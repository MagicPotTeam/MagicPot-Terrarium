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

/** Consecutive supersedes of one unchanged live object after which the save is reported as failed. */
export const SAVE_SUPERSEDE_STREAK_LIMIT = 3

/**
 * A supersede is benign only while the live session object keeps being replaced. A supersede of the
 * SAME live object (it was never replaced, yet the writer could not match it to its own copy, for
 * example after an in-place mutation) repeats forever if it is simply re-queued. This counts
 * consecutive supersedes per live object; keyed weakly, so a replaced object is not kept alive and a
 * newer object starts a new streak.
 */
export class SaveSupersedeStreaks {
  private counts = new WeakMap<object, number>()

  /** Record one supersede seen while `live` was the live object; true once the streak is exhausted. */
  note(live: object): boolean {
    const count = (this.counts.get(live) ?? 0) + 1
    this.counts.set(live, count)
    return count >= SAVE_SUPERSEDE_STREAK_LIMIT
  }

  /** Forget the streak of an object that was saved. */
  clear(live: object): void {
    this.counts.delete(live)
  }
}
