import { normalizeMagicPotToolName } from '@shared/app/types'

const MAGIC_AGENT_PLATFORM_DENIED_TOOL_NAME_VALUES = [
  'agent.terminal.run',
  'chat.tool.agent.terminal.run',
  'terminal.run',
  'magicagent.creative.terminal.run',
  'magicagent.platform.tool.creative.terminal.run'
] as const

const MAGIC_AGENT_PLATFORM_DENIED_TOOL_NAMES = new Set(
  MAGIC_AGENT_PLATFORM_DENIED_TOOL_NAME_VALUES.map((name) => normalizeMagicPotToolName(name))
)

export const isMagicAgentPlatformDeniedToolName = (toolName?: string | null): boolean =>
  MAGIC_AGENT_PLATFORM_DENIED_TOOL_NAMES.has(normalizeMagicPotToolName(toolName))
