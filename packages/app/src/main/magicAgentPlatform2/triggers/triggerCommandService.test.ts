import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { TriggerCommandError, TriggerCommandService } from './triggerCommandService'

const makeRuntime = (enabled = true) => {
  const trigger = { id: 'trigger-1', revision: 3, state: { id: 'trigger-1', enabled } }
  const store = {
    list: vi.fn(() => [trigger]),
    get: vi.fn(() => trigger),
    setEnabled: vi.fn((input) => ({
      ...trigger,
      state: { ...trigger.state, enabled: input.enabled },
      revision: input.expectedRevision + 1
    })),
    setPaused: vi.fn((input) => ({
      ...trigger,
      state: { ...trigger.state, paused: input.paused },
      revision: input.expectedRevision + 1
    })),
    retry: vi.fn((input) => ({ ...trigger, revision: input.expectedRevision + 1 })),
    create: vi.fn((state) => ({ kind: 'trigger', id: state.id, revision: 0, state })),
    update: vi.fn((input) => ({
      ...trigger,
      revision: input.expectedRevision + 1,
      state: { ...trigger.state, ...input.patch }
    }))
  }
  const occurrences = {
    enqueueManual: vi.fn((input) => ({
      id: input.occurrenceId,
      revision: 0,
      state: { ...input, status: 'pending' }
    }))
  }
  return { runtime: { store, occurrences } as never, store, occurrences, trigger }
}
const command = (patch: Record<string, unknown> = {}) => ({
  triggerId: 'trigger-1',
  expectedTriggerRevision: 3,
  occurrenceId: 'occ-1',
  requestedAt: 1000,
  idempotencyKey: 'idem-1',
  ...patch
})

describe('TriggerCommandService', () => {
  it('lists and gets triggers', () => {
    const { runtime, store, trigger } = makeRuntime()
    const service = new TriggerCommandService(runtime)
    expect(service.listTriggers()).toEqual([trigger])
    expect(service.getTrigger('trigger-1')).toBe(trigger)
    expect(store.list).toHaveBeenCalledOnce()
  })
  it('enqueues manual fire without dispatching', () => {
    const { runtime, occurrences } = makeRuntime()
    const service = new TriggerCommandService(runtime)
    const result = service.manualFire(command())
    expect(result.state.status).toBe('pending')
    expect(occurrences.enqueueManual).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: 1000 })
    )
    expect(runtime).not.toHaveProperty('dispatch')
  })
  it('replays idempotently and propagates occurrence conflicts', () => {
    const first = makeRuntime()
    const resource = { id: 'occ-1', revision: 0, state: { status: 'pending' } }
    first.occurrences.enqueueManual.mockReturnValueOnce(resource).mockImplementationOnce(() => {
      throw new TriggerCommandError('revision-conflict', 'Occurrence idempotency conflict.')
    })
    const service = new TriggerCommandService(first.runtime)
    expect(service.manualFire(command())).toBe(resource)
    expect(() => service.manualFire(command({ occurrenceId: 'occ-2' }))).toThrow(
      TriggerCommandError
    )
  })
  it('rejects a missing trigger', () => {
    const base = makeRuntime()
    const service = new TriggerCommandService({
      store: { get: vi.fn(() => undefined), list: vi.fn(() => []) },
      occurrences: base.occurrences
    } as never)
    expect(() => service.manualFire(command())).toThrowError(
      expect.objectContaining({ code: 'not-found' })
    )
  })
  it('rejects a revision mismatch', () => {
    const { runtime } = makeRuntime()
    const service = new TriggerCommandService(runtime)
    expect(() => service.manualFire(command({ expectedTriggerRevision: 4 }))).toThrowError(
      expect.objectContaining({ code: 'revision-conflict' })
    )
  })
  it('rejects a disabled trigger', () => {
    const { runtime } = makeRuntime(false)
    const service = new TriggerCommandService(runtime)
    expect(() => service.manualFire(command())).toThrowError(
      expect.objectContaining({ code: 'invalid-state' })
    )
  })
  it('rejects null, arrays, malformed revisions, and timestamps', () => {
    const { runtime: value } = makeRuntime()
    const service = new TriggerCommandService(value)
    for (const input of [
      null,
      [],
      { ...command(), expectedTriggerRevision: -1 },
      { ...command(), expectedTriggerRevision: '3' },
      { ...command(), requestedAt: -1 }
    ])
      expect(() => service.manualFire(input as never)).toThrow(TriggerCommandError)
  })

  it('maps update exactly without dispatching', () => {
    const { runtime, store } = makeRuntime()
    const service = new TriggerCommandService(runtime)
    const patch = { title: 'Updated', enabled: false, config: { safe: true } }
    service.update({
      triggerId: 'trigger-1',
      expectedTriggerRevision: 3,
      idempotencyKey: 'update-1',
      requestedAt: 20,
      patch
    })
    expect(store.update).toHaveBeenCalledWith({
      triggerId: 'trigger-1',
      expectedRevision: 3,
      idempotencyKey: 'update-1',
      updatedAt: 20,
      patch
    })
    expect(runtime).not.toHaveProperty('dispatch')
  })
  it('rejects update authority fields and invalid patches', () => {
    const { runtime } = makeRuntime()
    const service = new TriggerCommandService(runtime)
    expect(() => service.update({ ...command(), patch: { schedule: {} } } as never)).toThrowError(
      expect.objectContaining({ code: 'invalid-command' })
    )
    expect(() => service.update({ ...command(), patch: { title: '' } } as never)).toThrowError(
      expect.objectContaining({ code: 'invalid-command' })
    )
    expect(() => service.update({ ...command(), patch: { config: null } } as never)).toThrowError(
      expect.objectContaining({ code: 'invalid-command' })
    )
  })
  it('replays update through the real store after a later control mutation', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const store = new PersistentTriggerStore(eventStore)
    const created = store.create(
      {
        id: 'update-real',
        type: 'schedule',
        title: 'Old',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 100 },
        nextFireAt: 100
      },
      0
    )
    const service = new TriggerCommandService({ store, occurrences: {} } as never)
    const patch = { title: 'New', config: { safe: true } }
    const first = service.update({
      triggerId: 'update-real',
      expectedTriggerRevision: created.revision,
      idempotencyKey: 'update-real-1',
      requestedAt: 10,
      patch
    })
    service.pause({
      triggerId: 'update-real',
      expectedTriggerRevision: first.revision,
      idempotencyKey: 'pause-real-1',
      requestedAt: 20
    })
    expect(
      service.update({
        triggerId: 'update-real',
        expectedTriggerRevision: created.revision,
        idempotencyKey: 'update-real-1',
        requestedAt: 10,
        patch
      })
    ).toEqual(first)
    expect(store.get('update-real')?.revision).toBe(2)
    eventStore.close()
  })
  it('maps update store errors', () => {
    const { runtime, store } = makeRuntime()
    store.update.mockImplementationOnce(() => {
      throw new Error('Trigger revision conflict.')
    })
    const service = new TriggerCommandService(runtime)
    expect(() =>
      service.update({
        triggerId: 'trigger-1',
        expectedTriggerRevision: 3,
        idempotencyKey: 'x',
        requestedAt: 1,
        patch: { title: 'x' }
      })
    ).toThrowError(expect.objectContaining({ code: 'revision-conflict' }))
  })

  it('maps enable and disable commands exactly', () => {
    const { runtime, store } = makeRuntime()
    const service = new TriggerCommandService(runtime)
    service.enable({
      triggerId: 'trigger-1',
      expectedTriggerRevision: 3,
      idempotencyKey: 'enable',
      requestedAt: 10
    })
    service.disable({
      triggerId: 'trigger-1',
      expectedTriggerRevision: 3,
      idempotencyKey: 'disable',
      requestedAt: 11
    })
    expect(store.setEnabled).toHaveBeenNthCalledWith(1, {
      triggerId: 'trigger-1',
      enabled: true,
      expectedRevision: 3,
      idempotencyKey: 'enable',
      changedAt: 10
    })
    expect(store.setEnabled).toHaveBeenNthCalledWith(2, {
      triggerId: 'trigger-1',
      enabled: false,
      expectedRevision: 3,
      idempotencyKey: 'disable',
      changedAt: 11
    })
  })
  it('maps pause and resume commands exactly', () => {
    const { runtime, store } = makeRuntime()
    const service = new TriggerCommandService(runtime)
    service.pause({
      triggerId: 'trigger-1',
      expectedTriggerRevision: 3,
      idempotencyKey: 'pause',
      requestedAt: 10
    })
    service.resume({
      triggerId: 'trigger-1',
      expectedTriggerRevision: 3,
      idempotencyKey: 'resume',
      requestedAt: 11
    })
    expect(store.setPaused).toHaveBeenCalledWith({
      triggerId: 'trigger-1',
      paused: false,
      expectedRevision: 3,
      idempotencyKey: 'resume',
      changedAt: 11
    })
  })
  it('maps retry and rejects authority/control validation', () => {
    const { runtime, store } = makeRuntime()
    const service = new TriggerCommandService(runtime)
    service.retry({
      triggerId: 'trigger-1',
      expectedTriggerRevision: 3,
      idempotencyKey: 'retry',
      requestedAt: 10
    })
    expect(store.retry).toHaveBeenCalledWith({
      triggerId: 'trigger-1',
      expectedRevision: 3,
      idempotencyKey: 'retry',
      requestedAt: 10
    })
    expect(() =>
      service.pause({
        triggerId: 'trigger-1',
        expectedTriggerRevision: 3,
        idempotencyKey: 'x',
        requestedAt: 10,
        permit: true
      } as never)
    ).toThrow(/Unknown command field/)
  })
  it('maps store errors to stable command errors', () => {
    const { runtime, store } = makeRuntime()
    store.setEnabled
      .mockImplementationOnce(() => {
        throw new Error('Trigger not found.')
      })
      .mockImplementationOnce(() => {
        throw new Error('Trigger revision conflict.')
      })
      .mockImplementationOnce(() => {
        throw new Error('idempotency key conflicts')
      })
    const service = new TriggerCommandService(runtime)
    expect(() =>
      service.enable({
        triggerId: 'trigger-1',
        expectedTriggerRevision: 3,
        idempotencyKey: 'a',
        requestedAt: 1
      })
    ).toThrowError(expect.objectContaining({ code: 'not-found' }))
    expect(() =>
      service.enable({
        triggerId: 'trigger-1',
        expectedTriggerRevision: 3,
        idempotencyKey: 'b',
        requestedAt: 2
      })
    ).toThrowError(expect.objectContaining({ code: 'revision-conflict' }))
    expect(() =>
      service.enable({
        triggerId: 'trigger-1',
        expectedTriggerRevision: 3,
        idempotencyKey: 'c',
        requestedAt: 3
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
  })
  it('replays a real store control mutation after a later mutation', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const store = new PersistentTriggerStore(eventStore)
    const trigger = {
      id: 'real',
      type: 'schedule' as const,
      title: 'real',
      enabled: true,
      schedule: { type: 'interval' as const, intervalMs: 100 },
      nextFireAt: 100
    }
    const first = store.create(trigger, 0)
    const service = new TriggerCommandService({ store, occurrences: {} } as never)
    const paused = service.pause({
      triggerId: 'real',
      expectedTriggerRevision: first.revision,
      idempotencyKey: 'real-pause',
      requestedAt: 10
    })
    service.resume({
      triggerId: 'real',
      expectedTriggerRevision: paused.revision,
      idempotencyKey: 'real-resume',
      requestedAt: 20
    })
    expect(
      service.pause({
        triggerId: 'real',
        expectedTriggerRevision: first.revision,
        idempotencyKey: 'real-pause',
        requestedAt: 10
      })
    ).toEqual(paused)
    expect(store.get('real')?.revision).toBe(2)
    eventStore.close()
  })

  it('rejects authority injection fields and invalid digest', () => {
    const { runtime: value } = makeRuntime()
    const service = new TriggerCommandService(value)
    expect(() => service.manualFire({ ...command(), permit: 'x' } as never)).toThrow(
      /Unknown command field/
    )
    expect(() => service.manualFire(command({ payloadDigest: 'not-hex' }))).toThrow()
    expect(() => service.manualFire(command({ payloadDigest: 'a'.repeat(64) }))).not.toThrow()
  })

  it('maps a validated create command without dispatching', () => {
    const setup = makeRuntime()
    const service = new TriggerCommandService(setup.runtime)
    const trigger = {
      id: 'created-trigger',
      type: 'schedule',
      title: 'Created trigger',
      enabled: true,
      config: {
        executionTarget: { type: 'agent-run', agentId: 'agent-1', prompt: 'private' }
      }
    }
    service.createTrigger({
      trigger,
      schedule: { type: 'interval', intervalMs: 60_000, missedRunPolicy: 'run-once' },
      nextFireAt: 2_000,
      createdAt: 1_000,
      idempotencyKey: 'create-command'
    })
    expect(setup.store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ...trigger,
        schedule: { type: 'interval', intervalMs: 60_000, missedRunPolicy: 'run-once' },
        nextFireAt: 2_000,
        paused: false
      }),
      1_000,
      'create-command'
    )
    expect(setup.occurrences.enqueueManual).not.toHaveBeenCalled()
  })

  it.each([
    [
      { id: '', type: 'schedule', title: 'Bad', enabled: true },
      { type: 'interval', intervalMs: 10 },
      20,
      10
    ],
    [
      { id: 'bad-type', type: 'manual', title: 'Bad', enabled: true },
      { type: 'interval', intervalMs: 10 },
      20,
      10
    ],
    [
      { id: 'bad-schedule', type: 'schedule', title: 'Bad', enabled: true },
      { type: 'cron', intervalMs: 10 },
      20,
      10
    ],
    [
      { id: 'bad-interval', type: 'schedule', title: 'Bad', enabled: true },
      { type: 'interval', intervalMs: 0 },
      20,
      10
    ],
    [
      { id: 'bad-catch-up', type: 'schedule', title: 'Bad', enabled: true },
      { type: 'interval', intervalMs: 10, missedRunPolicy: 'catch-up', maxCatchUpRuns: 0 },
      20,
      10
    ],
    [
      { id: 'bad-time', type: 'schedule', title: 'Bad', enabled: true },
      { type: 'interval', intervalMs: 10 },
      9,
      10
    ]
  ])(
    'rejects invalid create trigger, schedule, and cursor inputs',
    (trigger, schedule, nextFireAt, createdAt) => {
      const { runtime } = makeRuntime()
      const service = new TriggerCommandService(runtime)
      expect(() =>
        service.createTrigger({
          trigger,
          schedule,
          nextFireAt,
          createdAt,
          idempotencyKey: 'invalid-create'
        })
      ).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
    }
  )

  it('rejects create authority injection fields', () => {
    const { runtime } = makeRuntime()
    const service = new TriggerCommandService(runtime)
    expect(() =>
      service.createTrigger({
        trigger: { id: 'authority', type: 'schedule', title: 'Authority', enabled: true },
        schedule: { type: 'interval', intervalMs: 10 },
        nextFireAt: 20,
        createdAt: 10,
        idempotencyKey: 'authority-create',
        permit: 'external'
      } as never)
    ).toThrow(/Unknown command field/)
  })

  it.each([
    [{ sourceKind: 'drive-state' }],
    [{ sourceKind: 'drive-state', driveId: '' }],
    [{ sourceKind: 'drive-state', status: 'unknown' }]
  ])('rejects invalid drive-state source config', (config) => {
    const service = new TriggerCommandService(makeRuntime().runtime)
    expect(() =>
      service.createTrigger({
        trigger: {
          id: 'invalid-drive-state',
          type: 'event',
          title: 'Invalid Drive',
          enabled: true,
          config: { ...config, target: { kind: 'agent-run', agentId: 'agent-1' } }
        },
        createdAt: 0,
        idempotencyKey: 'invalid-drive-state'
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
  })

  it.each([
    [{ sourceKind: 'cron', cron: '0 0 L * *' }],
    [{ sourceKind: 'cron', cron: '0 9 * * *', timeZone: 'Not/AZone' }],
    [{ sourceKind: 'cron', cron: '0 9 * * *', maxCatchUpRuns: 0 }]
  ])('rejects invalid calendar/cron source config', (config) => {
    const { runtime } = makeRuntime()
    const service = new TriggerCommandService(runtime)
    expect(() =>
      service.createTrigger({
        trigger: {
          id: 'invalid-calendar-cron',
          type: 'event',
          title: 'Invalid',
          enabled: true,
          config
        },
        createdAt: 1,
        idempotencyKey: 'invalid-calendar-cron'
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
  })

  it('creates a startup Trigger without interval sentinel fields', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentTriggerStore(eventStore)
      const service = new TriggerCommandService({
        store,
        occurrences: { enqueueManual: vi.fn() }
      } as never)
      const created = service.createTrigger({
        trigger: {
          id: 'startup-create',
          type: 'startup',
          title: 'Startup create',
          enabled: true,
          config: {
            executionTarget: { type: 'agent-run', agentId: 'agent-1', prompt: 'private' }
          }
        },
        createdAt: 10,
        idempotencyKey: 'startup-create-key'
      })
      expect(created.state).toMatchObject({
        id: 'startup-create',
        type: 'startup',
        paused: false
      })
      expect(created.state).not.toHaveProperty('schedule')
      expect(created.state).not.toHaveProperty('nextFireAt')
      expect(
        service.createTrigger({
          trigger: {
            id: 'startup-create',
            type: 'startup',
            title: 'Startup create',
            enabled: true,
            config: {
              executionTarget: { type: 'agent-run', agentId: 'agent-1', prompt: 'private' }
            }
          },
          createdAt: 10,
          idempotencyKey: 'startup-create-key'
        })
      ).toEqual(created)
    } finally {
      eventStore.close()
    }
  })

  it('replays a real create command and rejects changed semantics or caller', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const store = new PersistentTriggerStore(eventStore)
      const occurrences = { enqueueManual: vi.fn() }
      const service = new TriggerCommandService({ store, occurrences } as never)
      const command = {
        trigger: {
          id: 'real-create',
          type: 'schedule',
          title: 'Real create',
          enabled: true,
          config: {
            executionTarget: { type: 'agent-run', agentId: 'agent-1', prompt: 'private' }
          }
        },
        schedule: { type: 'interval', intervalMs: 100, missedRunPolicy: 'skip' },
        nextFireAt: 100,
        createdAt: 10,
        idempotencyKey: 'real-create-key'
      } as const
      const first = service.createTrigger(command)
      expect(service.createTrigger(command)).toEqual(first)
      expect(() =>
        service.createTrigger({
          ...command,
          trigger: { ...command.trigger, title: 'Changed' }
        })
      ).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
      expect(() =>
        service.createTrigger({ ...command, idempotencyKey: 'different-caller' })
      ).toThrowError(expect.objectContaining({ code: 'invalid-command' }))
      expect(occurrences.enqueueManual).not.toHaveBeenCalled()
    } finally {
      eventStore.close()
    }
  })
})
