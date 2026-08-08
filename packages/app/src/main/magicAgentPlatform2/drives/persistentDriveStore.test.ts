import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentDriveStore } from './persistentDriveStore'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fileStore = (databasePath?: string) => {
  const root = databasePath
    ? undefined
    : join('C:\\MagicPot-Terrarium-Tests', `magic-agent-drive-${Date.now()}-${Math.random()}`)
  if (root) {
    mkdirSync(root, { recursive: true })
    roots.push(root)
  }
  const path = databasePath ?? join(root!, 'events.sqlite')
  const eventStore = new MagicAgentEventStore(path)
  return { eventStore, store: new PersistentDriveStore(eventStore), databasePath: path }
}

const drive = () => ({
  id: 'drive-1',
  title: 'Ship Drive control plane',
  objective: 'Implement durable goals.',
  status: 'active' as const,
  priority: 10,
  ownerId: 'owner-1',
  assigneeId: 'agent-1',
  deliveryTarget: { kind: 'agent' as const, agentId: 'agent-1', text: 'Deliver goal' },
  links: [{ kind: 'task-group' as const, targetId: 'task-group-1' }],
  metadata: { source: 'platform-2' }
})

describe('PersistentDriveStore', () => {
  it('durably retries a dead-lettered delivery with replay and conflict guards', () => {
    const first = fileStore()
    first.store.create({ drive: drive(), createdAt: 10, idempotencyKey: 'create-drive' })
    const claimed = first.store.claimDelivery({
      ownerId: 'worker-1',
      now: 20,
      leaseMs: 100,
      token: 'claim-token'
    })!
    const dead = first.store.failDelivery({
      driveId: claimed.id,
      expectedRevision: claimed.revision,
      token: claimed.state.delivery!.lease!.token,
      failedAt: 30,
      reason: 'boom',
      retryDelayMs: 50,
      maxAttempts: 1,
      idempotencyKey: 'fail-drive'
    })
    expect(dead.state.delivery?.deadLetteredAt).toBe(30)

    const retry = {
      driveId: dead.id,
      expectedRevision: dead.revision,
      retryAt: 40,
      idempotencyKey: 'retry-drive'
    }
    const retried = first.store.retryDelivery(retry)
    expect(retried.state.delivery).toMatchObject({ attemptCount: 1, nextAttemptAt: 40 })
    expect(retried.state.delivery?.deadLetteredAt).toBeUndefined()
    expect(retried.state.delivery?.lease).toBeUndefined()
    expect(first.store.retryDelivery(retry)).toEqual(retried)
    expect(() => first.store.retryDelivery({ ...retry, retryAt: 41 })).toThrow(
      /idempotency conflict/i
    )
    first.eventStore.close()

    const reopened = fileStore(first.databasePath)
    expect(reopened.store.retryDelivery(retry)).toEqual(retried)
    reopened.eventStore.close()
  })

  it('creates, queries, and exactly replays a caller-idempotent Drive', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentDriveStore(eventStore)
      const input = { drive: drive(), createdAt: 10, idempotencyKey: 'create-drive' }
      const first = store.create(input)
      expect(store.get('drive-1')).toEqual(first)
      expect(store.list()).toEqual([first])
      expect(store.create(input)).toEqual(first)
      expect(() => store.create({ ...input, drive: { ...input.drive, title: 'Changed' } })).toThrow(
        /idempotency conflict/i
      )
      expect(() => store.create({ ...input, idempotencyKey: 'another-caller' })).toThrow(
        /already exists/i
      )
    } finally {
      eventStore.close()
    }
  })

  it('replays transition and transfer mutations after SQLite reopen', () => {
    const first = fileStore()
    first.store.create({ drive: drive(), createdAt: 10, idempotencyKey: 'create-drive' })
    const transition = {
      driveId: 'drive-1',
      expectedRevision: 0,
      status: 'waiting' as const,
      transitionedAt: 20,
      idempotencyKey: 'wait-drive'
    }
    const waited = first.store.transition(transition)
    const transfer = {
      driveId: 'drive-1',
      expectedRevision: 1,
      assigneeId: 'agent-2',
      transferredAt: 30,
      idempotencyKey: 'transfer-drive'
    }
    const transferred = first.store.transfer(transfer)
    first.eventStore.close()

    const reopened = fileStore(first.databasePath)
    expect(reopened.store.transition(transition)).toEqual(waited)
    expect(reopened.store.transfer(transfer)).toEqual(transferred)
    reopened.eventStore.close()
  })

  it('transitions and transfers with durable replay and lifecycle guards', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentDriveStore(eventStore)
      store.create({ drive: drive(), createdAt: 10, idempotencyKey: 'create-drive' })
      const waitingInput = {
        driveId: 'drive-1',
        expectedRevision: 0,
        status: 'waiting' as const,
        transitionedAt: 20,
        idempotencyKey: 'wait-drive',
        reason: 'external dependency'
      }
      const waiting = store.transition(waitingInput)
      expect(store.transition(waitingInput)).toEqual(waiting)
      expect(() => store.transition({ ...waitingInput, status: 'paused' })).toThrow(
        /idempotency conflict/i
      )
      const transferred = store.transfer({
        driveId: 'drive-1',
        expectedRevision: 1,
        ownerId: 'owner-2',
        assigneeId: 'agent-2',
        transferredAt: 30,
        idempotencyKey: 'transfer-drive'
      })
      expect(transferred.state).toMatchObject({ ownerId: 'owner-2', assigneeId: 'agent-2' })
      const active = store.transition({
        driveId: 'drive-1',
        expectedRevision: 2,
        status: 'active',
        transitionedAt: 40,
        idempotencyKey: 'resume-drive'
      })
      const terminal = store.transition({
        driveId: 'drive-1',
        expectedRevision: active.revision,
        status: 'completed',
        transitionedAt: 50,
        idempotencyKey: 'complete-drive',
        reason: 'done'
      })
      expect(terminal.state.terminalReason).toBe('done')
      expect(() =>
        store.transfer({
          driveId: 'drive-1',
          expectedRevision: terminal.revision,
          assigneeId: 'agent-3',
          transferredAt: 60,
          idempotencyKey: 'late-transfer'
        })
      ).toThrow(/terminal/i)
    } finally {
      eventStore.close()
    }
  })

  it('reports durable progress with safe evidence links and replay', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentDriveStore(eventStore)
      store.create({ drive: drive(), createdAt: 10, idempotencyKey: 'create-drive' })
      const input = {
        driveId: 'drive-1',
        expectedRevision: 0,
        summary: 'Implemented delivery',
        reportedAt: 20,
        idempotencyKey: 'progress-1',
        evidence: [
          { kind: 'session' as const, ref: 'session-1' },
          { kind: 'run' as const, ref: 'run-1' },
          { kind: 'artifact' as const, ref: 'artifact-1', digest: 'a'.repeat(64) }
        ]
      }
      const progress = store.reportProgress(input)
      expect(store.reportProgress(input)).toEqual(progress)
      expect(progress.state.progress).toMatchObject({
        summary: 'Implemented delivery',
        sequence: 1
      })
      expect(() => store.reportProgress({ ...input, summary: 'Changed' })).toThrow(
        /idempotency conflict/i
      )
      expect(() =>
        store.reportProgress({
          ...input,
          expectedRevision: progress.revision,
          idempotencyKey: 'bad-evidence',
          evidence: [{ kind: 'artifact', ref: 'artifact-2', digest: 'raw secret' }]
        })
      ).toThrow(/evidence/i)
    } finally {
      eventStore.close()
    }
  })

  it('claims, retries, acknowledges, and dead-letters deliveries with lease fencing', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentDriveStore(eventStore)
      store.create({ drive: drive(), createdAt: 10, idempotencyKey: 'create-drive' })
      const first = store.claimDelivery({
        now: 20,
        leaseMs: 10,
        ownerId: 'worker-1',
        token: 'claim-1'
      })!
      expect(first.state.delivery).toMatchObject({ attemptCount: 1, lease: { token: 'claim-1' } })
      expect(() =>
        store.acknowledgeDelivery({
          driveId: 'drive-1',
          expectedRevision: first.revision,
          token: 'wrong',
          acknowledgedAt: 21,
          idempotencyKey: 'bad-ack'
        })
      ).toThrow(/lease conflict/i)
      const failed = store.failDelivery({
        driveId: 'drive-1',
        expectedRevision: first.revision,
        token: 'claim-1',
        failedAt: 21,
        reason: 'temporary',
        retryDelayMs: 9,
        maxAttempts: 2,
        idempotencyKey: 'fail-1'
      })
      expect(
        store.claimDelivery({ now: 29, leaseMs: 10, ownerId: 'worker-2', token: 'claim-early' })
      ).toBeUndefined()
      const second = store.claimDelivery({
        now: 30,
        leaseMs: 10,
        ownerId: 'worker-2',
        token: 'claim-2'
      })!
      expect(second.state.delivery?.attemptCount).toBe(2)
      const dead = store.failDelivery({
        driveId: 'drive-1',
        expectedRevision: second.revision,
        token: 'claim-2',
        failedAt: 31,
        reason: 'permanent',
        retryDelayMs: 9,
        maxAttempts: 2,
        idempotencyKey: 'fail-2'
      })
      expect(dead.state.delivery?.deadLetteredAt).toBe(31)
      expect(
        store.claimDelivery({ now: 100, leaseMs: 10, ownerId: 'worker-3', token: 'claim-3' })
      ).toBeUndefined()

      store.create({
        drive: { ...drive(), id: 'drive-ack' },
        createdAt: 11,
        idempotencyKey: 'create-ack'
      })
      const claimedAck = store.claimDelivery({
        now: 40,
        leaseMs: 10,
        ownerId: 'worker-1',
        token: 'claim-ack'
      })!
      const ack = store.acknowledgeDelivery({
        driveId: claimedAck.id,
        expectedRevision: claimedAck.revision,
        token: 'claim-ack',
        acknowledgedAt: 41,
        idempotencyKey: 'ack-1'
      })
      expect(ack.state.delivery?.acknowledgedAt).toBe(41)
      expect(
        store.acknowledgeDelivery({
          driveId: claimedAck.id,
          expectedRevision: claimedAck.revision,
          token: 'claim-ack',
          acknowledgedAt: 41,
          idempotencyKey: 'ack-1'
        })
      ).toEqual(ack)
      expect(failed.state.delivery?.nextAttemptAt).toBe(30)
    } finally {
      eventStore.close()
    }
  })

  it('updates compatibility links with replay and terminal guards', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentDriveStore(eventStore)
      store.create({ drive: drive(), createdAt: 10, idempotencyKey: 'create-drive' })
      const input = {
        driveId: 'drive-1',
        expectedRevision: 0,
        links: [
          { kind: 'task-group' as const, targetId: 'task-group-2' },
          { kind: 'blocked-by' as const, targetId: 'drive-2' }
        ],
        updatedAt: 20,
        idempotencyKey: 'update-links'
      }
      const updated = store.setLinks(input)
      expect(store.setLinks(input)).toEqual(updated)
      expect(updated.state.links).toEqual(input.links)
      expect(() =>
        store.setLinks({ ...input, links: [{ kind: 'related', targetId: 'drive-3' }] })
      ).toThrow(/idempotency conflict/i)
      expect(() =>
        store.setLinks({
          ...input,
          expectedRevision: updated.revision,
          idempotencyKey: 'self-link-update',
          links: [{ kind: 'related', targetId: 'drive-1' }]
        })
      ).toThrow(/different resource/i)
    } finally {
      eventStore.close()
    }
  })

  it('rejects invalid initial lifecycle and link invariants', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentDriveStore(eventStore)
      expect(() =>
        store.create({
          drive: { ...drive(), status: 'completed' },
          createdAt: 10,
          idempotencyKey: 'terminal-drive'
        })
      ).toThrow(/draft or active/i)
      expect(() =>
        store.create({
          drive: {
            ...drive(),
            links: [{ kind: 'related', targetId: 'drive-1' }]
          },
          createdAt: 10,
          idempotencyKey: 'self-link'
        })
      ).toThrow(/different resource/i)
    } finally {
      eventStore.close()
    }
  })
})
