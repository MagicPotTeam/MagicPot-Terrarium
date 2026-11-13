import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { HashRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import layoutSlice, { type LayoutState } from '@renderer/store/slices/layoutSlice'
import Layout from '@renderer/components/Layout'

const h = vi.hoisted(() => ({ config: undefined as Config | undefined, save: vi.fn(async (_value: unknown) => {}), api: vi.fn(() => { throw new Error('Navigation fixture must not call services') }), environment: vi.fn(), general: vi.fn(), llm: vi.fn() }))
vi.mock('@renderer/store', async () => { const redux = await import('react-redux'); return { useAppDispatch: redux.useDispatch, useAppSelector: redux.useSelector } })
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: h.config, isReady: true, updateConfig: h.save }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => key }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
vi.mock('@renderer/components/TitleBar', () => ({ default: () => null }))
vi.mock('@renderer/components/ActivityBar', () => ({ default: () => null }))
vi.mock('@renderer/components/AgentWorkspace', () => ({ default: () => null }))
vi.mock('@renderer/components/SidePanel', () => ({ default: () => null }))
vi.mock('@renderer/components/BottomPanel', () => ({ default: () => null }))
vi.mock('@renderer/pages/SettingsPage/PanelEnvironment', async () => {
  const { default: Editor } = await import('@renderer/pages/SettingsPage/components/AgentSkillPackagesSettings')
  const { useEffect } = await import('react')
  function EnvironmentEditorFixture(props: React.ComponentProps<typeof Editor>) {
    useEffect(() => { h.environment() }, [])
    return <section aria-label="Existing Environment editor fixture"><Editor {...props} /></section>
  }
  return { default: EnvironmentEditorFixture }
})
vi.mock('@renderer/components/inputs/InputPath', () => ({ default: ({ value, onChange, label }: { value: string; onChange(value: string): void; label: string }) => <input aria-label={label} value={value} onChange={event => onChange(event.target.value)} /> }))
vi.mock('@renderer/pages/SettingsPage/PanelGeneral', () => ({ default: () => { h.general(); return <div>Existing General panel fixture</div> } }))
vi.mock('@renderer/pages/SettingsPage/PanelLLM', () => ({ default: () => { h.llm(); return <div>Existing LLM panel fixture</div> } }))
vi.mock('@renderer/pages/SettingsPage/PanelAbout', () => ({ default: () => null }))
vi.mock('@renderer/pages/SettingsPage/PanelMcp', () => ({ default: () => null }))
vi.mock('@renderer/pages/SettingsPage/PanelUpdates', () => ({ default: () => null }))

function mount(route = '/agent-management', state: unknown = { tab: 'llm' }) {
  window.history.replaceState({ usr: state, key: 'initial-skill-settings', idx: 0 }, '', `/#${route}`)
  const layout: LayoutState = { ...layoutSlice.getInitialState(), activeSidePanel: null, openTabs: [
    { id: 'tab-settings', label: 'Existing Settings', routePath: '/settings?tab=llm', closable: true },
    { id: 'tab-agent-management', label: 'Agent management', routePath: '/agent-management', closable: true }
  ], activeTabId: route.startsWith('/agent-management') ? 'tab-agent-management' : 'tab-settings', lastRoutePath: route, lastActiveProjectId: null, rightPanelVisible: false, bottomPanelVisible: false, bottomPanelMaximized: false, startupRestorePending: false, startupRestoreSnapshot: null }
  const store = configureStore({ reducer: { layout: layoutSlice.reducer }, preloadedState: { layout } })
  render(<React.StrictMode><Provider store={store}><HashRouter><Layout /></HashRouter></Provider></React.StrictMode>)
  return store
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); h.config = structuredClone(DEFAULT_CONFIG)
  h.config.llm_config.proceduralSkillPackages = [{ id: 'existing-registration', directory: 'D:/fixture-source-not-read', enabled: false, projectId: 'configured-project' }]
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) }) }

describe('actual router/MainArea/Settings/reducer source-editor handoff with a bounded Environment fixture', () => {
  it('leaves management only on click, clears legacy state, selects Environment, deduplicates stale Settings tab and repeats without hidden mounts', async () => {
    const store = mount()
    expect(await screen.findByRole('heading', { name: 'Agent management' })).toBeVisible()
    await settle()
    expect(h.environment).not.toHaveBeenCalled(); expect(h.llm).not.toHaveBeenCalled(); expect(h.general).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
    for (let visit = 0; visit < 2; visit++) {
      const beforeMounts = h.environment.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: 'Open skill-source settings' }))
      expect(await screen.findByRole('region', { name: 'Existing Environment editor fixture' })).toBeVisible()
      expect(screen.getByText('existing-registration')).toBeInTheDocument()
      expect(screen.getByRole('switch', { name: 'environment.agent_skill_packages.enable' })).not.toBeChecked()
      await settle()
      expect(window.location.hash).toBe('#/settings?tab=environment'); expect(window.history.state.usr).toBeNull()
      expect(store.getState().layout.activeTabId).toBe('tab-settings')
      expect(store.getState().layout.openTabs.filter(tab => tab.id === 'tab-settings')).toHaveLength(1)
      expect(store.getState().layout.openTabs.find(tab => tab.id === 'tab-settings')?.routePath).toBe('/settings?tab=llm')
      expect(h.environment.mock.calls.length).toBeGreaterThan(beforeMounts)
      expect(h.llm).not.toHaveBeenCalled(); expect(h.general).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Agent management' }))
      expect(await screen.findByRole('heading', { name: 'Agent management' })).toBeVisible()
      const mounts = h.environment.mock.calls.length; await settle(); expect(h.environment).toHaveBeenCalledTimes(mounts)
      expect(screen.getByRole('button', { name: 'Show bundled declarations' })).toHaveAttribute('aria-expanded', 'false')
      expect(store.getState().layout.openTabs.filter(tab => tab.id === 'tab-agent-management')).toHaveLength(1)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open skill-source settings' }))
    expect(await screen.findByRole('region', { name: 'Existing Environment editor fixture' })).toBeVisible(); await settle()
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    expect(await screen.findByRole('heading', { name: 'Agent management' })).toBeVisible()
    await waitFor(() => expect(store.getState().layout.openTabs.some(tab => tab.id === 'tab-settings')).toBe(false))
    expect(store.getState().layout.activeTabId).toBe('tab-agent-management')
  })
  it.each([
    { name: 'query Environment with no legacy state', query: '?tab=environment', state: null, panel: 'environment' },
    { name: 'valid legacy state still wins globally', query: '?tab=environment', state: { tab: 'llm' }, panel: 'llm' },
    { name: 'invalid legacy state falls through to query', query: '?tab=environment', state: { tab: 'skills' }, panel: 'environment' },
    { name: 'invalid tab remains General fallback', query: '?tab=skills', state: null, panel: 'general' }
  ])('preserves actual mounted Settings initial selection: $name', async ({ query, state, panel }) => {
    mount('/settings' + query, state)
    if (panel === 'environment') expect(await screen.findByRole('region', { name: 'Existing Environment editor fixture' })).toBeVisible()
    else expect(await screen.findByText(panel === 'llm' ? 'Existing LLM panel fixture' : 'Existing General panel fixture')).toBeVisible()
    expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
  })
  it('does not save on handoff; only the actual existing registration editor Save submits a canonical partial config', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Open skill-source settings' }))
    expect(await screen.findByRole('region', { name: 'Existing Environment editor fixture' })).toBeVisible()
    expect(h.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'environment.agent_skill_packages.manifest' }))
    expect(h.save).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'environment.agent_skill_packages.save' })) })
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ llm_config: { proceduralSkillPackages: [{ id: 'existing-registration', directory: 'D:/fixture-source-not-read', enabled: false, projectId: 'configured-project', source: 'manifest' }] } })
    expect(h.api).not.toHaveBeenCalled()
  })
})
