import { describe, expect, it } from 'vitest'
import {
  resolveTaggingSkillBootstrapProfileId,
  resolveTaggingSkillProfileId
} from './chatTaggingProfileUtils'
import { BUILT_IN_PROMPT_TRANSLATION_SKILL_ID, BUILT_IN_TAGGING_SKILL_ID } from './builtInSkills'

describe('chatTaggingProfileUtils', () => {
  it('keeps the current profile for non-tagging skills', () => {
    expect(
      resolveTaggingSkillProfileId({
        skillId: 'ops-agent',
        currentProfileId: 'gpt-4o',
        configuredProfileId: 'vision-model'
      })
    ).toBe('gpt-4o')
  })

  it('falls back to the configured image interrogation profile for tagging when no profile is set', () => {
    expect(
      resolveTaggingSkillProfileId({
        skillId: BUILT_IN_TAGGING_SKILL_ID,
        currentProfileId: null,
        configuredProfileId: 'vision-model'
      })
    ).toBe('vision-model')
  })

  it('can prefer the configured image interrogation profile when selecting the tagging skill', () => {
    expect(
      resolveTaggingSkillProfileId({
        skillId: BUILT_IN_TAGGING_SKILL_ID,
        currentProfileId: 'gpt-4o',
        configuredProfileId: 'vision-model',
        preferConfiguredProfile: true
      })
    ).toBe('vision-model')
  })

  it('preserves a manual override for tagging after selection when no forced preference is requested', () => {
    expect(
      resolveTaggingSkillProfileId({
        skillId: BUILT_IN_TAGGING_SKILL_ID,
        currentProfileId: 'manual-model',
        configuredProfileId: 'vision-model'
      })
    ).toBe('manual-model')
  })

  it('uses only the qapp image interrogation profile as the tagging bootstrap default', () => {
    expect(
      resolveTaggingSkillBootstrapProfileId({
        skillId: BUILT_IN_TAGGING_SKILL_ID,
        configuredProfileId: 'vision-model',
        fallbackProfileId: 'gpt-4o'
      })
    ).toBe('vision-model')

    expect(
      resolveTaggingSkillBootstrapProfileId({
        skillId: BUILT_IN_TAGGING_SKILL_ID,
        configuredProfileId: null,
        fallbackProfileId: 'gpt-4o'
      })
    ).toBeNull()
  })

  it('keeps the normal chat fallback model bootstrap for non-tagging skills', () => {
    expect(
      resolveTaggingSkillBootstrapProfileId({
        skillId: 'ops-agent',
        configuredProfileId: 'vision-model',
        fallbackProfileId: 'gpt-4o'
      })
    ).toBe('gpt-4o')
  })

  it('applies the configured built-in profile policy to prompt translation as well', () => {
    expect(
      resolveTaggingSkillBootstrapProfileId({
        skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
        configuredProfileId: 'translation-model',
        fallbackProfileId: 'gpt-4o'
      })
    ).toBe('translation-model')

    expect(
      resolveTaggingSkillProfileId({
        skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
        currentProfileId: 'manual-model',
        configuredProfileId: 'translation-model',
        preferConfiguredProfile: true
      })
    ).toBe('translation-model')
  })
})
