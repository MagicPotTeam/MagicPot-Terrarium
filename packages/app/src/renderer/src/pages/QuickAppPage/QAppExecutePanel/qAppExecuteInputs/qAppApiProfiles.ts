import { Config, LLMAPIProfile } from '@shared/config/config'
import {
  getQAppApiProfiles as getSharedQAppApiProfiles,
  isConfiguredApiProfile,
  isVisionCapableApiProfile
} from '@shared/config/apiProfileSelectors'

export const getQAppApiProfiles = (config: Config): LLMAPIProfile[] =>
  getSharedQAppApiProfiles(config)

const isConfiguredProfile = (profile: LLMAPIProfile): boolean => isConfiguredApiProfile(profile)

export const getConfiguredQAppApiProfiles = (config: Config): LLMAPIProfile[] =>
  getQAppApiProfiles(config).filter(isConfiguredProfile)

export const findQAppApiProfile = (
  config: Config,
  options?: {
    needVisionModel?: boolean
    profileId?: string
  }
): LLMAPIProfile | undefined => {
  const { needVisionModel = false, profileId } = options || {}
  const configuredProfiles = getConfiguredQAppApiProfiles(config)

  const matchesNeedVision = (profile: LLMAPIProfile) =>
    !needVisionModel || isVisionCapableApiProfile(profile)

  if (profileId) {
    const selectedProfile = configuredProfiles.find(
      (profile) => profile.id === profileId && matchesNeedVision(profile)
    )
    if (selectedProfile) {
      return selectedProfile
    }
  }

  if (needVisionModel) {
    return configuredProfiles.find(matchesNeedVision)
  }

  return configuredProfiles.find((profile) => !profile.is_vision_model) || configuredProfiles[0]
}
