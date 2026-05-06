import { describe, expect, it } from 'vitest'
import { normalizeRestoredSkillSelection } from './chatSessionUtils'
import {
  BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
  BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
  BUILT_IN_TAGGING_SKILL_ID,
  buildBuiltInImageInterrogationSkill,
  buildBuiltInPromptTranslationSkill,
  buildBuiltInSkills,
  mergeBuiltInSkills,
  stripDefaultBuiltInSkills
} from './builtInSkills'

const createConfig = () =>
  ({
    llm_config: {
      api_profiles: [],
      customSkills: [],
      customSkillCategories: [],
      usePromptOptimization: false,
      promptOptimizationQAppKey: '',
      promptOptimizationDefaultWidth: 1024,
      promptOptimizationDefaultHeight: 1024,
      promptOptimizationTipoModel: '',
      promptOptimizationTagLength: '',
      promptOptimizationNlLength: '',
      promptOptimizationDevice: '',
      promptOptimizationSeed: -1,
      usePromptTranslation: true,
      promptTranslationPrompt: '',
      promptTranslationProfileId: 'translation-model',
      useImageInterrogation: true,
      imageInterrogationPrompt: '',
      imageInterrogationProfileId: 'vision-model',
      useRandomPromptGeneration: false,
      randomPromptGenerationPrompt: ''
    },
    plugin_config: {
      api_profiles: [],
      light_adjustment_prompt: '',
      usePromptTranslation: true,
      promptTranslationSystemPrompt: 'Translate system',
      promptTranslationUserPrompt: 'Translate user',
      promptTranslationProfileId: 'translation-model',
      useImageInterrogation: true,
      imageInterrogationSystemPrompt: 'Inspect system',
      imageInterrogationUserPrompt: 'Inspect user',
      imageInterrogationProfileId: 'vision-model'
    }
  }) as never

describe('builtInSkills', () => {
  it('adds active built-in workflows ahead of persisted custom skills', () => {
    const merged = mergeBuiltInSkills([
      {
        id: 'ops-agent',
        category: 'Ops',
        skillName: 'Ops Agent',
        prompt: 'Handle ops tasks.',
        type: 'agent',
        apiAddress: 'https://example.com/agent'
      }
    ])

    expect(merged[0]?.id).toBe(BUILT_IN_IMAGE_INTERROGATION_SKILL_ID)
    expect(merged.some((skill) => skill.id === BUILT_IN_PROMPT_TRANSLATION_SKILL_ID)).toBe(true)
    expect(merged.some((skill) => skill.id === BUILT_IN_TAGGING_SKILL_ID)).toBe(false)
    expect(merged.some((skill) => skill.id === 'ops-agent')).toBe(true)
  })

  it('drops persisted legacy tagging skills from the merged skill list', () => {
    const merged = mergeBuiltInSkills([
      {
        id: BUILT_IN_TAGGING_SKILL_ID,
        category: 'Studio',
        skillName: 'Tagging',
        prompt: 'Use the studio tagging prompt.',
        type: 'normal'
      }
    ])

    expect(merged.find((skill) => skill.id === BUILT_IN_TAGGING_SKILL_ID)).toBeUndefined()
  })

  it('builds image interrogation and prompt translation built-ins from qapp settings', () => {
    const config = createConfig()

    expect(buildBuiltInImageInterrogationSkill({ config })).toEqual(
      expect.objectContaining({
        id: BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
        prompt: 'Inspect system\n\nInspect user'
      })
    )
    expect(buildBuiltInPromptTranslationSkill({ config })).toEqual(
      expect.objectContaining({
        id: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
        prompt: 'Translate system\n\nTranslate user'
      })
    )
  })

  it('builds only active built-in workflows for the picker and manager surfaces', () => {
    const skills = buildBuiltInSkills({ config: createConfig() })

    expect(skills.map((skill) => skill.id)).toEqual([
      BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
      BUILT_IN_PROMPT_TRANSLATION_SKILL_ID
    ])
  })

  it('does not restore removed tagging selections through the merged skill list', () => {
    const restored = normalizeRestoredSkillSelection(
      mergeBuiltInSkills(undefined),
      BUILT_IN_TAGGING_SKILL_ID
    )

    expect(restored.skillId).toBeNull()
  })

  it('removes legacy tagging skills when persisting custom skills', () => {
    const stripped = stripDefaultBuiltInSkills([
      {
        id: BUILT_IN_TAGGING_SKILL_ID,
        category: 'Studio',
        skillName: 'Tagging',
        prompt: 'Use my custom tagging prompt.',
        type: 'normal'
      }
    ])

    expect(stripped).toEqual([])
  })
})
