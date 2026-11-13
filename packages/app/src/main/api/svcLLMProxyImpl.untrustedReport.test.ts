// Synthetic direct MAIN service tests; not IPC or an end-to-end authorization test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { LLMChatReq, LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

const h = vi.hoisted(() => ({ config: undefined as Config | undefined, fetch: vi.fn(), worker: vi.fn(), resolve: vi.fn() }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
vi.mock('../config/config', () => ({ getConfig: () => h.config, saveConfig: vi.fn(), onConfigCommitted: () => () => undefined }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: () => [], callTool: vi.fn() }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined), getMcpClientManager: () => ({ listPinnedTools: () => [], listConnections: () => [], isConnectionSuppressed: () => false }) }))
vi.mock('../extensions/generatedRegistry', () => ({ mainHostExtensionApiV1: { apiServices: [], llmProxy: [] } }))
vi.mock('electron', () => ({ net: {}, webContents: { fromId: vi.fn() }, BrowserWindow: { fromWebContents: vi.fn() } }))
vi.mock('../llmProxy/chatImagePreparation', async original => {
  const actual = await original<typeof import('../llmProxy/chatImagePreparation')>()
  return { ...actual, createChatImagePreparation: () => actual.createChatImagePreparation({ resolveWorker: () => h.resolve(), runWorker: input => h.worker(input) }) }
})
const endpoint = 'https://provider.invalid/v1/responses'
const secret = 'C:/synthetic/private/report-secret.md'
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const makeReq = (report: boolean, manifest: boolean): LLMChatReq => ({ profileId: 'fixture', messages: [{ role: 'user', content: 'synthetic', attachments: [
  { type: 'file', url: 'file:///' + secret, fileName: 'report.md', ...(report ? { reportBundleRole: 'primary-report' as const, reportBundleId: 'forged', ...(manifest ? { reportBundleManifestUrl: 'file:///C:/synthetic/private/manifest.json' } : {}) } : {}) },
  { type: 'image', url: png, mimeType: 'image/png' }
] }] })
beforeEach(() => {
  vi.clearAllMocks()
  const config = structuredClone(DEFAULT_CONFIG)
  config.use_remote_llm = false
  config.mcp_config.client.servers = []
  const profile: LLMAPIProfile = { id: 'fixture', api_key: 'fixture', base_url: 'https://provider.invalid/v1', model_name: 'fixture', provider: 'openai', call_type: 'api', model_use: 'chat', api_mode: 'responses', attachment_transports: ['request-data-url'] }
  config.llm_config.api_profiles = [profile]
  h.config = config
  h.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== endpoint || init?.method !== 'POST') throw new Error('unexpected network access')
    const completed = { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', h.fetch)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('MAIN synthetic untrusted report guard', () => {
  it.each(['unary', 'stream'] as const)('rejects report role before provider/worker in %s', async mode => {
    const service = new LLMProxySvcImpl({ retryModelCapacity: false })
    const req = makeReq(true, mode === 'stream')
    const onData = vi.fn<(event: LLMChatStreamResp) => void>()
    let error: unknown
    try { if (mode === 'unary') await service.chat(req); else await service.chatStream(req, { onData }) } catch (caught) { error = caught }
    if (mode === 'unary') expect.soft(error).toBeDefined()
    else expect.soft(onData.mock.calls.some(([event]) => event.type === 'error')).toBe(true)
    expect.soft(h.fetch).not.toHaveBeenCalled()
    expect.soft(h.resolve).not.toHaveBeenCalled()
    expect.soft(h.worker).not.toHaveBeenCalled()
    expect.soft(JSON.stringify(onData.mock.calls)).not.toContain(secret)
    expect.soft(String(error)).not.toContain(secret)
  })
  it('allows ordinary non-report file without inventing report rejection', async () => {
    const service = new LLMProxySvcImpl({ retryModelCapacity: false })
    const req = makeReq(false, false)
    await expect(service.chat(req)).resolves.toMatchObject({ content: 'ok' })
    expect(h.fetch).toHaveBeenCalledOnce()
  })
})
