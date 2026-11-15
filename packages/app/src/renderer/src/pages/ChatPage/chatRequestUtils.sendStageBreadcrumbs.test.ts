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
