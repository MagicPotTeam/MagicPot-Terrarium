export type AgentInspectionCommand = 'env' | 'system_prompt'
export function isAgentInspectionCommand(text: string): boolean {
  return /^\/(?:env|system_prompt)(?:\s|$)/i.test(text.trimStart())
}
export function parseAgentInspectionCommand(text: string): AgentInspectionCommand | undefined {
  if (!isAgentInspectionCommand(text)) return undefined
  const match = /^\/(env|system_prompt)$/i.exec(text.trim())
  if (!match) throw new Error('Use /env or /system_prompt without arguments.')
  return match[1].toLowerCase() as AgentInspectionCommand
}
/** Deliberate whitelist: no process environment, paths, credentials or provider endpoints. */
export function formatAgentEnvironment(value: {
  conversationId: string
  profileId: string | null
  skillId: string | null
  storageScope: string
  remote: boolean
  route?: { channel?: string; scopeType?: string; scopeId?: string; threadId?: string }
}): string {
  return JSON.stringify({
    conversationId: value.conversationId,
    profileId: value.profileId,
    skillId: value.skillId,
    storageScope: value.storageScope,
    remote: value.remote,
    route: value.route ? {
      channel: value.route.channel, scopeType: value.route.scopeType,
      scopeId: value.route.scopeId, threadId: value.route.threadId
    } : null
  }, null, 2)
}
