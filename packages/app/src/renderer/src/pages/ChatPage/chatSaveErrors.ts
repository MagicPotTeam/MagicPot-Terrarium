import { ChatSessionSaveConflictError, ChatSessionSaveSupersededError } from './chatStorage'

/**
 * A guarded save found the stored record still equal to its baseline, but the live session object
 * was replaced while the write was pending (a streaming delta, a status update). Nothing was
 * written and nothing conflicts: the newer object is still dirty and is saved by the next
 * persistLatest. This is not a failure and must never be shown as one.
 */
export function isBenignSaveSupersede(error: unknown): boolean {
  return error instanceof ChatSessionSaveSupersededError
}

/**
 * A guarded save was refused because the stored record changed under another writer (or the
 * session was deleted). Retrying the same local object can only be refused again, so the caller
 * keeps the dirty copy, reports it once and stops retrying it automatically.
 */
export function isPermanentSaveConflict(error: unknown): boolean {
  return error instanceof ChatSessionSaveConflictError
}
