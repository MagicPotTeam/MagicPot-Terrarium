import React, { StrictMode, Suspense } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { HashRouter, MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { ChatSession, ChatSessionDraftBackupRecord, ExistingSessionSummaryResult } from './chatStorage'
import { createExistingConversationOpenCoordinator, type ExistingConversationProtection } from '@renderer/utils/existingConversationOpen'
import type { ExistingConversationOpenInput } from './useExistingConversationOpen'
import ChatPage from './ChatPage'
import AgentWorkspace from '@renderer/components/AgentWorkspace'
import Layout from '@renderer/components/Layout'
import layoutSlice, { closeRightPanel, closeTab, toggleBottomPanelMaximized, type LayoutState } from '@renderer/store/slices/layoutSlice'
import { existingConversationOpenStore as sharedOpen } from '@renderer/utils/existingConversationOpenStore'
import type { ExistingConversationWorkspaceAdapter } from '@renderer/components/existingConversationWorkspace'
import { PROJECTS_STORAGE_KEY } from '../MainPage/projectStore'
import { buildChatWorkspaceControlsPortalId, scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'

const f = vi.hoisted(() => ({
  load: vi.fn<(scope: string) => Promise<ChatSession[]>>(),
  summary: vi.fn<(scopes: readonly string[], signal?: AbortSignal) => Promise<ExistingSessionSummaryResult>>(),
  create: vi.fn(),
  backup: vi.fn<(id: string, scope: string) => ChatSessionDraftBackupRecord | undefined>(),
  host: vi.fn(),
  network: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  realMainArea: false,
  states: [] as Array<{ scope: string; id: string | null; draft?: string }>
}))
const config = { ...DEFAULT_CONFIG, use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [] }, custom_skills: [] }
vi.mock('@renderer/store', async () => { const redux = await import('react-redux'); return { useAppDispatch: redux.useDispatch, useAppSelector: redux.useSelector } })
vi.mock('@renderer/components/TitleBar', () => ({ default: () => null }))
vi.mock('@renderer/components/ActivityBar', () => ({ default: () => null }))
vi.mock('@renderer/components/SidePanel', () => ({ default: () => null }))
vi.mock('@renderer/components/BottomPanel', () => ({ default: () => null }))
vi.mock('@renderer/components/MainArea', async original => {
  const actual = await original<typeof import('@renderer/components/MainArea')>()
  return { default: function FixtureMainArea() {
    const location = useLocation(), navigate = useNavigate()
    if (f.realMainArea) return <actual.default />
    return <main><pre data-testid="fixture-route">{location.pathname + location.search}</pre><button onClick={() => navigate('/settings')}>Leave Open project</button><button onClick={() => navigate('/agent-management')}>Return to management</button></main>
  } }
})
vi.mock('../MainPage/MainPage', () => ({ default: () => <main>Fixture home</main> }))
vi.mock('../ProjectCanvasPage/ProjectCanvasPage', () => ({ default: () => <main>Fixture project canvas</main> }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en', resolvedLanguage: 'en' }, t: (key: string) => key }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config, isReady: true, buildEnv: { ...DEFAULT_BUILD_ENV, pathMap: { ...DEFAULT_BUILD_ENV.pathMap, data: '' } }, configUtils: {}, updateConfig: vi.fn() }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifySuccess: vi.fn(), notifyInfo: vi.fn(), notifyError: f.error, notifyWarning: f.warning }) }))
vi.mock('./hooks/useChatProfiles', () => ({ useChatProfiles: () => ({ availableProfiles: [{ id: 'fixture', name: 'Fixture', model: 'fixture', call_type: 'chat', api_key: '', base_url: '' }] }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => { f.host(); return { svcFs: {}, svcLLMProxy: {}, svcHyper: {}, svcManagedMedia: {} } } }))
vi.mock('./chatSessionUtils', async (original) => {
  const actual = await original<typeof import('./chatSessionUtils')>()
  return { ...actual, createChatSession: (...args: Parameters<typeof actual.createChatSession>) => { f.create(...args); return actual.createChatSession(...args) } }
})
vi.mock('./chatStorage', async (original) => {
  const actual = await original<typeof import('./chatStorage')>()
  return {
    ...actual,
    loadAllSessions: (scope: string) => f.load(scope),
    readExistingSessionSummaries: (scopes: readonly string[], signal?: AbortSignal) => f.summary(scopes, signal),
    compareAndUpdateSessionInDB: vi.fn(async () => {}),
    debouncedSaveSessions: vi.fn(), cancelDebouncedSessionSave: vi.fn(),
    deleteSessionFromDB: vi.fn(async () => {}),
    readSessionDraftBackup: (id: string, scope: string) => f.backup(id, scope),
    writeSessionDraftBackup: vi.fn(), deleteSessionDraftBackup: vi.fn(),
    readSessionDeleteTombstones: () => [], hasSessionDeleteTombstone: () => false
  }
})
vi.mock('@renderer/features/projectTrace/projectTraceCapture', () => ({ finalizeActiveProjectTraceCapture: vi.fn() }))
vi.mock('@renderer/features/projectTrace/ProjectTraceManagerPanel', () => ({ default: () => null }))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatComposer', () => ({ default: () => <div data-testid="composer" /> }))
vi.mock('./components/ChatMessageList', () => ({ default: ({ currentSession }: { currentSession?: ChatSession }) => {
  f.states.push({ scope: currentSession?.storageScope ?? '', id: currentSession?.id ?? null, draft: currentSession?.draft?.inputValue })
  return <pre data-testid="selected">{currentSession?.id ?? 'none'}</pre>
} }))

const scope = 'tab-project-p.agent-1'
const theme = createTheme()
const existing = (id = 'other'): ChatSession => ({ id, title: id, messages: [], storageScope: scope, profileId: 'fixture' })
const selected = () => screen.getByTestId('selected').textContent
function page(protection?: ExistingConversationProtection, options: { active?: boolean; strict?: boolean; scope?: string; open?: ExistingConversationOpenInput } = {}) {
  const currentScope = options.scope ?? scope
  const content = <ThemeProvider theme={theme}><MemoryRouter><div id={buildChatWorkspaceControlsPortalId(currentScope)} /><ChatPage storageScope={currentScope} active={options.active ?? true} acceptExternalInput={options.active ?? true} existingConversationProtection={protection} existingConversationOpen={options.open} /></MemoryRouter></ThemeProvider>
  return options.strict ? <StrictMode>{content}</StrictMode> : content
}
async function settled() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }) }
beforeEach(() => {
  vi.clearAllMocks(); f.realMainArea = false; f.load.mockReset().mockResolvedValue([]); f.summary.mockReset().mockResolvedValue({ status: 'ready', sessions: [] }); f.backup.mockReset().mockReturnValue(undefined); f.states = []
  localStorage.clear(); sessionStorage.clear()
  vi.stubGlobal('fetch', f.network.mockRejectedValue(new Error('Network prohibited by fixture')))
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterEach(async () => { cleanup(); const state = sharedOpen.getSnapshot(); if (state.request) sharedOpen.cancel(state.request.handle); for (const visit of sharedOpen.getSnapshot().visits) sharedOpen.depart(visit); vi.useRealTimers(); await settled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

const target = { projectId: 'tab-project-p', paneId: 'agent-1', storageScope: scope, sessionId: 'target' }
async function openInput(validate = vi.fn(async () => true)) {
  const coordinator = createExistingConversationOpenCoordinator({ validate })
  const handle = coordinator.start(target)!
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const visible = vi.fn(() => true)
  const presentation = coordinator.attachPresentation(handle, visible)!
  const pane = coordinator.attachPane(presentation, () => true)!
  expect(pane).not.toBeNull()
  return { coordinator, input: { coordinator, handle, pane }, visible, validate }
}

describe('actual ChatPage correlated post-request Open adapter, no Layout/UI caller', () => {
  const protection = { storageScope: scope, isProtected: () => true }
  it('loads after request/consumer binding and succeeds only after the exact existing selection is committed', async () => {
    f.load.mockResolvedValue([existing('other'), existing('target')])
    const { coordinator, input, validate } = await openInput()
    render(page(protection, { open: input }))
    await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('succeeded'))
    expect(selected()).toBe('target'); expect(f.load.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(validate).toHaveBeenCalledTimes(3); expect(f.create).not.toHaveBeenCalled()
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
  })
  it('does not acknowledge at selection or ref update before final persisted validation completes', async () => {
    let accept!: (value: boolean) => void
    const validate = vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise((resolve) => { accept = resolve }))
    const { coordinator, input } = await openInput(validate)
    f.load.mockResolvedValue([existing('target')]); render(page(protection, { open: input }))
    await waitFor(() => expect(selected()).toBe('target'))
    expect(coordinator.getSnapshot().result).toBeNull()
    await act(async () => accept(true)); await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('succeeded'))
  })
  it.each(['missing', 'failed'] as const)('rejects a post-request %s load and does not create or choose another conversation', async (failure) => {
    const { coordinator, input } = await openInput()
    f.load.mockResolvedValueOnce([existing('target')])
    if (failure === 'failed') f.load.mockRejectedValue(new Error('Fixture denied'))
    else f.load.mockResolvedValue([existing('other')])
    render(page(protection, { open: input }))
    await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('rejected'))
    expect(f.create).not.toHaveBeenCalled(); expect(selected()).toBe('none')
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
  })
  it('invalidates pending selection validation when a newer preview read replaces the current load', async () => {
    let accept!: (value: boolean) => void
    const validate = vi.fn(async () => true).mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise((resolve) => { accept = resolve }))
    const { coordinator, input } = await openInput(validate)
    f.load.mockResolvedValue([existing('target')]); render(page(protection, { open: input }))
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(2))
    f.load.mockResolvedValue([existing('other')])
    await act(async () => { window.dispatchEvent(new CustomEvent('chat:preview-refresh', { detail: { scope } })); accept(true) })
    await settled(); expect(coordinator.getSnapshot().result?.status).not.toBe('succeeded')
    expect(selected()).toBe('none'); expect(f.create).not.toHaveBeenCalled()
  })
  it('StrictMode replacement ignores old consumers and still opens only the exact target', async () => {
    const { coordinator, input } = await openInput(); f.load.mockResolvedValue([existing('target')])
    render(page(protection, { open: input, strict: true }))
    await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('succeeded'))
    expect(selected()).toBe('target'); expect(f.create).not.toHaveBeenCalled()
  })
  it.each(['tombstone', 'storage-denied'] as const)('refuses a fresh %s while persisted selection validation is pending', async (failure) => {
    let accept!: (value: boolean) => void
    const validate = vi.fn(async () => true).mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => { accept = resolve }))
    const { coordinator, input } = await openInput(validate)
    f.load.mockResolvedValue([existing('target')]); render(page(protection, { open: input }))
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(2))
    const key = `magicpot-chat-delete-tombstone:${encodeURIComponent(scope)}:target`
    let spy: ReturnType<typeof vi.spyOn> | undefined
    if (failure === 'tombstone') localStorage.setItem(key, '')
    else {
      const original = Storage.prototype.getItem
      spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, requested: string) {
        if (requested === key) throw new Error('Storage denied by fixture')
        return original.call(this, requested)
      })
    }
    try {
      await act(async () => accept(true))
      await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('rejected'))
      expect(selected()).toBe('none'); expect(f.create).not.toHaveBeenCalled()
      expect(coordinator.isGuarded(target.projectId)).toBe(true)
    } finally { spy?.mockRestore() }
  })
  it('does not persist the old target into a new scope from an interrupted uncommitted ChatPage render', async () => {
    let accept!: (value: boolean) => void
    const validate = vi.fn(async () => true).mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => { accept = resolve }))
    const { coordinator, input } = await openInput(validate)
    f.load.mockResolvedValue([existing('target')])
    const never = new Promise<void>(() => {}); const attempted = vi.fn()
    function Blocker({ pending }: { pending: boolean }) { if (pending) { attempted(); throw never } return null }
    function content(pending: boolean) {
      const nextScope = pending ? 'other.project-pane' : scope
      return <ThemeProvider theme={theme}><MemoryRouter><Suspense fallback={<div>Waiting</div>}><ChatPage storageScope={nextScope} existingConversationProtection={{ storageScope: nextScope, isProtected: () => true }} existingConversationOpen={input} /><Blocker pending={pending} /></Suspense></MemoryRouter></ThemeProvider>
    }
    const rendered = render(content(false))
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(2))
    await act(async () => { React.startTransition(() => rendered.rerender(content(true))) })
    expect(attempted).toHaveBeenCalled()
    await act(async () => accept(true))
    expect(localStorage.getItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'other.project-pane'))).toBeNull()
    expect(localStorage.getItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope))).toBe('target')
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
  })
  it('recovers normal loading after deactivation invalidates initial and Open reads without creating a fallback', async () => {
    const { coordinator, input } = await openInput()
    const reads: Array<(sessions: ChatSession[]) => void> = []
    f.load.mockImplementation(() => new Promise((resolve) => reads.push(resolve)))
    const rendered = render(page(protection, { open: input }))
    await waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(2))
    rendered.rerender(page(protection, { open: input, active: false }))
    await act(async () => { for (const done of reads) done([existing('target')]) })
    expect(coordinator.getSnapshot().result?.status).toBe('rejected')
    const oldCount = f.load.mock.calls.length
    f.load.mockResolvedValue([existing('target')])
    rendered.rerender(page(protection, { open: input, active: true }))
    await waitFor(() => expect(f.load.mock.calls.length).toBeGreaterThan(oldCount))
    rendered.rerender(page())
    await waitFor(() => expect(selected()).toBe('target'))
    expect(f.create).not.toHaveBeenCalled()
  })
  it('does not select or acknowledge after request cancellation or real unmount while its load is pending', async () => {
    const { coordinator, input } = await openInput(); const reads: Array<(sessions: ChatSession[]) => void> = []
    f.load.mockImplementation(() => new Promise((resolve) => reads.push(resolve)))
    const rendered = render(page(protection, { open: input }))
    await waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(2))
    await act(async () => { coordinator.cancel(input.handle); rendered.unmount(); for (const done of reads) done([existing('target')]) })
    expect(coordinator.getSnapshot().result?.status).toBe('rejected'); expect(f.create).not.toHaveBeenCalled()
  })
})

describe('actual Workspace and ChatPage combined handoff, injected Layout presentation and fixture storage only', () => {
  const siblingScope = 'tab-project-p.agent-2'
  const paneKey = `agent.workspace.${target.projectId}`
  function workspace(adapter: ExistingConversationWorkspaceAdapter, strict = false) {
    const content = <ThemeProvider theme={theme}><MemoryRouter><AgentWorkspace projectId={target.projectId} existingConversationOpen={adapter} /></MemoryRouter></ThemeProvider>
    return strict ? <StrictMode>{content}</StrictMode> : content
  }
  const inPane = (paneScope: string) => document.querySelector(`[data-agent-workspace-scope="${paneScope}"] [data-testid="selected"]`)?.textContent
  async function setup(validate = vi.fn(async () => true)) {
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([{ id: target.projectId, name: 'Existing', chatStorageScopePrefix: target.projectId }]))
    localStorage.setItem(paneKey, '[{"id":"agent-1","enabled":true},{"id":"agent-2","enabled":true}]')
    localStorage.setItem(`agent.workspace.active.${target.projectId}`, 'agent-2')
    f.load.mockImplementation(async loadedScope => loadedScope === scope ? [existing('other'), existing('target')] : [])
    const coordinator = createExistingConversationOpenCoordinator({ validate })
    const handle = coordinator.start(target)!
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const presentation = coordinator.attachPresentation(handle, () => true)!
    return { coordinator, handle, adapter: { coordinator, request: { handle, presentation } } }
  }
  it.each([false, true])('commits exact target and retains every hidden empty sibling after success and request prop removal, StrictMode=%s', async strict => {
    const { coordinator, adapter } = await setup()
    const rendered = render(workspace(adapter, strict))
    await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('succeeded'))
    expect(inPane(scope)).toBe('target'); expect(inPane(siblingScope)).toBe('none')
    expect(f.create).not.toHaveBeenCalled(); expect(coordinator.isGuarded(target.projectId)).toBe(true)
    rendered.rerender(workspace({ coordinator }, strict))
    await settled()
    expect(inPane(scope)).toBe('target'); expect(inPane(siblingScope)).toBe('none')
    expect(f.create).not.toHaveBeenCalled(); expect(f.network).not.toHaveBeenCalled()
  })
  it('missing target is rejected without choosing latest or auto-creating hidden empty siblings after request removal', async () => {
    const { coordinator, adapter } = await setup()
    f.load.mockImplementation(async loadedScope => loadedScope === scope ? [existing('other')] : [])
    const rendered = render(workspace(adapter))
    await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('rejected'))
    rendered.rerender(workspace({ coordinator })); await settled()
    expect(inPane(scope)).toBe('none'); expect(inPane(siblingScope)).toBe('none')
    expect(f.create).not.toHaveBeenCalled(); expect(coordinator.isGuarded(target.projectId)).toBe(true)
  })
  it.each(['different-pane', 'trace', 'disabled', 'unmount'] as const)('refuses late final validation after actual Workspace %s change', async change => {
    let finish!: (value: boolean) => void
    const validate = vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { coordinator, handle, adapter } = await setup(validate)
    const rendered = render(workspace(adapter))
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(3))
    expect(inPane(scope)).toBe('target'); expect(coordinator.getSnapshot().result).toBeNull()
    if (change === 'different-pane') document.querySelector<HTMLElement>(`[data-agent-workspace-scope="${siblingScope}"][role="button"]`)!.click()
    if (change === 'trace') screen.getByTestId('agent-workspace-trace-button').click()
    if (change === 'disabled') localStorage.setItem(paneKey, '[{"id":"agent-1","enabled":false},{"id":"agent-2","enabled":true}]')
    if (change === 'unmount') rendered.unmount()
    await act(async () => finish(true)); await settled()
    expect(coordinator.getSnapshot().result?.status).not.toBe('succeeded')
    expect(f.create).not.toHaveBeenCalled(); expect(coordinator.isGuarded(target.projectId)).toBe(true)
    coordinator.cancel(handle)
  })
})

describe('actual Layout → Workspace → ChatPage renderer chain, real transient coordinator/validator with stub storage only', () => {
  const siblingScope = `${target.projectId}.agent-2`
  const paneKey = `agent.workspace.${target.projectId}`
  const row = { storageScope: scope, sessionId: target.sessionId, title: 'Target', titleTruncated: false }
  const inPane = (paneScope: string) => document.querySelector(`[data-agent-workspace-scope="${paneScope}"] [data-testid="selected"]`)?.textContent
  function mountLayout(strict = false) {
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([{ id: target.projectId, name: 'Existing', chatStorageScopePrefix: target.projectId }]))
    localStorage.setItem(paneKey, '[{"id":"agent-1","enabled":true},{"id":"agent-2","enabled":true}]')
    localStorage.setItem(`agent.workspace.active.${target.projectId}`, 'agent-2')
    f.load.mockImplementation(async loadedScope => loadedScope === scope ? [existing('other'), existing('target')] : [])
    f.summary.mockResolvedValue({ status: 'ready', sessions: [row] })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    window.history.replaceState(null, '', '/#/agent-management')
    const state: LayoutState = { ...layoutSlice.getInitialState(), activeSidePanel: null, rightPanelVisible: false, bottomPanelVisible: true, bottomPanelMaximized: true, openTabs: [{ id: target.projectId, label: 'Existing', routePath: `/canvas?id=${target.projectId}`, closable: true }, { id: 'tab-agent-management', label: 'Management', routePath: '/agent-management', closable: true }], activeTabId: 'tab-agent-management', lastActiveProjectId: target.projectId, lastRoutePath: '/agent-management', startupRestorePending: false, startupRestoreSnapshot: null }
    const store = configureStore({ reducer: { layout: layoutSlice.reducer }, preloadedState: { layout: state } })
    const content = <ThemeProvider theme={theme}><Provider store={store}><HashRouter><Layout /></HashRouter></Provider></ThemeProvider>
    const rendered = render(strict ? <StrictMode>{content}</StrictMode> : content)
    return { store, rendered }
  }
  const feedback = () => screen.getByRole('region', { name: 'Existing conversation Open' })
  async function managementRow() {
    await screen.findByRole('heading', { name: 'Agent management' })
    fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
    await screen.findByText('Target')
    return within(screen.getByText('Target').closest('li')!).getByRole('button', { name: 'Open existing conversation' })
  }
  it.each([false, true])('actual MainArea management click unmounts the real source and acknowledges only the selected visible exact owner, StrictMode=%s', async strict => {
    f.realMainArea = true
    const { store } = mountLayout(strict)
    await screen.findByRole('heading', { name: 'Agent management' })
    expect(f.summary).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled()
    const button = await managementRow()
    let preflight!: (value: ExistingSessionSummaryResult) => void
    f.summary.mockImplementationOnce(() => new Promise(resolve => { preflight = resolve }))
    fireEvent.click(button)
    const handle = sharedOpen.getSnapshot().request!.handle
    expect(handle.target).toEqual(target); expect(sharedOpen.isGuarded(target.projectId)).toBe(true)
    expect(feedback()).toHaveTextContent('Opening existing conversation')
    expect(f.load).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Agent management' })).toBeVisible()
    await act(async () => preflight({ status: 'ready', sessions: [row] }))
    await waitFor(() => expect(sharedOpen.getSnapshot().result?.status).toBe('succeeded'))
    expect(sharedOpen.getSnapshot().result?.handle).toBe(handle)
    expect(screen.queryByRole('heading', { name: 'Agent management' })).toBeNull()
    expect(screen.getByText('Fixture project canvas')).toBeVisible()
    expect(window.location.hash).toBe(`#/canvas?id=${target.projectId}`)
    expect(store.getState().layout.activeTabId).toBe(target.projectId)
    expect(inPane(scope)).toBe('target'); expect(inPane(siblingScope)).toBe('none')
    expect(feedback()).toHaveTextContent('Existing conversation opened')
    expect(f.summary).toHaveBeenCalledTimes(4); expect(f.create).not.toHaveBeenCalled(); expect(f.network).not.toHaveBeenCalled()
    fireEvent.click(within(feedback()).getByRole('button', { name: 'Dismiss Open result' }))
    expect(screen.queryByRole('region', { name: 'Existing conversation Open' })).toBeNull()
    expect(sharedOpen.isGuarded(target.projectId)).toBe(true); expect(inPane(siblingScope)).toBe('none'); expect(f.create).not.toHaveBeenCalled()
  })
  it.each(['missing-tab', 'disabled', 'deleted', 'missing-session', 'load-failed', 'cancel'] as const)('actual MainArea management UI rejects %s without creating tabs/panes/conversations or acknowledging a different session', async failure => {
    f.realMainArea = true
    const { store } = mountLayout()
    const button = await managementRow()
    if (failure === 'missing-tab') await act(async () => { store.dispatch(closeTab(target.projectId)) })
    if (failure === 'disabled') localStorage.setItem(paneKey, '[{"id":"agent-1","enabled":false},{"id":"agent-2","enabled":true}]')
    if (failure === 'deleted') localStorage.setItem(`magicpot-chat-delete-tombstone:${encodeURIComponent(scope)}:target`, '')
    if (failure === 'missing-session') f.summary.mockResolvedValue({ status: 'ready', sessions: [] })
    if (failure === 'load-failed') f.load.mockImplementation(async loadedScope => { if (loadedScope === scope) throw new Error('fixture failed load'); return [] })
    let late!: (value: ExistingSessionSummaryResult) => void
    if (failure === 'cancel') f.summary.mockImplementationOnce(() => new Promise(resolve => { late = resolve }))
    const tabs = store.getState().layout.openTabs
    const panes = localStorage.getItem(paneKey)
    fireEvent.click(button)
    const handle = sharedOpen.getSnapshot().request?.handle ?? sharedOpen.getSnapshot().result!.handle
    if (failure === 'cancel') {
      fireEvent.click(within(feedback()).getByRole('button', { name: 'Cancel Open' }))
      await act(async () => late({ status: 'ready', sessions: [row] }))
    }
    await waitFor(() => expect(sharedOpen.getSnapshot().request).toBeNull())
    expect(sharedOpen.getSnapshot().result?.status).toBe('rejected'); expect(sharedOpen.getSnapshot().result?.handle).toBe(handle)
    expect(feedback()).toHaveTextContent('Existing conversation could not be opened')
    expect(store.getState().layout.openTabs).toEqual(tabs); expect(localStorage.getItem(paneKey)).toBe(panes)
    if (failure !== 'load-failed') expect(f.load).not.toHaveBeenCalled()
    if (failure !== 'load-failed') expect(screen.getByRole('heading', { name: 'Agent management' })).toBeVisible()
    else { expect(inPane(scope)).toBe('none'); expect(inPane(siblingScope)).toBe('none') }
    expect(f.states.some(state => state.id === 'other')).toBe(false)
    if (failure !== 'missing-tab') expect(sharedOpen.isGuarded(target.projectId)).toBe(true)
    expect(f.create).not.toHaveBeenCalled(); expect(f.network).not.toHaveBeenCalled()
  })
  it.each([false, true])('opens the exact existing selection only after real Layout/pane/load/commit acknowledgments, StrictMode=%s', async strict => {
    const { store } = mountLayout(strict)
    expect(f.summary).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled()
    await act(async () => { sharedOpen.start(target) })
    await waitFor(() => expect(sharedOpen.getSnapshot().result?.status).toBe('succeeded'))
    expect(screen.getByTestId('fixture-route')).toHaveTextContent(`/canvas?id=${target.projectId}`)
    expect(store.getState().layout.activeTabId).toBe(target.projectId)
    expect(store.getState().layout.rightPanelVisible).toBe(true); expect(store.getState().layout.bottomPanelMaximized).toBe(false)
    expect(inPane(scope)).toBe('target'); expect(inPane(siblingScope)).toBe('none')
    expect(f.summary).toHaveBeenCalledTimes(3); expect(f.create).not.toHaveBeenCalled(); expect(f.network).not.toHaveBeenCalled()
    expect(sharedOpen.isGuarded(target.projectId)).toBe(true)
  })
  it('waits for actual document visibility before selection and keeps empty siblings protected while hidden', async () => {
    mountLayout()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); sharedOpen.start(target) })
    await waitFor(() => expect(f.load).toHaveBeenCalled())
    expect(inPane(scope)).toBe('none'); expect(inPane(siblingScope)).toBe('none')
    expect(f.summary).toHaveBeenCalledTimes(1); expect(sharedOpen.getSnapshot().result).toBeNull()
    expect(f.create).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(sharedOpen.getSnapshot().result?.status).toBe('succeeded'))
    expect(inPane(scope)).toBe('target'); expect(inPane(siblingScope)).toBe('none')
    expect(f.create).not.toHaveBeenCalled()
  })
  it('supersedes a final-validation request on the same project without releasing guards or accepting the old acknowledgment', async () => {
    mountLayout()
    let finishOld!: (value: ExistingSessionSummaryResult) => void
    f.summary.mockResolvedValueOnce({ status: 'ready', sessions: [row] }).mockResolvedValueOnce({ status: 'ready', sessions: [row] }).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    await act(async () => { sharedOpen.start(target) })
    await waitFor(() => expect(f.summary).toHaveBeenCalledTimes(3))
    const oldVisit = sharedOpen.getSnapshot().visits[0]
    const next = { ...target, sessionId: 'other' }
    f.summary.mockResolvedValue({ status: 'ready', sessions: [{ ...row, sessionId: 'other' }] })
    await act(async () => { sharedOpen.start(next) })
    expect(sharedOpen.isGuarded(target.projectId)).toBe(true)
    expect(sharedOpen.getSnapshot().visits[0]).not.toBe(oldVisit)
    await waitFor(() => expect(sharedOpen.getSnapshot().result?.status).toBe('succeeded'))
    await act(async () => finishOld({ status: 'ready', sessions: [row] }))
    expect(sharedOpen.getSnapshot().result?.handle.target.sessionId).toBe('other')
    expect(inPane(scope)).toBe('other'); expect(inPane(siblingScope)).toBe('none')
    expect(f.create).not.toHaveBeenCalled(); expect(f.network).not.toHaveBeenCalled()
  })
  it('settles a deadline-expired mounted handoff, ignores its late validation and permits a new exact request without creating siblings', async () => {
    mountLayout()
    let finishOld!: (value: ExistingSessionSummaryResult) => void
    f.summary.mockResolvedValueOnce({ status: 'ready', sessions: [row] }).mockResolvedValueOnce({ status: 'ready', sessions: [row] }).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await act(async () => { sharedOpen.start(target); await vi.advanceTimersByTimeAsync(1) })
      expect(f.summary).toHaveBeenCalledTimes(3)
      expect(inPane(scope)).toBe('target'); expect(sharedOpen.getSnapshot().result).toBeNull()
      await act(async () => vi.advanceTimersByTimeAsync(15000))
      expect(sharedOpen.getSnapshot().request).toBeNull()
      expect(sharedOpen.getSnapshot().result?.reason).toBe('expired')
      expect(sharedOpen.isGuarded(target.projectId)).toBe(true)
      expect(inPane(siblingScope)).toBe('none'); expect(f.create).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
    await act(async () => finishOld({ status: 'ready', sessions: [row] }))
    expect(sharedOpen.getSnapshot().result?.reason).toBe('expired')
    f.summary.mockResolvedValue({ status: 'ready', sessions: [row] })
    await act(async () => { sharedOpen.start(target) })
    await waitFor(() => expect(sharedOpen.getSnapshot().result?.status).toBe('succeeded'))
    expect(inPane(scope)).toBe('target'); expect(inPane(siblingScope)).toBe('none')
    expect(f.create).not.toHaveBeenCalled()
  })
  it.each(['before-reentry', 'during-reentry'] as const)('settles departure, ignores its late load %s, then opens a fresh exact request without recovering a hidden draft or selecting latest', async overlap => {
    mountLayout()
    f.backup.mockReturnValue({ updatedAt: 1, draft: { inputValue: 'hidden retained draft', pendingAttachments: [], pendingHiddenContext: '', updatedAt: 1 } })
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, siblingScope), 'hidden-draft')
    const oldReads: Array<(sessions: ChatSession[]) => void> = []
    f.load.mockImplementation(() => new Promise(resolve => oldReads.push(resolve)))
    await act(async () => { sharedOpen.start(target) })
    const old = sharedOpen.getSnapshot().request!.handle
    await waitFor(() => expect(oldReads.length).toBeGreaterThanOrEqual(3))
    await act(async () => screen.getByRole('button', { name: 'Leave Open project' }).click())
    await waitFor(() => expect(sharedOpen.getSnapshot().request).toBeNull())
    expect(sharedOpen.getSnapshot().result?.status).toBe('rejected')
    await waitFor(() => expect(sharedOpen.isGuarded(target.projectId)).toBe(false))
    if (overlap === 'before-reentry') await act(async () => { for (const done of oldReads) done([existing('other')]) })
    expect(sharedOpen.getSnapshot().result?.handle).toBe(old)
    expect(f.create).not.toHaveBeenCalled()
    await act(async () => screen.getByRole('button', { name: 'Return to management' }).click())
    const newReads: Array<{ loadedScope: string; done: (sessions: ChatSession[]) => void }> = []
    f.load.mockImplementation(loadedScope => new Promise(done => newReads.push({ loadedScope, done })))
    await act(async () => { sharedOpen.start(target) })
    await waitFor(() => expect(newReads.length).toBeGreaterThanOrEqual(3))
    const next = sharedOpen.getSnapshot().request!.handle
    expect(next).not.toBe(old)
    if (overlap === 'during-reentry') await act(async () => { for (const done of oldReads) done([existing('other')]) })
    expect(sharedOpen.getSnapshot().request?.handle).toBe(next)
    expect(sharedOpen.getSnapshot().result).toBeNull()
    expect(inPane(siblingScope)).toBe('none'); expect(f.create).not.toHaveBeenCalled()
    await act(async () => { for (const read of newReads) read.done(read.loadedScope === scope ? [existing('target'), existing('other')] : []) })
    await waitFor(() => expect(sharedOpen.getSnapshot().result?.status).toBe('succeeded'))
    expect(sharedOpen.getSnapshot().result?.handle).not.toBe(old)
    expect(inPane(scope)).toBe('target'); expect(inPane(siblingScope)).toBe('none')
    expect(localStorage.getItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, siblingScope))).toBe('hidden-draft')
    expect(f.create).not.toHaveBeenCalled(); expect(f.network).not.toHaveBeenCalled()
  })
  it.each(['disabled', 'deleted', 'navigation', 'tab-close', 'hidden', 'right-hide', 'bottom-overlay', 'unmount'] as const)('does not acknowledge after %s changes while the real final persisted validation is pending', async change => {
    const { store, rendered } = mountLayout()
    let finish!: (value: ExistingSessionSummaryResult) => void
    f.summary.mockResolvedValueOnce({ status: 'ready', sessions: [row] }).mockResolvedValueOnce({ status: 'ready', sessions: [row] }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const simulateDeadline = change === 'hidden' || change === 'unmount'
    if (simulateDeadline) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => { sharedOpen.start(target) })
    if (simulateDeadline) {
      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(f.summary).toHaveBeenCalledTimes(3)
    } else await waitFor(() => expect(f.summary).toHaveBeenCalledTimes(3))
    expect(inPane(scope)).toBe('target'); expect(sharedOpen.getSnapshot().result).toBeNull()
    await act(async () => {
      if (change === 'disabled') localStorage.setItem(paneKey, '[{"id":"agent-1","enabled":false},{"id":"agent-2","enabled":true}]')
      if (change === 'deleted') localStorage.setItem(`magicpot-chat-delete-tombstone:${encodeURIComponent(scope)}:target`, '')
      if (change === 'navigation') screen.getByRole('button', { name: 'Leave Open project' }).click()
      if (change === 'tab-close') store.dispatch(closeTab(target.projectId))
      if (change === 'hidden') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
      }
      if (change === 'right-hide') store.dispatch(closeRightPanel())
      if (change === 'bottom-overlay') store.dispatch(toggleBottomPanelMaximized())
      if (change === 'unmount') rendered.unmount()
      finish({ status: 'ready', sessions: [row] })
    })
    if (simulateDeadline) {
      // A temporary hidden/unmounted parent may await reattachment, but the real
      // scheduled deadline callback must still settle, not leave a stranded request.
      await act(async () => vi.advanceTimersByTimeAsync(15000))
      expect(sharedOpen.getSnapshot().request).toBeNull()
      expect(sharedOpen.getSnapshot().result?.status).toBe('rejected')
      expect(sharedOpen.getSnapshot().result?.reason).toBe('expired')
      vi.useRealTimers()
    } else {
      await settled()
      await waitFor(() => expect(sharedOpen.getSnapshot().request).toBeNull())
      expect(sharedOpen.getSnapshot().result?.status).toBe('rejected')
    }
    expect(sharedOpen.getSnapshot().result?.status).not.toBe('succeeded')
    if (change === 'disabled' || change === 'deleted' || change === 'hidden' || change === 'right-hide' || change === 'bottom-overlay' || change === 'unmount') expect(sharedOpen.isGuarded(target.projectId)).toBe(true)
    if (change === 'disabled' || change === 'deleted' || change === 'hidden' || change === 'bottom-overlay') expect(inPane(siblingScope)).toBe('none')
    expect(f.create).not.toHaveBeenCalled(); expect(f.network).not.toHaveBeenCalled()
  })
})

describe('actual ChatPage protection seam (also exercised by optional Workspace above; no management Open button)', () => {
  it.each([true, false])('does not auto-create an empty protected pane when active=%s', async (active) => {
    render(page({ storageScope: scope, isProtected: () => true }, { active }))
    await waitFor(() => expect(f.load).toHaveBeenCalledWith(scope)); await settled()
    expect(f.create).not.toHaveBeenCalled(); expect(selected()).toBe('none')
    expect(f.network).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled()
  })
  it('does not recover a persisted draft as a newly created session during a guarded visit', async () => {
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'deleted-target')
    f.backup.mockReturnValue({ updatedAt: 1, draft: { inputValue: 'retained draft', pendingAttachments: [], pendingHiddenContext: '', updatedAt: 1 } })
    render(page({ storageScope: scope, isProtected: () => true }))
    await waitFor(() => expect(f.load).toHaveBeenCalled()); await settled()
    expect(f.create).not.toHaveBeenCalled(); expect(selected()).toBe('none')
    expect(localStorage.getItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope))).toBe('deleted-target')
  })
  it.each(['missing', null])('does not fall back to latest when remembered selected ID is %s', async (remembered) => {
    f.load.mockResolvedValue([existing()])
    if (remembered) localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), remembered)
    render(page({ storageScope: scope, isProtected: () => true }))
    await waitFor(() => expect(f.load).toHaveBeenCalled()); await settled()
    expect(selected()).toBe('none'); expect(f.states.some((state) => state.id === 'other')).toBe(false)
    expect(localStorage.getItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope))).toBe(remembered)
  })
  it('keeps a valid remembered existing selection without treating protection as Open success', async () => {
    f.load.mockResolvedValue([existing()]); localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'other')
    render(page({ storageScope: scope, isProtected: () => true }))
    await waitFor(() => expect(selected()).toBe('other')); expect(f.create).not.toHaveBeenCalled()
  })
  it('protects StrictMode replay and rereads synchronous policy when a pending load completes', async () => {
    let done!: (sessions: ChatSession[]) => void
    f.load.mockImplementation(() => new Promise((resolve) => { done = resolve }))
    let guarded = false
    render(page({ storageScope: scope, isProtected: () => guarded }, { strict: true }))
    await waitFor(() => expect(f.load).toHaveBeenCalled()); guarded = true
    await act(async () => done([])); await settled()
    expect(f.create).not.toHaveBeenCalled(); expect(selected()).toBe('none')
  })
  it('fails closed if current protection policy throws, rather than creating or choosing latest', async () => {
    f.load.mockResolvedValue([existing()])
    render(page({ storageScope: scope, isProtected: () => { throw new Error('Unavailable policy') } }))
    await waitFor(() => expect(f.load).toHaveBeenCalled()); await settled()
    expect(selected()).toBe('none'); expect(f.create).not.toHaveBeenCalled()
  })
  it('ordinary unprotected inactive ChatPage retains automatic initial-session creation', async () => {
    render(page(undefined, { active: false }))
    await waitFor(() => expect(f.create).toHaveBeenCalledTimes(1)); expect(selected()).not.toBe('none')
  })
  it('ordinary unprotected ChatPage retains latest selection fallback', async () => {
    f.load.mockResolvedValue([existing()]); render(page())
    await waitFor(() => expect(selected()).toBe('other'))
  })
  it('ordinary unprotected ChatPage still recovers an actual draft-backup record', async () => {
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'draft-owner')
    f.backup.mockReturnValue({ updatedAt: 1, draft: { inputValue: 'retained draft', pendingAttachments: [], pendingHiddenContext: '', updatedAt: 1 } })
    render(page())
    await waitFor(() => expect(selected()).toBe('draft-owner'))
    expect(f.backup).toHaveBeenCalledWith('draft-owner', scope)
    // Recovery intentionally seeds ordinary session defaults via createChatSession once.
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.states.some(state => state.id === 'draft-owner' && state.draft === 'retained draft')).toBe(true)
  })
  it('rechecks a newly installed protection policy inside the initial-session updater', async () => {
    let checks = 0
    render(page({ storageScope: scope, isProtected: () => ++checks > 1 }))
    await waitFor(() => expect(checks).toBeGreaterThanOrEqual(2)); await settled()
    expect(f.create).not.toHaveBeenCalled(); expect(selected()).toBe('none')
  })
  it('does not apply a different-scope protection object to ordinary ChatPage', async () => {
    render(page({ storageScope: 'other.scope', isProtected: () => true }))
    await waitFor(() => expect(f.create).toHaveBeenCalledTimes(1))
  })
  it('an explicit false policy preserves ordinary Chat behavior', async () => {
    render(page({ storageScope: scope, isProtected: () => false }))
    await waitFor(() => expect(f.create).toHaveBeenCalledTimes(1))
  })
})
