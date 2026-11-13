import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import AgentManagementPage from './AgentManagementPage'
import { projectLocalConfigOverview } from './localConfigOverview'

const effects = vi.hoisted(() => ({
  navigate: vi.fn(),
  dispatch: vi.fn(),
  save: vi.fn(),
  api: vi.fn(() => {
    throw new Error('Management mount must not access services')
  })
}))
let config: Config
let ready = true
let language = 'en'
vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({ config, isReady: ready, updateConfig: effects.save })
}))
vi.mock('@renderer/store', () => ({ useAppDispatch: () => effects.dispatch }))
vi.mock('react-router-dom', () => ({ useNavigate: () => effects.navigate, useLocation: () => locationFixture }))
const locationFixture = Object.freeze({ pathname: '/agent-management', search: '', hash: '', key: 'overview-fixture', state: null })
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language }, t: (key: string) => key })
}))
vi.mock('@renderer/utils/windowUtils', () => ({ api: effects.api }))
const sentinel = 'SECRET_FIELD_MUST_NOT_REACH_DTO_OR_DOM'
function fixture(): Config {
  const data = structuredClone(DEFAULT_CONFIG)
  data.llm_config.api_profiles = [
    {
      id: 'profile-local',
      model_name: 'model-configured',
      provider: 'openai',
      call_type: 'text',
      base_url: sentinel,
      api_key: sentinel,
      api_secret: sentinel,
      auth_account_email: sentinel,
      auth_connected_at: sentinel,
      local_model_path: sentinel,
      backup_api_keys: [sentinel],
      tencent_secret_id: sentinel,
      tencent_secret_key: sentinel,
      tagger_endpoint: sentinel
    }
  ]
  data.llm_config.proceduralSkillPackages = [
    { id: 'source-directory', directory: sentinel, enabled: true },
    {
      id: 'source-manifest',
      directory: sentinel,
      source: 'manifest',
      enabled: false,
      projectId: 'tab-project-existing'
    }
  ]
  data.remote_llm_server_config.access_token = sentinel
  return data
}
beforeEach(() => {
  vi.clearAllMocks()
  config = fixture()
  ready = true
  language = 'en'
  vi.stubGlobal('api', undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe('local-config management overview', () => {
  it('mounts the explicit session-summary action without reading session or project storage automatically', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem')
    const { container } = render(<React.StrictMode><AgentManagementPage /></React.StrictMode>)
    expect(screen.getByRole('button', { name: 'Show bundled declarations' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Not shown — use Show bundled declarations')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read installed catalog' })).toBeEnabled()
    expect(screen.getByText('Not loaded — use Read installed catalog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read existing conversation summaries' })).toBeEnabled()
    expect(screen.getByText('Not loaded — use Read existing conversation summaries')).toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
    expect(container.innerHTML).not.toContain(sentinel)
    expect(effects.api).not.toHaveBeenCalled()
    get.mockRestore()
  })
  it('reveals only bundled declarations on explicit page action without triggering live catalog or session services', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Show bundled declarations' }))
    const preview = screen.getByRole('region', { name: 'Bundled creative-tool declarations' })
    expect(within(preview).getAllByRole('listitem')).toHaveLength(21)
    expect(within(preview).getByText('terminal.run')).toBeInTheDocument()
    expect(screen.getByText('Not loaded — use Read installed catalog')).toBeInTheDocument()
    expect(screen.getByText('Not loaded — use Read existing conversation summaries')).toBeInTheDocument()
    expect(effects.api).not.toHaveBeenCalled(); expect(effects.save).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled()
    get.mockRestore(); set.mockRestore()
  })
  it('projects only named profile/source fields, omits credentials/paths and leaves input unchanged', () => {
    const before = structuredClone(config)
    const result = projectLocalConfigOverview(config)
    expect(result).toEqual({
      profiles: [
        {
          id: 'profile-local',
          modelName: 'model-configured',
          provider: 'openai',
          callType: 'text'
        }
      ],
      sources: [
        { id: 'source-directory', source: 'directory', enabled: true },
        {
          id: 'source-manifest',
          source: 'manifest',
          enabled: false,
          projectId: 'tab-project-existing'
        }
      ]
    })
    expect(JSON.stringify(result)).not.toContain(sentinel)
    expect(config).toEqual(before)
    result.profiles[0].modelName = 'detached change'
    expect(config.llm_config.api_profiles[0].model_name).toBe('model-configured')
  })
  it('does not even read excluded getters while building its detached DTO', () => {
    Object.defineProperty(config.llm_config.api_profiles[0], 'api_key', {
      get: () => {
        throw new Error('Excluded secret read')
      }
    })
    Object.defineProperty(config.llm_config.proceduralSkillPackages![0], 'directory', {
      get: () => {
        throw new Error('Excluded path read')
      }
    })
    expect(projectLocalConfigOverview(config).profiles[0].modelName).toBe('model-configured')
  })
  it('distinguishes loading from loaded-empty without exposing stale defaults or calling any services', () => {
    ready = false
    const view = render(
      <React.StrictMode>
        <AgentManagementPage />
      </React.StrictMode>
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading configuration')
    expect(screen.queryByText('profile-local')).toBeNull()
    expect(screen.queryByText('No model profiles configured')).toBeNull()
    ready = true
    config.llm_config.api_profiles = []
    config.llm_config.proceduralSkillPackages = undefined
    view.rerender(
      <React.StrictMode>
        <AgentManagementPage />
      </React.StrictMode>
    )
    expect(screen.getByText('No model profiles configured')).toBeInTheDocument()
    expect(screen.getByText('No procedural skill sources configured')).toBeInTheDocument()
    expect(effects.api).not.toHaveBeenCalled()
    expect(effects.save).not.toHaveBeenCalled()
  })
  it('shows inert whitelisted metadata with unavailable sections, no auth/runtime/usage/catalog calls or editors', () => {
    config.llm_config.api_profiles[0].model_name = '<img src=x onerror="window.SECRET=1">'
    const { container } = render(
      <React.StrictMode>
        <AgentManagementPage />
      </React.StrictMode>
    )
    expect(screen.getByRole('heading', { name: 'Agent management' })).toBeInTheDocument()
    expect(screen.getByText(config.llm_config.api_profiles[0].model_name)).toBeInTheDocument()
    expect(container.innerHTML).not.toContain(sentinel)
    expect(container.querySelector('img,script,input,textarea,select')).toBeNull()
    for (const heading of [
      'Account identity',
      'Persistence',
      'Runtime and deployment'
    ]) {
      const region = screen.getByRole('region', { name: heading })
      expect(within(region).getByText('Unavailable in this local-config view')).toBeInTheDocument()
    }
    expect(screen.getByText('Skill sources')).toBeInTheDocument()
    expect(effects.api).not.toHaveBeenCalled()
    expect(effects.save).not.toHaveBeenCalled()
    expect(effects.dispatch).not.toHaveBeenCalled()
    expect(effects.navigate).not.toHaveBeenCalled()
  })
  it('reflects updates from the existing config context without a reload/watch or mutation', () => {
    const view = render(<AgentManagementPage />)
    expect(screen.getByText('model-configured')).toBeInTheDocument()
    config = {
      ...config,
      llm_config: {
        ...config.llm_config,
        api_profiles: [{ ...config.llm_config.api_profiles[0], model_name: 'context-updated' }]
      }
    }
    view.rerender(<AgentManagementPage />)
    expect(screen.getByText('context-updated')).toBeInTheDocument()
    expect(screen.queryByText('model-configured')).toBeNull()
    expect(effects.api).not.toHaveBeenCalled()
    expect(effects.save).not.toHaveBeenCalled()
  })
  it('returns explicitly to the existing Settings tab only on click', () => {
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Back to Settings' }))
    expect(effects.dispatch).toHaveBeenCalledWith({
      type: 'layout/openTab',
      payload: { id: 'tab-settings', label: 'Settings', routePath: '/settings', closable: true }
    })
    expect(effects.navigate).toHaveBeenCalledWith('/settings')
    expect(effects.save).not.toHaveBeenCalled()
  })
  it('renders the management purpose and unavailable state in the Chinese UI', () => {
    language = 'zh-CN'
    render(<AgentManagementPage />)
    expect(screen.getByRole('heading', { name: 'Agent 管理' })).toBeInTheDocument()
    expect(screen.getAllByText('此本地配置视图暂不可用')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '读取已安装目录' })).toBeEnabled()
    expect(screen.getByText('尚未读取 — 请点击读取已安装目录')).toBeInTheDocument()
  })
})
