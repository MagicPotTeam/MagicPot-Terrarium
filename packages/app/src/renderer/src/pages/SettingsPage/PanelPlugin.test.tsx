import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import PanelPlugin from './PanelPlugin'

const showMessageBoxMock = vi.fn()
const clearHy3DCosPrefixMock = vi.fn()
const notifyInfoMock = vi.fn(() => 'message-key')
const notifySuccessMock = vi.fn()
const notifyWarningMock = vi.fn()
const closeMessageMock = vi.fn()

let currentLanguage = 'en-US'

const buildEnglishTranslations = (): Record<string, string> => ({
  'quickapp_api.section_info':
    'Quick App execution, Quick App prompt assistance, and Hunyuan3D prefer the "Quick App API" profiles configured here, and fall back to Agent API profiles when none are configured here.',
  'quickapp_api.split_notice':
    'No dedicated Quick App API profile is configured yet, so Quick Apps will temporarily reuse Agent API profiles. Add profiles here if you want Quick Apps to use a separate model set.',
  'quickapp_api.api_profiles_section': 'Quick App API Settings',
  'quickapp_api.prompt_title': 'Quick App Prompt Input Settings',
  'quickapp_api.use_prompt_translation': 'Enable Quick App Prompt Translation',
  'quickapp_api.prompt_translation_prompt': 'System Prompt',
  'quickapp_api.prompt_translation_prompt_placeholder': '',
  'quickapp_api.prompt_translation_system_prompt': 'System Prompt',
  'quickapp_api.prompt_translation_user_prompt': 'User Prompt',
  'quickapp_api.use_image_interrogation': 'Enable Quick App Image Interrogation',
  'quickapp_api.image_interrogation_prompt': 'Quick App Image Interrogation Prompt',
  'quickapp_api.image_interrogation_prompt_placeholder':
    'Prompt used when interrogating Quick App images',
  'quickapp_api.image_interrogation_system_prompt': 'System Prompt',
  'quickapp_api.image_interrogation_system_prompt_placeholder':
    'Prompt used when interrogating Quick App images',
  'quickapp_api.image_interrogation_user_prompt': 'User Prompt',
  'quickapp_api.image_interrogation_user_prompt_placeholder':
    'Prompt sent as the user message when interrogating Quick App images',
  'quickapp_api.translation_info_line1':
    'Once enabled, Quick App prompt translation will prefer the configuration here.',
  'quickapp_api.translation_info_line3':
    'Quick App prompt translation falls back to the Agent API only when no Quick App API profile is available.',
  'quickapp_api.interrogation_info_line1':
    'Once enabled, Quick App image interrogation will prefer the configuration here.',
  'quickapp_api.interrogation_info_line3':
    'Quick App image interrogation falls back to the Agent API only when no Quick App API profile is available.',
  'quickapp_api.hunyuan_title': 'Hunyuan3D (Quick App)',
  'quickapp_api.hunyuan_info':
    'Choose Hunyuan3D from the Quick Apps panel on the right. The Tencent Cloud credentials configured here are used to turn the uploaded reference image into a 3D model.',
  'quickapp_api.open_quickapp_api': 'Open Quick App API',
  'quickapp_api.api_region': 'Tencent API Region',
  'quickapp_api.api_region_hint': 'When left empty, MagicPot uses ap-guangzhou.',
  'quickapp_api.clear_cos_button': 'Clear Current Prefix',
  'quickapp_api.clear_cos_loading': 'Clearing...',
  'quickapp_api.clear_cos_dialog_title': 'Clear Hunyuan3D COS Cache',
  'quickapp_api.clear_cos_dialog_message':
    'This will delete all objects under the current Hunyuan3D prefix.',
  'quickapp_api.clear_cos_cancel': 'Cancel',
  'quickapp_api.clear_cos_confirm': 'Clear',
  'quickapp_api.clear_cos_progress': 'Clearing Hunyuan3D COS cache...',
  'quickapp_api.clear_cos_hint':
    'The clear button removes objects only under the current prefix, not the entire bucket.',
  'quickapp_api.clear_cos_requirements':
    'SecretId, SecretKey, COS bucket, and COS region are required before clearing.',
  'quickapp_api.clear_cos_empty': 'No objects were found under the current prefix.',
  'quickapp_api.clear_cos_success': 'Cleared {{deletedCount}} objects.',
  'quickapp_api.clear_cos_partial':
    'Deleted {{deletedCount}} objects, but {{errorCount}} objects failed to delete.',
  'quickapp_api.clear_cos_failed': 'Failed to clear the Hunyuan3D COS cache.'
})

let translations: Record<string, string> = buildEnglishTranslations()

const translate = (key: string, options?: Record<string, string | number | undefined>): string => {
  let template = translations[key]

  if (!template) {
    template = typeof options?.defaultValue === 'string' ? options.defaultValue : key
  }

  if (!options) {
    return template
  }

  return Object.entries(options).reduce((result, [name, value]) => {
    if (value === undefined) {
      return result
    }
    return result.replaceAll(`{{${name}}}`, String(value))
  }, template)
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: currentLanguage },
    t: translate
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

vi.mock('./PanelLLM', () => ({
  ApiProfilesSection: ({
    title,
    profiles
  }: {
    title: string
    profiles?: Array<{
      auth_mode?: string
      model_name?: string
      base_url?: string
      api_key?: string
      tencent_secret_id?: string
      tencent_secret_key?: string
      api_region?: string
      cos_bucket?: string
      cos_region?: string
      cos_key_prefix?: string
    }>
  }) => (
    <div
      data-testid="api-profiles-section"
      data-first-profile-api-key={profiles?.[0]?.api_key ?? ''}
      data-first-profile-auth-mode={profiles?.[0]?.auth_mode ?? ''}
      data-first-profile-base-url={profiles?.[0]?.base_url ?? ''}
      data-first-profile-cos-bucket={profiles?.[0]?.cos_bucket ?? ''}
      data-first-profile-cos-key-prefix={profiles?.[0]?.cos_key_prefix ?? ''}
      data-first-profile-cos-region={profiles?.[0]?.cos_region ?? ''}
      data-first-profile-api-region={profiles?.[0]?.api_region ?? ''}
      data-first-profile-model={profiles?.[0]?.model_name ?? ''}
      data-first-profile-secret-id={profiles?.[0]?.tencent_secret_id ?? ''}
      data-first-profile-secret-key={profiles?.[0]?.tencent_secret_key ?? ''}
      data-profile-count={profiles?.length ?? 0}
    >
      {title}
    </div>
  ),
  createEmptyProfile: () => ({
    id: 'mock-profile',
    model_name: '',
    base_url: '',
    api_key: ''
  })
}))

describe('PanelPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentLanguage = 'en-US'
    translations = buildEnglishTranslations()
  })

  it('migrates legacy Hunyuan3D settings into a Quick App API profile card', async () => {
    const saveSettings = vi.fn()

    render(
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          aigc3d_config: {
            ...DEFAULT_CONFIG.aigc3d_config!,
            tencent_secret_id: 'secret-id',
            tencent_secret_key: 'secret-key',
            api_region: 'ap-shanghai',
            cos_bucket: 'magicpot-1314265479',
            cos_region: 'ap-guangzhou',
            cos_key_prefix: 'magicpot/hunyuan3d'
          },
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: []
          }
        }}
        saveSettings={saveSettings}
      />
    )

    const section = screen.getByTestId('api-profiles-section')
    expect(section).toHaveAttribute('data-profile-count', '1')
    expect(section).toHaveAttribute('data-first-profile-model', 'Hunyuan3D Pro')
    expect(section).toHaveAttribute(
      'data-first-profile-base-url',
      'https://api.ai3d.cloud.tencent.com'
    )
    expect(section).toHaveAttribute('data-first-profile-secret-id', 'secret-id')
    expect(section).toHaveAttribute('data-first-profile-secret-key', 'secret-key')
    expect(section).toHaveAttribute('data-first-profile-api-region', 'ap-shanghai')
    expect(section).toHaveAttribute('data-first-profile-cos-bucket', 'magicpot-1314265479')
    expect(section).toHaveAttribute('data-first-profile-cos-region', 'ap-guangzhou')
    expect(section).toHaveAttribute('data-first-profile-cos-key-prefix', 'magicpot/hunyuan3d')

    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith({
        plugin_config: {
          api_profiles: [
            expect.objectContaining({
              id: 'legacy-hunyuan3d-profile',
              model_name: 'Hunyuan3D Pro',
              base_url: 'https://api.ai3d.cloud.tencent.com',
              tencent_secret_id: 'secret-id',
              tencent_secret_key: 'secret-key',
              api_region: 'ap-shanghai',
              cos_bucket: 'magicpot-1314265479',
              cos_region: 'ap-guangzhou',
              cos_key_prefix: 'magicpot/hunyuan3d'
            })
          ]
        }
      })
    })
  })

  it('saves quick app prompt translation system and user prompts separately', () => {
    const saveSettings = vi.fn()

    render(
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: [
              {
                id: 'quick-translate',
                model_name: 'Quick Translate',
                base_url: 'https://quick.example/v1',
                api_key: 'quick-key'
              }
            ]
          }
        }}
        saveSettings={saveSettings}
      />
    )

    const systemPromptInput = screen.getAllByLabelText('System Prompt')[0]
    fireEvent.change(systemPromptInput, {
      target: { value: 'translation system prompt override' }
    })
    fireEvent.blur(systemPromptInput)

    const userPromptInput = screen.getAllByLabelText('User Prompt')[0]
    fireEvent.change(userPromptInput, {
      target: { value: 'translation user prompt override' }
    })
    fireEvent.blur(userPromptInput)

    expect(saveSettings).toHaveBeenCalledWith({
      plugin_config: { promptTranslationSystemPrompt: 'translation system prompt override' }
    })
    expect(saveSettings).toHaveBeenCalledWith({
      plugin_config: { promptTranslationUserPrompt: 'translation user prompt override' }
    })
  })

  it('saves quick app image interrogation system and user prompts separately', () => {
    const saveSettings = vi.fn()

    render(
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: [
              {
                id: 'quick-vision',
                model_name: 'Quick Vision',
                base_url: 'https://quick.example/v1',
                api_key: 'quick-key',
                is_vision_model: true
              }
            ]
          }
        }}
        saveSettings={saveSettings}
      />
    )

    const systemPromptInput = screen.getAllByLabelText('System Prompt')[1]
    fireEvent.change(systemPromptInput, {
      target: { value: 'system prompt override' }
    })
    fireEvent.blur(systemPromptInput)

    const userPromptInput = screen.getAllByLabelText('User Prompt')[1]
    fireEvent.change(userPromptInput, {
      target: { value: 'user prompt override' }
    })
    fireEvent.blur(userPromptInput)

    expect(saveSettings).toHaveBeenCalledWith({
      plugin_config: { imageInterrogationSystemPrompt: 'system prompt override' }
    })
    expect(saveSettings).toHaveBeenCalledWith({
      plugin_config: { imageInterrogationUserPrompt: 'user prompt override' }
    })
  })

  it('falls back to localized Chinese defaults when zh-CN translations are missing', () => {
    currentLanguage = 'zh-CN'
    translations = {}

    render(
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: []
          }
        }}
        saveSettings={vi.fn()}
      />
    )

    expect(screen.queryByText('quickapp_api.api_profiles_section')).toBeNull()
    expect(screen.getByText('快应用 API 设置')).toBeTruthy()
  })
})
