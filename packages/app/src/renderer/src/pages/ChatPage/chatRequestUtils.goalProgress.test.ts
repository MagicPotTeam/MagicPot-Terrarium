import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'
const input = () => ({ config: { ...DEFAULT_CONFIG, use_remote_llm: false }, profileId: 'profile', goalProgressToken: 'main-owned-goal-once', conversationId: 'goal-chat', route: { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' }, messages: [{ role: 'user' as const, content: 'Ordinary explicit user message' }] })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe.each([false, true])('one-request goal token transport (stream=%s)', streaming => {
  it('passes only the explicit opaque token through local IPC without introducing probes or extra calls', async () => {
    const chat = vi.fn(async () => ({ content: 'answer' })), chatStream = vi.fn(async (_req, resp: { onData(value: LLMChatStreamResp): void }) => { resp.onData({ type: 'done', done: true, delta: '', content: 'answer', fullContent: 'answer' }) })
    const remoteFetch = vi.fn(), externalAgentStream = vi.fn()
    vi.stubGlobal('api', { svcLLMProxy: { chat, chatStream, remoteFetch, externalAgentStream, cancelConversation: vi.fn() } })
    const result = streaming ? (await requestChatCompletionStream({ ...input(), onEvent: vi.fn() })).result : await requestChatCompletion(input())
    expect(result.content).toBe('answer')
    expect(streaming ? chatStream : chat).toHaveBeenCalledOnce()
    expect((streaming ? chatStream : chat).mock.calls[0][0]).toMatchObject({ goalProgressToken: 'main-owned-goal-once', conversationId: 'goal-chat' })
    expect(streaming ? chat : chatStream).not.toHaveBeenCalled(); expect(remoteFetch).not.toHaveBeenCalled(); expect(externalAgentStream).not.toHaveBeenCalled()
  })
  it.each(['remote', 'external', 'skill', 'attachment', 'hidden', 'continuation', 'edit', 'media'] as const)('rejects %s before preparation/probes/any network or provider fallback', async kind => {
    const chat = vi.fn(), chatStream = vi.fn(), remoteFetch = vi.fn(), externalAgentStream = vi.fn()
    vi.stubGlobal('api', { svcLLMProxy: { chat, chatStream, remoteFetch, externalAgentStream, cancelConversation: vi.fn() } })
    const extra = kind === 'remote' ? { config: { ...DEFAULT_CONFIG, use_remote_llm: true } } : kind === 'external' ? { externalAgentSkill: { id: 'external', type: 'agent', apiAddress: 'https://forbidden.test' } } : kind === 'skill' ? { skillRuntime: {} } : kind === 'attachment' ? { messages: [{ role: 'user', content: 'x', attachments: [{ type: 'file', url: 'file://forbidden', reportBundleRole: 'primary-report' }] }] } : kind === 'hidden' ? { messages: [{ role: 'user', content: 'x', hiddenContext: 'secret' }] } : kind === 'continuation' ? { sessionUrl: 'prior' } : kind === 'edit' ? { isEdit: true } : { imageGenerationOptions: { enabled: true } }
    const req = { ...input(), ...extra } as Parameters<typeof requestChatCompletion>[0]
    await expect(streaming ? requestChatCompletionStream({ ...req, onEvent: vi.fn() }) : requestChatCompletion(req)).rejects.toThrow('Goal progress')
    for (const fn of [chat, chatStream, remoteFetch, externalAgentStream]) expect(fn).not.toHaveBeenCalled()
  })
})
