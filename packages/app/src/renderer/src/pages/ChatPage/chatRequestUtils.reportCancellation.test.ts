import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'
import { expandReportBundleAttachments } from './chatAttachmentPromptUtils'

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

describe.each([false, true])('report expansion cancellation (stream=%s)', (stream) => {
  it.each(
    (['preflight', 'preparation'] as const).flatMap((stage) =>
      (['fetch', 'text'] as const).flatMap((phase) =>
        (['dom-exception', 'string'] as const).map((reason) => [stage, phase, reason] as const)
      )
    )
  )(
    'stops during %s manifest %s with %s cancellation and does not read later manifests',
    async (stage, phase, reasonType) => {
      const firstManifest = deferred<string>()
      const fetchGate = deferred<Response>()
      let cleaning = false
      const firstText = vi.fn(() => firstManifest.promise)
      const response = { ok: true, text: firstText } as unknown as Response
      const fetchMock = vi.fn((_url: string, _options?: RequestInit): Promise<Response> => {
        if (cleaning) {
          return Promise.resolve({
            ok: true,
            text: async () => '{"version":1,"bundleId":"fixture","entries":[]}'
          } as unknown as Response)
        }
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
      const profile = {
        id: 'report-cancel-fixture',
        provider: 'openai' as const,
        deployment: 'cloud' as const,
        model_use: 'chat' as const,
        model_name: 'fixture',
        base_url: 'https://api.openai.com/v1',
        api_key: 'fixture',
        api_mode: (stage === 'preflight' ? 'responses' : 'chat-completions') as
          'responses' | 'chat-completions',
        attachment_transports: ['request-data-url' as const]
      }
      const controller = new AbortController()
      const request = {
        config: {
          ...DEFAULT_CONFIG,
          use_remote_llm: false,
          llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [profile] }
        },
        profileId: profile.id,
        conversationId: 'report-cancel',
        signal: controller.signal,
        messages: [
          {
            role: 'user' as const,
            content: 'Read the reports',
            attachments: [0, 1].map((index) => ({
              type: 'file' as const,
              url: 'data:text/plain;base64,YQ==',
              fileName: `report-${index}.txt`,
              reportBundleRole: 'primary-report' as const,
              reportBundleId: `report-${index}`,
              reportBundleManifestUrl: `local-media:///fixture/manifest-${index}.json`
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
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
        if (phase === 'text') await vi.waitFor(() => expect(firstText).toHaveBeenCalledOnce())
        expect(String(fetchMock.mock.calls[0][0])).toContain('manifest-0')
        const reason =
          reasonType === 'string'
            ? 'Chat session cancelled.'
            : new DOMException('cancel report', 'AbortError')
        controller.abort(reason)
        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 500 })
        expect(await pending).toMatchObject({
          name: 'AbortError',
          message: reasonType === 'string' ? reason : 'cancel report'
        })
        if (reasonType !== 'string') expect(await pending).toBe(reason)
        expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal)
        fetchGate.resolve(response)
        firstManifest.resolve('{"version":1,"bundleId":"report-0","entries":[]}')
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(firstText).toHaveBeenCalledTimes(phase === 'text' ? 1 : 0)
        expect(chat).not.toHaveBeenCalled()
        expect(chatStream).not.toHaveBeenCalled()
        expect(cancelConversation).not.toHaveBeenCalled()
      } finally {
        cleaning = true
        fetchGate.resolve(response)
        firstManifest.resolve('{"version":1,"bundleId":"report-0","entries":[]}')
        await pending
      }
    }
  )
})

describe('best-effort report expansion compatibility', () => {
  it.each([false, true])(
    'continues to a second manifest on a normal failure (live signal=%s)',
    async (withSignal) => {
      const primary = (id: string) => ({
        type: 'file' as const,
        url: `file:///report-${id}.txt`,
        reportBundleRole: 'primary-report' as const,
        reportBundleId: id,
        reportBundleManifestUrl: `file:///${id}/manifest.json`
      })
      const inputs = [primary('a'), primary('b')]
      const failure = new Error('fixture manifest unavailable')
      const reader = vi.fn(async (url: string) => {
        if (url.includes('/a/')) throw failure
        return JSON.stringify({
          version: 1,
          bundleId: 'b',
          entries: [{ role: 'report-image', fileName: 'image.png', relativePath: 'image.png' }]
        })
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const signal = withSignal ? new AbortController().signal : undefined
      const output = await expandReportBundleAttachments(inputs, reader, signal)
      expect(reader.mock.calls.map(([url]) => url)).toEqual([
        'file:///a/manifest.json',
        'file:///b/manifest.json'
      ])
      expect(output?.slice(0, 2)).toEqual(inputs)
      expect(output?.[2]).toMatchObject({
        type: 'image',
        reportBundleId: 'b',
        fileName: 'image.png'
      })
      expect(warn).toHaveBeenCalledOnce()
    }
  )
})
