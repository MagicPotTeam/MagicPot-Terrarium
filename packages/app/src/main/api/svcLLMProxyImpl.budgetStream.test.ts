import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import { DEFAULT_CONFIG } from '@shared/config/config'
import * as budget from '@shared/llm/providerJsonBudget'
import { getConfig } from '../config/config'
import { mainHostExtensionApiV1 } from '../extensions/generatedRegistry'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

vi.mock('electron', () => ({ net: {} }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => { throw new Error('Unexpected data path') } }))
vi.mock('./teamEndStore', () => ({ assertTeamRequestActive: vi.fn(), getTeamEndStore: () => { throw new Error('Unexpected End store') } }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: vi.fn(() => []) }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))

const code = 'PROVIDER_JSON_BUDGET_EXCEEDED'
const message = 'Provider request exceeds the size limit. Remove some attachments or send fewer images per message.'
const localConfig = () => {
  const config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [{
    id: 'fixture', provider: 'openai', deployment: 'local', call_type: 'api', model_use: 'chat',
    api_mode: 'chat-completions', base_url: 'https://provider.invalid/v1', api_key: 'fixture', model_name: 'fixture'
  }]
  return config
}
const request = { messages: [{ role: 'user' as const, content: 'fixture prompt' }], profileId: 'fixture' }
beforeEach(() => { vi.mocked(getConfig).mockReturnValue(localConfig()); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('local budget stream projection', () => {
  it('projects the real helper failure into both terminal frames without any model POST', async () => {
    const real = budget.serializeProviderJsonWithBudget
    let failure: unknown
    vi.spyOn(budget, 'serializeProviderJsonWithBudget').mockImplementation(value => {
      try { return real(value, 0) } catch (error) { failure = error; throw error }
    })
    const onData = vi.fn<(value: LLMChatStreamResp) => void>()
    await new LLMProxySvcImpl().chatStream(request, { onData })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(budget.isTrustedProviderJsonBudgetError(failure)).toBe(true)
    expect(onData.mock.calls.map(([event]) => event.type)).toEqual(['error', 'done'])
    for (const [event] of onData.mock.calls) {
      expect(event).toMatchObject({ errorCode: code, error: message, finishReason: 'error' })
      expect(event).not.toHaveProperty('body')
      expect(event).not.toHaveProperty('status')
    }
  })
  it('keeps partial stream text when a fake client subsequently triggers the real budget helper', async () => {
    const real = budget.serializeProviderJsonWithBudget
    vi.spyOn(budget, 'serializeProviderJsonWithBudget').mockImplementation(value => real(value, 0))
    const chat = vi.fn(async (params: { onDelta?: (value: unknown) => void }) => {
      params.onDelta?.({ type: 'text-delta', delta: 'partial output' })
      return budget.serializeProviderJsonWithBudget({ value: 'oversized' }) as never
    })
    const extension = { id: 'owned-budget-stream-fixture', createCli: () => ({ chat }) as never }
    mainHostExtensionApiV1.llmProxy.push(extension)
    try {
      const onData = vi.fn<(value: LLMChatStreamResp) => void>()
      await new LLMProxySvcImpl().chatStream(request, { onData })
      expect(chat).toHaveBeenCalledOnce()
      expect(onData.mock.calls.map(([event]) => event.type)).toEqual(['text-delta', 'error', 'done'])
      for (const [event] of onData.mock.calls.slice(1)) {
        expect(event).toMatchObject({ errorCode: code, error: message, fullContent: 'partial output', finishReason: 'error' })
      }
    } finally {
      mainHostExtensionApiV1.llmProxy.splice(mainHostExtensionApiV1.llmProxy.indexOf(extension), 1)
    }
  })
  it('does not project a public-constructed error carrying the same code', async () => {
    vi.spyOn(budget, 'serializeProviderJsonWithBudget').mockImplementation(() => { throw new budget.ProviderJsonBudgetError() })
    const onData = vi.fn<(value: LLMChatStreamResp) => void>()
    await new LLMProxySvcImpl().chatStream(request, { onData })
    expect(onData.mock.calls.map(([event]) => event.type)).toEqual(['error', 'done'])
    for (const [event] of onData.mock.calls) expect(event).not.toHaveProperty('errorCode')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('remote budget stream projection', () => {
  it.each(['error', 'done'] as const)('does not relay a remote %s frame\'s reserved code', async type => {
    const config = localConfig()
    config.use_remote_llm = true
    config.remote_llm_server_config = { server_origin: 'https://remote.invalid', access_token: 'fixture' }
    vi.mocked(getConfig).mockReturnValue(config)
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ type, delta: '', done: type === 'done', error: 'remote failure', finishReason: 'error', errorCode: code }) + '\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } }))
    const onData = vi.fn<(value: LLMChatStreamResp) => void>()
    await new LLMProxySvcImpl().chatStream(request, { onData })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(onData).toHaveBeenCalled()
    expect(onData.mock.calls.at(-1)?.[0].type).toBe('done')
    for (const [event] of onData.mock.calls) expect(event).not.toHaveProperty('errorCode')
  })
})
