import React from 'react'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import ChatPage from './ChatPage'
import MagicAgentApprovalCenter from '../../components/MagicAgentApprovalCenter'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import { FIXTURE_PNG, startTeamMockProvider } from '../../../../../../../scripts/chat/teamMockProvider.mjs'

const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn(), config: { value: null as any }, sessions: { value: [] as any[] }, api: { value: null as any }, dir: { value: '' }, profiles: [{ id: 'fixture-profile', model_name: 'fixture-model', model_use: 'chat' }], notify: vi.fn(), update: vi.fn(), configUtils: {} }))
vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en-US', getPath: () => { throw Error('forbidden path') } }, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../../../../main/config/buildEnv', () => ({ getBuildEnv: () => { if (!h.dir.value) throw Error('missing isolated dir'); return { pathMap: { data: h.dir.value, root: h.dir.value } } } }))
vi.mock('../../../../main/config/config', () => ({ getConfig: () => h.config.value, saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock('../../../../main/assistantRuntime/runtime', () => ({ getAssistantRuntime: () => ({ listTools: h.listTools, callTool: h.callTool }) }))
vi.mock('../../../../main/mcp/runtime', () => ({ syncMcpClientManager: vi.fn(async () => undefined) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' }, t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || key }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: h.config.value, isReady: true, buildEnv: DEFAULT_BUILD_ENV, configUtils: h.configUtils, updateConfig: h.update }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifySuccess: h.notify, notifyError: h.notify, notifyWarning: h.notify, notifyInfo: h.notify }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => h.api.value }))
vi.mock('./hooks/useChatProfiles', () => ({ useChatProfiles: () => ({ availableProfiles: h.profiles, remoteProfiles: [] }) }))
vi.mock('./chatStorage', async original => {
  const actual = await original<typeof import('./chatStorage')>()
  return { ...actual,
    compareAndUpdateSessionInDB: vi.fn(async (id: string, _scope: string, options: any) => { const i = h.sessions.value.findIndex(s => s.id === id); if (i < 0 || JSON.stringify(h.sessions.value[i]) !== JSON.stringify(options.expectedSession) || options.shouldUpdate?.(h.sessions.value[i]) === false) return null; const result = structuredClone(options.update(structuredClone(h.sessions.value[i]))); h.sessions.value[i] = result; return structuredClone(result) }),
    loadAllSessions: vi.fn(async () => structuredClone(h.sessions.value)),
    loadSessionFromDB: vi.fn(async (id: string) => structuredClone(h.sessions.value.find(s => s.id === id) ?? null)),
    saveSessionToDB: vi.fn(async (session: any) => { const i = h.sessions.value.findIndex(s => s.id === session.id); if (i < 0) h.sessions.value.push(structuredClone(session)); else h.sessions.value[i] = structuredClone(session) }),
    saveAllSessions: vi.fn(async (sessions: any[]) => { h.sessions.value = structuredClone(sessions) }), migrateFromLocalStorage: vi.fn(async () => null), debouncedSaveSessions: vi.fn(), cancelDebouncedSessionSave: vi.fn(), hasSessionDeleteTombstone: vi.fn(() => false), readSessionDeleteTombstones: vi.fn(() => []), readSessionDraftBackup: vi.fn(), writeSessionDraftBackup: vi.fn(), deleteSessionDraftBackup: vi.fn()
  }
})
vi.mock('./chatRequestUtils', async original => ({ ...(await original<typeof import('./chatRequestUtils')>()), supportsStreamingChatCompletion: () => false }))
vi.mock('./components/ChatComposer', () => ({ default: ({ inputValue, onInputChange, onSend }: any) => <><input data-testid="input" value={inputValue} onChange={e => onInputChange(e.target.value)} /><button onClick={onSend}>send fixture</button></> }))
vi.mock('./components/ChatMessageList', () => ({ default: ({ currentSession }: any) => <pre data-testid="session">{JSON.stringify(currentSession)}</pre> }))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))

it('uses real local HTTP model for team approval and result summary', async () => {
  expect(process.env.NODE_ENV).toBe('test')
  const originalFetch = globalThis.fetch, oldApi = Object.getOwnPropertyDescriptor(window, 'api')
  const oldLocal = Object.entries(localStorage), oldSession = Object.entries(sessionStorage)
  const cleanup: Array<() => void | Promise<void>> = []
  let didFail = false
  let failure: unknown
  try {
  const provider = await startTeamMockProvider()
  cleanup.push(() => provider.close())
  h.dir.value = mkdtempSync(path.join(tmpdir(), 'magicpot-http-team-'))
  cleanup.push(() => rmSync(h.dir.value, { recursive: true, force: true }))
  const requests: any[] = []
  cleanup.push(() => { vi.unstubAllGlobals() })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === FIXTURE_PNG) return originalFetch(input, init)
    if (String(input) !== provider.url) throw Error('fixture network forbidden')
    requests.push(JSON.parse(String(init?.body)))
    return originalFetch(input, init)
  }))
  const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'isolated-fixture', threadId: 'pane' } as const
  const url = 'file:///fixture/index.html#/canvas?id=isolated-fixture'
  const invoke = (service: string, method: string) => ({ methodName: `${service}.${method}`, senderId: 97, isMainFrame: true, senderUrl: url, frameUrl: url })
  const { LLMProxySvcImpl } = await import('../../../../main/api/svcLLMProxyImpl')
  const { MagicAgentPlatformSvcImpl } = await import('../../../../main/api/svcMagicAgentPlatformImpl')
  const { getAgentThreadNotesStore, closeAgentThreadNotesStore } = await import('../../../../main/api/agentThreadNotesStore')
  const { closeAssistantTerminalPolicyRuntime } = await import('../../../../main/magicAgentPlatform2/productionRuntime')
  const { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } = await import('../../../../main/magicAgentRuntime/trustedRouteBinding')
  cleanup.push(() => closeAgentThreadNotesStore())
  cleanup.push(() => closeAssistantTerminalPolicyRuntime())
  cleanup.push(() => clearMagicAgentTrustedRouteBindingsForTest())
  const { getTeamEndStore } = await import('../../../../main/api/teamEndStore')
  h.config.value = structuredClone(DEFAULT_CONFIG); h.config.value.use_remote_llm = false
  h.config.value.llm_config.api_profiles = [{ id: 'fixture-profile', model_name: 'fixture-model', model_use: 'chat', api_mode: 'chat-completions', base_url: provider.url, api_key: 'fixture-only' }]
  const sender = Object.assign(new EventEmitter(), { id: 97, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(97, route, { trustedUrl: url, trustedWebContents: sender as never })
  h.listTools.mockReturnValue([]); h.callTool.mockImplementation(async (r, name, args, options) => options.toolProvider.callTool(name, args, { route: r, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal }))
  const teamStore = getTeamEndStore()
  cleanup.push(() => (teamStore as unknown as { store: { close: () => void } }).store.close())
  const llm = new LLMProxySvcImpl(), platform = new MagicAgentPlatformSvcImpl()
  cleanup.push(() => llm.cancelConversation({ conversationId: 'writer' }, invoke('svcLLMProxy', 'cancelConversation')).then(() => undefined))
  const bridge = { chat: (req: any) => llm.chat(req, invoke('svcLLMProxy', 'chat')), cancelConversation: (req: any) => llm.cancelConversation(req, invoke('svcLLMProxy', 'cancelConversation')) }
  h.api.value = { svcHyper: { saveImageToDir: vi.fn(async () => ({ savedPath: 'fixture-only' })) }, svcLLMProxy: bridge, svcMagicAgentPlatform: { listPendingApprovals: (req: any) => platform.listPendingApprovals(req, invoke('svcMagicAgentPlatform', 'listPendingApprovals')), resolvePendingApproval: (req: any) => platform.resolvePendingApproval(req, invoke('svcMagicAgentPlatform', 'resolvePendingApproval')) }, svcShell: { fileExistsBatch: vi.fn(async () => []) } }
  cleanup.push(() => { if (oldApi) Object.defineProperty(window, 'api', oldApi); else Reflect.deleteProperty(window, 'api') })
  cleanup.push(() => { localStorage.clear(); oldLocal.forEach(([k, v]) => localStorage.setItem(k, v)); sessionStorage.clear(); oldSession.forEach(([k, v]) => sessionStorage.setItem(k, v)) })
  Object.defineProperty(window, 'api', { configurable: true, value: h.api.value }); localStorage.clear(); sessionStorage.clear()
  h.sessions.value = [{ id: 'lead', title: 'Lead', profileId: 'fixture-profile', messages: [], teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false } }, { id: 'designer', title: 'designer', profileId: 'fixture-profile', messages: [], teamLeadId: 'lead', teamMemberName: 'designer', teamRole: '设计师' }, { id: 'writer', title: 'writer', profileId: 'fixture-profile', messages: [], teamLeadId: 'lead', teamMemberName: 'writer', teamRole: '文案' }]
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'isolated-fixture'), 'lead')
  const store = await getAgentThreadNotesStore(), scope = { route, conversationId: 'writer' }, placements: any[] = []
  const onCanvas = (event: Event) => { const detail = (event as CustomEvent).detail; placements.push(detail); detail.onAdded({ id: 'fixture-image', type: 'image' }) }
  cleanup.push(() => window.removeEventListener('canvas:add-image', onCanvas))
  window.addEventListener('canvas:add-image', onCanvas)
  const view = render(<MemoryRouter><ThemeProvider theme={createTheme()}><ChatPage compact storageScope="isolated-fixture" route={route} /><MagicAgentApprovalCenter /></ThemeProvider></MemoryRouter>)
  cleanup.push(() => view.unmount())
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    const send = (text: string) => { fireEvent.change(screen.getByTestId('input'), { target: { value: text } }); fireEvent.click(screen.getByText('send fixture')) }
    send('@designer 设计海报')
    await waitFor(() => expect(placements).toEqual([expect.objectContaining({ src: FIXTURE_PNG, projectId: route.scopeId, generationSessionId: 'designer' })]), { timeout: 8000 })
    await waitFor(() => expect(h.sessions.value.find(s => s.id === 'designer')?.messages.some((m: any) => m.content === '设计结果')).toBe(true))
    send('@writer 保存工作笔记')
    expect(await screen.findByText('writer 想保存一条笔记', {}, { timeout: 8000 })).toBeVisible()
    expect(screen.getByText('approved-value')).toBeVisible()
    expect(store.get(scope)).toMatchObject({ revision: 0, notes: [] })
    const writerRequests = () => requests.filter(body => JSON.stringify(body.messages).includes('保存工作笔记'))
    expect(writerRequests()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => expect(store.get(scope)).toMatchObject({ revision: 1, notes: [{ key: 'fixture', value: 'approved-value' }] }))
    await waitFor(() => expect(h.sessions.value.find(s => s.id === 'writer')?.messages.some((m: any) => m.content === '文案结果')).toBe(true))
    expect(writerRequests()).toHaveLength(2)
    send('汇总团队结果')
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('团队汇总：设计结果和文案结果'))
    const lead = requests.find(body => JSON.stringify(body.messages).includes('汇总团队结果'))
    expect(JSON.stringify(lead.messages)).toContain('设计结果'); expect(JSON.stringify(lead.messages)).toContain('文案结果')
  } catch (error) {
    didFail = true
    failure = error
  }
  const cleanupErrors: unknown[] = []
  for (const dispose of cleanup.reverse()) {
    try { await dispose() } catch (error) { cleanupErrors.push(error) }
  }
  try { vi.resetModules() } catch (error) { cleanupErrors.push(error) }
  if (cleanupErrors.length) throw new AggregateError(didFail ? [failure, ...cleanupErrors] : cleanupErrors, 'Fixture or cleanup failed')
  if (didFail) throw failure
}, 20000)
