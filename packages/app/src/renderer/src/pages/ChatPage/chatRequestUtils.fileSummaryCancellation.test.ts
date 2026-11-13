import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'
import { augmentMessageContentWithFileAttachments } from './chatAttachmentPromptUtils'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each([false, true])('file summary cancellation (stream=%s)', (stream) => {
  it.each(
    (['plain-file', 'report'] as const).flatMap((kind) =>
      (['fetch', 'text'] as const).flatMap((phase) =>
        (['string', 'dom-exception'] as const).map((reason) => [kind, phase, reason] as const)
      )
    )
  )(
    'stops while reading the first %s at %s with %s cancellation and never reads the next',
    async (kind, phase, reasonType) => {
      const fetchGate = deferred<Response>()
      const textGate = deferred<string>()
      let cleaning = false
      const text = vi.fn(() => textGate.promise)
      const response = { ok: true, text } as unknown as Response
      const fetchMock = vi.fn((_url: string, _options?: RequestInit): Promise<Response> => {
        if (cleaning)
          return Promise.resolve({ ok: true, text: async () => 'fixture cleanup' } as Response)
        return phase === 'fetch' ? fetchGate.promise : Promise.resolve(response)
      })
      vi.stubGlobal('fetch', fetchMock)
      const chat = vi.fn()
      const chatStream = vi.fn()
      const cancelConversation = vi.fn()
      vi.stubGlobal('api', {
        svcManagedMedia: {},
        svcLLMProxy: { chat, chatStream, cancelConversation }
      })
      const controller = new AbortController()
      const request = {
        config: {
          ...DEFAULT_CONFIG,
          use_remote_llm: false,
          llm_config: {
            ...DEFAULT_CONFIG.llm_config,
            api_profiles: [
              {
                id: 'summary-fixture',
                provider: 'openai' as const,
                deployment: 'cloud' as const,
                model_use: 'chat' as const,
                model_name: 'fixture',
                base_url: 'https://fixture.invalid/v1',
                api_key: 'fixture',
                api_mode: 'chat-completions' as const,
                attachment_transports: ['request-data-url' as const]
              }
            ]
          }
        },
        profileId: 'summary-fixture',
        externalAgentSkill: {
          id: 'fixture-external',
          type: 'agent' as const,
          category: 'owned',
          skillName: 'Fixture',
          prompt: 'Summarize',
          apiAddress: 'https://never-called.invalid',
          apiKey: ''
        },
        conversationId: 'summary-owner',
        signal: controller.signal,
        messages: [
          {
            role: 'user' as const,
            content: 'Summarize',
            attachments: [0, 1].map((index) => ({
              type: 'file' as const,
              url: `blob:summary-${index}.txt`,
              fileName: `summary-${index}.txt`,
              mimeType: 'text/plain',
              ...(kind === 'report' ? { reportBundleRole: 'primary-report' as const } : {})
            }))
          }
        ]
      }
      const pending = (
        stream
          ? requestChatCompletionStream({ ...request, onEvent: vi.fn() })
          : requestChatCompletion(request)
      ).catch((error: unknown) => error)
      const settled = vi.fn()
      void pending.then(settled)
      try {
        await vi.waitFor(() =>
          expect(fetchMock, String(settled.mock.calls[0]?.[0])).toHaveBeenCalledOnce()
        )
        if (phase === 'text') await vi.waitFor(() => expect(text).toHaveBeenCalledOnce())
        expect(String(fetchMock.mock.calls[0][0])).toContain('summary-0.txt')
        const reason =
          reasonType === 'string'
            ? 'Chat session cancelled.'
            : new DOMException('summary cancelled', 'AbortError')
        controller.abort(reason)
        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 500 })
        expect(await pending).toMatchObject({
          name: 'AbortError',
          message: reasonType === 'string' ? reason : 'summary cancelled'
        })
        if (reasonType !== 'string') expect(await pending).toBe(reason)
        expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal)
        fetchGate.resolve(response)
        textGate.resolve('The late first report or file text')
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(text).toHaveBeenCalledTimes(phase === 'text' ? 1 : 0)
        expect(chat).not.toHaveBeenCalled()
        expect(chatStream).not.toHaveBeenCalled()
        expect(cancelConversation).not.toHaveBeenCalled()
      } finally {
        cleaning = true
        fetchGate.resolve(response)
        textGate.resolve('The late first report or file text')
        await pending
      }
    }
  )
})

describe('file summary fallback compatibility', () => {
  it.each(['plain-file', 'report'] as const)(
    'keeps the existing fallback after a live %s read fails and continues to later attachments',
    async (kind) => {
      const controller = new AbortController()
      const first = {
        type: 'file' as const,
        url: 'blob:first.txt',
        fileName: 'first.txt',
        mimeType: 'text/plain',
        ...(kind === 'report' ? { reportBundleRole: 'primary-report' as const } : {})
      }
      const second = {
        type: 'file' as const,
        url: 'blob:second.txt',
        fileName: 'second.txt',
        mimeType: 'text/plain'
      }
      const reader = vi.fn(async (url: string) => {
        if (url === first.url) throw new Error('fixture read failed')
        return 'second file contents'
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const content = await augmentMessageContentWithFileAttachments(
        [first, second],
        'Summarize',
        reader,
        {
          role: 'user',
          signal: controller.signal
        }
      )
      expect(reader.mock.calls.map(([url]) => url)).toEqual([first.url, second.url])
      expect(content).toContain(
        kind === 'report' ? 'report attached: first.txt' : 'file attached: first.txt'
      )
      expect(content).toContain('second file contents')
      expect(warn).toHaveBeenCalledOnce()
    }
  )
})
