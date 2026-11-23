import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LLMCli, LLMChatParams } from '@shared/llm'
import {
  CODEX_REQUEST_GOVERNOR_ERROR_CODES,
  __resetCodexRequestGovernorForTests,
  createCLIProxyGovernorIdentity,
  createCodexOAuthGovernorIdentity,
  createGuardedCodexCli,
  createCodexChatFingerprintPayload,
  normalizeCodexGovernorEndpoint,
  runWithCodexRequestGovernor
} from './codexRequestGovernor'

const run = (id: string, task: () => Promise<string>, identity = 'identity-a') =>
  runWithCodexRequestGovernor(
    {
      identity,
      endpoint: 'https://upstream.test/v1',
      fingerprint: { prompt: id }
    },
    task
  )

const expectDuplicate = async (promise: Promise<unknown>): Promise<void> => {
  await expect(promise).rejects.toMatchObject({
    name: 'CodexRequestGovernorError',
    code: CODEX_REQUEST_GOVERNOR_ERROR_CODES.DUPLICATE
  })
}

describe('Codex request governor', () => {
  afterEach(() => {
    vi.useRealTimers()
    __resetCodexRequestGovernorForTests()
  })

  it('fingerprints MAIN image routing without making false a new duplicate identity', () => {
    const request = { messages: [{ role: 'user' as const, content: 'Generate an image.' }] }
    const original = createCodexChatFingerprintPayload(request, 'text-model')
    expect(
      createCodexChatFingerprintPayload(
        { ...request, disableAutomaticImageGeneration: false },
        'text-model'
      )
    ).toEqual(original)
    expect(
      createCodexChatFingerprintPayload(
        { ...request, disableAutomaticImageGeneration: true },
        'text-model'
      )
    ).not.toEqual(original)
  })

  it('does not limit concurrent distinct requests', async () => {
    const started: string[] = []
    const tasks = Array.from({ length: 20 }, (_, index) =>
      run(`request-${index}`, async () => {
        started.push(String(index))
        return String(index)
      })
    )

    await expect(Promise.all(tasks)).resolves.toEqual(
      Array.from({ length: 20 }, (_, i) => String(i))
    )
    expect(started).toHaveLength(20)
  })

  it('rejects the fourth identical submission without sharing work', async () => {
    __resetCodexRequestGovernorForTests({
      duplicateMaxAccepted: 3,
      duplicateWindowMs: 30_000
    })
    let taskCalls = 0

    await expect(
      Promise.all(
        Array.from({ length: 3 }, () =>
          run('same prompt', async () => {
            taskCalls += 1
            return 'ok'
          })
        )
      )
    ).resolves.toEqual(['ok', 'ok', 'ok'])
    await expectDuplicate(
      run('same prompt', async () => {
        taskCalls += 1
        return 'blocked'
      })
    )
    expect(taskCalls).toBe(3)
  })

  it('expires duplicate counters after the configured window', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    __resetCodexRequestGovernorForTests({
      duplicateMaxAccepted: 1,
      duplicateWindowMs: 100
    })

    await expect(run('same', async () => 'first')).resolves.toBe('first')
    await expectDuplicate(run('same', async () => 'blocked'))

    await vi.advanceTimersByTimeAsync(101)
    await expect(run('same', async () => 'later')).resolves.toBe('later')
  })

  it('scopes duplicate detection by identity and normalized endpoint', async () => {
    __resetCodexRequestGovernorForTests({ duplicateMaxAccepted: 1 })

    await expect(run('same', async () => 'a', 'identity-a')).resolves.toBe('a')
    await expect(run('same', async () => 'b', 'identity-b')).resolves.toBe('b')
    await expect(
      runWithCodexRequestGovernor(
        {
          identity: 'identity-a',
          endpoint: 'https://other.test/v1',
          fingerprint: { prompt: 'same' }
        },
        async () => 'other'
      )
    ).resolves.toBe('other')
  })

  it('normalizes endpoint credentials away and creates opaque credential identities', () => {
    expect(
      normalizeCodexGovernorEndpoint('https://user:password@example.test/v1/?token=secret#fragment')
    ).toBe('https://example.test/v1')

    for (const [identity, secret] of [
      [createCLIProxyGovernorIdentity('api-key-secret'), 'api-key-secret'],
      [createCodexOAuthGovernorIdentity('account-secret'), 'account-secret']
    ]) {
      expect(identity).toMatch(/^[^:]+:[a-f0-9]{64}$/)
      expect(identity).not.toContain(secret)
    }
    expect(createCodexOAuthGovernorIdentity()).toBe('oauth:unknown')
  })

  it('does not let conversation metadata bypass duplicate protection', async () => {
    __resetCodexRequestGovernorForTests({ duplicateMaxAccepted: 1 })
    const delegate: LLMCli = { chat: vi.fn(async () => ({ content: 'ok' })) }
    const guarded = createGuardedCodexCli(delegate, {
      identity: 'identity',
      endpoint: 'https://upstream.test/v1',
      modelName: 'gpt-5'
    })
    const request = { messages: [{ role: 'user' as const, content: 'same' }] }

    await expect(
      guarded.chat({
        ...request,
        conversationId: 'conversation-a',
        sessionUrl: 'https://a.test'
      })
    ).resolves.toEqual({ content: 'ok' })
    await expectDuplicate(
      guarded.chat({
        ...request,
        conversationId: 'conversation-b',
        sessionUrl: 'https://b.test'
      })
    )
    expect(delegate.chat).toHaveBeenCalledTimes(1)
  })

  it('canonicalizes equivalent prompt and reasoning wire values', async () => {
    __resetCodexRequestGovernorForTests({ duplicateMaxAccepted: 1 })
    const delegate: LLMCli = { chat: vi.fn(async () => ({ content: 'ok' })) }
    const guarded = createGuardedCodexCli(delegate, {
      identity: 'identity',
      endpoint: 'https://upstream.test/v1',
      modelName: 'gpt-5'
    })
    const messages = [{ role: 'user' as const, content: 'same' }]

    await expect(
      guarded.chat({
        messages,
        systemPrompt: ' prompt ',
        // Legacy request value, no longer part of selectable reasoning levels.
        reasoningEffort: 'ultra' as LLMChatParams['reasoningEffort']
      })
    ).resolves.toEqual({ content: 'ok' })
    await expectDuplicate(
      guarded.chat({
        messages,
        systemPrompt: 'prompt',
        reasoningEffort: 'max'
      })
    )
  })

  it('distinguishes latest and all image history policies in normalized fingerprints', async () => {
    __resetCodexRequestGovernorForTests({ duplicateMaxAccepted: 1 })
    const delegate: LLMCli = { chat: vi.fn(async () => ({ content: 'ok' })) }
    const guarded = createGuardedCodexCli(delegate, {
      identity: 'identity',
      endpoint: 'https://upstream.test/v1'
    })
    const messages: LLMChatParams['messages'] = [{ role: 'user', content: 'inspect' }]

    await expect(guarded.chat({ messages })).resolves.toEqual({
      content: 'ok'
    })
    await expect(guarded.chat({ messages, imageHistoryPolicy: 'all' })).resolves.toEqual({
      content: 'ok'
    })
    await expectDuplicate(guarded.chat({ messages, imageHistoryPolicy: 'latest-user-turn' }))
  })

  it('fingerprints inline image bytes without retaining or collapsing their base64', async () => {
    __resetCodexRequestGovernorForTests({ duplicateMaxAccepted: 1 })
    const delegate: LLMCli = { chat: vi.fn(async () => ({ content: 'ok' })) }
    const guarded = createGuardedCodexCli(delegate, {
      identity: 'identity',
      endpoint: 'https://upstream.test/v1'
    })
    const request = (url: string): LLMChatParams => ({
      messages: [
        {
          role: 'user',
          content: 'inspect',
          attachments: [{ type: 'image', url }]
        }
      ]
    })

    await expect(guarded.chat(request('data:image/png;base64,YQ=='))).resolves.toEqual({
      content: 'ok'
    })
    await expect(guarded.chat(request('data:image/jpeg;base64,Yg=='))).resolves.toEqual({
      content: 'ok'
    })
    await expectDuplicate(guarded.chat(request('data:image/jpeg;base64,YQ==')))
    expect(delegate.chat).toHaveBeenCalledTimes(2)
  })

  it('treats logically identical percent-encoded and base64 data payloads as identical', async () => {
    __resetCodexRequestGovernorForTests({ duplicateMaxAccepted: 1 })
    const delegate: LLMCli = { chat: vi.fn(async () => ({ content: 'ok' })) }
    const guarded = createGuardedCodexCli(delegate, {
      identity: 'identity',
      endpoint: 'https://upstream.test/v1'
    })
    const request = (url: string): LLMChatParams => ({
      messages: [
        {
          role: 'user',
          content: 'inspect',
          attachments: [{ type: 'image', url }]
        }
      ]
    })

    await expect(guarded.chat(request('data:image/png,hello%20world'))).resolves.toEqual({
      content: 'ok'
    })
    await expectDuplicate(guarded.chat(request('data:image/webp;base64,aGVsbG8gd29ybGQ=')))
  })

  it('treats an omitted system prompt like the upstream default', async () => {
    __resetCodexRequestGovernorForTests({ duplicateMaxAccepted: 1 })
    const delegate: LLMCli = { chat: vi.fn(async () => ({ content: 'ok' })) }
    const guarded = createGuardedCodexCli(delegate, {
      identity: 'identity',
      endpoint: 'https://upstream.test/v1',
      modelName: 'gpt-5'
    })
    const params: LLMChatParams = {
      messages: [{ role: 'user', content: 'same' }]
    }

    await expect(guarded.chat(params)).resolves.toEqual({ content: 'ok' })
    await expectDuplicate(guarded.chat({ ...params, systemPrompt: 'You are a helpful assistant.' }))
  })
})

describe('native tool governor identity', () => {
  it('includes schemas and results so successive model steps are not duplicate submissions', () => {
    const base: LLMChatParams = {
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [{ name: 'files.read', description: 'read', inputSchema: { type: 'object' } }]
    }
    const next: LLMChatParams = {
      ...base,
      toolTurns: [
        {
          content: '',
          calls: [{ id: 'call1', name: 'files.read', wireName: 'mp_tool_0', arguments: '{}' }],
          results: [{ callId: 'call1', output: 'real result' }]
        }
      ]
    }
    expect(createCodexChatFingerprintPayload(base, 'owned')).not.toEqual(
      createCodexChatFingerprintPayload(next, 'owned')
    )
    const delegate: LLMCli = { supportsNativeTools: true, chat: vi.fn() }
    expect(
      createGuardedCodexCli(delegate, { identity: 'owned', endpoint: 'https://owned.test' })
        .supportsNativeTools
    ).toBe(true)
  })
})
