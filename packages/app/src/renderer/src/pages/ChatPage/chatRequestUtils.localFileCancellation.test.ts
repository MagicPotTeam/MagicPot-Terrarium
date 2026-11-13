import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import {
  normalizeChatAttachmentsForRequest,
  requestChatCompletion,
  requestChatCompletionStream
} from './chatRequestUtils'

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

describe.each([false, true])('ordinary local file cancellation (stream=%s)', (stream) => {
  it.each(['fetch', 'blob', 'array-buffer', 'file-reader'] as const)(
    'returns on abort during %s and ignores the late result',
    async (phase) => {
      const fetchGate = deferred<Response>()
      const blobGate = deferred<Blob>()
      const bufferGate = deferred<ArrayBuffer>()
      const fixtureBlob = new Blob(['a'], { type: 'text/plain' })
      const constructedBlob = vi.fn()
      const NativeBlob = globalThis.Blob
      if (phase === 'array-buffer') {
        class CountingBlob extends NativeBlob {
          constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
            super(parts, options)
            constructedBlob()
          }
        }
        vi.stubGlobal('Blob', CountingBlob)
      }
      let cleaning = false
      const readers: FakeReader[] = []
      class FakeReader {
        static readonly LOADING = 1
        readyState = 0
        result: string | null = null
        error: DOMException | null = null
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        onabort: (() => void) | null = null
        readAsDataURL = vi.fn(() => {
          this.readyState = 1
          if (phase !== 'file-reader' || cleaning) queueMicrotask(() => this.finish())
        })
        abort = vi.fn(() => {
          this.readyState = 2
          this.onabort?.()
        })
        constructor() {
          readers.push(this)
        }
        finish() {
          this.readyState = 2
          this.result = 'data:text/plain;base64,YQ=='
          this.onload?.()
        }
      }
      vi.stubGlobal('FileReader', FakeReader)
      const blob = vi.fn(() => (phase === 'blob' ? blobGate.promise : Promise.resolve(fixtureBlob)))
      const arrayBuffer = vi.fn(() => bufferGate.promise)
      const response = {
        ok: true,
        headers: { get: () => 'text/plain' },
        ...(phase === 'array-buffer' ? { arrayBuffer } : { blob })
      } as unknown as Response
      const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
        phase === 'fetch' ? fetchGate.promise : Promise.resolve(response)
      )
      vi.stubGlobal('fetch', fetchMock)
      const chat = vi.fn()
      const chatStream = vi.fn()
      const cancelConversation = vi.fn()
      vi.stubGlobal('api', { svcLLMProxy: { chat, chatStream, cancelConversation } })
      const profile = {
        id: 'local-file-fixture',
        provider: 'openai' as const,
        deployment: 'cloud' as const,
        model_use: 'chat' as const,
        model_name: 'fixture',
        base_url: 'https://fixture.invalid/v1',
        api_key: 'fixture',
        api_mode: 'responses' as const,
        attachment_transports: ['request-data-url' as const]
      }
      const config = {
        ...DEFAULT_CONFIG,
        use_remote_llm: false,
        llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [profile] }
      }
      const controller = new AbortController()
      const request = {
        config,
        profileId: profile.id,
        conversationId: 'local-file-cancellation',
        signal: controller.signal,
        messages: [
          {
            role: 'user' as const,
            content: 'analyze',
            attachments: [0, 1].map((index) => ({
              type: 'file' as const,
              url: `local-media:///fixture-${index}.txt`,
              fileName: `fixture-${index}.txt`
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
        await vi.waitFor(() => {
          if (phase === 'fetch') expect(fetchMock).toHaveBeenCalledOnce()
          else if (phase === 'blob') expect(blob).toHaveBeenCalledOnce()
          else if (phase === 'array-buffer') expect(arrayBuffer).toHaveBeenCalledOnce()
          else expect(readers[0]?.readAsDataURL).toHaveBeenCalledOnce()
        })
        expect(fetchMock).toHaveBeenCalledOnce()
        const lateLoad = readers[0]?.onload
        controller.abort('Chat session cancelled.')
        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 500 })
        expect(await pending).toMatchObject({
          name: 'AbortError',
          message: 'Chat session cancelled.'
        })
        expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal)
        if (phase === 'file-reader') expect(readers[0].abort).toHaveBeenCalledOnce()
        fetchGate.resolve(response)
        blobGate.resolve(fixtureBlob)
        bufferGate.resolve(new Uint8Array([97]).buffer)
        lateLoad?.()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(fetchMock).toHaveBeenCalledOnce()
        if (phase === 'fetch') expect(blob).not.toHaveBeenCalled()
        if (phase === 'blob' || phase === 'array-buffer') expect(readers).toHaveLength(0)
        if (phase === 'array-buffer') expect(constructedBlob).not.toHaveBeenCalled()
        expect(chat).not.toHaveBeenCalled()
        expect(chatStream).not.toHaveBeenCalled()
        expect(cancelConversation).not.toHaveBeenCalled()
      } finally {
        cleaning = true
        fetchGate.resolve(response)
        blobGate.resolve(fixtureBlob)
        bufferGate.resolve(new Uint8Array([97]).buffer)
        for (const reader of readers) reader.finish()
        await pending
      }
    }
  )
  it('pre-aborted local file never starts a fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const reason = new DOMException('stop before file', 'AbortError')
    controller.abort(reason)
    await expect(
      normalizeChatAttachmentsForRequest([{ type: 'file', url: 'local-media:///fixture.txt' }], {
        allowRequestDataUrl: true,
        signal: controller.signal
      })
    ).rejects.toBe(reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('keeps an already completed data URL intact if its signal aborts later', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(['a'], { type: 'text/plain' })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await normalizeChatAttachmentsForRequest(
      [{ type: 'file', url: 'local-media:///fixture.txt' }],
      { allowRequestDataUrl: true, signal: controller.signal }
    )
    expect(result?.[0].url).toBe('data:text/plain;base64,YQ==')
    controller.abort('after success')
    expect(result?.[0].url).toBe('data:text/plain;base64,YQ==')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('keeps the ordinary file error when the body read fails before cancellation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        blob: async () => {
          throw new Error('fixture body failure')
        }
      }))
    )
    await expect(
      normalizeChatAttachmentsForRequest(
        [{ type: 'file', url: 'local-media:///fixture.txt', fileName: 'fixture.txt' }],
        { allowRequestDataUrl: true, signal: new AbortController().signal }
      )
    ).rejects.toThrow(
      'Unable to prepare file attachment "fixture.txt" for the model: fixture body failure'
    )
  })
})
