import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ComfyBatchItemSummary, ComfyBatchState } from '@shared/api/svcComfyBatch'
import type { BatchManifestItem } from '@shared/api/svcFs'
import type { Workflow } from '@shared/comfy/types'

const mocks = vi.hoisted(() => {
  const registry = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    updateHealth: vi.fn()
  }
  const client = {
    objectInfo: vi.fn(),
    getQueue: vi.fn(),
    uploadImage: vi.fn(),
    prompt: vi.fn(),
    history: vi.fn(),
    view: vi.fn(),
    cancel: vi.fn(),
    interrupt: vi.fn()
  }
  const reservations = new Map<string, number>()
  const fsSvc = {
    prepareBatchWorkspace: vi.fn(),
    writeBatchManifest: vi.fn(),
    readBatchSourceImage: vi.fn(),
    commitBatchPng: vi.fn(),
    removeBatchStagingArtifacts: vi.fn(),
    appendBatchAggregateError: vi.fn(),
    failBatchItem: vi.fn()
  }
  const stateStore = {
    loadAll: vi.fn(),
    save: vi.fn(),
    close: vi.fn()
  }
  return { registry, client, fsSvc, stateStore, reservations }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => path.join(process.cwd(), '.magicpot-test-user-data')) }
}))

vi.mock('../comfy/instancePool', () => ({
  getComfyInstanceRegistry: vi.fn(() => mocks.registry),
  getComfyInstanceReservationCount: vi.fn(
    (instanceId: string) => mocks.reservations.get(instanceId) ?? 0
  ),
  tryReserveComfyInstanceCapacity: vi.fn(
    (state: { id: string; maxConcurrency: number }, active: number, pending: number) => {
      const reserved = mocks.reservations.get(state.id) ?? 0
      if (active + pending + reserved >= state.maxConcurrency) return null
      mocks.reservations.set(state.id, reserved + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const remaining = (mocks.reservations.get(state.id) ?? 1) - 1
        if (remaining > 0) mocks.reservations.set(state.id, remaining)
        else mocks.reservations.delete(state.id)
      }
    }
  )
}))

vi.mock('../comfy/batchStateStore', () => ({
  SqliteComfyBatchStateStore: vi.fn(function SqliteComfyBatchStateStore() {
    return mocks.stateStore
  })
}))

vi.mock('../comfy/http', () => ({
  ComfyHttpCli: vi.fn(function ComfyHttpCli() {
    return mocks.client
  })
}))

vi.mock('./svcFsImpl', () => ({
  FsSvcImpl: vi.fn(function FsSvcImpl() {
    return mocks.fsSvc
  })
}))

import { ComfyBatchSvcImpl } from './svcComfyBatchImpl'

const workflow: Workflow = {
  '1': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
  '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } }
}

const profile = (id = 'instance-1') => ({
  revision: 1,
  deleted: false,
  state: {
    id,
    name: id,
    origin: `http://${id}.test/`,
    kind: 'remote' as const,
    enabled: true,
    maxConcurrency: 1,
    tags: [],
    capabilities: {
      tags: [],
      models: [],
      customNodes: ['LoadImage', 'SaveImage']
    },
    health: { status: 'online' as const }
  }
})

const manifestItem = (
  relativeInputPath: string,
  status: BatchManifestItem['status'] = 'pending'
): BatchManifestItem => ({
  relativeInputPath,
  outputRelativePath: relativeInputPath.replace(/\.[^.]+$/u, '.png'),
  sourceFingerprint: { size: 3, mtimeMs: 10 },
  status,
  attempts: status === 'pending' ? [] : [{ startedAt: '2025-01-01T00:00:00.000Z' }]
})

const makeState = (
  batchId: string,
  sourceRoot: string,
  status: ComfyBatchState['status'],
  items: readonly ComfyBatchItemSummary[]
): ComfyBatchState => {
  const root = path.resolve(sourceRoot)
  const outputRoot = `${root}.output`
  const metadataRoot = path.join(outputRoot, '.magicpot-batch')
  const now = '2025-01-01T00:00:00.000Z'
  return {
    batchId,
    status,
    sourceRoot: root,
    workflow: structuredClone(workflow),
    binding: {
      inputNodeId: '1',
      inputField: 'image',
      outputNodeId: '2',
      outputIndex: 0
    },
    target: { mode: 'auto' },
    workspace: {
      sourceRoot: root,
      workRoot: outputRoot,
      outputRoot,
      metadataRoot,
      stagingRoot: path.join(metadataRoot, 'staging'),
      manifestPath: path.join(metadataRoot, 'manifest.json')
    },
    manifest: {
      version: 1,
      sourceRoot: root,
      createdAt: now,
      updatedAt: now,
      items: items.map((item) => manifestItem(item.relativeInputPath, item.status))
    },
    items,
    createdAt: now,
    updatedAt: now,
    errorLogPath: path.join(metadataRoot, 'errors.log')
  }
}

const successfulHistory = (promptId: string) => ({
  [promptId]: {
    prompt: [],
    outputs: {
      '2': {
        images: [{ filename: `${promptId}.png`, subfolder: 'outputs', type: 'output' }]
      }
    },
    status: { status_str: 'success', completed: true, messages: [] }
  }
})

type InternalSvc = {
  batches: Map<string, ComfyBatchState>
  activeSourceRoots: Map<string, string>
  cancellationRequests: Set<string>
  runners: Map<string, { promise: Promise<void> }>
  runGenerations: Map<string, number>
  acquireSource(state: ComfyBatchState): void
  launch(batchId: string): void
  executeItem(batchId: string, relativePath: string): Promise<void>
  commitSuccessfulItem(batchId: string, relativePath: string, image: Uint8Array): Promise<boolean>
}

const internal = (svc: ComfyBatchSvcImpl): InternalSvc => svc as unknown as InternalSvc

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for batch lifecycle condition.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('ComfyBatchSvcImpl lifecycle safety', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.reservations.clear()
    await fs.rm(path.join(process.cwd(), '.magicpot-test'), { recursive: true, force: true })

    const entries = [profile()]
    mocks.registry.list.mockImplementation(() => entries)
    mocks.registry.get.mockImplementation((id: string) =>
      entries.find((entry) => entry.state.id === id)
    )
    mocks.client.objectInfo.mockResolvedValue({ LoadImage: {}, SaveImage: {} })
    mocks.client.getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] })
    mocks.client.uploadImage.mockResolvedValue({
      filename: 'uploaded.png',
      subfolder: 'magicpot-batch',
      type: 'input'
    })
    mocks.client.prompt.mockResolvedValue({ prompt_id: 'prompt-default' })
    mocks.client.history.mockImplementation(async (promptId: string) => successfulHistory(promptId))
    mocks.client.view.mockResolvedValue(new Uint8Array([1, 2, 3]))
    mocks.client.cancel.mockResolvedValue(undefined)
    mocks.client.interrupt.mockResolvedValue(undefined)

    mocks.stateStore.loadAll.mockReturnValue([])
    mocks.stateStore.save.mockImplementation(() => undefined)
    mocks.fsSvc.writeBatchManifest.mockResolvedValue({ manifestPath: 'manifest.json' })
    mocks.fsSvc.readBatchSourceImage.mockResolvedValue({
      image: new Uint8Array([1, 2, 3]),
      filename: 'input.png'
    })
    mocks.fsSvc.commitBatchPng.mockResolvedValue({
      outputRelativePath: 'input.png',
      outputPath: 'output.png'
    })
    mocks.fsSvc.removeBatchStagingArtifacts.mockResolvedValue({ removedPaths: [] })
    mocks.fsSvc.failBatchItem.mockResolvedValue({
      errorLogPath: 'error.log',
      removedOutputPaths: []
    })
  })

  it('awaits deferred recovery before serving public APIs', async () => {
    const gate = deferred<void>()
    const recoverSpy = vi
      .spyOn(ComfyBatchSvcImpl.prototype as unknown as { recover: () => Promise<void> }, 'recover')
      .mockReturnValue(gate.promise)
    const svc = new ComfyBatchSvcImpl()

    const listing = svc.listInstances()
    await Promise.resolve()
    expect(mocks.registry.list).not.toHaveBeenCalled()

    gate.resolve()
    await expect(listing).resolves.toHaveLength(1)
    expect(mocks.registry.list).toHaveBeenCalledTimes(1)
    recoverSpy.mockRestore()
  })

  it('does not allow public instance mutations to redirect the managed local endpoint', async () => {
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    mocks.registry.get.mockReturnValue({
      ...profile('managed-local'),
      state: { ...profile('managed-local').state, kind: 'local' as const }
    })

    await expect(
      svc.updateInstance({
        id: 'managed-local',
        expectedRevision: 1,
        patch: { origin: 'https://attacker.example/' }
      })
    ).rejects.toThrow('local runtime bootstrap')
    expect(mocks.registry.update).not.toHaveBeenCalled()
  })

  it('recovers known, prepared, and clearly unsubmitted checkpoints conservatively', async () => {
    const sourceRoot = path.join(process.cwd(), 'recovery-source')
    const state = makeState('recover-batch', sourceRoot, 'running', [
      {
        relativeInputPath: 'known.jpg',
        status: 'running',
        attempts: 1,
        instanceId: 'instance-1',
        promptId: 'known-prompt',
        submissionToken: 'known-token',
        submissionState: 'submitted'
      },
      {
        relativeInputPath: 'prepared.jpg',
        status: 'running',
        attempts: 1,
        instanceId: 'instance-1',
        submissionToken: 'prepared-token',
        submissionState: 'prepared'
      },
      {
        relativeInputPath: 'legacy.jpg',
        status: 'running',
        attempts: 1
      }
    ])
    const directory = path.join(process.cwd(), '.magicpot-test', 'comfy-batch', 'batches')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, `${state.batchId}.json`), JSON.stringify(state), 'utf8')

    const svc = new ComfyBatchSvcImpl()
    const recovered = await svc.getBatch({ batchId: state.batchId })

    expect(recovered.status).toBe('paused')
    expect(recovered.items[0]).toMatchObject({
      status: 'running',
      promptId: 'known-prompt',
      submissionState: 'submitted',
      requiresManualIntervention: true
    })
    expect(recovered.items[1]).toMatchObject({
      status: 'failed',
      instanceId: 'instance-1',
      submissionToken: 'prepared-token',
      submissionState: 'unknown',
      requiresManualIntervention: true
    })
    expect(recovered.items[2]).toEqual({
      relativeInputPath: 'legacy.jpg',
      status: 'pending',
      attempts: 1
    })
    expect(mocks.fsSvc.writeBatchManifest).toHaveBeenCalled()
  })

  it('persists submission intent, posts once, and blocks ambiguous failover or retry', async () => {
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState('ambiguous-batch', path.join(process.cwd(), 'ambiguous'), 'running', [
      { relativeInputPath: 'input.jpg', status: 'pending', attempts: 0 }
    ])
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)

    const second = profile('instance-2')
    mocks.registry.list.mockReturnValue([profile(), second])
    mocks.registry.get.mockImplementation((id: string) =>
      [profile(), second].find((entry) => entry.state.id === id)
    )
    mocks.client.prompt.mockRejectedValue(new TypeError('connection reset after request dispatch'))

    await internal(svc).executeItem(state.batchId, 'input.jpg')

    expect(mocks.client.prompt).toHaveBeenCalledTimes(1)
    const preparedSave = mocks.stateStore.save.mock.calls
      .map(([candidate]) => candidate as ComfyBatchState)
      .find((candidate) => candidate.items[0]?.submissionState === 'prepared')
    expect(preparedSave?.items[0]).toMatchObject({
      status: 'running',
      instanceId: expect.any(String),
      instanceOrigin: 'http://instance-1.test/',
      instanceKind: 'remote',
      submissionState: 'prepared',
      submissionToken: expect.stringMatching(/^magicpot-batch-[a-f0-9]{64}$/u)
    })
    expect(
      (mocks.client.prompt.mock.calls[0]?.[0] as { extra_data?: Record<string, unknown> })
        .extra_data?.submissionToken
    ).toBe(preparedSave?.items[0]?.submissionToken)
    expect(mocks.fsSvc.readBatchSourceImage).toHaveBeenCalledTimes(1)
    expect(internal(svc).batches.get(state.batchId)).toMatchObject({
      status: 'paused',
      items: [
        expect.objectContaining({
          status: 'failed',
          submissionState: 'unknown',
          requiresManualIntervention: true
        })
      ]
    })
    await expect(svc.resumeBatch({ batchId: state.batchId })).rejects.toThrow(
      'submission outcome is unknown'
    )
    expect(mocks.client.prompt).toHaveBeenCalledTimes(1)

    await expect(
      svc.resolveSubmission({
        batchId: state.batchId,
        relativeInputPath: 'input.jpg',
        outcome: 'not-submitted'
      })
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ status: 'pending' })]
    })
  })

  it('never posts or fails over when prepared intent persistence has an unknown commit outcome', async () => {
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState(
      'persist-failure-batch',
      path.join(process.cwd(), 'persist-failure'),
      'running',
      [{ relativeInputPath: 'input.jpg', status: 'pending', attempts: 0 }]
    )
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)

    const second = profile('instance-2')
    mocks.registry.list.mockReturnValue([profile(), second])
    mocks.registry.get.mockImplementation((id: string) =>
      [profile(), second].find((entry) => entry.state.id === id)
    )
    let durableState: ComfyBatchState | undefined
    mocks.stateStore.save
      .mockImplementationOnce((candidate: ComfyBatchState) => {
        durableState = structuredClone(candidate)
        throw new Error('COMMIT outcome unknown')
      })
      .mockImplementation((candidate: ComfyBatchState) => {
        durableState = structuredClone(candidate)
      })

    await internal(svc).executeItem(state.batchId, 'input.jpg')

    expect(mocks.client.prompt).not.toHaveBeenCalled()
    expect(mocks.client.uploadImage).toHaveBeenCalledTimes(1)
    expect(internal(svc).batches.get(state.batchId)).toMatchObject({
      status: 'paused',
      items: [
        expect.objectContaining({
          submissionToken: expect.stringMatching(/^magicpot-batch-/u),
          submissionState: 'unknown',
          requiresManualIntervention: true
        })
      ]
    })
    expect(durableState?.items[0]).toMatchObject({
      submissionState: 'unknown',
      requiresManualIntervention: true
    })
  })

  it('resumes a known prompt on its original instance without submitting it again', async () => {
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState('known-batch', path.join(process.cwd(), 'known'), 'paused', [
      {
        relativeInputPath: 'known.jpg',
        status: 'running',
        attempts: 1,
        instanceId: 'instance-1',
        instanceOrigin: 'http://127.0.0.1:8188',
        instanceKind: 'local',
        promptId: 'known-prompt',
        submissionToken: 'known-token',
        submissionState: 'submitted',
        requiresManualIntervention: true
      }
    ])
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)

    await svc.resumeBatch({ batchId: state.batchId })
    await waitFor(() => internal(svc).batches.get(state.batchId)?.status === 'succeeded')

    expect(mocks.client.history).toHaveBeenCalledWith('known-prompt')
    expect(mocks.client.prompt).not.toHaveBeenCalled()
    expect(mocks.client.uploadImage).not.toHaveBeenCalled()
    expect(mocks.fsSvc.commitBatchPng).toHaveBeenCalledTimes(1)
    expect(internal(svc).batches.get(state.batchId)?.items[0]).toMatchObject({
      status: 'succeeded',
      promptId: 'known-prompt',
      instanceId: 'instance-1'
    })
  })

  it('relaunches after a pause-resume race instead of stranding pending work', async () => {
    const firstHistory = deferred<ReturnType<typeof successfulHistory>>()
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState('race-batch', path.join(process.cwd(), 'race'), 'queued', [
      { relativeInputPath: 'first.jpg', status: 'pending', attempts: 0 },
      { relativeInputPath: 'second.jpg', status: 'pending', attempts: 0 }
    ])
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)

    mocks.client.prompt
      .mockResolvedValueOnce({ prompt_id: 'prompt-first' })
      .mockResolvedValueOnce({ prompt_id: 'prompt-second' })
    mocks.client.history.mockImplementation((promptId: string) =>
      promptId === 'prompt-first'
        ? firstHistory.promise
        : Promise.resolve(successfulHistory(promptId))
    )

    internal(svc).launch(state.batchId)
    await waitFor(() => mocks.client.history.mock.calls.some(([id]) => id === 'prompt-first'))
    await svc.pauseBatch({ batchId: state.batchId })
    await svc.resumeBatch({ batchId: state.batchId })
    firstHistory.resolve(successfulHistory('prompt-first'))

    await waitFor(() => internal(svc).batches.get(state.batchId)?.status === 'succeeded')
    expect(mocks.client.prompt).toHaveBeenCalledTimes(2)
    expect(
      internal(svc)
        .batches.get(state.batchId)
        ?.items.map((item) => item.status)
    ).toEqual(['succeeded', 'succeeded'])
  })

  it('does not relaunch when a persistent checkpoint failure leaves only in-memory fail-closed state', async () => {
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState(
      'checkpoint-failure-batch',
      path.join(process.cwd(), 'checkpoint-failure'),
      'queued',
      [{ relativeInputPath: 'input.jpg', status: 'pending', attempts: 0 }]
    )
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)
    mocks.stateStore.save.mockImplementation(() => {
      throw new Error('persistent checkpoint failure')
    })

    internal(svc).launch(state.batchId)
    internal(svc).launch(state.batchId)
    const runner = internal(svc).runners.get(state.batchId)
    expect(runner).toBeDefined()
    await runner?.promise
    await waitFor(() => !internal(svc).runners.has(state.batchId))
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(internal(svc).batches.get(state.batchId)?.status).toBe('failed')
    expect(internal(svc).runGenerations.get(state.batchId)).toBe(1)
    expect(mocks.client.prompt).not.toHaveBeenCalled()
  })

  it('reacquires source ownership for retry and releases it on cancellation', async () => {
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const sourceRoot = path.join(process.cwd(), 'shared-source')
    const owner = makeState('owner-batch', sourceRoot, 'paused', [
      { relativeInputPath: 'owner.jpg', status: 'pending', attempts: 0 }
    ])
    const retry = makeState('retry-batch', sourceRoot, 'failed', [
      { relativeInputPath: 'retry.jpg', status: 'failed', attempts: 1, error: 'rejected' }
    ])
    internal(svc).batches.set(owner.batchId, owner)
    internal(svc).batches.set(retry.batchId, retry)
    internal(svc).acquireSource(owner)
    const launchSpy = vi
      .spyOn(internal(svc) as unknown as { launch: (batchId: string) => void }, 'launch')
      .mockImplementation(() => undefined)

    await expect(svc.retryFailed({ batchId: retry.batchId })).rejects.toThrow(
      'already has an active Comfy batch'
    )
    expect(internal(svc).batches.get(retry.batchId)?.status).toBe('failed')

    await expect(svc.cancelBatch({ batchId: owner.batchId })).resolves.toMatchObject({
      status: 'cancelled'
    })
    await expect(svc.retryFailed({ batchId: retry.batchId })).resolves.toMatchObject({
      status: 'queued'
    })
    expect(launchSpy).toHaveBeenCalledWith(retry.batchId)

    await expect(svc.cancelBatch({ batchId: retry.batchId })).resolves.toMatchObject({
      status: 'cancelled'
    })
    expect(internal(svc).activeSourceRoots.size).toBe(0)
  })

  it('uses the global interrupt endpoint only after confirming the batch prompt is running', async () => {
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState(
      'cancel-running',
      path.join(process.cwd(), 'cancel-running'),
      'running',
      [
        {
          relativeInputPath: 'input.jpg',
          status: 'running',
          attempts: 1,
          instanceId: 'instance-1',
          instanceOrigin: 'http://127.0.0.1:8188',
          instanceKind: 'local',
          promptId: 'prompt-running',
          submissionToken: 'running-token',
          submissionState: 'submitted'
        }
      ]
    )
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)
    mocks.client.getQueue
      .mockResolvedValueOnce({
        queue_running: [[1, 'prompt-running', workflow, { client_id: 'batch' }, []]],
        queue_pending: []
      })
      .mockResolvedValue({ queue_running: [], queue_pending: [] })

    await expect(svc.cancelBatch({ batchId: state.batchId })).resolves.toMatchObject({
      status: 'cancelled'
    })
    expect(mocks.client.cancel).toHaveBeenCalledWith('prompt-running')
    expect(mocks.client.interrupt).toHaveBeenCalledTimes(1)
  })

  it('does not interrupt unrelated running work after deleting a pending batch prompt', async () => {
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState(
      'cancel-pending',
      path.join(process.cwd(), 'cancel-pending'),
      'running',
      [
        {
          relativeInputPath: 'input.jpg',
          status: 'running',
          attempts: 1,
          instanceId: 'instance-1',
          instanceOrigin: 'http://127.0.0.1:8188',
          instanceKind: 'local',
          promptId: 'prompt-pending',
          submissionToken: 'pending-token',
          submissionState: 'submitted'
        }
      ]
    )
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)
    mocks.client.getQueue
      .mockResolvedValueOnce({
        queue_running: [[1, 'unrelated-running', workflow, { client_id: 'other' }, []]],
        queue_pending: [[2, 'prompt-pending', workflow, { client_id: 'batch' }, []]]
      })
      .mockResolvedValue({
        queue_running: [[1, 'unrelated-running', workflow, { client_id: 'other' }, []]],
        queue_pending: []
      })

    await expect(svc.cancelBatch({ batchId: state.batchId })).resolves.toMatchObject({
      status: 'cancelled'
    })
    expect(mocks.client.cancel).toHaveBeenCalledWith('prompt-pending')
    expect(mocks.client.interrupt).not.toHaveBeenCalled()
  })

  it('coalesces concurrent duplicate cancellation calls', async () => {
    const cancelGate = deferred<void>()
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState(
      'cancel-concurrent',
      path.join(process.cwd(), 'cancel-concurrent'),
      'running',
      [
        {
          relativeInputPath: 'input.jpg',
          status: 'running',
          attempts: 1,
          instanceId: 'instance-1',
          instanceOrigin: 'http://127.0.0.1:8188',
          instanceKind: 'local',
          promptId: 'prompt-concurrent',
          submissionToken: 'concurrent-token',
          submissionState: 'submitted'
        }
      ]
    )
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)
    mocks.client.cancel.mockReturnValue(cancelGate.promise)
    mocks.client.getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] })

    const first = svc.cancelBatch({ batchId: state.batchId })
    const second = svc.cancelBatch({ batchId: state.batchId })
    await waitFor(() => mocks.client.cancel.mock.calls.length === 1)
    cancelGate.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'cancelled' }),
      expect.objectContaining({ status: 'cancelled' })
    ])
    expect(mocks.client.cancel).toHaveBeenCalledTimes(2)
  })

  it('keeps cancellation intent when prompt cancellation cannot be confirmed', async () => {
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState(
      'cancel-unknown',
      path.join(process.cwd(), 'cancel-unknown'),
      'running',
      [
        {
          relativeInputPath: 'input.jpg',
          status: 'failed',
          attempts: 1,
          instanceId: 'instance-1',
          instanceOrigin: 'http://127.0.0.1:8188',
          instanceKind: 'local',
          submissionToken: 'unknown-token',
          submissionState: 'unknown',
          requiresManualIntervention: true
        }
      ]
    )
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)

    await expect(svc.cancelBatch({ batchId: state.batchId })).rejects.toThrow(
      'prompt submission outcome is unknown'
    )
    expect(internal(svc).batches.get(state.batchId)?.status).toBe('cancelling')
    expect([...internal(svc).activeSourceRoots.values()]).toContain(state.batchId)

    const resolved = await svc.resolveSubmission({
      batchId: state.batchId,
      relativeInputPath: 'input.jpg',
      outcome: 'cancelled'
    })
    expect(resolved.status).toBe('cancelled')
    expect(resolved.items[0]).toEqual({
      relativeInputPath: 'input.jpg',
      status: 'failed',
      attempts: 1,
      error: 'Submission was manually resolved as cancelled.'
    })

    mocks.stateStore.loadAll.mockReturnValue([structuredClone(resolved)])
    const restarted = new ComfyBatchSvcImpl()
    const recovered = await restarted.getBatch({ batchId: state.batchId })
    expect(recovered.status).toBe('cancelled')
    expect(recovered.items[0]).not.toHaveProperty('submissionToken')
    expect(recovered.items[0]).not.toHaveProperty('instanceId')
  })

  it('removes a promoted output when cancellation is observed during commit', async () => {
    const commitGate = deferred<{ outputRelativePath: string; outputPath: string }>()
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState('cancel-commit', path.join(process.cwd(), 'cancel-commit'), 'running', [
      {
        relativeInputPath: 'input.jpg',
        status: 'running',
        attempts: 1,
        instanceId: 'instance-1',
        instanceOrigin: 'http://127.0.0.1:8188',
        instanceKind: 'local',
        promptId: 'prompt-cancel',
        submissionToken: 'cancel-token',
        submissionState: 'submitted'
      }
    ])
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)
    mocks.fsSvc.commitBatchPng.mockReturnValue(commitGate.promise)

    const committing = internal(svc).commitSuccessfulItem(
      state.batchId,
      'input.jpg',
      new Uint8Array([1, 2, 3])
    )
    await waitFor(() => mocks.fsSvc.commitBatchPng.mock.calls.length === 1)

    const cancelling = svc.cancelBatch({ batchId: state.batchId })
    await waitFor(() => internal(svc).cancellationRequests.has(state.batchId))
    commitGate.resolve({ outputRelativePath: 'input.png', outputPath: 'output.png' })

    await expect(committing).resolves.toBe(false)
    await expect(cancelling).resolves.toMatchObject({ status: 'cancelled' })
    expect(mocks.fsSvc.failBatchItem).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRoot: state.sourceRoot,
        relativeInputPath: 'input.jpg'
      })
    )
    expect(internal(svc).batches.get(state.batchId)?.items[0].status).not.toBe('succeeded')
  })

  it('keeps cancelling state when promoted-output cleanup fails', async () => {
    const commitGate = deferred<{ outputRelativePath: string; outputPath: string }>()
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState(
      'cancel-cleanup-failure',
      path.join(process.cwd(), 'cancel-cleanup-failure'),
      'running',
      [
        {
          relativeInputPath: 'input.jpg',
          status: 'running',
          attempts: 1,
          instanceId: 'instance-1',
          instanceOrigin: 'http://127.0.0.1:8188',
          instanceKind: 'local',
          promptId: 'prompt-cleanup',
          submissionToken: 'cleanup-token',
          submissionState: 'submitted'
        }
      ]
    )
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)
    mocks.fsSvc.commitBatchPng.mockReturnValue(commitGate.promise)
    mocks.fsSvc.failBatchItem.mockRejectedValue(new Error('output cleanup failed'))

    const committing = internal(svc).commitSuccessfulItem(
      state.batchId,
      'input.jpg',
      new Uint8Array([1, 2, 3])
    )
    await waitFor(() => mocks.fsSvc.commitBatchPng.mock.calls.length === 1)
    const cancelling = svc.cancelBatch({ batchId: state.batchId })
    await waitFor(() => internal(svc).cancellationRequests.has(state.batchId))
    commitGate.resolve({ outputRelativePath: 'input.png', outputPath: 'output.png' })

    await expect(committing).rejects.toThrow('output cleanup failed')
    await expect(cancelling).rejects.toThrow('output cleanup failed')
    expect(internal(svc).batches.get(state.batchId)?.status).toBe('cancelling')
    expect([...internal(svc).activeSourceRoots.values()]).toContain(state.batchId)
  })

  it('does not report cancelled when the succeeded-manifest rollback keeps failing', async () => {
    const succeededManifestReached = deferred<void>()
    const releaseSucceededManifest = deferred<void>()
    const svc = new ComfyBatchSvcImpl()
    await svc.listInstances()
    const state = makeState(
      'cancel-rollback-failure',
      path.join(process.cwd(), 'cancel-rollback-failure'),
      'running',
      [
        {
          relativeInputPath: 'input.jpg',
          status: 'running',
          attempts: 1,
          instanceId: 'instance-1',
          instanceOrigin: 'http://127.0.0.1:8188',
          instanceKind: 'local',
          promptId: 'prompt-rollback',
          submissionToken: 'rollback-token',
          submissionState: 'submitted'
        }
      ]
    )
    internal(svc).batches.set(state.batchId, state)
    internal(svc).acquireSource(state)
    let succeededManifestWritten = false
    mocks.fsSvc.writeBatchManifest.mockImplementation(
      async ({ manifest }: { manifest: ComfyBatchState['manifest'] }) => {
        const itemStatus = manifest.items[0]?.status
        if (itemStatus === 'succeeded') {
          succeededManifestWritten = true
          succeededManifestReached.resolve()
          await releaseSucceededManifest.promise
          return { manifestPath: 'manifest.json' }
        }
        if (succeededManifestWritten && itemStatus === 'running') {
          throw new Error('rollback checkpoint failed')
        }
        return { manifestPath: 'manifest.json' }
      }
    )

    const committing = internal(svc).commitSuccessfulItem(
      state.batchId,
      'input.jpg',
      new Uint8Array([1, 2, 3])
    )
    const committingExpectation = expect(committing).rejects.toThrow('rollback checkpoint failed')
    await succeededManifestReached.promise
    const cancelling = svc.cancelBatch({ batchId: state.batchId })
    await waitFor(() => internal(svc).cancellationRequests.has(state.batchId))
    releaseSucceededManifest.resolve()

    await committingExpectation
    await expect(cancelling).rejects.toThrow('rollback checkpoint failed')
    expect(internal(svc).batches.get(state.batchId)?.status).toBe('cancelling')
    expect(mocks.fsSvc.failBatchItem).toHaveBeenCalled()
  })
})
