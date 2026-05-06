import {
  DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT,
  DEFAULT_IMAGE_INTERROGATION_USER_PROMPT,
  type Config,
  type CustomSkill,
  type CustomSkillInstructions,
  fromSkillManifest,
  type SkillManifest
} from '@shared/config/config'
import {
  QUICK_APP_IMAGE_INTERROGATION_APP_ID,
  QUICK_APP_PROMPT_TRANSLATION_APP_ID
} from '@shared/app/types'
import { getQAppPromptSettings } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/qAppPromptSettings'

export const BUILT_IN_TAGGING_SKILL_ID = 'builtin-tagging'
export const BUILT_IN_IMAGE_INTERROGATION_SKILL_ID = 'builtin-image-interrogation'
export const BUILT_IN_PROMPT_TRANSLATION_SKILL_ID = 'builtin-prompt-translation'

export const BUILT_IN_TAGGING_SKILL_ORIGIN = 'builtin-tagging-default'
export const BUILT_IN_IMAGE_INTERROGATION_SKILL_ORIGIN = 'builtin-image-interrogation-default'
export const BUILT_IN_PROMPT_TRANSLATION_SKILL_ORIGIN = 'builtin-prompt-translation-default'

const TAGGING_DESCRIPTION =
  'Describe the uploaded image and produce sidecar-ready tags and caption.'
const DESCRIPTION_PLACEHOLDER = '{{description}}'
const IMAGE_INTERROGATION_RESOURCE_URIS = [
  'qapp.imageInterrogation.systemPrompt',
  'qapp.imageInterrogation.userPrompt'
] as const
const PROMPT_TRANSLATION_RESOURCE_URIS = [
  'qapp.promptTranslation.systemPrompt',
  'qapp.promptTranslation.userPrompt'
] as const

const LEGACY_BUILT_IN_TAGGING_PROMPT = [
  "You are MagicPot's built-in image tagging skill.",
  'This workflow is file-oriented and should produce sidecar-ready text for local image files.',
  'Treat each image independently, even when multiple images are sent in batches.',
  'Return only the final sidecar text for the current image.',
  'Output exactly two lines in this format:',
  'tags: comma-separated concise English tags',
  'caption: one short English caption',
  'Do not output markdown fences, JSON, numbering, explanations, or file names unless the user explicitly asks for them.'
].join('\n')
const BUILT_IN_TAGGING_STRUCTURED_RESPONSE_PROMPT = [
  'Return JSON only.',
  'Preferred response schema:',
  JSON.stringify(
    {
      results: [
        {
          fileName: 'asset.png',
          tags: ['tag one', 'tag two'],
          tagsText: 'tag one, tag two',
          caption: 'A short English caption.',
          ocrResult: {
            kind: 'document',
            text: 'Optional OCR text when present.'
          }
        }
      ]
    },
    null,
    2
  ),
  'If there is only one asset, returning a single object with the same fields is also allowed.',
  'Do not return legacy "tags:" / "caption:" plain-text lines.'
].join('\n')

type BuiltInSkillOptions = {
  language?: string | null
  config?: Config | null
}

type BuiltInSkillDefinition = {
  id: string
  origin: string
  categoryZh: string
  categoryEn: string
  nameZh: string
  nameEn: string
  descriptionZh: string
  descriptionEn: string
  buildInstructions: (config?: Config | null) => CustomSkillInstructions
  execution: NonNullable<CustomSkill['execution']>
  bindings: NonNullable<CustomSkill['bindings']>
  resources?: string[]
  scripts?: string[]
}

const BUILT_IN_SKILL_IDS = [
  BUILT_IN_TAGGING_SKILL_ID,
  BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
  BUILT_IN_PROMPT_TRANSLATION_SKILL_ID
] as const

const REMOVED_BUILT_IN_SKILL_IDS = [BUILT_IN_TAGGING_SKILL_ID] as const

const isRemovedBuiltInSkillId = (skillId: string | null | undefined): boolean =>
  Boolean(
    skillId &&
    REMOVED_BUILT_IN_SKILL_IDS.includes(skillId as (typeof REMOVED_BUILT_IN_SKILL_IDS)[number])
  )

const resolveLocalizedLabel = (
  language: string | null | undefined,
  chinese: string,
  english: string
): string => {
  const normalized = (language || '').toLowerCase()
  return normalized.startsWith('zh') ? chinese : english
}

const resolveTemplate = (template: string, placeholder: string, value: string): string =>
  template.trim().split(placeholder).join(value)

const getPromptMirror = (instructions: CustomSkillInstructions): string =>
  [instructions.systemPrompt?.trim() || '', instructions.userPrompt?.trim() || '']
    .filter(Boolean)
    .join('\n\n')

const resolveImageInterrogationPromptTemplates = (config?: Config | null) => {
  if (config) {
    const settings = getQAppPromptSettings(config)
    return {
      systemPromptTemplate:
        settings.imageInterrogationSystemPrompt || DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT,
      userPromptTemplate:
        settings.imageInterrogationUserPrompt || DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
    }
  }

  return {
    systemPromptTemplate: DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT,
    userPromptTemplate: DEFAULT_IMAGE_INTERROGATION_USER_PROMPT
  }
}

export const buildBuiltInTaggingInstructions = (
  config?: Config | null
): CustomSkillInstructions => {
  const { systemPromptTemplate, userPromptTemplate } =
    resolveImageInterrogationPromptTemplates(config)
  const systemPrompt = resolveTemplate(
    systemPromptTemplate,
    DESCRIPTION_PLACEHOLDER,
    TAGGING_DESCRIPTION
  ).trim()
  const userPrompt = resolveTemplate(
    userPromptTemplate,
    DESCRIPTION_PLACEHOLDER,
    TAGGING_DESCRIPTION
  ).trim()

  return {
    ...(systemPrompt
      ? {
          systemPrompt: [systemPrompt, BUILT_IN_TAGGING_STRUCTURED_RESPONSE_PROMPT]
            .filter(Boolean)
            .join('\n\n')
        }
      : {}),
    ...(userPrompt ? { userPrompt } : {})
  }
}

export const buildBuiltInImageInterrogationInstructions = (
  config?: Config | null
): CustomSkillInstructions => {
  const settings = config ? getQAppPromptSettings(config) : null
  const systemPrompt =
    settings?.imageInterrogationSystemPrompt?.trim() || DEFAULT_IMAGE_INTERROGATION_SYSTEM_PROMPT
  const userPrompt =
    settings?.imageInterrogationUserPrompt?.trim() || DEFAULT_IMAGE_INTERROGATION_USER_PROMPT

  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(userPrompt ? { userPrompt } : {})
  }
}

export const buildBuiltInPromptTranslationInstructions = (
  config?: Config | null
): CustomSkillInstructions => {
  const settings = config ? getQAppPromptSettings(config) : null
  const systemPrompt = settings?.promptTranslationSystemPrompt?.trim() || ''
  const userPrompt = settings?.promptTranslationUserPrompt?.trim() || ''

  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(userPrompt ? { userPrompt } : {})
  }
}

const buildPreviousDefaultBuiltInTaggingPrompt = (config?: Config | null): string => {
  const instructions = buildBuiltInTaggingInstructions(config)

  return [
    instructions.systemPrompt || LEGACY_BUILT_IN_TAGGING_PROMPT,
    instructions.userPrompt ? `Also follow this user prompt:\n${instructions.userPrompt}` : null,
    'Treat each image independently, even when multiple images are sent in batches.',
    'Return only the final sidecar text for the current image.',
    'Output exactly two lines in this format:',
    'tags: comma-separated concise English tags',
    'caption: one short English caption',
    'Do not output markdown fences, JSON, numbering, explanations, or file names unless the user explicitly asks for them.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const buildBuiltInTaggingPrompt = (config?: Config | null): string =>
  getPromptMirror(buildBuiltInTaggingInstructions(config))

export const buildBuiltInImageInterrogationPrompt = (config?: Config | null): string =>
  getPromptMirror(buildBuiltInImageInterrogationInstructions(config))

export const buildBuiltInPromptTranslationPrompt = (config?: Config | null): string =>
  getPromptMirror(buildBuiltInPromptTranslationInstructions(config))

const buildBuiltInSkillDefinitions = (): BuiltInSkillDefinition[] => [
  {
    id: BUILT_IN_TAGGING_SKILL_ID,
    origin: BUILT_IN_TAGGING_SKILL_ORIGIN,
    categoryZh: '打标',
    categoryEn: 'Tagging',
    nameZh: '打标',
    nameEn: 'Tagging',
    descriptionZh: '复用快应用图片反推配置的内置打标技能。',
    descriptionEn: 'Built-in tagging skill that reuses Quick App image interrogation settings.',
    buildInstructions: buildBuiltInTaggingInstructions,
    execution: {
      mode: 'isolated',
      allowHistory: false,
      outputMode: 'structured',
      fallbackStrategy: 'smaller-batches',
      persistSessionUrl: false
    },
    bindings: [
      {
        appId: QUICK_APP_IMAGE_INTERROGATION_APP_ID,
        resourceUris: [...IMAGE_INTERROGATION_RESOURCE_URIS]
      }
    ],
    scripts: ['post:strip-markdown-fences', 'post:trim-text']
  },
  {
    id: BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
    origin: BUILT_IN_IMAGE_INTERROGATION_SKILL_ORIGIN,
    categoryZh: '图片反推',
    categoryEn: 'Image Interrogation',
    nameZh: '图片反推',
    nameEn: 'Image Interrogation',
    descriptionZh: '复用快应用图片反推的提示词和模型配置。',
    descriptionEn:
      'Built-in image interrogation skill that reuses Quick App image interrogation settings.',
    buildInstructions: buildBuiltInImageInterrogationInstructions,
    execution: {
      mode: 'isolated',
      allowHistory: false,
      outputMode: 'chat',
      fallbackStrategy: 'default',
      persistSessionUrl: false
    },
    bindings: [
      {
        appId: QUICK_APP_IMAGE_INTERROGATION_APP_ID,
        resourceUris: [...IMAGE_INTERROGATION_RESOURCE_URIS]
      }
    ],
    scripts: ['post:strip-markdown-fences', 'post:trim-text']
  },
  {
    id: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
    origin: BUILT_IN_PROMPT_TRANSLATION_SKILL_ORIGIN,
    categoryZh: '提示词翻译',
    categoryEn: 'Prompt Translation',
    nameZh: '提示词翻译',
    nameEn: 'Prompt Translation',
    descriptionZh: '复用快应用提示词翻译的提示词和模型配置。',
    descriptionEn:
      'Built-in prompt translation skill that reuses Quick App prompt translation settings.',
    buildInstructions: buildBuiltInPromptTranslationInstructions,
    execution: {
      mode: 'isolated',
      allowHistory: false,
      outputMode: 'chat',
      fallbackStrategy: 'default',
      persistSessionUrl: false
    },
    bindings: [
      {
        appId: QUICK_APP_PROMPT_TRANSLATION_APP_ID,
        resourceUris: [...PROMPT_TRANSLATION_RESOURCE_URIS]
      }
    ],
    scripts: ['post:strip-markdown-fences', 'post:trim-text']
  }
]

const buildBuiltInSkillFromDefinition = (
  definition: BuiltInSkillDefinition,
  options: BuiltInSkillOptions = {}
): CustomSkill => {
  const instructions = definition.buildInstructions(options.config)

  const manifest: SkillManifest = {
    metadata: {
      id: definition.id,
      category: resolveLocalizedLabel(
        options.language,
        definition.categoryZh,
        definition.categoryEn
      ),
      name: resolveLocalizedLabel(options.language, definition.nameZh, definition.nameEn),
      description: resolveLocalizedLabel(
        options.language,
        definition.descriptionZh,
        definition.descriptionEn
      ),
      version: 1,
      builtinOrigin: definition.origin,
      type: 'normal'
    },
    instructions,
    execution: definition.execution,
    bindings: definition.bindings,
    prompt: getPromptMirror(instructions),
    ...(definition.resources?.length ? { resources: definition.resources } : {}),
    ...(definition.scripts?.length ? { scripts: definition.scripts } : {})
  }

  return fromSkillManifest(manifest)
}

export const buildBuiltInTaggingSkill = (options: BuiltInSkillOptions = {}): CustomSkill =>
  buildBuiltInSkillFromDefinition(buildBuiltInSkillDefinitions()[0], options)

export const buildBuiltInImageInterrogationSkill = (
  options: BuiltInSkillOptions = {}
): CustomSkill => buildBuiltInSkillFromDefinition(buildBuiltInSkillDefinitions()[1], options)

export const buildBuiltInPromptTranslationSkill = (
  options: BuiltInSkillOptions = {}
): CustomSkill => buildBuiltInSkillFromDefinition(buildBuiltInSkillDefinitions()[2], options)

const buildLegacyBuiltInTaggingSkill = (language?: string | null): CustomSkill => ({
  id: BUILT_IN_TAGGING_SKILL_ID,
  category: resolveLocalizedLabel(language, '内置', 'Built-in'),
  skillName: resolveLocalizedLabel(language, '打标', 'Tagging'),
  prompt: LEGACY_BUILT_IN_TAGGING_PROMPT,
  type: 'normal'
})

export const buildBuiltInSkills = (options: BuiltInSkillOptions = {}): CustomSkill[] =>
  buildBuiltInSkillDefinitions()
    .filter((definition) => !isRemovedBuiltInSkillId(definition.id))
    .map((definition) => buildBuiltInSkillFromDefinition(definition, options))

export const isBuiltInTaggingSkillId = (skillId: string | null | undefined): boolean =>
  skillId === BUILT_IN_TAGGING_SKILL_ID

export const isBuiltInImageInterrogationSkillId = (skillId: string | null | undefined): boolean =>
  skillId === BUILT_IN_IMAGE_INTERROGATION_SKILL_ID

export const isBuiltInPromptTranslationSkillId = (skillId: string | null | undefined): boolean =>
  skillId === BUILT_IN_PROMPT_TRANSLATION_SKILL_ID

export const isBuiltInSkillId = (skillId: string | null | undefined): boolean =>
  Boolean(skillId && BUILT_IN_SKILL_IDS.includes(skillId as (typeof BUILT_IN_SKILL_IDS)[number]))

export const isDefaultBuiltInTaggingSkill = (
  skill: CustomSkill,
  options: BuiltInSkillOptions = {}
): boolean => {
  if (skill.id !== BUILT_IN_TAGGING_SKILL_ID) {
    return false
  }

  if (skill.builtinOrigin === BUILT_IN_TAGGING_SKILL_ORIGIN) {
    return true
  }

  const currentDefault = buildBuiltInTaggingSkill(options)
  const legacyDefault = buildLegacyBuiltInTaggingSkill(options.language)
  const previousDefault = {
    ...currentDefault,
    prompt: buildPreviousDefaultBuiltInTaggingPrompt(options.config)
  }
  const previousCategoryDefault = {
    ...currentDefault,
    category: resolveLocalizedLabel(options.language, '内置', 'Built-in')
  }
  const previousCategoryPromptDefault = {
    ...previousDefault,
    category: resolveLocalizedLabel(options.language, '内置', 'Built-in')
  }

  const normalizeSkill = (value: CustomSkill) =>
    JSON.stringify({
      id: value.id,
      category: value.category,
      skillName: value.skillName,
      description: value.description || '',
      version: value.version || 0,
      builtinOrigin: value.builtinOrigin || '',
      prompt: value.prompt,
      instructions: value.instructions || null,
      execution: value.execution || null,
      bindings: value.bindings || [],
      resources: value.resources || [],
      scripts: value.scripts || [],
      type: value.type,
      apiAddress: value.apiAddress || '',
      apiKey: value.apiKey || ''
    })

  const serialized = normalizeSkill(skill)
  return (
    serialized === normalizeSkill(currentDefault) ||
    serialized === normalizeSkill(previousDefault) ||
    serialized === normalizeSkill(previousCategoryDefault) ||
    serialized === normalizeSkill(previousCategoryPromptDefault) ||
    serialized === normalizeSkill(legacyDefault)
  )
}

export const isDefaultBuiltInSkill = (
  skill: CustomSkill,
  options: BuiltInSkillOptions = {}
): boolean => {
  if (skill.id === BUILT_IN_TAGGING_SKILL_ID) {
    return isDefaultBuiltInTaggingSkill(skill, options)
  }

  if (!isBuiltInSkillId(skill.id)) {
    return false
  }

  const currentDefault = buildBuiltInSkills(options).find((candidate) => candidate.id === skill.id)
  if (!currentDefault) {
    return false
  }

  return JSON.stringify(skill) === JSON.stringify(currentDefault)
}

export const stripDefaultBuiltInSkills = (
  customSkills: CustomSkill[] | undefined,
  options: BuiltInSkillOptions = {}
): CustomSkill[] =>
  (customSkills || []).filter(
    (skill) => !isRemovedBuiltInSkillId(skill.id) && !isDefaultBuiltInSkill(skill, options)
  )

export const mergeBuiltInSkills = (
  customSkills: CustomSkill[] | undefined,
  options: BuiltInSkillOptions = {}
): CustomSkill[] => {
  const merged = new Map<string, CustomSkill>()
  const persistedCustomSkills = (customSkills || []).filter(
    (skill) => !isRemovedBuiltInSkillId(skill.id)
  )

  for (const skill of [...buildBuiltInSkills(options), ...persistedCustomSkills]) {
    merged.set(skill.id, skill)
  }

  return Array.from(merged.values())
}
