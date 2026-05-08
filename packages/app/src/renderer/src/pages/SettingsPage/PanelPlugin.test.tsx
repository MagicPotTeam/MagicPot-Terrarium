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
    profiles?: Array<{ auth_mode?: string; model_name?: string; api_key?: string }>
  }) => (
    <div
      data-testid="api-profiles-section"
      data-first-profile-api-key={profiles?.[0]?.api_key ?? ''}
      data-first-profile-auth-mode={profiles?.[0]?.auth_mode ?? ''}
      data-first-profile-model={profiles?.[0]?.model_name ?? ''}
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

  it('renders the Quick App-specific Hunyuan3D guidance', () => {
    render(
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: [
              {
                id: 'quick-profile',
                model_name: 'Quick Model',
                base_url: 'https://quick.example/v1',
                api_key: 'quick-key'
              }
            ]
          }
        }}
        saveSettings={vi.fn()}
      />
    )

    expect(screen.getByText('Hunyuan3D (Quick App)')).toBeTruthy()
    expect(
      screen.getByText(
        'Choose Hunyuan3D from the Quick Apps panel on the right. The Tencent Cloud credentials configured here are used to turn the uploaded reference image into a 3D model.'
      )
    ).toBeTruthy()
  })

  it('saves a dedicated Tencent API region without disturbing COS region settings', () => {
    const saveSettings = vi.fn()

    render(
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          aigc3d_config: {
            ...DEFAULT_CONFIG.aigc3d_config!,
            api_region: '',
            cos_region: 'ap-guangzhou'
          },
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: []
          }
        }}
        saveSettings={saveSettings}
      />
    )

    const apiRegionInput = screen.getByLabelText('Tencent API Region')
    fireEvent.change(apiRegionInput, {
      target: { value: 'ap-shanghai' }
    })
    fireEvent.blur(apiRegionInput)

    expect(saveSettings).toHaveBeenCalledWith({ aigc3d_config: { api_region: 'ap-shanghai' } })
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

  it('clears the configured Hunyuan3D COS prefix after confirmation', async () => {
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
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          aigc3d_config: {
            ...DEFAULT_CONFIG.aigc3d_config!,
            tencent_secret_id: 'secret-id',
            tencent_secret_key: 'secret-key',
            cos_bucket: 'magicpot-1314265479',
            cos_region: 'ap-guangzhou',
            cos_key_prefix: 'magicpot/hunyuan3d'
          },
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: []
          }
        }}
        saveSettings={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear Current Prefix' }))

    await waitFor(() => {
      expect(showMessageBoxMock).toHaveBeenCalled()
      expect(clearHy3DCosPrefixMock).toHaveBeenCalledWith({})
      expect(notifySuccessMock).toHaveBeenCalledWith('Cleared 2 objects.')
    })
  })

  it('shows the normalized COS prefix when the configured value collapses to slash-only input', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })

    render(
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          aigc3d_config: {
            ...DEFAULT_CONFIG.aigc3d_config!,
            tencent_secret_id: 'secret-id',
            tencent_secret_key: 'secret-key',
            cos_bucket: 'magicpot-1314265479',
            cos_region: 'ap-guangzhou',
            cos_key_prefix: '/'
          },
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: []
          }
        }}
        saveSettings={vi.fn()}
      />
    )

    expect(screen.getByText('Prefix: magicpot/hunyuan3d')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clear Current Prefix' }))

    await waitFor(() => {
      expect(showMessageBoxMock).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.stringContaining('Prefix: magicpot/hunyuan3d')
        })
      )
    })

    expect(clearHy3DCosPrefixMock).not.toHaveBeenCalled()
  })

  it('disables COS cleanup until the required Tencent settings are configured', () => {
    render(
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          aigc3d_config: {
            ...DEFAULT_CONFIG.aigc3d_config!,
            cos_key_prefix: 'magicpot/hunyuan3d'
          },
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: []
          }
        }}
        saveSettings={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Clear Current Prefix' })).toBeDisabled()
    expect(
      screen.getByText(
        'SecretId, SecretKey, COS bucket, and COS region are required before clearing.'
      )
    ).toBeTruthy()
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
    expect(screen.queryByText('quickapp_api.hunyuan_title')).toBeNull()
    expect(screen.getByText('Hunyuan3D（快应用）')).toBeTruthy()
  })

  it('does not call clearHy3DCosPrefix when the user cancels the confirmation dialog', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 })

    render(
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          aigc3d_config: {
            ...DEFAULT_CONFIG.aigc3d_config!,
            tencent_secret_id: 'secret-id',
            tencent_secret_key: 'secret-key',
            cos_bucket: 'magicpot-1314265479',
            cos_region: 'ap-guangzhou',
            cos_key_prefix: 'magicpot/hunyuan3d'
          },
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: []
          }
        }}
        saveSettings={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear Current Prefix' }))

    await waitFor(() => {
      expect(showMessageBoxMock).toHaveBeenCalled()
    })

    expect(clearHy3DCosPrefixMock).not.toHaveBeenCalled()
    expect(notifySuccessMock).not.toHaveBeenCalled()
  })

  it('shows a warning when COS cleanup has partial errors', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    clearHy3DCosPrefixMock.mockResolvedValue({
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      keyPrefix: 'magicpot/hunyuan3d',
      matchedCount: 5,
      deletedCount: 3,
      errorCount: 2
    })

    render(
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          aigc3d_config: {
            ...DEFAULT_CONFIG.aigc3d_config!,
            tencent_secret_id: 'secret-id',
            tencent_secret_key: 'secret-key',
            cos_bucket: 'magicpot-1314265479',
            cos_region: 'ap-guangzhou',
            cos_key_prefix: 'magicpot/hunyuan3d'
          },
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: []
          }
        }}
        saveSettings={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear Current Prefix' }))

    await waitFor(() => {
      expect(notifyWarningMock).toHaveBeenCalledWith(expect.stringContaining('3'))
    })
  })

  it('shows a warning when COS cleanup API call fails', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    clearHy3DCosPrefixMock.mockRejectedValue(new Error('Network error'))

    render(
      <PanelPlugin
        settingsValue={{
          ...DEFAULT_CONFIG,
          aigc3d_config: {
            ...DEFAULT_CONFIG.aigc3d_config!,
            tencent_secret_id: 'secret-id',
            tencent_secret_key: 'secret-key',
            cos_bucket: 'magicpot-1314265479',
            cos_region: 'ap-guangzhou',
            cos_key_prefix: 'magicpot/hunyuan3d'
          },
          plugin_config: {
            ...DEFAULT_CONFIG.plugin_config!,
            api_profiles: []
          }
        }}
        saveSettings={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear Current Prefix' }))

    await waitFor(() => {
      expect(notifyWarningMock).toHaveBeenCalledWith('Network error')
    })
  })
})
