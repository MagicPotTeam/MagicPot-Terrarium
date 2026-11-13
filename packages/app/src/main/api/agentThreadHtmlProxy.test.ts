import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn(), launch: vi.fn() }))
vi.mock('electron', () => ({ net: {}, webContents: { fromId: mocks.fromId }, BrowserWindow: { fromWebContents: mocks.parent } }))
vi.mock('./agentThreadHtmlRuntime', () => ({ getAgentThreadHtmlRuntime: async () => ({ launch: mocks.launch, assertReady: () => undefined }) }))
vi.mock('./agentThreadHtmlProcess', () => ({ openHtmlProcess: mocks.launch }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
vi.mock('../assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: mocks.listTools, callTool: mocks.callTool }) }))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { cliFromProfile } from '@shared/llm'
import { getConfig } from '../config/config'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'
import { agentThreadHtmlApps } from './agentThreadHtmlApps'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'html-project', threadId: 'pane' } as const
const scope = { route, conversationId: 'html-chat' }, url = 'file:///D:/owned/app/index.html#/canvas?id=html-project'
const invoke = (name: string) => ({ methodName: `svcLLMProxy.${name}`, senderId: 91, frameUrl: url, senderUrl: url, isMainFrame: true })
let sender: EventEmitter, config: typeof DEFAULT_CONFIG
beforeEach(() => {
  vi.clearAllMocks()
  sender = Object.assign(new EventEmitter(), { id: 91, isDestroyed: () => false, getURL: () => url })
  registerMagicAgentTrustedRouteBinding(91, route, { trustedUrl: url, trustedWebContents: sender as never }); mocks.fromId.mockReturnValue(sender); mocks.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  config = structuredClone(DEFAULT_CONFIG); config.project_trace_config.enable_agent_html_apps = true
  config.llm_config.api_profiles = [{ id: 'agent-profile', model_name: 'Agent Model', base_url: 'https://model.example/v1', api_key: 'not-used' }]
  vi.mocked(getConfig).mockReturnValue(config); mocks.listTools.mockReturnValue([])
  mocks.callTool.mockImplementation((r, name, args, options) => options.toolProvider.callTool(name, args, { route: r, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal }))
  mocks.launch.mockImplementation(async (_doc, options) => ({ closed: false, update: vi.fn(), close: vi.fn(async () => { options.onClosed(true); return { confirmed: true } }) }))
})
afterEach(async () => { await agentThreadHtmlApps.dispose(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
describe('HTML show_app through real local chat tool loop (model/OS launcher stubbed)', () => {
  it.each(['chat', 'chatStream'].flatMap(method => [false, true].flatMap(native => [false, true].map(withInfo => ({ method, native, withInfo })))))('prepares via $method native=$native withInfo=$withInfo, opens only on user IPC and detaches only after successful parent', async ({ method, native, withInfo }) => {
    const service = new LLMProxySvcImpl()
    const chat = vi.fn(async (input) => {
      const args = { title: 'Isolated game', html: '<button onclick="kt.send(\'done\',42)">Choose</button>', data: { count: 1 } }
      const call = (name: string, values: Record<string, unknown>, id: string) => {
        if (!native) return JSON.stringify({ toolName: name, args: values })
        const index = input.tools.findIndex((tool: { name: string }) => tool.name === name)
        expect(index).toBeGreaterThanOrEqual(0)
        if (name === 'show_app') expect(JSON.stringify(input.tools[index])).toContain('wait_for')
        expect(input.tools.some((tool: { name: string }) => tool.name === 'shell.execute' || tool.name === 'python.execute')).toBe(false)
        return { content: '', toolCalls: [{ id, name, wireName: `mp_tool_${index}`, arguments: JSON.stringify(values) }] }
      }
      if (withInfo && chat.mock.calls.length === 1) return call('info', { name: 'show_app' }, 'html-info')
      const transcript = JSON.stringify(native ? input.toolTurns : input.messages)
      if (chat.mock.calls.length === (withInfo ? 3 : 2)) {
        expect(transcript).toContain('awaitingUserOpen')
        return 'App document prepared; waiting for you to open it.'
      }
      if (withInfo) {
        for (const text of ['magicpot-local-app-manual/v1', 'declarative-and-html', 'not a readiness check', 'grantsPermission']) expect(transcript).toContain(text)
        expect((await service.listAgentHtmlApps(scope, invoke('listAgentHtmlApps'))).apps).toEqual([])
        expect((await service.listAgentInteractions(scope, invoke('listAgentInteractions'))).interactions).toEqual([])
        expect(mocks.launch).not.toHaveBeenCalled()
      }
      return call('show_app', args, 'html-native')
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: native } as never)
    const req = { ...scope, profileId: 'agent-profile', messages: [{ role: 'user' as const, content: 'Prepare a local app' }] }, onData = vi.fn()
    const result = method === 'chat' ? await service.chat(req, invoke(method)) : await service.chatStream(req, { onData }, invoke(method))
    if (method === 'chat') expect(result).toMatchObject({ content: expect.stringContaining('prepared') })
    else expect(onData).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', content: expect.stringContaining('prepared') }))
    const items = await service.listAgentHtmlApps(scope, invoke('listAgentHtmlApps'))
    expect(items.apps).toHaveLength(1); expect(items.apps[0].status).toBe('ready'); expect(mocks.launch).not.toHaveBeenCalled()
    expect(sender.listenerCount('did-start-navigation')).toBe(1)
    const open = { ...scope, appId: items.apps[0].id, expectedRevision: 1 }
    expect(await service.openAgentHtmlApp(open, invoke('openAgentHtmlApp'))).toMatchObject({ app: { status: 'open' } })
    expect(await service.closeAgentHtmlApp(open, invoke('closeAgentHtmlApp'))).toMatchObject({ app: { status: 'closed' } })
    expect(chat).toHaveBeenCalledTimes(withInfo ? 3 : 2)
    sender.emit('did-start-navigation'); await vi.waitFor(async () => expect((await service.listAgentHtmlApps(scope, invoke('listAgentHtmlApps'))).apps).toEqual([]))
  })
  it.each(['length', 'error'] as const)('does not detach prepared app after parent %s', async ending => {
    const service = new LLMProxySvcImpl(), chat = vi.fn(async () => {
      if (chat.mock.calls.length === 1) return JSON.stringify({ toolName: 'show_app', args: { title: 'HTML', html: '<p>test</p>' } })
      if (ending === 'error') throw new Error('parent failed')
      return { content: 'partial', finishReason: 'length' }
    })
    vi.mocked(cliFromProfile).mockReturnValue({ chat, supportsNativeTools: false } as never)
    await service.chat({ ...scope, profileId: 'agent-profile', messages: [{ role: 'user', content: 'prepare app' }] }, invoke('chat')).catch(() => undefined)
    const items = await service.listAgentHtmlApps(scope, invoke('listAgentHtmlApps'))
    expect(items.apps).toHaveLength(1); expect(items.apps[0].status).toBe('closed'); expect(mocks.launch).not.toHaveBeenCalled()
  })
})
