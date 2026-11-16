import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { ChatAttachment, ChatMessage } from '@shared/llm'
import {
  normalizeChatAttachmentsForRequest,
  requestChatCompletion,
  requestChatCompletionStream
} from './chatRequestUtils'

// The per-image cap is a module constant, not a caller option. Lower it here so a
// tiny stream exceeds it; no request input can raise or lower it.
vi.mock('@shared/llm/chatAttachmentTransportLimits', async importOriginal => ({
  ...(await importOriginal<typeof import('@shared/llm/chatAttachmentTransportLimits')>()),
  MAX_LLM_REQUEST_IMAGE_SOURCE_BYTES: 3
}))

const profile = {
  id: 'cap-fixture',
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

const stubImageFetch = (values: Uint8Array[], contentType = 'image/png') => {
  let cursor = 0
  const cancel = vi.fn()
  const blob = vi.fn()
  const arrayBuffer = vi.fn()
  const fetch = vi.fn(async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (cursor === values.length) controller.close()
            else controller.enqueue(values[cursor++])
          },
          cancel
        },
        { highWaterMark: 0 }
      ),
      { headers: { 'content-type': contentType } }
    )
    Object.defineProperty(response, 'blob', { value: blob })
    Object.defineProperty(response, 'arrayBuffer', { value: arrayBuffer })
    return response
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, cancel, blob, arrayBuffer }
}

const stubIpc = () => {
  const chat = vi.fn(async () => ({ content: 'ok' }))
  const chatStream = vi.fn(async (_request, response) => {
    response.onData({ type: 'done', delta: '', done: true, content: 'ok', finishReason: 'stop' })
  })
  vi.stubGlobal('api', { svcLLMProxy: { chat, chatStream } })
  return { chat, chatStream }
}

const capMessage = 'Unable to prepare image attachment "fixture.png" for the model: Image source exceeds the per-image byte limit.'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('per-image source cap for un-managed request images', () => {
  it('accepts an image at the cap through the stream reader', async () => {
    const f = stubImageFetch([new Uint8Array([1, 2]), new Uint8Array([3])])
    const attachments: ChatAttachment[] = [{ type: 'image', url: 'local-media:///fixture.png', fileName: 'fixture.png' }]
    const [result] = (await normalizeChatAttachmentsForRequest(attachments, { allowRequestDataUrl: true }))!
    expect(result.url).toBe('data:image/png;base64,AQID')
    expect(result.mimeType).toBe('image/png')
    expect(result.sizeBytes).toBe(3)
    expect(f.blob).not.toHaveBeenCalled()
    expect(f.arrayBuffer).not.toHaveBeenCalled()
    expect(f.cancel).not.toHaveBeenCalled()
  })

  it('builds a canonical data URL when the source content-type carries parameters', async () => {
    stubImageFetch([new Uint8Array([1, 2, 3])], 'image/PNG; charset=binary')
    const attachments: ChatAttachment[] = [{ type: 'image', url: 'local-media:///fixture.png', fileName: 'fixture.png' }]
    const [result] = (await normalizeChatAttachmentsForRequest(attachments, { allowRequestDataUrl: true }))!
    expect(result.url).toBe('data:image/png;base64,AQID')
    expect(result.mimeType).toBe('image/png')
  })

  it('refuses a stream over the cap, cancels the reader once and leaves the input unchanged', async () => {
    const f = stubImageFetch([new Uint8Array([1, 2]), new Uint8Array([3, 4])])
    const ipc = stubIpc()
    const attachment: ChatAttachment = { type: 'image', url: 'local-media:///fixture.png', fileName: 'fixture.png' }
    const attachments = [attachment]
    const snapshot = structuredClone(attachments)
    await expect(normalizeChatAttachmentsForRequest(attachments, { allowRequestDataUrl: true })).rejects.toThrow(
      capMessage
    )
    expect(f.fetch).toHaveBeenCalledOnce()
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.blob).not.toHaveBeenCalled()
    expect(f.arrayBuffer).not.toHaveBeenCalled()
    expect(attachments).toEqual(snapshot)
    expect(attachments[0]).toBe(attachment)
    expect(ipc.chat).not.toHaveBeenCalled()
    expect(ipc.chatStream).not.toHaveBeenCalled()
  })

  it('refuses a body without getReader instead of falling back to blob()', async () => {
    const blob = vi.fn(async () => new Blob([new Uint8Array([1])], { type: 'image/png' }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/png' }), body: {}, blob }) as unknown as Response)
    )
    const attachments: ChatAttachment[] = [{ type: 'image', url: 'local-media:///fixture.png', fileName: 'fixture.png' }]
    await expect(normalizeChatAttachmentsForRequest(attachments, { allowRequestDataUrl: true })).rejects.toThrow(
      'Unable to prepare image attachment "fixture.png" for the model: Image source did not provide a readable body.'
    )
    expect(blob).not.toHaveBeenCalled()
  })

  it.each([false, true])('sends no chat IPC after the cap refuses an image, stream=%s', async stream => {
    const f = stubImageFetch([new Uint8Array([1, 2, 3, 4])])
    const ipc = stubIpc()
    const messages: ChatMessage[] = [
      { role: 'user', content: 'fixture', attachments: [{ type: 'image', url: 'local-media:///fixture.png', fileName: 'fixture.png' }] }
    ]
    const originalMessage = messages[0]
    const originalAttachment = messages[0].attachments![0]
    const snapshot = structuredClone(messages)
    const input = { config, profileId: 'cap-fixture', messages, signal: new AbortController().signal }
    const send = stream ? requestChatCompletionStream({ ...input, onEvent: vi.fn() }) : requestChatCompletion(input)
    await expect(send).rejects.toThrow(capMessage)
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.blob).not.toHaveBeenCalled()
    expect(ipc.chat).not.toHaveBeenCalled()
    expect(ipc.chatStream).not.toHaveBeenCalled()
    expect(messages).toEqual(snapshot)
    expect(messages[0]).toBe(originalMessage)
    expect(messages[0].attachments![0]).toBe(originalAttachment)
  })
})
