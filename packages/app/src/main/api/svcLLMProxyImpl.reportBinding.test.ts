// Direct MAIN service tests of the report-bundle binding check at the chat boundary, with the
// real registry on a real temporary directory. Not IPC and not an end-to-end test.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { LLMChatReq, LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import { UNVERIFIED_REPORT_BUNDLE_MESSAGE } from '@shared/llm/unverifiedReport'
import {
  beginReportBundle,
  initializeReportBundleRegistry,
  registerReportBundle,
  resetReportBundleRegistryForTest
} from '../reportBundles/reportBundleRegistry'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

// The node suite replaces node:fs with memfs; the registry needs real links, ctime and nlink.
vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('node:fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
)
const h = vi.hoisted(() => ({
  config: undefined as Config | undefined,
  dataDir: '',
  fetch: vi.fn(),
  worker: vi.fn(),
  resolve: vi.fn()
}))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.dataDir } }) }))
vi.mock('../config/config', () => ({
  getConfig: () => h.config,
  saveConfig: vi.fn(),
  onConfigCommitted: () => () => undefined
}))
vi.mock('../assistantRuntime/runtime', () => ({
  getAssistantRuntime: () => ({ listTools: () => [], callTool: vi.fn() })
}))
vi.mock('../mcp/runtime', () => ({
  syncMcpClientManager: vi.fn(async () => undefined),
  getMcpClientManager: () => ({
    listPinnedTools: () => [],
    listConnections: () => [],
    isConnectionSuppressed: () => false
  })
}))
vi.mock('../extensions/generatedRegistry', () => ({
  mainHostExtensionApiV1: { apiServices: [], llmProxy: [] }
}))
vi.mock('electron', () => ({
  net: {},
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() }
}))
vi.mock('../llmProxy/chatImagePreparation', async (original) => {
  const actual = await original<typeof import('../llmProxy/chatImagePreparation')>()
  return {
    ...actual,
    createChatImagePreparation: () =>
      actual.createChatImagePreparation({
        resolveWorker: () => h.resolve(),
        runWorker: (input) => h.worker(input)
      })
  }
})

const endpoint = 'https://provider.invalid/v1/responses'
const reportText = '# Synthetic report\nbody\n'
const dataUrlOf = (text: string) =>
  `data:text/markdown;base64,${Buffer.from(text).toString('base64')}`
const forgedBinding = `rb1.${'A'.repeat(43)}`
let tmp = ''

async function sealBundle(conversationId: string): Promise<string> {
  const root = path.join(tmp, 'project')
  const bundleDir = path.join(root, '.report_bundles', 'canvas-target-synthetic')
  const { ticket } = await beginReportBundle({ bundleDir, conversation: { conversationId } }, [
    root
  ])
  fs.writeFileSync(path.join(bundleDir, 'report.md'), reportText)
  fs.writeFileSync(
    path.join(bundleDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      bundleId: 'canvas-target-synthetic',
      title: 'Synthetic',
      createdAt: new Date().toISOString(),
      primaryRefName: 'report.md',
      entries: [
        {
          role: 'primary-report',
          fileName: 'report.md',
          mimeType: 'text/markdown',
          refName: 'report.md',
          relativePath: 'report.md',
          imageCount: 0
        }
      ]
    })
  )
  return (await registerReportBundle({ ticket })).binding
}

const makeReq = (binding: string, url: string, conversationId: string | undefined): LLMChatReq => ({
  profileId: 'fixture',
  ...(conversationId ? { conversationId } : {}),
  messages: [
    {
      role: 'user',
      content: 'synthetic',
      attachments: [
        {
          type: 'file',
          url,
          fileName: 'report.md',
          mimeType: 'text/markdown',
          reportBundleRole: 'primary-report',
          reportBundleId: 'canvas-target-synthetic',
          reportBundleBinding: binding
        }
      ]
    }
  ]
})

async function run(mode: 'unary' | 'stream', req: LLMChatReq) {
  const service = new LLMProxySvcImpl({ retryModelCapacity: false })
  const onData = vi.fn<(event: LLMChatStreamResp) => void>()
  let error: unknown
  try {
    if (mode === 'unary') await service.chat(req)
    else await service.chatStream(req, { onData })
  } catch (caught) {
    error = caught
  }
  const streamError = onData.mock.calls
    .map(([event]) => event)
    .find((event) => event.type === 'error')
  return { error, streamError, onData }
}

beforeEach(() => {
  vi.clearAllMocks()
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-llm-report-binding-')))
  h.dataDir = path.join(tmp, 'data')
  fs.mkdirSync(h.dataDir, { recursive: true })
  initializeReportBundleRegistry({ userDataDir: path.join(tmp, 'userData') })
  const config = structuredClone(DEFAULT_CONFIG)
  config.use_remote_llm = false
  config.mcp_config.client.servers = []
  const profile: LLMAPIProfile = {
    id: 'fixture',
    api_key: 'fixture',
    base_url: 'https://provider.invalid/v1',
    model_name: 'fixture',
    provider: 'openai',
    call_type: 'api',
    model_use: 'chat',
    api_mode: 'responses',
    attachment_transports: ['request-data-url']
  }
  config.llm_config.api_profiles = [profile]
  h.config = config
  h.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== endpoint || init?.method !== 'POST')
      throw new Error('unexpected network access')
    const completed = {
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }
      ]
    }
    return new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } }
    )
  })
  vi.stubGlobal('fetch', h.fetch)
})
afterEach(() => {
  resetReportBundleRegistryForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe.each(['unary', 'stream'] as const)('MAIN report-bundle binding check (%s)', (mode) => {
  const expectRefused = (outcome: Awaited<ReturnType<typeof run>>) => {
    const message =
      mode === 'unary' ? (outcome.error as Error | undefined)?.message : outcome.streamError?.error
    expect(message).toBe(UNVERIFIED_REPORT_BUNDLE_MESSAGE)
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.resolve).not.toHaveBeenCalled()
    expect(h.worker).not.toHaveBeenCalled()
    const surfaced = `${String(outcome.error)} ${JSON.stringify(outcome.onData.mock.calls)}`
    expect(surfaced).not.toContain(tmp)
    expect(surfaced).not.toContain('report.md')
    expect(surfaced).not.toContain('rb1.')
  }

  it('refuses a forged well-formed binding before provider and worker', async () => {
    await sealBundle('conv-1')
    expectRefused(await run(mode, makeReq(forgedBinding, dataUrlOf(reportText), 'conv-1')))
  })

  it('lets a registered binding with its conversation and the exact primary bytes reach the provider, without the binding', async () => {
    const binding = await sealBundle('conv-1')
    const outcome = await run(mode, makeReq(binding, dataUrlOf(reportText), 'conv-1'))
    expect(outcome.error).toBeUndefined()
    expect(outcome.streamError).toBeUndefined()
    expect(h.fetch).toHaveBeenCalledOnce()
    const body = String((h.fetch.mock.calls[0][1] as RequestInit).body)
    expect(body).not.toContain(binding)
    expect(body).not.toContain('reportBundleBinding')
  })

  it('refuses the same binding with other primary bytes', async () => {
    const binding = await sealBundle('conv-1')
    expectRefused(await run(mode, makeReq(binding, dataUrlOf('# Another report\n'), 'conv-1')))
  })

  it('refuses the binding in another conversation, or without one', async () => {
    const binding = await sealBundle('conv-1')
    expectRefused(await run(mode, makeReq(binding, dataUrlOf(reportText), 'conv-2')))
    expectRefused(await run(mode, makeReq(binding, dataUrlOf(reportText), undefined)))
  })

  it('refuses a registered primary that also carries binary or media, which would replace its checked url', async () => {
    const binding = await sealBundle('conv-1')
    const withExtra = (extra: Record<string, unknown>): LLMChatReq => {
      const req = makeReq(binding, dataUrlOf(reportText), 'conv-1')
      const [message] = req.messages
      return {
        ...req,
        messages: [{ ...message, attachments: [{ ...message.attachments![0], ...extra } as never] }]
      }
    }
    const otherBytes = Buffer.from('# Another report\n')
    expectRefused(
      await run(
        mode,
        withExtra({
          binary: {
            transport: 'chunked-binary-v1',
            reference: { sizeBytes: otherBytes.length, chunkCount: 1 },
            chunks: [{ index: 0, bytes: new Uint8Array(otherBytes) }]
          }
        })
      )
    )
    expectRefused(
      await run(
        mode,
        withExtra({
          media: {
            version: 1,
            kind: 'managed',
            relativePath: `originals/aa/${'a'.repeat(64)}.md`,
            mimeType: 'text/markdown',
            sizeBytes: otherBytes.length,
            sha256: 'a'.repeat(64)
          }
        })
      )
    )
  })

  it('refuses every binding while the registry is not initialised', async () => {
    const binding = await sealBundle('conv-1')
    resetReportBundleRegistryForTest()
    expectRefused(await run(mode, makeReq(binding, dataUrlOf(reportText), 'conv-1')))
  })
})
