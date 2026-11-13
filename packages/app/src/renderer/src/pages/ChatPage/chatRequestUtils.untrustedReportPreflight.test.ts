import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type CustomSkill } from '@shared/config/config'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'

const agent: CustomSkill = { id: 'fixture', type: 'agent', category: 'fixture', skillName: 'Fixture', prompt: 'Analyze', apiAddress: 'https://synthetic.invalid', apiKey: '' }
const config: Config = { ...DEFAULT_CONFIG, use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [{ id: 'fixture-profile', provider: 'openai', deployment: 'cloud', model_use: 'chat', model_name: 'fixture-model', base_url: 'https://synthetic.invalid/v1', api_key: 'synthetic', api_mode: 'chat-completions', attachment_transports: ['request-data-url', 'accessible-url'] }] } }
const primary = (extra: Record<string, unknown> = {}) => ({ type: 'file' as const, url: 'data:text/plain;base64,QQ==', fileName: 'report.txt', reportBundleRole: 'primary-report' as const, ...extra })
const picture = { type: 'image' as const, url: 'local-media:///synthetic/image.png', mimeType: 'image/png' }
function fixture() {
  const fetch = vi.fn(async () => new Response('synthetic', { headers: { 'content-type': 'text/plain' } }))
  const materialize = vi.fn()
  const chat = vi.fn(async () => ({ content: 'synthetic' }))
  const chatStream = vi.fn(async (_payload, receiver: { onData: (event: unknown) => void }) => receiver.onData({ type: 'done', content: 'synthetic' }))
  const remoteFetch = vi.fn(async () => ({ status: 200, statusText: 'OK', body: JSON.stringify({ content: 'synthetic' }) }))
  const externalAgentStream = vi.fn(async (_payload, receiver: { onData: (event: unknown) => void }) => receiver.onData({ type: 'done', content: 'synthetic' }))
  vi.stubGlobal('fetch', fetch)
  window.api = { svcManagedMedia: { materializeForRequest: materialize }, svcLLMProxy: { chat, chatStream, remoteFetch, externalAgentStream } } as unknown as Window['api']
  return { fetch, materialize, chat, chatStream, remoteFetch, externalAgentStream }
}
function run(messages: ChatMessage[], stream = false, external = false, latest = false) {
  const input = { config, messages, profileId: 'fixture-profile', ...(external ? { externalAgentSkill: agent } : {}), ...(latest ? { imageHistoryPolicy: 'latest-user-turn' as const } : {}) }
  return stream ? requestChatCompletionStream({ ...input, onEvent: vi.fn() }) : requestChatCompletion(input)
}
beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('unverified primary-report request preflight', () => {
  it.each([
    ['missing manifest', {}, false, false, false],
    ['self claimed hint', { reportBundleId: 'claimed', reportBundleImageCount: 1 }, false, false, true],
    ['present manifest', { reportBundleManifestUrl: 'local-media:///synthetic/manifest.json', reportBundleId: 'claimed', reportBundleImageCount: 1 }, true, false, true],
    ['external route', { reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }, false, true, false],
    ['external streaming', {}, true, true, true]
  ] as const)('rejects %s before I/O', async (_name, metadata, stream, external, withImage) => {
    const f = fixture()
    const messages: ChatMessage[] = [{ role: 'user', content: 'synthetic', attachments: [primary(metadata), ...(withImage ? [picture] : [])] }]
    const before = JSON.stringify(messages)
    await expect(run(messages, stream, external)).rejects.toThrow()
    expect(JSON.stringify(messages)).toBe(before)
    for (const fn of Object.values(f)) expect(fn).not.toHaveBeenCalled()
  })
  it('rejects an old primary file even under latest-user-turn image policy', async () => {
    const f = fixture()
    const messages: ChatMessage[] = [{ role: 'user', content: 'old', attachments: [primary({ reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }), picture] }, { role: 'user', content: 'new' }]
    const before = JSON.stringify(messages)
    await expect(run(messages, false, false, true)).rejects.toThrow()
    expect(JSON.stringify(messages)).toBe(before)
    for (const fn of Object.values(f)) expect(fn).not.toHaveBeenCalled()
  })
  it('allows an ordinary file without a report role', async () => {
    const f = fixture()
    const messages: ChatMessage[] = [{ role: 'user', content: 'synthetic', attachments: [{ type: 'file', url: 'data:text/plain;base64,QQ==', fileName: 'ordinary.txt', mimeType: 'text/plain' }] }]
    await expect(run(messages)).resolves.toBeDefined()
    expect(f.chat).toHaveBeenCalledOnce()
  })
  it('allows a message already projected without the report attachment', async () => {
    const f = fixture()
    const projected: ChatMessage[] = [{ role: 'user', content: 'synthetic' }]
    await expect(run(projected)).resolves.toBeDefined()
    expect(f.chat).toHaveBeenCalledOnce()
  })
})
