import { isBuiltInSkillId } from './builtInSkills'

const resolveConfiguredProfileIdForBuiltInSkill = (options: {
  skillId: string | null | undefined
  configuredProfileId: string | null | undefined
}): string | null => {
  return options.configuredProfileId || null
}

export const resolveTaggingSkillBootstrapProfileId = (options: {
  skillId: string | null | undefined
  configuredProfileId: string | null | undefined
  fallbackProfileId: string | null | undefined
}): string | null => {
  if (isBuiltInSkillId(options.skillId)) {
    return resolveConfiguredProfileIdForBuiltInSkill(options)
  }

  return options.fallbackProfileId || null
}

export const resolveTaggingSkillProfileId = (options: {
  skillId: string | null | undefined
  currentProfileId: string | null | undefined
  configuredProfileId: string | null | undefined
  preferConfiguredProfile?: boolean
}): string | null => {
  if (!isBuiltInSkillId(options.skillId)) {
    return options.currentProfileId || null
  }

  const configuredProfileId = resolveConfiguredProfileIdForBuiltInSkill(options)

  if (options.preferConfiguredProfile && configuredProfileId) {
    return configuredProfileId
  }

  return options.currentProfileId || configuredProfileId || null
}
