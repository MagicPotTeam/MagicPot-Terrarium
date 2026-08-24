import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '@shared/comfy/types'
import { encodeDeferredComfyFileInputValue } from '@shared/comfy/deferredImages'
import { fileItemToValue } from '@shared/comfy/funcs'
import { COMFY_EVENT_CLIENT_ID_ALL } from '@shared/api/svcComfy'
import { ComfyHttpCli } from '../comfy/http'
import { closeComfyOutputRouteStore, getComfyOutputRouteStore } from '../comfy/outputRouteStore'

const {
  addTaskMock,
  cancelTaskMock,
  cancelTaskByPromptIdMock,
  getQueueMock,
  getTaskMock,
  getTaskByPromptIdMock,
  listenComfyEventMock,
  importManagedMediaStreamMock,
  instanceRegistryGetMock,
  getComfyInstanceClientMock,
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
    getQueueMock: vi.fn(() => ({
      running: [],
      pending: [],
      completed: [],
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
    instanceRegistryGetMock: vi.fn(),
    getComfyInstanceClientMock: vi.fn(),
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

vi.mock('../comfy/instancePool', () => ({
  getComfyInstanceRegistry: vi.fn(() => ({ get: instanceRegistryGetMock })),
  getComfyInstanceClient: getComfyInstanceClientMock
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
  getTaskByPromptId: getTaskByPromptIdMock,
  resolveTaskSubmission: vi.fn()
}))

vi.mock('../comfy/state', () => ({
  listenComfyEvent: listenComfyEventMock
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

import { ComfySvcImpl } from './svcComfyImpl'

describe('ComfySvcImpl', () => {
  beforeEach(() => {
    closeComfyOutputRouteStore()
    vi.clearAllMocks()
    resetComfyTestState()
  })

  afterEach(() => {
    closeComfyOutputRouteStore()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('registered instance routing', () => {
    it('rejects endpoint metadata without an instance id', async () => {
      const svc = new ComfySvcImpl()

      await expect(
        svc.getView({
          filename: 'result.png',
          subfolder: '',
          type: 'output',
          instanceOrigin: 'http://127.0.0.1:8188/',
          instanceKind: 'local'
        })
      ).rejects.toThrow('metadata requires an opaque route id')
      expect(getComfyInstanceClientMock).not.toHaveBeenCalled()
    })

    it('uses a captured opaque route after the registry entry is edited, disabled, or deleted', async () => {
      const route = getComfyOutputRouteStore().capture({
        id: 'gpu-route',
        origin: 'https://captured.example/',
        kind: 'remote'
      })
      instanceRegistryGetMock.mockReturnValue({
        deleted: true,
        state: {
          id: 'gpu-route',
          origin: 'https://replacement.example/',
          kind: 'remote',
          enabled: false
        }
      })
      const view = vi.spyOn(ComfyHttpCli.prototype, 'view').mockImplementation(async function (
        this: ComfyHttpCli
      ) {
        expect((this as unknown as { configuredOrigin?: string }).configuredOrigin).toBe(
          'https://captured.example/'
        )
        return new Uint8Array([1, 2, 3])
      })
      const svc = new ComfySvcImpl()

      await expect(
        svc.getView({
          filename: 'result.png',
          subfolder: '',
          type: 'output',
          instanceId: 'gpu-route',
          instanceRouteId: route.routeId
        })
      ).resolves.toEqual({ result: new Uint8Array([1, 2, 3]) })
      expect(view).toHaveBeenCalledTimes(1)
      expect(instanceRegistryGetMock).not.toHaveBeenCalled()
      expect(getComfyInstanceClientMock).not.toHaveBeenCalled()
    })

    it('uses the captured endpoint for imports after the registry identity changes', async () => {
      const route = getComfyOutputRouteStore().capture({
        id: 'gpu-import',
        origin: 'https://captured-import.example/',
        kind: 'remote'
      })
      instanceRegistryGetMock.mockReturnValue({
        deleted: false,
        state: {
          id: 'gpu-import',
          origin: 'https://replacement.example/',
          kind: 'local',
          enabled: false
        }
      })
      const viewResponse = vi
        .spyOn(ComfyHttpCli.prototype, 'viewResponse')
        .mockImplementation(async function (this: ComfyHttpCli) {
          expect((this as unknown as { configuredOrigin?: string }).configuredOrigin).toBe(
            'https://captured-import.example/'
          )
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'content-type': 'image/png' }
          })
        })
      const reference = {
        version: 1,
        kind: 'managed',
        relativePath: 'ab/hash.png',
        sha256: 'a'.repeat(64),
        sizeBytes: 3,
        mimeType: 'image/png',
        originalFileName: 'result.png'
      }
      importManagedMediaStreamMock.mockResolvedValue({
        reference,
        localMediaUrl: 'local-media:/managed'
      })
      const svc = new ComfySvcImpl()

      await expect(
        svc.importOutputImage({
          filename: 'result.png',
          subfolder: '',
          type: 'output',
          instanceId: 'gpu-import',
          instanceRouteId: route.routeId
        })
      ).resolves.toMatchObject({ reference, localMediaUrl: 'local-media:/managed' })
      expect(viewResponse).toHaveBeenCalledTimes(1)
      expect(instanceRegistryGetMock).not.toHaveBeenCalled()
    })

    it.each([
      {
        name: 'unknown handle',
        route: { instanceRouteId: 'route-forged' },
        expected: 'route is unavailable'
      },
      {
        name: 'empty handle',
        route: { instanceRouteId: '' },
        expected: 'route id is invalid'
      },
      {
        name: 'forged instance id',
        route: { instanceId: 'other-instance' },
        expected: 'does not match its instance id'
      },
      {
        name: 'forged origin',
        route: { instanceOrigin: 'https://forged.example/' },
        expected: 'does not match its captured origin'
      },
      {
        name: 'forged kind',
        route: { instanceKind: 'local' as const },
        expected: 'does not match its captured kind'
      }
    ])('fails closed for $name before view or import fetches', async ({ route, expected }) => {
      const captured = getComfyOutputRouteStore().capture({
        id: 'gpu-closed',
        origin: 'https://captured-closed.example/',
        kind: 'remote'
      })
      const view = vi.spyOn(ComfyHttpCli.prototype, 'view')
      const viewResponse = vi.spyOn(ComfyHttpCli.prototype, 'viewResponse')
      const descriptor = {
        filename: 'result.png',
        subfolder: '',
        type: 'output' as const,
        instanceRouteId: captured.routeId,
        ...route
      }
      const svc = new ComfySvcImpl()

      await expect(svc.getView(descriptor)).rejects.toThrow(expected)
      await expect(svc.importOutputImage(descriptor)).rejects.toThrow(expected)
      expect(view).not.toHaveBeenCalled()
      expect(viewResponse).not.toHaveBeenCalled()
      expect(importManagedMediaStreamMock).not.toHaveBeenCalled()
    })

    it('rejects view and import access through a disabled legacy instance route', async () => {
      instanceRegistryGetMock.mockReturnValue({
        deleted: false,
        state: {
          id: 'disabled-gpu',
          enabled: false
        }
      })
      const svc = new ComfySvcImpl()

      await expect(
        svc.getView({
          filename: 'result.png',
          subfolder: '',
          type: 'output',
          instanceId: 'disabled-gpu'
        })
      ).rejects.toThrow('instance is unavailable')
      await expect(
        svc.importOutputImage({
          filename: 'result.png',
          subfolder: '',
          type: 'output',
          instanceId: 'disabled-gpu'
        })
      ).rejects.toThrow('instance is unavailable')
      expect(getComfyInstanceClientMock).not.toHaveBeenCalled()
    })
  })

  describe('importOutputImage', () => {
    it('validates the descriptor and imports the Comfy response stream', async () => {
      const svc = new ComfySvcImpl()
      const viewResponse = vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png; charset=binary' }
        })
      )
      ;(svc as unknown as { cli: () => { viewResponse: typeof viewResponse } }).cli = () => ({
        viewResponse
      })
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
      ;(svc as unknown as { cli: () => { viewResponse: typeof viewResponse } }).cli = () => ({
        viewResponse
      })
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
        ;(svc as unknown as { cli: () => { viewResponse: typeof viewResponse } }).cli = () => ({
          viewResponse
        })
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
      ;(svc as unknown as { cli: () => { viewResponse: typeof viewResponse } }).cli = () => ({
        viewResponse
      })

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
      ;(svc as unknown as { cli: () => { viewResponse: typeof viewResponse } }).cli = () => ({
        viewResponse
      })
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
      ;(svc as unknown as { cli: () => { viewResponse: typeof viewResponse } }).cli = () => ({
        viewResponse
      })
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
      ;(svc as unknown as { cli: () => { viewResponse: typeof viewResponse } }).cli = () => ({
        viewResponse
      })
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
      ;(svc as unknown as { cli: () => { viewResponse: typeof viewResponse } }).cli = () => ({
        viewResponse
      })
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

  describe('submitWorkflow', () => {
    it('falls back to the shared session key when no explicit client id is provided', async () => {
      const svc = new ComfySvcImpl()
      ;(
        svc as unknown as { cli: () => { objectInfo: () => Promise<Record<string, unknown>> } }
      ).cli = () =>
        ({
          objectInfo: vi.fn().mockResolvedValue({})
        }) as never

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
      ;(
        svc as unknown as { cli: () => { objectInfo: () => Promise<Record<string, unknown>> } }
      ).cli = () =>
        ({
          objectInfo: vi.fn().mockResolvedValue({})
        }) as never

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
      ;(
        svc as unknown as { cli: () => { objectInfo: () => Promise<Record<string, unknown>> } }
      ).cli = () =>
        ({
          objectInfo: vi.fn().mockResolvedValue({})
        }) as never

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

    it('preserves deferred, routed, malformed-reserved, and history values in the durable task payload', async () => {
      const svc = new ComfySvcImpl()
      ;(
        svc as unknown as { cli: () => { objectInfo: () => Promise<Record<string, unknown>> } }
      ).cli = () =>
        ({
          objectInfo: vi.fn().mockResolvedValue({})
        }) as never

      const postPromptSpy = vi.spyOn(svc, 'postPrompt').mockResolvedValue({
        prompt_id: 'prompt-4'
      })

      const deferredValue = encodeDeferredComfyFileInputValue({
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 10,
        filePath: 'C:/cache/clip.mp4'
      })
      const routedValue = fileItemToValue({
        filename: 'result.png',
        type: 'output',
        instanceId: 'gpu-a',
        instanceRouteId: 'route-a',
        instanceOrigin: 'https://gpu.example/',
        instanceKind: 'remote'
      })
      const malformedReservedValue = 'MAGICPOT_DEFERRED_COMFY_FILE:%not-json'
      const prompt = {
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
            image: routedValue,
            original: deferredValue,
            malformed: malformedReservedValue
          }
        }
      } satisfies Workflow

      await svc.submitWorkflow({ prompt, clientId: 'renderer-qapp' })

      expect(postPromptSpy).toHaveBeenCalledWith({
        prompt,
        client_id: 'renderer-qapp',
        extra_data: undefined
      })
      expect(postPromptSpy.mock.calls[0][0].prompt).toBe(prompt)
      expect(postPromptSpy.mock.calls[0][0].prompt['31'].inputs).toEqual({
        image: routedValue,
        original: deferredValue,
        malformed: malformedReservedValue
      })
    })
    it('passes the original workflow unchanged into addTask before lease-time materialization', async () => {
      const deferredValue = encodeDeferredComfyFileInputValue({
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 10,
        filePath: 'C:/cache/clip.mp4'
      })
      const malformedReservedValue = 'MAGICPOT_DEFERRED_COMFY_FILE:%not-json'
      const prompt = {
        '1': {
          class_type: 'LoadVideo',
          inputs: {
            video: deferredValue,
            original: deferredValue,
            malformed: malformedReservedValue
          }
        },
        '2': {
          class_type: 'Note',
          inputs: { value: 'history metadata remains durable' }
        }
      } satisfies Workflow
      const svc = new ComfySvcImpl()

      await expect(
        svc.submitWorkflow({ prompt, clientId: 'renderer-qapp', extra_data: { source: 'test' } })
      ).resolves.toEqual({ prompt_id: 'task-queued' })

      expect(addTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'comfy_prompt',
          client_id: 'renderer-qapp',
          payload: prompt,
          extra_data: { source: 'test' }
        })
      )
      const calls = addTaskMock.mock.calls as unknown as Array<[{ payload: Workflow }]>
      const task = calls.at(-1)?.[0]
      expect(task).toBeDefined()
      expect(task?.payload).toBe(prompt)
      expect(task?.payload['1'].inputs).toEqual({
        video: deferredValue,
        original: deferredValue,
        malformed: malformedReservedValue
      })
      expect(task?.payload['2']).toEqual({
        class_type: 'Note',
        inputs: { value: 'history metadata remains durable' }
      })
    })

    it('requests ComfyUI memory cleanup when requested by the caller', async () => {
      const svc = new ComfySvcImpl()
      ;(
        svc as unknown as { cli: () => { objectInfo: () => Promise<Record<string, unknown>> } }
      ).cli = () =>
        ({
          objectInfo: vi.fn().mockResolvedValue({})
        }) as never

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
