import type { Config } from '@shared/config/config'
import type { ChatCapabilityProfile } from '@shared/llm'
import {
  resolveProjectIdFromStorageScope,
  resolveProjectResourceDir
} from '@renderer/utils/projectResourcePaths'
import { rendererHostExtensionApiV1 } from '@renderer/extensions/generatedRegistry'
import { getBaseProfileId } from './chatPageShared'

export const resolveChatReasoningPreferenceKey = (
  profileId: string | null | undefined,
  profile?: ChatCapabilityProfile | null
): string | null => {
  const extensionValue = rendererHostExtensionApiV1.chat?.resolveReasoningPreferenceKey?.(
    profileId,
    profile
  )
  if (extensionValue !== undefined) {
    return extensionValue
  }

  const baseProfileId = getBaseProfileId(profileId)
  if (baseProfileId) {
    return baseProfileId
  }

  const modelName = String(profile?.model_name || '')
    .trim()
    .toLowerCase()
  return modelName || null
}

export const resolveAssistantImageAutoSaveDir = (options: {
  config: Pick<Config, 'download_dir'>
  storageScope?: string
}): string | undefined => {
  const extensionValue =
    rendererHostExtensionApiV1.chat?.resolveAssistantImageAutoSaveDir?.(options)
  if (extensionValue !== undefined) {
    return extensionValue
  }

  return resolveProjectResourceDir({
    config: { download_dir: options.config.download_dir },
    projectId: resolveProjectIdFromStorageScope(options.storageScope),
    segments: ['.AutoSave', 'Agent']
  })
}
