/**
 * Ordered, baseline-guarded session writer.
 *
 * The whole-session upsert in `saveSessionToDB` is only safe when the writer can prove the record
 * it is about to overwrite is still the snapshot it started from. This helper keeps one frozen
 * baseline snapshot per (scope, sessionId):
 *
 * - the baseline is frozen SYNCHRONOUSLY the first time a session becomes dirty, before the save is
 *   queued, so an external refresh that advances the caller's persisted map cannot move it later;
 * - external refreshes never touch this map, so a frozen baseline is never replaced;
 * - a successful save by this writer advances the baseline to the value it just persisted, so a
 *   queued follow-up save by the same writer compares against the latest own write (no self
 *   conflict) while two concurrent own saves still apply in order;
 * - `reset()` bumps an epoch (so a stale in-flight save cannot advance the baseline back) but keeps
 *   the in-flight mutation chains alive instead of dropping them.
 *
 * If a save fails (including a cross-writer conflict) the baseline is left untouched and the
 * rejection propagates, so the caller keeps its dirty reply instead of blindly retrying an
 * overwrite.
 */
import { saveSessionToDB, type ChatSession } from './chatStorage'

const baselineKey = (scope: string, sessionId: string): string => `${scope}\u0000${sessionId}`

export class ChatSessionSaveBaseline {
  private baselines = new Map<string, ChatSession | null>()
  private chains = new Map<string, Promise<unknown>>()
  private epoch = 0

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.chains.set(key, settled)
    void settled.finally(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key)
    })
    return run
  }

  /** Whether a baseline has already been frozen for this session. */
  hasBaseline(scope: string, sessionId: string): boolean {
    return this.baselines.has(baselineKey(scope, sessionId))
  }

  /** Freeze the baseline on first touch. Returns the effective baseline (null = expect absent). */
  freeze(scope: string, sessionId: string, snapshot: ChatSession | null): ChatSession | null {
    const key = baselineKey(scope, sessionId)
    if (!this.baselines.has(key)) this.baselines.set(key, snapshot)
    return this.baselines.get(key) ?? null
  }

  /** Advance the baseline to a value that is known to be persisted. */
  advance(scope: string, sessionId: string, session: ChatSession): void {
    this.baselines.set(baselineKey(scope, sessionId), session)
  }

  /** Drop the baseline (e.g. after the record is clean or deleted). */
  release(scope: string, sessionId: string): void {
    this.baselines.delete(baselineKey(scope, sessionId))
  }

  /**
   * Invalidate baselines for a fresh load/scope switch. In-flight chains are intentionally kept so
   * queued saves keep their order; the bumped epoch stops any stale in-flight task from advancing a
   * baseline back to the pre-reset state.
   */
  reset(): void {
    this.epoch += 1
    this.baselines.clear()
  }

  /** Whether a write for this key is currently queued/in-flight. */
  isPending(scope: string, sessionId: string): boolean {
    return this.chains.has(baselineKey(scope, sessionId))
  }

  /**
   * Adopt the freshly loaded snapshot as the baseline for CLEAN sessions of one scope only.
   * Sessions that are still dirty (unsaved) or have an in-flight write keep their existing frozen
   * baseline, so switching scope away and back cannot hand an old dirty snapshot a newer baseline
   * (and thus overwrite authority). Other scopes' baselines are never touched.
   */
  adoptLoaded(scope: string, sessions: ChatSession[], dirtySessionIds: ReadonlySet<string>): void {
    for (const session of sessions) {
      const key = baselineKey(scope, session.id)
      if (dirtySessionIds.has(session.id)) continue
      if (this.chains.has(key)) continue
      this.baselines.set(key, session)
    }
  }

  /**
   * Persist one session through the frozen baseline. `resolveBaseline` is consulted SYNCHRONOUSLY,
   * before enqueueing, the first time a key is touched, so the snapshot captured is the one current
   * at the moment the session first became dirty. Pass the last confirmed persisted snapshot, or
   * null for a brand-new session.
   */
  async persist(
    scope: string,
    session: ChatSession,
    resolveBaseline: () => ChatSession | null
  ): Promise<void> {
    const key = baselineKey(scope, session.id)
    // Freeze immediately (synchronously) so an external refresh cannot move this baseline between
    // the first dirty observation and the actual queued write.
    if (!this.baselines.has(key)) this.baselines.set(key, resolveBaseline())
    const capturedBaseline = this.baselines.get(key) ?? null
    const callEpoch = this.epoch
    return this.enqueue(key, async () => {
      const sameEpoch = this.epoch === callEpoch
      // If the lifecycle was reset while this write was queued, the map may now hold a baseline
      // frozen by the NEW load for the same key. Never let this stale task use it: fall back to the
      // snapshot captured when the write was enqueued so CAS still rejects a newer record.
      const expected =
        sameEpoch && this.baselines.has(key) ? (this.baselines.get(key) ?? null) : capturedBaseline
      await saveSessionToDB(session, scope, { expectedSession: expected })
      // Re-check the epoch AFTER the await: a reset may have happened while this write was in
      // flight, in which case we must not advance (or re-seed) a baseline for the stale snapshot.
      if (this.epoch === callEpoch) this.baselines.set(key, session)
    })
  }
}
