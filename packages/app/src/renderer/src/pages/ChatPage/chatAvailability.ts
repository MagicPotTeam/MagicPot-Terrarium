export const shouldShowNoApiWarning = (params: {
  availableProfileCount: number
  useRemoteLlm: boolean
  hasExternalAgentSkills: boolean
}): boolean =>
  params.availableProfileCount === 0 && !params.useRemoteLlm && !params.hasExternalAgentSkills
