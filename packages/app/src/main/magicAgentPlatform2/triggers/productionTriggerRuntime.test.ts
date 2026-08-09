import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
import { join } from 'node:path'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import type { PersistentTriggerState } from './persistentTriggerStore'
import { DriveCommandService } from '../drives/driveCommandService'
import { ProductionDriveRuntime } from '../drives/productionDriveRuntime'
import { subscribeDriveStates } from '../drives/driveStateEvents'
import { ProductionTriggerRuntime } from './productionTriggerRuntime'

const stores: MagicAgentEventStore[] = []
afterEach(() => {
  for (const store of stores) store.close()
  stores.length = 0
})

const trigger = (target: unknown, nextFireAt = 0): PersistentTriggerState => ({
  id: `trigger-${Math.random()}`,
  type: 'schedule',
  title: 'Nightly',
  enabled: true,
  config: { target },
  schedule: { type: 'interval', intervalMs: 1000 },
  nextFireAt
})

const startupTrigger = (target: Record<string, unknown>) => ({
  id: 'startup-trigger',
  type: 'startup' as const,
  title: 'Startup trigger',
  enabled: true,
  config: { target }
})

const setup = (effect: 'allow' | 'deny') => {
  const eventStore = new MagicAgentEventStore(':memory:')
  stores.push(eventStore)
  const authorization = new MagicAgentPolicyAuthorizationService({
    store: eventStore,
    rules: [
      {
        ruleId: effect,
        priority: 1,
        effect,
        match: {
          origins: ['trigger'],
          actions: ['trigger.execute'],
          targetKinds: ['trigger'],
          actorKinds: ['system'],
          effectKinds: ['tool.invoke'],
          risks: ['high']
        },
        explanation: effect
      }
    ],
    policyVersion: 'policy-1',
    storeId: 'store-1',
    trustedApprovers: [{ kind: 'user', id: 'approver-1' }]
  })
  return { eventStore, authorization }
}

describe('production trigger runtime', () => {
  it('owns store/executor/scheduler and has idempotent start/stop', async () => {
    const { eventStore, authorization } = setup('deny')
    const runtime = new ProductionTriggerRuntime({
      eventStore,
      authorization,
      service: { runAgent: vi.fn(), runGraph: vi.fn() },
      grantProvider: vi.fn(),
      routeResolver: () => ({ trusted: true }),
      now: () => 1000,
      pollInterval: 60_000
    })
    expect(runtime.store).toBeInstanceOf(Object)
    runtime.start()
    runtime.start()
    await runtime.stop()
    await runtime.stop()
    expect(() => eventStore.listResources({ kind: 'trigger', limit: 10 })).not.toThrow()
  })

  it('dispatches due agent trigger through policy and trusted route', async () => {
    const { eventStore, authorization } = setup('allow')
    const runAgent = vi.fn(async (input) => input)
    const runtime = new ProductionTriggerRuntime({
      eventStore,
      authorization,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: vi.fn(async (request) => {
        const grant = authorization.createApprovalGrant({
          grantId: 'runtime-grant-1',
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses: 1,
          idempotencyKey: 'runtime-grant-1'
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      }),
      routeResolver: () => ({ trusted: true }),
      now: () => 1000,
      pollInterval: 60_000
    })
    runtime.store.create(trigger({ kind: 'agent-run', agentId: 'agent-1', prompt: 'p' }, 0), 0)
    await runtime.scheduler.runOnce()
    expect(runAgent).toHaveBeenCalledOnce()
  })

  it('does not dispatch denied trigger', async () => {
    const { eventStore, authorization } = setup('deny')
    const runAgent = vi.fn()
    const runtime = new ProductionTriggerRuntime({
      eventStore,
      authorization,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: vi.fn(),
      routeResolver: () => ({ trusted: true }),
      now: () => 1000
    })
    runtime.store.create(trigger({ kind: 'agent-run', agentId: 'agent-1', prompt: 'p' }, 0), 0)
    await runtime.scheduler.runOnce()
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('reclaims a claimed trigger after stop and lease expiry on restart', async () => {
    const first = setup('deny')
    let now = 100
    const firstRuntime = new ProductionTriggerRuntime({
      eventStore: first.eventStore,
      authorization: first.authorization,
      service: { runAgent: vi.fn(), runGraph: vi.fn() },
      grantProvider: vi.fn(),
      routeResolver: () => ({ trusted: true }),
      now: () => now,
      pollInterval: 60_000
    })
    firstRuntime.store.create(trigger({ kind: 'agent-run', agentId: 'a', prompt: 'p' }, 0), 0)
    await firstRuntime.scheduler.runOnce()
    await firstRuntime.stop()

    now = 40_000
    const secondRuntime = new ProductionTriggerRuntime({
      eventStore: first.eventStore,
      authorization: first.authorization,
      service: { runAgent: vi.fn(), runGraph: vi.fn() },
      grantProvider: vi.fn(),
      routeResolver: () => ({ trusted: true }),
      now: () => now,
      pollInterval: 60_000
    })
    secondRuntime.start()
    await secondRuntime.stop()
    await secondRuntime.scheduler.runOnce()
    expect(secondRuntime.store.list()).toHaveLength(1)
    expect(secondRuntime.store.list()[0].state.claim).toBeUndefined()
  })
  it('recovers a persisted claim after a real SQLite close and reopen', async () => {
    const root = resolve(`.tmp-magic-agent-runtime-recovery-${Date.now()}-${Math.random()}`)
    mkdirSync(root, { recursive: true })
    const path = join(root, 'events.db')
    let now = 100
    const firstStore = new MagicAgentEventStore(path)
    const firstAuth = new MagicAgentPolicyAuthorizationService({
      store: firstStore,
      rules: [
        {
          ruleId: 'allow',
          priority: 1,
          effect: 'allow',
          match: {
            origins: ['trigger'],
            actions: ['trigger.execute'],
            targetKinds: ['trigger'],
            actorKinds: ['system'],
            effectKinds: ['tool.invoke'],
            risks: ['high']
          },
          explanation: 'allow'
        }
      ],
      policyVersion: 'policy-1',
      storeId: 'store-1',
      trustedApprovers: [{ kind: 'user', id: 'approver-1' }]
    })
    const firstRuntime = new ProductionTriggerRuntime({
      eventStore: firstStore,
      authorization: firstAuth,
      service: { runAgent: vi.fn(), runGraph: vi.fn() },
      grantProvider: vi.fn(),
      routeResolver: () => ({ trusted: true }),
      now: () => now
    })
    firstRuntime.store.create(
      trigger({ kind: 'agent-run', agentId: 'agent-1', prompt: 'recovery' }, 0),
      0
    )
    const claimed = firstRuntime.store.claimDue(now, 'crashed-worker', 1000)
    expect(claimed?.state.claim?.claimId).toBe('crashed-worker')
    firstStore.close()

    now = 1200
    expect(existsSync(root)).toBe(true)
    expect(existsSync(`${path}.magicagent.lock-target`)).toBe(true)
    const secondStore = new MagicAgentEventStore(path)
    const secondAuth = new MagicAgentPolicyAuthorizationService({
      store: secondStore,
      rules: [
        {
          ruleId: 'allow',
          priority: 1,
          effect: 'allow',
          match: {
            origins: ['trigger'],
            actions: ['trigger.execute'],
            targetKinds: ['trigger'],
            actorKinds: ['system'],
            effectKinds: ['tool.invoke'],
            risks: ['high']
          },
          explanation: 'allow'
        }
      ],
      policyVersion: 'policy-1',
      storeId: 'store-2',
      trustedApprovers: [{ kind: 'user', id: 'approver-1' }]
    })
    const runAgent = vi.fn(async (input) => input)
    const secondRuntime = new ProductionTriggerRuntime({
      eventStore: secondStore,
      authorization: secondAuth,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: vi.fn(async (request) => {
        const grant = secondAuth.createApprovalGrant({
          grantId: 'runtime-recovery-grant',
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: now,
          expiresAt: now + 1000,
          maxUses: 1,
          idempotencyKey: 'runtime-recovery-grant'
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      }),
      routeResolver: () => ({ trusted: true }),
      now: () => now
    })
    const ran = await secondRuntime.scheduler.runOnce()
    expect(ran).toBe(true)
    expect(runAgent).toHaveBeenCalledOnce()
    expect(secondRuntime.store.list()[0].state.claim).toBeUndefined()
    secondStore.close()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('production trigger runtime manual occurrences', () => {
  it('dispatches an explicitly granted manual occurrence and records completion/outcome', async () => {
    const { eventStore, authorization } = setup('allow')
    const runAgent = vi.fn(async (input) => input)
    const runtime = new ProductionTriggerRuntime({
      eventStore,
      authorization,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: async (request) => {
        const grant = authorization.createApprovalGrant({
          grantId: `manual-${request.requestId}`,
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses: 1,
          idempotencyKey: `manual-${request.requestId}`
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      },
      routeResolver: () => ({ trusted: true }),
      now: () => 1000,
      pollInterval: 60_000
    })
    const created = runtime.store.create(
      trigger({ kind: 'agent-run', agentId: 'manual-agent', prompt: 'p' }, 9_999),
      0
    )
    runtime.occurrences.enqueueManual({
      occurrenceId: 'manual-occ-1',
      triggerId: created.id,
      scheduledAt: 1000,
      requestedAt: 1000,
      idempotencyKey: 'manual-occ-1'
    })
    await runtime.occurrenceScheduler.runOnce()
    expect(runAgent).toHaveBeenCalledOnce()
    expect(runtime.occurrences.get('manual-occ-1')?.state.status).toBe('completed')
    expect(runtime.outcomes.list().some((item) => item.state.status === 'succeeded')).toBe(true)
    await runtime.stop()
  })

  it('ticks calendar/cron on the runtime timer and stops ticking after stop', async () => {
    vi.useFakeTimers()
    try {
      const { eventStore, authorization } = setup('deny')
      let now = Date.parse('2026-01-01T00:00:00Z')
      const runtime = new ProductionTriggerRuntime({
        eventStore,
        authorization,
        service: { runAgent: vi.fn(), runGraph: vi.fn() },
        grantProvider: vi.fn(),
        routeResolver: () => ({ trusted: true }),
        now: () => now,
        pollInterval: 1_000
      })
      runtime.store.create(
        {
          id: 'timer-calendar',
          type: 'event',
          title: 'Timer calendar',
          enabled: true,
          config: {
            sourceKind: 'calendar',
            startAt: '2026-01-01T00:00:01Z',
            target: { kind: 'agent-run', agentId: 'timer-agent' }
          }
        },
        now,
        'timer-calendar-create'
      )
      runtime.start()
      expect(runtime.occurrences.list()).toHaveLength(0)
      now += 1_000
      await vi.advanceTimersByTimeAsync(1_000)
      expect(runtime.occurrences.list()).toHaveLength(1)
      await runtime.stop()
      now += 1_000
      await vi.advanceTimersByTimeAsync(1_000)
      expect(runtime.occurrences.list()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs committed Drive state through occurrence, Policy, permit, dispatch, and outcome', async () => {
    const { eventStore, authorization } = setup('allow')
    const runAgent = vi.fn(async (input) => input)
    const now = 100
    const runtime = new ProductionTriggerRuntime({
      eventStore,
      authorization,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: async (request) => {
        const grant = authorization.createApprovalGrant({
          grantId: `drive-state-grant:${request.requestId}`,
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: now,
          expiresAt: now + 1000,
          maxUses: 1,
          idempotencyKey: `drive-state-grant:${request.requestId}`
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      },
      routeResolver: () => ({ trusted: true }),
      now: () => now,
      pollInterval: 60_000
    })
    runtime.store.create(
      {
        id: 'drive-state-runtime',
        type: 'event',
        title: 'Drive complete',
        enabled: true,
        config: {
          sourceKind: 'drive-state',
          driveId: 'drive-1',
          status: 'completed',
          target: { kind: 'agent-run', agentId: 'drive-observer', prompt: 'drive completed' }
        }
      },
      0,
      'drive-state-runtime-create'
    )
    const unsubscribe = subscribeDriveStates((event) => runtime.driveStateSource.enqueue(event))
    const driveRuntime = new ProductionDriveRuntime({ eventStore, deliver: vi.fn() })
    const commands = new DriveCommandService(driveRuntime)
    commands.create({
      drive: {
        id: 'drive-1',
        title: 'Goal',
        objective: 'Ship',
        status: 'active',
        priority: 1,
        assigneeId: 'agent-1',
        links: []
      },
      createdAt: 10,
      idempotencyKey: 'create-drive'
    })
    commands.transition({
      driveId: 'drive-1',
      expectedRevision: 0,
      status: 'completed',
      transitionedAt: now,
      idempotencyKey: 'complete-drive',
      reason: 'done'
    })
    unsubscribe()
    await runtime.occurrenceScheduler.runOnce()
    expect(runAgent).toHaveBeenCalledOnce()
    expect(runtime.occurrences.list()[0]?.state).toMatchObject({
      source: 'drive-state',
      status: 'completed'
    })
    expect(runtime.outcomes.listUncertain()).toEqual([])
  })

  it('runs cron occurrence through runtime Policy, permit, dispatch, and outcome', async () => {
    const { eventStore, authorization } = setup('allow')
    const runAgent = vi.fn(async (input) => input)
    const now = Date.parse('2026-01-01T00:15:00Z')
    const runtime = new ProductionTriggerRuntime({
      eventStore,
      authorization,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: async (request) => {
        const grant = authorization.createApprovalGrant({
          grantId: `cron-grant:${request.requestId}`,
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: now,
          expiresAt: now + 1000,
          maxUses: 1,
          idempotencyKey: `cron-grant:${request.requestId}`
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      },
      routeResolver: () => ({ trusted: true }),
      now: () => now,
      pollInterval: 60_000
    })
    runtime.store.create(
      {
        id: 'cron-runtime',
        type: 'event',
        title: 'Cron runtime',
        enabled: true,
        config: {
          sourceKind: 'cron',
          cron: '*/15 * * * *',
          timeZone: 'UTC',
          startAt: '2026-01-01T00:01:00Z',
          maxCatchUpRuns: 1,
          target: { kind: 'agent-run', agentId: 'cron-agent', prompt: 'cron' }
        }
      },
      Date.parse('2026-01-01T00:00:00Z'),
      'cron-runtime-create'
    )
    runtime.start()
    await runtime.stop()
    await runtime.occurrenceScheduler.runOnce()
    expect(runAgent).toHaveBeenCalledOnce()
    expect(runtime.occurrences.list()[0]?.state).toMatchObject({
      source: 'cron',
      status: 'completed'
    })
    expect(runtime.store.get('cron-runtime')?.state.config?.['sourceCursorAt']).toBe(now)
  })

  it('runs calendar occurrence through runtime Policy, permit, dispatch, and outcome', async () => {
    const { eventStore, authorization } = setup('allow')
    const runAgent = vi.fn(async (input) => input)
    const now = Date.parse('2026-01-01T00:15:00Z')
    const runtime = new ProductionTriggerRuntime({
      eventStore,
      authorization,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: async (request) => {
        const grant = authorization.createApprovalGrant({
          grantId: `calendar-grant:${request.requestId}`,
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: now,
          expiresAt: now + 1000,
          maxUses: 1,
          idempotencyKey: `calendar-grant:${request.requestId}`
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      },
      routeResolver: () => ({ trusted: true }),
      now: () => now,
      pollInterval: 60_000
    })
    runtime.store.create(
      {
        id: 'calendar-runtime',
        type: 'event',
        title: 'Calendar runtime',
        enabled: true,
        config: {
          sourceKind: 'calendar',
          startAt: '2026-01-01T00:15:00Z',
          target: { kind: 'agent-run', agentId: 'calendar-agent', prompt: 'calendar' }
        }
      },
      Date.parse('2026-01-01T00:00:00Z'),
      'calendar-runtime-create'
    )
    runtime.start()
    await runtime.stop()
    await runtime.occurrenceScheduler.runOnce()
    expect(runAgent).toHaveBeenCalledOnce()
    expect(runtime.occurrences.list()[0]?.state).toMatchObject({
      source: 'calendar',
      status: 'completed'
    })
    expect(runtime.outcomes.list()).toEqual([
      expect.objectContaining({ state: expect.objectContaining({ status: 'succeeded' }) })
    ])
  })

  it('runs a startup occurrence through policy, permit, dispatch, and durable outcome', async () => {
    const { eventStore, authorization } = setup('allow')
    const runAgent = vi.fn(async (input) => input)
    const runtime = new ProductionTriggerRuntime({
      eventStore,
      authorization,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: async (request) => {
        const grant = authorization.createApprovalGrant({
          grantId: `g-${request.requestId}`,
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses: 1,
          idempotencyKey: `g-${request.requestId}`
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      },
      routeResolver: () => ({ trusted: true }),
      now: () => 1000,
      bootId: 'production-boot',
      pollInterval: 60_000
    })
    runtime.store.create(
      startupTrigger({ kind: 'agent-run', agentId: 'startup-agent', prompt: 'boot' }),
      0,
      'startup-production-create'
    )
    runtime.start()
    await runtime.stop()
    await runtime.occurrenceScheduler.runOnce()
    expect(runAgent).toHaveBeenCalledOnce()
    expect(runtime.occurrences.get('startup:production-boot:startup-trigger')?.state).toMatchObject(
      {
        source: 'startup',
        status: 'completed'
      }
    )
    expect(runtime.outcomes.list()).toEqual([
      expect.objectContaining({ state: expect.objectContaining({ status: 'succeeded' }) })
    ])
  })

  it('keeps startup occurrence identity stable within a boot and distinct across boots', async () => {
    const { eventStore, authorization } = setup('deny')
    const options = {
      eventStore,
      authorization,
      service: { runAgent: vi.fn(), runGraph: vi.fn() },
      grantProvider: vi.fn(),
      routeResolver: () => ({ trusted: true }),
      now: () => 1000,
      pollInterval: 60_000
    }
    const first = new ProductionTriggerRuntime({ ...options, bootId: 'boot-one' })
    first.store.create(startupTrigger({ kind: 'agent-run', agentId: 'startup-agent' }), 0)
    first.start()
    first.start()
    expect(first.occurrences.list().map((item) => item.id)).toEqual([
      'startup:boot-one:startup-trigger'
    ])
    await first.stop()

    const second = new ProductionTriggerRuntime({ ...options, bootId: 'boot-two' })
    second.start()
    expect(
      second.occurrences
        .list()
        .map((item) => item.id)
        .toSorted()
    ).toEqual(['startup:boot-one:startup-trigger', 'startup:boot-two:startup-trigger'])
    await second.stop()
  })

  it('fails a manual occurrence without a grant and does not dispatch', async () => {
    const { eventStore, authorization } = setup('allow')
    const runAgent = vi.fn()
    const runtime = new ProductionTriggerRuntime({
      eventStore,
      authorization,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: vi.fn(),
      routeResolver: () => ({ trusted: true }),
      now: () => 1000,
      pollInterval: 60_000
    })
    const created = runtime.store.create(
      trigger({ kind: 'agent-run', agentId: 'blocked-agent', prompt: 'p' }, 9_999),
      0
    )
    runtime.occurrences.enqueueManual({
      occurrenceId: 'manual-occ-2',
      triggerId: created.id,
      scheduledAt: 1000,
      requestedAt: 1000,
      idempotencyKey: 'manual-occ-2'
    })
    await runtime.occurrenceScheduler.runOnce()
    expect(runAgent).not.toHaveBeenCalled()
    const occurrence = runtime.occurrences.get('manual-occ-2')?.state
    expect(occurrence?.status).toBe('failed')
    expect(occurrence?.nextRetryAt).toBe(6000)
    expect(runtime.outcomes.list()).toHaveLength(0)
    await runtime.stop()
  })

  it('keeps same-time manual outcomes isolated', async () => {
    const { eventStore, authorization } = setup('allow')
    const runAgent = vi.fn(async (input) => input)
    const runtime = new ProductionTriggerRuntime({
      eventStore,
      authorization,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: async (request) => {
        const grant = authorization.createApprovalGrant({
          grantId: `g-${request.requestId}`,
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses: 1,
          idempotencyKey: `g-${request.requestId}`
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      },
      routeResolver: () => ({ trusted: true }),
      now: () => 1000,
      pollInterval: 60_000
    })
    const created = runtime.store.create(
      trigger({ kind: 'agent-run', agentId: 'same-time', prompt: 'p' }, 9_999),
      0
    )
    for (const id of ['manual-occ-a', 'manual-occ-b'])
      runtime.occurrences.enqueueManual({
        occurrenceId: id,
        triggerId: created.id,
        scheduledAt: 1000,
        requestedAt: 1000,
        idempotencyKey: id
      })
    await runtime.occurrenceScheduler.runOnce()
    await runtime.occurrenceScheduler.runOnce()
    expect(runAgent).toHaveBeenCalledTimes(2)
    expect(
      runtime.outcomes.list().filter((item) => item.state.status === 'succeeded')
    ).toHaveLength(2)
    await runtime.stop()
  })
})
