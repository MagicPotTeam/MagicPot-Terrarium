import React from 'react'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { cliFromProfile } from '@shared/llm'
import ChatPage from './ChatPage'
import MagicAgentApprovalCenter from '../../components/MagicAgentApprovalCenter'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import type { ChatSession } from './chatStorage'

const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), callTool: vi.fn(), listTools: vi.fn(), config: { value: null as any }, sessions: { value: [] as any[] }, api: { value: null as any }, dir: { value: '' }, profiles: [{ id: 'scratchpad-profile', model_name: 'Fixture', model_use: 'chat' }], notify: vi.fn(), update: vi.fn(), configUtils: {} }))
vi.mock('electron', () => ({ net: {}, app: { getLocale: () => 'en-US', getPath: () => { throw Error('forbidden fixture path') } }, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../../../../main/config/buildEnv', () => ({ getBuildEnv: () => { if (!h.dir.value) throw Error('fixture data path unavailable'); return { pathMap: { data: h.dir.value, root: h.dir.value } } } }))
vi.mock('../../../../main/config/config', () => ({ getConfig: () => h.config.value, saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
vi.mock(import('@shared/llm'), async original => ({ ...(await original()), cliFromProfile: vi.fn() }))
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
    compareAndUpdateSessionInDB: vi.fn(async (id: string, _scope: string, options: any) => {
      const index = h.sessions.value.findIndex(s => s.id === id)
      if (index < 0 || JSON.stringify(h.sessions.value[index]) !== JSON.stringify(options.expectedSession) || options.shouldUpdate?.(h.sessions.value[index]) === false) return null
      const updated = structuredClone(options.update(structuredClone(h.sessions.value[index])))
      h.sessions.value[index] = updated
      return structuredClone(updated)
    }),
    endTeamInDB: vi.fn(async ({ expectedLead }: { expectedLead: ChatSession }) => {
      const lead = { ...expectedLead, teamEnded: true, teamGeneration: (expectedLead.teamGeneration ?? 0) + 1, teamLifecycleRevision: (expectedLead.teamLifecycleRevision ?? 0) + 1 }
      const members = h.sessions.value.filter(s => s.teamLeadId === lead.id).map(s => ({ ...s, teamLifecycleRevision: (s.teamLifecycleRevision ?? 0) + 1, ...(lead.teamSettings?.autoCleanup ? { archived: true } : {}) }))
      h.sessions.value = h.sessions.value.map(s => s.id === lead.id ? lead : members.find(m => m.id === s.id) ?? s)
      return { lead, members }
    }),
    loadAllSessions: vi.fn(async () => structuredClone(h.sessions.value)),
    loadSessionFromDB: vi.fn(async (id: string) => structuredClone(h.sessions.value.find(s => s.id === id) ?? null)),
    saveSessionToDB: vi.fn(async (session: ChatSession) => { const i = h.sessions.value.findIndex(s => s.id === session.id); if (i < 0) h.sessions.value.push(structuredClone(session)); else h.sessions.value[i] = structuredClone(session) }),
    saveAllSessions: vi.fn(async (sessions: ChatSession[]) => { h.sessions.value = structuredClone(sessions) }),
    migrateFromLocalStorage: vi.fn(async () => null),
    debouncedSaveSessions: vi.fn(), cancelDebouncedSessionSave: vi.fn(),
    hasSessionDeleteTombstone: vi.fn(() => false), readSessionDeleteTombstones: vi.fn(() => []),
    readSessionDraftBackup: vi.fn(), writeSessionDraftBackup: vi.fn(), deleteSessionDraftBackup: vi.fn()
  }
})
vi.mock('./chatRequestUtils', async original => ({ ...(await original<typeof import('./chatRequestUtils')>()), supportsStreamingChatCompletion: () => false }))
vi.mock('./components/ChatComposer', () => ({ default: ({ inputValue, onInputChange, onSend, addMenuSlot }: any) => <><ul data-testid="add-menu">{addMenuSlot?.(() => undefined)}</ul><input data-testid="input" value={inputValue} onChange={e => onInputChange(e.target.value)} /><button onClick={onSend}>send fixture</button></> }))
vi.mock('./components/ChatMessageList', () => ({ default: ({ currentSession }: any) => <pre data-testid="session">{JSON.stringify(currentSession)}</pre> }))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'isolated-fixture', threadId: 'pane' } as const
const url = 'file:///fixture/index.html#/canvas?id=isolated-fixture'
const invoke = (service: string, method: string) => ({ methodName: `${service}.${method}`, senderId: 97, isMainFrame: true, senderUrl: url, frameUrl: url })

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const originalLocal = Object.entries(localStorage)
const originalSession = Object.entries(sessionStorage)
let teamStoreOpened = false

afterEach(async () => {
  const { closeAgentThreadNotesStore } = await import('../../../../main/api/agentThreadNotesStore')
  const { closeAssistantTerminalPolicyRuntime } = await import('../../../../main/magicAgentPlatform2/productionRuntime')
  const { clearMagicAgentTrustedRouteBindingsForTest } = await import('../../../../main/magicAgentRuntime/trustedRouteBinding')
  await closeAgentThreadNotesStore(); closeAssistantTerminalPolicyRuntime(); clearMagicAgentTrustedRouteBindingsForTest()
  if (teamStoreOpened) {
    const { getTeamEndStore } = await import('../../../../main/api/teamEndStore')
    ;(getTeamEndStore() as unknown as { store: { close: () => void } }).store.close()
  }
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
  localStorage.clear(); originalLocal.forEach(([key, value]) => localStorage.setItem(key, value))
  sessionStorage.clear(); originalSession.forEach(([key, value]) => sessionStorage.setItem(key, value))
  vi.unstubAllGlobals()
  if (h.dir.value) rmSync(h.dir.value, { recursive: true, force: true })
  teamStoreOpened = false
  vi.resetModules()
})

it.each(['approve', 'end', 'deny'] as const)('two members with real MAIN scratchpad approval (decision: %s)', async decision => {
  const endWhilePending = decision === 'end'
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { if (input === 'data:image/png;base64,QQ==') return originalFetch(input, init); throw new Error('network forbidden in fixture') }))
  h.dir.value = mkdtempSync(path.join(tmpdir(), 'magicpot-cross-layer-'))
  expect(process.env.NODE_ENV).toBe('test')
  const { LLMProxySvcImpl } = await import('../../../../main/api/svcLLMProxyImpl')
  const { MagicAgentPlatformSvcImpl } = await import('../../../../main/api/svcMagicAgentPlatformImpl')
  const { getAgentThreadNotesStore } = await import('../../../../main/api/agentThreadNotesStore')
  const { registerMagicAgentTrustedRouteBinding } = await import('../../../../main/magicAgentRuntime/trustedRouteBinding')
  h.config.value = structuredClone(DEFAULT_CONFIG)
  h.config.value.use_remote_llm = false
  h.config.value.llm_config.api_profiles = [{ id: 'scratchpad-profile', model_name: 'Fixture', base_url: 'https://model.invalid/v1', api_key: 'fixture' }]
  const sender = Object.assign(new EventEmitter(), { id: 97, isDestroyed: () => false, getURL: () => url })
  h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(97, route, { trustedUrl: url, trustedWebContents: sender as never })
  h.listTools.mockReturnValue([])
  h.callTool.mockImplementation(async (r, name, args, options) => options.toolProvider.callTool(name, args, { route: r, runId: options.runId, toolCallId: options.toolCallId, signal: options.signal }))
  const image = 'data:image/png;base64,QQ=='
  const model = vi.fn(async (input: any) => {
    if (input.conversationId === 'designer') return { content: '设计结果', attachments: [{ type: 'image', url: image, mimeType: 'image/png' }] }
    if (input.conversationId === 'writer') return model.mock.calls.filter(([call]) => call.conversationId === 'writer').length === 1 ? JSON.stringify({ toolName: 'scratchpad', args: { action: 'set', key: 'fixture', value: 'approved-value', expectedRevision: 0 } }) : '文案结果'
    if (input.conversationId === 'lead') return '团队汇总'
    throw Error(`unexpected model conversation: ${input.conversationId}`)
  })
  vi.mocked(cliFromProfile).mockReturnValue({ chat: model, supportsNativeTools: false } as never)
  const { getTeamEndStore } = await import('../../../../main/api/teamEndStore')
  getTeamEndStore(); teamStoreOpened = true
  const llm = new LLMProxySvcImpl(), platform = new MagicAgentPlatformSvcImpl()
  let writerOutcome: Promise<'fulfilled' | 'rejected'> | undefined
  const bridge = { endTeam: (req: any) => llm.endTeam(req), chat: (req: any) => {
    const pending = llm.chat(req, invoke('svcLLMProxy', 'chat'))
    if (req.conversationId === 'writer') writerOutcome = pending.then(() => 'fulfilled', () => 'rejected')
    return pending
  }, cancelConversation: (req: any) => llm.cancelConversation(req, invoke('svcLLMProxy', 'cancelConversation')) }
  h.api.value = { svcHyper: { saveImageToDir: vi.fn(async () => ({ savedPath: 'fixture-only' })) }, svcLLMProxy: bridge, svcMagicAgentPlatform: { listPendingApprovals: (req: any) => platform.listPendingApprovals(req, invoke('svcMagicAgentPlatform', 'listPendingApprovals')), resolvePendingApproval: (req: any) => platform.resolvePendingApproval(req, invoke('svcMagicAgentPlatform', 'resolvePendingApproval')) }, svcShell: { fileExistsBatch: vi.fn(async () => []) } }
  Object.defineProperty(window, 'api', { configurable: true, value: h.api.value })
  localStorage.clear(); sessionStorage.clear()
  h.sessions.value = [{ id: 'lead', title: 'Lead', profileId: 'scratchpad-profile', messages: [], teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: endWhilePending } }, { id: 'designer', title: 'designer', profileId: 'scratchpad-profile', messages: [], teamLeadId: 'lead', teamMemberName: 'designer', teamRole: '设计师' }, { id: 'writer', title: 'writer', profileId: 'scratchpad-profile', messages: [], teamLeadId: 'lead', teamMemberName: 'writer', teamRole: '文案' }]
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'isolated-fixture'), 'lead')
  const store = await getAgentThreadNotesStore(), scope = { route, conversationId: 'writer' }
  const placements: any[] = []
  const onCanvas = (event: Event) => { const detail = (event as CustomEvent).detail; placements.push(detail); detail.onAdded({ id: 'fixture-image', type: 'image' }) }
  window.addEventListener('canvas:add-image', onCanvas)
  const view = render(<MemoryRouter><ThemeProvider theme={createTheme()}><ChatPage compact storageScope="isolated-fixture" route={route} /><MagicAgentApprovalCenter /></ThemeProvider></MemoryRouter>)
  try {
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('lead'))
    const send = (text: string) => { fireEvent.change(screen.getByTestId('input'), { target: { value: text } }); fireEvent.click(screen.getByText('send fixture')) }
    send('@designer 设计海报')
    await waitFor(() => expect(placements).toEqual([expect.objectContaining({ src: image, projectId: route.scopeId, generationSessionId: 'designer' })]), { timeout: 6000 })
    await waitFor(() => expect(h.sessions.value.find(s => s.id === 'designer')?.messages.some((m: any) => m.content === '设计结果')).toBe(true))
    send('@writer 保存工作笔记')
    expect(await screen.findByText('writer 想保存一条笔记', {}, { timeout: 6000 })).toBeVisible()
    expect(screen.getByText('approved-value')).toBeVisible()
    expect(store.get(scope)).toMatchObject({ revision: 0, notes: [] })
    expect(model.mock.calls.filter(([call]) => call.conversationId === 'writer')).toHaveLength(1)
    if (decision === 'deny') {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
        expect(await writerOutcome).toBe('rejected')
      })
      await waitFor(() => expect(screen.queryByText('writer 想保存一条笔记')).not.toBeInTheDocument())
      expect(store.get(scope)).toMatchObject({ revision: 0, notes: [] })
      expect(model.mock.calls.filter(([call]) => call.conversationId === 'writer')).toHaveLength(1)
      expect(h.sessions.value.find(s => s.id === 'writer')?.messages.some((m: any) => m.content === '文案结果')).toBe(false)
      return
    }
    if (endWhilePending) {
      const area = await screen.findByRole('region', { name: '进程区' })
      fireEvent.click(screen.getByTestId('chat-composer-menu-team'))
      const management = await screen.findByRole('dialog', { name: '团队管理' })
      fireEvent.click(within(management).getByRole('button', { name: '结束团队' }))
      await waitFor(() => expect(h.sessions.value.find(s => s.id === 'lead')?.teamEnded).toBe(true))
      expect(store.get(scope)).toMatchObject({ revision: 0, notes: [] })
      expect(model.mock.calls.filter(([call]) => call.conversationId === 'writer')).toHaveLength(1)
      expect(await screen.findByRole('dialog')).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: '允许这次操作' }))
    } else fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => expect(store.get(scope)).toMatchObject({ revision: 1, notes: [{ key: 'fixture', value: 'approved-value' }] }))
    await waitFor(() => expect(h.sessions.value.find(s => s.id === 'writer')?.messages.some((m: any) => m.content === '文案结果')).toBe(true))
    if (endWhilePending) return
    send('汇总团队结果')
    await waitFor(() => expect(model.mock.calls.some(([call]) => call.conversationId === 'lead')).toBe(true))
    const leadCall = model.mock.calls.find(([call]) => call.conversationId === 'lead')![0]
    expect(JSON.stringify(leadCall.messages)).toContain('设计结果')
    expect(JSON.stringify(leadCall.messages)).toContain('文案结果')
    await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent('团队汇总'))
  } finally { window.removeEventListener('canvas:add-image', onCanvas); view.unmount(); await llm.cancelConversation({ conversationId: 'writer' }, invoke('svcLLMProxy', 'cancelConversation')) }
}, 15000)
