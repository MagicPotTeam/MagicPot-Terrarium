import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ChatMessage } from '@shared/llm'
import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'

const config: Config = { ...DEFAULT_CONFIG, use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [{ id: 'fixture', provider: 'openai', deployment: 'cloud', model_use: 'chat', model_name: 'fixture', base_url: 'https://provider.invalid/v1', api_key: 'fixture', api_mode: 'responses', call_type: 'api', attachment_transports: ['request-data-url'] }] } }
// 12 base64 characters = 9 bytes per image after encoding for the request.
const dataUrl = 'data:image/png;base64,YWJjZGVmZ2hp'
const output = { transport: 'request-data-url' as const, dataUrl, mimeType: 'image/png', sizeBytes: 9 }
const SECRET_TEXT = 'private prompt text that must never leave the renderer'

function messages(): ChatMessage[] {
  return [{ role: 'user', content: SECRET_TEXT, attachments: Array.from({ length: 3 }, (_, index) => {
    const hash = index.toString(16).repeat(64)
    return { type: 'image' as const, url: `local-media:///secret-folder/${index}.png`, fileName: `secret-name-${index}.png`, sizeBytes: 1000,
      media: { version: 1 as const, kind: 'managed' as const, relativePath: `originals/${hash.slice(0, 2)}/${hash}.png`, sha256: hash, sizeBytes: 1000, mimeType: 'image/png', originalFileName: `secret-name-${index}.png` } }
  }) }]
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (window as { appDiagnostics?: unknown }).appDiagnostics
})

describe.each([false, true])('send-stage breadcrumbs, stream=%s', (stream) => {
  function setup() {
    const reportChatSendStage = vi.fn()
    ;(window as { appDiagnostics?: unknown }).appDiagnostics = { reportChatSendStage }
    const order: string[] = []
    reportChatSendStage.mockImplementation((breadcrumb: { stage: string }) => order.push(breadcrumb.stage))
    const chat = vi.fn(async () => { order.push('dispatch'); return { content: 'ok' } })
    const chatStream = vi.fn(async (_request: unknown, response: ServerStreaming<LLMChatStreamResp>) => {
      order.push('dispatch'); response.onData({ type: 'done', delta: '', done: true, content: 'ok', finishReason: 'stop' })
    })
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected network') }))
    window.api = { svcManagedMedia: { materializeForRequest: vi.fn(async () => output) }, svcLLMProxy: { chat, chatStream, remoteFetch: vi.fn() } } as unknown as Window['api']
    const send = () => {
      const options = { config, messages: messages(), profileId: 'fixture', signal: new AbortController().signal }
      return stream ? requestChatCompletionStream({ ...options, onEvent: vi.fn() }) : requestChatCompletion(options)
    }
    return { reportChatSendStage, order, send }
  }

  it('reports one breadcrumb per stage, in order, with counts and sizes only', async () => {
    const f = setup()
    await f.send()

    expect(f.order).toEqual(['request-start', 'images-checked', 'request-built', 'dispatch', 'reply-finished'])
    const [start, , built] = f.reportChatSendStage.mock.calls.map(([breadcrumb]) => breadcrumb)
    expect(start).toMatchObject({ stage: 'request-start', messageCount: 1, imageCount: 3, imageBytes: 3000, dataUrlCount: 0, dataUrlChars: 0 })
    // After the request was built the images are inline data: URLs.
    expect(built).toMatchObject({ stage: 'request-built', imageCount: 3, dataUrlCount: 3, dataUrlChars: 3 * dataUrl.length })
    for (const [breadcrumb] of f.reportChatSendStage.mock.calls) {
      const serialized = JSON.stringify(breadcrumb)
      expect(serialized).not.toContain('private prompt')
      expect(serialized).not.toContain('secret')
      expect(serialized).not.toContain('data:')
      expect(serialized).not.toContain('local-media')
    }
  })

  // Updated: 'reply-failed' used to carry the counts of the input messages and nothing else.
  it('reports a failed or aborted request, so that a later death is not placed in a send that had ended', async () => {
    const f = setup()
    const failure = new Error('provider said no: secret detail')
    const dispatch = (stream ? window.api.svcLLMProxy.chatStream : window.api.svcLLMProxy.chat) as unknown as ReturnType<typeof vi.fn>
    dispatch.mockImplementation(async () => { f.order.push('dispatch'); throw failure })

    // The caller gets the very same error.
    await expect(f.send()).rejects.toBe(failure)

    expect(f.order).toEqual(['request-start', 'images-checked', 'request-built', 'dispatch', 'reply-failed'])
    const failed = f.reportChatSendStage.mock.calls.at(-1)?.[0]
    const built = f.reportChatSendStage.mock.calls.at(-2)?.[0]
    // The stage it had reached, the counts of that stage and the error's name; never its message.
    expect(failed).toEqual({
      stage: 'reply-failed',
      sendSeq: built.sendSeq,
      messageCount: 1,
      imageCount: 3,
      // The sizes of the built request (9 bytes per encoded image), not of the input.
      imageBytes: 3 * 9,
      dataUrlCount: 3,
      dataUrlChars: 3 * dataUrl.length,
      failedAfter: 'request-built',
      errorName: 'Error'
    })
    expect(JSON.stringify(failed)).not.toContain('secret')
    expect(JSON.stringify(failed)).not.toContain('provider')
  })

  it('tells a failure while the images are read from the user\'s Stop during the reply', async () => {
    const f = setup()
    const materialize = window.api.svcManagedMedia.materializeForRequest as unknown as ReturnType<typeof vi.fn>
    materialize.mockImplementation(async () => { throw new RangeError('Array buffer allocation failed for secret-name-0.png') })
    await expect(f.send()).rejects.toBeInstanceOf(RangeError)
    const readFailure = f.reportChatSendStage.mock.calls.at(-1)?.[0]
    expect(readFailure).toMatchObject({ stage: 'reply-failed', failedAfter: 'images-checked', errorName: 'RangeError', imageCount: 3 })
    expect(JSON.stringify(readFailure)).not.toContain('secret')

    const g = setup()
    const dispatch = (stream ? window.api.svcLLMProxy.chatStream : window.api.svcLLMProxy.chat) as unknown as ReturnType<typeof vi.fn>
    dispatch.mockImplementation(async () => { throw new DOMException('The user aborted a request.', 'AbortError') })
    await expect(g.send()).rejects.toBeDefined()
    expect(g.reportChatSendStage.mock.calls.at(-1)?.[0]).toMatchObject({ stage: 'reply-failed', failedAfter: 'request-built', errorName: 'AbortError', dataUrlCount: 3 })

    // An app's own error class or a thrown non-error is 'other', never its own name.
    const h = setup()
    const dispatchH = (stream ? window.api.svcLLMProxy.chatStream : window.api.svcLLMProxy.chat) as unknown as ReturnType<typeof vi.fn>
    dispatchH.mockImplementation(async () => { throw Object.assign(new Error('x'), { name: 'secret-name-0.png' }) })
    await expect(h.send()).rejects.toBeDefined()
    expect(h.reportChatSendStage.mock.calls.at(-1)?.[0]).toMatchObject({ stage: 'reply-failed', errorName: 'other' })
  })

  it('gives every stage of one request the same number and every request its own', async () => {
    const f = setup()
    await f.send()
    await f.send()
    const seqs = f.reportChatSendStage.mock.calls.map(([breadcrumb]) => breadcrumb.sendSeq)
    expect(seqs).toHaveLength(8)
    expect(new Set(seqs.slice(0, 4)).size).toBe(1)
    expect(new Set(seqs.slice(4)).size).toBe(1)
    expect(seqs[4]).toBeGreaterThan(seqs[0])
    expect(Number.isSafeInteger(seqs[0]) && seqs[0] > 0).toBe(true)
  })

  it('keeps an image send that is still running apart from a text request that ends meanwhile', async () => {
    const f = setup()
    const dispatch = (stream ? window.api.svcLLMProxy.chatStream : window.api.svcLLMProxy.chat) as unknown as ReturnType<typeof vi.fn>
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const original = dispatch.getMockImplementation() as (...args: unknown[]) => unknown
    dispatch.mockImplementationOnce(async (...args: unknown[]) => { await held; return original(...args) })
    const imageSend = f.send()
    await vi.waitFor(() => expect(f.order).toContain('request-built'))

    const textOnly = { config, messages: [{ role: 'user' as const, content: 'hi' }], profileId: 'fixture', signal: new AbortController().signal }
    await (stream ? requestChatCompletionStream({ ...textOnly, onEvent: vi.fn() }) : requestChatCompletion(textOnly))

    const reports = f.reportChatSendStage.mock.calls.map(([breadcrumb]) => breadcrumb)
    const imageSeq = reports[0].sendSeq
    const textSeq = reports.at(-1).sendSeq
    expect(textSeq).not.toBe(imageSeq)
    expect(reports.at(-1)).toMatchObject({ stage: 'reply-finished', imageCount: 0 })
    // The image send's own last report is still a running stage.
    expect(reports.filter((breadcrumb) => breadcrumb.sendSeq === imageSeq).at(-1)).toMatchObject({ stage: 'request-built', imageCount: 3 })

    release()
    await imageSend
    expect(f.reportChatSendStage.mock.calls.at(-1)?.[0]).toMatchObject({ stage: 'reply-finished', sendSeq: imageSeq, imageCount: 3 })
  })

  // Updated: this used to report 'reply-failed', which overwrote the breadcrumb of a send that was running.
  it('reports nothing for a request that was aborted before anything was read', async () => {
    const f = setup()
    const controller = new AbortController()
    controller.abort()
    const options = { config, messages: messages(), profileId: 'fixture', signal: controller.signal }

    await expect(stream ? requestChatCompletionStream({ ...options, onEvent: vi.fn() }) : requestChatCompletion(options)).rejects.toBeDefined()

    expect(f.order).toEqual([])
  })

  it('carries no JS heap number: performance.memory does not follow the heap', async () => {
    const f = setup()
    vi.stubGlobal('performance', { ...performance, now: () => 0, memory: { usedJSHeapSize: 26_000_000, jsHeapSizeLimit: 2_330_000_000 } })
    await f.send()
    for (const [breadcrumb] of f.reportChatSendStage.mock.calls) {
      expect(breadcrumb).not.toHaveProperty('usedJSHeapSize')
      expect(breadcrumb).not.toHaveProperty('jsHeapSizeLimit')
    }
  })

  it('never lets a failing diagnostics bridge affect the send', async () => {
    const f = setup()
    f.reportChatSendStage.mockImplementation(() => { throw new Error('bridge gone') })
    await expect(f.send()).resolves.toBeDefined()
  })

  it('is a no-op without the bridge', async () => {
    const f = setup()
    delete (window as { appDiagnostics?: unknown }).appDiagnostics
    await expect(f.send()).resolves.toBeDefined()
    expect(f.reportChatSendStage).not.toHaveBeenCalled()
  })
})
