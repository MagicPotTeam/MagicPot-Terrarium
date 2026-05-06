import { describe, expect, it, vi } from 'vitest'
import { waitForQAppPromptResult } from './qAppPromptResult'

describe('waitForQAppPromptResult', () => {
  it('returns existing history without waiting again', async () => {
    const history = {
      'prompt-1': {
        outputs: {},
        prompt: [0, 'prompt-1', {}, { client_id: 'client-1' }, []],
        status: { status_str: 'success', completed: true, messages: [] }
      }
    }

    const getHistory = vi.fn().mockResolvedValue(history)
    const waitPromptId = vi.fn()

    await expect(waitForQAppPromptResult({ getHistory, waitPromptId }, 'prompt-1')).resolves.toBe(
      history['prompt-1']
    )
    expect(waitPromptId).not.toHaveBeenCalled()
  })

  it('falls back to waitPromptId when history is not ready yet', async () => {
    const result = {
      outputs: {},
      prompt: [0, 'prompt-1', {}, { client_id: 'client-1' }, []],
      status: { status_str: 'success', completed: true, messages: [] }
    }

    const getHistory = vi.fn().mockResolvedValue({})
    const waitPromptId = vi.fn().mockImplementation(async (_req, resp) => {
      resp.onData({ 'prompt-1': result })
    })

    await expect(waitForQAppPromptResult({ getHistory, waitPromptId }, 'prompt-1')).resolves.toBe(
      result
    )
    expect(waitPromptId).toHaveBeenCalledOnce()
  })
})
