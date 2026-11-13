import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import AgentManagementPage from './AgentManagementPage'

const h = vi.hoisted(() => ({ navigate: vi.fn(), dispatch: vi.fn(), save: vi.fn(), api: vi.fn(() => { throw new Error('Management must not read auth, usage or providers') }) }))
let config: Config, ready = true, language = 'en'
const location = Object.freeze({ pathname: '/agent-management', search: '', hash: '', state: { tab: 'environment' }, key: 'model-nav-unit' })
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate, useLocation: () => location }))
vi.mock('@renderer/store', () => ({ useAppDispatch: () => h.dispatch }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config, isReady: ready, updateConfig: h.save }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language }, t: (key: string) => key }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
const secret = 'MODEL_AUTH_EMAIL_KEY_URL_PATH_NOT_FOR_DOM_OR_NAVIGATION'
const action = () => screen.getByRole('button', { name: 'Open model-profile settings' })
beforeEach(() => {
  vi.clearAllMocks(); ready = true; language = 'en'; config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [{ id: 'configured-id', model_name: 'configured-model', provider: 'openai', call_type: 'codex', api_key: secret, base_url: secret, auth_mode: 'codex_oauth', auth_account_email: secret, auth_connected_at: secret }]
  config.llm_config.proceduralSkillPackages = [{ id: 'source-registration', directory: secret, enabled: true }]
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('explicit model-profile configuration handoff, never account identity', () => {
  it('discloses destination credential/network/autosave effects, then dispatches canonical tab before static cleared-state navigation without API or secret payload', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem'), before = structuredClone(config)
    const { container } = render(<React.StrictMode><AgentManagementPage /></React.StrictMode>)
    const profiles = screen.getByRole('region', { name: 'Configured model profiles' })
    const notice = within(profiles).getByText('Model settings')
    expect(notice).not.toHaveTextContent(/credentials|permission/)
    expect(action()).toHaveAttribute('aria-describedby', notice.id)
    const account = screen.getByRole('region', { name: 'Account identity' })
    expect(within(account).getByText('Unavailable in this local-config view')).toBeVisible()
    expect(h.navigate).not.toHaveBeenCalled(); expect(h.dispatch).not.toHaveBeenCalled()
    fireEvent.click(action())
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'layout/openTab', payload: { id: 'tab-settings', label: 'Settings', routePath: '/settings', closable: true } })
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith('/settings?tab=llm', { state: null })
    expect(h.dispatch.mock.invocationCallOrder[0]).toBeLessThan(h.navigate.mock.invocationCallOrder[0])
    expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled()
    expect(config).toEqual(before); expect(container.innerHTML).not.toContain(secret)
    expect(screen.getByText('Not loaded — use Read installed catalog')).toBeInTheDocument()
    expect(screen.getByText('Not loaded — use Read existing conversation summaries')).toBeInTheDocument()
  })
  it('does not open on StrictMode/rerender/context/language/time, hides while unready and offers an empty ready local registry', async () => {
    vi.useFakeTimers(); ready = false
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem')
    const view = render(<React.StrictMode><AgentManagementPage /></React.StrictMode>)
    expect(screen.queryByRole('button', { name: 'Open model-profile settings' })).toBeNull()
    ready = true; config = { ...config, llm_config: { ...config.llm_config, api_profiles: [] } }
    view.rerender(<React.StrictMode><AgentManagementPage /></React.StrictMode>)
    expect(action()).toBeEnabled(); expect(screen.getByText('No model profiles configured')).toBeVisible()
    language = 'zh-CN'; view.rerender(<React.StrictMode><AgentManagementPage /></React.StrictMode>)
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(screen.getByRole('button', { name: '打开模型配置设置' })).toBeEnabled()
    expect(h.navigate).not.toHaveBeenCalled(); expect(h.dispatch).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled()
  })
  it('disables local profile editing in remote mode without toggling remote config or disabling skill-source settings', () => {
    config.use_remote_llm = true; const before = structuredClone(config)
    const view = render(<AgentManagementPage />)
    expect(action()).toBeDisabled()
    const reason = screen.getByText('Local model-profile editing is unavailable while remote LLM mode is active.')
    expect(reason).toBeVisible(); expect(action().getAttribute('aria-describedby')?.split(' ')).toContain(reason.id)
    fireEvent.click(action()); expect(h.navigate).not.toHaveBeenCalled(); expect(h.dispatch).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Open skill-source settings' })).toBeEnabled()
    expect(config).toEqual(before); expect(h.save).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled()
    config = { ...config, use_remote_llm: false }; view.rerender(<AgentManagementPage />)
    expect(action()).toBeEnabled(); expect(screen.queryByText(reason.textContent!)).toBeNull(); expect(h.navigate).not.toHaveBeenCalled()
  })
  it('localizes disclosure/action and preserves skill-source and Back destinations with no profile identity forwarded', () => {
    language = 'zh-CN'; render(<AgentManagementPage />)
    expect(screen.getByText('模型设置')).toBeVisible()
    expect(screen.queryByText(/修改可能自动保存/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开模型配置设置' }))
    expect(h.navigate).toHaveBeenLastCalledWith('/settings?tab=llm', { state: null })
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'layout/openTab', payload: { id: 'tab-settings', label: '设置', routePath: '/settings', closable: true } })
    fireEvent.click(screen.getByRole('button', { name: '打开技能来源设置' }))
    expect(h.navigate).toHaveBeenLastCalledWith('/settings?tab=environment', { state: null })
    fireEvent.click(screen.getByRole('button', { name: '返回设置' }))
    expect(h.navigate).toHaveBeenLastCalledWith('/settings'); expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
  })
})
