import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { resolveAttachmentBatchCapability } from './chatRequestUtils'

const config: Config = {
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [] }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('capability probe lifetime', () => {
  it('bounds an unresponsive probe and cancels its main-process conversation', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    const chat = vi.fn((_request: unknown) => new Promise<never>(() => undefined))
    const cancelConversation = vi.fn().mockResolvedValue({ cancelled: true })
    window.api = {
      svcManagedMedia: {},
      svcLLMProxy: { chat, cancelConversation }
    } as unknown as Window['api']

    const pending = resolveAttachmentBatchCapability({
      config,
      profileId: 'capability-probe-timeout-fixture'
    })
    await vi.advanceTimersByTimeAsync(60_000)

    await expect(pending).resolves.toBe(1)
    expect(chat).toHaveBeenCalledOnce()
    const conversationId = (chat.mock.calls[0][0] as { conversationId?: string }).conversationId
    expect(conversationId).toMatch(/^capability-probe:attachment-batch:/)
    expect(cancelConversation).toHaveBeenCalledExactlyOnceWith({
      conversationId,
      cancellationId: (chat.mock.calls[0][0] as { cancellationId: string }).cancellationId
    })
    console.log(
      'timers',
      setTimeoutSpy.mock.calls.map(([, delay]) => delay),
      clearTimeoutSpy.mock.calls.length,
      vi.getTimerCount()
    )
  })
})
