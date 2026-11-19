/**
 * Ordered, baseline-guarded session writer.
 *
 * The whole-session upsert in `saveSessionToDB` is only safe when the writer can prove the record
 * it is about to overwrite is still the snapshot it started from. This helper keeps one frozen
 * baseline snapshot per (scope, sessionId) and one ordered save chain per key:
 *
 * - callers freeze the baseline SYNCHRONOUSLY (`freeze` / `ensureFrozen`) the first time a session
 *   becomes dirty, before the save is queued, so an external refresh that advances the caller's
 *   persisted map cannot move it later;
 * - external refreshes only replace baselines of clean sessions without a queued or in-flight
 *   write (`adoptLoaded`), so a frozen dirty baseline is never replaced;
 * - `persistLatest` is the only writer: it resolves the live session when its queued turn runs
 *   (never a captured snapshot), compares it against the frozen baseline by CAS, and advances the
 *   baseline to the written payload on success;
 * - `advance`, `fenceAndAdvance`, `reconcileTeamEnd` and `reset()` bump an epoch, so a stale queued
 *   save is skipped and a stale in-flight save cannot advance the baseline back; in-flight
 *   mutation chains are kept alive instead of dropped.
 *
 * If a save fails (including a cross-writer conflict) the baseline is left untouched and the
 * rejection propagates, so the caller keeps its dirty reply instead of blindly retrying an
 * overwrite.
 */
import { ChatSessionSaveSupersededError, matchesTeamEndBaseline, normalizedSessionsEqual, sameTeamLifecycle, saveSessionToDB, type ChatSession } from './chatStorage'

const baselineKey = (scope: string, sessionId: string): string => `${scope || 'default'}\u0000${sessionId}`

/**
 * persistLatest refused an ordinary save because the payload's team membership / lifecycle fences
 * no longer match the frozen baseline (an ordinary save may never change those). Nothing was
 * written; the same object can only be refused again.
 */
export class ChatSessionLifecycleChangedError extends Error {
  readonly code = 'CHAT_SESSION_LIFECYCLE_CHANGED'
  constructor() {
    super('Session lifecycle changed before save')
    this.name = 'ChatSessionLifecycleChangedError'
  }
}

// A rejection of persistLatest -> the live session object whose payload it was writing (or refused
// to write) when it failed. Keyed weakly by the error, so nothing outlives the rejection.
const attemptedSessions = new WeakMap<object, ChatSession>()

/**
 * The live session object whose payload persistLatest last tried to write when it rejected with
 * `error`: the source of the refused payload (after a supersede retry, the newer object it moved on
 * to). Undefined for an error persistLatest did not raise after resolving a session. A caller that
 * records a refusal must record this object, never whatever object is live when the rejection
 * arrives: an object that replaced it in between was never sent and may save against a baseline
 * that moved meanwhile (a team End or lifecycle reconcile, an attachment advance).
 */
export function attemptedSessionOf(error: unknown): ChatSession | undefined {
  return typeof error === 'object' && error !== null ? attemptedSessions.get(error) : undefined
}

const noteAttempt = (error: unknown, session: ChatSession): void => {
  if (typeof error === 'object' && error !== null) attemptedSessions.set(error, session)
}

export class ChatSessionSaveBaseline {
  private baselines = new Map<string, ChatSession | null>()
  private chains = new Map<string, Promise<unknown>>()
  private savedSnapshots = new WeakMap<ChatSession, Map<string, ChatSession>>()
  private saveAcks = new WeakMap<ChatSession, Map<string, {epoch:number; keyEpoch:number; observation:number}>>()
  private acknowledgementObservations = new Map<string, number>()
  private keyEpochs = new Map<string, number>()
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

  /** An acknowledgement is valid only while the exact immutable payload remains current. */
  isAcknowledgementCurrent(scope: string, session: ChatSession): boolean {
    const key = baselineKey(scope, session.id)
    const saved = this.savedSnapshots.get(session)?.get(key)
    const baseline = this.baselines.get(key)
    const ack = this.saveAcks.get(session)?.get(key)
    return Boolean(saved && baseline && ack && ack.epoch === this.epoch && ack.keyEpoch === (this.keyEpochs.get(key) ?? 0) &&
      ack.observation === (this.acknowledgementObservations.get(key) ?? 0) &&
      normalizedSessionsEqual(session, saved, scope) && normalizedSessionsEqual(saved, baseline, scope))
  }

  /** Whether a baseline has already been frozen for this session. */
  hasBaseline(scope: string, sessionId: string): boolean {
    return this.baselines.has(baselineKey(scope, sessionId))
  }

  /** Freeze synchronously without allocating a caller-owned snapshot copy. */
  ensureFrozen(scope: string, sessionId: string, snapshot: ChatSession | null): void {
    const key = baselineKey(scope, sessionId)
    if (!this.baselines.has(key)) this.baselines.set(key, snapshot && structuredClone(snapshot))
  }

  /** Freeze the baseline on first touch. Returns the effective baseline (null = expect absent). */
  freeze(scope: string, sessionId: string, snapshot: ChatSession | null): ChatSession | null {
    this.ensureFrozen(scope, sessionId, snapshot)
    const frozen = this.baselines.get(baselineKey(scope, sessionId)) ?? null
    return frozen && structuredClone(frozen)
  }

  /** Advance the baseline to a value that is known to be persisted. */
  advance(scope: string, sessionId: string, session: ChatSession): void {
    const key = baselineKey(scope, sessionId)
    this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1)
    this.baselines.set(key, structuredClone(session))
  }

  /** Install a lifecycle-transition baseline without allowing older queued saves to reuse it. */
  fenceAndAdvance(scope: string, sessionId: string, session: ChatSession): void {
    const key = baselineKey(scope, sessionId)
    this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1)
    this.baselines.set(key, structuredClone(session))
  }

  /** Rebase only when End is the sole persisted change from this dirty lineage. */
  reconcileTeamEnd(scope: string, local: ChatSession, persisted: ChatSession): ChatSession | null {
    const key = baselineKey(scope, local.id)
    const baseline = this.baselines.get(key)
    this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1)
    if (!baseline || !sameTeamLifecycle(local, baseline) || !matchesTeamEndBaseline(baseline, persisted, scope)) return null
    this.baselines.set(key, structuredClone(persisted))
    return local.teamLeadId
      ? {...local, archived: persisted.archived, teamLifecycleRevision: persisted.teamLifecycleRevision}
      : {...local, teamEnded: persisted.teamEnded, teamGeneration: persisted.teamGeneration, teamLifecycleRevision: persisted.teamLifecycleRevision}
  }

  /** Drop the baseline (e.g. after the record is clean or deleted). */
  release(scope: string, sessionId: string): void {
    const key = baselineKey(scope, sessionId)
    this.baselines.delete(key)
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
    const key = baselineKey(scope, sessionId)
    return this.chains.has(key)
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
      this.baselines.set(key, structuredClone(session))
    }
  }

  /** Queue a live-state read with all saves for this session.
   * `onAcknowledged` is a non-throwing owner callback invoked synchronously after a successful
   * commit and baseline update, before the save promise can deliver a batch completion callback.
   * The caller must not perform asynchronous work or throw from it.
   * Earlier writes settle before `resolveLatest` runs, so debounce never writes a captured object.
   */
  async persistLatest(
    scope: string,
    sessionId: string,
    resolveLatest: () => ChatSession | null,
    resolveBaseline: () => ChatSession | null,
    onAcknowledged?: () => void,
    retrySuperseded = false,
    prepareLatest?: () => ChatSession | null
  ): Promise<ChatSession | null> {
    const key = baselineKey(scope, sessionId)
    const callEpoch = this.epoch
    const keyEpoch = this.keyEpochs.get(key) ?? 0
    return this.enqueue(key, async () => {
      if (this.epoch !== callEpoch || (this.keyEpochs.get(key) ?? 0) !== keyEpoch) return null
      const session = prepareLatest ? prepareLatest() : resolveLatest()
      if (!session) return null
      if (session.id !== sessionId) throw new Error('Resolved session ID changed')
      if (!this.baselines.has(key)) {
        const resolved = resolveBaseline()
        this.baselines.set(key, resolved && structuredClone(resolved))
      }
      const expected = this.baselines.get(key) ?? null
      const epochIsCurrent = () => this.epoch === callEpoch && (this.keyEpochs.get(key) ?? 0) === keyEpoch
      let current = session
      let payload = structuredClone(current)
      for (let attempt = 0; ; attempt++) {
        if (expected && !sameTeamLifecycle(payload, expected)) {
          const refusal = new ChatSessionLifecycleChangedError()
          noteAttempt(refusal, current)
          throw refusal
        }
        try {
          await saveSessionToDB(payload, scope, {
            expectedSession: expected,
            pendingSaveOwner: null,
            shouldUpdate: () => epochIsCurrent() && resolveLatest() === current && normalizedSessionsEqual(current, payload, scope)
          })
          break
        } catch (error) {
          this.acknowledgementObservations.set(key, (this.acknowledgementObservations.get(key) ?? 0) + 1)
          noteAttempt(error, current)
          if (!(error instanceof ChatSessionSaveSupersededError) || !retrySuperseded || attempt >= 2 || !epochIsCurrent()) throw error
          const latest = resolveLatest()
          if (!latest || latest.id !== sessionId || latest === current) throw error
          current = latest
          payload = structuredClone(current)
        }
      }
      const savedKeys = this.savedSnapshots.get(current) ?? new Map<string, ChatSession>()
      savedKeys.set(key, payload)
      this.savedSnapshots.set(current, savedKeys)
      const acknowledgements = this.saveAcks.get(current) ?? new Map<string, {epoch:number; keyEpoch:number; observation:number}>()
      acknowledgements.set(key, {epoch:callEpoch, keyEpoch, observation:this.acknowledgementObservations.get(key) ?? 0})
      this.saveAcks.set(current, acknowledgements)
      if (epochIsCurrent()) this.baselines.set(key, payload)
      // Notify the owner in the same turn as the baseline change. A later debounce callback can
      // arrive after an older storage read has already been accepted.
      onAcknowledged?.()
      return current
    })
  }
}
