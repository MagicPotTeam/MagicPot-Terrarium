import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config, LLMAPIProfile } from '@shared/config/config'
import { rendererHostExtensionApiV1 } from './generatedRegistry'
import {
  applyRendererAgentApiProfileCallType,
  buildRendererAgentApiProfileCallTypeOptions,
  buildRendererClearedQuickAppLegacyHunyuanConfig,
  buildRendererQuickAppLegacyHunyuanProfile,
  getRendererQuickAppApiProfilesSectionAction,
  isRendererQuickAppLegacyHunyuanProfile,
  prepareRendererClonedQuickAppProfile,
  renderRendererAgentApiProfileCardExtra,
  resolveRendererAgentApiProfileUi,
  resolveRendererAssistantImageAutoSaveDir,
  resolveRendererChatReasoningPreferenceKey,
  resolveRendererQuickAppApiProfileLists
} from './rendererHostExtensionHelpers'

const createProfile = (id: string, modelName = id): LLMAPIProfile =>
  ({
    id,
    model_name: modelName,
    api_key: '',
    base_url: 'https://example.invalid/v1',
    provider: 'default',
    model_use: 'default',
    is_ollama: false,
    is_vision_model: false,
    is_ocr_model: false
  }) as LLMAPIProfile

const config = { download_dir: 'C:/Downloads' } as Config

afterEach(() => {
  delete rendererHostExtensionApiV1.chat
  delete rendererHostExtensionApiV1.settings
})

describe('renderer HostExtensionApi helper fallbacks', () => {
  it('uses chat fallback semantics only when an extension does not handle the value', () => {
    const reasoningFallback = vi.fn(() => 'fallback-key')
    expect(resolveRendererChatReasoningPreferenceKey('profile-a', null, reasoningFallback)).toBe(
      'fallback-key'
    )
    expect(reasoningFallback).toHaveBeenCalledTimes(1)

    reasoningFallback.mockClear()
    rendererHostExtensionApiV1.chat = {
      resolveReasoningPreferenceKey: () => 'extension-key'
    }
    expect(resolveRendererChatReasoningPreferenceKey('profile-a', null, reasoningFallback)).toBe(
      'extension-key'
    )
    expect(reasoningFallback).not.toHaveBeenCalled()

    rendererHostExtensionApiV1.chat = {
      resolveReasoningPreferenceKey: () => null
    }
    expect(
      resolveRendererChatReasoningPreferenceKey('profile-a', null, reasoningFallback)
    ).toBeNull()
    expect(reasoningFallback).not.toHaveBeenCalled()

    rendererHostExtensionApiV1.chat = {
      resolveReasoningPreferenceKey: () => undefined
    }
    expect(resolveRendererChatReasoningPreferenceKey('profile-a', null, reasoningFallback)).toBe(
      'fallback-key'
    )
    expect(reasoningFallback).toHaveBeenCalledTimes(1)
  })

  it('uses assistant image auto-save fallback only when the chat extension returns undefined', () => {
    const fallback = vi.fn(() => 'C:/fallback/.AutoSave/Agent')
    const options = { config, storageScope: 'project-1.chat' }

    expect(resolveRendererAssistantImageAutoSaveDir(options, fallback)).toBe(
      'C:/fallback/.AutoSave/Agent'
    )
    expect(fallback).toHaveBeenCalledTimes(1)

    fallback.mockClear()
    rendererHostExtensionApiV1.chat = {
      resolveAssistantImageAutoSaveDir: () => 'C:/extension/.AutoSave/Agent'
    }
    expect(resolveRendererAssistantImageAutoSaveDir(options, fallback)).toBe(
      'C:/extension/.AutoSave/Agent'
    )
    expect(fallback).not.toHaveBeenCalled()
  })

  it('uses settings fallback semantics for agent profile hooks', () => {
    const profile = createProfile('agent-profile')
    const extensionProfile = { ...profile, call_type: 'extension' }
    const baseOptions = [{ label: 'API Model', value: 'api' }]
    const extensionOptions = [...baseOptions, { label: 'Extension', value: 'extension' }]
    const baseUi = {
      showApiKeyInput: true,
      showBackupKeys: true,
      showBaseUrlInput: true,
      showKlingSecretInput: false
    }
    const extensionUi = { ...baseUi, showApiKeyInput: false }
    const fallbackProfile = vi.fn(() => profile)
    const optionsFallback = vi.fn(() => baseOptions)
    const uiFallback = vi.fn(() => baseUi)
    const extraFallback = vi.fn(() => 'fallback-extra')

    expect(
      applyRendererAgentApiProfileCallType({ callType: 'api', profile }, fallbackProfile)
    ).toBe(profile)
    expect(
      buildRendererAgentApiProfileCallTypeOptions(
        { baseOptions, isChineseUi: false, profile },
        optionsFallback
      )
    ).toBe(baseOptions)
    expect(
      resolveRendererAgentApiProfileUi({ baseUi, isChineseUi: false, profile }, uiFallback)
    ).toBe(baseUi)
    expect(
      renderRendererAgentApiProfileCardExtra(
        {
          callTypeOptions: baseOptions,
          isChineseUi: false,
          onChangeCallType: vi.fn(),
          onClone: vi.fn(),
          onDelete: vi.fn(),
          onReplaceProfiles: vi.fn(),
          onUpdate: vi.fn(),
          profile,
          profiles: [profile]
        },
        extraFallback
      )
    ).toBe('fallback-extra')

    rendererHostExtensionApiV1.settings = {
      applyAgentApiProfileCallType: () => extensionProfile,
      buildAgentApiProfileCallTypeOptions: () => extensionOptions,
      resolveAgentApiProfileUi: () => extensionUi,
      renderAgentApiProfileCardExtra: () => 'extension-extra'
    }

    fallbackProfile.mockClear()
    optionsFallback.mockClear()
    uiFallback.mockClear()
    extraFallback.mockClear()

    expect(
      applyRendererAgentApiProfileCallType({ callType: 'extension', profile }, fallbackProfile)
    ).toBe(extensionProfile)
    expect(
      buildRendererAgentApiProfileCallTypeOptions(
        { baseOptions, isChineseUi: false, profile },
        optionsFallback
      )
    ).toBe(extensionOptions)
    expect(
      resolveRendererAgentApiProfileUi({ baseUi, isChineseUi: false, profile }, uiFallback)
    ).toBe(extensionUi)
    expect(
      renderRendererAgentApiProfileCardExtra(
        {
          callTypeOptions: extensionOptions,
          isChineseUi: false,
          onChangeCallType: vi.fn(),
          onClone: vi.fn(),
          onDelete: vi.fn(),
          onReplaceProfiles: vi.fn(),
          onUpdate: vi.fn(),
          profile,
          profiles: [profile]
        },
        extraFallback
      )
    ).toBe('extension-extra')

    expect(fallbackProfile).not.toHaveBeenCalled()
    expect(optionsFallback).not.toHaveBeenCalled()
    expect(uiFallback).not.toHaveBeenCalled()
    expect(extraFallback).not.toHaveBeenCalled()
  })

  it('uses settings fallback semantics for profile creation and clearing hooks', () => {
    const fallbackProfile = vi.fn(() => createProfile('fallback-profile'))
    expect(buildRendererQuickAppLegacyHunyuanProfile(config, fallbackProfile)?.id).toBe(
      'fallback-profile'
    )
    expect(fallbackProfile).toHaveBeenCalledTimes(1)

    fallbackProfile.mockClear()
    rendererHostExtensionApiV1.settings = {
      buildQuickAppLegacyHunyuanProfile: () => null,
      buildClearedQuickAppLegacyHunyuanConfig: () => ({
        tencent_secret_id: 'extension-cleared',
        tencent_secret_key: '',
        api_region: '',
        cos_bucket: '',
        cos_region: '',
        cos_key_prefix: ''
      })
    }
    expect(buildRendererQuickAppLegacyHunyuanProfile(config, fallbackProfile)).toBeNull()
    expect(fallbackProfile).not.toHaveBeenCalled()

    const fallbackClearedConfig = vi.fn(() => ({
      tencent_secret_id: 'fallback-cleared',
      tencent_secret_key: '',
      api_region: '',
      cos_bucket: '',
      cos_region: '',
      cos_key_prefix: ''
    }))
    expect(buildRendererClearedQuickAppLegacyHunyuanConfig(fallbackClearedConfig)).toMatchObject({
      tencent_secret_id: 'extension-cleared'
    })
    expect(fallbackClearedConfig).not.toHaveBeenCalled()
  })

  it('uses settings fallback semantics for profile lists, clone preparation, actions, and legacy checks', () => {
    const pluginProfile = createProfile('plugin-profile')
    const qappProfile = createProfile('qapp-profile')
    const sourceProfile = createProfile('source-profile')
    const clonedProfile = createProfile('cloned-profile')
    const extensionClone = createProfile('extension-clone')

    const profileListFallback = vi.fn(() => ({
      pluginProfileCards: [pluginProfile],
      qAppProfiles: [qappProfile]
    }))
    expect(
      resolveRendererQuickAppApiProfileLists(
        { effectivePluginProfiles: [pluginProfile], settingsValue: config },
        profileListFallback
      )
    ).toEqual({ pluginProfileCards: [pluginProfile], qAppProfiles: [qappProfile] })
    expect(profileListFallback).toHaveBeenCalledTimes(1)

    rendererHostExtensionApiV1.settings = {
      resolveQuickAppApiProfileLists: () => ({
        pluginProfileCards: [qappProfile],
        qAppProfiles: [pluginProfile]
      }),
      prepareClonedQuickAppProfile: () => extensionClone,
      getQuickAppApiProfilesSectionAction: () => 'extension-action',
      isQuickAppLegacyHunyuanProfile: () => false
    }

    profileListFallback.mockClear()
    expect(
      resolveRendererQuickAppApiProfileLists(
        { effectivePluginProfiles: [pluginProfile], settingsValue: config },
        profileListFallback
      )
    ).toEqual({ pluginProfileCards: [qappProfile], qAppProfiles: [pluginProfile] })
    expect(profileListFallback).not.toHaveBeenCalled()

    const cloneFallback = vi.fn(() => clonedProfile)
    expect(prepareRendererClonedQuickAppProfile(sourceProfile, clonedProfile, cloneFallback)).toBe(
      extensionClone
    )
    expect(cloneFallback).not.toHaveBeenCalled()

    const actionFallback = vi.fn(() => 'fallback-action')
    expect(
      getRendererQuickAppApiProfilesSectionAction(
        {
          effectivePluginProfiles: [pluginProfile],
          isChineseUi: false,
          savePluginProfiles: vi.fn()
        },
        actionFallback
      )
    ).toBe('extension-action')
    expect(actionFallback).not.toHaveBeenCalled()

    const legacyFallback = vi.fn(() => true)
    expect(isRendererQuickAppLegacyHunyuanProfile(pluginProfile, legacyFallback)).toBe(false)
    expect(legacyFallback).not.toHaveBeenCalled()
  })
})
