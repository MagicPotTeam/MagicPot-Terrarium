import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { HashRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Layout from './Layout'
import layoutSlice, { closeRightPanel, closeTab, setActiveTab, toggleBottomPanelMaximized, type LayoutState } from '../store/slices/layoutSlice'
import { existingConversationOpenStore as coordinator } from '../utils/existingConversationOpenStore'
import type { ExistingConversationWorkspaceAdapter } from './existingConversationWorkspace'
import type { OpenRequestHandle } from '../utils/existingConversationOpen'

const f = vi.hoisted(() => ({ validate: vi.fn<(target: unknown, signal: AbortSignal) => Promise<boolean>>(), children: [] as Child[], sourceUnmount: vi.fn() }))
type Child = { projectId: string; existingConversationOpen?: ExistingConversationWorkspaceAdapter }
vi.mock('../store', async () => { const redux = await import('react-redux'); return { useAppDispatch: redux.useDispatch, useAppSelector: redux.useSelector } })
vi.mock('../utils/existingConversationOpenStore', async () => {
  const { useSyncExternalStore } = await import('react')
  const { createExistingConversationOpenCoordinator } = await import('../utils/existingConversationOpen')
  const store = createExistingConversationOpenCoordinator({ validate: (target, signal) => f.validate(target, signal) })
  return { existingConversationOpenStore: store, useExistingConversationOpenSnapshot: () => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) }
})
vi.mock('./TitleBar', () => ({ default: () => null }))
vi.mock('./ActivityBar', () => ({ default: () => null }))
vi.mock('./SidePanel', () => ({ default: () => null }))
vi.mock('./BottomPanel', () => ({ default: () => null }))
vi.mock('./AgentWorkspace', () => ({ default: (props: Child) => { f.children.push(props); return <div data-testid="workspace" data-project={props.projectId} data-open={String(!!props.existingConversationOpen?.request)} /> } }))
vi.mock('./MainArea', () => ({ default: function MockMainArea() {
  const navigate = useNavigate(), location = useLocation()
  React.useEffect(() => () => { f.sourceUnmount() }, [location.pathname])
  return <main><span data-testid="route">{location.pathname + location.search}</span><button onClick={() => navigate('/settings')}>Leave</button><button onClick={() => navigate('/canvas?id=tab-project-other')}>Other project</button></main>
} }))
const projectId = 'tab-project-existing'
const route = `/canvas?id=${projectId}`
const target = { projectId, paneId: 'agent-1', storageScope: `${projectId}.agent-1`, sessionId: 'target' }
const latest = () => f.children.at(-1)!
function fixture(): LayoutState {
  return { ...layoutSlice.getInitialState(), activeSidePanel: null, rightPanelVisible: false, bottomPanelVisible: true, bottomPanelMaximized: true, openTabs: [{ id: projectId, label: 'Existing', routePath: route, closable: true }, { id: 'tab-project-other', label: 'Other', routePath: '/canvas?id=tab-project-other', closable: true }, { id: 'tab-agent-management', label: 'Management', routePath: '/agent-management', closable: true }], activeTabId: 'tab-agent-management', lastActiveProjectId: projectId, lastRoutePath: '/agent-management', startupRestorePending: false, startupRestoreSnapshot: null }
}
function mount(state = fixture(), strict = false, initialRoute = state.lastRoutePath) {
  window.history.replaceState(null, '', `/#${initialRoute}`)
  const store = configureStore({ reducer: { layout: layoutSlice.reducer }, preloadedState: { layout: state } })
  const content = <Provider store={store}><HashRouter><Layout /></HashRouter></Provider>
  const rendered = render(strict ? <React.StrictMode>{content}</React.StrictMode> : content)
  return { store, rendered }
}
async function start() { let handle!: OpenRequestHandle; await act(async () => { handle = coordinator.start(target)! }); return handle }
beforeEach(() => { localStorage.clear(); f.validate.mockReset().mockResolvedValue(true); f.children = []; f.sourceUnmount.mockClear(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }) })
afterEach(() => { cleanup(); const state = coordinator.getSnapshot(); if (state.request) coordinator.cancel(state.request.handle); for (const visit of coordinator.getSnapshot().visits) coordinator.depart(visit); vi.restoreAllMocks(); localStorage.clear() })

describe('actual Layout Redux/HashRouter existing-project Open caller with injected validation and child only', () => {
  it.each([false, true])('navigates only after validation, opens the right panel and removes bottom maximization before a presentation lease, StrictMode=%s', async strict => {
    let validated!: (value: boolean) => void; f.validate.mockImplementationOnce(() => new Promise(resolve => { validated = resolve }))
    const { store } = mount(fixture(), strict); const handle = await start()
    expect(coordinator.isGuarded(projectId)).toBe(true)
    expect(screen.getByTestId('route')).toHaveTextContent('/agent-management'); expect(f.children).toHaveLength(0)
    await act(async () => validated(true))
    await waitFor(() => expect(latest()?.existingConversationOpen?.request?.handle).toBe(handle))
    expect(screen.getByTestId('route')).toHaveTextContent(route)
    expect(store.getState().layout.activeTabId).toBe(projectId)
    expect(store.getState().layout.rightPanelVisible).toBe(true); expect(store.getState().layout.bottomPanelMaximized).toBe(false)
    expect(f.children.every(child => child.projectId === projectId && child.existingConversationOpen?.coordinator === coordinator)).toBe(true)
    expect(f.sourceUnmount).toHaveBeenCalled(); expect(coordinator.getSnapshot().request?.handle).toBe(handle)
    expect(coordinator.getSnapshot().result).toBeNull()
  })
  it.each(['missing', 'mismatched-route', 'duplicate-id', 'duplicate-query'] as const)('rejects a %s destination tab without creating/rewriting tabs or mounting any Workspace', async failure => {
    const state = fixture()
    if (failure === 'missing') state.openTabs = state.openTabs.filter(tab => tab.id !== projectId)
    if (failure === 'mismatched-route') state.openTabs[0].routePath = '/canvas?id=other'
    if (failure === 'duplicate-id') state.openTabs.push({ ...state.openTabs[0] })
    if (failure === 'duplicate-query') state.openTabs[0].routePath += '&id=other'
    const before = state.openTabs; const { store } = mount(state); await start()
    await waitFor(() => expect(coordinator.getSnapshot().result?.reason).toBe('destination-lost'))
    expect(store.getState().layout.openTabs).toEqual(before)
    expect(f.children).toHaveLength(0); expect(screen.getByTestId('route')).toHaveTextContent('/agent-management')
  })
  it('does not mount a wrong project while the route and active tab are converging', async () => {
    const state = fixture(); state.activeTabId = 'tab-project-other'; state.rightPanelVisible = true; state.bottomPanelVisible = false; state.bottomPanelMaximized = false
    const handle = await start(); mount(state)
    await waitFor(() => expect(latest()?.existingConversationOpen?.request?.handle).toBe(handle))
    expect(f.children.every(child => child.projectId === projectId)).toBe(true)
  })
  it('does not grant presentation while the document is hidden and invalidates an existing lease on hide', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    mount(); await start()
    await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent(route))
    expect(f.children.every(child => !child.existingConversationOpen?.request)).toBe(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(latest()?.existingConversationOpen?.request).toBeDefined())
    const presentation = latest().existingConversationOpen!.request!.presentation
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(coordinator.attachPane(presentation, () => true)).toBeNull()
  })
  it.each(['close-tab', 'hide-right', 'bottom-overlay', 'leave-route'] as const)('invalidates a prior presentation after actual committed %s without automatic retry or success', async change => {
    const { store } = mount(); const handle = await start()
    await waitFor(() => expect(latest()?.existingConversationOpen?.request).toBeDefined())
    const prior = latest().existingConversationOpen!.request!.presentation
    await act(async () => {
      if (change === 'close-tab') store.dispatch(closeTab(projectId))
      if (change === 'hide-right') store.dispatch(closeRightPanel())
      if (change === 'bottom-overlay') store.dispatch(toggleBottomPanelMaximized())
      if (change === 'leave-route') fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    })
    expect(coordinator.attachPane(prior, () => true)).toBeNull()
    expect(coordinator.getSnapshot().result?.status).not.toBe('succeeded')
    if (change !== 'bottom-overlay') await waitFor(() => expect(coordinator.getSnapshot().request?.handle).not.toBe(handle))
    expect(store.getState().layout.rightPanelVisible).toBe(change === 'hide-right' ? false : true)
  })
  it('retains the visit and supplies policy-only Workspace adapter after rejection, then departs only after leaving the exact project', async () => {
    mount(); const handle = await start()
    await waitFor(() => expect(latest()?.existingConversationOpen?.request).toBeDefined())
    await act(async () => { coordinator.cancel(handle) })
    await waitFor(() => expect(latest()?.existingConversationOpen?.request).toBeUndefined())
    expect(latest().existingConversationOpen?.coordinator).toBe(coordinator); expect(coordinator.isGuarded(projectId)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(coordinator.isGuarded(projectId)).toBe(false))
  })
  it('rejects a user navigation that diverges from the captured source while preflight is pending', async () => {
    let validated!: (value: boolean) => void; f.validate.mockImplementationOnce(() => new Promise(resolve => { validated = resolve }))
    mount(); const handle = await start()
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    await act(async () => validated(true))
    await waitFor(() => expect(coordinator.getSnapshot().request?.handle).not.toBe(handle))
    expect(screen.getByTestId('route')).toHaveTextContent('/settings'); expect(f.children).toHaveLength(0)
  })
  it('does not overwrite a browser hash departure that precedes the HashRouter React commit', async () => {
    let validated!: (value: boolean) => void; f.validate.mockImplementationOnce(() => new Promise(resolve => { validated = resolve }))
    mount(); const handle = await start()
    // replaceState deliberately does not notify HashRouter: committed React route is still the source.
    window.history.replaceState(null, '', '/#/settings')
    expect(screen.getByTestId('route')).toHaveTextContent('/agent-management')
    await act(async () => validated(true))
    expect(window.location.hash).toBe('#/settings')
    expect(coordinator.getSnapshot().request?.handle).not.toBe(handle)
    expect(f.children).toHaveLength(0)
  })
  it('keeps the exact route/tab mount fence after closing the destination and departing the last visit', async () => {
    const { store } = mount(); await start()
    await waitFor(() => expect(latest()?.existingConversationOpen?.request).toBeDefined())
    f.children = []
    await act(async () => { store.dispatch(closeTab(projectId)) })
    expect(store.getState().layout.activeTabId).toBe('tab-project-other')
    expect(screen.getByTestId('route')).toHaveTextContent(route)
    expect(coordinator.getSnapshot().request).toBeNull()
    expect(coordinator.getSnapshot().visits).toHaveLength(0)
    expect(f.children).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Other project' }))
    await waitFor(() => expect(latest()?.projectId).toBe('tab-project-other'))
    expect(screen.getByTestId('route')).toHaveTextContent('/canvas?id=tab-project-other')
  })
  it.each([
    ['active-tab', 'departure', false], ['right-panel', 'departure', false], ['bottom-panel', 'departure', false],
    ['active-tab', 'supersession', false], ['right-panel', 'supersession', false], ['bottom-panel', 'supersession', false],
    ['active-tab', 'supersession', true], ['right-panel', 'supersession', true], ['bottom-panel', 'supersession', true]
  ] as const)('stops old mutations after synchronous %s callback %s and preserves replacement navigation, waitForRouteSync=%s', async (step, change, waitForRouteSync) => {
    const { store } = mount()
    let replaced = false
    let finishReplacement!: (value: boolean) => void
    const replacement: { current: OpenRequestHandle | null; state: LayoutState | null } = { current: null, state: null }
    const unsubscribe = store.subscribe(() => {
      const state = store.getState().layout
      if (replaced || state.activeTabId !== projectId ||
        (step !== 'active-tab' && !state.rightPanelVisible) ||
        (step === 'bottom-panel' && state.bottomPanelMaximized)) return
      replaced = true
      replacement.state = state
      if (change === 'departure') window.history.replaceState(null, '', '/#/settings')
      else {
        f.validate.mockImplementation(() => new Promise(resolve => { finishReplacement = resolve }))
        replacement.current = coordinator.start({ ...target, projectId: 'tab-project-other', storageScope: 'tab-project-other.agent-1' })
      }
    })
    try {
      const old = await start()
      expect(replaced).toBe(true)
      expect(window.location.hash).toBe(change === 'departure' ? '#/settings' : '#/agent-management')
      expect(coordinator.getSnapshot().request?.handle).not.toBe(old)
      expect(store.getState().layout.rightPanelVisible).toBe(replacement.state?.rightPanelVisible)
      expect(store.getState().layout.bottomPanelMaximized).toBe(replacement.state?.bottomPanelMaximized)
      expect(f.children).toHaveLength(0)
      if (change === 'supersession') {
        expect(coordinator.getSnapshot().request?.handle).toBe(replacement.current)
        expect(replacement.current?.target.projectId).toBe('tab-project-other')
        if (waitForRouteSync) {
          // Execute Layout's real 50ms route/tab reconciliation while the new
          // persisted validation remains pending; it is not user departure.
          await waitFor(() => expect(store.getState().layout.activeTabId).toBe('tab-agent-management'))
          expect(coordinator.getSnapshot().request?.handle).toBe(replacement.current)
          expect(window.location.hash).toBe('#/agent-management')
          expect(f.children).toHaveLength(0)
        }
        await act(async () => finishReplacement(true))
        await waitFor(() => expect(latest()?.existingConversationOpen?.request?.handle).toBe(replacement.current))
        expect(screen.getByTestId('route')).toHaveTextContent('/canvas?id=tab-project-other')
        expect(f.children.every(child => child.projectId === 'tab-project-other')).toBe(true)
      } else {
        expect(coordinator.getSnapshot().request).toBeNull()
        expect(coordinator.getSnapshot().result?.reason).toBe('destination-lost')
      }
    } finally { unsubscribe() }
  })
  it('rejects a pending replacement on an external tab-only change rather than treating it as internal route synchronization', async () => {
    const { store } = mount()
    let changed = false
    let finish!: (value: boolean) => void
    const next: { handle: OpenRequestHandle | null } = { handle: null }
    const unsubscribe = store.subscribe(() => {
      if (changed || store.getState().layout.activeTabId !== projectId) return
      changed = true
      f.validate.mockImplementation(() => new Promise(resolve => { finish = resolve }))
      next.handle = coordinator.start({ ...target, sessionId: 'other' })
    })
    try {
      await start()
      expect(coordinator.getSnapshot().request?.handle).toBe(next.handle)
      // Same final tab as route-sync would choose, but this is an untagged user
      // state change. Merely matching the management route must not excuse it.
      await act(async () => { store.dispatch(setActiveTab('tab-agent-management')) })
      expect(coordinator.getSnapshot().request).toBeNull()
      expect(coordinator.getSnapshot().result?.handle).toBe(next.handle)
      expect(coordinator.getSnapshot().result?.reason).toBe('destination-lost')
      await act(async () => finish(true))
      expect(f.children).toHaveLength(0); expect(window.location.hash).toBe('#/agent-management')
    } finally { unsubscribe() }
  })
  it.each(['departure', 'supersession'] as const)('isolates another %s inside Layout internal route/tab reconciliation and ignores the prior pending validation', async change => {
    const { store } = mount()
    let stage = 0
    let finishMiddle!: (value: boolean) => void
    let finishLast!: (value: boolean) => void
    const handles: { middle: OpenRequestHandle | null; last: OpenRequestHandle | null } = { middle: null, last: null }
    const unsubscribe = store.subscribe(() => {
      const tab = store.getState().layout.activeTabId
      if (stage === 0 && tab === projectId) {
        stage = 1
        f.validate.mockImplementation(() => new Promise(resolve => { finishMiddle = resolve }))
        handles.middle = coordinator.start({ ...target, projectId: 'tab-project-other', storageScope: 'tab-project-other.agent-1' })
      } else if (stage === 1 && tab === 'tab-agent-management') {
        stage = 2
        if (change === 'departure') window.history.replaceState(null, '', '/#/settings')
        else {
          f.validate.mockImplementation(() => new Promise(resolve => { finishLast = resolve }))
          handles.last = coordinator.start({ ...target, sessionId: 'last' })
        }
      }
    })
    try {
      await start()
      expect(coordinator.getSnapshot().request?.handle).toBe(handles.middle)
      await waitFor(() => expect(stage).toBe(2))
      expect(f.children).toHaveLength(0)
      expect(store.getState().layout.rightPanelVisible).toBe(false)
      expect(store.getState().layout.bottomPanelMaximized).toBe(true)
      await act(async () => finishMiddle(true))
      if (change === 'departure') {
        expect(coordinator.getSnapshot().request).toBeNull()
        expect(coordinator.getSnapshot().result?.handle).toBe(handles.middle)
        expect(coordinator.getSnapshot().result?.reason).toBe('destination-lost')
        expect(window.location.hash).toBe('#/settings'); expect(f.children).toHaveLength(0)
      } else {
        expect(coordinator.getSnapshot().request?.handle).toBe(handles.last)
        expect(coordinator.getSnapshot().result).toBeNull()
        await act(async () => finishLast(true))
        await waitFor(() => expect(latest()?.existingConversationOpen?.request?.handle).toBe(handles.last))
        expect(screen.getByTestId('route')).toHaveTextContent(route)
        expect(f.children.every(child => child.projectId === projectId)).toBe(true)
      }
    } finally { unsubscribe() }
  })
  it('ordinary never-Open project layouts still mount their existing Workspace without a new request', async () => {
    const state = fixture(); state.activeTabId = projectId; state.lastRoutePath = route; state.rightPanelVisible = true; state.bottomPanelVisible = false; state.bottomPanelMaximized = false
    mount(state)
    expect(await screen.findByTestId('workspace')).toHaveAttribute('data-project', projectId)
    expect(coordinator.getSnapshot().request).toBeNull(); expect(f.validate).not.toHaveBeenCalled()
  })
})
