import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '@shared/comfy/types'
import { COMFY_EVENT_CLIENT_ID_ALL } from '@shared/api/svcComfy'
import type { ComfyHttpCli } from '../comfy/http'
import type { TaskQueueState } from '../queue/taskQueue'
import { ComfySvcImpl } from './svcComfyImpl'

const {
  addTaskMock,
  cancelTaskMock,
  cancelTaskByPromptIdMock,
  getQueueMock,
  getTaskMock,
  getTaskByPromptIdMock,
  listenComfyEventMock,
  importManagedMediaStreamMock,
  poolGetObjectInfoMock,
  poolOrderedInstancesMock,
  emitComfyEvent,
  resetComfyTestState,
  setTaskPromptOwner
} = vi.hoisted(() => {
  let activeListener: {
    onEvent: (event: unknown) => void
    onEnd: () => void
  } | null = null

  const taskPromptOwners = new Map<string, { id: string; client_id: string }>()

  return {
    addTaskMock: vi.fn(() => 'task-queued'),
    cancelTaskMock: vi.fn(async () => true),
    cancelTaskByPromptIdMock: vi.fn(async () => true),
    getQueueMock: vi.fn((): TaskQueueState => ({
      running: [],
      pending: [],
      completed: [],
      cancelled: [],
      error: []
    })),
    getTaskMock: vi.fn(() => [null, null] as const),
    getTaskByPromptIdMock: vi.fn((promptId: string) => {
      const task = taskPromptOwners.get(promptId)
      return task ? (['running', task] as const) : ([null, null] as const)
    }),
    listenComfyEventMock: vi.fn(
      (listener: { onEvent: (event: unknown) => void; onEnd: () => void }) => {
        activeListener = listener
      }
    ),
    importManagedMediaStreamMock: vi.fn(),
    poolGetObjectInfoMock: vi.fn(async () => ({ KSampler: {} })),
    poolOrderedInstancesMock: vi.fn(async () => []),
    emitComfyEvent: (event: unknown) => {
      activeListener?.onEvent(event)
    },
    resetComfyTestState: () => {
      activeListener = null
      taskPromptOwners.clear()
    },
    setTaskPromptOwner: (promptId: string, task: { id: string; client_id: string }) => {
      taskPromptOwners.set(promptId, task)
    }
  }
})

vi.mock('../config/config', () => ({
  getConfig: vi.fn(() => ({
    client_id: 'default-client'
  }))
}))

vi.mock('../config/buildEnv', () => ({
  getBuildEnv: vi.fn(() => ({
    env: {
      build: 'development',
      platform: 'windows',
      buildMode: 'embedded',
      packageVersion: 'test'
    },
    pathMap: {
      resources: 'C:/MagicPot/resources',
      file: 'C:/MagicPot',
      data: 'C:/MagicPot/data'
    },
    embeddedDefaults: {
      pythonCmd: '',
      comfyuiDir: '',
      comfyuiArgs: []
    }
  }))
}))

vi.mock('../comfy/loraBypass', () => ({
  processWorkflowLoras: vi.fn((workflow: Workflow) => ({
    workflow
  }))
}))

vi.mock('../queue/taskQueue', () => ({
  addTask: addTaskMock,
  cancelTask: cancelTaskMock,
  cancelTaskByPromptId: cancelTaskByPromptIdMock,
  getQueue: getQueueMock,
  getTask: getTaskMock,
  getTaskByPromptId: getTaskByPromptIdMock
}))

vi.mock('../comfy/state', () => ({
  listenComfyEvent: listenComfyEventMock
}))

vi.mock('../comfy/comfyInstancePool', () => ({
  getComfyInstancePool: () => ({
    getObjectInfo: poolGetObjectInfoMock,
    orderedAvailableInstances: poolOrderedInstancesMock
  })
}))

vi.mock('../llmProxy/chatMediaDir', () => ({
  getChatMediaDir: vi.fn(() => 'C:/media')
}))

vi.mock('../llmProxy/managedMediaStore', () => ({
  DEFAULT_MANAGED_MEDIA_MAX_BYTES: 1024,
  importManagedMediaStream: importManagedMediaStreamMock,
  ManagedMediaImportError: class ManagedMediaImportError extends Error {
    name = 'ManagedMediaImportError'
    constructor(
      public readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
}))

type TestComfyCli = Partial<Pick<ComfyHttpCli, 'objectInfo' | 'viewResponse'>>

const setComfyCli = (svc: ComfySvcImpl, cli: TestComfyCli): void => {
  ;(svc as unknown as { cli: () => TestComfyCli }).cli = () => cli
}

const setObjectInfoMock = (svc: ComfySvcImpl): void =>
  setComfyCli(svc, { objectInfo: vi.fn().mockResolvedValue({}) })

describe('ComfySvcImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetComfyTestState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('importOutputImage', () => {
    it('validates the descriptor and imports the Comfy response stream', async () => {
      const svc = new ComfySvcImpl()
      const viewResponse = vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png; charset=binary' }
        })
      )
      setComfyCli(svc, { viewResponse })
      const reference = {
        version: 1,
        kind: 'managed',
        relativePath: 'ab/hash.png',
        sha256: 'a'.repeat(64),
        sizeBytes: 3,
        mimeType: 'image/png',
        originalFileName: 'result 1.png'
      }
      importManagedMediaStreamMock.mockResolvedValue({
        reference,
        localMediaUrl: 'local-media:/managed',
        absolutePath: 'hidden',
        metadataPath: 'hidden'
      })

      await expect(
        svc.importOutputImage({
          filename: 'result 1.png',
          subfolder: 'batch 1/nested',
          type: 'output'
        })
      ).resolves.toEqual({
        reference,
        localMediaUrl: 'local-media:/managed',
        mimeType: 'image/png',
        sizeBytes: 3,
        fileName: 'result 1.png'
      })
      expect(viewResponse).toHaveBeenCalledWith(
        { filename: 'result 1.png', subfolder: 'batch 1/nested', type: 'output' },
        expect.any(AbortSignal)
      )
      expect(importManagedMediaStreamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          chatMediaRoot: expect.stringMatching(/comfy-outputs[\\/]global$/),
          mimeType: 'image/png',
          originalFileName: 'result 1.png',
          provenance: {
            source: 'comfy-output',
            filename: 'result 1.png',
            subfolder: 'batch 1/nested',
            type: 'output'
          }
        }),
        { authorizedRoot: 'C:/media' }
      )
    })

    it.each([
      '../x.png',
      'x/y.png',
      'x%20y.png',
      '%2e%2e%2fx.png',
      '%252e%252e%255cx.png',
      'C:%5cx.png',
      'x.png?raw',
      'x.png#fragment'
    ])('rejects unsafe filename %s before fetching', async (filename) => {
      const svc = new ComfySvcImpl()
      const viewResponse = vi.fn()
      setComfyCli(svc, { viewResponse })
      await expect(svc.importOutputImage({ filename, type: 'output' })).rejects.toThrow(
        'Invalid ComfyUI output filename'
      )
      expect(viewResponse).not.toHaveBeenCalled()
    })

    it.each(['a//b', 'a/./b', 'a/../b', '/absolute', 'C:/drive', '\\\\unc', 'a%2fb'])(
      'rejects unsafe subfolder %s before fetching',
      async (subfolder) => {
        const svc = new ComfySvcImpl()
        const viewResponse = vi.fn()
        setComfyCli(svc, { viewResponse })
        await expect(
          svc.importOutputImage({ filename: 'x.png', subfolder, type: 'output' })
        ).rejects.toThrow('Invalid ComfyUI output subfolder')
        expect(viewResponse).not.toHaveBeenCalled()
      }
    )

    it('rejects redirects without importing their body', async () => {
      const svc = new ComfySvcImpl()
      const viewResponse = vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 302, headers: { location: 'https://other.test/x.png' } })
        )
      setComfyCli(svc, { viewResponse })

      await expect(svc.importOutputImage({ filename: 'x.png', type: 'output' })).rejects.toThrow(
        'redirect rejected'
      )
      expect(importManagedMediaStreamMock).not.toHaveBeenCalled()
    })

    it('rejects non-output descriptors and failed or unsupported responses', async () => {
      const svc = new ComfySvcImpl()
      await expect(
        svc.importOutputImage({ filename: 'x.png', type: 'input' } as never)
      ).rejects.toThrow('must be output')
      const viewResponse = vi
        .fn()
        .mockResolvedValueOnce(new Response('no', { status: 502 }))
        .mockResolvedValueOnce(new Response('html', { headers: { 'content-type': 'text/html' } }))
      setComfyCli(svc, { viewResponse })
      await expect(svc.importOutputImage({ filename: 'x.png', type: 'output' })).rejects.toThrow(
        'HTTP 502'
      )
      await expect(svc.importOutputImage({ filename: 'x.png', type: 'output' })).rejects.toThrow(
        'unsupported image type'
      )
    })

    it('rejects declared oversize responses before importing', async () => {
      const svc = new ComfySvcImpl()
      const viewResponse = vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1]), {
          headers: { 'content-type': 'image/png', 'content-length': '1025' }
        })
      )
      setComfyCli(svc, { viewResponse })
      await expect(svc.importOutputImage({ filename: 'x.png', type: 'output' })).rejects.toThrow(
        'byte limit'
      )
      expect(importManagedMediaStreamMock).not.toHaveBeenCalled()
    })
    it('rejects chunked oversize responses and aborts stalled bodies', async () => {
      const svc = new ComfySvcImpl()
      const oversizedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1025))
          controller.close()
        }
      })
      const stalledBody = new ReadableStream<Uint8Array>({
        start() {
          // Intentionally never resolves; the service timeout must abort this body.
        }
      })
      const viewResponse = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(oversizedBody, { headers: { 'content-type': 'image/png' } })
        )
        .mockResolvedValueOnce(
          new Response(stalledBody, { headers: { 'content-type': 'image/png' } })
        )
      setComfyCli(svc, { viewResponse })
      importManagedMediaStreamMock
        .mockRejectedValueOnce(
          Object.assign(new Error('Managed media exceeds byte limit'), {
            name: 'ManagedMediaImportError',
            code: 'MANAGED_MEDIA_TOO_LARGE'
          })
        )
        .mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () =>
                reject(
                  Object.assign(new Error('aborted'), {
                    name: 'ManagedMediaImportError',
                    code: 'MANAGED_MEDIA_ABORTED'
                  })
                ),
              { once: true }
            )
          })
          throw new Error('unreachable')
        })

      await expect(
        svc.importOutputImage({ filename: 'x.png', type: 'output' })
      ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_TOO_LARGE' })

      vi.useFakeTimers()
      const stalled = svc.importOutputImage({ filename: 'x.png', type: 'output' })
      const stalledExpectation = expect(stalled).rejects.toMatchObject({
        code: 'MANAGED_MEDIA_ABORTED'
      })
      await vi.advanceTimersByTimeAsync(30_001)
      await stalledExpectation
    })

    it('rejects malformed content length and missing imported metadata with typed errors', async () => {
      const svc = new ComfySvcImpl()
      const viewResponse = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(new Uint8Array([1]), {
            headers: { 'content-type': 'image/png', 'content-length': '1x' }
          })
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
        )
      setComfyCli(svc, { viewResponse })
      importManagedMediaStreamMock.mockResolvedValueOnce({
        reference: { version: 1, kind: 'managed', relativePath: 'x', sha256: 'a'.repeat(64) },
        localMediaUrl: 'local-media:/managed'
      })

      const malformed = await svc
        .importOutputImage({ filename: 'x.png', type: 'output' })
        .catch((error) => error)
      expect(malformed).toMatchObject({
        name: 'ManagedMediaImportError',
        code: 'MANAGED_MEDIA_INVALID',
        message: 'ComfyUI view returned an invalid content length'
      })
      const invalidReference = await svc
        .importOutputImage({ filename: 'x.png', type: 'output' })
        .catch((error) => error)
      expect(invalidReference).toMatchObject({
        name: 'ManagedMediaImportError',
        code: 'MANAGED_MEDIA_INVALID',
        message: 'Imported ComfyUI output metadata is invalid'
      })
      expect(String(invalidReference)).not.toContain('relativePath')
    })
  })

  describe('getObjectInfo', () => {
    it('uses the shared ComfyUI instance pool', async () => {
      const svc = new ComfySvcImpl()
      poolGetObjectInfoMock.mockResolvedValueOnce({ CheckpointLoaderSimple: {} } as never)

      await expect(svc.getObjectInfo({})).resolves.toEqual({ CheckpointLoaderSimple: {} })
      expect(poolGetObjectInfoMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('getQueue', () => {
    it('includes recent internal task errors for the unified task center', async () => {
      getQueueMock.mockReturnValueOnce({
        running: [],
        pending: [],
        completed: [],
        cancelled: [],
        error: [
          {
            id: 'task-error',
            type: 'comfy_prompt',
            client_id: 'client-1',
            created_at: 1_735_000_000_000,
            prompt_id: 'prompt-error',
            payload: {},
            result: null
          }
        ]
      })

      const result = await new ComfySvcImpl().getQueue({})

      expect(result.queue_error).toHaveLength(1)
      expect(result.queue_error?.[0]?.[1]).toBe('task-error')
    })
  })

  describe('submitWorkflow', () => {
    it('falls back to the shared session key when no explicit client id is provided', async () => {
      const svc = new ComfySvcImpl()
      setObjectInfoMock(svc)

      const postPromptSpy = vi.spyOn(svc, 'postPrompt').mockResolvedValue({
        prompt_id: 'prompt-1'
      })
      const workflow = {} as Workflow

      await svc.submitWorkflow({
        prompt: workflow,
        sessionKey: 'canvas:thread:canvas-1:thread:agent-2'
      })

      expect(postPromptSpy).toHaveBeenCalledWith({
        prompt: workflow,
        client_id: 'canvas:thread:canvas-1:thread:agent-2',
        extra_data: undefined
      })
    })

    it('prefers an explicit client id over the session key fallback', async () => {
      const svc = new ComfySvcImpl()
      setObjectInfoMock(svc)

      const postPromptSpy = vi.spyOn(svc, 'postPrompt').mockResolvedValue({
        prompt_id: 'prompt-2'
      })
      const workflow = {} as Workflow

      await svc.submitWorkflow({
        prompt: workflow,
        clientId: 'renderer-qapp',
        sessionKey: 'canvas:thread:canvas-1:thread:agent-2'
      })

      expect(postPromptSpy).toHaveBeenCalledWith({
        prompt: workflow,
        client_id: 'renderer-qapp',
        extra_data: undefined
      })
    })

    it('uses an anonymous workflow-scoped client id instead of config.client_id when identity is missing', async () => {
      const svc = new ComfySvcImpl()
      setObjectInfoMock(svc)

      const postPromptSpy = vi.spyOn(svc, 'postPrompt').mockResolvedValue({
        prompt_id: 'prompt-3'
      })
      const workflow = {} as Workflow
      const randomUuidSpy = vi
        .spyOn(crypto, 'randomUUID')
        .mockReturnValue('00000000-0000-4000-8000-000000000000')

      await svc.submitWorkflow({
        prompt: workflow
      })

      expect(postPromptSpy).toHaveBeenCalledWith({
        prompt: workflow,
        client_id: 'magicpot-workflow-00000000-0000-4000-8000-000000000000',
        extra_data: undefined
      })

      randomUuidSpy.mockRestore()
    })

    it('strips UI-only nodes before posting the prompt to ComfyUI', async () => {
      const svc = new ComfySvcImpl()
      setObjectInfoMock(svc)

      const postPromptSpy = vi.spyOn(svc, 'postPrompt').mockResolvedValue({
        prompt_id: 'prompt-4'
      })

      await svc.submitWorkflow({
        prompt: {
          '10': {
            class_type: 'SeedVR2VideoUpscaler',
            inputs: {
              image: ['31', 0]
            }
          },
          '18': {
            class_type: 'Note',
            inputs: {
              value: 'Enable to upscale alpha/mask channel along with RGB channel.'
            }
          },
          '31': {
            class_type: 'LoadImage',
            inputs: {
              image: 'input.png'
            }
          }
        },
        clientId: 'renderer-qapp'
      })

      expect(postPromptSpy).toHaveBeenCalledWith({
        prompt: {
          '10': {
            class_type: 'SeedVR2VideoUpscaler',
            inputs: {
              image: ['31', 0]
            }
          },
          '31': {
            class_type: 'LoadImage',
            inputs: {
              image: 'input.png'
            }
          }
        },
        client_id: 'renderer-qapp',
        extra_data: undefined
      })
    })
    it('requests ComfyUI memory cleanup when requested by the caller', async () => {
      const svc = new ComfySvcImpl()
      setObjectInfoMock(svc)

      const postPromptSpy = vi.spyOn(svc, 'postPrompt').mockResolvedValue({
        prompt_id: 'prompt-cleanup'
      })
      const workflow = {} as Workflow

      await svc.submitWorkflow({
        prompt: workflow,
        clientId: 'renderer-qapp',
        cleanupAfterRun: true
      })

      expect(postPromptSpy).toHaveBeenCalledWith({
        prompt: workflow,
        client_id: 'renderer-qapp',
        cleanupAfterRun: true,
        extra_data: undefined
      })
    })
  })

  describe('freeMemory', () => {
    it('proxies ComfyUI memory cleanup requests', async () => {
      const freeMemoryMock = vi.fn().mockResolvedValue(undefined)
      const svc = new ComfySvcImpl()
      ;(svc as unknown as { cli: () => { freeMemory: typeof freeMemoryMock } }).cli = () =>
        ({
          freeMemory: freeMemoryMock
        }) as never

      await expect(svc.freeMemory({ unload_models: true, free_memory: true })).resolves.toEqual({})
      expect(freeMemoryMock).toHaveBeenCalledWith({ unload_models: true, free_memory: true })
    })
  })

  describe('connectWs', () => {
    it('forwards all events for the shared wildcard stream', async () => {
      const svc = new ComfySvcImpl()
      const onData = vi.fn()

      const connectPromise = svc.connectWs({ client_id: COMFY_EVENT_CLIENT_ID_ALL }, {
        onData
      } as never)

      emitComfyEvent({
        type: 'progress',
        data: {
          prompt_id: 'external-prompt',
          value: 1,
          max: 4
        }
      })

      expect(onData).toHaveBeenCalledWith({
        type: 'progress',
        data: {
          prompt_id: 'external-prompt',
          value: 1,
          max: 4
        }
      })

      expect(listenComfyEventMock).toHaveBeenCalledTimes(1)
      listenComfyEventMock.mock.calls[0]?.[0]?.onEnd()
      await connectPromise
    })

    it('filters scoped streams down to the matching prompt owner and rewrites prompt ids', async () => {
      setTaskPromptOwner('prompt-1', {
        id: 'task-1',
        client_id: 'canvas:thread:canvas-1:thread:agent-2'
      })
      setTaskPromptOwner('prompt-2', {
        id: 'task-2',
        client_id: 'other-client'
      })

      const svc = new ComfySvcImpl()
      const onData = vi.fn()

      const connectPromise = svc.connectWs({ client_id: 'canvas:thread:canvas-1:thread:agent-2' }, {
        onData
      } as never)

      emitComfyEvent({
        type: 'progress',
        data: {
          prompt_id: 'prompt-1',
          value: 2,
          max: 5
        }
      })
      emitComfyEvent({
        type: 'progress',
        data: {
          prompt_id: 'prompt-2',
          value: 3,
          max: 5
        }
      })

      expect(onData).toHaveBeenCalledTimes(1)
      expect(onData).toHaveBeenCalledWith({
        type: 'progress',
        data: {
          prompt_id: 'task-1',
          value: 2,
          max: 5
        }
      })

      listenComfyEventMock.mock.calls[0]?.[0]?.onEnd()
      await connectPromise
    })
  })
})
