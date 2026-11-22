import { AGENT_SIDE_LIMITS } from '@shared/api/agentThreadSide'

export type AgentSideCommand = { action: 'help' } | { action: 'start'; question: string } | { action: 'open'; branchId: string } | { action: 'stop'; branchId: string } | { action: 'continue'; branchId: string; question: string }
export type AgentSideCommandHandle = { execute(command: AgentSideCommand, expectedScope?: string): boolean }
export const isAgentSideCommand = (text: string): boolean => /^\/btw(?:\s|$)/i.test(text.trimStart())

/** Explicit composer input only, never parse provider output or external auto-send. */
export function parseAgentSideCommand(text: string): AgentSideCommand | undefined {
  if (!isAgentSideCommand(text)) return undefined
  const input = text.trim().slice(4).trim()
  if (!input) return { action: 'help' }
  if (input.includes('\0')) throw new Error('Invalid side command.')
  const question = (value: string) => {
    if (!value.trim() || value.length > AGENT_SIDE_LIMITS.questionCharacters) throw new Error('Invalid side question.')
    return value.trim()
  }
  if (!input.startsWith('--')) return { action: 'start', question: question(input) }
  const match = input.match(/^--(continue|open|stop)\s+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\s+([\s\S]*))?$/i)
  if (!match) throw new Error('Invalid side command.')
  const action = match[1].toLowerCase() as 'continue' | 'open' | 'stop', branchId = match[2].toLowerCase()
  if (action === 'continue') return { action, branchId, question: question(match[3] ?? '') }
  if (match[3]?.trim()) throw new Error('Invalid side command arguments.')
  return { action, branchId }
}
