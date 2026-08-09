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
})
