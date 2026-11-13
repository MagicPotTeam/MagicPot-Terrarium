import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { HashRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import layoutSlice, { type LayoutState } from '../store/slices/layoutSlice'
import Layout from './Layout'

const effects = vi.hoisted(() => ({ agent: vi.fn(), side: vi.fn(), bottom: vi.fn(), chat: vi.fn(), project: vi.fn(), api: vi.fn(() => { throw new Error('Unexpected service access in local overview integration') }), save: vi.fn(), managementLoads: 0 }))
vi.mock('../store', async () => {
  const redux = await import('react-redux')
  return { useAppDispatch: redux.useDispatch, useAppSelector: redux.useSelector }
})
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: DEFAULT_CONFIG, isReady: true, updateConfig: effects.save }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => key }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: effects.api }))
vi.mock('./TitleBar', () => ({ default: () => null }))
vi.mock('./ActivityBar', () => ({ default: () => null }))
vi.mock('./AgentWorkspace', () => ({ default: () => { effects.agent(); return <div data-testid="unwanted-agent-workspace" /> } }))
vi.mock('./SidePanel', () => ({ default: () => { effects.side(); return null } }))
vi.mock('./BottomPanel', () => ({ default: () => { effects.bottom(); return null } }))
vi.mock('../pages/ChatPage/ChatPage', () => ({ default: () => { effects.chat(); return null } }))
vi.mock('../pages/ProjectCanvasPage/ProjectCanvasPage', () => ({ default: () => { effects.project(); return <div>Existing project canvas</div> } }))
vi.mock('../pages/AgentManagementPage/AgentManagementPage', async (original) => {
  effects.managementLoads++
  return await original()
})
vi.mock('../pages/SettingsPage/PanelAbout', () => ({ default: () => null }))
vi.mock('../pages/SettingsPage/PanelEnvironment', () => ({ default: () => null }))
vi.mock('../pages/SettingsPage/PanelGeneral', () => ({ default: () => <div>General Settings</div> }))
vi.mock('../pages/SettingsPage/PanelLLM', () => ({ default: () => null }))
vi.mock('../pages/SettingsPage/PanelMcp', () => ({ default: () => null }))
vi.mock('../pages/SettingsPage/PanelUpdates', () => ({ default: () => null }))

function fixtureState(): LayoutState {
  return { ...layoutSlice.getInitialState(), activeSidePanel: 'quickapp', rightPanelVisible: true, bottomPanelVisible: true, bottomPanelMaximized: true, openTabs: [{ id: 'tab-project-existing', label: 'Existing', routePath: '/canvas?id=tab-project-existing', closable: true }], activeTabId: 'tab-project-existing', lastActiveProjectId: 'tab-project-existing', lastRoutePath: '/canvas?id=tab-project-existing', startupRestorePending: false, startupRestoreSnapshot: null }
}
function mount(hash: string, layout = fixtureState()) {
  window.history.replaceState(null, '', `/#${hash}`)
  const store = configureStore({ reducer: { layout: layoutSlice.reducer }, preloadedState: { layout } })
  render(<React.StrictMode><Provider store={store}><HashRouter><Layout /></HashRouter></Provider></React.StrictMode>)
  return store
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear() })

describe('real Settings, lazy MainArea and layout reducer integration', () => {
  it('loads the management module only after the actual Settings click, deduplicates returns and closes back to Settings', async () => {
    const layout = fixtureState(); layout.openTabs = [{ id: 'tab-settings', label: 'Settings', routePath: '/settings', closable: true }]; layout.activeTabId = 'tab-settings'; layout.lastRoutePath = '/settings'; layout.bottomPanelVisible = false; layout.bottomPanelMaximized = false
    const store = mount('/settings', layout)
    const button = await screen.findByRole('button', { name: 'Agent management' })
    expect(effects.managementLoads).toBe(0)
    fireEvent.click(button)
    expect(await screen.findByRole('heading', { name: 'Agent management' })).toBeVisible()
    expect(store.getState().layout.activeTabId).toBe('tab-agent-management')
    fireEvent.click(screen.getByRole('button', { name: 'Back to Settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Agent management' }))
    expect(await screen.findByRole('heading', { name: 'Agent management' })).toBeVisible()
    expect(store.getState().layout.openTabs.filter(tab => tab.id === 'tab-agent-management')).toHaveLength(1)
    fireEvent.keyDown(window, { ctrlKey: true, key: 'w' })
    expect(await screen.findByRole('button', { name: 'Agent management' })).toBeInTheDocument()
    expect(store.getState().layout.activeTabId).toBe('tab-settings'); expect(store.getState().layout.openTabs.some(tab => tab.id === 'tab-agent-management')).toBe(false)
    expect(effects.api).not.toHaveBeenCalled(); expect(effects.save).not.toHaveBeenCalled()
  })
  it.each(['/agent-management', '/agent-management/', '/AGENT-MANAGEMENT', '/%61gent-management'])('mounts the real lazy page and materializes its tab for direct route %s rather than a saved project', async (route) => {
    const store = mount(route)
    expect(await screen.findByRole('heading', { name: 'Agent management' })).toBeVisible()
    await waitFor(() => expect(store.getState().layout.openTabs.filter(tab => tab.id === 'tab-agent-management')).toHaveLength(1))
    expect(store.getState().layout.activeTabId).toBe('tab-agent-management')
    expect(store.getState().layout.lastActiveProjectId).toBe('tab-project-existing')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
    expect(effects.agent).not.toHaveBeenCalled(); expect(effects.bottom).not.toHaveBeenCalled(); expect(effects.side).not.toHaveBeenCalled(); expect(effects.chat).not.toHaveBeenCalled(); expect(effects.project).not.toHaveBeenCalled(); expect(effects.api).not.toHaveBeenCalled(); expect(effects.save).not.toHaveBeenCalled()
  })
  it('finishes a stale startup snapshot without replacing the explicit management page or opening project panels', async () => {
    const state = fixtureState(); state.startupRestorePending = true
    state.startupRestoreSnapshot = { activeSidePanel: state.activeSidePanel, sidePanelWidth: state.sidePanelWidth, rightPanelVisible: true, bottomPanelVisible: true, bottomPanelActiveTab: 'terminal', openTabs: state.openTabs, activeTabId: state.activeTabId, lastActiveProjectId: state.lastActiveProjectId, lastRoutePath: state.lastRoutePath }
    const store = mount('/agent-management', state)
    expect(await screen.findByRole('heading', { name: 'Agent management' })).toBeVisible()
    await waitFor(() => expect(store.getState().layout.startupRestorePending).toBe(false))
    await waitFor(() => expect(store.getState().layout.activeTabId).toBe('tab-agent-management'))
    expect(screen.getByRole('heading', { name: 'Agent management' })).toBeVisible()
    expect(store.getState().layout.openTabs.map(tab => tab.id)).toEqual(['tab-project-existing', 'tab-agent-management'])
    expect(effects.agent).not.toHaveBeenCalled(); expect(effects.bottom).not.toHaveBeenCalled(); expect(effects.side).not.toHaveBeenCalled(); expect(effects.chat).not.toHaveBeenCalled(); expect(effects.project).not.toHaveBeenCalled(); expect(effects.api).not.toHaveBeenCalled()
  })
})
