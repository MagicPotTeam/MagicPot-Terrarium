import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_INTERROGATION_PROMPT,
  DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT,
  DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
} from '@shared/config/config'
import { migratorQAppImageInterrogationPrompt } from './migrator_qapp_image_interrogation_prompt'

describe('migratorQAppImageInterrogationPrompt', () => {
  it('moves the legacy quick app image interrogation prompt into the new system prompt field', () => {
    const migrated = migratorQAppImageInterrogationPrompt.migrate({
      plugin_config: {
        imageInterrogationPrompt: 'legacy quick app prompt'
      }
    })

    expect(migrated.plugin_config).toMatchObject({
      imageInterrogationPrompt: 'legacy quick app prompt',
      imageInterrogationSystemPrompt: 'legacy quick app prompt',
      imageInterrogationUserPrompt: DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
    })
  })

  it('falls back to the legacy agent prompt when the quick app prompt is absent', () => {
    const migrated = migratorQAppImageInterrogationPrompt.migrate({
      llm_config: {
        imageInterrogationPrompt: 'legacy agent prompt'
      }
    })

    expect(migrated.plugin_config).toMatchObject({
      imageInterrogationSystemPrompt: 'legacy agent prompt',
      imageInterrogationUserPrompt: DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
    })
  })

  it('does not overwrite already migrated system and user prompts', () => {
    const migrated = migratorQAppImageInterrogationPrompt.migrate({
      plugin_config: {
        imageInterrogationPrompt: 'legacy quick app prompt',
        imageInterrogationSystemPrompt: 'custom system prompt',
        imageInterrogationUserPrompt: 'custom user prompt'
      }
    })

    expect(migrated.plugin_config).toMatchObject({
      imageInterrogationSystemPrompt: 'custom system prompt',
      imageInterrogationUserPrompt: 'custom user prompt'
    })
  })

  it('upgrades the historical default system prompt to the new default', () => {
    const migrated = migratorQAppImageInterrogationPrompt.migrate({
      plugin_config: {
        imageInterrogationPrompt: DEFAULT_IMAGE_INTERROGATION_PROMPT,
        imageInterrogationSystemPrompt: DEFAULT_IMAGE_INTERROGATION_PROMPT,
        imageInterrogationUserPrompt: DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
      }
    })

    expect(migrated.plugin_config).toMatchObject({
      imageInterrogationSystemPrompt: DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT,
      imageInterrogationUserPrompt: DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
    })
  })
})
