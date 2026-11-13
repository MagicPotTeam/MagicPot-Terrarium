import { describe, expect, it, vi } from 'vitest'
import type { MagicAgentPlatformRunResp } from '../../../shared/api/svcMagicAgentPlatform'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { _crashTesting } from '../persistence/crashHooks'
import type { MagicAgentPolicyAuthorizationService } from '../policy'
import { AgentInstanceCommandService } from './agentInstanceCommandService'
import {
  createMagicAgentConfigContent,
  PersistentAgentConfigStore
} from './persistentAgentConfigStore'
import { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import {
  ProductionAgentInstanceLifecycleService,
  type AgentInstanceRunAdapter
} from './productionAgentInstanceLifecycle'
import type { CooperativeExecutionController } from './cooperativeExecutionController'

const actor = { kind: 'user', id: 'owner' } as const
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve() }
const response = (): MagicAgentPlatformRunResp => ({
  runId: 'replacement-local-run', agentId: 'old-definition', status: 'completed',
  content: 'local', messages: [], toolCalls: [], events: [], startedAt: 1, finishedAt: 2
})

// Only explicit local MAIN lifecycle/controller/store/command boundaries. No
// supplier, SDK/host effect recovery, renderer permission or team admission proof.
const setup = async (active = true) => {
  const events = new MagicAgentEventStore(':memory:')
  const store = new PersistentAgentInstanceStore(events)
  const configs = new PersistentAgentConfigStore(events)
  const wrapper = deferred<MagicAgentPlatformRunResp>()
  let execution!: CooperativeExecutionController
  let signal!: AbortSignal
  let now = 10
  const authorize = vi.fn(() => ({ status: 'authorized', permit: {} }))
  const consumeExecutionPermit = vi.fn()
  const runAgent = vi.fn<AgentInstanceRunAdapter>((_request, options) => {
    execution = options.cooperativeExecution
    signal = options.signal
    return wrapper.promise
  })
  const lifecycle = new ProductionAgentInstanceLifecycleService(
    store, { authorize, consumeExecutionPermit } as unknown as MagicAgentPolicyAuthorizationService,
    runAgent, () => now
  )
  const commands = new AgentInstanceCommandService(store, lifecycle, configs)
  const instance = store.create({
    instance: {
      id: 'stable-instance', name: 'old', definitionId: 'old-definition', configVersion: 'v1',
      depth: 0, status: 'created',
      limits: { maxChildren: 0, maxDepth: 0, maxConcurrency: 1, maxRuntimeMs: 1000, allowedToolNames: [], workspaceRoots: [] }
    }, createdAt: 1, idempotencyKey: 'create'
  })
  configs.create({
    config: createMagicAgentConfigContent({
      version: 'v2', definitionId: 'new-definition', model: { profileId: 'local-fixture' },
      systemPrompt: 'local', inference: {}, tools: { allowedToolNames: [] },
      memory: { allowHistory: false, contextMessageLimit: 0, scope: 'session' },
      policy: { policyIds: [], workspaceRoots: [] }, channels: { channelIds: [] },
      budgets: { maxRuntimeMs: 1000 }, createdAt: 2, createdBy: actor
    }), idempotencyKey: 'config'
  })
  const start = () => lifecycle.start({
    instanceId: instance.id, expectedRevision: store.get(instance.id)!.revision, actor,
    request: { text: 'local', route: { channel: 'generic', scopeType: 'dm', scopeId: 'replacement' } },
    idempotencyKey: 'start'
  })
  if (active) await start()
  const input = () => ({
    actor, instanceId: instance.id, expectedRevision: store.get(instance.id)!.revision,
    definitionId: 'new-definition', name: 'new', configVersion: 'v2', replacedAt: 20,
    idempotencyKey: 'replace'
  })
  return {
    events, store, configs, commands, lifecycle, wrapper, runAgent, authorize,
    consumeExecutionPermit, start, input, id: instance.id,
    setNow(value: number) { now = value },
    get execution() { return execution }, get signal() { return signal },
    async cleanup() {
      wrapper.resolve(response())
      await flush()
      await lifecycle.close().catch(() => undefined)
      events.close()
    }
  }
}

describe('Agent replacement exact pause through synchronous commit', () => {
  it.each(['resume', 'resume-repause'] as const)('rejects %s after durable quiesce returned without any revision change', async action => {
    const s = await setup()
    try {
      const pause = s.store.pause.bind(s.store)
      let revisionAtPause: number | undefined
      vi.spyOn(s.store, 'pause').mockImplementationOnce(input => {
        const result = pause(input)
        revisionAtPause = result.revision
        queueMicrotask(() => {
          s.lifecycle.resumeCooperativeExecution(s.id)
          if (action === 'resume-repause') void s.execution.requestPause()
        })
        return result
      })
      const replace = vi.spyOn(s.store, 'replace')
      await expect(s.commands.replace(s.input())).rejects.toThrow(/pause.*no longer current|superseded/i)
      expect(s.store.get(s.id)?.revision).toBe(revisionAtPause)
      expect(s.store.get(s.id)?.state).toMatchObject({ status: 'paused', definitionId: 'old-definition', configVersion: 'v1' })
      expect(replace).not.toHaveBeenCalled()
      expect(s.runAgent).toHaveBeenCalledOnce()
      expect(s.execution.isPaused()).toBe(action === 'resume-repause')
    } finally { await s.cleanup() }
  })

  it('keeps the authorized replacement input stable when its caller mutates fields during pause', async () => {
    const s = await setup()
    try {
      const input = s.input()
      const original = { ...input }
      const pause = s.store.pause.bind(s.store)
      vi.spyOn(s.store, 'pause').mockImplementationOnce(command => {
        const result = pause(command)
        queueMicrotask(() => {
          input.name = 'caller-changed-name'
          input.definitionId = 'caller-changed-definition'
          input.configVersion = 'unapproved-version'
          input.idempotencyKey = 'caller-changed-operation'
        })
        return result
      })
      const result = await s.commands.replace(input)
      expect(result.state).toMatchObject({
        name: original.name, definitionId: original.definitionId,
        configVersion: original.configVersion
      })
      expect(s.store.getReplaceReplay(s.id, original.idempotencyKey)).toBeDefined()
      expect(s.store.getReplaceReplay(s.id, input.idempotencyKey)).toBeUndefined()
    } finally { await s.cleanup() }
  })

  it('rejects an already-paused read continuation after resume and a distinct new pause without revision change', async () => {
    const s = await setup()
    try {
      await s.lifecycle.quiesceForReplacement(s.id)
      const get = s.store.get.bind(s.store)
      let pausedReads = 0
      vi.spyOn(s.store, 'get').mockImplementation(id => {
        const result = get(id)
        // Command first reads the resource, preparation next reads it, then the
        // awaited pause path reads its drained resource immediately before return.
        if (id === s.id && result?.state.status === 'paused' && ++pausedReads === 3) {
          queueMicrotask(() => {
            s.lifecycle.resumeCooperativeExecution(s.id)
            void s.execution.requestPause()
          })
        }
        return result
      })
      const input = { actor, instanceId: s.id, expectedRevision: 2, definitionId: 'new-definition', name: 'new', configVersion: 'v2', replacedAt: 20, idempotencyKey: 'replace-paused' }
      const replace = vi.spyOn(s.store, 'replace')
      await expect(s.commands.replace(input)).rejects.toThrow(/pause.*no longer current|superseded/i)
      expect(pausedReads).toBeGreaterThanOrEqual(3)
      expect(s.store.get(s.id)?.revision).toBe(2)
      expect(s.execution.isPaused()).toBe(true)
      expect(replace).not.toHaveBeenCalled()
    } finally { await s.cleanup() }
  })

  it.each(['stop', 'close'] as const)('rejects %s begun between durable pause return and the replacement commit', async action => {
    const s = await setup()
    let stopping: Promise<void> | undefined
    try {
      const pause = s.store.pause.bind(s.store)
      vi.spyOn(s.store, 'pause').mockImplementationOnce(input => {
        const result = pause(input)
        queueMicrotask(() => {
          stopping = action === 'close' ? s.lifecycle.close() : s.lifecycle.stop({
            actor, instanceId: s.id, expectedRevision: result.revision, idempotencyKey: 'stop-during-replacement'
          })
        })
        return result
      })
      const replace = vi.spyOn(s.store, 'replace')
      await expect(s.commands.replace(s.input())).rejects.toThrow(/pause.*no longer current|superseded/i)
      expect(s.signal.aborted).toBe(true)
      expect(replace).not.toHaveBeenCalled()
      expect(s.store.get(s.id)?.state.definitionId).toBe('old-definition')
      let joined = false
      void stopping!.then(() => { joined = true })
      await flush()
      expect(joined).toBe(false)
      s.wrapper.resolve(response())
      await stopping
    } finally { await s.cleanup() }
  })

  it('rejects an owner that finishes after pause preparation instead of replacing under its stale proof', async () => {
    const s = await setup()
    try {
      const pause = s.store.pause.bind(s.store)
      vi.spyOn(s.store, 'pause').mockImplementationOnce(input => {
        const result = pause(input)
        s.wrapper.resolve(response())
        return result
      })
      const replace = vi.spyOn(s.store, 'replace')
      await expect(s.commands.replace(s.input())).rejects.toThrow(/pause.*no longer current|superseded/i)
      expect(replace).not.toHaveBeenCalled()
      expect(s.store.get(s.id)?.state.definitionId).toBe('old-definition')
    } finally { await s.cleanup() }
  })

  it('does not treat copied resources or another service as a replacement pause proof', async () => {
    const s = await setup()
    const other = await setup(false)
    try {
      const prepared = await s.lifecycle.quiesceForReplacement(s.id)
      const replace = vi.spyOn(s.store, 'replace')
      expect(() => s.lifecycle.commitReplacement({ ...prepared }, s.input())).toThrow(/pause.*no longer current|superseded/i)
      expect(() => other.lifecycle.commitReplacement(prepared, other.input())).toThrow(/pause.*no longer current|superseded/i)
      expect(replace).not.toHaveBeenCalled()
      const result = s.lifecycle.commitReplacement(prepared, s.input())
      expect(result.state.definitionId).toBe('new-definition')
      expect(replace).toHaveBeenCalledOnce()
      expect(() => s.lifecycle.commitReplacement(prepared, s.input())).toThrow(/pause.*no longer current|superseded/i)
      expect(replace).toHaveBeenCalledOnce()
    } finally { await s.cleanup(); await other.cleanup() }
  })

  it('does not revive an old proof when a different pause becomes current', async () => {
    const s = await setup()
    try {
      const old = await s.lifecycle.quiesceForReplacement(s.id)
      s.lifecycle.resumeCooperativeExecution(s.id)
      const current = await s.lifecycle.quiesceForReplacement(s.id)
      expect(current).not.toBe(old)
      expect(current.revision).toBe(old.revision)
      expect(s.lifecycle.isAtSafePoint(s.id)).toBe(true)
      const replace = vi.spyOn(s.store, 'replace')
      expect(() => s.lifecycle.commitReplacement(old, s.input())).toThrow(/pause.*no longer current|superseded/i)
      expect(replace).not.toHaveBeenCalled()
      expect(s.lifecycle.commitReplacement(current, s.input()).state.definitionId).toBe('new-definition')
      expect(replace).toHaveBeenCalledOnce()
    } finally { await s.cleanup() }
  })

  it.each(['before', 'after'] as const)('consumes the proof even when a %s-commit store failure occurs', async side => {
    const s = await setup()
    try {
      const prepared = await s.lifecycle.quiesceForReplacement(s.id)
      const replace = s.store.replace.bind(s.store)
      const failure = new Error(`explicit-${side}-commit-fault`)
      const write = vi.spyOn(s.store, 'replace').mockImplementationOnce((input, fence) => {
        if (side === 'after') replace(input, fence)
        throw failure
      })
      expect(() => s.lifecycle.commitReplacement(prepared, s.input())).toThrow(failure)
      expect(() => s.lifecycle.commitReplacement(prepared, s.input())).toThrow(/pause.*no longer current|superseded/i)
      expect(write).toHaveBeenCalledOnce()
      expect(s.store.get(s.id)?.state.definitionId).toBe(side === 'after' ? 'new-definition' : 'old-definition')
      expect(s.execution.isPaused()).toBe(true)
      await expect(s.start()).rejects.toThrow(/already active/i)
    } finally { await s.cleanup() }
  })

  it('rejects owner admission after an owner-absent preparation without performing replacement', async () => {
    const s = await setup(false)
    try {
      const prepared = await s.lifecycle.quiesceForReplacement(s.id)
      await s.start()
      const replace = vi.spyOn(s.store, 'replace')
      expect(() => s.lifecycle.commitReplacement(prepared, s.input())).toThrow(/revision conflict|pause.*no longer current|superseded/i)
      expect(replace).not.toHaveBeenCalled()
      expect(s.signal.aborted).toBe(false)
      expect(s.runAgent).toHaveBeenCalledOnce()
    } finally { await s.cleanup() }
  })

  it('rejects synchronous resume-repause during the final resource read instead of accepting a boolean safe point', async () => {
    const s = await setup()
    try {
      const prepared = await s.lifecycle.quiesceForReplacement(s.id)
      const input = s.input()
      const get = s.store.get.bind(s.store)
      vi.spyOn(s.store, 'get').mockImplementationOnce(id => {
        const result = get(id)
        s.lifecycle.resumeCooperativeExecution(s.id)
        void s.execution.requestPause()
        return result
      })
      const replace = vi.spyOn(s.store, 'replace')
      expect(() => s.lifecycle.commitReplacement(prepared, input)).toThrow(/pause.*no longer current|superseded/i)
      expect(s.lifecycle.isAtSafePoint(s.id)).toBe(true)
      expect(replace).not.toHaveBeenCalled()
    } finally { await s.cleanup() }
  })

  it('does not absorb an unrelated config revision changed by the authorization callout', async () => {
    const s = await setup()
    try {
      s.authorize.mockImplementationOnce(() => {
        s.store.stageConfig({ id: s.id, expectedRevision: 1, configVersion: 'v2', stagedAt: 10, idempotencyKey: 'interleaved-config' })
        return { status: 'authorized', permit: {} }
      })
      const pause = vi.spyOn(s.execution, 'requestPause')
      const replace = vi.spyOn(s.store, 'replace')
      await expect(s.commands.replace(s.input())).rejects.toThrow(/revision conflict/i)
      expect(pause).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      expect(s.store.get(s.id)?.state.pendingConfigVersion).toBe('v2')
    } finally { await s.cleanup() }
  })

  it('captures the authenticated actor before policy callouts can mutate the caller object', async () => {
    const s = await setup()
    try {
      const input = { ...s.input(), actor: { kind: 'user', id: 'owner', labels: { origin: 'trusted' } } }
      s.authorize.mockImplementationOnce(() => {
        input.actor.id = 'changed-owner'
        input.actor.labels.origin = 'changed'
        input.name = 'changed-name'
        return { status: 'authorized', permit: {} }
      })
      const result = await s.commands.replace(input)
      expect(result.state.name).toBe('new')
      const consumed = s.consumeExecutionPermit.mock.calls.at(-1) as unknown as [{ request: { actor: unknown } }]
      expect(consumed[0].request.actor).toEqual({ kind: 'user', id: 'owner', labels: { origin: 'trusted' } })
      expect(input.actor.id).toBe('changed-owner')
    } finally { await s.cleanup() }
  })

  it.each(['command-proxy', 'field-accessor', 'actor-proxy', 'actor-accessor', 'extra-field'] as const)('rejects %s without running accessors, policy or pause', async shape => {
    const s = await setup()
    try {
      s.authorize.mockClear()
      s.consumeExecutionPermit.mockClear()
      const touched = vi.fn(() => 'new')
      let input = s.input()
      if (shape === 'command-proxy') input = new Proxy(input, { ownKeys() { touched(); throw new Error('not data') } })
      if (shape === 'field-accessor') Object.defineProperty(input, 'name', { enumerable: true, get: touched })
      if (shape === 'actor-proxy') input = { ...input, actor: new Proxy(actor, { get() { touched(); throw new Error('not data') } }) }
      if (shape === 'actor-accessor') {
        const nested = { ...actor }
        Object.defineProperty(nested, 'id', { enumerable: true, get: touched })
        input = { ...input, actor: nested }
      }
      if (shape === 'extra-field') input = Object.assign(input, { unexpected: true })
      const pause = vi.spyOn(s.execution, 'requestPause')
      await expect(s.commands.replace(input)).rejects.toThrow(/plain|data|field|proxy|proxies|getter/i)
      expect(touched).not.toHaveBeenCalled()
      expect(s.authorize).not.toHaveBeenCalled()
      expect(s.consumeExecutionPermit).not.toHaveBeenCalled()
      expect(pause).not.toHaveBeenCalled()
      expect(s.store.get(s.id)?.revision).toBe(1)
    } finally { await s.cleanup() }
  })

  it.each(['resume-repause', 'close'] as const)('rejects %s from the inner store replacement read after the lifecycle entry check', async action => {
    const s = await setup()
    let closing: Promise<void> | undefined
    try {
      const prepared = await s.lifecycle.quiesceForReplacement(s.id)
      const input = s.input()
      const get = s.store.get.bind(s.store)
      let reads = 0
      vi.spyOn(s.store, 'get').mockImplementation(id => {
        const result = get(id)
        if (++reads === 2) {
          if (action === 'close') closing = s.lifecycle.close()
          else {
            s.lifecycle.resumeCooperativeExecution(s.id)
            void s.execution.requestPause()
          }
        }
        return result
      })
      const mutation = vi.spyOn(s.events, 'mutateResource')
      expect(() => s.lifecycle.commitReplacement(prepared, input)).toThrow(/pause.*no longer current|superseded/i)
      expect(reads).toBeGreaterThanOrEqual(2)
      expect(s.store.get(s.id)?.state.definitionId).toBe('old-definition')
      expect(mutation).not.toHaveBeenCalled()
      s.wrapper.resolve(response())
      await closing
    } finally { await s.cleanup() }
  })

  it('rejects a coercible operation key without executing it after final proof validation', async () => {
    const s = await setup()
    try {
      const prepared = await s.lifecycle.quiesceForReplacement(s.id)
      const coercion = vi.fn(() => {
        s.lifecycle.resumeCooperativeExecution(s.id)
        void s.execution.requestPause()
        return 'coerced-operation'
      })
      const input = { ...s.input(), idempotencyKey: { toString: coercion } as unknown as string }
      const replace = vi.spyOn(s.store, 'replace')
      expect(() => s.lifecycle.commitReplacement(prepared, input)).toThrow(/invalid replacement|must be.*string|must be data/i)
      expect(coercion).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      expect(s.store.get(s.id)?.state.definitionId).toBe('old-definition')
    } finally { await s.cleanup() }
  })

  it.each(['resume-repause', 'close'] as const)('rolls back the real SQLite mutation when %s supersedes the proof at the before-commit boundary', async action => {
    const s = await setup()
    let closing: Promise<void> | undefined
    try {
      const prepared = await s.lifecycle.quiesceForReplacement(s.id)
      const input = s.input()
      const revision = prepared.revision
      const events = s.events.countEvents()
      _crashTesting.setHook(stage => {
        if (stage !== 'resource.before-commit') return
        if (action === 'close') closing = s.lifecycle.close()
        else {
          s.lifecycle.resumeCooperativeExecution(s.id)
          void s.execution.requestPause()
        }
      })
      expect(() => s.lifecycle.commitReplacement(prepared, input)).toThrow(/pause.*no longer current|superseded/i)
      _crashTesting.setHook(null)
      expect(s.store.get(s.id)?.revision).toBe(revision)
      expect(s.store.get(s.id)?.state.definitionId).toBe('old-definition')
      expect(s.events.countEvents()).toBe(events)
      expect(s.store.getReplaceReplay(s.id, input.idempotencyKey)).toBeUndefined()
      expect(() => s.lifecycle.commitReplacement(prepared, input)).toThrow(/pause.*no longer current|superseded/i)
      s.wrapper.resolve(response())
      await closing
    } finally { _crashTesting.setHook(null); await s.cleanup() }
  })

  it('does not retroactively fail a valid committed replacement when the after-commit observer resumes it', async () => {
    const s = await setup()
    try {
      const prepared = await s.lifecycle.quiesceForReplacement(s.id)
      _crashTesting.setHook(stage => {
        if (stage !== 'resource.after-commit') return
        s.lifecycle.resumeCooperativeExecution(s.id)
      })
      const result = s.lifecycle.commitReplacement(prepared, s.input())
      _crashTesting.setHook(null)
      expect(result.state.definitionId).toBe('new-definition')
      expect(s.execution.isPaused()).toBe(false)
      expect(s.store.get(s.id)?.revision).toBe(result.revision)
    } finally { _crashTesting.setHook(null); await s.cleanup() }
  })

  it('preserves captured owner absence even if startup faults before changing the durable revision', async () => {
    const s = await setup(false)
    try {
      const prepared = await s.lifecycle.quiesceForReplacement(s.id)
      const failure = new Error('explicit-start-before-commit')
      vi.spyOn(s.store, 'start').mockImplementationOnce(() => { throw failure })
      await expect(s.start()).rejects.toBe(failure)
      expect(s.store.get(s.id)?.revision).toBe(prepared.revision)
      const replace = vi.spyOn(s.store, 'replace')
      expect(() => s.lifecycle.commitReplacement(prepared, s.input())).toThrow(/pause.*no longer current|superseded/i)
      expect(replace).not.toHaveBeenCalled()
      expect(s.runAgent).not.toHaveBeenCalled()
    } finally { await s.cleanup() }
  })

  it('does not accept a preparation for another instance and consumes that mistaken attempt', async () => {
    const s = await setup()
    try {
      const prepared = await s.lifecycle.quiesceForReplacement(s.id)
      const replace = vi.spyOn(s.store, 'replace')
      expect(() => s.lifecycle.commitReplacement(prepared, { ...s.input(), instanceId: 'another-instance' })).toThrow(/pause.*no longer current|superseded/i)
      expect(() => s.lifecycle.commitReplacement(prepared, s.input())).toThrow(/pause.*no longer current|superseded/i)
      expect(replace).not.toHaveBeenCalled()
      expect(s.store.get(s.id)?.revision).toBe(prepared.revision)
    } finally { await s.cleanup() }
  })

  it.each(['revision', 'config', 'consumed-approval'] as const)('rejects %s preflight without requesting pause', async problem => {
    const s = await setup()
    try {
      s.authorize.mockClear()
      s.consumeExecutionPermit.mockClear()
      const input = s.input()
      if (problem === 'revision') input.expectedRevision = 0
      if (problem === 'config') input.configVersion = 'missing-version'
      if (problem === 'consumed-approval') s.authorize.mockReturnValueOnce({ status: 'already-consumed', permit: {} })
      const pause = vi.spyOn(s.execution, 'requestPause')
      const replace = vi.spyOn(s.store, 'replace')
      await expect(s.commands.replace(input)).rejects.toThrow(/revision conflict|unavailable|already-consumed/i)
      expect(pause).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      expect(s.consumeExecutionPermit).not.toHaveBeenCalled()
      if (problem !== 'consumed-approval') expect(s.authorize).not.toHaveBeenCalled()
    } finally { await s.cleanup() }
  })

  it('replays historical replacement data without disturbing a later owner of the same instance', async () => {
    const s = await setup()
    const later = deferred<MagicAgentPlatformRunResp>()
    try {
      const input = s.input()
      const replaced = await s.commands.replace(input)
      s.wrapper.resolve(response())
      await flush()
      let controller!: CooperativeExecutionController
      let signal!: AbortSignal
      s.runAgent.mockImplementationOnce((_request, options) => {
        controller = options.cooperativeExecution
        signal = options.signal
        return later.promise
      })
      s.setNow(30)
      await s.lifecycle.start({
        actor, instanceId: s.id, expectedRevision: replaced.revision,
        request: { text: 'second', route: { channel: 'generic', scopeType: 'dm', scopeId: 'replacement-later' } },
        idempotencyKey: 'later-start'
      })
      const current = s.store.get(s.id)!
      s.authorize.mockClear()
      s.consumeExecutionPermit.mockClear()
      const pause = vi.spyOn(controller, 'requestPause')
      const mutation = vi.spyOn(s.events, 'mutateResource')
      await expect(s.commands.replace(input)).resolves.toEqual(replaced)
      expect(s.authorize).not.toHaveBeenCalled()
      expect(s.consumeExecutionPermit).not.toHaveBeenCalled()
      expect(pause).not.toHaveBeenCalled()
      expect(mutation).not.toHaveBeenCalled()
      expect(signal.aborted).toBe(false)
      expect(controller.isPaused()).toBe(false)
      expect(s.store.get(s.id)).toEqual(current)
    } finally { later.resolve(response()); await s.cleanup() }
  })

  it('keeps a valid live-paused replacement compatible without freeing its old execution owner', async () => {
    const s = await setup()
    try {
      const result = await s.commands.replace(s.input())
      expect(result.id).toBe(s.id)
      expect(result.state).toMatchObject({ status: 'stopped', definitionId: 'new-definition', configVersion: 'v2' })
      expect(s.signal.aborted).toBe(false)
      expect(s.execution.isPaused()).toBe(true)
      expect(s.lifecycle.isAtSafePoint(s.id)).toBe(true)
      await expect(s.start()).rejects.toThrow(/already active/i)
      expect(s.runAgent).toHaveBeenCalledOnce()
    } finally { await s.cleanup() }
  })

  it('does not pause or consume approval for a forbidden actor', async () => {
    const s = await setup()
    try {
      s.authorize.mockClear()
      s.consumeExecutionPermit.mockClear()
      const pause = vi.spyOn(s.execution, 'requestPause')
      await expect(s.commands.replace({ ...s.input(), actor: { kind: 'agent', id: 'other' } })).rejects.toThrow(/itself/i)
      expect(pause).not.toHaveBeenCalled()
      expect(s.authorize).not.toHaveBeenCalled()
      expect(s.consumeExecutionPermit).not.toHaveBeenCalled()
    } finally { await s.cleanup() }
  })

  it('does not request pause when replacement approval is denied', async () => {
    const s = await setup()
    try {
      s.authorize.mockReturnValueOnce({ status: 'denied', permit: {} })
      const pause = vi.spyOn(s.execution, 'requestPause')
      await expect(s.commands.replace(s.input())).rejects.toThrow(/denied/i)
      expect(pause).not.toHaveBeenCalled()
      expect(s.execution.isPaused()).toBe(false)
      expect(s.store.get(s.id)?.revision).toBe(1)
    } finally { await s.cleanup() }
  })

  it('preserves exact historical replacement replay without authorizing or pausing again', async () => {
    const s = await setup()
    try {
      const input = s.input()
      const original = await s.commands.replace(input)
      s.lifecycle.resumeCooperativeExecution(s.id)
      s.authorize.mockClear()
      s.consumeExecutionPermit.mockClear()
      const pause = vi.spyOn(s.execution, 'requestPause')
      await expect(s.commands.replace(input)).resolves.toEqual(original)
      expect(pause).not.toHaveBeenCalled()
      expect(s.authorize).not.toHaveBeenCalled()
      expect(s.consumeExecutionPermit).not.toHaveBeenCalled()
      expect(s.execution.isPaused()).toBe(false)
      await expect(s.commands.replace({ ...input, name: 'changed' })).rejects.toThrow(/idempotency conflict/i)
      expect(s.store.get(s.id)?.revision).toBe(original.revision)
    } finally { await s.cleanup() }
  })
})
