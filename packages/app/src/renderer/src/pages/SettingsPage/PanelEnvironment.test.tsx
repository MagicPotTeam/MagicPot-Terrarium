import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import PanelEnvironment from './PanelEnvironment'

const translations: Record<string, string> = {
  'llm.proxy_mode_title': '魔壶代理模式',
  'llm.proxy_mode_desc': '魔壶代理模式说明',
  'environment.comfyui_title': 'ComfyUI Settings',
  'environment.comfyui_desc': 'Unified ComfyUI endpoint',
  'environment.comfy_batch_profiles_title': 'ComfyUI Instances',
  'environment.setup_title': 'Environment Setup',
  'environment.python_cmd_label': 'Python Command',
  'environment.comfy_dir_label': 'ComfyUI Directory',
  'environment.comfy_port_label': 'ComfyUI Port',
  'environment.comfy_args_label': 'ComfyUI Arguments',
  'environment.comfy_batch_profiles_desc': 'Separate ComfyUI endpoints',
  'qapp.batch.enabled': 'Enabled',
  'qapp.batch.name': 'Name',
  'qapp.batch.url': 'ComfyUI Endpoint',
  'qapp.batch.concurrency': 'Concurrency',
  'qapp.batch.test': 'Test',
  'qapp.batch.add_instance': 'Add instance',
  'qapp.batch.save_instances': 'Save instances',
  'qapp.batch.delete_instance': 'Delete instance',
  'qapp.batch.saved': 'Saved'
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
  },
  svcComfyBatch: {
    listProfiles: vi.fn().mockResolvedValue({
      profiles: [
        {
          id: 'remote-1',
          name: 'Remote GPU',
          baseUrl: 'https://comfy.example.com',
          enabled: true,
          maxConcurrency: 2
        }
      ]
    }),
    replaceProfiles: vi.fn().mockImplementation(async ({ profiles }) => ({ profiles })),
    probeProfile: vi.fn()
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

  it('renders unified ComfyUI settings and batch profiles without a mode switch', async () => {
    render(
      <PanelEnvironment
        settingsValue={{ ...DEFAULT_CONFIG, use_remote_comfyui: true }}
        saveSettings={vi.fn()}
      />
    )

    const comfySection = (await screen.findByRole('heading', { name: 'ComfyUI Settings' })).closest(
      'section'
    )
    const proxySection = (await screen.findByRole('heading', { name: '魔壶代理模式' })).closest(
      'section'
    )

    expect(comfySection).toBeTruthy()
    expect(proxySection).toBeTruthy()
    if (!comfySection || !proxySection) {
      throw new Error('Expected settings sections to render.')
    }
    expect(
      comfySection.compareDocumentPosition(proxySection) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getAllByText('ComfyUI Endpoint').length).toBeGreaterThan(0)
    expect(await screen.findByRole('heading', { name: 'Environment Setup' })).toBeTruthy()
    expect(screen.getAllByText('Python Command').length).toBeGreaterThan(0)
    expect(screen.getAllByText('ComfyUI Directory').length).toBeGreaterThan(0)
    expect(screen.getAllByText('ComfyUI Port').length).toBeGreaterThan(0)
    expect(screen.getAllByText('ComfyUI Arguments').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'ComfyUI Instances' })).toBeTruthy()
    expect(await screen.findByDisplayValue('https://comfy.example.com')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add instance' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'ComfyUI Mode' })).toBeNull()
  })

  it('shows probe latency beside the ComfyUI startup switch instead of Enabled', async () => {
    apiMock.svcComfyBatch.probeProfile.mockResolvedValueOnce({
      result: {
        ok: true,
        baseUrl: 'https://comfy.example.com',
        latencyMs: 7
      }
    })
    render(<PanelEnvironment settingsValue={DEFAULT_CONFIG} saveSettings={vi.fn()} />)

    await screen.findByDisplayValue('https://comfy.example.com')
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }))

    expect(await screen.findByRole('switch', { name: '7 ms' })).toBeTruthy()
    expect(screen.queryByText('Enabled')).toBeNull()
  })

  it('shows probe errors below the ComfyUI endpoint field', async () => {
    apiMock.svcComfyBatch.probeProfile.mockRejectedValueOnce(new Error('fetch failed'))
    render(<PanelEnvironment settingsValue={DEFAULT_CONFIG} saveSettings={vi.fn()} />)

    const endpoint = await screen.findByDisplayValue('https://comfy.example.com')
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }))

    const error = await screen.findByText('fetch failed')
    expect(endpoint.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'fetch failed' })).toBeNull()
    expect(screen.queryByText('Enabled')).toBeNull()
  })
})
