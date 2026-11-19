import { ChatSessionLifecycleChangedError } from './chatSaveBaseline'
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
 * session was deleted), or because the live object's team membership / lifecycle fences no longer
 * match the frozen baseline (an ordinary save may never change those; persistLatest refuses it
 * before writing). Retrying the same local object can only be refused again, so the caller keeps the
 * dirty copy, reports it once and stops retrying it automatically; a newer object or an explicit
 * Retry still tries.
 */
export function isPermanentSaveConflict(error: unknown): boolean {
  return error instanceof ChatSessionSaveConflictError || error instanceof ChatSessionLifecycleChangedError
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
  // scope\u0000id -> session id of every session whose exhausted streak was already reported.
  private reported = new Map<string, string>()

  /** Record one supersede seen while `live` was the live object; true once the streak is exhausted. */
  note(live: object): boolean {
    const count = (this.counts.get(live) ?? 0) + 1
    this.counts.set(live, count)
    return count >= SAVE_SUPERSEDE_STREAK_LIMIT
  }

  /**
   * Mark the exhausted streak of the session under `key` as reported. True only the first time since
   * that session last saved, so a stuck save is reported once, like a conflict; the caller still
   * reports an explicit Retry.
   */
  markReported(key: string, sessionId: string): boolean {
    if (this.reported.has(key)) return false
    this.reported.set(key, sessionId)
    return true
  }

  /** Forget the streak of an object that was saved, and that its session's stuck save was reported. */
  clear(live: object, key: string): void {
    this.counts.delete(live)
    this.reported.delete(key)
  }

  /** Drop every report for which `drop(key, sessionId)` is true. */
  prune(drop: (key: string, sessionId: string) => boolean): void {
    for (const [key, id] of this.reported) if (drop(key, id)) this.reported.delete(key)
  }
}

/**
 * scope\u0000id -> the session object whose guarded save another writer refused. The automatic save
 * skips that very object (it can only be refused again) and tries any newer one. The object is held
 * through a WeakRef: a conflicted session of another scope (whole messages, inline images) must not
 * stay alive just because it was refused once; once collected, nothing can present it again.
 */
export class RefusedSaveSessions {
  private entries = new Map<string, { id: string; ref: { deref(): object | undefined } }>()

  /** `holdWeakly` is a seam for tests; it must not keep its target alive. */
  constructor(private readonly holdWeakly: (session: object) => { deref(): object | undefined } = session => new WeakRef(session)) {}

  get size(): number {
    return this.entries.size
  }

  record(key: string, session: { id: string }): void {
    this.entries.set(key, { id: session.id, ref: this.holdWeakly(session) })
  }

  /** Whether `session` is the very object that was refused under `key`. */
  isRefused(key: string, session: object): boolean {
    return this.entries.get(key)?.ref.deref() === session
  }

  /** Whether a refusal was recorded (and so reported) for `key` since its last successful save. */
  has(key: string): boolean {
    return this.entries.has(key)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  /** Drop every entry for which `drop(key, sessionId)` is true. */
  prune(drop: (key: string, sessionId: string) => boolean): void {
    for (const [key, entry] of this.entries) if (drop(key, entry.id)) this.entries.delete(key)
  }
}
