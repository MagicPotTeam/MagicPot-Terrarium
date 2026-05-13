import type {
  Config,
  CustomSkill,
  CustomSkillBinding,
  CustomSkillExecutionPolicy,
  CustomSkillContextMessageLimit,
  CustomSkillOutputSchema
} from '@shared/config/config'
import type { LLMChatSkillRuntime } from '@shared/api/svcLLMProxy'
import { buildMagicPotAppCatalog, findMagicPotAppById } from '@shared/app/catalog'
import {
  normalizeMagicPotResourceUri,
  normalizeMagicPotToolName,
  type MagicPotAppDefinition
} from '@shared/app/types'
import { valueIsJsonDict } from '@shared/utils/utilTypes'
import {
  BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
  BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
  BUILT_IN_TAGGING_SKILL_ID,
  buildBuiltInImageInterrogationInstructions,
  buildBuiltInPromptTranslationInstructions,
  buildBuiltInTaggingInstructions
} from './builtInSkills'

export type SkillRuntimeInstructions = {
  systemPrompt?: string
  userPrompt?: string
}

export type SkillRuntimeSpec = {
  skill: CustomSkill | null
  instructions: SkillRuntimeInstructions
  execution: Required<Omit<CustomSkillExecutionPolicy, 'contextMessageLimit'>> & {
    contextMessageLimit?: CustomSkillContextMessageLimit
  }
  outputSchema?: CustomSkillOutputSchema
  resources: string[]
  scripts: string[]
  boundApps: MagicPotAppDefinition[]
  boundBindings: Array<{
    app: MagicPotAppDefinition
    toolNames: string[]
    resourceUris: string[]
  }>
  unavailableBindings: Array<{
    appId: string
    appName?: string
    reason: string
    requestedToolNames: string[]
    requestedResourceUris: string[]
  }>
}

const DEFAULT_EXECUTION_POLICY: Required<Omit<CustomSkillExecutionPolicy, 'contextMessageLimit'>> =
  {
    mode: 'inherit',
    allowHistory: true,
    outputMode: 'default',
    fallbackStrategy: 'default',
    persistSessionUrl: true
  }

const buildLegacyInstructions = (
  skill: CustomSkill | null,
  config?: Config | null
): SkillRuntimeInstructions => {
  if (!skill) {
    return {}
  }

  if (skill.id === BUILT_IN_TAGGING_SKILL_ID) {
    return buildBuiltInTaggingInstructions(config)
  }

  if (skill.id === BUILT_IN_IMAGE_INTERROGATION_SKILL_ID) {
    return buildBuiltInImageInterrogationInstructions(config)
  }

  if (skill.id === BUILT_IN_PROMPT_TRANSLATION_SKILL_ID) {
    return buildBuiltInPromptTranslationInstructions(config)
  }

  const prompt = skill.prompt?.trim()
  return prompt ? { systemPrompt: prompt } : {}
}

const mergeExecutionPolicy = (skill: CustomSkill | null): SkillRuntimeSpec['execution'] => ({
  ...DEFAULT_EXECUTION_POLICY,
  ...(skill?.execution || {})
})

const hasExplicitArrayBinding = (
  binding: CustomSkillBinding | undefined,
  key: 'toolNames' | 'resourceUris'
): boolean => Array.isArray(binding?.[key])

const resolveDefaultBoundAppIds = (skillId: string | null | undefined): string[] => {
  switch (skillId) {
    case BUILT_IN_TAGGING_SKILL_ID:
    case BUILT_IN_IMAGE_INTERROGATION_SKILL_ID:
      return ['qapp.image-interrogation']
    case BUILT_IN_PROMPT_TRANSLATION_SKILL_ID:
      return ['qapp.prompt-translation']
    default:
      return []
  }
}

export const resolveSkillRuntimeSpec = (
  skill: CustomSkill | null | undefined,
  config?: Config | null,
  apps?: MagicPotAppDefinition[]
): SkillRuntimeSpec => {
  const availableApps = apps || buildMagicPotAppCatalog(config)
  const normalizedSkill = skill || null
  const isExternalAgentSkill = normalizedSkill?.type === 'agent'
  const instructions = isExternalAgentSkill
    ? {}
    : normalizedSkill?.instructions &&
        (normalizedSkill.instructions.systemPrompt || normalizedSkill.instructions.userPrompt)
      ? {
          systemPrompt: normalizedSkill.instructions.systemPrompt?.trim() || undefined,
          userPrompt: normalizedSkill.instructions.userPrompt?.trim() || undefined
        }
      : buildLegacyInstructions(normalizedSkill, config)

  const execution = mergeExecutionPolicy(normalizedSkill)
  const candidateOutputSchema = normalizedSkill?.outputSchema
  const outputSchema =
    candidateOutputSchema !== undefined && valueIsJsonDict(candidateOutputSchema)
      ? candidateOutputSchema
      : undefined
  const resources = (normalizedSkill?.resources || []).map((value) => value.trim()).filter(Boolean)
  const scripts = (normalizedSkill?.scripts || []).map((value) => value.trim()).filter(Boolean)
  const boundAppIds = normalizedSkill?.bindings?.map((binding) => binding.appId) || []
  const defaultBoundAppIds = resolveDefaultBoundAppIds(normalizedSkill?.id)
  const resolvedAppIds = [...new Set([...defaultBoundAppIds, ...boundAppIds])]
  const boundApps = resolvedAppIds
    .map((appId) => findMagicPotAppById(availableApps, appId))
    .filter((app): app is MagicPotAppDefinition => Boolean(app))
  const boundBindings: SkillRuntimeSpec['boundBindings'] = []
  const unavailableBindings: SkillRuntimeSpec['unavailableBindings'] = []

  resolvedAppIds.forEach((appId) => {
    const app = findMagicPotAppById(availableApps, appId)
    const binding = normalizedSkill?.bindings?.find((item) => item.appId === appId)
    const requestedToolNames = (
      binding && hasExplicitArrayBinding(binding, 'toolNames')
        ? binding.toolNames || []
        : app?.capabilities.tools.map((tool) => tool.name) || []
    )
      .map((value) => normalizeMagicPotToolName(value))
      .filter(Boolean)
    const requestedResourceUris = (
      binding && hasExplicitArrayBinding(binding, 'resourceUris')
        ? binding.resourceUris || []
        : app?.capabilities.resources.map((resource) => resource.uri) || []
    )
      .map((value) => normalizeMagicPotResourceUri(value))
      .filter(Boolean)

    if (!app) {
      unavailableBindings.push({
        appId,
        reason: 'missing-app',
        requestedToolNames: [...new Set(requestedToolNames)],
        requestedResourceUris: [...new Set(requestedResourceUris)]
      })
      return
    }

    if (!app.enabled || app.status !== 'ready') {
      unavailableBindings.push({
        appId,
        appName: app.name,
        reason: app.enabled ? app.status : 'disabled',
        requestedToolNames: [...new Set(requestedToolNames)],
        requestedResourceUris: [...new Set(requestedResourceUris)]
      })
      return
    }

    const availableToolNames = new Set(
      app.capabilities.tools.map((tool) => normalizeMagicPotToolName(tool.name))
    )
    const availableResourceUris = new Set(
      app.capabilities.resources.map((resource) => normalizeMagicPotResourceUri(resource.uri))
    )
    const resolvedToolNames = [
      ...new Set(requestedToolNames.filter((name) => availableToolNames.has(name)))
    ]
    const resolvedResourceUris = [
      ...new Set(requestedResourceUris.filter((uri) => availableResourceUris.has(uri)))
    ]
    const missingToolNames = requestedToolNames.filter((name) => !availableToolNames.has(name))
    const missingResourceUris = requestedResourceUris.filter(
      (uri) => !availableResourceUris.has(uri)
    )

    boundBindings.push({
      app,
      toolNames: resolvedToolNames,
      resourceUris: resolvedResourceUris
    })

    if (missingToolNames.length > 0 || missingResourceUris.length > 0) {
      unavailableBindings.push({
        appId,
        appName: app.name,
        reason: 'missing-capabilities',
        requestedToolNames: [...new Set(missingToolNames)],
        requestedResourceUris: [...new Set(missingResourceUris)]
      })
    }
  })

  return {
    skill: normalizedSkill,
    instructions,
    execution,
    outputSchema,
    resources,
    scripts,
    boundApps,
    boundBindings,
    unavailableBindings
  }
}

export const buildSystemPromptFromSkillRuntime = (runtime: SkillRuntimeSpec): string | undefined =>
  runtime.instructions.systemPrompt?.trim() || undefined

export const buildUserPromptFromSkillRuntime = (runtime: SkillRuntimeSpec): string | undefined =>
  runtime.instructions.userPrompt?.trim() || undefined

export const serializeSkillRuntimeSpec = (
  runtime: SkillRuntimeSpec
): LLMChatSkillRuntime | undefined => {
  if (!runtime.skill) {
    return undefined
  }

  const candidateOutputSchema = runtime.outputSchema

  return {
    skillId: runtime.skill.id,
    instructions:
      runtime.instructions.systemPrompt || runtime.instructions.userPrompt
        ? {
            ...(runtime.instructions.systemPrompt
              ? { systemPrompt: runtime.instructions.systemPrompt }
              : {}),
            ...(runtime.instructions.userPrompt
              ? { userPrompt: runtime.instructions.userPrompt }
              : {})
          }
        : undefined,
    execution: runtime.execution,
    outputSchema:
      candidateOutputSchema !== undefined && valueIsJsonDict(candidateOutputSchema)
        ? candidateOutputSchema
        : undefined,
    resources: runtime.resources.length > 0 ? runtime.resources : undefined,
    scripts: runtime.scripts.length > 0 ? runtime.scripts : undefined,
    bindings:
      runtime.boundBindings.length > 0
        ? runtime.boundBindings.map((binding) => ({
            appId: binding.app.id,
            appName: binding.app.name,
            transport: binding.app.transport,
            source: binding.app.source,
            toolNames: binding.toolNames,
            resourceUris: binding.resourceUris
          }))
        : undefined
  }
}

export const buildSkillRuntimeCapabilityContext = (
  runtime: SkillRuntimeSpec
): string | undefined => {
  const lines: string[] = []

  switch (runtime.execution.outputMode) {
    case 'text':
      lines.push('Skill output mode: text. Return text only; do not return generated media.')
      break
    case 'image':
      lines.push(
        'Skill output mode: image. Return only actual image output. A text description is not a completed image deliverable.'
      )
      break
    case 'video':
      lines.push(
        'Skill output mode: video. Return only actual video output. A text description is not a completed video deliverable.'
      )
      break
    case 'model3d':
      lines.push(
        'Skill output mode: 3D. Return only actual 3D model output. A text description is not a completed 3D deliverable.'
      )
      break
    case 'chat':
    case 'default':
      break
    default:
      lines.push(`Skill output mode: ${runtime.execution.outputMode}.`)
  }

  if (runtime.execution.outputMode === 'structured' && runtime.outputSchema) {
    lines.push('Structured output schema is active for this skill.')
  }

  if (runtime.execution.fallbackStrategy !== 'default') {
    lines.push(`Attachment fallback strategy: ${runtime.execution.fallbackStrategy}.`)
  }

  if (runtime.boundBindings.length > 0) {
    lines.push('Resolved bound apps and capabilities:')
    runtime.boundBindings.forEach((binding) => {
      const capabilityBits = [
        binding.toolNames.length > 0 ? `tools=${binding.toolNames.join(', ')}` : '',
        binding.resourceUris.length > 0 ? `resources=${binding.resourceUris.join(', ')}` : ''
      ].filter(Boolean)
      lines.push(
        `- ${binding.app.name} (${binding.app.id}; transport=${binding.app.transport}; source=${binding.app.source})${
          capabilityBits.length > 0 ? ` -> ${capabilityBits.join(' ; ')}` : ''
        }`
      )
    })
  }

  if (runtime.unavailableBindings.length > 0) {
    lines.push('Unavailable bound apps or capabilities:')
    runtime.unavailableBindings.forEach((binding) => {
      const capabilityBits = [
        binding.requestedToolNames.length > 0
          ? `requested tools=${binding.requestedToolNames.join(', ')}`
          : '',
        binding.requestedResourceUris.length > 0
          ? `requested resources=${binding.requestedResourceUris.join(', ')}`
          : ''
      ].filter(Boolean)
      lines.push(
        `- ${binding.appName || binding.appId} (${binding.reason})${
          capabilityBits.length > 0 ? ` -> ${capabilityBits.join(' ; ')}` : ''
        }`
      )
    })
  }

  if (runtime.resources.length > 0) {
    lines.push('Skill resources:')
    runtime.resources.forEach((resource) => lines.push(`- ${resource}`))
  }

  if (runtime.scripts.length > 0) {
    lines.push('Skill scripts:')
    runtime.scripts.forEach((script) => lines.push(`- ${script}`))
  }

  return lines.length > 0 ? lines.join('\n') : undefined
}
