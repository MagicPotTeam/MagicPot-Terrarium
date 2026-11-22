import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { llmProxySvcDef } from '@shared/api/svcLLMProxy'
import { registerIpcServer } from '@shared/api/createServer/registerIpcServer'
import * as budget from '@shared/llm/providerJsonBudget'
import * as config from '../config/config'
import { mainHostExtensionApiV1 } from '../extensions/generatedRegistry'
import { AssistantToolResultError } from '../assistantRuntime/toolFailure'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

const { handle, fetchMock } = vi.hoisted(() => ({ handle: vi.fn(), fetchMock: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, on: vi.fn() }, net: {}, webContents: { fromId: vi.fn() }, BrowserWindow: { fromWebContents: vi.fn() } }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn() }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))

const request = { profileId: 'budget-test', messages: [{ role: 'user' as const, content: 'synthetic input' }] }
const event = { sender: { id: 1, getURL: () => 'app://test' }, senderFrame: { url: 'app://test', parent: null } }
const code = 'PROVIDER_JSON_BUDGET_EXCEEDED'
const message = 'Provider request exceeds the size limit. Remove some attachments or send fewer images per message.'

function register() {
  const svcLLMProxy = new LLMProxySvcImpl({ retryModelCapacity: false })
  registerIpcServer({ svcLLMProxy: { chat: llmProxySvcDef.chat } }, { svcLLMProxy: { chat: svcLLMProxy.chat } })
  const callback = handle.mock.calls.find(([name]) => name === 'svcLLMProxy.chat')?.[1]
  if (!callback) throw new Error('chat IPC handler not registered')
  return callback as (ipcEvent: typeof event, chatRequest: typeof request) => Promise<unknown>
}

describe('unary chat budget IPC', () => {
  const initialExtensions = [...mainHostExtensionApiV1.llmProxy]
  beforeEach(() => {
    handle.mockReset()
    fetchMock.mockReset().mockRejectedValue(new Error('Unexpected network attempt'))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(config.getConfig).mockReturnValue({ ...DEFAULT_CONFIG, use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [{ id: 'budget-test', model_name: 'synthetic-model', base_url: 'https://fixture.invalid/v1', api_key: 'synthetic', api_mode: 'chat-completions' }] } })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    mainHostExtensionApiV1.llmProxy.splice(0, mainHostExtensionApiV1.llmProxy.length, ...initialExtensions)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('returns the actual trusted serializer failure through the registered IPC envelope before POST', async () => {
    const real = budget.serializeProviderJsonWithBudget
    const serialize = vi.spyOn(budget, 'serializeProviderJsonWithBudget').mockImplementation(value => real(value, 0))
    const result = await register()(event, request)
    expect(serialize).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, error: { message, code } })
  })

  it('strips a colliding code from an ordinary extension error', async () => {
    mainHostExtensionApiV1.llmProxy.unshift({ id: 'budget-test-extension', handleChatRequest: async () => { throw Object.assign(new Error('synthetic extension failure'), { code }) } })
    const result = await register()(event, request)
    expect(result).toEqual({ ok: false, error: { message: 'synthetic extension failure' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves an assistant tool failure receipt but strips a colliding budget code', async () => {
    mainHostExtensionApiV1.llmProxy.unshift({ id: 'budget-test-receipt', handleChatRequest: async () => { throw new AssistantToolResultError({ message: 'synthetic tool failure', code }, { content: 'synthetic receipt' }) } })
    const result = await register()(event, request)
    expect(result).toEqual({ ok: false, error: { message: 'synthetic tool failure', payload: { kind: 'agent-tool-failure/v1', toolResult: { content: 'synthetic receipt' }, toolHistory: [] } } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
