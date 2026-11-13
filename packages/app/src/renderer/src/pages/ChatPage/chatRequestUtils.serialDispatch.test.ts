import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ChatMessage } from '@shared/llm'
import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'

const config: Config = { ...DEFAULT_CONFIG, use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [{ id: 'fixture', provider: 'openai', deployment: 'cloud', model_use: 'chat', model_name: 'fixture', base_url: 'https://fixture.example/v1', api_key: 'fixture', api_mode: 'responses', call_type: 'api', attachment_transports: ['request-data-url'] }] } }
const messages = (): ChatMessage[] => [{ role: 'user', content: 'fixture', attachments: [
  { type: 'image', url: 'local-media:///fixture/first.png', media: { version: 1, kind: 'managed', relativePath: `originals/aa/${'a'.repeat(64)}.png`, sha256: 'a'.repeat(64), sizeBytes: 1, mimeType: 'image/png', originalFileName: 'first.png' } },
  { type: 'image', url: 'local-media:///fixture/second.png', fileName: 'second.png' },
  { type: 'image', url: 'local-media:///fixture/third.png', fileName: 'third.png' }
] }]
const materialized = { transport: 'request-data-url' as const, dataUrl: 'data:image/png;base64,YQ==', mimeType: 'image/png', sizeBytes: 1 }
const imageResponse = () => ({ ok: true, blob: async () => new Blob(['a'], { type: 'image/png' }) })

afterEach(() => vi.unstubAllGlobals())

describe.each([false, true])('serial preparation before local dispatch (stream=%s)', stream => {
  it.each([false, true])('dispatches only after all images succeed (failSecond=%s)', async failSecond => {
    const events: string[] = []
    const materializeForRequest = vi.fn(async () => { events.push('managed'); return materialized })
    const fetchMock = vi.fn(async (url: string) => {
      events.push(url.includes('second.png') ? 'second' : url.includes('third.png') ? 'third' : 'unexpected')
      if (!url.includes('second.png') && !url.includes('third.png')) throw new Error('Unexpected network access')
      if (failSecond && url.includes('second.png')) throw new Error('fixture second failure')
      return imageResponse()
    })
    const chat = vi.fn(async () => { events.push('chat'); return { content: 'fixture reply' } })
    const chatStream = vi.fn(async (_req: unknown, response: ServerStreaming<LLMChatStreamResp>) => {
      events.push('stream')
      response.onData({ type: 'done', delta: '', done: true, content: 'fixture reply', finishReason: 'stop' })
    })
    vi.stubGlobal('fetch', fetchMock)
    window.api = { svcManagedMedia: { materializeForRequest }, svcLLMProxy: { chat, chatStream, remoteFetch: vi.fn() } } as unknown as Window['api']
    const input = messages(), original = structuredClone(input)
    const options = { config, messages: input, profileId: 'fixture', signal: new AbortController().signal }
    const pending = stream ? requestChatCompletionStream({ ...options, onEvent: vi.fn() }) : requestChatCompletion(options)
    if (failSecond) {
      await expect(pending).rejects.toThrow('fixture second failure')
      expect(events).toEqual(['managed', 'second'])
      expect(chat).not.toHaveBeenCalled()
      expect(chatStream).not.toHaveBeenCalled()
    } else {
      await expect(pending).resolves.toMatchObject(stream ? { result: { content: 'fixture reply' } } : { content: 'fixture reply' })
      expect(events).toEqual(['managed', 'second', 'third', stream ? 'stream' : 'chat'])
      expect(stream ? chatStream : chat).toHaveBeenCalledTimes(1)
    }
    expect(input).toEqual(original)
  })
})
