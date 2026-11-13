import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import AgentManagementPage from './AgentManagementPage'

const h = vi.hoisted(() => ({ navigate: vi.fn(), dispatch: vi.fn(), save: vi.fn(), api: vi.fn(() => { throw new Error('Navigation must not read services') }) }))
let config: Config, ready = true, language = 'en'
const location = Object.freeze({ pathname: '/agent-management', search: '', hash: '', state: { tab: 'llm' }, key: 'source-nav-unit' })
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate, useLocation: () => location }))
vi.mock('@renderer/store', () => ({ useAppDispatch: () => h.dispatch }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config, isReady: ready, updateConfig: h.save }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language }, t: (key: string) => key }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
const secret = 'PRIVATE_SOURCE_PATH_AND_PROFILE_MUST_NOT_LEAVE_MANAGEMENT'
const action = () => screen.getByRole('button', { name: 'Open skill-source settings' })
beforeEach(() => {
  vi.clearAllMocks(); ready = true; language = 'en'; config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.proceduralSkillPackages = [{ id: 'registered-only', directory: secret, enabled: false, projectId: 'private-project' }]
  config.llm_config.api_profiles = [{ id: 'profile', api_key: secret, base_url: secret, model_name: 'configured' }]
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('explicit skill-source Settings handoff, not source discovery', () => {
  it('dispatches existing Settings identity before static query navigation with cleared legacy state, no service/config/path payload', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem'), before = structuredClone(config)
    const { container } = render(<React.StrictMode><AgentManagementPage /></React.StrictMode>)
    const source = screen.getByRole('region', { name: 'Configured procedural skill sources' })
    expect(within(source).getByText('Environment settings')).toBeVisible()
    expect(h.dispatch).not.toHaveBeenCalled(); expect(h.navigate).not.toHaveBeenCalled()
    fireEvent.click(action())
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'layout/openTab', payload: { id: 'tab-settings', label: 'Settings', routePath: '/settings', closable: true } })
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith('/settings?tab=environment', { state: null })
    expect(h.dispatch.mock.invocationCallOrder[0]).toBeLessThan(h.navigate.mock.invocationCallOrder[0])
    expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled()
    expect(config).toEqual(before); expect(container.innerHTML).not.toContain(secret)
    expect(screen.getByText('Not loaded — use Read installed catalog')).toBeInTheDocument()
    expect(screen.getByText('Not loaded — use Read existing conversation summaries')).toBeInTheDocument()
  })
  it('never auto-navigates or reads/saves on StrictMode, rerender, updated context, language or elapsed time', async () => {
    vi.useFakeTimers()
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem')
    const view = render(<React.StrictMode><AgentManagementPage /></React.StrictMode>)
    expect(action()).toBeEnabled(); view.rerender(<React.StrictMode><AgentManagementPage /></React.StrictMode>)
    config = { ...config, llm_config: { ...config.llm_config, proceduralSkillPackages: [] } }; language = 'zh-CN'
    view.rerender(<React.StrictMode><AgentManagementPage /></React.StrictMode>)
    expect(screen.getByRole('button', { name: '打开技能来源设置' })).toBeEnabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(screen.getByRole('button', { name: '打开技能来源设置' })).toBeEnabled()
    expect(h.navigate).not.toHaveBeenCalled(); expect(h.dispatch).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled()
  })
  it('hides source editing handoff while config is unready, but offers it for a ready empty registry', () => {
    ready = false
    const view = render(<AgentManagementPage />)
    expect(screen.queryByRole('button', { name: 'Open skill-source settings' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Loading configuration')
    ready = true; config.llm_config.proceduralSkillPackages = []
    view.rerender(<AgentManagementPage />)
    expect(screen.getByText('No procedural skill sources configured')).toBeInTheDocument(); expect(action()).toBeEnabled()
    expect(h.navigate).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
  })
  it('localizes the explicit destination action and notice without changing Back to Settings or sending source identity', () => {
    language = 'zh-CN'; render(<AgentManagementPage />)
    expect(screen.getByText('环境设置')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开技能来源设置' }))
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'layout/openTab', payload: { id: 'tab-settings', label: '设置', routePath: '/settings', closable: true } })
    expect(h.navigate).toHaveBeenLastCalledWith('/settings?tab=environment', { state: null })
    fireEvent.click(screen.getByRole('button', { name: '返回设置' }))
    expect(h.navigate).toHaveBeenLastCalledWith('/settings'); expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
  })
})
