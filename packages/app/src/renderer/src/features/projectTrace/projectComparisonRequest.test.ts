import { describe, expect, it, vi } from 'vitest'
import type { LLMChatReq, LLMChatResp } from '@shared/api/svcLLMProxy'
import { requestProjectComparison } from './projectComparisonRequest'

const request: LLMChatReq = {
  profileId: 'exact-profile',
  messages: [{ role: 'user', content: 'Synthetic summary' }]
}
const pending = () => {
  let resolve!: (value: LLMChatResp) => void
  const promise = new Promise<LLMChatResp>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('project comparison IPC request cancellation', () => {
  it('sends one isolated conversation id and does not cancel after success', async () => {
    const chat = vi.fn(async () => ({ content: 'Advice' }))
    const cancelConversation = vi.fn(async () => ({ cancelled: true }))
    const controller = new AbortController()
    await expect(
      requestProjectComparison(request, controller.signal, { chat, cancelConversation })
    ).resolves.toEqual({ content: 'Advice' })
    expect(chat).toHaveBeenCalledExactlyOnceWith(
      {
        ...request,
        comparisonRouting: 'configured',
        conversationId: expect.stringMatching(/^project-comparison-/)
      },
      { signal: controller.signal }
    )
    controller.abort()
    expect(cancelConversation).not.toHaveBeenCalled()
  })

  it('cancels the exact main request even when unary IPC ignores AbortSignal', async () => {
    const deferred = pending()
    const chat = vi.fn(() => deferred.promise)
    const cancelConversation = vi.fn(async () => ({ cancelled: true }))
    const controller = new AbortController()
    const promise = requestProjectComparison(request, controller.signal, {
      chat,
      cancelConversation
    })
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    controller.abort()
    await rejected
    const sent = chat.mock.calls[0] as unknown as [LLMChatReq]
    expect(cancelConversation).toHaveBeenCalledExactlyOnceWith({
      conversationId: sent[0].conversationId
    })
    deferred.resolve({ content: 'Late' })
    await Promise.resolve()
    expect(chat).toHaveBeenCalledOnce()
  })

  it('blocks pre-cancelled work and contains cancellation errors without retries', async () => {
    const chat = vi.fn(() => new Promise<LLMChatResp>(() => undefined))
    const cancelConversation = vi.fn(async () => {
      throw new Error('private transport error')
    })
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(
      requestProjectComparison(request, cancelled.signal, { chat, cancelConversation })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(chat).not.toHaveBeenCalled()
    const controller = new AbortController()
    const result = requestProjectComparison(request, controller.signal, {
      chat,
      cancelConversation
    })
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(chat).toHaveBeenCalledOnce()
  })
})
