import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '@shared/comfy/types'
import { COMFY_EVENT_CLIENT_ID_ALL } from '@shared/api/svcComfy'

const {
  addTaskMock,
  cancelTaskMock,
  cancelTaskByPromptIdMock,
  getQueueMock,
  getTaskMock,
  getTaskByPromptIdMock,
  listenComfyEventMock,
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

import { ComfySvcImpl } from './svcComfyImpl'

describe('ComfySvcImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetComfyTestState()
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

    it('strips UI-only nodes before posting the prompt to ComfyUI', async () => {
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
