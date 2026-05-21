import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import SettingsPage from './SettingsPage'

let currentLanguage = 'zh-CN'
let currentThemeMode: 'light' | 'dark' = 'light'
let translations: Record<string, string> = {
  'menu.settings': '\u8bbe\u7f6e',
  'settings.tabs.general': '\u4e00\u822c\u8bbe\u7f6e',
  'settings.tabs.environment': '\u73af\u5883\u90e8\u7f72',
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
  useLocation: () => ({ state: {} })
}))

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
    isReady: true,
    configUtils: {},
    updateConfig: vi.fn()
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
  currentLanguage = 'zh-CN'
  currentThemeMode = 'light'
  translations = {
    'menu.settings': '\u8bbe\u7f6e',
    'settings.tabs.general': '\u4e00\u822c\u8bbe\u7f6e',
    'settings.tabs.environment': '\u73af\u5883\u90e8\u7f72',
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
    const quickAppTab = screen.getByText('\u5feb\u5e94\u7528 API')

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

  it('uses the light theme background and text colors when the UI mode is light', () => {
    const { container } = render(<SettingsPage />)

    const root = container.firstElementChild as HTMLElement
    const styles = window.getComputedStyle(root)

    expect(styles.backgroundColor).toBe('rgb(231, 234, 245)')
    expect(styles.color).toBe('rgb(17, 17, 17)')
  })
})
