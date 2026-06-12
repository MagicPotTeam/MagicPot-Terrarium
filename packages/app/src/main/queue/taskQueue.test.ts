import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComfyHistory, Workflow } from '@shared/comfy/types'
import { encodeDeferredComfyImageInputValue } from '@shared/comfy/deferredImages'

const { promptMock, uploadImageMock, waitPromptIdMock } = vi.hoisted(() => ({
  promptMock: vi.fn(async (_req: unknown) => ({ prompt_id: 'comfy-prompt-1' })),
  uploadImageMock: vi.fn(async (_fileItem: unknown, _image: unknown) => ({
    filename: 'uploaded-input.png',
    type: 'input'
  })),
  waitPromptIdMock: vi.fn(
    async (
      _cli: unknown,
      promptId: string,
      _timeout?: number,
      _poll?: number,
      _shouldCancel?: () => boolean
    ) => {
      return {
        prompt: [0, promptId, {} as Workflow, { client_id: 'transport-client' }, []],
        outputs: {},
        status: {
          status_str: 'success',
          completed: true,
          messages: []
        }
      } as ComfyHistory
    }
  )
}))

vi.mock('../comfy/http', () => ({
  COMFY_PROCESS_TRANSPORT_CLIENT_ID: 'magicpot-main-test',
  ComfyHttpCli: class MockComfyHttpCli {
    async prompt(req: unknown) {
      return promptMock(req)
    }

    async uploadImage(fileItem: unknown, image: unknown) {
      return uploadImageMock(fileItem, image)
    }

    async interrupt() {
      return undefined
    }

    async cancel() {
      return undefined
    }
  }
}))

vi.mock('../comfy/logic', () => ({
  waitPromptId: waitPromptIdMock
}))

describe('taskQueue transport client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('submits internal tasks through the shared transport client and keeps logical client metadata', async () => {
    vi.resetModules()
    const taskQueue = await import('./taskQueue')
    const logicalClientId = 'canvas:thread:canvas-1:thread:agent-2'
    const createdAt = 1710000000000
    const workflow = {} as Workflow

    const taskId = taskQueue.addTask({
      id: '',
      type: 'comfy_prompt',
      client_id: logicalClientId,
      created_at: createdAt,
      prompt_id: null,
      payload: workflow,
      result: null
    })

    try {
      await taskQueue.initTaskQueue()
      await vi.advanceTimersByTimeAsync(1000)

      expect(promptMock).toHaveBeenCalledWith({
        prompt: workflow,
        client_id: 'magicpot-main-test',
        extra_data: undefined
      })

      const [status, task] = taskQueue.getTask(taskId)
      expect(status).toBe('completed')
      expect(task?.result?.prompt[3]).toEqual(
        expect.objectContaining({
          client_id: logicalClientId,
          created_at: createdAt
        })
      )
    } finally {
      await taskQueue.stopTaskQueue()
    }
  })

  it('uploads deferred Comfy image inputs before submitting the prompt', async () => {
    vi.resetModules()
    const taskQueue = await import('./taskQueue')
    const deferredImageValue = encodeDeferredComfyImageInputValue({
      fileName: 'folder-photo.png',
      mimeType: 'image/png',
      sizeBytes: 2,
      dataUrl: 'data:image/png;base64,SGk='
    })
    const workflow: Workflow = {
      '1': {
        class_type: 'LoadImage',
        inputs: {
          image: deferredImageValue,
          mask: deferredImageValue
        }
      }
    }

    const taskId = taskQueue.addTask({
      id: '',
      type: 'comfy_prompt',
      client_id: 'logical-client',
      created_at: 1710000000000,
      prompt_id: null,
      payload: workflow,
      result: null
    })

    try {
      await taskQueue.initTaskQueue()
      await vi.advanceTimersByTimeAsync(1000)

      expect(uploadImageMock).toHaveBeenCalledTimes(1)
      expect(uploadImageMock.mock.calls[0][0]).toEqual({
        filename: 'folder-photo.png',
        type: 'input'
      })
      expect(Array.from(uploadImageMock.mock.calls[0][1] as Uint8Array)).toEqual([72, 105])
      expect(promptMock).toHaveBeenCalledWith({
        prompt: {
          '1': {
            class_type: 'LoadImage',
            inputs: {
              image: 'uploaded-input.png',
              mask: 'uploaded-input.png'
            }
          }
        },
        client_id: 'magicpot-main-test',
        extra_data: undefined
      })

      const [status, task] = taskQueue.getTask(taskId)
      expect(status).toBe('completed')
      expect(task?.payload['1'].inputs.image).toBe('uploaded-input.png')
      expect(task?.result?.prompt[2]['1'].inputs.image).toBe(deferredImageValue)
    } finally {
      await taskQueue.stopTaskQueue()
    }
  })

  it('marks tasks as cancelled when they are removed before execution completes', async () => {
    vi.resetModules()
    const taskQueue = await import('./taskQueue')
    const logicalClientId = 'canvas:thread:canvas-1:thread:agent-2'
    const workflow = {} as Workflow

    waitPromptIdMock.mockImplementationOnce(
      async (
        _cli: unknown,
        _promptId: string,
        _a: unknown,
        _b: unknown,
        shouldCancel?: () => boolean
      ) =>
        await new Promise((resolve) => {
          const check = () => {
            if (shouldCancel?.()) {
              resolve({
                prompt: [
                  0,
                  'comfy-prompt-1',
                  {} as Workflow,
                  { client_id: 'transport-client' },
                  []
                ],
                outputs: {},
                status: {
                  status_str: 'success',
                  completed: true,
                  messages: []
                }
              } as ComfyHistory)
              return
            }
            setTimeout(check, 0)
          }
          check()
        })
    )

    const taskId = taskQueue.addTask({
      id: '',
      type: 'comfy_prompt',
      client_id: logicalClientId,
      created_at: Date.now(),
      prompt_id: null,
      payload: workflow,
      result: null
    })

    try {
      await taskQueue.initTaskQueue()
      await vi.advanceTimersByTimeAsync(1000)

      const cancelled = await taskQueue.cancelTask(taskId)
      expect(cancelled).toBe(true)

      await vi.advanceTimersByTimeAsync(10)

      const [status] = taskQueue.getTask(taskId)
      expect(status).toBe('cancelled')
    } finally {
      await taskQueue.stopTaskQueue()
    }
  })
})
