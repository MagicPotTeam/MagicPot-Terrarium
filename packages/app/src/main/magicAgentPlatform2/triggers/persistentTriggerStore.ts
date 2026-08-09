import type { MagicAgentTriggerSpec } from '@shared/magicAgent/triggers'
import {
  canonicalPolicyJson,
  sha256PolicyText,
  type PolicyJsonValue
} from '../../../shared/magicAgentPlatform2/policy'
import type { MagicAgentEventStore, StoredResource } from '../persistence'

export const MAGIC_AGENT_TRIGGER_RESOURCE_KIND = 'trigger'

export type MissedRunPolicy = 'skip' | 'run-once' | 'catch-up'

export type PersistentTriggerSchedule = Readonly<{
  type: 'interval'
  intervalMs: number
  missedRunPolicy?: MissedRunPolicy
  maxCatchUpRuns?: number
}>

type TriggerOccurrence = Readonly<{
  occurrenceAt: number
  windowStart: number
  windowEnd: number
  missedCount: number
  nextFireAtAfter: number
  batchEndAt?: number
}>

type TriggerClaim = TriggerOccurrence &
  Readonly<{ claimId: string; claimedAt: number; expiresAt: number }>

type TriggerFailure = Readonly<{
  attempts: number
  lastError: string
  nextRetryAt: number
  occurrence: TriggerOccurrence
}>

type PersistentTriggerBase = Omit<MagicAgentTriggerSpec, 'type'> & Readonly<{ paused?: boolean }>

export type PersistentScheduleTriggerState = PersistentTriggerBase &
  Readonly<{
    type: 'schedule'
    schedule: PersistentTriggerSchedule
    nextFireAt: number
    lastFireAt?: number
    catchUpUntilAt?: number
    claim?: TriggerClaim
    failure?: TriggerFailure
  }>

export type PersistentSourceTriggerState = PersistentTriggerBase &
  Readonly<{
    type: Exclude<MagicAgentTriggerSpec['type'], 'schedule'>
    schedule?: never
    nextFireAt?: never
    lastFireAt?: never
    catchUpUntilAt?: never
    claim?: never
    failure?: never
  }>

export type PersistentTriggerState = PersistentScheduleTriggerState | PersistentSourceTriggerState

type StoredScheduleTrigger = StoredResource<PersistentScheduleTriggerState>

const DEFAULT_MISSED_RUN_POLICY: MissedRunPolicy = 'run-once'
const policies = new Set<MissedRunPolicy>(['skip', 'run-once', 'catch-up'])

const finite = (value: number, name: string) => {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`)
}

const checkedAdd = (base: number, increment: number, name: string) => {
  const result = base + increment
  finite(result, name)
  return result
}

const advance = (start: number, interval: number, count: number) => {
  if (!Number.isSafeInteger(count))
    throw new Error('Trigger occurrence count must be a safe integer.')
  const increment = interval * count
  finite(increment, 'Trigger schedule advancement')
  return checkedAdd(start, increment, 'Trigger nextFireAt')
}

const policyOf = (schedule: PersistentTriggerSchedule): MissedRunPolicy =>
  schedule.missedRunPolicy ?? DEFAULT_MISSED_RUN_POLICY

const dueOccurrences = (nextFireAt: number, now: number, interval: number) => {
  const elapsed = now - nextFireAt
  finite(elapsed, 'Trigger schedule elapsed time')
  const count = Math.floor(elapsed / interval) + 1
  if (!Number.isSafeInteger(count) || count <= 0)
    throw new Error('Trigger schedule occurrence count exceeds the safe integer range.')
  return count
}
const assertTrigger = (trigger: PersistentTriggerState) => {
  if (!trigger.id.trim()) throw new Error('Trigger id is required.')
  if (trigger.type !== 'schedule') return
  if (!Number.isFinite(trigger.schedule.intervalMs) || trigger.schedule.intervalMs <= 0) {
    throw new Error('Trigger interval must be positive.')
  }
  finite(trigger.nextFireAt, 'Trigger nextFireAt')
  const policy = policyOf(trigger.schedule)
  if (!policies.has(policy)) throw new Error('Trigger missed-run policy is invalid.')
  if (policy === 'catch-up') {
    if (
      !Number.isInteger(trigger.schedule.maxCatchUpRuns) ||
      trigger.schedule.maxCatchUpRuns! <= 0
    ) {
      throw new Error('Trigger maxCatchUpRuns must be a strict positive integer.')
    }
  } else if (trigger.schedule.maxCatchUpRuns !== undefined) {
    throw new Error('Trigger maxCatchUpRuns is only valid for catch-up policy.')
  }
}

const isScheduleState = (state: PersistentTriggerState): state is PersistentScheduleTriggerState =>
  state.type === 'schedule'

const isScheduleResource = (
  resource: StoredResource<PersistentTriggerState>
): resource is StoredScheduleTrigger => isScheduleState(resource.state)

const key = (triggerId: string, suffix: string) => `trigger:${triggerId}:${suffix}`
const event = (
  triggerId: string,
  type: string,
  createdAt: number,
  payload: unknown,
  revision: number,
  identity = 'resource'
) => ({
  protocolVersion: '2.0.0',
  id: key(triggerId, `${type}:${createdAt}:${revision}:${identity}`),
  type,
  createdAt,
  payload,
  envelopeKind: 'event' as const,
  streamId: key(triggerId, 'stream'),
  sequence: revision,
  resource: { kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND, id: triggerId },
  revision
})

export class PersistentTriggerStore {
  constructor(private readonly eventStore: MagicAgentEventStore) {}

  get(triggerId: string): StoredResource<PersistentTriggerState> | undefined {
    return this.eventStore.getResource<PersistentTriggerState>(
      MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
      triggerId
    )
  }

  list(): readonly StoredResource<PersistentTriggerState>[] {
    return this.eventStore.listResources({
      kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
      limit: 1_000
    }) as readonly StoredResource<PersistentTriggerState>[]
  }

  create(
    trigger: PersistentTriggerState,
    now = Date.now(),
    callerIdempotencyKey?: string
  ): StoredResource<PersistentTriggerState> {
    finite(now, 'Trigger creation time')
    const normalized: PersistentTriggerState =
      trigger.type === 'schedule'
        ? {
            ...trigger,
            schedule: {
              ...trigger.schedule,
              missedRunPolicy: policyOf(trigger.schedule)
            }
          }
        : trigger
    assertTrigger(normalized)
    const callerKey = callerIdempotencyKey ?? key(normalized.id, `create:${now}`)
    const storedKey = key(normalized.id, `caller:${callerKey}`)
    const stateDigest = sha256PolicyText(
      canonicalPolicyJson(normalized as unknown as PolicyJsonValue)
    )
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_TRIGGER_RESOURCE_KIND, normalized.id, 1000)
      .find((mutation) => mutation.idempotencyKey === storedKey)
    if (replay) {
      const committed = this.eventStore.getEvent(replay.eventId)
      const payload = committed?.payload as
        | { triggerId?: string; triggerType?: string; schedule?: unknown; stateDigest?: string }
        | undefined
      if (
        committed?.createdAt !== now ||
        committed.type !== 'trigger.created' ||
        payload?.triggerId !== normalized.id ||
        payload.triggerType !== normalized.type ||
        payload.stateDigest !== stateDigest ||
        (normalized.type === 'schedule' &&
          canonicalPolicyJson(payload.schedule as PolicyJsonValue) !==
            canonicalPolicyJson(normalized.schedule as unknown as PolicyJsonValue))
      )
        throw new Error('Trigger create idempotency key conflicts with committed command.')
      return replay.resource as StoredResource<PersistentTriggerState>
    }
    if (this.get(normalized.id)) throw new Error('Trigger already exists.')
    return this.eventStore.mutateResource<PersistentTriggerState>({
      operation: 'create',
      kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
      id: normalized.id,
      idempotencyKey: storedKey,
      state: normalized,
      createdAt: now,
      event: event(
        normalized.id,
        'trigger.created',
        now,
        {
          triggerId: normalized.id,
          triggerType: normalized.type,
          ...(normalized.type === 'schedule' ? { schedule: normalized.schedule } : {}),
          stateDigest
        },
        0
      )
    }).resource
  }

  claimDue(
    now: number,
    claimId: string,
    leaseMs: number
  ): StoredResource<PersistentScheduleTriggerState> | undefined {
    finite(now, 'Trigger claim time')
    if (!claimId.trim()) throw new Error('Trigger claim id is required.')
    if (!Number.isFinite(leaseMs) || leaseMs <= 0)
      throw new Error('Trigger lease must be positive and finite.')
    const expiresAt = checkedAdd(now, leaseMs, 'Trigger claim expiry')

    for (const candidate of this.list()
      .filter(isScheduleResource)
      .toSorted(
        (left, right) =>
          left.state.nextFireAt - right.state.nextFireAt || left.id.localeCompare(right.id)
      )) {
      if (!isClaimable(candidate.state, now)) continue
      let due: StoredScheduleTrigger = candidate
      const existing = retryOccurrence(due.state, now)
      if (!existing) {
        const prepared = this.prepareOccurrence(due, now)
        if (!prepared) continue
        due = prepared.resource
        if (!prepared.occurrence) continue
      }
      const occurrence = retryOccurrence(due.state, now) ?? this.occurrenceFor(due.state, now)
      if (!occurrence) continue
      try {
        return this.eventStore.mutateResource<PersistentScheduleTriggerState>({
          operation: 'update',
          kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
          id: due.id,
          idempotencyKey: key(due.id, `claim:${claimId}:${now}`),
          expectedRevision: due.revision,
          state: {
            ...due.state,
            claim: { claimId, claimedAt: now, expiresAt, ...occurrence }
          },
          createdAt: now,
          event: event(
            due.id,
            'trigger.claimed',
            now,
            { claimId, leaseMs, ...occurrence },
            due.revision + 1,
            claimId
          )
        }).resource
      } catch (error) {
        if (isRevisionConflict(error)) continue
        throw error
      }
    }
    return undefined
  }

  update(input: {
    triggerId: string
    expectedRevision: number
    idempotencyKey: string
    updatedAt: number
    patch: { title?: string; enabled?: boolean; config?: Record<string, unknown> }
  }): StoredResource<PersistentTriggerState> {
    if (
      !input.triggerId.trim() ||
      !input.idempotencyKey.trim() ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isFinite(input.updatedAt) ||
      input.updatedAt < 0
    )
      throw new Error('Invalid trigger update command.')
    const patch = input.patch
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.keys(patch).length === 0
    )
      throw new Error('Invalid trigger update patch.')
    for (const key of Object.keys(patch))
      if (!['title', 'enabled', 'config'].includes(key))
        throw new Error(`Unknown trigger update field: ${key}`)
    if (patch.title !== undefined && !patch.title.trim())
      throw new Error('Trigger title must be non-empty.')
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')
      throw new Error('Trigger enabled must be boolean.')
    if (patch.config !== undefined) assertJsonRecord(patch.config)
    const replay = this.replayResourceMutation(input.triggerId, input.idempotencyKey, {
      createdAt: input.updatedAt,
      type: 'trigger.updated',
      payload: {
        expectedRevision: input.expectedRevision,
        patch: {
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.config === undefined ? {} : { config: patch.config })
        }
      }
    })
    if (replay) return replay
    const current = this.get(input.triggerId)
    if (!current) throw new Error('Trigger not found.')
    if (current.revision !== input.expectedRevision) throw new Error('Trigger revision conflict.')
    return this.eventStore.mutateResource<PersistentTriggerState>({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
      id: input.triggerId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      state: {
        ...current.state,
        paused: current.state.paused ?? false,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.config === undefined ? {} : { config: patch.config })
      },
      createdAt: input.updatedAt,
      event: event(
        input.triggerId,
        'trigger.updated',
        input.updatedAt,
        {
          expectedRevision: input.expectedRevision,
          patch: {
            ...(patch.title === undefined ? {} : { title: patch.title }),
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            ...(patch.config === undefined ? {} : { config: patch.config })
          }
        },
        input.expectedRevision + 1
      )
    }).resource
  }

  advanceSourceCursor(input: {
    triggerId: string
    expectedRevision: number
    cursorAt: number
    advancedAt: number
    idempotencyKey: string
  }): StoredResource<PersistentTriggerState> {
    if (
      !input.triggerId.trim() ||
      !input.idempotencyKey.trim() ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isFinite(input.cursorAt) ||
      input.cursorAt < 0 ||
      !Number.isFinite(input.advancedAt) ||
      input.advancedAt < 0
    )
      throw new Error('Invalid trigger source cursor command.')
    const replay = this.replayResourceMutation(input.triggerId, input.idempotencyKey, {
      createdAt: input.advancedAt,
      type: 'trigger.source-cursor-advanced',
      payload: { cursorAt: input.cursorAt }
    })
    if (replay) return replay
    const current = this.get(input.triggerId)
    if (!current) throw new Error('Trigger not found.')
    if (current.revision !== input.expectedRevision) throw new Error('Trigger revision conflict.')
    if (current.state.type === 'schedule')
      throw new Error('Schedule Trigger cannot use a source cursor.')
    return this.eventStore.mutateResource<PersistentTriggerState>({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
      id: input.triggerId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      state: {
        ...current.state,
        config: { ...(current.state.config ?? {}), sourceCursorAt: input.cursorAt }
      },
      createdAt: input.advancedAt,
      event: event(
        input.triggerId,
        'trigger.source-cursor-advanced',
        input.advancedAt,
        { cursorAt: input.cursorAt },
        input.expectedRevision + 1,
        String(input.cursorAt)
      )
    }).resource
  }

  setEnabled(input: {
    triggerId: string
    enabled: boolean
    expectedRevision: number
    idempotencyKey: string
    changedAt: number
  }): StoredResource<PersistentTriggerState> {
    return this.setControl(
      input,
      'enabled',
      input.enabled,
      input.enabled ? 'trigger.enabled' : 'trigger.disabled'
    )
  }
  setPaused(input: {
    triggerId: string
    paused: boolean
    expectedRevision: number
    idempotencyKey: string
    changedAt: number
  }): StoredResource<PersistentTriggerState> {
    return this.setControl(
      input,
      'paused',
      input.paused,
      input.paused ? 'trigger.paused' : 'trigger.resumed'
    )
  }
  retry(input: {
    triggerId: string
    expectedRevision: number
    idempotencyKey: string
    requestedAt: number
  }): StoredResource<PersistentTriggerState> {
    if (
      !input.triggerId.trim() ||
      !input.idempotencyKey.trim() ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isFinite(input.requestedAt) ||
      input.requestedAt < 0
    )
      throw new Error('Invalid trigger retry command.')
    const replay = this.replayResourceMutation(input.triggerId, input.idempotencyKey, {
      createdAt: input.requestedAt,
      type: 'trigger.retry-requested',
      payload: { expectedRevision: input.expectedRevision, nextRetryAt: input.requestedAt }
    })
    if (replay) return replay
    const current = this.get(input.triggerId)
    if (!current) throw new Error('Trigger not found.')
    if (current.revision !== input.expectedRevision) throw new Error('Trigger revision conflict.')
    if (!isScheduleResource(current)) throw new Error('Source-driven Trigger cannot be retried.')
    if (!current.state.failure) throw new Error('Trigger has no failure to retry.')
    if (current.state.claim) throw new Error('Active trigger claim cannot be retried.')
    return this.eventStore.mutateResource<PersistentTriggerState>({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
      id: input.triggerId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      state: {
        ...current.state,
        failure: { ...current.state.failure, nextRetryAt: input.requestedAt }
      },
      createdAt: input.requestedAt,
      event: event(
        input.triggerId,
        'trigger.retry-requested',
        input.requestedAt,
        { expectedRevision: input.expectedRevision, nextRetryAt: input.requestedAt },
        input.expectedRevision + 1
      )
    }).resource
  }
  private setControl(
    input: {
      triggerId: string
      expectedRevision: number
      idempotencyKey: string
      changedAt: number
    },
    field: 'enabled' | 'paused',
    value: boolean,
    type: string
  ): StoredResource<PersistentTriggerState> {
    if (!input.idempotencyKey.trim())
      throw new Error('Trigger mutation idempotency key is required.')
    const replay = this.replayResourceMutation(input.triggerId, input.idempotencyKey, {
      createdAt: input.changedAt,
      type,
      payload: { [field]: value }
    })
    if (replay) return replay
    const current = this.get(input.triggerId)
    if (!current) throw new Error('Trigger not found.')
    if (current.revision !== input.expectedRevision) throw new Error('Trigger revision conflict.')
    return this.eventStore.mutateResource<PersistentTriggerState>({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
      id: input.triggerId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      state: { ...current.state, paused: current.state.paused ?? false, [field]: value },
      createdAt: input.changedAt,
      event: event(
        input.triggerId,
        type,
        input.changedAt,
        { [field]: value },
        input.expectedRevision + 1
      )
    }).resource
  }

  failClaim(
    triggerId: string,
    claimId: string,
    failedAt: number,
    error: string,
    retryDelayMs: number
  ): StoredResource<PersistentTriggerState> {
    finite(failedAt, 'Trigger failure time')
    if (!error.trim()) throw new Error('Trigger failure error is required.')
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
      throw new Error('Trigger retry delay must be finite and not negative.')
    }
    const replay = this.replayClaimMutation(triggerId, `fail:${claimId}`, failedAt, {
      claimId,
      error,
      retryDelayMs
    })
    if (replay) return replay
    const current = this.requireActiveClaim(triggerId, claimId, failedAt)
    const attempts = (current.state.failure?.attempts ?? 0) + 1
    const occurrence = occurrenceFromClaim(current.state.claim!)
    const state = clean({
      ...current.state,
      claim: undefined,
      failure: {
        attempts,
        lastError: error,
        nextRetryAt: checkedAdd(failedAt, retryDelayMs, 'Trigger retry time'),
        occurrence
      }
    })
    return this.eventStore.mutateResource<PersistentTriggerState>({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
      id: triggerId,
      idempotencyKey: key(triggerId, `fail:${claimId}`),
      expectedRevision: current.revision,
      state,
      createdAt: failedAt,
      event: event(
        triggerId,
        'trigger.failed',
        failedAt,
        { claimId, error, attempts, retryDelayMs, ...occurrence },
        current.revision + 1,
        claimId
      )
    }).resource
  }

  completeClaim(
    triggerId: string,
    claimId: string,
    firedAt: number
  ): StoredResource<PersistentTriggerState> {
    finite(firedAt, 'Trigger completion time')
    const replay = this.replayClaimMutation(triggerId, `fire:${claimId}`, firedAt, { claimId })
    if (replay) return replay
    const current = this.requireActiveClaim(triggerId, claimId, firedAt)
    const claim = current.state.claim!
    const nextFireAt = claim.nextFireAtAfter
    finite(nextFireAt, 'Trigger nextFireAt')
    const catchUpUntilAt =
      current.state.catchUpUntilAt !== undefined && nextFireAt <= current.state.catchUpUntilAt
        ? current.state.catchUpUntilAt
        : undefined
    return this.eventStore.mutateResource<PersistentTriggerState>({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
      id: triggerId,
      idempotencyKey: key(triggerId, `fire:${claimId}`),
      expectedRevision: current.revision,
      state: clean({
        ...current.state,
        claim: undefined,
        failure: undefined,
        nextFireAt,
        lastFireAt: claim.occurrenceAt,
        catchUpUntilAt
      }),
      createdAt: firedAt,
      event: event(
        triggerId,
        'trigger.fired',
        firedAt,
        { claimId, firedAt, ...occurrenceFromClaim(claim) },
        current.revision + 1,
        claimId
      )
    }).resource
  }

  private prepareOccurrence(
    due: StoredScheduleTrigger,
    now: number
  ): { resource: StoredScheduleTrigger; occurrence?: TriggerOccurrence } | undefined {
    const state = due.state
    const policy = policyOf(state.schedule)
    const interval = state.schedule.intervalMs
    const dueCount = dueOccurrences(state.nextFireAt, now, interval)
    const latestDue = advance(state.nextFireAt, interval, dueCount - 1)

    if (policy === 'skip' && state.nextFireAt < now) {
      const occurrenceDueNow = latestDue === now
      const missedCount = dueCount - (occurrenceDueNow ? 1 : 0)
      if (missedCount === 0) return { resource: due, occurrence: this.occurrenceFor(state, now) }
      const nextFireAt = advance(state.nextFireAt, interval, missedCount)
      const windowEnd = advance(state.nextFireAt, interval, missedCount - 1)
      const skipped = this.skip(due, now, missedCount, state.nextFireAt, windowEnd, nextFireAt)
      return { resource: skipped, occurrence: this.occurrenceFor(skipped.state, now) }
    }

    if (policy === 'catch-up' && state.catchUpUntilAt === undefined) {
      const max = state.schedule.maxCatchUpRuns!
      const skippedCount = Math.max(0, dueCount - max)
      let prepared = due
      if (skippedCount > 0) {
        const nextFireAt = advance(state.nextFireAt, interval, skippedCount)
        prepared = this.skip(
          due,
          now,
          skippedCount,
          state.nextFireAt,
          advance(nextFireAt, interval, -1),
          nextFireAt,
          latestDue
        )
      } else {
        prepared = this.markCatchUp(due, now, latestDue)
      }
      return { resource: prepared, occurrence: this.occurrenceFor(prepared.state, now, latestDue) }
    }

    return { resource: due, occurrence: this.occurrenceFor(state, now) }
  }

  private occurrenceFor(
    state: PersistentScheduleTriggerState,
    now: number,
    batchEndOverride?: number
  ): TriggerOccurrence | undefined {
    if (state.nextFireAt > now) return undefined
    const interval = state.schedule.intervalMs
    const policy = policyOf(state.schedule)
    if (policy === 'run-once') {
      const count = dueOccurrences(state.nextFireAt, now, interval)
      const windowEnd = advance(state.nextFireAt, interval, count - 1)
      return {
        occurrenceAt: windowEnd,
        windowStart: state.nextFireAt,
        windowEnd,
        missedCount: Math.max(0, count - 1),
        nextFireAtAfter: advance(state.nextFireAt, interval, count)
      }
    }
    const occurrenceAt = state.nextFireAt
    return {
      occurrenceAt,
      windowStart: occurrenceAt,
      windowEnd: occurrenceAt,
      missedCount: 0,
      nextFireAtAfter: advance(occurrenceAt, interval, 1),
      ...(policy === 'catch-up'
        ? { batchEndAt: batchEndOverride ?? state.catchUpUntilAt ?? occurrenceAt }
        : {})
    }
  }

  private skip(
    current: StoredScheduleTrigger,
    now: number,
    missedCount: number,
    windowStart: number,
    windowEnd: number,
    nextFireAt: number,
    catchUpUntilAt?: number
  ): StoredScheduleTrigger {
    const payload = { missedCount, windowStart, windowEnd, nextFireAt }
    return this.eventStore.mutateResource<PersistentScheduleTriggerState>({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
      id: current.id,
      idempotencyKey: key(current.id, `skip:${windowStart}:${windowEnd}:${now}`),
      expectedRevision: current.revision,
      state: clean({ ...current.state, nextFireAt, catchUpUntilAt }),
      createdAt: now,
      event: event(
        current.id,
        'trigger.skipped',
        now,
        payload,
        current.revision + 1,
        `${windowStart}:${windowEnd}`
      )
    }).resource as StoredScheduleTrigger
  }

  private markCatchUp(
    current: StoredScheduleTrigger,
    now: number,
    catchUpUntilAt: number
  ): StoredScheduleTrigger {
    return this.eventStore.mutateResource<PersistentScheduleTriggerState>({
      operation: 'update',
      kind: MAGIC_AGENT_TRIGGER_RESOURCE_KIND,
      id: current.id,
      idempotencyKey: key(current.id, `catch-up:${current.state.nextFireAt}:${catchUpUntilAt}`),
      expectedRevision: current.revision,
      state: { ...current.state, catchUpUntilAt },
      createdAt: now,
      event: event(
        current.id,
        'trigger.catch-up.started',
        now,
        { windowStart: current.state.nextFireAt, windowEnd: catchUpUntilAt },
        current.revision + 1,
        `${current.state.nextFireAt}:${catchUpUntilAt}`
      )
    }).resource as StoredScheduleTrigger
  }
  private requireActiveClaim(
    triggerId: string,
    claimId: string,
    at: number
  ): StoredScheduleTrigger {
    const current = this.get(triggerId)
    if (!current) throw new Error(`Trigger not found: ${triggerId}`)
    if (!isScheduleResource(current)) throw new Error('Source-driven Trigger cannot hold a claim.')
    if (current.state.claim?.claimId !== claimId) throw new Error('Trigger claim does not match.')
    if (at >= current.state.claim.expiresAt) throw new Error('Trigger claim has expired.')
    return current
  }

  private replayResourceMutation(
    triggerId: string,
    callerKey: string,
    expected: Readonly<{
      createdAt: number
      type: string
      payload: Readonly<Record<string, unknown>>
    }>
  ): StoredResource<PersistentTriggerState> | undefined {
    const mutation = this.eventStore
      .listResourceMutations(MAGIC_AGENT_TRIGGER_RESOURCE_KIND, triggerId, 1_000)
      .find((candidate) => candidate.idempotencyKey === callerKey)
    if (!mutation) return undefined
    const committedEvent = this.eventStore.getEvent(mutation.eventId)
    const committedPayload = committedEvent?.payload as Record<string, unknown> | undefined
    if (
      committedEvent?.createdAt !== expected.createdAt ||
      committedEvent?.type !== expected.type ||
      !committedPayload ||
      canonicalPolicyJson(committedPayload as PolicyJsonValue) !==
        canonicalPolicyJson(expected.payload as PolicyJsonValue)
    )
      throw new Error('Trigger mutation replay payload conflicts with committed command.')
    return mutation.resource as StoredResource<PersistentTriggerState>
  }

  private replayClaimMutation(
    triggerId: string,
    suffix: string,
    committedAt: number,
    payload: Readonly<Record<string, unknown>>
  ): StoredResource<PersistentTriggerState> | undefined {
    const idempotencyKey = key(triggerId, suffix)
    const mutation = this.eventStore
      .listResourceMutations(MAGIC_AGENT_TRIGGER_RESOURCE_KIND, triggerId, 1_000)
      .find((candidate) => candidate.idempotencyKey === idempotencyKey)
    if (!mutation) return undefined
    const committedEvent = this.eventStore.getEvent(mutation.eventId)
    const committedPayload = committedEvent?.payload as Record<string, unknown> | undefined
    if (
      committedEvent?.createdAt !== committedAt ||
      !committedPayload ||
      Object.entries(payload).some(([name, value]) => committedPayload[name] !== value)
    ) {
      throw new Error(
        `Trigger claim replay payload conflicts with committed ${suffix.split(':')[0]}.`
      )
    }
    return mutation.resource as StoredResource<PersistentTriggerState>
  }
}

const assertJsonRecord: (value: unknown) => asserts value is Record<string, unknown> = (
  value: unknown
) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Trigger config must be a JSON object.')
  const walk = (item: unknown): void => {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return
    if (Array.isArray(item)) return item.forEach(walk)
    if (typeof item !== 'object') throw new Error('Trigger config must be JSON-safe.')
    Object.values(item).forEach(walk)
  }
  walk(value)
}

const clean = <T extends PersistentTriggerState>(value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T

const occurrenceFromClaim = (claim: TriggerClaim): TriggerOccurrence => ({
  occurrenceAt: claim.occurrenceAt,
  windowStart: claim.windowStart,
  windowEnd: claim.windowEnd,
  missedCount: claim.missedCount,
  nextFireAtAfter: claim.nextFireAtAfter,
  ...(claim.batchEndAt === undefined ? {} : { batchEndAt: claim.batchEndAt })
})

const retryOccurrence = (
  state: PersistentScheduleTriggerState,
  now: number
): TriggerOccurrence | undefined => {
  if (state.failure && state.failure.nextRetryAt <= now) return state.failure.occurrence
  if (state.claim && state.claim.expiresAt <= now) return occurrenceFromClaim(state.claim)
  return undefined
}

const isClaimable = (state: PersistentScheduleTriggerState, now: number) =>
  Boolean(
    state.enabled &&
    !state.paused &&
    (!state.failure ? state.nextFireAt <= now : state.failure.nextRetryAt <= now) &&
    (!state.claim || state.claim.expiresAt <= now)
  )

const isRevisionConflict = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  error.code === 'MAGIC_AGENT_RESOURCE_REVISION_CONFLICT'
