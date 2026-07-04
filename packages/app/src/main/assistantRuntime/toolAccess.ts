import { normalizeMagicPotToolName } from '@shared/app/types'
import type { AssistantToolDefinition } from './toolRegistry'

const normalizeToolName = (value?: string | null): string => normalizeMagicPotToolName(value)

export const normalizeAllowedToolNames = (allowedToolNames?: string[] | null): string[] | null => {
  if (!Array.isArray(allowedToolNames)) {
    return null
  }

  return [...new Set(allowedToolNames.map((value) => normalizeToolName(value)).filter(Boolean))]
}

export const filterAssistantToolsByAllowlist = (
  tools: AssistantToolDefinition[],
  allowedToolNames?: string[] | null
): AssistantToolDefinition[] => {
  const allowlist = normalizeAllowedToolNames(allowedToolNames)
  if (!allowlist) {
    return tools
  }

  const allowed = new Set(allowlist)
  return tools.filter((tool) => allowed.has(normalizeToolName(tool.name)))
}

export const assertAssistantToolAllowed = (
  toolName: string,
  allowedToolNames?: string[] | null
): void => {
  const allowlist = normalizeAllowedToolNames(allowedToolNames)
  if (!allowlist) {
    return
  }

  if (!allowlist.includes(normalizeToolName(toolName))) {
    throw new Error(`Tool "${toolName}" is not bound to the current skill.`)
  }
}
