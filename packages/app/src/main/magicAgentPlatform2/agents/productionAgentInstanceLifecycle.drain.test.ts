import { describe, expect, it, vi } from 'vitest'
import type {
  MagicAgentPlatformRunReq,
  MagicAgentPlatformRunResp
} from '../../../shared/api/svcMagicAgentPlatform'
import { MagicAgentEventStore } from '../persistence/eventStore'
import type { MagicAgentPolicyAuthorizationService } from '../policy'
import { CooperativeExecutionController } from './cooperativeExecutionController'
import { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import {
  ProductionAgentInstanceLifecycleService,
  type AgentInstanceRunAdapter
} from './productionAgentInstanceLifecycle'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
const actor = { kind: 'user', id: 'owner' } as const
const request: MagicAgentPlatformRunReq = {
  profileId: 'local-fixture', agentId: 'agent', text: 'test',
  route: { channel: 'generic', scopeType: 'dm', scopeId: 'lifecycle-retention' }
}
const completedRun = (): MagicAgentPlatformRunResp => ({
  runId: 'local-run', agentId: 'agent', status: 'completed', content: 'done',
  messages: [], toolCalls: [], events: [], startedAt: 1, finishedAt: 2
})

// This suite owns only explicit controller registrations and the actual promise
// returned to the lifecycle. It is not a native host/SDK/effect-drainage fixture.
const fixture = (dispatch?: AgentInstanceRunAdapter) => {
  const eventStore = new MagicAgentEventStore(':memory:')
  const store = new PersistentAgentInstanceStore(eventStore)
  const wrapper = deferred<MagicAgentPlatformRunResp>()
  const raw = deferred<void>()
  let execution!: CooperativeExecutionController
  let signal!: AbortSignal
  let child: Promise<void> | undefined
  let tick = 10
  const authorization = {
    authorize: vi.fn(() => ({ status: 'authorized', permit: { permitId: 'local' } })),
    consumeExecutionPermit: vi.fn()
  }
  const runAgent = vi.fn(dispatch ?? ((_req, options) => {
    execution = options.cooperativeExecution
    signal = options.signal
    child = execution.run('tool-invocation', undefined, async () => { await raw.promise })
    // Observe rejection without replacing the original promise or its registration.
    void child.catch(() => undefined)
    return wrapper.promise
  }))
  const service = new ProductionAgentInstanceLifecycleService(
    store, authorization as unknown as MagicAgentPolicyAuthorizationService,
    runAgent, () => tick++
  )
  const add = (id: string) => store.create({
    instance: {
      id, name: id, definitionId: 'agent', depth: 0, configVersion: 'v1', status: 'created',
      limits: { maxChildren: 2, maxDepth: 2, maxConcurrency: 2, maxRuntimeMs: 1000, allowedToolNames: [], workspaceRoots: [] }
    },
    createdAt: 1, idempotencyKey: `create:${id}`
  })
  add('instance')
  const start = (key = 'start', id = 'instance') => service.start({
    instanceId: id, expectedRevision: store.get(id)!.revision,
    actor, request, idempotencyKey: key
  })
  return {
    eventStore, store, service, authorization, runAgent, wrapper, raw, add, start,
    get execution() { return execution },
    get signal() { return signal },
    get child() { return child },
    async cleanup() {
      raw.resolve(undefined)
      wrapper.resolve(completedRun())
      await flush()
      await service.close().catch(() => undefined)
      eventStore.close()
    }
  }
}

describe('CooperativeExecutionController passive drainage', () => {
  it('does not mistake resume notifications for actual drainage', async () => {
    const execution = new CooperativeExecutionController()
    const leave = execution.enter('tool-invocation')
    try {
      let finished = false
      const pending = execution.whenQuiescent().then(() => { finished = true })
      execution.resume()
      await flush()
      expect(finished).toBe(false)
      expect(execution.isQuiescent()).toBe(false)
      leave()
      await pending
      expect(execution.isPaused()).toBe(false)
    } finally { leave() }
  })

  it('neither creates nor withdraws a pause or its exact ticket', async () => {
    const execution = new CooperativeExecutionController()
    const ticket = await execution.requestPause()
    await execution.whenQuiescent()
    expect(execution.isPauseCurrent(ticket)).toBe(true)
    expect(execution.isPaused()).toBe(true)
  })

  it('rechecks active registration if new work enters before its continuation', async () => {
    const execution = new CooperativeExecutionController()
    const first = execution.enter('tool-invocation')
    let second: (() => void) | undefined
    try {
      let finished = false
      const pending = execution.whenQuiescent().then(() => { finished = true })
      first()
      second = execution.enter('assistant-turn')
      await flush()
      expect(finished).toBe(false)
      second()
      await pending
    } finally { first(); second?.() }
  })
})

describe('ProductionAgentInstanceLifecycle retained execution owner', () => {
  it.each(['fulfilled', 'rejected'] as const)('keeps a %s wrapper owned until the exact tracked child drains', async outcome => {
    const s = fixture()
    try {
      await s.start()
      if (outcome === 'fulfilled') s.wrapper.resolve(completedRun())
      else s.wrapper.reject(new Error('early wrapper rejection'))
      await flush()
      expect(s.execution.isQuiescent()).toBe(false)
      expect(s.store.get('instance')?.state.status).toBe('running')
      expect(s.service.isAtSafePoint('instance')).toBe(false)
      await expect(s.start('duplicate')).rejects.toThrow(/already active/i)
      expect(s.runAgent).toHaveBeenCalledOnce()
      s.raw.resolve(undefined)
      await s.child
      await flush()
      expect(s.store.get('instance')?.state.status).toBe('stopped')
      expect(s.service.isAtSafePoint('instance')).toBe(true)
    } finally { await s.cleanup() }
  })

  it('keeps recovery and config mutation fail-closed while a terminal owner still drains', async () => {
    const s = fixture()
    try {
      await s.start()
      s.wrapper.resolve(completedRun())
      await flush()
      const activate = vi.spyOn(s.store, 'activateStagedConfig')
      const rollback = vi.spyOn(s.store, 'rollbackConfig')
      expect(() => s.service.recoverInterrupted()).toThrow(/owns|closes/i)
      expect(() => s.service.activateStagedConfigAtSafePoint({
        instanceId: 'instance', expectedRevision: 1, activatedAt: 20, idempotencyKey: 'activate'
      })).toThrow(/safe point/i)
      expect(() => s.service.rollbackConfigAtSafePoint({
        instanceId: 'instance', expectedRevision: 1, rolledBackAt: 20, idempotencyKey: 'rollback'
      })).toThrow(/safe point/i)
      await expect(s.service.quiesceForReplacement('instance')).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' })
      expect(activate).not.toHaveBeenCalled()
      expect(rollback).not.toHaveBeenCalled()
      expect(s.store.get('instance')?.state.status).toBe('running')
    } finally { await s.cleanup() }
  })

  it('keeps a child-first execution owned until the wrapper settles too', async () => {
    const s = fixture()
    try {
      await s.start()
      s.raw.resolve(undefined)
      await s.child
      await flush()
      expect(s.execution.isQuiescent()).toBe(true)
      expect(s.store.get('instance')?.state.status).toBe('running')
      await expect(s.start('duplicate')).rejects.toThrow(/already active/i)
      expect(s.service.isAtSafePoint('instance')).toBe(false)
      s.wrapper.resolve(completedRun())
      await flush()
      expect(s.store.get('instance')?.state.status).toBe('stopped')
    } finally { await s.cleanup() }
  })

  it('preserves a live paused safe point and leaves normally finished paused state paused', async () => {
    const s = fixture()
    try {
      await s.start()
      s.raw.resolve(undefined)
      await s.child
      await s.service.pause({ instanceId: 'instance', expectedRevision: 1, actor, idempotencyKey: 'pause' })
      expect(s.service.isAtSafePoint('instance')).toBe(true)
      s.wrapper.resolve(completedRun())
      await flush()
      expect(s.store.get('instance')?.state.status).toBe('paused')
      expect(s.service.isAtSafePoint('instance')).toBe(true)
    } finally { await s.cleanup() }
  })

  it.each(['stop', 'close'] as const)('joins the retained owner during %s after prompt abort without resuming it', async action => {
    const s = fixture()
    try {
      await s.start()
      s.wrapper.resolve(completedRun())
      await flush()
      const resume = vi.spyOn(s.execution, 'resume')
      let finished = false
      const pending = (action === 'close' ? s.service.close() : s.service.stop({
        instanceId: 'instance', expectedRevision: s.store.get('instance')!.revision,
        actor, idempotencyKey: 'stop'
      })).then(() => { finished = true })
      expect(s.signal.aborted).toBe(true)
      await flush()
      expect(finished).toBe(false)
      expect(s.service.isAtSafePoint('instance')).toBe(false)
      s.raw.resolve(undefined)
      await pending
      expect(s.store.get('instance')?.state.status).toBe('stopped')
      expect(resume).not.toHaveBeenCalled()
    } finally { await s.cleanup() }
  })

  it.each(['stop', 'close'] as const)('observes late child rejection and still joins it during %s', async action => {
    const s = fixture()
    try {
      await s.start()
      s.wrapper.reject(new Error('wrapper cancelled'))
      await flush()
      let finished = false
      const pending = (action === 'close' ? s.service.close() : s.service.stop({
        instanceId: 'instance', expectedRevision: s.store.get('instance')!.revision,
        actor, idempotencyKey: 'stop'
      })).then(() => { finished = true })
      expect(s.signal.aborted).toBe(true)
      await flush()
      expect(finished).toBe(false)
      const failure = new Error('late child rejection')
      s.raw.reject(failure)
      await expect(s.child).rejects.toBe(failure)
      await pending
      expect(s.store.get('instance')?.state.status).toBe('stopped')
    } finally { await s.cleanup() }
  })

  it('publishes its exact owner before synchronous dispatch re-enters start', async () => {
    let nested: Promise<unknown> | undefined
    let calls = 0
    const s: ReturnType<typeof fixture> = fixture(() => {
      if (++calls === 1) nested = s.start('nested').catch(error => error)
      return s.wrapper.promise
    })
    try {
      await s.start()
      expect(await nested).toMatchObject({ message: expect.stringMatching(/already active/i) })
      expect(s.runAgent).toHaveBeenCalledOnce()
      expect(s.authorization.authorize).toHaveBeenCalledOnce()
    } finally { await s.cleanup() }
  })

  it('accounts for an accepted synchronous dispatch throw without losing its original error or child', async () => {
    const failure = new Error('synchronous dispatch failure')
    let execution!: CooperativeExecutionController
    const s: ReturnType<typeof fixture> = fixture((_req, options) => {
      execution = options.cooperativeExecution
      void execution.run('tool-invocation', undefined, async () => { await s.raw.promise }).catch(() => undefined)
      throw failure
    })
    try {
      await expect(s.start()).rejects.toBe(failure)
      expect(execution.isQuiescent()).toBe(false)
      expect(s.store.get('instance')?.state.status).toBe('running')
      expect(s.service.isAtSafePoint('instance')).toBe(false)
      await expect(s.start('duplicate')).rejects.toThrow(/already active/i)
      s.raw.resolve(undefined)
      await flush()
      expect(s.store.get('instance')?.state.status).toBe('stopped')
    } finally { await s.cleanup() }
  })

  it('publishes its initialized join and closing guard before synchronous close/abort re-entry', async () => {
    let closing: Promise<void> | undefined
    let signal!: AbortSignal
    const s: ReturnType<typeof fixture> = fixture((_req, options) => {
      signal = options.signal
      closing = s.service.close()
      return s.wrapper.promise
    })
    try {
      await s.start()
      expect(signal.aborted).toBe(true)
      let finished = false
      void closing!.then(() => { finished = true })
      await flush()
      expect(finished).toBe(false)
      await expect(s.start('while-closing')).rejects.toThrow(/clos/i)
      s.wrapper.resolve(completedRun())
      await closing
      await expect(s.start('after-close')).rejects.toThrow(/clos/i)
    } finally { await s.cleanup() }
  })

  it('keeps the accepted instance identity immutable after the caller changes its input', async () => {
    const s = fixture()
    try {
      const input = { instanceId: 'instance', expectedRevision: 0, actor, request, idempotencyKey: 'start' }
      await s.service.start(input)
      input.instanceId = 'caller-mutated-id'
      input.expectedRevision = 999
      s.raw.resolve(undefined)
      s.wrapper.resolve(completedRun())
      await flush()
      expect(s.store.get('instance')?.state.status).toBe('stopped')
      expect(s.service.isAtSafePoint('instance')).toBe(true)
      expect(s.store.get('caller-mutated-id')).toBeUndefined()
    } finally { await s.cleanup() }
  })

  it('does not let a delayed stop continuation stop a newer exact execution', async () => {
    const s = fixture()
    const newerWrapper = deferred<MagicAgentPlatformRunResp>()
    let newerStart: Promise<void> | undefined
    try {
      await s.start()
      const original = s.store.stop.bind(s.store)
      vi.spyOn(s.store, 'stop').mockImplementationOnce(input => {
        const result = original(input)
        // Public delayed continuation: the finalizer releases its exact owner in
        // this turn, then this queued new start runs before stop's join resumes.
        queueMicrotask(() => {
          s.runAgent.mockImplementationOnce(() => newerWrapper.promise)
          newerStart = s.start('newer')
          void newerStart.catch(() => undefined)
        })
        return result
      })
      const stopped = s.service.stop({ instanceId: 'instance', expectedRevision: 1, actor, idempotencyKey: 'old-stop' })
      s.raw.resolve(undefined)
      s.wrapper.resolve(completedRun())
      await stopped
      await newerStart
      expect(s.runAgent).toHaveBeenCalledTimes(2)
      expect(s.store.get('instance')?.state.status).toBe('running')
      expect(s.store.get('instance')?.revision).toBe(3)
      newerWrapper.resolve(completedRun())
      await flush()
      expect(s.store.get('instance')?.state.status).toBe('stopped')
    } finally { newerWrapper.resolve(completedRun()); await s.cleanup() }
  })

  it('retains the exact close promise identity while joining all work', async () => {
    const s = fixture()
    try {
      await s.start()
      const first = s.service.close()
      const second = s.service.close()
      expect(second).toBe(first)
      s.wrapper.resolve(completedRun())
      s.raw.resolve(undefined)
      await first
    } finally { await s.cleanup() }
  })

  it.each(['before', 'after'] as const)('latches a terminal publication fault %s commit without a failed-run retry or false idle', async side => {
    const s = fixture()
    const failure = new Error(`terminal publication ${side}`)
    try {
      await s.start()
      s.raw.resolve(undefined)
      await s.child
      const original = s.store.stop.bind(s.store)
      // One-shot failure keeps the old implementation from producing an unhandled
      // second failure. A forbidden second settlement would call the real method.
      const stop = vi.spyOn(s.store, 'stop').mockImplementationOnce(input => {
        if (side === 'after') original(input)
        throw failure
      })
      s.wrapper.resolve(completedRun())
      await flush()
      expect(stop).toHaveBeenCalledOnce()
      expect(s.service.isAtSafePoint('instance')).toBe(false)
      await expect(s.start('duplicate')).rejects.toThrow(/already active/i)
      await expect(s.service.close()).rejects.toBe(failure)
      expect(stop).toHaveBeenCalledOnce()
      expect(s.store.get('instance')?.state.status).toBe(side === 'after' ? 'stopped' : 'running')
    } finally { await s.cleanup() }
  })

  it('does not expose idle or admit re-entry inside terminal publication, even after its store commit', async () => {
    const s = fixture()
    let nested: Promise<unknown> | undefined
    const safe: boolean[] = []
    try {
      await s.start()
      s.raw.resolve(undefined)
      await s.child
      const original = s.store.stop.bind(s.store)
      vi.spyOn(s.store, 'stop').mockImplementationOnce(input => {
        safe.push(s.service.isAtSafePoint('instance'))
        const result = original(input)
        safe.push(s.service.isAtSafePoint('instance'))
        nested = s.start('publication-reentry').catch(error => error)
        return result
      })
      s.wrapper.resolve(completedRun())
      await flush()
      expect(safe).toEqual([false, false])
      expect(await nested).toMatchObject({ message: expect.stringMatching(/already active/i) })
      expect(s.runAgent).toHaveBeenCalledOnce()
      expect(s.service.isAtSafePoint('instance')).toBe(true)
    } finally { await s.cleanup() }
  })

  it('retains ownership if a synchronous terminal publication callout registers new tracked work', async () => {
    const s = fixture()
    let release!: () => void
    try {
      await s.start()
      s.raw.resolve(undefined)
      await s.child
      const original = s.store.stop.bind(s.store)
      vi.spyOn(s.store, 'stop').mockImplementationOnce(input => {
        const result = original(input)
        release = s.execution.enter('tool-invocation')
        return result
      })
      s.wrapper.resolve(completedRun())
      await flush()
      expect(s.execution.isQuiescent()).toBe(false)
      expect(s.service.isAtSafePoint('instance')).toBe(false)
      await expect(s.start('duplicate')).rejects.toThrow(/already active/i)
      release()
      await flush()
      expect(s.service.isAtSafePoint('instance')).toBe(true)
    } finally { release?.(); await s.cleanup() }
  })

  it('honors stop requested while a paused terminal owner is still draining publication re-entry', async () => {
    const s = fixture()
    let release!: () => void
    try {
      await s.start()
      s.raw.resolve(undefined)
      await s.child
      await s.service.pause({ instanceId: 'instance', expectedRevision: 1, actor, idempotencyKey: 'pause' })
      const originalGet = s.store.get.bind(s.store)
      let inject = true
      vi.spyOn(s.store, 'get').mockImplementation(id => {
        const result = originalGet(id)
        if (id === 'instance' && inject) {
          inject = false
          // Synthetic already-paused tracked work, using actual registration.
          // Public enter stays forbidden. Exercise finalizer revalidation only.
          expect(() => s.execution.enter('tool-invocation')).toThrow(
            expect.objectContaining({ code: 'COOPERATIVE_EXECUTION_PAUSED' })
          )
          release = Reflect.apply(Reflect.get(s.execution, 'registerActive'), s.execution, ['tool-invocation']) as () => void
        }
        return result
      })
      s.wrapper.resolve(completedRun())
      await flush()
      expect(s.service.isAtSafePoint('instance')).toBe(false)
      const stopping = s.service.stop({ instanceId: 'instance', expectedRevision: 2, actor, idempotencyKey: 'stop-paused-tail' })
      expect(s.signal.aborted).toBe(true)
      release()
      await stopping
      expect(s.store.get('instance')?.state.status).toBe('stopped')
    } finally { release?.(); await s.cleanup() }
  })

  it.each(['before', 'after'] as const)('keeps an ambiguous accepted-start write fault %s commit owned without dispatch or retry', async side => {
    const s = fixture()
    const failure = new Error(`start write ${side}`)
    const original = s.store.start.bind(s.store)
    try {
      const start = vi.spyOn(s.store, 'start').mockImplementationOnce(input => {
        if (side === 'after') original(input)
        throw failure
      })
      await expect(s.start()).rejects.toBe(failure)
      expect(s.runAgent).not.toHaveBeenCalled()
      expect(s.service.isAtSafePoint('instance')).toBe(false)
      await expect(s.start('duplicate')).rejects.toThrow(/already active/i)
      await expect(s.service.close()).rejects.toBe(failure)
      expect(start).toHaveBeenCalledOnce()
      expect(s.store.get('instance')?.state.status).toBe(side === 'after' ? 'running' : 'created')
    } finally { await s.cleanup() }
  })

  it('keeps fault-reporting close pending when failed publication introduced another tracked registration', async () => {
    const s = fixture()
    const failure = new Error('publication failed with tracked work still active')
    let release!: () => void
    try {
      await s.start()
      s.raw.resolve(undefined)
      await s.child
      vi.spyOn(s.store, 'stop').mockImplementationOnce(() => {
        release = s.execution.enter('tool-invocation')
        throw failure
      })
      s.wrapper.resolve(completedRun())
      await flush()
      let finished = false
      const closing = s.service.close().then(
        () => { finished = true; return undefined },
        error => { finished = true; return error }
      )
      await flush()
      expect(s.execution.isQuiescent()).toBe(false)
      expect(finished).toBe(false)
      release()
      expect(await closing).toBe(failure)
      expect(s.service.isAtSafePoint('instance')).toBe(false)
    } finally { release?.(); await s.cleanup() }
  })

  it.each(['stop', 'close'] as const)('still joins work registered by %s abort after the owner fault was already reported', async action => {
    const s = fixture()
    const fault = new Error('already reported terminal publication fault')
    let release: (() => void) | undefined
    try {
      await s.start()
      s.raw.resolve(undefined)
      await s.child
      vi.spyOn(s.store, 'stop').mockImplementationOnce(() => { throw fault })
      s.wrapper.resolve(completedRun())
      await flush()
      s.signal.addEventListener('abort', () => { release = s.execution.enter('tool-invocation') }, { once: true })
      let finished = false
      const joined = (action === 'close' ? s.service.close() : s.service.stop({
        instanceId: 'instance', expectedRevision: 1, actor, idempotencyKey: 'stop-fault'
      })).then(
        () => { finished = true; return undefined },
        error => { finished = true; return error }
      )
      expect(s.signal.aborted).toBe(true)
      await flush()
      expect(s.execution.isQuiescent()).toBe(false)
      expect(finished).toBe(false)
      release!()
      expect(await joined).toBe(fault)
      expect(s.service.isAtSafePoint('instance')).toBe(false)
    } finally { release?.(); await s.cleanup() }
  })

  it('reports close faults in owner insertion order after all owners drain, not failure completion order', async () => {
    const s = fixture()
    const firstFailure = new Error('first accepted owner failed publication')
    const secondFailure = new Error('second accepted owner failed earlier')
    const secondWrapper = deferred<MagicAgentPlatformRunResp>()
    try {
      await s.start()
      s.add('second')
      s.runAgent.mockImplementationOnce(() => secondWrapper.promise)
      await s.start('second-start', 'second')
      vi.spyOn(s.store, 'stop').mockImplementation(input => {
        throw input.instanceId === 'instance' ? firstFailure : secondFailure
      })
      let finished = false
      const closing = s.service.close().then(
        () => { finished = true; return undefined },
        error => { finished = true; return error }
      )
      secondWrapper.resolve(completedRun())
      await flush()
      expect(finished).toBe(false)
      s.wrapper.resolve(completedRun())
      s.raw.resolve(undefined)
      expect(await closing).toBe(firstFailure)
      expect(s.service.isAtSafePoint('instance')).toBe(false)
      expect(s.service.isAtSafePoint('second')).toBe(false)
    } finally { secondWrapper.resolve(completedRun()); await s.cleanup() }
  })

  it('waits for other owners before reporting the first close publication failure', async () => {
    const s = fixture()
    const failure = new Error('first owner publication failed')
    const secondWrapper = deferred<MagicAgentPlatformRunResp>()
    const secondRaw = deferred<void>()
    let secondSignal!: AbortSignal
    try {
      await s.start()
      s.add('second')
      s.runAgent.mockImplementationOnce((_req, options) => {
        secondSignal = options.signal
        void options.cooperativeExecution.run('tool-invocation', undefined, async () => {
          await secondRaw.promise
        }).catch(() => undefined)
        return secondWrapper.promise
      })
      await s.start('start-second', 'second')
      const original = s.store.stop.bind(s.store)
      vi.spyOn(s.store, 'stop').mockImplementation(input => {
        if (input.instanceId === 'instance') throw failure
        return original(input)
      })
      let finished = false
      const closing = s.service.close().then(
        () => { finished = true; return undefined },
        error => { finished = true; return error }
      )
      expect(secondSignal.aborted).toBe(true)
      s.raw.resolve(undefined)
      s.wrapper.resolve(completedRun())
      secondWrapper.resolve(completedRun())
      await flush()
      expect(finished).toBe(false)
      secondRaw.resolve(undefined)
      expect(await closing).toBe(failure)
      expect(s.store.get('second')?.state.status).toBe('stopped')
    } finally {
      secondWrapper.resolve(completedRun())
      secondRaw.resolve(undefined)
      await s.cleanup()
    }
  })
})
