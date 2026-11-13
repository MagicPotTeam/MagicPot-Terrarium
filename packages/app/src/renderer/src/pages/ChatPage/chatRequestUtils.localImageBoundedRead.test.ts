import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { ChatMessage } from '@shared/llm'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'

const profile = { id: 'bounded-fixture', provider: 'openai' as const, deployment: 'cloud' as const, model_use: 'chat' as const, model_name: 'fixture', base_url: 'https://fixture.invalid/v1', api_key: 'fixture', api_mode: 'responses' as const, attachment_transports: ['request-data-url' as const] }
const config = { ...DEFAULT_CONFIG, use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [profile] } }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe.each([false, true])('ordinary local image bounded read, stream=%s', stream => {
  function setup(body: ReadableStream<Uint8Array> | null, blobResult: () => Promise<Blob>) {
    const blob = vi.fn(blobResult), arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    const fetch = vi.fn(async () => ({ ok: true, headers: { get: () => 'image/png' }, body, blob, arrayBuffer }) as unknown as Response)
    vi.stubGlobal('fetch', fetch)
    const chat = vi.fn(async () => ({ content: 'ok' }))
    const chatStream = vi.fn(async (_request, response) => { response.onData({ type: 'done', delta: '', done: true, content: 'ok', finishReason: 'stop' }) })
    vi.stubGlobal('api', { svcLLMProxy: { chat, chatStream } })
    const messages: ChatMessage[] = [{ role: 'user', content: 'fixture', attachments: [{ type: 'image', url: 'local-media:///fixture.png', fileName: 'fixture.png' }] }]
    const originalMessage = messages[0], originalAttachment = messages[0].attachments![0], snapshot = structuredClone(messages)
    const controller = new AbortController()
    const send = () => {
      const input = { config, profileId: 'bounded-fixture', messages, signal: controller.signal }
      return stream ? requestChatCompletionStream({ ...input, onEvent: vi.fn() }) : requestChatCompletion(input)
    }
    const unchanged = () => { expect(messages).toEqual(snapshot); expect(messages[0]).toBe(originalMessage); expect(messages[0].attachments![0]).toBe(originalAttachment) }
    return { blob, arrayBuffer, fetch, chat, chatStream, controller, send, unchanged }
  }

  it('uses the response stream for a small image without blob or arrayBuffer', async () => {
    const read = vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array([1]) }).mockResolvedValueOnce({ done: true })
    const cancel = vi.fn(async () => {})
    const body = { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) } as unknown as ReadableStream<Uint8Array>
    const f = setup(body, async () => new Blob([new Uint8Array([1])], { type: 'image/png' }))
    await expect(f.send()).resolves.toBeDefined()
    expect(read).toHaveBeenCalled()
    expect(f.blob).not.toHaveBeenCalled(); expect(f.arrayBuffer).not.toHaveBeenCalled()
    expect(stream ? f.chatStream : f.chat).toHaveBeenCalledOnce()
    f.unchanged()
  })

  it('fails closed without a response body even if blob is available', async () => {
    const f = setup(null, async () => new Blob([new Uint8Array([1])], { type: 'image/png' }))
    await expect(f.send()).rejects.toThrow()
    expect(f.blob).not.toHaveBeenCalled(); expect(f.arrayBuffer).not.toHaveBeenCalled()
    expect(f.chat).not.toHaveBeenCalled(); expect(f.chatStream).not.toHaveBeenCalled()
    f.unchanged()
  })

  it('cancels a pending body reader on abort', async () => {
    const gate = deferred<Blob>()
    const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}))
    const cancel = vi.fn(async () => {})
    const body = { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) } as unknown as ReadableStream<Uint8Array>
    const f = setup(body, () => gate.promise)
    const pending = f.send(), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalled(), { timeout: 300 })
    } finally {
      f.controller.abort()
      await rejected
      gate.resolve(new Blob())
    }
    expect(cancel).toHaveBeenCalled()
    expect(f.blob).not.toHaveBeenCalled(); expect(f.arrayBuffer).not.toHaveBeenCalled()
    expect(f.chat).not.toHaveBeenCalled(); expect(f.chatStream).not.toHaveBeenCalled()
    f.unchanged()
  })

  it('aborts a pending blob fallback and does not dispatch', async () => {
    const gate = deferred<Blob>()
    const f = setup(null, () => gate.promise)
    const pending = f.send(), rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(f.blob).toHaveBeenCalledOnce())
    f.controller.abort(); await rejected
    expect(f.chat).not.toHaveBeenCalled(); expect(f.chatStream).not.toHaveBeenCalled()
    gate.resolve(new Blob([new Uint8Array([1])], { type: 'image/png' }))
    expect(f.arrayBuffer).not.toHaveBeenCalled(); f.unchanged()
  })
})
