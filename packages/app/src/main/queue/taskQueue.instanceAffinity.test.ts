import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fsReadControl = vi.hoisted(() => ({
  targetPath: null as string | null,
  afterFirstRead: null as (() => Promise<void>) | null,
  readCount: 0
}))
vi.mock('node:fs', async (importActual) => importActual())
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (!fsReadControl.targetPath || path.resolve(String(args[0])) !== fsReadControl.targetPath) {
        return handle
      }
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'read') {
            return async (...readArgs: Parameters<typeof target.read>) => {
              const result = await target.read(...readArgs)
              fsReadControl.readCount += 1
              if (fsReadControl.readCount === 1) await fsReadControl.afterFirstRead?.()
              return result
            }
          }
          const value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
})
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ComfyHistory, Workflow } from '@shared/comfy/types'
import {
  encodeDeferredComfyImageInputValue,
  encodeDeferredComfyMaskInputValue
} from '@shared/comfy/deferredImages'
import { fileItemToValue } from '@shared/comfy/funcs'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { ComfyJobStore } from '../comfy/jobStore'
import { getComfyOutputRouteStore } from '../comfy/outputRouteStore'

const mocks = vi.hoisted(() => {
  const managedClient = {
    objectInfo: vi.fn(),
    uploadImage: vi.fn(),
    uploadMask: vi.fn(),
    view: vi.fn(),
    prompt: vi.fn(),
    history: vi.fn(),
    interrupt: vi.fn(),
    cancel: vi.fn(),
    getQueue: vi.fn(),
    historyAll: vi.fn(),
    isRemoteComfyUI: vi.fn(() => true),
    freeMemory: vi.fn()
  }
  const legacyClient = {
    objectInfo: vi.fn(),
    uploadImage: vi.fn(),
    uploadMask: vi.fn(),
    view: vi.fn(),
    prompt: vi.fn(),
    history: vi.fn(),
    interrupt: vi.fn(),
    cancel: vi.fn(),
    getQueue: vi.fn(),
    historyAll: vi.fn(),
    isRemoteComfyUI: vi.fn(() => false),
    freeMemory: vi.fn()
  }
  const release = vi.fn()
  const registry = { get: vi.fn(), list: vi.fn() }
  return {
    managedClient,
    legacyClient,
    release,
    registry,
    acquireComfyInstance: vi.fn(),
    getComfyInstanceClient: vi.fn(),
    retainRestoredComfyInstanceCapacity: vi.fn(() => vi.fn()),
    releaseRestoredComfyInstanceCapacity: vi.fn()
  }
})

vi.mock('../comfy/instancePool', () => ({
  acquireComfyInstance: mocks.acquireComfyInstance,
  getComfyInstanceClient: mocks.getComfyInstanceClient,
  getComfyInstanceRegistry: vi.fn(() => mocks.registry),
  retainRestoredComfyInstanceCapacity: mocks.retainRestoredComfyInstanceCapacity,
  releaseRestoredComfyInstanceCapacity: mocks.releaseRestoredComfyInstanceCapacity
}))

vi.mock('../comfy/http', () => ({
  COMFY_PROCESS_TRANSPORT_CLIENT_ID: 'magicpot-main-process',
  ComfyHttpCli: vi.fn(function ComfyHttpCli() {
    return mocks.legacyClient
  })
}))

import {
  addTask,
  cancelTask,
  cancelTaskByPromptId,
  getTask,
  initTaskQueue,
  resolveTaskSubmission,
  stopTaskQueue,
  type Task
} from './taskQueue'

const restartTempDirectories: string[] = []
const restartStores: MagicAgentEventStore[] = []
const createRestartStorePath = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'magicpot-taskqueue-restart-'))
  restartTempDirectories.push(directory)
  return path.join(directory, 'events.sqlite3')
}

const baseWorkflow: Workflow = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '2': {
    class_type: 'LoraLoader',
    inputs: {
      model: ['1', 0],
      clip: ['1', 1],
      lora_name: 'missing.safetensors',
      strength_model: 1,
      strength_clip: 1
    }
  },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } }
}

const success = (promptId: string, prompt: Workflow): ComfyHistory => ({
  prompt: [0, promptId, prompt, { client_id: 'transport' }, []],
  outputs: { '3': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } },
  status: { status_str: 'success', completed: true, messages: [] }
})

const add = (workflow: Workflow = structuredClone(baseWorkflow)): string =>
  addTask({
    id: '',
    type: 'comfy_prompt',
    client_id: 'renderer-client',
    created_at: 1,
    prompt_id: null,
    payload: workflow,
    result: null
  })

const waitForTask = async (
  id: string,
  expected: 'running' | 'cancelling' | 'unknown' | 'completed' | 'cancelled' | 'error'
) => {
  for (let attempt = 0; attempt < 600; attempt++) {
    const [status, task] = getTask(id)
    if (status === expected && task) return task
    await vi.advanceTimersByTimeAsync(5)
  }
  const [status] = getTask(id)
  throw new Error(`Timed out waiting for task ${id}: ${status}`)
}

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
}

describe('ordinary Comfy task instance affinity', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    fsReadControl.targetPath = null
    fsReadControl.afterFirstRead = null
    fsReadControl.readCount = 0
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mocks.managedClient.objectInfo.mockResolvedValue({
      LoraLoader: { input: { required: { lora_name: [['installed.safetensors'], {}] } } }
    })
    mocks.managedClient.view.mockResolvedValue(new Uint8Array([9, 8, 7]))
    mocks.managedClient.uploadImage.mockResolvedValue({
      filename: 'leased-upload.png',
      subfolder: '',
      type: 'input'
    })
    mocks.managedClient.uploadMask.mockResolvedValue({
      filename: 'leased-mask.png',
      subfolder: 'clipspace',
      type: 'input'
    })
    mocks.managedClient.prompt.mockImplementation(async ({ prompt }: { prompt: Workflow }) => ({
      prompt_id: 'managed-prompt',
      prompt
    }))
    mocks.managedClient.history.mockImplementation(async (promptId: string) => ({
      [promptId]: success(promptId, mocks.managedClient.prompt.mock.calls[0]?.[0].prompt)
    }))
    mocks.managedClient.interrupt.mockResolvedValue(undefined)
    mocks.managedClient.cancel.mockResolvedValue(undefined)
    mocks.managedClient.getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] })
    mocks.managedClient.historyAll.mockResolvedValue({})
    mocks.acquireComfyInstance.mockResolvedValue({
      state: {
        id: 'gpu-b',
        origin: 'https://gpu-b.example/',
        kind: 'remote',
        enabled: true,
        maxConcurrency: 1,
        tags: [],
        capabilities: { tags: [], models: [], customNodes: [] },
        health: { status: 'online' }
      },
      cli: mocks.managedClient,
      release: mocks.release
    })
    mocks.registry.get.mockReturnValue({ state: { id: 'gpu-b' }, deleted: false })
    mocks.getComfyInstanceClient.mockReturnValue(mocks.managedClient)

    mocks.legacyClient.objectInfo.mockResolvedValue({})
    mocks.legacyClient.prompt.mockResolvedValue({ prompt_id: 'legacy-prompt' })
    mocks.legacyClient.history.mockImplementation(async (promptId: string) => ({
      [promptId]: success(promptId, baseWorkflow)
    }))
    mocks.legacyClient.interrupt.mockResolvedValue(undefined)
    mocks.legacyClient.cancel.mockResolvedValue(undefined)
    mocks.legacyClient.getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] })
    mocks.legacyClient.historyAll.mockResolvedValue({})
    await initTaskQueue({ eventStore: new MagicAgentEventStore(':memory:') })
  })

  afterEach(async () => {
    await stopTaskQueue()
    vi.useRealTimers()
    for (const store of restartStores.splice(0)) store.close()
    for (const directory of restartTempDirectories.splice(0)) {
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch (error) {
        console.warn('Deferred cleanup for restart fixture:', error)
      }
    }
  })

  it('preprocesses and submits with the final leased client, then releases once', async () => {
    const id = add()
    await vi.advanceTimersByTimeAsync(1_100)
    const task = await waitForTask(id, 'completed')

    expect(mocks.acquireComfyInstance).toHaveBeenCalledWith(
      baseWorkflow,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(mocks.managedClient.objectInfo).toHaveBeenCalledTimes(1)
    expect(mocks.legacyClient.objectInfo).not.toHaveBeenCalled()
    const submitted = mocks.managedClient.prompt.mock.calls[0]?.[0].prompt as Workflow
    expect(submitted['2']).toBeUndefined()
    expect(submitted['3']?.inputs.images).toEqual(['1', 0])
    expect(mocks.managedClient.history).toHaveBeenCalledWith(
      'managed-prompt',
      expect.any(AbortSignal)
    )
    expect(task.instanceId).toBe('gpu-b')
    expect(task.result?.outputs['3']?.images?.[0]).toMatchObject({
      instanceId: 'gpu-b',
      instanceRouteId: expect.stringMatching(/^route-/u),
      instanceOrigin: 'https://gpu-b.example/',
      instanceKind: 'remote'
    })
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })

  it('uploads deferred images only through the leased client', async () => {
    const deferredImage = encodeDeferredComfyImageInputValue({
      fileName: 'drop.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AQID',
      sizeBytes: 3
    })
    const workflow: Workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: deferredImage } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } }
    }
    const id = add(workflow)
    await vi.advanceTimersByTimeAsync(1_100)
    await waitForTask(id, 'completed')

    expect(mocks.managedClient.uploadImage).toHaveBeenCalledWith(
      { filename: 'drop.png', type: 'input' },
      new Uint8Array([1, 2, 3]),
      expect.any(AbortSignal)
    )
    expect(mocks.legacyClient.uploadImage).not.toHaveBeenCalled()
    expect(mocks.managedClient.prompt.mock.calls[0]?.[0].prompt['1'].inputs.image).toBe(
      'leased-upload.png'
    )
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })

  it('reuploads a mask original when the source route id differs despite the same endpoint tuple', async () => {
    const sourceRouteId = 'route-source-same-tuple'
    const routeStore = getComfyOutputRouteStore()
    const originalGet = routeStore.get.bind(routeStore)
    const captureSpy = vi.spyOn(routeStore, 'capture').mockReturnValue({
      routeId: 'route-destination-same-tuple',
      instanceId: 'gpu-b',
      origin: 'https://gpu-b.example/',
      kind: 'remote',
      createdAt: 2
    })
    vi.spyOn(routeStore, 'get').mockImplementation((routeId: string) =>
      routeId === sourceRouteId
        ? {
            routeId: sourceRouteId,
            instanceId: 'gpu-b',
            origin: 'https://gpu-b.example/',
            kind: 'remote',
            createdAt: 1
          }
        : originalGet(routeId)
    )
    mocks.legacyClient.view.mockResolvedValueOnce(new Uint8Array([4, 5, 6]))
    const originalValue = fileItemToValue({
      filename: 'source.png',
      type: 'output',
      instanceId: 'gpu-b',
      instanceRouteId: sourceRouteId,
      instanceOrigin: 'https://gpu-b.example/',
      instanceKind: 'remote'
    })
    const deferredMask = encodeDeferredComfyMaskInputValue({
      fileName: 'mask.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AQID',
      sizeBytes: 3,
      originalValue
    })
    const workflow: Workflow = {
      '1': { class_type: 'LoadImageMask', inputs: { image: deferredMask } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } }
    }

    const id = add(workflow)
    await vi.advanceTimersByTimeAsync(1_100)
    const task = await waitForTask(id, 'completed')

    expect(mocks.legacyClient.view).toHaveBeenCalledTimes(1)
    expect(mocks.managedClient.uploadImage).toHaveBeenCalledWith(
      { filename: 'source.png', type: 'input' },
      new Uint8Array([4, 5, 6]),
      expect.any(AbortSignal)
    )
    expect(mocks.managedClient.uploadMask).toHaveBeenCalledWith(
      { filename: 'mask.png', type: 'input', subfolder: 'clipspace' },
      new Uint8Array([1, 2, 3]),
      { filename: 'leased-upload.png', type: 'input' },
      expect.any(AbortSignal)
    )
    expect(task.result?.prompt[2]).toEqual(workflow)
    captureSpy.mockRestore()
    vi.mocked(routeStore.get).mockRestore()
  })

  it('materializes an authorized persisted file on the leased client and preserves history', async () => {
    await stopTaskQueue()
    const directory = await mkdtemp(path.join(tmpdir(), 'magicpot-persisted-integration-'))
    restartTempDirectories.push(directory)
    const authorizedRoot = path.join(directory, 'qapp-input-images')
    await mkdir(authorizedRoot)
    const filePath = path.join(authorizedRoot, 'image.png')
    await writeFile(filePath, new Uint8Array([1, 2, 3]))
    await initTaskQueue({
      eventStore: new MagicAgentEventStore(':memory:'),
      deferredFileAuthorizedRoot: authorizedRoot
    })
    const deferred = encodeDeferredComfyImageInputValue({
      fileName: 'image.png',
      mimeType: 'image/png',
      filePath,
      sizeBytes: 3
    })
    const workflow: Workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: deferred } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } }
    }
    const id = add(workflow)
    await vi.advanceTimersByTimeAsync(1_100)
    const task = await waitForTask(id, 'completed')
    expect(mocks.managedClient.uploadImage).toHaveBeenCalledWith(
      { filename: 'image.png', type: 'input' },
      new Uint8Array([1, 2, 3]),
      expect.any(AbortSignal)
    )
    expect(task.result?.prompt[2]).toEqual(workflow)
  })

  it.each(['outside', 'size-mismatch'] as const)(
    'fails persisted %s authority before upload or prompt',
    async (kind) => {
      await stopTaskQueue()
      const directory = await mkdtemp(path.join(tmpdir(), 'magicpot-persisted-reject-'))
      restartTempDirectories.push(directory)
      const authorizedRoot = path.join(directory, 'qapp-input-images')
      await mkdir(authorizedRoot)
      const filePath =
        kind === 'outside'
          ? path.join(directory, 'outside.png')
          : path.join(authorizedRoot, 'image.png')
      await writeFile(filePath, new Uint8Array([1, 2, 3]))
      await initTaskQueue({
        eventStore: new MagicAgentEventStore(':memory:'),
        deferredFileAuthorizedRoot: authorizedRoot
      })
      const workflow: Workflow = {
        '1': {
          class_type: 'LoadImage',
          inputs: {
            image: encodeDeferredComfyImageInputValue({
              fileName: 'image.png',
              mimeType: 'image/png',
              filePath,
              sizeBytes: kind === 'size-mismatch' ? 4 : 3
            })
          }
        }
      }
      const id = add(workflow)
      await vi.advanceTimersByTimeAsync(1_100)
      await waitForTask(id, 'error')
      expect(mocks.managedClient.uploadImage).not.toHaveBeenCalled()
      expect(mocks.managedClient.uploadMask).not.toHaveBeenCalled()
      expect(mocks.managedClient.prompt).not.toHaveBeenCalled()
      expect(mocks.managedClient.historyAll).not.toHaveBeenCalled()
      expect(mocks.managedClient.getQueue).not.toHaveBeenCalled()
    }
  )

  it('rejects a persisted file truncated between chunk reads before any Comfy side effect', async () => {
    await stopTaskQueue()
    const directory = await mkdtemp(path.join(tmpdir(), 'magicpot-persisted-toctou-'))
    restartTempDirectories.push(directory)
    const authorizedRoot = path.join(directory, 'qapp-input-images')
    await mkdir(authorizedRoot)
    const filePath = path.join(authorizedRoot, 'large.bin')
    const originalSize = 2 * 1024 * 1024 + 17
    await writeFile(filePath, new Uint8Array(originalSize).fill(7))
    fsReadControl.targetPath = path.resolve(filePath)
    fsReadControl.afterFirstRead = async () => truncate(filePath, 1024 * 1024)
    await initTaskQueue({
      eventStore: new MagicAgentEventStore(':memory:'),
      deferredFileAuthorizedRoot: authorizedRoot
    })
    const deferred = encodeDeferredComfyImageInputValue({
      fileName: 'large.bin',
      mimeType: 'application/octet-stream',
      filePath,
      sizeBytes: originalSize
    })
    const workflow: Workflow = { '1': { class_type: 'LoadImage', inputs: { image: deferred } } }
    const id = add(workflow)
    await vi.advanceTimersByTimeAsync(1_100)
    const task = await waitForTask(id, 'error')
    expect(fsReadControl.readCount).toBeGreaterThanOrEqual(2)
    expect(task.historyPayload ?? workflow).toEqual(workflow)
    expect(mocks.managedClient.uploadImage).not.toHaveBeenCalled()
    expect(mocks.managedClient.uploadMask).not.toHaveBeenCalled()
    expect(mocks.managedClient.prompt).not.toHaveBeenCalled()
    expect(mocks.managedClient.history).not.toHaveBeenCalled()
    expect(mocks.managedClient.historyAll).not.toHaveBeenCalled()
    expect(mocks.managedClient.getQueue).not.toHaveBeenCalled()
    expect(mocks.managedClient.freeMemory).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })

  it('aborts a persisted file read before a second chunk or any Comfy side effect', async () => {
    await stopTaskQueue()
    const directory = await mkdtemp(path.join(tmpdir(), 'magicpot-persisted-abort-'))
    restartTempDirectories.push(directory)
    const authorizedRoot = path.join(directory, 'qapp-input-images')
    await mkdir(authorizedRoot)
    const filePath = path.join(authorizedRoot, 'large.bin')
    const originalSize = 2 * 1024 * 1024 + 17
    await writeFile(filePath, new Uint8Array(originalSize).fill(9))
    let signalFirstRead!: () => void
    let releaseFirstRead!: () => void
    const firstRead = new Promise<void>((resolve) => {
      signalFirstRead = resolve
    })
    const heldRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve
    })
    fsReadControl.targetPath = path.resolve(filePath)
    fsReadControl.afterFirstRead = async () => {
      signalFirstRead()
      await heldRead
    }
    await initTaskQueue({
      eventStore: new MagicAgentEventStore(':memory:'),
      deferredFileAuthorizedRoot: authorizedRoot
    })
    const deferred = encodeDeferredComfyImageInputValue({
      fileName: 'large.bin',
      mimeType: 'application/octet-stream',
      filePath,
      sizeBytes: originalSize
    })
    const workflow: Workflow = { '1': { class_type: 'LoadImage', inputs: { image: deferred } } }
    const id = add(workflow)
    const advancing = vi.advanceTimersByTimeAsync(1_100)
    await firstRead
    const cancellation = cancelTask(id)
    releaseFirstRead()
    await Promise.all([advancing, cancellation])
    const task = await waitForTask(id, 'cancelled')

    expect(fsReadControl.readCount).toBe(1)
    expect(task.historyPayload ?? task.payload).toEqual(workflow)
    expect(mocks.managedClient.uploadImage).not.toHaveBeenCalled()
    expect(mocks.managedClient.uploadMask).not.toHaveBeenCalled()
    expect(mocks.managedClient.prompt).not.toHaveBeenCalled()
    expect(mocks.managedClient.history).not.toHaveBeenCalled()
    expect(mocks.managedClient.historyAll).not.toHaveBeenCalled()
    expect(mocks.managedClient.getQueue).not.toHaveBeenCalled()
    expect(mocks.managedClient.freeMemory).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(1))
  })

  it('rejects a persisted linked directory before any Comfy side effect', async () => {
    await stopTaskQueue()
    const directory = await mkdtemp(path.join(tmpdir(), 'magicpot-persisted-linked-dir-'))
    restartTempDirectories.push(directory)
    const authorizedRoot = path.join(directory, 'qapp-input-images')
    const outsideDirectory = path.join(directory, 'outside')
    await mkdir(authorizedRoot)
    await mkdir(outsideDirectory)
    await writeFile(path.join(outsideDirectory, 'image.png'), new Uint8Array([1, 2, 3]))
    const linkedDirectory = path.join(authorizedRoot, 'linked')
    try {
      await symlink(
        outsideDirectory,
        linkedDirectory,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    } catch {
      return
    }
    await initTaskQueue({
      eventStore: new MagicAgentEventStore(':memory:'),
      deferredFileAuthorizedRoot: authorizedRoot
    })
    const deferred = encodeDeferredComfyImageInputValue({
      fileName: 'image.png',
      mimeType: 'image/png',
      filePath: path.join(linkedDirectory, 'image.png'),
      sizeBytes: 3
    })
    const workflow: Workflow = { '1': { class_type: 'LoadImage', inputs: { image: deferred } } }
    const id = add(workflow)
    await vi.advanceTimersByTimeAsync(1_100)
    const task = await waitForTask(id, 'error')
    expect(task.historyPayload ?? workflow).toEqual(workflow)
    expect(mocks.managedClient.uploadImage).not.toHaveBeenCalled()
    expect(mocks.managedClient.uploadMask).not.toHaveBeenCalled()
    expect(mocks.managedClient.prompt).not.toHaveBeenCalled()
    expect(mocks.managedClient.history).not.toHaveBeenCalled()
    expect(mocks.managedClient.historyAll).not.toHaveBeenCalled()
    expect(mocks.managedClient.getQueue).not.toHaveBeenCalled()
    expect(mocks.managedClient.freeMemory).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })

  it('rejects a persisted symlink before upload or prompt', async () => {
    await stopTaskQueue()
    const directory = await mkdtemp(path.join(tmpdir(), 'magicpot-persisted-symlink-'))
    restartTempDirectories.push(directory)
    const authorizedRoot = path.join(directory, 'qapp-input-images')
    await mkdir(authorizedRoot)
    const outside = path.join(directory, 'outside.png')
    await writeFile(outside, new Uint8Array([1, 2, 3]))
    const filePath = path.join(authorizedRoot, 'link.png')
    try {
      await symlink(outside, filePath, 'file')
    } catch {
      return
    }
    await initTaskQueue({
      eventStore: new MagicAgentEventStore(':memory:'),
      deferredFileAuthorizedRoot: authorizedRoot
    })
    const workflow: Workflow = {
      '1': {
        class_type: 'LoadImage',
        inputs: {
          image: encodeDeferredComfyImageInputValue({
            fileName: 'link.png',
            mimeType: 'image/png',
            filePath,
            sizeBytes: 3
          })
        }
      }
    }
    const id = add(workflow)
    await vi.advanceTimersByTimeAsync(1_100)
    await waitForTask(id, 'error')
    expect(mocks.managedClient.uploadImage).not.toHaveBeenCalled()
    expect(mocks.managedClient.uploadMask).not.toHaveBeenCalled()
    expect(mocks.managedClient.prompt).not.toHaveBeenCalled()
    expect(mocks.managedClient.historyAll).not.toHaveBeenCalled()
    expect(mocks.managedClient.getQueue).not.toHaveBeenCalled()
  })

  it('routes prompt-id-only cancellation to the task instance', async () => {
    const cancellationPromptId = 'managed-cancel-prompt'
    let resolveHistory!: (value: Record<string, ComfyHistory>) => void
    const historyPending = new Promise<Record<string, ComfyHistory>>((resolve) => {
      resolveHistory = resolve
    })
    mocks.managedClient.prompt.mockResolvedValueOnce({ prompt_id: cancellationPromptId })
    mocks.managedClient.history.mockReturnValue(historyPending)
    const id = add()
    await vi.advanceTimersByTimeAsync(1_100)
    await waitForTask(id, 'running')
    expect(getTask(id)[1]).toMatchObject({ prompt_id: cancellationPromptId, instanceId: 'gpu-b' })

    mocks.managedClient.getQueue
      .mockResolvedValueOnce({
        queue_running: [[0, cancellationPromptId, baseWorkflow, { client_id: 'transport' }, []]],
        queue_pending: []
      })
      .mockResolvedValue({ queue_running: [], queue_pending: [] })
    const cancellation = cancelTaskByPromptId(cancellationPromptId)
    await vi.waitFor(() =>
      expect(mocks.managedClient.cancel).toHaveBeenCalledWith(
        cancellationPromptId,
        expect.any(AbortSignal)
      )
    )
    expect(mocks.registry.get).not.toHaveBeenCalled()
    expect(mocks.getComfyInstanceClient).not.toHaveBeenCalled()
    expect(mocks.managedClient.interrupt).not.toHaveBeenCalled()
    expect(mocks.managedClient.cancel).toHaveBeenCalledWith(
      cancellationPromptId,
      expect.any(AbortSignal)
    )
    expect(mocks.legacyClient.interrupt).not.toHaveBeenCalled()
    expect(mocks.legacyClient.cancel).not.toHaveBeenCalled()

    resolveHistory({
      [cancellationPromptId]: {
        ...success(cancellationPromptId, baseWorkflow),
        status: {
          status_str: 'error',
          completed: true,
          messages: [
            ['execution_interrupted', { prompt_id: cancellationPromptId, timestamp: 1 }] as never
          ]
        }
      }
    })
    await cancellation
    await waitForTask(id, 'cancelled')
    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mocks.acquireComfyInstance).toHaveBeenCalledTimes(1))
  })

  it('cancels during a durable lease before POST without reconciliation', async () => {
    let resolveObjectInfo!: (value: Record<string, unknown>) => void
    mocks.managedClient.objectInfo.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveObjectInfo = resolve
      })
    )
    const id = add()
    await vi.advanceTimersByTimeAsync(1_100)
    await vi.waitFor(() => expect(mocks.managedClient.objectInfo).toHaveBeenCalledTimes(1))
    const cancellation = cancelTask(id)
    resolveObjectInfo({})
    await expect(cancellation).resolves.toBe(true)
    await waitForTask(id, 'cancelled')
    expect(mocks.managedClient.prompt).not.toHaveBeenCalled()
    expect(mocks.managedClient.historyAll).not.toHaveBeenCalled()
    expect(mocks.managedClient.getQueue).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })

  it.each(['success', 'failure'] as const)(
    'projects the authoritative %s terminal when cancellation races history',
    async (outcome) => {
      const promptId = `race-${outcome}`
      let resolveHistory!: (value: Record<string, ComfyHistory>) => void
      const historyPending = new Promise<Record<string, ComfyHistory>>((resolve) => {
        resolveHistory = resolve
      })
      mocks.managedClient.prompt.mockResolvedValueOnce({ prompt_id: promptId })
      mocks.managedClient.history.mockReturnValue(historyPending)
      const id = add()
      await vi.advanceTimersByTimeAsync(1_100)
      await waitForTask(id, 'running')
      const cancellation = cancelTask(id)
      await vi.waitFor(() => expect(mocks.managedClient.cancel).toHaveBeenCalled())
      const history = success(promptId, baseWorkflow)
      if (outcome === 'failure')
        history.status = {
          status_str: 'error',
          completed: true,
          messages: [['execution_error', { prompt_id: promptId }] as never]
        }
      resolveHistory({ [promptId]: history })
      await expect(cancellation).resolves.toBe(true)
      await waitForTask(id, outcome === 'success' ? 'completed' : 'error')
      expect(getTask(id)[0]).toBe(outcome === 'success' ? 'completed' : 'error')
      expect(mocks.release).toHaveBeenCalledTimes(1)
    }
  )

  it('makes stop wait for a tracked prompt-id cancellation and gates new calls', async () => {
    const promptId = 'blocked-stop-prompt'
    let resolveHistory!: (value: Record<string, ComfyHistory>) => void
    const historyPending = new Promise<Record<string, ComfyHistory>>((resolve) => {
      resolveHistory = resolve
    })
    mocks.managedClient.prompt.mockResolvedValueOnce({ prompt_id: promptId })
    mocks.managedClient.history.mockReturnValue(historyPending)
    const id = add()
    await vi.advanceTimersByTimeAsync(1_100)
    await waitForTask(id, 'running')
    const cancellation = cancelTaskByPromptId(promptId)
    await vi.waitFor(() => expect(mocks.managedClient.cancel).toHaveBeenCalled())
    let stopped = false
    const stopping = stopTaskQueue().then(() => {
      stopped = true
    })
    await flush()
    expect(stopped).toBe(false)
    await expect(cancelTask(id)).resolves.toBe(false)
    resolveHistory({
      [promptId]: {
        ...success(promptId, baseWorkflow),
        status: {
          status_str: 'error',
          completed: true,
          messages: [['execution_interrupted', { prompt_id: promptId, timestamp: 1 }] as never]
        }
      }
    })
    await cancellation
    await stopping
    expect(stopped).toBe(true)
    expect(() => add()).toThrow('not ready')
  })

  it('does not interrupt unrelated work when cancellation precedes the prompt response', async () => {
    let resolvePrompt!: (value: { prompt_id: string }) => void
    const pendingPrompt = new Promise<{ prompt_id: string }>((resolve) => {
      resolvePrompt = resolve
    })
    mocks.managedClient.prompt.mockReturnValueOnce(pendingPrompt)
    mocks.managedClient.getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] })
    const id = add()
    await vi.advanceTimersByTimeAsync(1_100)
    await waitForTask(id, 'running')

    const cancellation = cancelTask(id)
    await flush()
    expect(mocks.managedClient.interrupt).not.toHaveBeenCalled()
    expect(getTask(id)[0]).toBe('cancelling')

    resolvePrompt({ prompt_id: 'late-prompt' })
    await expect(cancellation).resolves.toBe(true)
    await vi.waitFor(() =>
      expect(mocks.managedClient.cancel).toHaveBeenCalledWith(
        'late-prompt',
        expect.any(AbortSignal)
      )
    )
    const unknown = await waitForTask(id, 'unknown')
    expect(unknown).toMatchObject({ cancelRequested: true, requiresManualIntervention: true })
    expect(mocks.managedClient.interrupt).not.toHaveBeenCalled()

    mocks.managedClient.getQueue.mockResolvedValue({
      queue_running: [[0, 'late-prompt', baseWorkflow, { magicpot_task_id: id }, []]],
      queue_pending: []
    })
    mocks.managedClient.historyAll.mockResolvedValue({
      'late-prompt': {
        ...success('late-prompt', baseWorkflow),
        prompt: [0, 'late-prompt', baseWorkflow, { magicpot_task_id: id }, []]
      }
    })
    await expect(resolveTaskSubmission(id, 'submitted', 'late-prompt')).rejects.toThrow(
      'does not carry this task submission token'
    )
  })

  it('keeps accepted-but-unresolved submissions in explicit unknown state without releasing capacity', async () => {
    mocks.managedClient.prompt.mockRejectedValueOnce(
      Object.assign(new TypeError('response lost'), { cause: { code: 'ECONNRESET' } })
    )
    mocks.managedClient.getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] })
    mocks.managedClient.historyAll.mockResolvedValue({})
    const id = add()
    await vi.advanceTimersByTimeAsync(2_000)
    const task = await waitForTask(id, 'unknown')

    expect(task).toMatchObject({
      submissionState: 'unknown',
      submissionUnknown: true,
      requiresManualIntervention: true
    })
    expect(mocks.managedClient.prompt).toHaveBeenCalledTimes(1)
    expect(mocks.release).not.toHaveBeenCalled()

    const [resolvedA, resolvedB] = await Promise.all([
      resolveTaskSubmission(id, 'cancelled'),
      resolveTaskSubmission(id, 'cancelled')
    ])
    expect(resolvedA.submissionUnknown).toBe(false)
    expect(resolvedB.id).toBe(id)
    expect(getTask(id)[0]).toBe('cancelled')
    await expect(resolveTaskSubmission(id, 'submitted', 'other-prompt')).rejects.toThrow()
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })

  it('reconciles a late submission token instead of retrying the prompt', async () => {
    mocks.managedClient.prompt.mockRejectedValueOnce(
      Object.assign(new TypeError('response lost'), { cause: { code: 'ECONNRESET' } })
    )
    let historyAttempt = 0
    const id = add()
    mocks.managedClient.historyAll.mockImplementation(async () => {
      historyAttempt += 1
      if (historyAttempt < 3) return {}
      return {
        'token-prompt': {
          ...success('token-prompt', baseWorkflow),
          prompt: [
            0,
            'token-prompt',
            baseWorkflow,
            { client_id: 'transport', magicpot_task_id: id },
            []
          ]
        }
      }
    })
    mocks.managedClient.history.mockResolvedValue({
      'token-prompt': success('token-prompt', baseWorkflow)
    })
    await vi.advanceTimersByTimeAsync(2_000)
    const task = await waitForTask(id, 'completed')

    expect(task.prompt_id).toBe('token-prompt')
    expect(mocks.managedClient.prompt).toHaveBeenCalledTimes(1)
  })

  it('commits success before slow cleanup and cannot be changed to cancelled', async () => {
    let resolveCleanup!: () => void
    const cleanupPending = new Promise<void>((resolve) => {
      resolveCleanup = resolve
    })
    mocks.managedClient.isRemoteComfyUI.mockReturnValueOnce(false)
    mocks.managedClient.freeMemory.mockReturnValueOnce(cleanupPending)
    const id = addTask({
      id: '',
      type: 'comfy_prompt',
      client_id: 'renderer-client',
      created_at: 1,
      prompt_id: null,
      payload: structuredClone(baseWorkflow),
      cleanupAfterRun: true,
      result: null
    })

    await vi.advanceTimersByTimeAsync(1_100)
    await waitForTask(id, 'completed')

    expect(mocks.managedClient.freeMemory).toHaveBeenCalledTimes(1)
    expect(mocks.release).not.toHaveBeenCalled()
    await expect(cancelTask(id)).resolves.toBe(false)
    expect(getTask(id)[0]).toBe('completed')

    resolveCleanup()
    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(1))
    expect(getTask(id)[0]).toBe('completed')
  })

  it('keeps a restored known-prompt cancellation unconfirmed and capacity retained', async () => {
    await stopTaskQueue()
    const eventStore = new MagicAgentEventStore(':memory:')
    const jobs = new ComfyJobStore(eventStore)
    const route = getComfyOutputRouteStore().capture({
      id: 'gpu-b',
      origin: 'https://gpu-b.example/',
      kind: 'remote'
    })
    const created = jobs.create({
      jobId: 'cancel-restart',
      workflow: baseWorkflow,
      clientId: 'renderer-client',
      createdAt: 1,
      idempotencyKey: 'create-cancel-restart'
    })
    const leased = jobs.assign({
      jobId: created.id,
      expectedRevision: created.revision,
      instanceId: 'gpu-b',
      instanceRouteId: route.routeId,
      instanceOrigin: route.origin,
      instanceKind: route.kind,
      leaseOwner: 'old',
      leaseExpiresAt: 9999,
      at: 2,
      idempotencyKey: 'lease-cancel-restart'
    })
    const prepared = jobs.prepare({
      jobId: created.id,
      expectedRevision: leased.revision,
      submissionToken: created.id,
      promptWorkflow: baseWorkflow,
      historyWorkflow: baseWorkflow,
      at: 3,
      idempotencyKey: 'prepare-cancel-restart'
    })
    const submitting = jobs.markSubmitting({
      jobId: created.id,
      expectedRevision: prepared.revision,
      at: 4,
      idempotencyKey: 'submitting-cancel-restart'
    })
    const submitted = jobs.bindPrompt({
      jobId: created.id,
      expectedRevision: submitting.revision,
      promptId: 'known-cancel-prompt',
      at: 5,
      idempotencyKey: 'bind-cancel-restart'
    })
    jobs.requestCancel({
      jobId: created.id,
      expectedRevision: submitted.revision,
      at: 6,
      idempotencyKey: 'request-cancel-restart'
    })
    mocks.legacyClient.getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] })
    mocks.legacyClient.history.mockResolvedValue({})
    await initTaskQueue({ eventStore })
    const task = await waitForTask('cancel-restart', 'unknown')
    expect(task).toMatchObject({ cancelRequested: true, prompt_id: 'known-cancel-prompt' })
    expect(mocks.retainRestoredComfyInstanceCapacity).toHaveBeenCalled()
    expect(mocks.releaseRestoredComfyInstanceCapacity).not.toHaveBeenCalled()
  })

  it('fails closed when restored job authority conflicts with its captured route', async () => {
    await stopTaskQueue()
    const eventStore = new MagicAgentEventStore(':memory:')
    const jobs = new ComfyJobStore(eventStore)
    const route = getComfyOutputRouteStore().capture({
      id: 'gpu-b',
      origin: 'https://gpu-b.example/',
      kind: 'remote'
    })
    const created = jobs.create({
      jobId: 'tampered-route-restart',
      workflow: baseWorkflow,
      clientId: 'renderer-client',
      createdAt: 1,
      idempotencyKey: 'create-tampered-route-restart'
    })
    jobs.assign({
      jobId: created.id,
      expectedRevision: created.revision,
      instanceId: 'gpu-b',
      instanceRouteId: route.routeId,
      instanceOrigin: 'https://tampered.example/',
      instanceKind: route.kind,
      leaseOwner: 'old',
      leaseExpiresAt: 9_999,
      at: 2,
      idempotencyKey: 'lease-tampered-route-restart'
    })
    const restoredRelease = vi.fn()
    mocks.retainRestoredComfyInstanceCapacity.mockReturnValueOnce(restoredRelease)

    await initTaskQueue({ eventStore })
    await vi.advanceTimersByTimeAsync(1_100)
    const task = await waitForTask('tampered-route-restart', 'error')

    expect(task.historyPayload ?? task.payload).toEqual(baseWorkflow)
    expect(mocks.acquireComfyInstance).not.toHaveBeenCalled()
    expect(mocks.managedClient.objectInfo).not.toHaveBeenCalled()
    expect(mocks.managedClient.uploadImage).not.toHaveBeenCalled()
    expect(mocks.managedClient.uploadMask).not.toHaveBeenCalled()
    expect(mocks.managedClient.prompt).not.toHaveBeenCalled()
    expect(mocks.managedClient.history).not.toHaveBeenCalled()
    expect(mocks.managedClient.historyAll).not.toHaveBeenCalled()
    expect(mocks.managedClient.getQueue).not.toHaveBeenCalled()
    expect(mocks.legacyClient.objectInfo).not.toHaveBeenCalled()
    expect(mocks.legacyClient.prompt).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(restoredRelease).toHaveBeenCalledTimes(1))
  })

  it('releases restored capacity and remains stopped when initialization fails', async () => {
    await stopTaskQueue()
    const eventStore = new MagicAgentEventStore(':memory:')
    const jobs = new ComfyJobStore(eventStore)
    const route = getComfyOutputRouteStore().capture({
      id: 'gpu-b',
      origin: 'https://gpu-b.example/',
      kind: 'remote'
    })
    const created = jobs.create({
      jobId: 'failed-init-restart',
      workflow: baseWorkflow,
      clientId: 'renderer-client',
      createdAt: 1,
      idempotencyKey: 'create-failed-init-restart'
    })
    jobs.assign({
      jobId: created.id,
      expectedRevision: created.revision,
      instanceId: 'gpu-b',
      instanceRouteId: route.routeId,
      instanceOrigin: route.origin,
      instanceKind: route.kind,
      leaseOwner: 'old',
      leaseExpiresAt: 9_999,
      at: 2,
      idempotencyKey: 'lease-failed-init-restart'
    })
    const restoredRelease = vi.fn()
    mocks.retainRestoredComfyInstanceCapacity.mockReturnValueOnce(restoredRelease)

    await expect(
      initTaskQueue({
        eventStore,
        beforeStart: async () => {
          throw new Error('startup barrier failed')
        }
      })
    ).rejects.toThrow('startup barrier failed')

    expect(restoredRelease).toHaveBeenCalledTimes(1)
    expect(() => add()).toThrow('not ready')
  })

  it('restores queued dispatch target and requirements before acquiring an instance', async () => {
    await stopTaskQueue()
    const storePath = await createRestartStorePath()
    const seedStore = new MagicAgentEventStore(storePath)
    const jobs = new ComfyJobStore(seedStore)
    jobs.create({
      jobId: 'queued-policy-restart',
      workflow: baseWorkflow,
      clientId: 'renderer-client',
      target: { mode: 'specific', instanceId: 'gpu-b' },
      requirements: {
        tags: ['restored-policy'],
        models: ['model.safetensors'],
        customNodes: ['LoraLoader']
      },
      createdAt: 1,
      idempotencyKey: 'create-queued-policy-restart'
    })
    seedStore.close()
    const restoredStore = new MagicAgentEventStore(storePath)
    restartStores.push(restoredStore)

    await initTaskQueue({ eventStore: restoredStore })
    await vi.advanceTimersByTimeAsync(1_100)
    await waitForTask('queued-policy-restart', 'completed')

    expect(mocks.acquireComfyInstance).toHaveBeenCalledWith(
      baseWorkflow,
      expect.objectContaining({
        target: { mode: 'specific', instanceId: 'gpu-b' },
        requirements: {
          tags: ['restored-policy'],
          models: ['model.safetensors'],
          customNodes: ['LoraLoader']
        },
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('restores a prepared job by reusing durable workflows and posting exactly once', async () => {
    await stopTaskQueue()
    const storePath = await createRestartStorePath()
    const seedStore = new MagicAgentEventStore(storePath)
    const jobs = new ComfyJobStore(seedStore)
    const route = getComfyOutputRouteStore().capture({
      id: 'gpu-b',
      origin: 'https://gpu-b.example/',
      kind: 'remote'
    })
    const created = jobs.create({
      jobId: 'prepared-restart',
      workflow: baseWorkflow,
      clientId: 'renderer-client',
      createdAt: 1,
      idempotencyKey: 'create'
    })
    const leased = jobs.assign({
      jobId: 'prepared-restart',
      expectedRevision: created.revision,
      instanceId: 'gpu-b',
      instanceRouteId: route.routeId,
      instanceOrigin: route.origin,
      instanceKind: route.kind,
      leaseOwner: 'old-process',
      leaseExpiresAt: 20,
      at: 2,
      idempotencyKey: 'assign'
    })
    jobs.prepare({
      jobId: 'prepared-restart',
      expectedRevision: leased.revision,
      submissionToken: 'prepared-restart',
      promptWorkflow: baseWorkflow,
      historyWorkflow: baseWorkflow,
      at: 3,
      idempotencyKey: 'prepare'
    })
    seedStore.close()
    const restoredStore = new MagicAgentEventStore(storePath)
    restartStores.push(restoredStore)
    mocks.legacyClient.prompt.mockResolvedValueOnce({ prompt_id: 'prepared-prompt' })
    mocks.legacyClient.history.mockResolvedValueOnce({
      'prepared-prompt': success('prepared-prompt', baseWorkflow)
    })

    await initTaskQueue({ eventStore: restoredStore })
    await waitForTask('prepared-restart', 'completed')

    expect(mocks.legacyClient.prompt).toHaveBeenCalledTimes(1)
    expect(mocks.legacyClient.objectInfo).not.toHaveBeenCalled()
    expect(mocks.legacyClient.uploadImage).not.toHaveBeenCalled()
  })

  it('reconciles a restarted submitting job without repeating POST', async () => {
    await stopTaskQueue()
    const storePath = await createRestartStorePath()
    const seedStore = new MagicAgentEventStore(storePath)
    const jobs = new ComfyJobStore(seedStore)
    const route = getComfyOutputRouteStore().capture({
      id: 'gpu-b',
      origin: 'https://gpu-b.example/',
      kind: 'remote'
    })
    const created = jobs.create({
      jobId: 'submitting-restart',
      workflow: baseWorkflow,
      clientId: 'renderer-client',
      createdAt: 1,
      idempotencyKey: 'create'
    })
    const leased = jobs.assign({
      jobId: 'submitting-restart',
      expectedRevision: created.revision,
      instanceId: 'gpu-b',
      instanceRouteId: route.routeId,
      instanceOrigin: route.origin,
      instanceKind: route.kind,
      leaseOwner: 'old-process',
      leaseExpiresAt: 20,
      at: 2,
      idempotencyKey: 'assign'
    })
    const prepared = jobs.prepare({
      jobId: 'submitting-restart',
      expectedRevision: leased.revision,
      submissionToken: 'submitting-restart',
      promptWorkflow: baseWorkflow,
      historyWorkflow: baseWorkflow,
      at: 3,
      idempotencyKey: 'prepare'
    })
    jobs.markSubmitting({
      jobId: 'submitting-restart',
      expectedRevision: prepared.revision,
      at: 4,
      idempotencyKey: 'submitting'
    })
    seedStore.close()
    const restoredStore = new MagicAgentEventStore(storePath)
    restartStores.push(restoredStore)
    mocks.legacyClient.getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] })
    mocks.legacyClient.historyAll.mockResolvedValue({
      'accepted-prompt': {
        ...success('accepted-prompt', baseWorkflow),
        prompt: [0, 'accepted-prompt', baseWorkflow, { magicpot_task_id: 'submitting-restart' }, []]
      }
    })
    mocks.legacyClient.history.mockResolvedValue({
      'accepted-prompt': success('accepted-prompt', baseWorkflow)
    })

    await initTaskQueue({ eventStore: restoredStore })
    await waitForTask('submitting-restart', 'completed')

    expect(mocks.legacyClient.prompt).not.toHaveBeenCalled()
    expect(mocks.legacyClient.historyAll).toHaveBeenCalled()
  })

  it('fails closed before any Comfy side effect when no endpoint can be captured', async () => {
    mocks.acquireComfyInstance.mockResolvedValueOnce(null)
    const id = add()
    await vi.advanceTimersByTimeAsync(1_100)
    await waitForTask(id, 'error')

    expect(mocks.legacyClient.objectInfo).not.toHaveBeenCalled()
    expect(mocks.legacyClient.prompt).not.toHaveBeenCalled()
    expect(mocks.legacyClient.history).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  })
})
