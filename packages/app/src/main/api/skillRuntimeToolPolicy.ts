import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { normalizeAllowedToolNames } from '../assistantRuntime/toolAccess'

export const extractSkillRuntimeAllowedToolNames = (req: LLMChatReq): string[] | null => {
  const bindings = req.skillRuntime?.bindings || []
  const explicitToolBindings = bindings.filter((binding) => Array.isArray(binding.toolNames))
  if (!explicitToolBindings.length) {
    // MagicAgentRuntime deliberately omits an allowlist when the agent uses its
    // default tool surface. Keep ordinary custom skills fail-closed while
    // giving Agent threads the built-in web tools so the model can decide when
    // browsing is genuinely useful without a "please search" prompt.
    if (
      bindings.some(
        (binding) =>
          binding.source === 'magicAgentRuntime' || binding.source === 'assistant-runtime'
      )
    ) {
      return ['web_search', 'web_fetch']
    }
    return null
  }

  return (
    normalizeAllowedToolNames(explicitToolBindings.flatMap((binding) => binding.toolNames || [])) ||
    []
  )
}
