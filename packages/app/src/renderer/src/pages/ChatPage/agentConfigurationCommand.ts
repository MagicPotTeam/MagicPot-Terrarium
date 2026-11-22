export type AgentConfigurationCommand = 'plugin' | 'module'
export function isAgentConfigurationCommand(text: string): boolean {
  return /^\/(?:plugin|module)(?:\s|$)/i.test(text.trimStart())
}
/** Changes stay in the existing user editor, where approval/revocation remains authoritative. */
export function parseAgentConfigurationCommand(text: string): AgentConfigurationCommand | undefined {
  if (!isAgentConfigurationCommand(text)) return undefined
  const match = /^\/(plugin|module)(?:\s+configure)?$/i.exec(text.trim())
  if (!match) throw new Error('Use /plugin [configure] or /module [configure]. Change switches and parameters in the existing editor.')
  return match[1].toLowerCase() as AgentConfigurationCommand
}
