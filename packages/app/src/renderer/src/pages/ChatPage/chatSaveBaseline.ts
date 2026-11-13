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
 * - a successful save advances the live-state baseline; legacy snapshot saves retain their frozen
 *   CAS expectation because neither equal content nor message appends establish provenance;
 * - `reset()` bumps an epoch (so a stale in-flight save cannot advance the baseline back) but keeps
 *   the in-flight mutation chains alive instead of dropping them.
 *
 * If a save fails (including a cross-writer conflict) the baseline is left untouched and the
 * rejection propagates, so the caller keeps its dirty reply instead of blindly retrying an
 * overwrite.
 */
import { ChatSessionSaveSupersededError, matchesTeamEndBaseline, normalizedSessionsEqual, sameTeamLifecycle, saveSessionToDB, type ChatSession } from './chatStorage'

const baselineKey = (scope: string, sessionId: string): string => `${scope || 'default'}\u0000${sessionId}`

interface SnapshotReservation {
  readonly payload: ChatSession
  readonly baseline: ChatSession | null
  readonly epoch: number
  readonly keyEpoch: number
  invalidated: boolean
  settled: boolean
}

/** Reject a stale history when the frozen baseline is already its strict message extension. */
function isStrictMessageAppend(previous: ChatSession, next: ChatSession, scope: string): boolean {
  if (!Array.isArray(previous.messages) || !Array.isArray(next.messages) || next.messages.length <= previous.messages.length) return false
  return normalizedSessionsEqual(previous, {...next, messages: next.messages.slice(0, previous.messages.length)}, scope)
}

export class ChatSessionSaveBaseline {
  private baselines = new Map<string, ChatSession | null>()
  private legacyBaselines = new Map<string, ChatSession | null>()
  private chains = new Map<string, Promise<unknown>>()
  private pendingSnapshots = new WeakMap<ChatSession, Map<string, Promise<void>>>()
  private savedSnapshots = new WeakMap<ChatSession, Map<string, ChatSession>>()
  private saveAcks = new WeakMap<ChatSession, Map<string, {epoch:number; keyEpoch:number; observation:number}>>()
  private acknowledgementObservations = new Map<string, number>()
  private reservations = new WeakMap<ChatSession, Map<string, SnapshotReservation>>()
  private activeReservations = new Map<string, Set<SnapshotReservation>>()
  private activeWrites = new Map<string, {epoch: number; keyEpoch: number; promise: Promise<void>}>()
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

  /** Reserve the exact delayed payload and its current baseline before registering a timer. */
  reserve(scope: string, session: ChatSession, resolveBaseline: () => ChatSession | null): void {
    const key = baselineKey(scope, session.id)
    const byKey = this.reservations.get(session) ?? new Map<string, SnapshotReservation>()
    const existing = byKey.get(key)
    if (existing) {
      if (!normalizedSessionsEqual(session, existing.payload, scope)) throw new Error('A reserved session snapshot was mutated in place')
      return
    }
    if (!this.baselines.has(key)) {
      const resolved = resolveBaseline()
      this.baselines.set(key, resolved && structuredClone(resolved))
    }
    if (!this.legacyBaselines.has(key)) this.legacyBaselines.set(key, this.baselines.get(key) ?? null)
    const current = this.legacyBaselines.get(key) ?? null
    const previouslyAcknowledged = this.savedSnapshots.get(session)?.get(key)
    if (previouslyAcknowledged) {
      if (!normalizedSessionsEqual(session, previouslyAcknowledged, scope)) throw new Error('A persisted session snapshot was mutated in place')
      return
    }
    const payload = structuredClone(session)
    const ticket: SnapshotReservation = {
      payload,
      baseline: current && structuredClone(current),
      epoch: this.epoch,
      keyEpoch: this.keyEpochs.get(key) ?? 0,
      invalidated: false,
      settled: false
    }
    byKey.set(key, ticket)
    this.reservations.set(session, byKey)
    const active = this.activeReservations.get(key) ?? new Set<SnapshotReservation>()
    active.add(ticket)
    this.activeReservations.set(key, active)
  }

  /** Dispose a coalesced, not-yet-run reservation without granting its payload new authority. */
  discardReservation(scope: string, session: ChatSession): void {
    const key = baselineKey(scope, session.id)
    const ticket = this.reservations.get(session)?.get(key)
    if (!ticket || ticket.settled) return
    ticket.invalidated = true
    this.retireReservation(key, ticket)
  }

  /** Keep newer registered snapshots from inheriting an older timer's completion. */
  supersedeReservations(scope: string, sessionId: string, current: ChatSession): void {
    const key = baselineKey(scope, sessionId)
    const currentTicket = this.reservations.get(current)?.get(key)
    for (const ticket of [...(this.activeReservations.get(key) ?? [])]) {
      if (ticket === currentTicket) continue
      ticket.invalidated = true
      this.retireReservation(key, ticket)
    }
  }

  private retireReservation(key: string, ticket: SnapshotReservation): void {
    ticket.settled = true
    const active = this.activeReservations.get(key)
    active?.delete(ticket)
    if (active?.size === 0) this.activeReservations.delete(key)
  }

  private invalidateReservations(key: string): void {
    const active = this.activeReservations.get(key)
    if (!active) return
    for (const ticket of active) ticket.invalidated = true
    this.activeReservations.delete(key)
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
    this.legacyBaselines.delete(key)
    this.invalidateReservations(key)
    this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1)
    this.baselines.set(key, structuredClone(session))
  }

  /** Install a lifecycle-transition baseline without allowing older queued saves to reuse it. */
  fenceAndAdvance(scope: string, sessionId: string, session: ChatSession): void {
    const key = baselineKey(scope, sessionId)
    this.legacyBaselines.delete(key)
    this.invalidateReservations(key)
    this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1)
    this.baselines.set(key, structuredClone(session))
  }

  /** Rebase only when End is the sole persisted change from this dirty lineage. */
  reconcileTeamEnd(scope: string, local: ChatSession, persisted: ChatSession): ChatSession | null {
    const key = baselineKey(scope, local.id)
    const baseline = this.baselines.get(key)
    this.legacyBaselines.delete(key)
    this.invalidateReservations(key)
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
    this.legacyBaselines.delete(key)
    this.invalidateReservations(key)
    this.baselines.delete(key)
  }

  /**
   * Invalidate baselines for a fresh load/scope switch. In-flight chains are intentionally kept so
   * queued saves keep their order; the bumped epoch stops any stale in-flight task from advancing a
   * baseline back to the pre-reset state.
   */
  reset(): void {
    this.epoch += 1
    for (const key of this.activeReservations.keys()) this.invalidateReservations(key)
    this.baselines.clear()
    this.legacyBaselines.clear()
  }

  /** Whether a write for this key is currently queued/in-flight. */
  isPending(scope: string, sessionId: string): boolean {
    const key = baselineKey(scope, sessionId)
    return this.chains.has(key) || this.activeReservations.has(key)
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
      if (this.chains.has(key) || this.activeReservations.has(key)) continue
      this.legacyBaselines.delete(key)
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
        if (expected && !sameTeamLifecycle(payload, expected)) throw new Error('Session lifecycle changed before save')
        try {
          await saveSessionToDB(payload, scope, {
            expectedSession: expected,
            pendingSaveOwner: null,
            shouldUpdate: () => epochIsCurrent() && resolveLatest() === current && normalizedSessionsEqual(current, payload, scope)
          })
          break
        } catch (error) {
          this.acknowledgementObservations.set(key, (this.acknowledgementObservations.get(key) ?? 0) + 1)
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
    const ticket = this.reservations.get(session)?.get(key)
    if (ticket && (ticket.invalidated || ticket.epoch !== this.epoch || ticket.keyEpoch !== (this.keyEpochs.get(key) ?? 0))) {
      throw new Error('Session save reservation is no longer current')
    }
    if (ticket && !normalizedSessionsEqual(session, ticket.payload, scope)) throw new Error('A reserved session snapshot was mutated in place')
    if (ticket?.settled && !this.isAcknowledgementCurrent(scope, session)) {
      throw new Error('Session save reservation is no longer current')
    }
    // A delayed autosave and an immediate snapshot save can carry the identical object.
    // Join the original save; never reinterpret that old payload under a later baseline.
    const existing = this.pendingSnapshots.get(session)?.get(key)
    if (existing) return existing
    const payload = ticket ? structuredClone(ticket.payload) : structuredClone(session)
    const savedSnapshot = this.savedSnapshots.get(session)?.get(key)
    if (savedSnapshot && !normalizedSessionsEqual(session, savedSnapshot, scope)) {
      throw new Error('A persisted session snapshot was mutated in place')
    }
    const savedAck = this.saveAcks.get(session)?.get(key)
    if (savedSnapshot && (!savedAck || savedAck.epoch !== this.epoch || savedAck.keyEpoch !== (this.keyEpochs.get(key) ?? 0) ||
      savedAck.observation !== (this.acknowledgementObservations.get(key) ?? 0))) {
      throw new Error('Session save acknowledgement is no longer current')
    }
    // Freeze immediately (synchronously) so an external refresh cannot move this baseline between
    // the first dirty observation and the actual queued write.
    if (!this.baselines.has(key)) {
      const resolved = resolveBaseline()
      this.baselines.set(key, resolved && structuredClone(resolved))
    }
    if (!this.legacyBaselines.has(key)) this.legacyBaselines.set(key, this.baselines.get(key) ?? null)
    const baselineAtCall = ticket ? ticket.baseline : (this.legacyBaselines.get(key) ?? null)
    const capturedBaseline = baselineAtCall && structuredClone(baselineAtCall)
    if (!ticket && !this.activeWrites.has(key) && capturedBaseline && isStrictMessageAppend(session, capturedBaseline, scope)) {
      throw new Error('Older session history cannot replace its newer baseline')
    }
    if (capturedBaseline && !sameTeamLifecycle(session, capturedBaseline)) throw new Error('Session lifecycle changed before save')
    const callEpoch = this.epoch
    const keyEpoch = this.keyEpochs.get(key) ?? 0
    const run = this.enqueue(key, async () => {
      if ((this.keyEpochs.get(key) ?? 0) !== keyEpoch) throw new Error('Session lifecycle changed before save')
      // A queued legacy snapshot retains its original CAS expectation.
      if (ticket && (ticket.invalidated || ticket.epoch !== this.epoch || ticket.keyEpoch !== (this.keyEpochs.get(key) ?? 0))) {
        throw new Error('Session save reservation is no longer current')
      }
      const expected = capturedBaseline
      // A former success is not a current storage observation. Confirm that exact payload by
      // transactional CAS; it may have been replaced by another writer in the meantime.
      const previouslySaved = this.savedSnapshots.get(session)?.get(key)
      if (previouslySaved && !normalizedSessionsEqual(session, previouslySaved, scope)) {
        throw new Error('A persisted session snapshot was mutated in place')
      }
      try {
        await saveSessionToDB(payload, scope, { expectedSession: previouslySaved ?? expected, pendingSaveOwner: null })
      } catch (error) {
        // A known failure invalidates every earlier completion for this key, including a
        // different object still waiting in an older batch callback.
        this.acknowledgementObservations.set(key, (this.acknowledgementObservations.get(key) ?? 0) + 1)
        throw error
      }
      const savedKeys = this.savedSnapshots.get(session) ?? new Map<string, ChatSession>()
      savedKeys.set(key, payload)
      this.savedSnapshots.set(session, savedKeys)
      const acknowledgements = this.saveAcks.get(session) ?? new Map<string, {epoch:number; keyEpoch:number; observation:number}>()
      acknowledgements.set(key, {epoch:callEpoch, keyEpoch, observation:this.acknowledgementObservations.get(key) ?? 0})
      this.saveAcks.set(session, acknowledgements)
      if (ticket) this.retireReservation(key, ticket)
      // Re-check the epoch AFTER the await: a reset may have happened while this write was in
      // flight, in which case we must not advance (or re-seed) a baseline for the stale snapshot.
      if (this.epoch === callEpoch && (this.keyEpochs.get(key) ?? 0) === keyEpoch) this.baselines.set(key, payload)
    })
    this.activeWrites.set(key, {epoch: callEpoch, keyEpoch, promise: run})
    void run.finally(() => {
      if (this.activeWrites.get(key)?.promise === run) this.activeWrites.delete(key)
    }).catch(() => undefined)
    const byKey = this.pendingSnapshots.get(session) ?? new Map<string, Promise<void>>()
    byKey.set(key, run)
    this.pendingSnapshots.set(session, byKey)
    void run.finally(() => {
      const pending = this.pendingSnapshots.get(session)?.get(key)
      if (pending === run) byKey.delete(key)
    }).catch(() => undefined)
    return run
  }
}
