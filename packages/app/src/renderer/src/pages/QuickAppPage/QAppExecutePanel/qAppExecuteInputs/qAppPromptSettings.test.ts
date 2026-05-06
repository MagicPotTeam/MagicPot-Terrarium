import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_INTERROGATION_PROMPT,
  DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT,
  DEFAULT_IMAGE_INTERROGATION_USER_PROMPT,
  DEFAULT_PROMPT_TRANSLATION_SYSTEM_PROMPT,
  DEFAULT_PROMPT_TRANSLATION_USER_PROMPT
} from '@shared/config/config'
import { getQAppPromptSettings } from './qAppPromptSettings'

describe('getQAppPromptSettings', () => {
  it('prefers quick app prompt settings when they are configured', () => {
    const settings = getQAppPromptSettings({
      ...DEFAULT_CONFIG,
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        usePromptTranslation: false,
        promptTranslationPrompt: 'agent translate',
        promptTranslationProfileId: 'agent-translate',
        useImageInterrogation: false,
        imageInterrogationPrompt: 'agent vision',
        imageInterrogationProfileId: 'agent-vision'
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        usePromptTranslation: true,
        promptTranslationSystemPrompt: 'quick translate system',
        promptTranslationUserPrompt: 'quick translate user',
        promptTranslationProfileId: 'quick-translate',
        useImageInterrogation: true,
        imageInterrogationSystemPrompt: 'quick vision system',
        imageInterrogationUserPrompt: 'quick vision user',
        imageInterrogationProfileId: 'quick-vision'
      }
    })

    expect(settings).toMatchObject({
      usePromptTranslation: true,
      promptTranslationSystemPrompt: 'quick translate system',
      promptTranslationUserPrompt: 'quick translate user',
      promptTranslationProfileId: 'quick-translate',
      useImageInterrogation: true,
      imageInterrogationSystemPrompt: 'quick vision system',
      imageInterrogationUserPrompt: 'quick vision user',
      imageInterrogationProfileId: 'quick-vision'
    })
  })

  it('falls back to agent prompt settings when quick app prompt settings are missing', () => {
    const settings = getQAppPromptSettings({
      ...DEFAULT_CONFIG,
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        usePromptTranslation: false,
        promptTranslationPrompt: 'agent translate',
        promptTranslationProfileId: 'agent-translate',
        useImageInterrogation: false,
        imageInterrogationPrompt: 'agent vision',
        imageInterrogationProfileId: 'agent-vision'
      },
      plugin_config: {
        api_profiles: [],
        light_adjustment_prompt: DEFAULT_CONFIG.plugin_config!.light_adjustment_prompt
      }
    })

    expect(settings).toMatchObject({
      usePromptTranslation: false,
      promptTranslationSystemPrompt: 'agent translate',
      promptTranslationUserPrompt: DEFAULT_PROMPT_TRANSLATION_USER_PROMPT,
      promptTranslationProfileId: 'agent-translate',
      useImageInterrogation: false,
      imageInterrogationSystemPrompt: 'agent vision',
      imageInterrogationUserPrompt: DEFAULT_IMAGE_INTERROGATION_USER_PROMPT,
      imageInterrogationProfileId: 'agent-vision'
    })
  })

  it('falls back to built-in defaults when both quick app and agent prompts are blank', () => {
    const settings = getQAppPromptSettings({
      ...DEFAULT_CONFIG,
      llm_config: {
        ...DEFAULT_CONFIG.llm_config,
        promptTranslationPrompt: '',
        imageInterrogationPrompt: ''
      },
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        promptTranslationPrompt: '   ',
        promptTranslationSystemPrompt: '   ',
        promptTranslationUserPrompt: '   ',
        imageInterrogationPrompt: '   ',
        imageInterrogationSystemPrompt: '   ',
        imageInterrogationUserPrompt: '   '
      }
    })

    expect(settings.promptTranslationSystemPrompt).toBe(DEFAULT_PROMPT_TRANSLATION_SYSTEM_PROMPT)
    expect(settings.promptTranslationUserPrompt).toBe(DEFAULT_PROMPT_TRANSLATION_USER_PROMPT)
    expect(settings.imageInterrogationSystemPrompt).toBe(DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT)
    expect(settings.imageInterrogationUserPrompt).toBe(DEFAULT_IMAGE_INTERROGATION_USER_PROMPT)
  })

  it('keeps legacy quick app translation prompt as the system prompt', () => {
    const settings = getQAppPromptSettings({
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        promptTranslationPrompt: 'legacy quick translate'
      }
    })

    expect(settings.promptTranslationSystemPrompt).toBe('legacy quick translate')
    expect(settings.promptTranslationUserPrompt).toBe(DEFAULT_PROMPT_TRANSLATION_USER_PROMPT)
  })

  it('maps legacy placeholder-based quick app translation prompt to the user prompt', () => {
    const settings = getQAppPromptSettings({
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        promptTranslationPrompt: 'Translate this to English: {{prompt}}'
      }
    })

    expect(settings.promptTranslationSystemPrompt).toBe(DEFAULT_PROMPT_TRANSLATION_USER_PROMPT)
    expect(settings.promptTranslationUserPrompt).toBe('Translate this to English: {{prompt}}')
  })

  it('keeps legacy quick app image interrogation prompt as the system prompt', () => {
    const settings = getQAppPromptSettings({
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        imageInterrogationPrompt: 'legacy quick vision'
      }
    })

    expect(settings.imageInterrogationSystemPrompt).toBe('legacy quick vision')
    expect(settings.imageInterrogationUserPrompt).toBe(DEFAULT_IMAGE_INTERROGATION_USER_PROMPT)
  })

  it('upgrades the historical default image interrogation prompt to the new default', () => {
    const settings = getQAppPromptSettings({
      ...DEFAULT_CONFIG,
      plugin_config: {
        ...DEFAULT_CONFIG.plugin_config!,
        imageInterrogationPrompt: DEFAULT_IMAGE_INTERROGATION_PROMPT,
        imageInterrogationSystemPrompt: DEFAULT_IMAGE_INTERROGATION_PROMPT
      }
    })

    expect(settings.imageInterrogationSystemPrompt).toBe(DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT)
  })
})
