import { AGENT_THREAD_MEMORY_LIMITS as LIMITS } from '@shared/api/agentThreadMemory'

export type AgentScratchpadCommand = { action: 'view' }
export type AgentScratchpadCommandHandle = { execute(command: AgentScratchpadCommand, expectedScope: string): boolean }
export const isAgentScratchpadCommand = (text: string): boolean => /^\/(?:scratchpad|pad)(?:\s|$)/i.test(text.trimStart())

/** User-composer entry only. Recognized invalid commands must never fall through to a model. */
export function parseAgentScratchpadCommand(text: string): AgentScratchpadCommand | undefined {
  if (!isAgentScratchpadCommand(text)) return undefined
  if (!/^\/(?:scratchpad|pad)$/i.test(text.trim())) throw new Error('Invalid scratchpad view command; use /scratchpad or /pad with no arguments.')
  return { action: 'view' }
}

/** Validate an IPC snapshot before an inert user-only view. No Markdown/HTML execution. */
export function formatAgentScratchpad(value: unknown): { revision: number; text: string; truncated: boolean } {
  if (!value || typeof value !== 'object' || !('revision' in value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !('notes' in value) || !Array.isArray(value.notes) || value.notes.length > LIMITS.noteKeys) throw new Error('Invalid scratchpad snapshot.')
  const keys = new Set<string>()
  const notes = value.notes.map(note => {
    if (!note || typeof note !== 'object' || typeof note.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(note.key) || keys.has(note.key) || typeof note.value !== 'string' || note.value.length > LIMITS.noteCharacters || !Number.isFinite(note.updatedAt)) throw new Error('Invalid scratchpad note.')
    keys.add(note.key)
    return { key: note.key, value: note.value, updatedAt: note.updatedAt }
  })
  if (new TextEncoder().encode(JSON.stringify(notes)).byteLength > LIMITS.noteBytes) throw new Error('Invalid scratchpad capacity.')
  const lines = notes.map(note => `${note.key}: ${note.value}`).join('\n').split(/\r\n|\r|\n/)
  return { revision: Number(value.revision), text: lines.slice(0, 50).join('\n'), truncated: lines.length > 50 }
}
