import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
import { MagicAgentEventStore } from '../persistence/eventStore'
import { DriveCommandError, DriveCommandService } from './driveCommandService'
import { clearDriveStateListenersForTest, subscribeDriveStates } from './driveStateEvents'
import {
  createProductionDriveDelivery,
  DRIVE_INVOCATION,
  closeProductionDriveLifecycle,
  getProductionDriveLifecycle,
  startProductionDriveLifecycle
} from './productionDriveLifecycle'
import { ProductionDriveRuntime } from './productionDriveRuntime'
import { readDriveTrustedDispatchContext } from '../../magicAgentRuntime/driveTrustedDispatchContext'

const drive = {
  id: 'drive-1',
  title: 'Drive',
  objective: 'Ship',
  status: 'active' as const,
  priority: 1,
  assigneeId: 'agent-1',
  links: []
}

describe('Production Drive runtime/lifecycle/commands', () => {
  it('recovers an expired pending delivery after SQLite reopen and acknowledges once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drive-runtime-restart-'))
    const databasePath = join(root, 'events.sqlite')
    try {
      const firstStore = new MagicAgentEventStore(databasePath)
      const first = new ProductionDriveRuntime({ eventStore: firstStore, deliver: vi.fn() })
      first.store.create({
        drive: { ...drive, deliveryTarget: { kind: 'agent', agentId: 'agent-1', text: 'Resume' } },
        createdAt: 1,
        idempotencyKey: 'create-restart'
      })
      first.store.claimDelivery({
        now: 10,
        leaseMs: 5,
        ownerId: 'crashed-worker',
        token: 'crashed-claim'
      })
      firstStore.close()

      const reopenedStore = new MagicAgentEventStore(databasePath)
      const runAgent = vi.fn(async () => ({
        runId: 'restart-run',
        agentId: 'agent-1',
        status: 'completed' as const,
        content: '',
        messages: [],
        toolCalls: [],
        events: [],
        createdAt: 15,
        updatedAt: 15,
        startedAt: 15,
        finishedAt: 15,
        metadata: {}
      }))
      const reopened = new ProductionDriveRuntime({
        eventStore: reopenedStore,
        deliver: createProductionDriveDelivery({ runAgent }),
        now: () => 15,
        token: () => 'recovered-claim'
      })
      expect(await reopened.scheduler.runOnce()).toBe(true)
      expect(runAgent).toHaveBeenCalledOnce()
      expect(reopened.store.get('drive-1')?.state.delivery).toMatchObject({
        attemptCount: 2,
        acknowledgedAt: 15
      })
      reopenedStore.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs durable claim through the real production runAgent adapter and acknowledges', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const runAgent = vi.fn(async () => ({
        runId: 'run-delivery',
        agentId: 'agent-1',
        status: 'completed' as const,
        content: '',
        messages: [],
        toolCalls: [],
        events: [],
        createdAt: 1,
        updatedAt: 1,
        startedAt: 1,
        finishedAt: 1,
        metadata: {}
      }))
      const runtime = new ProductionDriveRuntime({
        eventStore,
        deliver: createProductionDriveDelivery({ runAgent }),
        now: () => 10,
        token: () => 'production-claim',
        pollIntervalMs: 60_000
      })
      runtime.store.create({
        drive: {
          ...drive,
          deliveryTarget: { kind: 'agent', agentId: 'agent-1', text: 'Execute goal' }
        },
        createdAt: 1,
        idempotencyKey: 'create-production-delivery'
      })
      expect(await runtime.scheduler.runOnce()).toBe(true)
      expect(runAgent).toHaveBeenCalledOnce()
      expect(runtime.store.get('drive-1')?.state.delivery).toMatchObject({
        attemptCount: 1,
        acknowledgedAt: 10
      })
    } finally {
      eventStore.close()
    }
  })

  it('delivers an explicit agent target through the public Policy-gated runAgent path', async () => {
    const runAgent = vi.fn(
      async (_request: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformRunReq) => ({
        runId: 'run-1',
        agentId: 'agent-1',
        status: 'completed' as const,
        content: '',
        messages: [],
        toolCalls: [],
        events: [],
        createdAt: 1,
        updatedAt: 1,
        startedAt: 1,
        finishedAt: 1,
        metadata: {}
      })
    )
    const deliver = createProductionDriveDelivery({ runAgent })
    await deliver({
      kind: 'drive',
      id: 'drive-1',
      revision: 2,
      deleted: false,
      createdAt: 1,
      updatedAt: 2,
      state: {
        ...drive,
        deliveryTarget: { kind: 'agent', agentId: 'agent-1', text: 'Continue goal' }
      }
    })
    const deliveredRequest = runAgent.mock.calls[0]![0]!
    expect(readDriveTrustedDispatchContext(deliveredRequest)).toEqual({
      driveId: 'drive-1',
      driveRevision: 2,
      status: 'active',
      assigneeId: 'agent-1',
      targetAgentId: 'agent-1'
    })
    expect(JSON.parse(JSON.stringify(deliveredRequest))).toEqual({
      route: { channel: 'magicpot-drive://runtime', scopeType: 'channel', scopeId: 'drive-1' },
      agentId: 'agent-1',
      text: 'Continue goal',
      metadata: { driveId: 'drive-1', driveRevision: 2 }
    })
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        route: { channel: 'magicpot-drive://runtime', scopeType: 'channel', scopeId: 'drive-1' },
        agentId: 'agent-1',
        text: 'Continue goal',
        metadata: { driveId: 'drive-1', driveRevision: 2 }
      }),
      DRIVE_INVOCATION
    )
  })

  it('can own the command plane with delivery explicitly disabled', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const deliver = vi.fn()
      const runtime = new ProductionDriveRuntime({ eventStore, deliver, deliveryEnabled: false })
      runtime.start()
      runtime.store.create({ drive, createdAt: 1, idempotencyKey: 'create-disabled' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(deliver).not.toHaveBeenCalled()
      await runtime.stop()
    } finally {
      eventStore.close()
    }
  })

  it('owns one store/scheduler and leaves the external Event Store open', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const runtime = new ProductionDriveRuntime({
      eventStore,
      deliver: vi.fn(),
      pollIntervalMs: 60_000
    })
    runtime.start()
    runtime.start()
    await runtime.stop()
    await runtime.stop()
    runtime.store.create({ drive, createdAt: 1, idempotencyKey: 'create' })
    expect(runtime.store.get('drive-1')).toBeDefined()
    eventStore.close()
  })

  it('publishes committed create and transition state events without replay duplicates', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const events: unknown[] = []
    const unsubscribe = subscribeDriveStates((event) => events.push(event))
    try {
      const commands = new DriveCommandService(
        new ProductionDriveRuntime({ eventStore, deliver: vi.fn() })
      )
      const createInput = { drive, createdAt: 1, idempotencyKey: 'create' }
      commands.create(createInput)
      commands.create(createInput)
      const transitionInput = {
        driveId: 'drive-1',
        expectedRevision: 0,
        status: 'completed' as const,
        transitionedAt: 2,
        idempotencyKey: 'complete',
        reason: 'done'
      }
      commands.transition(transitionInput)
      commands.transition(transitionInput)
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({
        driveId: 'drive-1',
        previousStatus: 'active',
        status: 'completed',
        revision: 1
      })
    } finally {
      unsubscribe()
      clearDriveStateListenersForTest()
      eventStore.close()
    }
  })

  it('provides normalized internal commands', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const runtime = new ProductionDriveRuntime({ eventStore, deliver: vi.fn() })
      const commands = new DriveCommandService(runtime)
      const created = commands.create({ drive, createdAt: 1, idempotencyKey: 'create' })
      const progress = commands.reportProgress({
        driveId: 'drive-1',
        expectedRevision: 0,
        summary: 'Working',
        evidence: [{ kind: 'run', ref: 'run-1' }],
        reportedAt: 2,
        idempotencyKey: 'progress'
      })
      expect(progress.state.progress?.summary).toBe('Working')
      expect(commands.listDrives()).toEqual([progress])
      expect(commands.getDrive('drive-1')).toEqual(progress)
      expect(() =>
        commands.transition({
          driveId: 'drive-1',
          expectedRevision: 1,
          status: 'draft',
          transitionedAt: 2,
          idempotencyKey: 'bad'
        })
      ).toThrow(DriveCommandError)
      expect(() => commands.getDrive('')).toThrowError(
        expect.objectContaining({ code: 'invalid-command' })
      )
    } finally {
      eventStore.close()
    }
  })

  it('exposes a lifecycle singleton and stable command service', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const first = startProductionDriveLifecycle({
      eventStore,
      deliver: vi.fn(),
      pollIntervalMs: 60_000
    })
    const second = startProductionDriveLifecycle({
      eventStore,
      deliver: vi.fn(),
      pollIntervalMs: 60_000
    })
    expect(second).toBe(first)
    expect(getProductionDriveLifecycle()?.commands).toBe(first.commands)
    await closeProductionDriveLifecycle()
    expect(getProductionDriveLifecycle()).toBeUndefined()
    eventStore.close()
  })
})
