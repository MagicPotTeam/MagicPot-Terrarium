import { describe, expect, it, vi } from 'vitest'
import type { ComfyHistoryResp } from '@shared/comfy/types'
import { waitPromptId, type ComfyCliWrapper } from './logic'

vi.mock('@shared/utils/utilFuncs', () => ({
  sleep: vi.fn(async () => undefined)
}))

describe('waitPromptId', () => {
  it('keeps polling without a fixed default timeout until the prompt history is ready', async () => {
    let calls = 0
    const cli: ComfyCliWrapper = {
      history: vi.fn(async (promptId: string) => {
        calls += 1
        if (calls < 3) {
          return {}
        }

        return {
          [promptId]: {
            prompt: [0, promptId, {}, { client_id: '' }, []],
            outputs: { node: {} },
            status: {
              status_str: 'success',
              completed: true,
              messages: []
            }
          }
        } satisfies ComfyHistoryResp
      }),
      view: vi.fn()
    }

    await expect(waitPromptId(cli, 'prompt-1')).resolves.toMatchObject({
      outputs: { node: {} },
      status: { completed: true }
    })
    expect(cli.history).toHaveBeenCalledTimes(3)
  })

  it('still supports an explicit timeout for callers that need one', async () => {
    vi.useFakeTimers()
    try {
      let now = 0
      vi.spyOn(Date, 'now').mockImplementation(() => {
        now += 10
        return now
      })

      const cli: ComfyCliWrapper = {
        history: vi.fn(async () => ({})),
        view: vi.fn()
      }

      await expect(waitPromptId(cli, 'prompt-timeout', 15, 1)).resolves.toMatchObject({
        status: {
          status_str: 'error',
          messages: [
            [
              'execution_error',
              expect.objectContaining({
                exception_type: 'TimeoutError',
                exception_message: 'waitPromptId timeout after 15ms'
              })
            ]
          ]
        }
      })
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })
})
