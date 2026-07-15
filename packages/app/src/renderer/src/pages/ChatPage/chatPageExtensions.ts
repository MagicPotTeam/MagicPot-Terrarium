import type { Config } from '@shared/config/config'
import type { ChatCapabilityProfile } from '@shared/llm'
import { resolveProjectResourceDir } from '@renderer/utils/projectResourcePaths'
import {
  resolveRendererAssistantImageAutoSaveDir,
  resolveRendererChatReasoningPreferenceKey
} from '@renderer/extensions/rendererHostExtensionHelpers'
import { getBaseProfileId } from './chatPageShared'

export const resolveChatReasoningPreferenceKey = (
  profileId: string | null | undefined,
  profile?: ChatCapabilityProfile | null
): string | null =>
  resolveRendererChatReasoningPreferenceKey(profileId, profile, () => {
    const baseProfileId = getBaseProfileId(profileId)
    if (baseProfileId) {
      return baseProfileId
    }

    const modelName = String(profile?.model_name || '')
      .trim()
      .toLowerCase()
    return modelName || null
  })

export const resolveAssistantImageAutoSaveDir = (options: {
  config: Pick<Config, 'download_dir'>
  storageScope?: string
}): string | undefined =>
  resolveRendererAssistantImageAutoSaveDir(options, () =>
    resolveProjectResourceDir({
      config: { download_dir: options.config.download_dir },
      segments: ['.AutoSave', 'Agent']
    })
  )
