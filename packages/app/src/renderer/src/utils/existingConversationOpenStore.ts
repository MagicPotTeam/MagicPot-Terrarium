import { useSyncExternalStore } from 'react'
import { readExistingSessionSummaries } from '../pages/ChatPage/chatStorage'
import { readManagementPaneSnapshot } from '../pages/AgentManagementPage/managementPaneMetadata'
import { createExistingConversationOpenCoordinator, type ExistingConversationTarget } from './existingConversationOpen'

const validId = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 512 && value.trim() === value &&
  ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

/** Fresh bounded current-state checks, never a cached row/receipt or atomic cross-storage authority. */
export async function validateExistingConversationTarget(input: ExistingConversationTarget, signal: AbortSignal): Promise<boolean> {
  try {
    if (signal.aborted || !input || !validId(input.projectId) || !validId(input.paneId) || !validId(input.sessionId)) return false
    // Detach the request identity before awaiting; mutable caller fields cannot retarget the read.
    const target = Object.freeze({ projectId: input.projectId, paneId: input.paneId, storageScope: input.storageScope, sessionId: input.sessionId })
    if (target.storageScope !== `${target.projectId}.${target.paneId}`) return false
    const hasOwner = (metadata: ReturnType<typeof readManagementPaneSnapshot>) => metadata.status === 'ready' &&
      metadata.owners.filter(owner => owner.projectId === target.projectId && owner.paneId === target.paneId && owner.storageScope === target.storageScope).length === 1
    const before = readManagementPaneSnapshot()
    if (!hasOwner(before) || before.status !== 'ready' || !before.isCurrent()) return false
    const deleted = () => localStorage.getItem(`magicpot-chat-delete-tombstone:${encodeURIComponent(target.storageScope)}:${encodeURIComponent(target.sessionId)}`) !== null
    if (deleted() || signal.aborted) return false
    // The reader opens only an existing compatible store and publishes only on transaction complete.
    const result = await readExistingSessionSummaries([target.storageScope], signal)
    if (signal.aborted || result.status !== 'ready' || !before.isCurrent()) return false
    const after = readManagementPaneSnapshot()
    if (!hasOwner(after) || after.status !== 'ready' || !after.isCurrent() || deleted() || signal.aborted) return false
    if (!Array.isArray(result.sessions) || result.sessions.length > 512) return false
    const seen = new Set<string>()
    let matches = 0
    for (const session of result.sessions) {
      if (session.storageScope !== target.storageScope || !validId(session.sessionId) || seen.has(session.sessionId)) return false
      seen.add(session.sessionId)
      if (session.sessionId === target.sessionId) matches++
    }
    return matches === 1 && !signal.aborted
  } catch {
    return false
  }
}

/** Transient renderer state only: no routing, storage access, timers or requests until start(). */
export const existingConversationOpenStore = createExistingConversationOpenCoordinator({ validate: validateExistingConversationTarget })
export function useExistingConversationOpenSnapshot() {
  return useSyncExternalStore(existingConversationOpenStore.subscribe, existingConversationOpenStore.getSnapshot, existingConversationOpenStore.getSnapshot)
}
