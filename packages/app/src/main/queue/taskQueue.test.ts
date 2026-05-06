import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComfyHistory, Workflow } from '@shared/comfy/types'

const { promptMock, waitPromptIdMock } = vi.hoisted(() => ({
  promptMock: vi.fn(async (_req: unknown) => ({ prompt_id: 'comfy-prompt-1' })),
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
