import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import PanelEnvironment from './PanelEnvironment'

const translations: Record<string, string> = {
  'llm.proxy_mode_title': '魔壶代理模式',
  'llm.proxy_mode_desc': '魔壶代理模式说明',
  'environment.comfy_mode_title': 'ComfyUI Mode',
  'environment.comfy_mode_info_title': 'ComfyUI Mode',
  'environment.comfy_mode_info_desc': 'ComfyUI mode description',
  'environment.comfy_mode_label': 'Use Remote ComfyUI',
  'environment.remote_comfyui_title': 'Remote ComfyUI Settings',
  'environment.remote_comfyui_origin_label': 'Remote ComfyUI Origin'
}

const apiMock = {
  svcHyper: {
    listFastSettingTemplates: vi.fn().mockResolvedValue({ templates: [] }),
    getFastSettingValue: vi.fn().mockResolvedValue({ pythonCmd: '', comfyuiDir: '' }),
    getExtraModelPaths: vi.fn().mockResolvedValue({})
  },
  svcDialog: {
    showOpenDialog: vi.fn()
  },
  svcState: {
    getStorageLocations: vi.fn().mockResolvedValue({ locations: [] }),
    getLlmProxyAccessUsage: vi.fn().mockResolvedValue({
      running: false,
      usage: []
    })
  },
  svcShell: {
    openPath: vi.fn()
  }
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string) => translations[key] ?? key
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => apiMock
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: vi.fn(),
    notifyInfo: vi.fn(),
    notifySuccess: vi.fn(),
    notifyWarning: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    buildEnv: {
      env: { buildMode: 'embedded' },
      pathMap: { file: 'C:/MagicPot' },
      embeddedDefaults: {
        comfyuiDir: 'C:/ComfyUI',
        pythonCmd: 'python',
        comfyuiArgs: ['--port', '8188']
      }
    }
  })
}))

vi.mock('@renderer/store', () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      layout: {
        lastActiveProjectId: null,
        openTabs: []
      }
    })
}))

vi.mock('./components/SettingSection', () => ({
  default: ({ title, children }: { title?: ReactNode; children: ReactNode }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  )
}))

vi.mock('./components/EnvironmentInfo', () => ({
  default: () => <div>Environment info</div>
}))

vi.mock('./components/DataStorageInfo', () => ({
  default: () => <div>Data storage</div>
}))

vi.mock('@renderer/components/PureConfigNotSetCallout', () => ({
  default: () => null
}))

vi.mock('@renderer/components/RemoteConfigNotSetCallout', () => ({
  default: () => null
}))

vi.mock('./components/FastSettingErrorModal', () => ({
  FastSettingErrorModal: () => null
}))

vi.mock('@renderer/pages/ProjectCanvasPage/Dialogs/FigmaBindingDialog', () => ({
  default: () => null
}))

vi.mock('@renderer/pages/ProjectCanvasPage/canvasStorage', () => ({
  loadCanvasItems: vi.fn().mockResolvedValue({
    items: [],
    groups: [],
    groupBranches: [],
    figmaBinding: null
  }),
  saveCanvasItems: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@renderer/pages/ProjectCanvasPage/projectCanvasPageShared', () => ({
  getCanvasItemsBounds: vi.fn(() => null)
}))

beforeEach(() => {
  ;(
    window as typeof window & {
      path: {
        isAbsolute: (value: string) => boolean
        normalize: (value: string) => string
        relative: (from: string, to: string) => string
        join: (...parts: string[]) => string
      }
    }
  ).path = {
    isAbsolute: (value: string) => /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/'),
    normalize: (value: string) => value.replace(/\\/g, '/'),
    relative: (_from: string, to: string) => to,
    join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')
  } as typeof window.path
})

describe('PanelEnvironment', () => {
  it('shows the proxy mode section and bridge sections in Chinese UI', async () => {
    render(<PanelEnvironment settingsValue={DEFAULT_CONFIG} saveSettings={vi.fn()} />)

    expect(await screen.findByText('Data storage')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '魔壶代理模式' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'DCC 桥接' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Adobe 桥接' })).toBeTruthy()
  })

  it('renders remote ComfyUI settings directly after the ComfyUI mode section', async () => {
    render(
      <PanelEnvironment
        settingsValue={{ ...DEFAULT_CONFIG, use_remote_comfyui: true }}
        saveSettings={vi.fn()}
      />
    )

    const comfyModeSection = (await screen.findByRole('heading', { name: 'ComfyUI Mode' })).closest(
      'section'
    )
    const remoteSection = (
      await screen.findByRole('heading', { name: 'Remote ComfyUI Settings' })
    ).closest('section')
    const proxySection = (await screen.findByRole('heading', { name: '魔壶代理模式' })).closest(
      'section'
    )

    expect(comfyModeSection).toBeTruthy()
    expect(remoteSection).toBeTruthy()
    expect(proxySection).toBeTruthy()
    if (!comfyModeSection || !remoteSection || !proxySection) {
      throw new Error('Expected settings sections to render.')
    }
    expect(
      comfyModeSection.compareDocumentPosition(remoteSection) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      remoteSection.compareDocumentPosition(proxySection) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getAllByText('Remote ComfyUI Origin').length).toBeGreaterThan(0)
  })
})
