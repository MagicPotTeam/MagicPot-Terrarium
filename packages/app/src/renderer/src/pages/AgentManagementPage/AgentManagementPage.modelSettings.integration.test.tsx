import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { HashRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import layoutSlice, { type LayoutState } from '@renderer/store/slices/layoutSlice'
import { rendererHostExtensionApiV1 } from '@renderer/extensions/generatedRegistry'
import Layout from '@renderer/components/Layout'

const h = vi.hoisted(() => ({ config: undefined as Config | undefined, save: vi.fn(async (_value: unknown) => {}), api: vi.fn(() => { throw new Error('Public model-settings navigation must not call providers, auth or discovery') }), environment: vi.fn(), general: vi.fn(), notify: vi.fn() }))
vi.mock('@renderer/store', async () => { const redux = await import('react-redux'); return { useAppDispatch: redux.useDispatch, useAppSelector: redux.useSelector } })
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: h.config, isReady: true, updateConfig: h.save }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifyInfo: h.notify, notifySuccess: h.notify, notifyWarning: h.notify, closeMessage: h.notify }) }))
vi.mock('@renderer/components/TitleBar', () => ({ default: () => null }))
vi.mock('@renderer/components/ActivityBar', () => ({ default: () => null }))
vi.mock('@renderer/components/AgentWorkspace', () => ({ default: () => null }))
vi.mock('@renderer/components/SidePanel', () => ({ default: () => null }))
vi.mock('@renderer/components/BottomPanel', () => ({ default: () => null }))
vi.mock('@renderer/pages/SettingsPage/PanelEnvironment', async () => {
  const { useEffect } = await import('react')
  function EnvironmentDestinationFixture() { useEffect(() => { h.environment() }, []); return <section aria-label="Environment destination fixture" /> }
  return { default: EnvironmentDestinationFixture }
})
vi.mock('@renderer/pages/SettingsPage/PanelGeneral', () => ({ default: () => { h.general(); return <div>General destination fixture</div> } }))
vi.mock('@renderer/pages/SettingsPage/PanelAbout', () => ({ default: () => null }))
vi.mock('@renderer/pages/SettingsPage/PanelMcp', () => ({ default: () => null }))
vi.mock('@renderer/pages/SettingsPage/PanelUpdates', () => ({ default: () => null }))
vi.mock('@renderer/components/inputs/InputPath', () => ({ default: ({ value, onChange, label }: { value: string; onChange(value: string): void; label: string }) => <input aria-label={label} value={value} onChange={event => onChange(event.target.value)} /> }))

function mount(route = '/agent-management', state: unknown = { tab: 'environment' }) {
  window.history.replaceState({ usr: state, key: 'initial-model-settings', idx: 0 }, '', `/#${route}`)
  const layout: LayoutState = { ...layoutSlice.getInitialState(), activeSidePanel: null, openTabs: [
    { id: 'tab-settings', label: 'Existing Settings', routePath: '/settings?tab=environment', closable: true },
    { id: 'tab-agent-management', label: 'Agent management', routePath: '/agent-management', closable: true }
  ], activeTabId: route.startsWith('/agent-management') ? 'tab-agent-management' : 'tab-settings', lastRoutePath: route, lastActiveProjectId: null, rightPanelVisible: false, bottomPanelVisible: false, bottomPanelMaximized: false, startupRestorePending: false, startupRestoreSnapshot: null }
  const store = configureStore({ reducer: { layout: layoutSlice.reducer }, preloadedState: { layout } })
  render(<React.StrictMode><Provider store={store}><HashRouter><Layout /></HashRouter></Provider></React.StrictMode>)
  return store
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); h.config = structuredClone(DEFAULT_CONFIG)
  h.config.use_remote_llm = false
  h.config.llm_config.api_profiles = [{ id: 'synthetic-model-profile', model_name: 'fixture-model', api_key: '', base_url: 'https://fixture.invalid/v1', provider: 'openai', call_type: 'api' }]
  expect(rendererHostExtensionApiV1.settings).toBeUndefined()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) }) }
const modelAction = () => screen.getByRole('button', { name: 'Open model-profile settings' })
const openManagement = async () => { fireEvent.click(screen.getByRole('button', { name: 'Agent management' })); expect(await screen.findByRole('heading', { name: 'Agent management' })).toBeVisible() }

describe('actual router/Layout/MainArea/Settings/PanelLLM model-profile handoff, public empty extension fallback', () => {
  it('selects actual LLM despite stale Environment tab and legacy state, reconciles delayed Layout and repeats model/source/Back returns without extra tabs or hidden effects', async () => {
    const store = mount(); expect(await screen.findByRole('heading', { name: 'Agent management' })).toBeVisible(); await settle()
    expect(screen.queryByLabelText('llm.base_url')).toBeNull(); expect(h.environment).not.toHaveBeenCalled(); expect(h.general).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
    for (let visit = 0; visit < 2; visit++) {
      fireEvent.click(modelAction())
      expect(await screen.findByLabelText('llm.base_url')).toHaveValue('https://fixture.invalid/v1')
      expect(screen.getByRole('button', { name: 'llm.add_api_profile' })).toBeVisible()
      await settle()
      expect(window.location.hash).toBe('#/settings?tab=llm'); expect(window.history.state.usr).toBeNull()
      expect(store.getState().layout.activeTabId).toBe('tab-settings')
      expect(store.getState().layout.openTabs.filter(tab => tab.id === 'tab-settings')).toHaveLength(1)
      expect(store.getState().layout.openTabs.find(tab => tab.id === 'tab-settings')?.routePath).toBe('/settings?tab=environment')
      expect(h.environment).toHaveBeenCalledTimes(visit * 2); expect(h.general).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
      await openManagement(); await settle(); expect(screen.queryByLabelText('llm.base_url')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Open skill-source settings' }))
      expect(await screen.findByRole('region', { name: 'Environment destination fixture' })).toBeVisible(); await settle()
      expect(window.location.hash).toBe('#/settings?tab=environment'); expect(screen.queryByLabelText('llm.base_url')).toBeNull()
      await openManagement(); await settle()
      expect(screen.getByRole('button', { name: 'Show bundled declarations' })).toHaveAttribute('aria-expanded', 'false')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Back to Settings' }))
    expect(await screen.findByText('General destination fixture')).toBeVisible(); await settle()
    expect(window.location.hash).toBe('#/settings'); expect(store.getState().layout.openTabs.filter(tab => tab.id === 'tab-settings')).toHaveLength(1)
    expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
  })
  it('hands off without saving; an actual PanelLLM Base URL input immediately submits canonical config via existing context update rather than waiting for Save', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Open model-profile settings' }))
    const input = await screen.findByLabelText('llm.base_url'); await settle()
    expect(h.save).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled()
    await act(async () => { fireEvent.change(input, { target: { value: 'https://edited.invalid/v1' } }) })
    // Existing updateProfile normalizes ordinary API profiles; do not change the editor for this navigation slice.
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ llm_config: { api_profiles: [{ id: 'synthetic-model-profile', model_name: 'fixture-model', api_key: '', base_url: 'https://edited.invalid/v1', provider: 'default', call_type: undefined, deployment: undefined, is_ollama: false }] } })
    expect(h.api).not.toHaveBeenCalled(); expect(h.environment).not.toHaveBeenCalled(); expect(h.general).not.toHaveBeenCalled()
  })
  it('keeps remote LLM mode unchanged and local model action disabled, matching the actual LLM destination which suppresses the local profile editor', async () => {
    h.config!.use_remote_llm = true; const before = structuredClone(h.config)
    const store = mount(); expect(await screen.findByRole('heading', { name: 'Agent management' })).toBeVisible()
    expect(modelAction()).toBeDisabled(); expect(screen.getByText('Local model-profile editing is unavailable while remote LLM mode is active.')).toBeVisible()
    fireEvent.click(modelAction()); await settle(); expect(window.location.hash).toBe('#/agent-management'); expect(store.getState().layout.activeTabId).toBe('tab-agent-management')
    expect(screen.getByRole('button', { name: 'Open skill-source settings' })).toBeEnabled(); expect(h.config).toEqual(before); expect(h.save).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled()
    cleanup(); mount('/settings?tab=llm', null)
    expect(await screen.findByRole('button', { name: 'Agent management' })).toBeVisible(); await settle()
    expect(screen.queryByLabelText('llm.base_url')).toBeNull(); expect(screen.queryByRole('button', { name: 'llm.add_api_profile' })).toBeNull()
    expect(h.save).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(h.config).toEqual(before)
  })
})
