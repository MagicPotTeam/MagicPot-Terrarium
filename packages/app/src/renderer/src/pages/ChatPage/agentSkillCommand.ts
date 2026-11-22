export type AgentSkillCommand = { action: 'list' } | { action: 'show' | 'enable' | 'disable' | 'toggle'; name: string }
export type AgentSkillCommandHandle = { execute(command: AgentSkillCommand, expectedScope: string): boolean }
export const isAgentSkillCommand = (text: string) => /^\/skills?(?:\s|$)/i.test(text.trimStart())
/** User-composer grammar only. A command is never synthesized from model output. */
export function parseAgentSkillCommand(text: string): AgentSkillCommand | undefined {
  if (!isAgentSkillCommand(text)) return undefined
  const command = text.trim().replace(/^\/skills?/i, '').trim()
  if (!command || /^list$/i.test(command)) return { action: 'list' }
  const match = command.match(/^(show|enable|disable|toggle)\s+([^\r\n]+)$/i)
  if (!match || !match[2].trim() || match[2].trim().length > 128 || Array.from(match[2]).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Invalid user skill command.')
  return { action: match[1].toLowerCase() as 'show' | 'enable' | 'disable' | 'toggle', name: match[2].trim() }
}
