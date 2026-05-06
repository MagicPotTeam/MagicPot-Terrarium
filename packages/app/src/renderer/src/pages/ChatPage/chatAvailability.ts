export const shouldShowNoApiWarning = (params: {
  availableProfileCount: number
  useRemoteLlm: boolean
  hasExternalAgentSkills: boolean
  compact: boolean
  isSkillPickerOpen: boolean
  hasCustomSkills: boolean
}): boolean => {
  const noBuiltInChatRuntime =
    params.availableProfileCount === 0 && !params.useRemoteLlm && !params.hasExternalAgentSkills

  if (!noBuiltInChatRuntime) {
    return false
  }

  return !(params.compact && params.isSkillPickerOpen && params.hasCustomSkills)
}
