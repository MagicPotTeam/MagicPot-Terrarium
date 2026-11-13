import React from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import AgentManagementPage from './AgentManagementPage'

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  dispatch: vi.fn(),
  save: vi.fn(),
  api: vi.fn(() => { throw new Error('No management service read for static disclosure') }),
  fetch: vi.fn(() => { throw new Error('No target or provider probe') }),
  openDatabase: vi.fn(() => { throw new Error('No conversation database read on mount') })
}))
let config: Config, ready = true, language = 'en'
const location = Object.freeze({ pathname: '/agent-management', search: '', hash: '', key: 'deployment-static-fixture', state: null })
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config, isReady: ready, updateConfig: h.save }) }))
vi.mock('@renderer/store', () => ({ useAppDispatch: () => h.dispatch }))
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate, useLocation: () => location }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language }, t: (key: string) => key }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
const sentinel = 'PRIVATE_DEPLOYMENT_URL_TOKEN_PATH_NOT_FOR_DOM'
const strictPage = () => <React.StrictMode><AgentManagementPage /></React.StrictMode>
const deployment = () => screen.getByRole('region', { name: language.startsWith('zh') ? '运行时与部署' : 'Runtime and deployment' })
const noEffects = () => {
  expect(h.api).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled()
  expect(h.openDatabase).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
  expect(h.dispatch).not.toHaveBeenCalled(); expect(h.navigate).not.toHaveBeenCalled()
}
function expectDisclosure() {
  const section = deployment()
  if (language.startsWith('zh')) {
    expect(within(section).getByText('此本地配置视图暂不可用')).toBeVisible()
    expect(section).not.toHaveTextContent('规范的目标归属')
  } else {
    expect(within(section).getByText('Unavailable in this local-config view')).toBeVisible()
    expect(section).not.toHaveTextContent('canonical target owner')
  }
  expect(section).not.toHaveTextContent(/\b0\s+(?:machines|targets|nodes)\b|\bdisconnected\b|没有(?:部署)?目标|0\s*台|已断开/i)
  expect(section.querySelector('button,a,input,select,textarea,table,ul,ol,[role="button"],[role="status"],[role="list"]')).toBeNull()
  return section
}

beforeEach(() => {
  vi.clearAllMocks(); ready = true; language = 'en'; config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [{ id: 'configured-profile', model_name: 'configured-model', provider: 'openai', call_type: 'text', api_key: sentinel, base_url: sentinel, local_model_path: sentinel }]
  config.llm_config.proceduralSkillPackages = [{ id: 'registered-source', directory: sentinel, enabled: true }]
  config.remote_llm_server_config = { server_origin: sentinel, access_token: sentinel }
  config.local_llm_server_config = { ...config.local_llm_server_config, bind_host: sentinel, access_token: sentinel }
  vi.stubGlobal('fetch', h.fetch); vi.stubGlobal('indexedDB', { open: h.openDatabase })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('static deployment unavailable explanation on the real management page under StrictMode', () => {
  it.each(['en', 'zh-CN'] as const)('explains the missing owner/read path in %s without an empty or disconnected target claim', locale => {
    language = locale; const before = structuredClone(config)
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem')
    const { container } = render(strictPage())
    expectDisclosure(); expect(container.innerHTML).not.toContain(sentinel); expect(config).toEqual(before)
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); noEffects()
  })
  it('preserves the other unavailable sections and all separate existing manual controls without adding deployment actions', () => {
    render(strictPage()); expectDisclosure()
    for (const name of ['Account identity', 'Persistence']) {
      const section = screen.getByRole('region', { name })
      expect(within(section).getByText('Unavailable in this local-config view')).toBeVisible()
      expect(section).not.toHaveTextContent(/canonical target owner|Deploy and Start/)
    }
    expect(screen.getAllByText('Unavailable in this local-config view')).toHaveLength(3)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
      'Back to Settings', 'Open model-profile settings', 'Open skill-source settings',
      'Read existing conversation summaries', 'Read installed catalog',
      'Show bundled declarations', 'Read startup storage metadata', 'Open Studio workspace'
    ])
    expect(screen.getByText('Not loaded — use Read existing conversation summaries')).toBeVisible()
    expect(screen.getByText('Not loaded — use Read installed catalog')).toBeVisible()
    expect(screen.getByText('Not shown — use Show bundled declarations')).toBeVisible()
    expect(screen.getByText('Not loaded — use Read startup storage metadata')).toBeVisible(); noEffects()
  })
  it('does not turn config readiness, remote mode, locale, focus or elapsed time into a target observation', async () => {
    ready = false; vi.useFakeTimers()
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem')
    const view = render(strictPage()); expectDisclosure()
    expect(screen.getByRole('status')).toHaveTextContent('Loading configuration')
    ready = true; config = { ...config, use_remote_llm: true }; view.rerender(strictPage()); expectDisclosure()
    expect(screen.getByRole('button', { name: 'Open model-profile settings' })).toBeDisabled()
    language = 'zh-CN'; view.rerender(strictPage()); expectDisclosure()
    act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) }); expectDisclosure()
    config = { ...config, use_remote_llm: false }; language = 'en'; view.rerender(strictPage()); expectDisclosure()
    expect(screen.getByRole('button', { name: 'Open model-profile settings' })).toBeEnabled()
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); noEffects()
  })
  it.each(['remote_llm_server_config', 'local_llm_server_config'] as const)('does not read %s even when the current mode is remote', key => {
    const getter = vi.fn((): never => { throw new Error('Excluded proxy settings must not be inspected') })
    config.use_remote_llm = true
    Object.defineProperty(config, key, { configurable: true, enumerable: true, get: getter })
    const { container } = render(strictPage()); expectDisclosure()
    expect(getter).not.toHaveBeenCalled(); expect(container.innerHTML).not.toContain(sentinel); noEffects()
  })
  it.each(['en', 'zh-CN'] as const)('keeps a remounted %s view unavailable without resuming, probing or rendering targets', locale => {
    language = locale
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem')
    const first = render(strictPage()); expectDisclosure(); first.unmount()
    render(strictPage()); expectDisclosure()
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); noEffects()
  })
})
