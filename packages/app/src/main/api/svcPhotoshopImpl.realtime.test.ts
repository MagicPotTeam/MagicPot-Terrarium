import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import type { ComfyHistory } from '@shared/comfy/types'

const mocks = vi.hoisted(() => ({
  addTask: vi.fn(),
  cancelTask: vi.fn(),
  getQueue: vi.fn(),
  getTask: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => process.cwd()) },
  clipboard: { readImage: vi.fn() },
  nativeImage: {},
  shell: {}
}))
vi.mock('child_process', () => ({ exec: vi.fn(), execFile: vi.fn() }))
vi.mock('../queue/taskQueue', () => ({
  addTask: mocks.addTask,
  cancelTask: mocks.cancelTask,
  getQueue: mocks.getQueue,
  getTask: mocks.getTask
}))
vi.mock('@shared/comfy/deferredImages', () => ({
  encodeDeferredComfyImageInputValue: vi.fn(() => 'deferred-image')
}))
vi.mock('../testUiPolicy', () => ({
  readTestUiEnv: vi.fn(() => ({})),
  resolveTestUiPolicy: vi.fn(() => ({})),
  resolveTestArtifactPath: vi.fn(() => process.cwd())
}))

import { PhotoshopSvcImpl, waitForQueuedPhotoshopTask } from './svcPhotoshopImpl'

const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )
)

const history = (promptId: string, withOutput = true): ComfyHistory => ({
  prompt: [0, promptId, {}, { client_id: 'transport' }, []],
  outputs: withOutput
    ? { save: { images: [{ filename: `${promptId}.png`, type: 'output' }] } }
    : {},
  status: { status_str: 'success', completed: true, messages: [] }
})

const request = {
  workflowTemplate: JSON.stringify({ input: { inputs: { image: '' }, class_type: 'LoadImage' } }),
  imageInputSlot: 'input.inputs.image',
  outputNodeIds: ['save'],
  pollInterval: 10
}

const tick = async (ms = 25): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await Promise.resolve()
}

describe('Photoshop realtime queue behavior', () => {
  let service: PhotoshopSvcImpl

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    service = new PhotoshopSvcImpl()
    vi.spyOn(
      service as unknown as {
        loadImageFromPhotoshopInternal: (
          req: Record<string, never>,
          signal?: AbortSignal
        ) => Promise<{ image: Uint8Array; fileName: string }>
      },
      'loadImageFromPhotoshopInternal'
    ).mockResolvedValue({
      image: png,
      fileName: 'input.png'
    })
    mocks.getQueue.mockReturnValue({
      running: [],
      pending: [],
      completed: [],
      error: [],
      unknown: [],
      cancelling: [],
      cancelled: []
    })
    mocks.cancelTask.mockResolvedValue(true)
  })

  afterEach(async () => {
    await service.stopRealtimeGeneration({})
    vi.useRealTimers()
  })

  it('serializes concurrent starts so only the final session remains active', async () => {
    mocks.addTask.mockReturnValue('ordinary-concurrent-start')
    mocks.getTask.mockReturnValue([
      'completed',
      {
        id: 'ordinary-concurrent-start',
        prompt_id: 'comfy-concurrent-start',
        result: history('comfy-concurrent-start')
      }
    ])
    const first = service.startRealtimeGeneration({ ...request, pollInterval: 20 })
    const second = service.startRealtimeGeneration({ ...request, pollInterval: 30 })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { success: true },
      { success: true }
    ])
    expect((await service.getRealtimeGenerationStatus({})).isRunning).toBe(true)
    await tick(35)
    expect(mocks.addTask).toHaveBeenCalledTimes(1)
  })

  it('serializes a public Photoshop load with a simultaneous realtime export', async () => {
    const internal = service as unknown as {
      loadImageFromPhotoshopInternal: (
        req: Record<string, never>,
        signal?: AbortSignal
      ) => Promise<{ image: Uint8Array; fileName: string }>
    }
    let resolvePublic!: (value: { image: Uint8Array; fileName: string }) => void
    const internalSpy = vi
      .spyOn(internal, 'loadImageFromPhotoshopInternal')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePublic = resolve
          })
      )
      .mockResolvedValueOnce({ image: png, fileName: 'realtime.png' })
    mocks.addTask.mockReturnValue('ordinary-serialized-export')
    mocks.getTask.mockReturnValue([
      'completed',
      {
        id: 'ordinary-serialized-export',
        prompt_id: 'comfy-serialized-export',
        result: history('comfy-serialized-export')
      }
    ])

    const publicLoad = service.loadImageFromPhotoshop({})
    await Promise.resolve()
    await service.startRealtimeGeneration(request)
    await tick(50)
    expect(internalSpy).toHaveBeenCalledTimes(1)
    expect(mocks.addTask).not.toHaveBeenCalled()

    resolvePublic({ image: png, fileName: 'public.png' })
    await publicLoad
    await tick(50)
    expect(internalSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(mocks.addTask).toHaveBeenCalledTimes(1)
  })

  it('stops promptly while an underlying load promise is blocked and isolates the next session', async () => {
    const internal = service as unknown as {
      loadImageFromPhotoshopInternal: (
        req: Record<string, never>,
        signal?: AbortSignal
      ) => Promise<{ image: Uint8Array; fileName: string }>
    }
    const loadSpy = vi.spyOn(internal, 'loadImageFromPhotoshopInternal')
    let resolveOldLoad!: (value: { image: Uint8Array; fileName: string }) => void
    loadSpy
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldLoad = resolve
          })
      )
      .mockResolvedValueOnce({ image: png, fileName: 'new.png' })
    mocks.addTask.mockReturnValue('ordinary-new-load')
    mocks.getTask.mockReturnValue([
      'completed',
      {
        id: 'ordinary-new-load',
        prompt_id: 'comfy-new-load',
        result: history('comfy-new-load')
      }
    ])

    await service.startRealtimeGeneration(request)
    await tick()
    const stopped = service.stopRealtimeGeneration({})
    await expect(stopped).resolves.toEqual({ success: true })

    const restart = service.startRealtimeGeneration(request)
    await tick(50)
    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(mocks.addTask).not.toHaveBeenCalled()

    resolveOldLoad({ image: png, fileName: 'old-late.png' })
    await restart
    await tick(50)

    const status = await service.getRealtimeGenerationStatus({})
    expect(loadSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(status.latestGeneratedResult?.promptId).toBe('comfy-new-load')
    expect(mocks.addTask).toHaveBeenCalledTimes(1)
  })

  it('uses a distinct fallback output path after a direct Windows export failure', async () => {
    const internal = service as unknown as {
      exportFromPhotoshopWindowsWithFallback: (
        outputPath: string,
        signal?: AbortSignal
      ) => Promise<string>
      exportFromPhotoshopWindows: (outputPath: string, signal?: AbortSignal) => Promise<void>
      exportFromPhotoshopWindowsViaClipboard: (
        outputPath: string,
        signal?: AbortSignal
      ) => Promise<void>
    }
    vi.spyOn(internal, 'exportFromPhotoshopWindows').mockRejectedValue(new Error('direct failed'))
    const fallback = vi
      .spyOn(internal, 'exportFromPhotoshopWindowsViaClipboard')
      .mockResolvedValue(undefined)
    const directPath = 'C:\\temp\\photoshop-export-direct-nonce.png'

    const selectedPath = await internal.exportFromPhotoshopWindowsWithFallback(directPath)

    expect(selectedPath).not.toBe(directPath)
    expect(selectedPath).toMatch(/photoshop-export-fallback-[0-9a-f-]+\.png$/)
    expect(fallback).toHaveBeenCalledWith(selectedPath, undefined)
  })

  it('cleans direct and fallback output paths without confusing the authoritative fallback', async () => {
    const internal = service as unknown as {
      exportFromPhotoshopWindowsWithFallback: (
        outputPath: string,
        signal?: AbortSignal
      ) => Promise<string>
      exportFromPhotoshopWindows: (outputPath: string, signal?: AbortSignal) => Promise<void>
      exportFromPhotoshopWindowsViaClipboard: (
        outputPath: string,
        signal?: AbortSignal
      ) => Promise<void>
    }
    vi.spyOn(internal, 'exportFromPhotoshopWindows').mockRejectedValue(new Error('direct failed'))
    vi.spyOn(internal, 'exportFromPhotoshopWindowsViaClipboard').mockResolvedValue(undefined)
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValue(new Error('not present'))
    const directPath = 'C:\\temp\\direct-orphan.png'

    vi.useFakeTimers()
    const fallbackPath = await internal.exportFromPhotoshopWindowsWithFallback(directPath)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(fallbackPath).not.toBe(directPath)
    expect(unlink.mock.calls.filter(([filePath]) => filePath === directPath).length).toBe(4)
    expect(unlink).not.toHaveBeenCalledWith(fallbackPath)
    unlink.mockRestore()
  })

  it('schedules bounded cleanup when an authoritative export load fails or aborts', async () => {
    const cleanupService = new PhotoshopSvcImpl()
    const internal = cleanupService as unknown as {
      loadImageFromPhotoshopInternal: (
        req: Record<string, never>,
        signal?: AbortSignal
      ) => Promise<{ image: Uint8Array; fileName: string }>
      exportFromPhotoshopMac: (outputPath: string, signal?: AbortSignal) => Promise<void>
    }
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValue(new Error('not present'))
    vi.spyOn(internal, 'exportFromPhotoshopMac').mockRejectedValue(new Error('export failed'))
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    vi.useFakeTimers()
    await expect(internal.loadImageFromPhotoshopInternal({})).rejects.toThrow('export failed')
    await vi.advanceTimersByTimeAsync(60_000)

    const cleanedPaths = unlink.mock.calls.map(([filePath]) => String(filePath))
    expect(cleanedPaths).toHaveLength(4)
    expect(new Set(cleanedPaths).size).toBe(1)
    expect(cleanedPaths[0]).toMatch(/photoshop-export-[0-9a-f-]+\.png$/)
    platform.mockRestore()
    unlink.mockRestore()
  })

  it('accepts an authoritative completion read at the timeout boundary', async () => {
    mocks.getTask.mockReturnValue([
      'completed',
      {
        id: 'ordinary-final-window',
        prompt_id: 'comfy-final-window',
        result: history('comfy-final-window')
      }
    ])
    const controller = new AbortController()

    await expect(
      waitForQueuedPhotoshopTask('ordinary-final-window', controller.signal, 0)
    ).resolves.toMatchObject({ promptId: 'comfy-final-window' })
    expect(mocks.getTask).toHaveBeenCalledTimes(1)
  })

  it('cancels the active ordinary task and aborts polling when stopped pending', async () => {
    mocks.addTask.mockReturnValue('ordinary-task-1')
    mocks.getTask.mockReturnValue([
      'pending',
      { id: 'ordinary-task-1', prompt_id: null, result: null }
    ])
    await service.startRealtimeGeneration(request)
    await tick()

    await expect(service.stopRealtimeGeneration({})).resolves.toEqual({ success: true })
    expect(mocks.cancelTask).toHaveBeenCalledWith('ordinary-task-1')
    expect((await service.getRealtimeGenerationStatus({})).isRunning).toBe(false)
  })

  it('bounds a hung queue cancellation so stop and restart cannot wait forever', async () => {
    mocks.addTask.mockReturnValue('ordinary-hung-cancel')
    mocks.getTask.mockReturnValue([
      'pending',
      { id: 'ordinary-hung-cancel', prompt_id: null, result: null }
    ])
    mocks.cancelTask.mockImplementation(() => new Promise<boolean>(() => undefined))
    await service.startRealtimeGeneration(request)
    await tick()

    const stop = service.stopRealtimeGeneration({})
    await tick(4999)
    let settled = false
    void stop.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await tick(1)
    await expect(stop).resolves.toEqual({ success: true })
    expect((await service.getRealtimeGenerationStatus({})).isRunning).toBe(false)
  })

  it('bounds catch-path cancellation and stop drain when cancellation never settles', async () => {
    mocks.addTask.mockReturnValue('ordinary-catch-hung')
    mocks.getTask
      .mockImplementationOnce(() => {
        throw new Error('synthetic poll failure')
      })
      .mockReturnValue(['pending', { id: 'ordinary-catch-hung', prompt_id: null, result: null }])
    mocks.cancelTask.mockImplementation(() => new Promise<boolean>(() => undefined))

    await service.startRealtimeGeneration(request)
    await tick()
    const stop = service.stopRealtimeGeneration({})
    await tick(5000)
    await expect(stop).resolves.toEqual({ success: true })

    mocks.cancelTask.mockResolvedValue(true)
    mocks.getTask.mockReturnValue([
      'completed',
      {
        id: 'ordinary-after-hung',
        prompt_id: 'comfy-after-hung',
        result: history('comfy-after-hung')
      }
    ])
    mocks.addTask.mockReturnValue('ordinary-after-hung')
    await expect(service.startRealtimeGeneration(request)).resolves.toEqual({ success: true })
  })

  it.each(['initial reconciliation read', 'final reconciliation read'])(
    'locks the image hash when the %s throws after submission',
    async (failurePoint) => {
      mocks.addTask.mockReturnValue('ordinary-reconcile-throw')
      if (failurePoint === 'initial reconciliation read') {
        mocks.getTask.mockImplementation(() => {
          throw new Error('queue reads unavailable')
        })
      } else {
        mocks.getTask
          .mockImplementationOnce(() => {
            throw new Error('poll read failed')
          })
          .mockReturnValueOnce([
            'pending',
            { id: 'ordinary-reconcile-throw', prompt_id: null, result: null }
          ])
          .mockImplementation(() => {
            throw new Error('final read failed')
          })
      }

      await service.startRealtimeGeneration({ ...request, pollInterval: 20 })
      await tick(100)

      expect(mocks.addTask).toHaveBeenCalledTimes(1)
    }
  )

  it('publishes a task that becomes completed during final timeout reconciliation', async () => {
    mocks.addTask.mockReturnValue('ordinary-final-reconcile')
    mocks.getTask
      .mockReturnValueOnce([
        'pending',
        { id: 'ordinary-final-reconcile', prompt_id: null, result: null }
      ])
      .mockReturnValue([
        'completed',
        {
          id: 'ordinary-final-reconcile',
          prompt_id: 'comfy-final-reconcile',
          result: history('comfy-final-reconcile')
        }
      ])
    let nowCalls = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCalls += 1
      return nowCalls <= 3 ? 0 : 30 * 60 * 1000
    })

    await service.startRealtimeGeneration(request)
    await tick(150)
    nowSpy.mockRestore()

    const status = await service.getRealtimeGenerationStatus({})
    expect(status.latestGeneratedResult?.promptId).toBe('comfy-final-reconcile')
    expect(mocks.addTask).toHaveBeenCalledTimes(1)
  })

  it('does not publish an old session result after restart and uses the real Comfy prompt id', async () => {
    mocks.addTask.mockReturnValueOnce('ordinary-old').mockReturnValueOnce('ordinary-new')
    let oldCompleted = false
    mocks.getTask.mockImplementation((id: string) => {
      if (id === 'ordinary-old') {
        return oldCompleted
          ? ['completed', { id, prompt_id: 'comfy-old', result: history('comfy-old') }]
          : ['pending', { id, prompt_id: null, result: null }]
      }
      return ['completed', { id, prompt_id: 'comfy-new', result: history('comfy-new') }]
    })

    await service.startRealtimeGeneration(request)
    await tick()
    const restart = service.startRealtimeGeneration(request)
    await tick()
    await restart
    oldCompleted = true
    await tick(150)

    const status = await service.getRealtimeGenerationStatus({})
    expect(status.latestGeneratedResult?.promptId).toBe('comfy-new')
    expect(status.latestGeneratedResult?.history.prompt[1]).toBe('comfy-new')
    expect(mocks.cancelTask).toHaveBeenCalledWith('ordinary-old')
  })

  it.each(['unknown', 'error'] as const)(
    'does not publish terminal %s tasks',
    async (terminalStatus) => {
      mocks.addTask.mockReturnValue('ordinary-terminal')
      mocks.getTask.mockReturnValue([
        terminalStatus,
        { id: 'ordinary-terminal', prompt_id: null, result: null }
      ])
      await service.startRealtimeGeneration(request)
      await tick(50)

      const status = await service.getRealtimeGenerationStatus({})
      expect(status.latestGeneratedResult).toBeUndefined()
    }
  )

  it('does not publish a successful task with no output images', async () => {
    mocks.addTask.mockReturnValue('ordinary-empty')
    mocks.getTask.mockReturnValue([
      'completed',
      { id: 'ordinary-empty', prompt_id: 'comfy-empty', result: history('comfy-empty', false) }
    ])
    await service.startRealtimeGeneration(request)
    await tick(50)

    expect((await service.getRealtimeGenerationStatus({})).latestGeneratedResult).toBeUndefined()
  })

  it('retries the same image after an authoritative task failure', async () => {
    mocks.addTask.mockReturnValueOnce('ordinary-error').mockReturnValueOnce('ordinary-retry')
    mocks.getTask.mockImplementation((id: string) =>
      id === 'ordinary-error'
        ? ['error', { id, prompt_id: 'comfy-error', result: null }]
        : ['completed', { id, prompt_id: 'comfy-retry', result: history('comfy-retry') }]
    )

    await service.startRealtimeGeneration(request)
    await tick(80)

    expect(mocks.addTask).toHaveBeenCalledTimes(2)
    expect((await service.getRealtimeGenerationStatus({})).latestGeneratedResult?.promptId).toBe(
      'comfy-retry'
    )
  })

  it('does not resubmit an unchanged image after an ambiguous submission', async () => {
    mocks.addTask.mockReturnValue('ordinary-unknown')
    mocks.getTask.mockReturnValue([
      'unknown',
      { id: 'ordinary-unknown', prompt_id: null, result: null }
    ])

    await service.startRealtimeGeneration(request)
    await tick(150)

    expect(mocks.addTask).toHaveBeenCalledTimes(1)
  })

  it.each(['unknown', 'cancelling'] as const)(
    'does not enqueue realtime work while the ordinary queue contains %s capacity',
    async (blockingStatus) => {
      mocks.getQueue.mockReturnValue({
        running: [],
        pending: [],
        completed: [],
        error: [],
        unknown: blockingStatus === 'unknown' ? [{ id: 'blocked' }] : [],
        cancelling: blockingStatus === 'cancelling' ? [{ id: 'blocked' }] : [],
        cancelled: []
      })

      await service.startRealtimeGeneration(request)
      await tick(80)

      expect(mocks.addTask).not.toHaveBeenCalled()
    }
  )

  it('uses only the ordinary task queue and exposes no direct Comfy client submission seam', async () => {
    mocks.addTask.mockReturnValue('ordinary-only')
    mocks.getTask.mockReturnValue([
      'completed',
      { id: 'ordinary-only', prompt_id: 'comfy-only', result: history('comfy-only') }
    ])
    await service.startRealtimeGeneration(request)
    await tick(50)

    expect(mocks.addTask).toHaveBeenCalledTimes(1)
    expect(mocks.getTask).toHaveBeenCalledWith('ordinary-only')
  })
})
