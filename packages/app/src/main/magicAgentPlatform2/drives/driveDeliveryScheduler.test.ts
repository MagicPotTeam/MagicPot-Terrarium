import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { DriveDeliveryScheduler } from './driveDeliveryScheduler'
import { PersistentDriveStore } from './persistentDriveStore'

const createDrive = (store: PersistentDriveStore, id: string, priority = 1) =>
  store.create({
    drive: {
      id,
      title: id,
      objective: `Deliver ${id}`,
      status: 'active',
      priority,
      assigneeId: 'agent-1',
      deliveryTarget: { kind: 'agent' as const, agentId: 'agent-1', text: `Deliver ${id}` },
      links: []
    },
    createdAt: 1,
    idempotencyKey: `create:${id}`
  })

describe('DriveDeliveryScheduler', () => {
  it('claims and acknowledges delivery through a single-flight worker', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentDriveStore(eventStore)
      createDrive(store, 'drive-low', 1)
      createDrive(store, 'drive-high', 10)
      const deliver = vi.fn(async () => undefined)
      const scheduler = new DriveDeliveryScheduler({
        store,
        deliver,
        ownerId: 'worker-1',
        now: () => 10,
        token: () => 'claim-one'
      })
      expect(await scheduler.runOnce()).toBe(true)
      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'drive-high' }))
      expect(store.get('drive-high')?.state.delivery?.acknowledgedAt).toBe(10)
      expect(store.get('drive-low')?.state.delivery).toBeUndefined()
    } finally {
      eventStore.close()
    }
  })

  it('retries failures and dead-letters after the configured max attempts', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentDriveStore(eventStore)
      createDrive(store, 'drive-fail')
      let now = 10
      let token = 0
      const scheduler = new DriveDeliveryScheduler({
        store,
        deliver: async () => {
          throw new Error('delivery failed')
        },
        ownerId: 'worker-1',
        now: () => now,
        token: () => `claim-${++token}`,
        retryDelayMs: 5,
        maxAttempts: 2
      })
      expect(await scheduler.runOnce()).toBe(true)
      expect(store.get('drive-fail')?.state.delivery).toMatchObject({
        attemptCount: 1,
        nextAttemptAt: 15
      })
      now = 14
      expect(await scheduler.runOnce()).toBe(false)
      now = 15
      expect(await scheduler.runOnce()).toBe(true)
      expect(store.get('drive-fail')?.state.delivery).toMatchObject({
        attemptCount: 2,
        deadLetteredAt: 15
      })
      now = 100
      expect(await scheduler.runOnce()).toBe(false)
    } finally {
      eventStore.close()
    }
  })

  it('settles successful delivery at the latest revision after progress is reported', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentDriveStore(eventStore)
      createDrive(store, 'drive-progress')
      let now = 10
      const scheduler = new DriveDeliveryScheduler({
        store,
        deliver: async (claimed) => {
          expect(claimed.id).toBe('drive-progress')
          store.reportProgress({
            driveId: claimed.id,
            expectedRevision: claimed.revision,
            summary: 'Completed the first step',
            evidence: [{ kind: 'run', ref: 'run-1' }],
            reportedAt: 11,
            idempotencyKey: 'progress-1'
          })
          now = 12
        },
        ownerId: 'worker-1',
        now: () => now,
        token: () => 'progress-claim'
      })

      expect(await scheduler.runOnce()).toBe(true)
      expect(store.get('drive-progress')?.state).toMatchObject({
        progress: {
          summary: 'Completed the first step',
          reportedAt: 11,
          sequence: 1,
          evidence: [{ kind: 'run', ref: 'run-1' }]
        },
        delivery: { acknowledgedAt: 12 }
      })
    } finally {
      eventStore.close()
    }
  })

  it('settles failed delivery at the latest revision after progress is reported', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentDriveStore(eventStore)
      createDrive(store, 'drive-progress-fail')
      let now = 10
      const scheduler = new DriveDeliveryScheduler({
        store,
        deliver: async (claimed) => {
          store.reportProgress({
            driveId: claimed.id,
            expectedRevision: claimed.revision,
            summary: 'Made partial progress',
            evidence: [{ kind: 'text', ref: 'checkpoint-1' }],
            reportedAt: 11,
            idempotencyKey: 'progress-before-failure'
          })
          now = 12
          throw new Error('delivery stopped')
        },
        ownerId: 'worker-1',
        now: () => now,
        token: () => 'failure-claim',
        retryDelayMs: 5
      })

      expect(await scheduler.runOnce()).toBe(true)
      expect(store.get('drive-progress-fail')?.state).toMatchObject({
        progress: {
          summary: 'Made partial progress',
          reportedAt: 11,
          evidence: [{ kind: 'text', ref: 'checkpoint-1' }]
        },
        delivery: {
          nextAttemptAt: 17,
          lastFailure: { failedAt: 12, reason: 'delivery stopped' }
        }
      })
    } finally {
      eventStore.close()
    }
  })

  it.each([
    ['successful', false],
    ['failed', true]
  ] as const)(
    'does not settle %s delivery after unrelated state changes with the same lease',
    async (_label, deliveryFails) => {
      const eventStore = new MagicAgentEventStore(':memory:')
      try {
        const store = new PersistentDriveStore(eventStore)
        createDrive(store, `drive-state-${deliveryFails ? 'fail' : 'ack'}`)
        const driveId = `drive-state-${deliveryFails ? 'fail' : 'ack'}`
        let now = 10
        const scheduler = new DriveDeliveryScheduler({
          store,
          deliver: async (claimed) => {
            now = 11
            store.transfer({
              driveId: claimed.id,
              expectedRevision: claimed.revision,
              ownerId: 'replacement-owner',
              transferredAt: now,
              idempotencyKey: `transfer:${claimed.id}`
            })
            now = 12
            if (deliveryFails) throw new Error('delivery failed after transfer')
          },
          ownerId: 'worker-1',
          now: () => now,
          token: () => `state-claim-${deliveryFails}`
        })

        await expect(scheduler.runOnce()).rejects.toThrow('Drive delivery state conflict')
        expect(store.get(driveId)?.state).toMatchObject({
          ownerId: 'replacement-owner',
          delivery: { lease: { token: `state-claim-${deliveryFails}` } }
        })
        expect(store.get(driveId)?.state.delivery?.acknowledgedAt).toBeUndefined()
        expect(store.get(driveId)?.state.delivery?.lastFailure).toBeUndefined()
      } finally {
        eventStore.close()
      }
    }
  )

  it('does not settle delivery after its lease is replaced', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentDriveStore(eventStore)
      createDrive(store, 'drive-lease-lost')
      let now = 10
      const scheduler = new DriveDeliveryScheduler({
        store,
        deliver: async () => {
          now = 16
          expect(
            store.claimDelivery({
              now,
              leaseMs: 10,
              ownerId: 'worker-2',
              token: 'replacement-claim'
            })
          ).toMatchObject({ id: 'drive-lease-lost' })
        },
        ownerId: 'worker-1',
        now: () => now,
        token: () => 'original-claim',
        leaseMs: 5
      })

      await expect(scheduler.runOnce()).rejects.toThrow('Drive delivery lease conflict')
      expect(store.get('drive-lease-lost')?.state.delivery).toMatchObject({
        attemptCount: 2,
        lease: { ownerId: 'worker-2', token: 'replacement-claim', expiresAt: 26 }
      })
      expect(store.get('drive-lease-lost')?.state.delivery?.acknowledgedAt).toBeUndefined()
      expect(store.get('drive-lease-lost')?.state.delivery?.lastFailure).toBeUndefined()
    } finally {
      eventStore.close()
    }
  })
})
