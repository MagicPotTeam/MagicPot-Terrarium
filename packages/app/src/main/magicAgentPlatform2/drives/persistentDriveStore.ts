import type { MagicAgentDriveState } from '../../../shared/magicAgentPlatform2/drive'
import { canonicalPolicyJson, sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import type { MagicAgentEventStore, StoredResource } from '../persistence/eventStore'

export const MAGIC_AGENT_DRIVE_RESOURCE_KIND = 'drive' as const

export type CreateDriveInput = Readonly<{
  drive: MagicAgentDriveState
  createdAt: number
  idempotencyKey: string
}>

const event = (
  driveId: string,
  createdAt: number,
  payload: Record<string, unknown>,
  revision: number
) => ({
  protocolVersion: '2.0.0',
  id: `drive:${driveId}:created:${createdAt}:${revision}`,
  type: 'drive.created',
  createdAt,
  payload,
  envelopeKind: 'event' as const,
  streamId: `drive:${driveId}:stream`,
  sequence: revision,
  resource: { kind: MAGIC_AGENT_DRIVE_RESOURCE_KIND, id: driveId },
  revision
})

const assertLinks = (driveId: string, links: MagicAgentDriveState['links']): void => {
  const linkKeys = new Set<string>()
  for (const link of links) {
    if (!link.targetId.trim() || link.targetId === driveId)
      throw new Error('Drive link target must be a different resource.')
    const key = `${link.kind}:${link.targetId}`
    if (linkKeys.has(key)) throw new Error('Drive links must be unique.')
    linkKeys.add(key)
  }
}

const assertDrive = (drive: MagicAgentDriveState): void => {
  if (!drive.id.trim() || !drive.title.trim() || !drive.objective.trim())
    throw new Error('Drive id, title, and objective are required.')
  if (drive.status !== 'draft' && drive.status !== 'active')
    throw new Error('New Drive status must be draft or active.')
  if (!Number.isInteger(drive.priority) || drive.priority < 0)
    throw new Error('Drive priority must be a non-negative integer.')
  if (drive.deliveryTarget) {
    if (!drive.deliveryTarget.agentId.trim() || !drive.deliveryTarget.text.trim())
      throw new Error('Drive delivery target agentId and text are required.')
    if (drive.deliveryTarget.allowedToolNames?.some((name) => !name.trim()))
      throw new Error('Drive delivery target tool names must be non-empty.')
  }
  assertLinks(drive.id, drive.links)
}

const transitions: Readonly<
  Record<MagicAgentDriveState['status'], readonly MagicAgentDriveState['status'][]>
> = {
  draft: ['active', 'cancelled'],
  active: ['waiting', 'paused', 'completed', 'failed', 'cancelled'],
  waiting: ['active', 'paused', 'failed', 'cancelled'],
  paused: ['active', 'cancelled'],
  completed: [],
  failed: ['active', 'cancelled'],
  cancelled: []
}

const mutationEvent = (
  driveId: string,
  type: string,
  createdAt: number,
  payload: Record<string, unknown>,
  revision: number
) => ({
  protocolVersion: '2.0.0',
  id: `drive:${driveId}:${type}:${createdAt}:${revision}`,
  type,
  createdAt,
  payload,
  envelopeKind: 'event' as const,
  streamId: `drive:${driveId}:stream`,
  sequence: revision,
  resource: { kind: MAGIC_AGENT_DRIVE_RESOURCE_KIND, id: driveId },
  revision
})

export class PersistentDriveStore {
  constructor(private readonly eventStore: MagicAgentEventStore) {}

  list(): readonly StoredResource<MagicAgentDriveState>[] {
    return this.eventStore.listResources({
      kind: MAGIC_AGENT_DRIVE_RESOURCE_KIND,
      limit: 1_000
    }) as readonly StoredResource<MagicAgentDriveState>[]
  }

  get(driveId: string): StoredResource<MagicAgentDriveState> | undefined {
    return this.eventStore.getResource(MAGIC_AGENT_DRIVE_RESOURCE_KIND, driveId) as
      | StoredResource<MagicAgentDriveState>
      | undefined
  }

  transition(input: {
    driveId: string
    expectedRevision: number
    status: MagicAgentDriveState['status']
    transitionedAt: number
    idempotencyKey: string
    reason?: string
  }): StoredResource<MagicAgentDriveState> {
    if (
      !input.driveId.trim() ||
      !input.idempotencyKey.trim() ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isFinite(input.transitionedAt) ||
      input.transitionedAt < 0 ||
      (input.reason !== undefined && !input.reason.trim())
    )
      throw new Error('Invalid Drive transition command.')
    const storedKey = `drive:${input.driveId}:transition:${input.idempotencyKey}`
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_DRIVE_RESOURCE_KIND, input.driveId, 1_000)
      .find((mutation) => mutation.idempotencyKey === storedKey)
    if (replay) {
      const committed = this.eventStore.getEvent(replay.eventId)
      const payload = committed?.payload as { status?: string; reason?: string } | undefined
      if (
        committed?.type !== 'drive.status-transitioned' ||
        committed.createdAt !== input.transitionedAt ||
        payload?.status !== input.status ||
        payload.reason !== input.reason
      )
        throw new Error('Drive transition idempotency conflict.')
      return replay.resource as StoredResource<MagicAgentDriveState>
    }
    const current = this.get(input.driveId)
    if (!current) throw new Error('Drive not found.')
    if (current.revision !== input.expectedRevision) throw new Error('Drive revision conflict.')
    if (!transitions[current.state.status].includes(input.status))
      throw new Error(`Invalid Drive transition: ${current.state.status} -> ${input.status}.`)
    const terminal =
      input.status === 'completed' || input.status === 'failed' || input.status === 'cancelled'
    const state: MagicAgentDriveState = terminal
      ? { ...current.state, status: input.status, terminalReason: input.reason ?? input.status }
      : (Object.fromEntries(
          Object.entries({ ...current.state, status: input.status }).filter(
            ([name]) => name !== 'terminalReason'
          )
        ) as unknown as MagicAgentDriveState)
    return this.eventStore.mutateResource<MagicAgentDriveState>({
      operation: 'update',
      kind: MAGIC_AGENT_DRIVE_RESOURCE_KIND,
      id: input.driveId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: storedKey,
      state,
      createdAt: input.transitionedAt,
      event: mutationEvent(
        input.driveId,
        'drive.status-transitioned',
        input.transitionedAt,
        {
          fromStatus: current.state.status,
          status: input.status,
          ...(input.reason === undefined ? {} : { reason: input.reason })
        },
        input.expectedRevision + 1
      )
    }).resource
  }

  transfer(input: {
    driveId: string
    expectedRevision: number
    ownerId?: string
    assigneeId?: string
    transferredAt: number
    idempotencyKey: string
  }): StoredResource<MagicAgentDriveState> {
    if (
      !input.driveId.trim() ||
      !input.idempotencyKey.trim() ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isFinite(input.transferredAt) ||
      input.transferredAt < 0 ||
      (input.ownerId !== undefined && !input.ownerId.trim()) ||
      (input.assigneeId !== undefined && !input.assigneeId.trim())
    )
      throw new Error('Invalid Drive transfer command.')
    if (input.ownerId === undefined && input.assigneeId === undefined)
      throw new Error('Drive transfer must change owner or assignee.')
    const storedKey = `drive:${input.driveId}:transfer:${input.idempotencyKey}`
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_DRIVE_RESOURCE_KIND, input.driveId, 1_000)
      .find((mutation) => mutation.idempotencyKey === storedKey)
    if (replay) {
      const committed = this.eventStore.getEvent(replay.eventId)
      const payload = committed?.payload as { ownerId?: string; assigneeId?: string } | undefined
      if (
        committed?.type !== 'drive.transferred' ||
        committed.createdAt !== input.transferredAt ||
        payload?.ownerId !== input.ownerId ||
        payload?.assigneeId !== input.assigneeId
      )
        throw new Error('Drive transfer idempotency conflict.')
      return replay.resource as StoredResource<MagicAgentDriveState>
    }
    const current = this.get(input.driveId)
    if (!current) throw new Error('Drive not found.')
    if (current.revision !== input.expectedRevision) throw new Error('Drive revision conflict.')
    if (current.state.status === 'completed' || current.state.status === 'cancelled')
      throw new Error('Terminal Drive cannot be transferred.')
    const state: MagicAgentDriveState = {
      ...current.state,
      ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
      ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId })
    }
    return this.eventStore.mutateResource<MagicAgentDriveState>({
      operation: 'update',
      kind: MAGIC_AGENT_DRIVE_RESOURCE_KIND,
      id: input.driveId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: storedKey,
      state,
      createdAt: input.transferredAt,
      event: mutationEvent(
        input.driveId,
        'drive.transferred',
        input.transferredAt,
        {
          ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
          ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId })
        },
        input.expectedRevision + 1
      )
    }).resource
  }

  reportProgress(input: {
    driveId: string
    expectedRevision: number
    summary: string
    evidence: NonNullable<MagicAgentDriveState['progress']>['evidence']
    reportedAt: number
    idempotencyKey: string
  }): StoredResource<MagicAgentDriveState> {
    if (
      !input.driveId.trim() ||
      !input.summary.trim() ||
      !input.idempotencyKey.trim() ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isFinite(input.reportedAt) ||
      input.reportedAt < 0
    )
      throw new Error('Invalid Drive progress command.')
    for (const item of input.evidence) {
      if (!item.ref.trim() || (item.digest !== undefined && !/^[a-f0-9]{64}$/i.test(item.digest)))
        throw new Error('Invalid Drive progress evidence.')
    }
    const evidenceDigest = sha256PolicyText(canonicalPolicyJson(input.evidence as never))
    const storedKey = `drive:${input.driveId}:progress:${input.idempotencyKey}`
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_DRIVE_RESOURCE_KIND, input.driveId, 1_000)
      .find((mutation) => mutation.idempotencyKey === storedKey)
    if (replay) {
      const committed = this.eventStore.getEvent(replay.eventId)
      const payload = committed?.payload as
        | { summary?: string; evidenceDigest?: string }
        | undefined
      if (
        committed?.type !== 'drive.progress-reported' ||
        committed.createdAt !== input.reportedAt ||
        payload?.summary !== input.summary ||
        payload?.evidenceDigest !== evidenceDigest
      )
        throw new Error('Drive progress idempotency conflict.')
      return replay.resource as StoredResource<MagicAgentDriveState>
    }
    const current = this.get(input.driveId)
    if (!current) throw new Error('Drive not found.')
    if (current.revision !== input.expectedRevision) throw new Error('Drive revision conflict.')
    if (current.state.status === 'completed' || current.state.status === 'cancelled')
      throw new Error('Terminal Drive progress cannot be changed.')
    const progress = {
      summary: input.summary,
      reportedAt: input.reportedAt,
      sequence: (current.state.progress?.sequence ?? 0) + 1,
      evidence: input.evidence
    }
    return this.eventStore.mutateResource<MagicAgentDriveState>({
      operation: 'update',
      kind: MAGIC_AGENT_DRIVE_RESOURCE_KIND,
      id: input.driveId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: storedKey,
      state: { ...current.state, progress },
      createdAt: input.reportedAt,
      event: mutationEvent(
        input.driveId,
        'drive.progress-reported',
        input.reportedAt,
        {
          summary: input.summary,
          evidenceDigest,
          evidenceCount: input.evidence.length,
          sequence: progress.sequence
        },
        input.expectedRevision + 1
      )
    }).resource
  }

  claimDelivery(input: {
    now: number
    leaseMs: number
    ownerId: string
    token: string
  }): StoredResource<MagicAgentDriveState> | undefined {
    if (
      !Number.isFinite(input.now) ||
      input.now < 0 ||
      !Number.isFinite(input.leaseMs) ||
      input.leaseMs <= 0 ||
      !input.ownerId.trim() ||
      !input.token.trim()
    )
      throw new Error('Invalid Drive delivery claim.')
    const candidates = this.list()
      .filter((item) => {
        const delivery = item.state.delivery
        return (
          item.state.status === 'active' &&
          item.state.assigneeId !== undefined &&
          item.state.deliveryTarget !== undefined &&
          delivery?.acknowledgedAt === undefined &&
          delivery?.deadLetteredAt === undefined &&
          (delivery?.nextAttemptAt ?? 0) <= input.now &&
          (delivery?.lease === undefined || delivery.lease.expiresAt <= input.now)
        )
      })
      .toSorted(
        (left, right) =>
          right.state.priority - left.state.priority ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id)
      )
    const current = candidates[0]
    if (!current) return undefined
    const attemptCount = (current.state.delivery?.attemptCount ?? 0) + 1
    return this.eventStore.mutateResource<MagicAgentDriveState>({
      operation: 'update',
      kind: MAGIC_AGENT_DRIVE_RESOURCE_KIND,
      id: current.id,
      expectedRevision: current.revision,
      idempotencyKey: `drive:${current.id}:delivery-claim:${input.token}`,
      state: {
        ...current.state,
        delivery: {
          attemptCount,
          nextAttemptAt: current.state.delivery?.nextAttemptAt ?? input.now,
          lease: {
            ownerId: input.ownerId,
            token: input.token,
            expiresAt: input.now + input.leaseMs
          },
          ...(current.state.delivery?.lastFailure
            ? { lastFailure: current.state.delivery.lastFailure }
            : {})
        }
      },
      createdAt: input.now,
      event: mutationEvent(
        current.id,
        'drive.delivery-claimed',
        input.now,
        { ownerId: input.ownerId, token: input.token, attemptCount },
        current.revision + 1
      )
    }).resource
  }

  acknowledgeDelivery(input: {
    driveId: string
    expectedRevision: number
    token: string
    acknowledgedAt: number
    idempotencyKey: string
  }): StoredResource<MagicAgentDriveState> {
    return this.finishDelivery(input, 'acknowledge')
  }

  failDelivery(input: {
    driveId: string
    expectedRevision: number
    token: string
    failedAt: number
    reason: string
    retryDelayMs: number
    maxAttempts: number
    idempotencyKey: string
  }): StoredResource<MagicAgentDriveState> {
    return this.finishDelivery(input, 'fail')
  }

  retryDelivery(input: {
    driveId: string
    expectedRevision: number
    retryAt: number
    idempotencyKey: string
  }): StoredResource<MagicAgentDriveState> {
    if (
      !input.driveId.trim() ||
      !input.idempotencyKey.trim() ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isFinite(input.retryAt) ||
      input.retryAt < 0
    )
      throw new Error('Invalid Drive delivery retry command.')
    const storedKey = `drive:${input.driveId}:delivery-retry:${input.idempotencyKey}`
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_DRIVE_RESOURCE_KIND, input.driveId, 1_000)
      .find((m) => m.idempotencyKey === storedKey)
    if (replay) {
      const committed = this.eventStore.getEvent(replay.eventId)
      const payload = committed?.payload as { retryAt?: number } | undefined
      if (
        committed?.type !== 'drive.delivery-retried' ||
        committed.createdAt !== input.retryAt ||
        payload?.retryAt !== input.retryAt
      )
        throw new Error('Drive delivery retry idempotency conflict.')
      return replay.resource as StoredResource<MagicAgentDriveState>
    }
    const current = this.get(input.driveId)
    if (!current) throw new Error('Drive not found.')
    if (current.revision !== input.expectedRevision) throw new Error('Drive revision conflict.')
    if (!current.state.delivery) throw new Error('Drive delivery not found.')
    if (current.state.status === 'completed' || current.state.status === 'cancelled')
      throw new Error('Terminal Drive cannot be retried.')
    const {
      lease: _lease,
      deadLetteredAt: _dead,
      acknowledgedAt: _ack,
      ...preserved
    } = current.state.delivery
    return this.eventStore.mutateResource<MagicAgentDriveState>({
      operation: 'update',
      kind: MAGIC_AGENT_DRIVE_RESOURCE_KIND,
      id: input.driveId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: storedKey,
      state: { ...current.state, delivery: { ...preserved, nextAttemptAt: input.retryAt } },
      createdAt: input.retryAt,
      event: mutationEvent(
        input.driveId,
        'drive.delivery-retried',
        input.retryAt,
        { retryAt: input.retryAt },
        input.expectedRevision + 1
      )
    }).resource
  }

  private finishDelivery(
    input:
      | {
          driveId: string
          expectedRevision: number
          token: string
          acknowledgedAt: number
          idempotencyKey: string
        }
      | {
          driveId: string
          expectedRevision: number
          token: string
          failedAt: number
          reason: string
          retryDelayMs: number
          maxAttempts: number
          idempotencyKey: string
        },
    operation: 'acknowledge' | 'fail'
  ): StoredResource<MagicAgentDriveState> {
    const acknowledge = 'acknowledgedAt' in input
    const at = acknowledge ? input.acknowledgedAt : input.failedAt
    if (
      !input.driveId.trim() ||
      !input.token.trim() ||
      !input.idempotencyKey.trim() ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isFinite(at) ||
      at < 0
    )
      throw new Error('Invalid Drive delivery completion command.')
    if (
      !acknowledge &&
      (!input.reason.trim() ||
        !Number.isFinite(input.retryDelayMs) ||
        input.retryDelayMs < 0 ||
        !Number.isInteger(input.maxAttempts) ||
        input.maxAttempts <= 0)
    )
      throw new Error('Invalid Drive delivery failure command.')
    const storedKey = `drive:${input.driveId}:delivery-${operation}:${input.idempotencyKey}`
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_DRIVE_RESOURCE_KIND, input.driveId, 1_000)
      .find((mutation) => mutation.idempotencyKey === storedKey)
    if (replay) return replay.resource as StoredResource<MagicAgentDriveState>
    const current = this.get(input.driveId)
    if (!current) throw new Error('Drive not found.')
    if (current.revision !== input.expectedRevision) throw new Error('Drive revision conflict.')
    const delivery = current.state.delivery
    if (!delivery?.lease || delivery.lease.token !== input.token || delivery.lease.expiresAt < at)
      throw new Error('Drive delivery lease conflict.')
    const deadLetter = !acknowledge && delivery.attemptCount >= input.maxAttempts
    const nextDelivery = acknowledge
      ? {
          attemptCount: delivery.attemptCount,
          nextAttemptAt: delivery.nextAttemptAt,
          acknowledgedAt: at
        }
      : {
          attemptCount: delivery.attemptCount,
          nextAttemptAt: at + input.retryDelayMs,
          ...(deadLetter ? { deadLetteredAt: at } : {}),
          lastFailure: { failedAt: at, reason: input.reason }
        }
    return this.eventStore.mutateResource<MagicAgentDriveState>({
      operation: 'update',
      kind: MAGIC_AGENT_DRIVE_RESOURCE_KIND,
      id: input.driveId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: storedKey,
      state: { ...current.state, delivery: nextDelivery },
      createdAt: at,
      event: mutationEvent(
        input.driveId,
        acknowledge
          ? 'drive.delivery-acknowledged'
          : deadLetter
            ? 'drive.delivery-dead-lettered'
            : 'drive.delivery-failed',
        at,
        acknowledge
          ? { token: input.token }
          : { token: input.token, reason: input.reason, deadLetter },
        input.expectedRevision + 1
      )
    }).resource
  }

  setLinks(input: {
    driveId: string
    expectedRevision: number
    links: MagicAgentDriveState['links']
    updatedAt: number
    idempotencyKey: string
  }): StoredResource<MagicAgentDriveState> {
    if (
      !input.driveId.trim() ||
      !input.idempotencyKey.trim() ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !Number.isFinite(input.updatedAt) ||
      input.updatedAt < 0
    )
      throw new Error('Invalid Drive links command.')
    const storedKey = `drive:${input.driveId}:links:${input.idempotencyKey}`
    const linksDigest = sha256PolicyText(canonicalPolicyJson(input.links as never))
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_DRIVE_RESOURCE_KIND, input.driveId, 1_000)
      .find((mutation) => mutation.idempotencyKey === storedKey)
    if (replay) {
      const committed = this.eventStore.getEvent(replay.eventId)
      const payload = committed?.payload as { linksDigest?: string } | undefined
      if (
        committed?.type !== 'drive.links-updated' ||
        committed.createdAt !== input.updatedAt ||
        payload?.linksDigest !== linksDigest
      )
        throw new Error('Drive links idempotency conflict.')
      return replay.resource as StoredResource<MagicAgentDriveState>
    }
    const current = this.get(input.driveId)
    if (!current) throw new Error('Drive not found.')
    if (current.revision !== input.expectedRevision) throw new Error('Drive revision conflict.')
    if (current.state.status === 'completed' || current.state.status === 'cancelled')
      throw new Error('Terminal Drive links cannot be changed.')
    assertLinks(input.driveId, input.links)
    const state: MagicAgentDriveState = { ...current.state, links: input.links }
    return this.eventStore.mutateResource<MagicAgentDriveState>({
      operation: 'update',
      kind: MAGIC_AGENT_DRIVE_RESOURCE_KIND,
      id: input.driveId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: storedKey,
      state,
      createdAt: input.updatedAt,
      event: mutationEvent(
        input.driveId,
        'drive.links-updated',
        input.updatedAt,
        { linksDigest, linkCount: input.links.length },
        input.expectedRevision + 1
      )
    }).resource
  }

  create(input: CreateDriveInput): StoredResource<MagicAgentDriveState> {
    assertDrive(input.drive)
    if (!Number.isFinite(input.createdAt) || input.createdAt < 0 || !input.idempotencyKey.trim())
      throw new Error('Invalid Drive create command.')
    const stateDigest = sha256PolicyText(canonicalPolicyJson(input.drive as never))
    const storedKey = `drive:${input.drive.id}:caller:${input.idempotencyKey}`
    const replay = this.eventStore
      .listResourceMutations(MAGIC_AGENT_DRIVE_RESOURCE_KIND, input.drive.id, 1_000)
      .find((mutation) => mutation.idempotencyKey === storedKey)
    if (replay) {
      const committed = this.eventStore.getEvent(replay.eventId)
      const payload = committed?.payload as { stateDigest?: string } | undefined
      if (
        committed?.type !== 'drive.created' ||
        committed.createdAt !== input.createdAt ||
        payload?.stateDigest !== stateDigest
      )
        throw new Error('Drive create idempotency conflict.')
      return replay.resource as StoredResource<MagicAgentDriveState>
    }
    if (this.get(input.drive.id)) throw new Error('Drive already exists.')
    return this.eventStore.mutateResource<MagicAgentDriveState>({
      operation: 'create',
      kind: MAGIC_AGENT_DRIVE_RESOURCE_KIND,
      id: input.drive.id,
      state: input.drive,
      createdAt: input.createdAt,
      idempotencyKey: storedKey,
      event: event(
        input.drive.id,
        input.createdAt,
        {
          driveId: input.drive.id,
          status: input.drive.status,
          priority: input.drive.priority,
          stateDigest
        },
        0
      )
    }).resource
  }
}
