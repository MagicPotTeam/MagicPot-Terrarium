import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import SettingsPage from './SettingsPage'

const managementNavigation = vi.hoisted(() => ({ navigate: vi.fn(), dispatch: vi.fn(), updateConfig: vi.fn(), isReady: true }))

let currentLanguage = 'zh-CN'
let currentThemeMode: 'light' | 'dark' = 'light'
let translations: Record<string, string> = {
  'menu.settings': '\u8bbe\u7f6e',
  'settings.tabs.general': '\u4e00\u822c\u8bbe\u7f6e',
  'settings.tabs.environment': '\u73af\u5883\u90e8\u7f72',
  'settings.tabs.plugin': '\u63d2\u4ef6 API',
  'settings.tabs.llm': 'Agent\u7ebf\u7a0b\u914d\u7f6e',
  'settings.tabs.mcp': 'MCP',
  'settings.tabs.about': '\u5173\u4e8e',
  'settings.tab_descs.general': '\u8bed\u8a00\u3001\u4e3b\u9898\u3001\u4fdd\u5b58\u8def\u5f84',
  'settings.tab_descs.environment': 'ComfyUI \u90e8\u7f72\u4e0e\u6a21\u578b\u76ee\u5f55',
  'settings.tab_descs.about': '\u7248\u672c\u4fe1\u606f\u4e0e\u5f00\u53d1\u8005',
  'general.close': '\u5173\u95ed'
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: currentLanguage },
    t: (key: string) => translations[key] ?? key
  })
}))

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ state: {}, search: '' }),
  useNavigate: () => managementNavigation.navigate
}))

vi.mock('@renderer/store', () => ({ useAppDispatch: () => managementNavigation.dispatch }))

vi.mock('@mui/material/styles', async () => {
  const actual =
    await vi.importActual<typeof import('@mui/material/styles')>('@mui/material/styles')
  return {
    ...actual,
    useTheme: () => ({
      palette: {
        mode: currentThemeMode,
        background: {
          default: currentThemeMode === 'light' ? '#e7eaf5' : '#1a1a1a'
        },
        text: {
          primary: currentThemeMode === 'light' ? '#111111' : '#ffffff',
          secondary: currentThemeMode === 'light' ? '#4d4d4d' : '#b0b0b0'
        }
      }
    })
  }
})

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: DEFAULT_CONFIG,
    buildEnv: {},
    isReady: managementNavigation.isReady,
    configUtils: {},
    updateConfig: managementNavigation.updateConfig
  })
}))

vi.mock('./PanelGeneral', () => ({
  default: () => <div data-testid="panel-general" />
}))

vi.mock('./PanelEnvironment', () => ({
  default: () => <div data-testid="panel-environment" />
}))

vi.mock('./PanelLLM', () => ({
  default: () => <div data-testid="panel-llm" />
}))

vi.mock('./PanelPlugin', () => ({
  default: () => <div data-testid="panel-plugin" />
}))

vi.mock('./PanelMcp', () => ({
  default: () => <div data-testid="panel-mcp" />
}))

vi.mock('./PanelAbout', () => ({
  default: () => <div data-testid="panel-about" />
}))

beforeEach(() => {
  managementNavigation.navigate.mockReset(); managementNavigation.dispatch.mockReset(); managementNavigation.updateConfig.mockReset(); managementNavigation.isReady = true
  currentLanguage = 'zh-CN'
  currentThemeMode = 'light'
  translations = {
    'menu.settings': '\u8bbe\u7f6e',
    'settings.tabs.general': '\u4e00\u822c\u8bbe\u7f6e',
    'settings.tabs.environment': '\u73af\u5883\u90e8\u7f72',
    'settings.tabs.plugin': '\u63d2\u4ef6 API',
    'settings.tabs.llm': 'Agent\u7ebf\u7a0b\u914d\u7f6e',
    'settings.tabs.mcp': 'MCP',
    'settings.tabs.about': '\u5173\u4e8e',
    'settings.tab_descs.general': '\u8bed\u8a00\u3001\u4e3b\u9898\u3001\u4fdd\u5b58\u8def\u5f84',
    'settings.tab_descs.environment': 'ComfyUI \u90e8\u7f72\u4e0e\u6a21\u578b\u76ee\u5f55',
    'settings.tab_descs.about': '\u7248\u672c\u4fe1\u606f\u4e0e\u5f00\u53d1\u8005',
    'general.close': '\u5173\u95ed'
  }
})

describe('SettingsPage', () => {
  it('shows the Agent thread settings, Quick App API, and MCP tabs in the Chinese UI', async () => {
    render(<SettingsPage />)

    const agentTab = await screen.findByText('Agent线程配置')
    const quickAppTab = screen.getByText('\u63d2\u4ef6 API')

    expect(agentTab).toBeTruthy()
    expect(quickAppTab).toBeTruthy()
    expect(
      quickAppTab.compareDocumentPosition(agentTab) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByText('MCP')).toBeTruthy()
    expect(screen.queryByTestId('panel-assistant')).toBeNull()
  })

  it('does not repeat the active tab title in the content area', () => {
    render(<SettingsPage />)

    expect(screen.getAllByText('\u4e00\u822c\u8bbe\u7f6e')).toHaveLength(1)
  })

  it('opens the management tab only from its real mounted Settings action without editing config', () => {
    currentLanguage = 'en'; render(<SettingsPage />)
    expect(managementNavigation.dispatch).not.toHaveBeenCalled(); expect(managementNavigation.navigate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Agent management' }))
    expect(managementNavigation.dispatch).toHaveBeenCalledWith({ type: 'layout/openTab', payload: { id: 'tab-agent-management', label: 'Agent management', routePath: '/agent-management', closable: true } })
    expect(managementNavigation.navigate).toHaveBeenCalledWith('/agent-management')
    expect(managementNavigation.dispatch.mock.invocationCallOrder[0]).toBeLessThan(managementNavigation.navigate.mock.invocationCallOrder[0])
    expect(managementNavigation.updateConfig).not.toHaveBeenCalled()
  })
  it('offers a localized management entry while the existing config is loading', () => {
    managementNavigation.isReady = false; render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Agent 管理' }))
    expect(managementNavigation.navigate).toHaveBeenCalledWith('/agent-management')
    expect(managementNavigation.updateConfig).not.toHaveBeenCalled()
  })
  it('uses the light theme background and text colors when the UI mode is light', () => {
    const { container } = render(<SettingsPage />)

    const root = container.firstElementChild as HTMLElement
    const styles = window.getComputedStyle(root)

    expect(styles.backgroundColor).toBe('rgb(231, 234, 245)')
    expect(styles.color).toBe('rgb(17, 17, 17)')
  })
})
