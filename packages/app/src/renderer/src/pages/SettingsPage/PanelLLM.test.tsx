import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { rendererHostExtensionApiV1 } from '@renderer/extensions/generatedRegistry'
import { createEmptyCustomSkill, getCustomSkillValidationIssues } from './PanelLLM'
import PanelLLM from './PanelLLM'

const showMessageBoxMock = vi.fn()
const clearHy3DCosPrefixMock = vi.fn()
const notifyInfoMock = vi.fn(() => 'message-key')
const notifySuccessMock = vi.fn()
const notifyWarningMock = vi.fn()
const closeMessageMock = vi.fn()

let currentLanguage = 'en-US'
let translations: Record<string, string> = {
  'quickapp_api.open_quickapp_api': 'Open Quick App API',
  'llm.quickapp_api_hint_title': 'Quick App API lives in the plugin tab',
  'llm.quickapp_api_hint':
    'Quick Apps, prompt assistance, image interrogation, and Hunyuan3D now use the separate Quick App API settings.',
  'llm.profile_title': 'Agent Thread Settings',
  'llm.model_name': 'Model Name',
  'llm.model_name_placeholder': 'Renderer Agent',
  'llm.base_url': 'Base URL',
  'llm.base_url_placeholder': 'https://example.com/v1',
  'llm.api_key': 'API Key',
  'llm.api_key_placeholder': 'sk-...',
  'llm.add_backup_key': 'Add Backup Key',
  'llm.backup_key': 'Backup Key',
  'llm.add_api_profile': 'Add API Profile'
}

type TranslationOptions = Record<string, unknown> & { defaultValue?: string }

const interpolateTranslation = (template: string, options?: TranslationOptions): string =>
  template.replace(/{{\s*(\w+)\s*}}/g, (_match, key: string) => {
    const value = options?.[key]
    return value === undefined || value === null ? '' : String(value)
  })

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: currentLanguage },
    t: (key: string, options?: TranslationOptions) =>
      interpolateTranslation(translations[key] ?? options?.defaultValue ?? key, options)
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcDialog: {
      showMessageBox: showMessageBoxMock
    },
    svcLLMProxy: {
      clearHy3DCosPrefix: clearHy3DCosPrefixMock
    }
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyInfo: notifyInfoMock,
    notifySuccess: notifySuccessMock,
    notifyWarning: notifyWarningMock,
    closeMessage: closeMessageMock
  })
}))

const buildSettingsWithProfile = (profile: Record<string, unknown>) => ({
  ...DEFAULT_CONFIG,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [
      {
        id: 'profile-1',
        model_name: 'Demo Model',
        base_url: 'https://example.com/v1',
        api_key: 'sk-test',
        ...profile
      }
    ]
  }
})

beforeEach(() => {
  currentLanguage = 'en-US'
  translations = {
    'quickapp_api.open_quickapp_api': 'Open Quick App API',
    'llm.quickapp_api_hint_title': 'Quick App API lives in the plugin tab',
    'llm.quickapp_api_hint':
      'Quick Apps, prompt assistance, image interrogation, and Hunyuan3D now use the separate Quick App API settings.',
    'llm.profile_title': 'Agent Thread Settings',
    'llm.model_name': 'Model Name',
    'llm.model_name_placeholder': 'Renderer Agent',
    'llm.base_url': 'Base URL',
    'llm.base_url_placeholder': 'https://example.com/v1',
    'llm.api_key': 'API Key',
    'llm.api_key_placeholder': 'sk-...',
    'llm.add_backup_key': 'Add Backup Key',
    'llm.backup_key': 'Backup Key',
    'llm.add_api_profile': 'Add API Profile'
  }
  delete rendererHostExtensionApiV1.chat
  delete rendererHostExtensionApiV1.settings
  vi.clearAllMocks()
})

describe('PanelLLM custom skill validation', () => {
  it('marks empty normal skills as incomplete', () => {
    const issues = getCustomSkillValidationIssues(createEmptyCustomSkill())

    expect(issues).toEqual([
      'Category is required.',
      'Skill Name is required.',
      'Prompt is required.'
    ])
  })

  it('requires an API address for agent skills', () => {
    const issues = getCustomSkillValidationIssues({
      ...createEmptyCustomSkill(),
      category: 'Ops',
      skillName: 'Renderer Agent',
      prompt: 'Route the task',
      type: 'agent'
    })

    expect(issues).toEqual(['Agent skills require an API Address.'])
  })
})

describe('PanelLLM Agent API settings', () => {
  it('hides custom skills and removes the Quick App API prompt', () => {
    render(<PanelLLM settingsValue={DEFAULT_CONFIG} saveSettings={vi.fn()} />)

    expect(screen.queryByText('Custom Skills')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Quick App API' })).toBeNull()
  })

  it('renders the call-type and capability selects without exposing protocol or deployment overrides', () => {
    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({})}
        saveSettings={vi.fn()}
        onSelectTab={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Call Type')).toBeInTheDocument()
    expect(screen.getByLabelText('Capability')).toBeInTheDocument()
    expect(screen.getByLabelText('Model Name')).toBeInTheDocument()
    expect(screen.queryByText('Protocol')).toBeNull()
    expect(screen.queryByText('Cloud / Local')).toBeNull()
  })

  it('routes Agent API settings through renderer extension seams', () => {
    const saveSettings = vi.fn()
    rendererHostExtensionApiV1.settings = {
      applyAgentApiProfileCallType: ({ callType, profile }) =>
        callType === 'codex'
          ? {
              ...profile,
              call_type: 'codex',
              base_url: 'https://api.openai.com/v1',
              api_key: ''
            }
          : undefined,
      buildAgentApiProfileCallTypeOptions: ({ baseOptions }) => [
        ...baseOptions,
        { label: 'Codex', value: 'codex' }
      ],
      renderAgentApiProfileCardExtra: () => <div>Extension settings loaded</div>,
      resolveAgentApiProfileUi: ({ baseUi }) => ({
        ...baseUi,
        modelNamePlaceholder: 'extension-model',
        showBaseUrlInput: false
      })
    }

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({})}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    expect(screen.queryByLabelText('Base URL')).toBeNull()
    expect(screen.getByText('Extension settings loaded')).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByLabelText('Call Type'))
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }))

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          expect.objectContaining({
            id: 'profile-1',
            call_type: 'codex',
            base_url: 'https://api.openai.com/v1',
            api_key: ''
          })
        ]
      }
    })
  })

  it('lets renderer extension extras replace the full Agent API profile list', () => {
    const saveSettings = vi.fn()
    rendererHostExtensionApiV1.settings = {
      buildAgentApiProfileCallTypeOptions: ({ baseOptions }) => [
        ...baseOptions,
        { label: 'Codex', value: 'codex' }
      ],
      renderAgentApiProfileCardExtra: ({ onReplaceProfiles, profiles }) => (
        <button
          type="button"
          onClick={() =>
            onReplaceProfiles(
              profiles.map((profile) => ({
                ...profile,
                api_key: '',
                auth_mode: undefined,
                call_type: undefined
              }))
            )
          }
        >
          Extension disconnect all
        </button>
      )
    }

    render(
      <PanelLLM
        settingsValue={{
          ...DEFAULT_CONFIG,
          llm_config: {
            ...DEFAULT_CONFIG.llm_config,
            api_profiles: [
              {
                id: 'codex-oauth',
                model_name: 'Codex OAuth',
                base_url: 'https://api.openai.com/v1',
                api_key: '',
                auth_mode: 'codex_oauth',
                call_type: 'codex'
              },
              {
                id: 'codex-call-type',
                model_name: 'Codex Call Type',
                base_url: 'https://api.openai.com/v1',
                api_key: 'codex-token',
                call_type: 'codex'
              }
            ]
          }
        }}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Extension disconnect all' })[0])

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          expect.objectContaining({
            id: 'codex-oauth',
            api_key: '',
            auth_mode: undefined,
            call_type: undefined
          }),
          expect.objectContaining({
            id: 'codex-call-type',
            api_key: '',
            auth_mode: undefined,
            call_type: undefined
          })
        ]
      }
    })
  })

  it('creates new profiles with the explicit default provider and capability options', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM settingsValue={DEFAULT_CONFIG} saveSettings={saveSettings} onSelectTab={vi.fn()} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add API Profile' }))

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          expect.objectContaining({
            provider: 'default',
            model_use: 'default'
          })
        ]
      }
    })
  })

  it('clears old protocol overrides when the API address is edited', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Gemini Demo',
          base_url: 'https://example.com/v1',
          api_key: 'sk-test',
          deployment: 'cloud',
          provider: 'gemini'
        })}
        saveSettings={saveSettings}
      />
    )

    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://generativelanguage.googleapis.com/v1beta' }
    })
    fireEvent.blur(screen.getByLabelText('Base URL'))

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          {
            id: 'profile-1',
            model_name: 'Gemini Demo',
            base_url: 'https://generativelanguage.googleapis.com/v1beta',
            api_key: 'sk-test',
            provider: 'default',
            is_ollama: false
          }
        ]
      }
    })
  })

  it('infers local mode from a localhost API address without keeping the old deployment flag', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Gemini Demo',
          base_url: '',
          api_key: '',
          deployment: 'cloud',
          provider: 'gemini'
        })}
        saveSettings={saveSettings}
      />
    )

    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'http://127.0.0.1:8000/v1' }
    })
    fireEvent.blur(screen.getByLabelText('Base URL'))

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          {
            id: 'profile-1',
            model_name: 'Gemini Demo',
            base_url: 'http://127.0.0.1:8000/v1',
            api_key: '',
            provider: 'default',
            is_ollama: false
          }
        ]
      }
    })
  })

  it('stores the explicit default capability without leaving vision flags enabled', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_use: 'vision',
          is_vision_model: true,
          is_ocr_model: false
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    const capabilitySelect = screen.getByLabelText('Capability')
    fireEvent.mouseDown(capabilitySelect)
    fireEvent.click(screen.getByRole('option', { name: 'Default' }))

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          {
            id: 'profile-1',
            model_name: 'Demo Model',
            base_url: 'https://example.com/v1',
            api_key: 'sk-test',
            model_use: 'default',
            provider: 'default',
            is_ollama: false,
            is_vision_model: false,
            is_ocr_model: false
          }
        ]
      }
    })
  })

  it('marks OCR capability as vision-capable and OCR-capable', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({})}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    const capabilitySelect = screen.getByLabelText('Capability')
    fireEvent.mouseDown(capabilitySelect)
    fireEvent.click(screen.getByRole('option', { name: 'OCR' }))

    expect(saveSettings).toHaveBeenCalledWith({
      llm_config: {
        api_profiles: [
          {
            id: 'profile-1',
            model_name: 'Demo Model',
            base_url: 'https://example.com/v1',
            api_key: 'sk-test',
            model_use: 'ocr',
            provider: 'default',
            is_ollama: false,
            is_vision_model: true,
            is_ocr_model: true
          }
        ]
      }
    })
  })

  it('marks multimodal capability as vision-capable without enabling OCR', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({})}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    const capabilitySelect = screen.getByLabelText('Capability')
    fireEvent.mouseDown(capabilitySelect)
    fireEvent.click(screen.getByRole('option', { name: 'Multimodal' }))

    expect(saveSettings).toHaveBeenCalledWith({
      llm_config: {
        api_profiles: [
          {
            id: 'profile-1',
            model_name: 'Demo Model',
            base_url: 'https://example.com/v1',
            api_key: 'sk-test',
            model_use: 'multimodal',
            provider: 'default',
            is_ollama: false,
            is_vision_model: true,
            is_ocr_model: false
          }
        ]
      }
    })
  })

  it('marks general-agent capability as vision-capable without enabling OCR', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({})}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    const capabilitySelect = screen.getByLabelText('Capability')
    fireEvent.mouseDown(capabilitySelect)
    fireEvent.click(screen.getByRole('option', { name: 'General Agent' }))

    expect(saveSettings).toHaveBeenCalledWith({
      llm_config: {
        api_profiles: [
          {
            id: 'profile-1',
            model_name: 'Demo Model',
            base_url: 'https://example.com/v1',
            api_key: 'sk-test',
            model_use: 'agent',
            provider: 'default',
            is_ollama: false,
            is_vision_model: true,
            is_ocr_model: false
          }
        ]
      }
    })
  })

  it('stores image-generation capability without enabling vision or OCR flags', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({})}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    const capabilitySelect = screen.getByLabelText('Capability')
    fireEvent.mouseDown(capabilitySelect)
    fireEvent.click(screen.getByRole('option', { name: 'Image Generation' }))

    expect(saveSettings).toHaveBeenCalledWith({
      llm_config: {
        api_profiles: [
          {
            id: 'profile-1',
            model_name: 'Demo Model',
            base_url: 'https://example.com/v1',
            api_key: 'sk-test',
            model_use: 'image',
            provider: 'default',
            is_ollama: false,
            is_vision_model: false,
            is_ocr_model: false
          }
        ]
      }
    })
  })

  it('stores video-generation capability without enabling vision or OCR flags', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({})}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    const capabilitySelect = screen.getByLabelText('Capability')
    fireEvent.mouseDown(capabilitySelect)
    fireEvent.click(screen.getByRole('option', { name: 'Video Generation' }))

    expect(saveSettings).toHaveBeenCalledWith({
      llm_config: {
        api_profiles: [
          {
            id: 'profile-1',
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'sk-test',
            api_secret: '',
            backup_api_keys: undefined,
            model_use: 'video',
            provider: 'kling',
            deployment: 'cloud',
            is_ollama: false,
            is_vision_model: false,
            is_ocr_model: false
          }
        ]
      }
    })
  })

  it('preserves Kling video provider settings and stores SecretKey edits', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'kling-v3',
          base_url: 'https://api-beijing.klingai.com',
          api_key: 'access-id',
          api_secret: '',
          provider: 'kling',
          deployment: 'cloud',
          model_use: 'video'
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Video Provider')).toHaveTextContent('Kling')
    expect(screen.getByLabelText('Kling AccessKey')).toBeInTheDocument()
    expect(screen.getByLabelText('Kling SecretKey')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Backup Key' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Kling SecretKey'), {
      target: { value: 'secret-key' }
    })

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          expect.objectContaining({
            id: 'profile-1',
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'access-id',
            api_secret: 'secret-key',
            provider: 'kling',
            deployment: 'cloud',
            model_use: 'video'
          })
        ]
      }
    })
  })

  it.each([
    ['Default', 'default'],
    ['Chat', 'chat'],
    ['Image Generation', 'image']
  ])(
    'clears Kling SecretKey when switching a video profile back to %s capability',
    (optionName, expectedModelUse) => {
      const saveSettings = vi.fn()

      render(
        <PanelLLM
          settingsValue={buildSettingsWithProfile({
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'access-id',
            api_secret: 'secret-key',
            provider: 'kling',
            deployment: 'cloud',
            model_use: 'video'
          })}
          saveSettings={saveSettings}
          onSelectTab={vi.fn()}
        />
      )

      const capabilitySelect = screen.getByLabelText('Capability')
      fireEvent.mouseDown(capabilitySelect)
      fireEvent.click(screen.getByRole('option', { name: optionName }))

      const savedProfile = saveSettings.mock.lastCall?.[0]?.llm_config?.api_profiles?.[0]
      expect(savedProfile).toMatchObject({
        id: 'profile-1',
        model_use: expectedModelUse,
        provider: 'default'
      })
      expect(savedProfile?.deployment).toBeUndefined()
      expect(savedProfile?.api_secret).toBeUndefined()
    }
  )

  it('switches video profiles to Volcengine presets without keeping Kling secrets', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'kling-v3',
          base_url: 'https://api-beijing.klingai.com',
          api_key: 'access-id',
          api_secret: 'secret-key',
          backup_api_keys: ['backup-secret'],
          provider: 'kling',
          deployment: 'cloud',
          model_use: 'video'
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    const providerSelect = screen.getByLabelText('Video Provider')
    fireEvent.mouseDown(providerSelect)
    fireEvent.click(screen.getByRole('option', { name: 'Volcengine / BytePlus Seedance' }))

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          expect.objectContaining({
            id: 'profile-1',
            provider: 'volcengine',
            deployment: 'cloud',
            model_use: 'video',
            model_name: 'doubao-seedance-1-0-pro-250528',
            base_url: 'https://ark.cn-beijing.volces.com/api/v3',
            api_secret: undefined,
            is_vision_model: false,
            is_ocr_model: false
          })
        ]
      }
    })
  })

  it('clears Kling AccessKey and SecretKey when cloning a video profile', () => {
    const saveSettings = vi.fn()
    const randomUUIDSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000000')

    try {
      render(
        <PanelLLM
          settingsValue={buildSettingsWithProfile({
            model_name: 'kling-v3',
            base_url: 'https://api-beijing.klingai.com',
            api_key: 'access-id',
            api_secret: 'secret-key',
            provider: 'kling',
            deployment: 'cloud',
            model_use: 'video'
          })}
          saveSettings={saveSettings}
          onSelectTab={vi.fn()}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Clone' }))

      expect(saveSettings).toHaveBeenLastCalledWith({
        llm_config: {
          api_profiles: [
            expect.objectContaining({
              id: 'profile-1',
              api_key: 'access-id',
              api_secret: 'secret-key'
            }),
            expect.objectContaining({
              id: '00000000-0000-4000-8000-000000000000',
              model_name: 'kling-v3',
              provider: 'kling',
              model_use: 'video',
              api_key: '',
              api_secret: undefined,
              backup_api_keys: undefined
            })
          ]
        }
      })
    } finally {
      randomUUIDSpy.mockRestore()
    }
  })

  it('clears Kling SecretKey when switching a video profile to local call type', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'kling-v3',
          base_url: 'https://api-beijing.klingai.com',
          api_key: 'access-id',
          api_secret: 'secret-key',
          provider: 'kling',
          deployment: 'cloud',
          model_use: 'video'
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    const callTypeSelect = screen.getByLabelText('Call Type')
    fireEvent.mouseDown(callTypeSelect)
    fireEvent.click(screen.getByRole('option', { name: 'Local Model' }))

    const savedProfile = saveSettings.mock.lastCall?.[0]?.llm_config?.api_profiles?.[0]
    expect(savedProfile).toMatchObject({
      id: 'profile-1',
      call_type: 'local',
      api_key: '',
      provider: 'default'
    })
    expect(savedProfile?.deployment).toBeUndefined()
    expect(savedProfile?.api_secret).toBeUndefined()
  })

  it('syncs local ONNX model profiles into the duplicate-check visual model list', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Local CLIP',
          base_url: '',
          api_key: '',
          call_type: 'local',
          local_model_path: ''
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Model Path')).toBeInTheDocument()
    expect(screen.queryByLabelText('Base URL')).toBeNull()

    fireEvent.change(screen.getByLabelText('Model Path'), {
      target: { value: 'D:\\models\\vision\\local-clip.onnx' }
    })
    fireEvent.blur(screen.getByLabelText('Model Path'))

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          expect.objectContaining({
            id: 'profile-1',
            call_type: 'local',
            model_name: 'Local CLIP',
            local_model_path: 'D:\\models\\vision\\local-clip.onnx',
            base_url: '',
            api_key: '',
            provider: 'default',
            is_ollama: false
          })
        ]
      },
      plugin_config: {
        duplicateCheck: {
          visualModels: [
            expect.objectContaining({
              id: 'agent-local:profile-1',
              name: 'Local CLIP',
              modelPath: 'D:\\models\\vision\\local-clip.onnx',
              enabled: true
            })
          ]
        }
      }
    })
  })

  it('switches a Hunyuan3D preset to a local model and clears API-only fields', () => {
    const saveSettings = vi.fn()
    const { container, rerender } = render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Hunyuan3D Pro',
          base_url: 'https://api.ai3d.cloud.tencent.com',
          api_key: 'hy-token',
          tencent_secret_id: 'secret-id',
          tencent_secret_key: 'secret-key',
          api_region: 'ap-shanghai',
          cos_bucket: 'magicpot-1314265479',
          cos_region: 'ap-guangzhou',
          cos_key_prefix: 'magicpot/hunyuan3d'
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Call Type')).toHaveTextContent('Hunyuan3D')

    fireEvent.mouseDown(screen.getByLabelText('Call Type'))
    fireEvent.click(screen.getByRole('option', { name: 'Local Model' }))

    const savedProfile = saveSettings.mock.lastCall?.[0].llm_config.api_profiles[0]
    expect(savedProfile).toEqual(
      expect.objectContaining({
        id: 'profile-1',
        call_type: 'local',
        model_name: '',
        base_url: '',
        api_key: '',
        provider: 'default',
        model_use: 'default',
        is_ollama: false,
        is_vision_model: false,
        is_ocr_model: false,
        local_model_path: ''
      })
    )
    expect(savedProfile).not.toHaveProperty('tencent_secret_id')
    expect(savedProfile).not.toHaveProperty('tencent_secret_key')
    expect(savedProfile).not.toHaveProperty('api_region')
    expect(savedProfile).not.toHaveProperty('cos_bucket')
    expect(savedProfile).not.toHaveProperty('cos_region')
    expect(savedProfile).not.toHaveProperty('cos_key_prefix')

    rerender(
      <PanelLLM
        settingsValue={buildSettingsWithProfile(savedProfile)}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )
    expect(within(container).getByLabelText('Call Type')).toHaveTextContent('Local Model')
    expect(within(container).getByLabelText('Model Name')).toHaveValue('')
    expect(within(container).queryByText('Hunyuan3D Pro')).toBeNull()
    expect(within(container).getByLabelText('Model Path')).toBeInTheDocument()
    expect(within(container).queryByLabelText('Base URL')).toBeNull()
  })

  it('switches a local model back to a generic API model and clears the local path', () => {
    const saveSettings = vi.fn()
    const { container, rerender } = render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Local CLIP',
          base_url: '',
          api_key: '',
          call_type: 'local',
          local_model_path: 'D:\\models\\vision\\local-clip.onnx'
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Call Type')).toHaveTextContent('Local Model')

    fireEvent.mouseDown(screen.getByLabelText('Call Type'))
    fireEvent.click(screen.getByRole('option', { name: 'API Model' }))

    const savedProfile = saveSettings.mock.lastCall?.[0].llm_config.api_profiles[0]
    expect(savedProfile).toEqual(
      expect.objectContaining({
        id: 'profile-1',
        model_name: '',
        base_url: 'https://api.openai.com/v1',
        api_key: '',
        provider: 'default',
        model_use: 'default',
        is_ollama: false,
        is_vision_model: false,
        is_ocr_model: false
      })
    )
    expect(savedProfile.call_type).toBeUndefined()
    expect(savedProfile).not.toHaveProperty('local_model_path')

    rerender(
      <PanelLLM
        settingsValue={buildSettingsWithProfile(savedProfile)}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )
    expect(within(container).getByLabelText('Call Type')).toHaveTextContent('API Model')
    expect(within(container).getByLabelText('Base URL')).toBeInTheDocument()
    expect(within(container).queryByLabelText('Model Path')).toBeNull()
  })

  it('switches an API profile to the Tripo API preset', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Demo Model',
          base_url: 'https://example.com/v1',
          api_key: 'sk-test',
          model_use: 'vision',
          is_vision_model: true,
          is_ocr_model: true
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    fireEvent.mouseDown(screen.getByLabelText('Call Type'))
    fireEvent.click(screen.getByRole('option', { name: 'Tripo API' }))

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          expect.objectContaining({
            id: 'profile-1',
            call_type: 'api',
            model_name: 'Tripo3D',
            base_url: 'https://api.tripo3d.ai/v2/openapi',
            api_key: '',
            provider: 'default',
            model_use: 'default',
            is_ollama: false,
            is_vision_model: false,
            is_ocr_model: false
          })
        ]
      }
    })
  })

  it('lets Tripo API profiles switch between international and mainland endpoints', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Tripo3D',
          base_url: 'https://api.tripo3d.ai/v2/openapi',
          api_key: 'tripo-token',
          call_type: 'api'
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Call Type')).toHaveTextContent('Tripo API')

    fireEvent.mouseDown(screen.getByLabelText('Tripo Endpoint'))
    fireEvent.click(screen.getByRole('option', { name: 'Mainland China api.tripo3d.com' }))

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          expect.objectContaining({
            id: 'profile-1',
            call_type: 'api',
            model_name: 'Tripo3D',
            base_url: 'https://api.tripo3d.com/v2/openapi',
            api_key: 'tripo-token',
            provider: 'default',
            model_use: 'default',
            is_ollama: false
          })
        ]
      }
    })
  })

  it('switches a Tripo API preset back to a generic API model', () => {
    const saveSettings = vi.fn()
    const { container, rerender } = render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Tripo3D',
          base_url: 'https://api.tripo3d.ai/v2/openapi',
          api_key: 'tripo-token',
          call_type: 'api'
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Call Type')).toHaveTextContent('Tripo API')

    fireEvent.mouseDown(screen.getByLabelText('Call Type'))
    fireEvent.click(screen.getByRole('option', { name: 'API Model' }))

    const savedProfile = saveSettings.mock.lastCall?.[0].llm_config.api_profiles[0]
    expect(savedProfile).toEqual(
      expect.objectContaining({
        id: 'profile-1',
        model_name: '',
        base_url: 'https://api.openai.com/v1',
        api_key: '',
        provider: 'default',
        model_use: 'default',
        is_ollama: false,
        is_vision_model: false,
        is_ocr_model: false
      })
    )
    expect(savedProfile.call_type).toBeUndefined()

    rerender(
      <PanelLLM
        settingsValue={buildSettingsWithProfile(savedProfile)}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )
    expect(within(container).getByLabelText('Call Type')).toHaveTextContent('API Model')
    expect(within(container).getByLabelText('Model Name')).toHaveValue('')
    expect(within(container).queryByText('Tripo3D')).toBeNull()
  })

  it('switches a Tripo API preset to a local model without keeping Tripo text', () => {
    const saveSettings = vi.fn()
    const { container, rerender } = render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Tripo3D',
          base_url: 'https://api.tripo3d.ai/v2/openapi',
          api_key: 'tripo-token',
          call_type: 'api'
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Call Type')).toHaveTextContent('Tripo API')

    fireEvent.mouseDown(screen.getByLabelText('Call Type'))
    fireEvent.click(screen.getByRole('option', { name: 'Local Model' }))

    const savedProfile = saveSettings.mock.lastCall?.[0].llm_config.api_profiles[0]
    expect(savedProfile).toEqual(
      expect.objectContaining({
        id: 'profile-1',
        call_type: 'local',
        model_name: '',
        base_url: '',
        api_key: '',
        provider: 'default',
        model_use: 'default',
        is_ollama: false,
        is_vision_model: false,
        is_ocr_model: false,
        local_model_path: ''
      })
    )

    rerender(
      <PanelLLM
        settingsValue={buildSettingsWithProfile(savedProfile)}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )
    expect(within(container).getByLabelText('Call Type')).toHaveTextContent('Local Model')
    expect(within(container).getByLabelText('Model Name')).toHaveValue('')
    expect(within(container).queryByText('Tripo3D')).toBeNull()
  })

  it('switches an API profile to the Hunyuan3D preset', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({})}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    fireEvent.mouseDown(screen.getByLabelText('Call Type'))
    fireEvent.click(screen.getByRole('option', { name: 'Hunyuan3D' }))

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          expect.objectContaining({
            id: 'profile-1',
            model_name: 'Hunyuan3D Pro',
            base_url: 'https://api.ai3d.cloud.tencent.com',
            api_key: 'sk-test',
            provider: 'default',
            model_use: 'default',
            api_region: 'ap-guangzhou',
            cos_region: 'ap-guangzhou',
            cos_key_prefix: 'magicpot/hunyuan3d'
          })
        ]
      }
    })
  })

  it('switches a Hunyuan3D preset back to a generic API model and clears Tencent fields', () => {
    const saveSettings = vi.fn()
    const { container, rerender } = render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Hunyuan3D Pro',
          base_url: 'https://api.ai3d.cloud.tencent.com',
          api_key: 'hy-token',
          tencent_secret_id: 'secret-id',
          tencent_secret_key: 'secret-key',
          api_region: 'ap-shanghai',
          cos_bucket: 'magicpot-1314265479',
          cos_region: 'ap-guangzhou',
          cos_key_prefix: 'magicpot/hunyuan3d'
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Call Type')).toHaveTextContent('Hunyuan3D')

    fireEvent.mouseDown(screen.getByLabelText('Call Type'))
    fireEvent.click(screen.getByRole('option', { name: 'API Model' }))

    const savedProfile = saveSettings.mock.lastCall?.[0].llm_config.api_profiles[0]
    expect(savedProfile).toEqual(
      expect.objectContaining({
        id: 'profile-1',
        model_name: '',
        base_url: 'https://api.openai.com/v1',
        api_key: '',
        provider: 'default',
        model_use: 'default',
        is_ollama: false
      })
    )
    expect(savedProfile.call_type).toBeUndefined()
    expect(savedProfile).not.toHaveProperty('tencent_secret_id')
    expect(savedProfile).not.toHaveProperty('tencent_secret_key')
    expect(savedProfile).not.toHaveProperty('api_region')
    expect(savedProfile).not.toHaveProperty('cos_bucket')
    expect(savedProfile).not.toHaveProperty('cos_region')
    expect(savedProfile).not.toHaveProperty('cos_key_prefix')

    rerender(
      <PanelLLM
        settingsValue={buildSettingsWithProfile(savedProfile)}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )
    expect(within(container).getByLabelText('Call Type')).toHaveTextContent('API Model')
  })

  it('edits Hunyuan3D Tencent and COS fields in the profile card', () => {
    const saveSettings = vi.fn()

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Hunyuan3D Pro',
          base_url: 'https://api.ai3d.cloud.tencent.com',
          api_key: '',
          tencent_secret_id: '',
          tencent_secret_key: '',
          api_region: 'ap-guangzhou',
          cos_bucket: '',
          cos_region: 'ap-guangzhou',
          cos_key_prefix: 'magicpot/hunyuan3d'
        })}
        saveSettings={saveSettings}
        onSelectTab={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText('Tencent SecretId'), {
      target: { value: 'secret-id' }
    })
    fireEvent.blur(screen.getByLabelText('Tencent SecretId'))

    expect(saveSettings).toHaveBeenLastCalledWith({
      llm_config: {
        api_profiles: [
          expect.objectContaining({
            id: 'profile-1',
            tencent_secret_id: 'secret-id'
          })
        ]
      }
    })
  })

  it('clears the selected Hunyuan3D profile COS prefix', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    clearHy3DCosPrefixMock.mockResolvedValue({
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      keyPrefix: 'magicpot/hunyuan3d',
      matchedCount: 2,
      deletedCount: 2,
      errorCount: 0
    })

    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'Hunyuan3D Pro',
          base_url: 'https://api.ai3d.cloud.tencent.com',
          api_key: '',
          tencent_secret_id: 'secret-id',
          tencent_secret_key: 'secret-key',
          api_region: 'ap-guangzhou',
          cos_bucket: 'magicpot-1314265479',
          cos_region: 'ap-guangzhou',
          cos_key_prefix: 'magicpot/hunyuan3d'
        })}
        saveSettings={vi.fn()}
        onSelectTab={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear Current Prefix' }))

    await waitFor(() => {
      expect(clearHy3DCosPrefixMock).toHaveBeenCalledWith({ profileId: 'profile-1' })
      expect(notifySuccessMock).toHaveBeenCalledWith('Cleared 2 objects.')
    })
  })

  it('does not show recommended model dropdown options for API call type profiles', () => {
    render(
      <PanelLLM
        settingsValue={buildSettingsWithProfile({
          model_name: 'GLM-4.6V-Flash',
          base_url: 'https://open.bigmodel.cn/api/paas/v4',
          api_key: 'glm-key'
        })}
        saveSettings={vi.fn()}
        onSelectTab={vi.fn()}
      />
    )

    const modelNameInput = screen.getByLabelText('Model Name')
    fireEvent.focus(modelNameInput)
    fireEvent.keyDown(modelNameInput, { key: 'ArrowDown' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByRole('option', { name: 'gpt-5.4' })).toBeNull()
  })

  it('does not render the Quick App API button in Chinese either', () => {
    currentLanguage = 'zh-CN'
    translations = {
      'llm.quickapp_api_hint_title': 'Quick App API lives in the plugin tab',
      'llm.quickapp_api_hint':
        'Quick Apps, prompt assistance, image interrogation, and Hunyuan3D now use the separate Quick App API settings.'
    }

    render(<PanelLLM settingsValue={DEFAULT_CONFIG} saveSettings={vi.fn()} />)

    expect(screen.queryByRole('button', { name: '打开快应用 API' })).toBeNull()

    currentLanguage = 'en-US'
    translations = {
      'quickapp_api.open_quickapp_api': 'Open Quick App API',
      'llm.quickapp_api_hint_title': 'Quick App API lives in the plugin tab',
      'llm.quickapp_api_hint':
        'Quick Apps, prompt assistance, image interrogation, and Hunyuan3D now use the separate Quick App API settings.',
      'llm.profile_title': 'Agent Thread Settings',
      'llm.model_name': 'Model Name',
      'llm.model_name_placeholder': 'Renderer Agent',
      'llm.base_url': 'Base URL',
      'llm.base_url_placeholder': 'https://example.com/v1',
      'llm.api_key': 'API Key',
      'llm.api_key_placeholder': 'sk-...',
      'llm.add_backup_key': 'Add Backup Key',
      'llm.backup_key': 'Backup Key',
      'llm.add_api_profile': 'Add API Profile'
    }
  })
})
