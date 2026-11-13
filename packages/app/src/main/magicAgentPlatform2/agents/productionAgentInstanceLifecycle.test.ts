import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { MagicAgentPlatformRunResp } from '../../../shared/api/svcMagicAgentPlatform'
import { canonicalPolicyJson } from '../../../shared/magicAgentPlatform2/policy'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import {
  createAgentInstanceLifecyclePolicyRequest,
  createAgentConfigPolicyRequest,
  ProductionAgentInstanceLifecycleService
} from './productionAgentInstanceLifecycle'

const completedRun = (runId = 'run'): MagicAgentPlatformRunResp => ({
  runId,
  agentId: 'agent',
  status: 'completed',
  content: 'ok',
  messages: [],
  toolCalls: [],
  events: [],
  startedAt: 1,
  finishedAt: 2
})

const setup = (effect: 'allow' | 'deny' = 'allow') => {
  const eventStore = new MagicAgentEventStore(':memory:')
  const store = new PersistentAgentInstanceStore(eventStore)
  const authorization = new MagicAgentPolicyAuthorizationService({
    store: eventStore,
    policyVersion: 'm6-test',
    storeId: 'm6',
    trustedApprovers: [{ kind: 'user', id: 'approver-1' }],
    rules: [
      {
        ruleId: 'lifecycle',
        priority: 1,
        effect: effect === 'allow' ? 'require-approval' : effect,
        match: {
          origins: ['internal'],
          actions: [
            'agent-instance.start',
            'agent-instance.pause',
            'agent-instance.resume',
            'agent-instance.stop',
            'agent-instance.stage-config',
            'agent-instance.activate-config',
            'agent-instance.rollback-config'
          ]
        },
        explanation: effect,
        ...(effect === 'allow'
          ? {
              approvalRequirement: {
                scopeKind: 'request',
                scopeValue: 'agent-lifecycle',
                maxUses: 2,
                expiresInMs: 1_000,
                reason: 'Agent lifecycle approval'
              }
            }
          : {})
      }
    ]
  })
  const created = store.create({
    instance: {
      id: 'instance-1',
      name: 'Worker',
      definitionId: 'agent-1',
      depth: 0,
      configVersion: 'v1',
      status: 'created',
      limits: {
        maxChildren: 2,
        maxDepth: 2,
        maxConcurrency: 1,
        maxRuntimeMs: 100,
        allowedToolNames: ['read'],
        workspaceRoots: ['C:\\workspace']
      }
    },
    createdAt: 1,
    idempotencyKey: 'create'
  })
  return { eventStore, store, authorization, created }
}
const allowedAuthorization = {
  authorize: vi.fn(() => ({ status: 'authorized', permit: { token: 'permit' } })),
  consumeExecutionPermit: vi.fn()
} as never

const request = {
  agentId: 'caller-controlled',
  text: 'work',
  route: { channel: 'm6', scopeType: 'dm' as const, scopeId: 'instance-1' },
  timeoutMs: 500,
  allowedToolNames: ['read', 'write']
}

const incrementingClock = () => {
  let now = 10
  return () => now++
}

describe('ProductionAgentInstanceLifecycleService', () => {
  it('classifies activation expansion as high-risk and reduction/equivalent as low-risk', () => {
    const { eventStore, created } = setup()
    const actor = { kind: 'user', id: 'owner' } as const
    for (const [privilegeChange, kind, risk] of [
      ['expansion', 'agent.lifecycle', 'high'],
      ['reduction', 'agent.config', 'low'],
      ['equivalent', 'agent.config', 'low']
    ] as const) {
      const policyRequest = createAgentConfigPolicyRequest({
        actor,
        action: 'activate-config',
        instance: created,
        configVersion: 'v2',
        privilegeChange
      })
      expect(policyRequest.input).toMatchObject({
        activeConfigVersion: 'v1',
        configVersion: 'v2',
        privilegeChange
      })
      expect(policyRequest.effects).toEqual([expect.objectContaining({ kind, risk })])
    }
    eventStore.close()
  })

  it('requires separate approval grants for create and remove lifecycle mutations', () => {
    const { eventStore, authorization, created } = setup()
    const lifecycle = new ProductionAgentInstanceLifecycleService(
      new PersistentAgentInstanceStore(eventStore),
      authorization,
      async () => ({ runId: 'unused' }) as never,
      () => 20
    )
    const actor = { kind: 'user', id: 'owner' } as const
    const candidate = {
      kind: 'agent-instance' as const,
      id: 'instance-created',
      revision: 0,
      deleted: false,
      createdAt: 20,
      updatedAt: 20,
      state: { ...created.state, id: 'instance-created' }
    }
    expect(() =>
      lifecycle.authorizeLifecycleMutation({
        actor,
        action: 'create',
        instance: candidate,
        idempotencyKey: 'create'
      })
    ).toThrow(/awaiting-approval/)
    const createRequest = createAgentInstanceLifecyclePolicyRequest({
      actor,
      action: 'create',
      instance: candidate
    })
    const createGrant = authorization.createApprovalGrant({
      grantId: 'create-grant',
      request: createRequest,
      approvedBy: { kind: 'user', id: 'approver-1' },
      issuedAt: 20,
      expiresAt: 1020,
      maxUses: 1,
      idempotencyKey: 'create-grant'
    }).grant
    expect(
      lifecycle.authorizeLifecycleMutation({
        actor,
        action: 'create',
        instance: candidate,
        idempotencyKey: 'create-resume',
        grantId: createGrant.grantId,
        expectedGrantUseCount: 0
      })
    ).toBe(true)
    expect(() =>
      lifecycle.authorizeLifecycleMutation({
        actor,
        action: 'remove',
        instance: created,
        idempotencyKey: 'remove'
      })
    ).toThrow(/awaiting-approval/)
    const removeRequest = createAgentInstanceLifecyclePolicyRequest({
      actor,
      action: 'remove',
      instance: created
    })
    const removeGrant = authorization.createApprovalGrant({
      grantId: 'remove-grant',
      request: removeRequest,
      approvedBy: { kind: 'user', id: 'approver-1' },
      issuedAt: 20,
      expiresAt: 1020,
      maxUses: 1,
      idempotencyKey: 'remove-grant'
    }).grant
    expect(
      lifecycle.authorizeLifecycleMutation({
        actor,
        action: 'remove',
        instance: created,
        idempotencyKey: 'remove-resume',
        grantId: removeGrant.grantId,
        expectedGrantUseCount: 0
      })
    ).toBe(true)
    eventStore.close()
  })

  it('requires separate approval grants for safe activation and rollback', () => {
    const { eventStore, store, authorization, created } = setup()
    const lifecycle = new ProductionAgentInstanceLifecycleService(
      store,
      authorization,
      async () => ({ runId: 'run' }) as never,
      () => 20
    )
    const actor = { kind: 'user', id: 'owner' } as const
    const staged = store.stageConfig({
      id: created.id,
      expectedRevision: created.revision,
      configVersion: 'v2',
      stagedAt: 11,
      idempotencyKey: 'stage-direct'
    })
    const activateRequest = createAgentConfigPolicyRequest({
      actor,
      action: 'activate-config',
      instance: staged
    })
    expect(() =>
      lifecycle.authorizeConfigMutation({
        actor,
        action: 'activate-config',
        instanceId: staged.id,
        idempotencyKey: 'activate'
      })
    ).toThrow(/awaiting-approval/)
    expect(store.get(staged.id)?.state.configVersion).toBe('v1')
    const activateGrant = authorization.createApprovalGrant({
      grantId: 'activate-grant',
      request: activateRequest,
      approvedBy: { kind: 'user', id: 'approver-1' },
      issuedAt: 20,
      expiresAt: 1020,
      maxUses: 1,
      idempotencyKey: 'activate-grant'
    }).grant
    expect(
      lifecycle.authorizeConfigMutation({
        actor,
        action: 'activate-config',
        instanceId: staged.id,
        idempotencyKey: 'activate-resume',
        grantId: activateGrant.grantId,
        expectedGrantUseCount: 0
      })
    ).toBe(true)
    const activated = lifecycle.activateStagedConfigAtSafePoint({
      instanceId: staged.id,
      expectedRevision: staged.revision,
      activatedAt: 21,
      idempotencyKey: 'activate-store'
    })
    expect(activated.state.configVersion).toBe('v2')
    const rollbackRequest = createAgentConfigPolicyRequest({
      actor,
      action: 'rollback-config',
      instance: activated
    })
    expect(() =>
      lifecycle.authorizeConfigMutation({
        actor,
        action: 'rollback-config',
        instanceId: activated.id,
        idempotencyKey: 'rollback'
      })
    ).toThrow(/awaiting-approval/)
    const rollbackGrant = authorization.createApprovalGrant({
      grantId: 'rollback-grant',
      request: rollbackRequest,
      approvedBy: { kind: 'user', id: 'approver-1' },
      issuedAt: 20,
      expiresAt: 1020,
      maxUses: 1,
      idempotencyKey: 'rollback-grant'
    }).grant
    expect(
      lifecycle.authorizeConfigMutation({
        actor,
        action: 'rollback-config',
        instanceId: activated.id,
        idempotencyKey: 'rollback-resume',
        grantId: rollbackGrant.grantId,
        expectedGrantUseCount: 0
      })
    ).toBe(true)
    const rolledBack = lifecycle.rollbackConfigAtSafePoint({
      instanceId: activated.id,
      expectedRevision: activated.revision,
      rolledBackAt: 22,
      idempotencyKey: 'rollback-store'
    })
    expect(rolledBack.state.configVersion).toBe('v1')
    eventStore.close()
  })

  it('resumes config staging with approval and treats consumed permit as replay', () => {
    const { eventStore, store, authorization, created } = setup()
    const lifecycle = new ProductionAgentInstanceLifecycleService(
      store,
      authorization,
      async () => ({ runId: 'run' }) as never,
      () => 10
    )
    const actor = { kind: 'user', id: 'owner' } as const
    const request = createAgentConfigPolicyRequest({
      actor,
      action: 'stage-config',
      instance: created,
      configVersion: 'v2'
    })
    expect(() =>
      lifecycle.authorizeConfigMutation({
        actor,
        action: 'stage-config',
        instanceId: created.id,
        configVersion: 'v2',
        idempotencyKey: 'stage'
      })
    ).toThrow(/awaiting-approval/)
    expect(store.get(created.id)?.state.pendingConfigVersion).toBeUndefined()
    const grant = authorization.createApprovalGrant({
      grantId: 'config-grant',
      request,
      approvedBy: { kind: 'user', id: 'approver-1' },
      issuedAt: 10,
      expiresAt: 1010,
      maxUses: 1,
      idempotencyKey: 'config-grant'
    }).grant
    expect(
      lifecycle.authorizeConfigMutation({
        actor,
        action: 'stage-config',
        instanceId: created.id,
        configVersion: 'v2',
        idempotencyKey: 'stage-resume',
        grantId: grant.grantId,
        expectedGrantUseCount: 0
      })
    ).toBe(true)
    expect(
      lifecycle.authorizeConfigMutation({
        actor,
        action: 'stage-config',
        instanceId: created.id,
        configVersion: 'v2',
        idempotencyKey: 'stage-resume',
        grantId: grant.grantId,
        expectedGrantUseCount: 0
      })
    ).toBe(false)
    const staged = store.stageConfig({
      id: created.id,
      expectedRevision: created.revision,
      configVersion: 'v2',
      stagedAt: 10,
      idempotencyKey: 'stage'
    })
    expect(staged.state.pendingConfigVersion).toBe('v2')
    eventStore.close()
  })

  it('Policy-gates config staging and keeps version identities only in projection', () => {
    const { eventStore, store, authorization, created } = setup('deny')
    const lifecycle = new ProductionAgentInstanceLifecycleService(
      store,
      authorization,
      async () => ({ runId: 'run' }) as never,
      () => 10
    )
    expect(() =>
      lifecycle.authorizeConfigMutation({
        actor: { kind: 'user', id: 'owner' },
        action: 'stage-config',
        instanceId: created.id,
        configVersion: 'v2',
        idempotencyKey: 'stage'
      })
    ).toThrow(/denied/)
    expect(store.get(created.id)?.state.pendingConfigVersion).toBeUndefined()
    const request = createAgentConfigPolicyRequest({
      actor: { kind: 'user', id: 'owner' },
      action: 'stage-config',
      instance: created,
      configVersion: 'v2'
    })
    expect(JSON.stringify(request)).toContain('v2')
    expect(JSON.stringify(request)).not.toContain('system prompt secret')
    eventStore.close()
  })

  it('activates staged config only when no Agent execution is active', async () => {
    const { eventStore, store, created } = setup()
    const staged = store.stageConfig({
      id: created.id,
      expectedRevision: created.revision,
      configVersion: 'v2',
      stagedAt: 2,
      idempotencyKey: 'stage'
    })
    let release!: () => void
    const lifecycle = new ProductionAgentInstanceLifecycleService(
      store,
      allowedAuthorization,
      async () =>
        new Promise((resolve) => {
          release = () => resolve(completedRun())
        }),
      () => 3
    )
    const running = lifecycle.start({
      instanceId: staged.id,
      expectedRevision: staged.revision,
      actor: { kind: 'user', id: 'owner' },
      request,
      idempotencyKey: 'start'
    })
    await vi.waitFor(() => expect(lifecycle.isAtSafePoint(staged.id)).toBe(false))
    expect(() =>
      lifecycle.activateStagedConfigAtSafePoint({
        instanceId: staged.id,
        expectedRevision: staged.revision + 1,
        activatedAt: 4,
        idempotencyKey: 'activate'
      })
    ).toThrow(/safe point/)
    release()
    await vi.waitFor(() => expect(lifecycle.isAtSafePoint(staged.id)).toBe(true))
    const stopped = store.get(staged.id)!
    const activated = lifecycle.activateStagedConfigAtSafePoint({
      instanceId: staged.id,
      expectedRevision: stopped.revision,
      activatedAt: 5,
      idempotencyKey: 'activate'
    })
    expect(activated.state.configVersion).toBe('v2')
    eventStore.close()
  })

  describe('pause ticket consumers (not a general config safe point)', () => {
    const scenario = async () => {
      const { eventStore, store, created } = setup()
      let execution!: import('./cooperativeExecutionController').CooperativeExecutionController
      let runSignal!: AbortSignal
      const service = new ProductionAgentInstanceLifecycleService(store, allowedAuthorization, async (_req, options) => {
        execution = options.cooperativeExecution; runSignal = options.signal
        await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
        return completedRun()
      }, incrementingClock())
      const actor = { kind: 'user', id: 'owner' } as const
      await service.start({ instanceId: created.id, expectedRevision: 0, actor, request, idempotencyKey: 'ticket-start' })
      const pause = (key: string) => service.pause({ instanceId: created.id, expectedRevision: store.get(created.id)!.revision, actor, idempotencyKey: key })
      const resume = (key: string) => service.resume({ instanceId: created.id, expectedRevision: store.get(created.id)!.revision, actor, idempotencyKey: key })
      const close = async () => { await service.close(); eventStore.close() }
      return { eventStore, store, id: created.id, service, execution, runSignal, actor, pause, resume, close }
    }

    it('does not durably pause after an immediate resume of a running instance', async () => {
      const s = await scenario()
      try {
        const pending = s.pause('idle-pause'), rejected = expect(pending).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' })
        s.resume('withdraw-idle')
        await rejected
        expect(s.store.get(s.id)?.state.status).toBe('running'); expect(s.execution.isPaused()).toBe(false)
      } finally { await s.close() }
    })

    it('withdraws an active drain without releasing the active tool ownership', async () => {
      const s = await scenario(), leave = s.execution.enter('tool-invocation')
      let settled = false
      try {
        const pending = s.pause('active-pause'), rejected = expect(pending).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' }).then(() => { settled = true })
        s.resume('withdraw-active')
        for (let i = 0; i < 12; i++) await Promise.resolve()
        expect(settled).toBe(true); expect(s.execution.isQuiescent()).toBe(false)
        leave(); await rejected
        expect(s.store.get(s.id)?.state.status).toBe('running')
      } finally { leave(); await s.close() }
    })

    it('keeps an old durable-pause continuation stale across immediate resume and re-pause', async () => {
      const s = await scenario()
      try {
        const stale = s.pause('old-pause'), rejected = expect(stale).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' })
        s.resume('between-pauses')
        const fresh = s.pause('fresh-pause')
        await rejected
        expect((await fresh).state.status).toBe('paused')
        expect(s.store.get(s.id)?.revision).toBe(2)
      } finally { await s.close() }
    })

    it.each(['pause', 'replacement'])('rechecks its ticket at the %s commit after its helper resolved', async action => {
      const s = await scenario(), requestPause = s.service.requestCooperativePause.bind(s.service)
      vi.spyOn(s.service, 'requestCooperativePause').mockImplementation(async id => {
        const ticket = await requestPause(id)
        queueMicrotask(() => s.service.resumeCooperativeExecution(id))
        return ticket
      })
      try {
        const pending = action === 'pause' ? s.pause('commit-race') : s.service.quiesceForReplacement(s.id)
        await expect(pending).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' })
        expect(s.store.get(s.id)?.state.status).toBe('running'); expect(s.execution.isPaused()).toBe(false)
      } finally { await s.close() }
    })

    it.each(['pause-pause', 'pause-replacement', 'replacement-pause'])('commits concurrent %s once after validating each current ticket', async order => {
      const s = await scenario(), leave = s.execution.enter('llm-inference')
      try {
        const first = order === 'replacement-pause' ? s.service.quiesceForReplacement(s.id) : s.pause('first')
        const second = order === 'pause-pause' || order === 'replacement-pause' ? s.pause('second') : s.service.quiesceForReplacement(s.id)
        leave()
        const results = await Promise.all([first, second])
        expect(results.map(result => result.state.status)).toEqual(['paused', 'paused'])
        expect(results[0].revision).toBe(2); expect(results[1].revision).toBe(2)
        expect(s.store.get(s.id)?.revision).toBe(2)
      } finally { leave(); await s.close() }
    })

    it.each(['stop', 'close'])('does not let a queued idle pause overwrite %s', async action => {
      const s = await scenario()
      try {
        const pending = s.pause('late-pause'), rejected = expect(pending).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' })
        const stopped = action === 'close' ? s.service.close() : s.service.stop({ instanceId: s.id, expectedRevision: 1, actor: s.actor, idempotencyKey: 'ticket-stop' })
        await rejected; await stopped
        expect(s.runSignal.aborted).toBe(true); expect(s.store.get(s.id)?.state.status).toBe('stopped')
      } finally { await s.close() }
    })

    it.each(['paused', 'concurrent'])('replays a successful %s duplicate pause as historical data without another transition', async mode => {
      const s = await scenario()
      try {
        let original!: Awaited<ReturnType<typeof s.pause>>
        const duplicateInput = { instanceId: s.id, expectedRevision: mode === 'paused' ? 2 : 1, actor: s.actor, idempotencyKey: 'duplicate-receipt' }
        if (mode === 'paused') {
          await s.pause('first-pause')
          original = await s.service.pause(duplicateInput)
        } else {
          const leave = s.execution.enter('llm-inference')
          const first = s.pause('first-pause'), duplicate = s.service.pause(duplicateInput)
          leave(); await first; original = await duplicate
        }
        expect(s.store.get(s.id)?.revision).toBe(2)
        s.resume('after-duplicate')
        const requestGate = vi.spyOn(s.execution, 'requestPause'), resumeGate = vi.spyOn(s.execution, 'resume')
        expect(await s.service.pause(duplicateInput)).toEqual(original)
        expect(requestGate).not.toHaveBeenCalled(); expect(resumeGate).not.toHaveBeenCalled()
        expect(s.store.get(s.id)?.state.status).toBe('running'); expect(s.store.get(s.id)?.revision).toBe(3)
        await expect(s.service.pause({ ...duplicateInput, actor: { kind: 'user', id: 'other' } })).rejects.toThrow(/idempotency conflict/i)
      } finally { await s.close() }
    })

    it('replays a running-resume no-op without withdrawing a later independent pause', async () => {
      const s = await scenario()
      try {
        const command = { instanceId: s.id, expectedRevision: 1, actor: s.actor, idempotencyKey: 'resume-noop' }
        const receipt = s.service.resume(command)
        expect(receipt.revision).toBe(1)
        await s.pause('later-pause')
        const resume = vi.spyOn(s.execution, 'resume')
        expect(s.service.resume(command)).toEqual(receipt)
        expect(resume).not.toHaveBeenCalled(); expect(s.execution.isPaused()).toBe(true)
        expect(s.store.get(s.id)?.state.status).toBe('paused'); expect(s.store.get(s.id)?.revision).toBe(2)
      } finally { await s.close() }
    })

    it('uses the original deep command snapshot after a caller mutates its input during pause drain', async () => {
      const s = await scenario(), leave = s.execution.enter('tool-invocation')
      const original = { instanceId: s.id, expectedRevision: 1, actor: { ...s.actor }, idempotencyKey: 'captured-original' }
      const mutable = { ...original, actor: { kind: 'user', id: 'owner' } }
      try {
        const first = s.pause('first'), duplicate = s.service.pause(mutable)
        mutable.actor.id = 'changed'; mutable.idempotencyKey = 'changed'; mutable.expectedRevision = 999
        leave(); await first; const result = await duplicate
        s.resume('resume-after-captured')
        expect(await s.service.pause(original)).toEqual(result)
        expect(s.store.get(s.id)?.state.status).toBe('running')
      } finally { leave(); await s.close() }
    })

    it.each(['before', 'after'])('does not repair or repeat a no-op whose append failed %s commit', async side => {
      const s = await scenario()
      try {
        await s.pause('initial')
        const command = { instanceId: s.id, expectedRevision: 2, actor: s.actor, idempotencyKey: 'lost-noop' }
        const append = s.eventStore.appendBatch.bind(s.eventStore), failure = new Error('no-op append failure')
        const record = vi.spyOn(s.store, 'recordLifecycleNoopCompletion').mockImplementationOnce(input => {
          vi.spyOn(s.eventStore, 'appendBatch').mockImplementationOnce(events => { if (side === 'after') append(events); throw failure })
          return Reflect.apply(Object.getPrototypeOf(s.store).recordLifecycleNoopCompletion, s.store, [input])
        })
        await expect(s.service.pause(command)).rejects.toBe(failure)
        s.resume('after-failed-receipt')
        const requestGate = vi.spyOn(s.execution, 'requestPause')
        if (side === 'after') expect((await s.service.pause(command)).state.status).toBe('paused')
        else await expect(s.service.pause(command)).rejects.toThrow(/revision conflict/i)
        expect(requestGate).not.toHaveBeenCalled(); expect(record).toHaveBeenCalledOnce()
        expect(s.store.get(s.id)?.state.status).toBe('running')
      } finally { await s.close() }
    })

    it.each(['stop', 'close'])('keeps an aborted active drain unacknowledged until it really leaves during %s', async action => {
      const s = await scenario(), leave = s.execution.enter('tool-invocation')
      try {
        let settled = false
        const pending = s.pause('active-abort'), rejected = expect(pending).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' }).then(() => { settled = true })
        const joined = action === 'close' ? s.service.close() : s.service.stop({ instanceId: s.id, expectedRevision: 1, actor: s.actor, idempotencyKey: 'active-stop' })
        let joinedSettled = false
        void joined.then(() => { joinedSettled = true })
        await Promise.resolve()
        expect(s.runSignal.aborted).toBe(true); expect(settled).toBe(false); expect(joinedSettled).toBe(false)
        expect(s.execution.isPaused()).toBe(true); expect(s.execution.isQuiescent()).toBe(false)
        leave(); await rejected; await joined
        expect(s.store.get(s.id)?.state.status).toBe('stopped')
      } finally { leave(); await s.close() }
    })

    it.each(['before', 'after'])('reports running-resume receipt failure %s commit without undoing withdrawal or recreating a missing receipt', async side => {
      const s = await scenario()
      try {
        const stale = s.pause('to-withdraw'), rejected = expect(stale).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' })
        const command = { instanceId: s.id, expectedRevision: 1, actor: s.actor, idempotencyKey: 'resume-write-failed' }
        const append = s.eventStore.appendBatch.bind(s.eventStore), failure = new Error('resume receipt failure')
        vi.spyOn(s.store, 'recordLifecycleNoopCompletion').mockImplementationOnce(input => {
          vi.spyOn(s.eventStore, 'appendBatch').mockImplementationOnce(events => { if (side === 'after') append(events); throw failure })
          return Reflect.apply(Object.getPrototypeOf(s.store).recordLifecycleNoopCompletion, s.store, [input])
        })
        expect(() => s.service.resume(command)).toThrow(failure)
        await rejected; expect(s.execution.isPaused()).toBe(false)
        await s.pause('new-independent-pause')
        const resume = vi.spyOn(s.execution, 'resume')
        if (side === 'after') expect(s.service.resume(command).state.status).toBe('running')
        else expect(() => s.service.resume(command)).toThrow(/revision conflict/i)
        expect(resume).not.toHaveBeenCalled(); expect(s.execution.isPaused()).toBe(true)
        expect(s.store.get(s.id)?.state.status).toBe('paused')
      } finally { await s.close() }
    })

    it('does not accept an already-paused shortcut while late legacy work is active', async () => {
      const s = await scenario()
      try {
        await s.pause('initial')
        expect(() => s.execution.enter('tool-invocation')).toThrow(
          expect.objectContaining({ code: 'COOPERATIVE_EXECUTION_PAUSED' })
        )
        // Synthetic pre-hardening/corrupt state, not a legal paused entry. Retain
        // actual registration/release and all already-paused consumer assertions.
        const leave = Reflect.apply(Reflect.get(s.execution, 'registerActive'), s.execution, [
          'tool-invocation'
        ]) as () => void
        let repeated!: ReturnType<typeof s.pause>
        try {
          let acknowledged = false
          repeated = s.pause('repeated').then(result => { acknowledged = true; return result })
          for (let i = 0; i < 8; i++) await Promise.resolve()
          expect(acknowledged).toBe(false)
        } finally { leave() }
        expect((await repeated).state.status).toBe('paused'); expect(s.store.get(s.id)?.revision).toBe(2)
      } finally { await s.close() }
    })
  })

  it('does not let a delayed pause acknowledgement target a restarted execution with the same instance id', async () => {
    const { eventStore, store, created } = setup()
    let finishFirst!: (value: MagicAgentPlatformRunResp) => void
    let firstGate!: import('./cooperativeExecutionController').CooperativeExecutionController
    let secondGate!: import('./cooperativeExecutionController').CooperativeExecutionController
    let calls = 0
    const service = new ProductionAgentInstanceLifecycleService(store, allowedAuthorization, (_req, options) => {
      calls++
      if (calls === 1) {
        firstGate = options.cooperativeExecution
        return new Promise<MagicAgentPlatformRunResp>(resolve => { finishFirst = resolve })
      }
      secondGate = options.cooperativeExecution
      return new Promise<MagicAgentPlatformRunResp>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    }, incrementingClock())
    const actor = { kind: 'user', id: 'owner' } as const
    let release!: () => void
    const releaseAck = new Promise<void>(resolve => { release = resolve })
    try {
      await service.start({ instanceId: created.id, expectedRevision: 0, actor, request, idempotencyKey: 'first' })
      const original = firstGate.requestPause.bind(firstGate)
      vi.spyOn(firstGate, 'requestPause').mockImplementation(async () => { const ticket = await original(); await releaseAck; return ticket })
      const stale = service.pause({ instanceId: created.id, expectedRevision: 1, actor, idempotencyKey: 'delayed-first' })
      const rejected = expect(stale).rejects.toMatchObject({ code: 'COOPERATIVE_PAUSE_SUPERSEDED' })
      finishFirst(completedRun('first')); for (let i = 0; i < 12; i++) await Promise.resolve()
      expect(store.get(created.id)?.state.status).toBe('stopped')
      await service.start({ instanceId: created.id, expectedRevision: 2, actor, request, idempotencyKey: 'second' })
      expect(secondGate).not.toBe(firstGate); release(); await rejected
      expect(store.get(created.id)?.state.status).toBe('running'); expect(store.get(created.id)?.revision).toBe(3)
      expect(secondGate.isPaused()).toBe(false)
    } finally { release(); finishFirst?.(completedRun('cleanup')); await service.close(); eventStore.close() }
  })

  it('acknowledges a cooperative safe point only after active runtime work drains', async () => {
    const { eventStore, store, created } = setup()
    let execution!: import('./cooperativeExecutionController').CooperativeExecutionController
    let finishRun!: () => void
    const service = new ProductionAgentInstanceLifecycleService(
      store,
      allowedAuthorization,
      async (_req, options) => {
        execution = options.cooperativeExecution
        await new Promise<void>((resolve) => {
          finishRun = resolve
        })
        return completedRun()
      }
    )
    await service.start({
      instanceId: created.id,
      expectedRevision: 0,
      actor: { kind: 'user', id: 'owner' },
      request,
      idempotencyKey: 'start'
    })
    await vi.waitFor(() => expect(execution).toBeDefined())
    const leaveLlm = execution.enter('llm-inference')
    let paused = false
    const pause = service.requestCooperativePause(created.id).then(() => {
      paused = true
    })
    await Promise.resolve()
    expect(paused).toBe(false)
    expect(service.isAtSafePoint(created.id)).toBe(false)
    leaveLlm()
    await pause
    expect(service.isAtSafePoint(created.id)).toBe(true)
    service.resumeCooperativeExecution(created.id)
    expect(service.isAtSafePoint(created.id)).toBe(false)
    finishRun()
    await vi.waitFor(() => expect(store.get(created.id)?.state.status).toBe('stopped'))
    eventStore.close()
  })

  it('quiesces running replacement only after active tool execution drains', async () => {
    const { eventStore, store, created } = setup()
    let execution!: import('./cooperativeExecutionController').CooperativeExecutionController
    let finishRun!: () => void
    const service = new ProductionAgentInstanceLifecycleService(
      store,
      allowedAuthorization,
      async (_req, options) => {
        execution = options.cooperativeExecution
        await new Promise<void>((resolve) => {
          finishRun = resolve
        })
        return completedRun()
      },
      incrementingClock()
    )
    await service.start({
      instanceId: created.id,
      expectedRevision: 0,
      actor: { kind: 'user', id: 'owner' },
      request,
      idempotencyKey: 'start'
    })
    await vi.waitFor(() => expect(execution).toBeDefined())
    const leaveTool = execution.enter('tool-invocation')
    const quiesce = service.quiesceForReplacement(created.id)
    await Promise.resolve()
    expect(store.get(created.id)?.state.status).toBe('running')
    leaveTool()
    const paused = await quiesce
    expect(paused.state.status).toBe('paused')
    expect(service.isAtSafePoint(created.id)).toBe(true)
    finishRun()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.get(created.id)?.state.status).toBe('paused')
    eventStore.close()
  })

  it('durably pauses only after quiescence and resumes blocked execution', async () => {
    const { eventStore, store, created } = setup()
    let execution!: import('./cooperativeExecutionController').CooperativeExecutionController
    let finishRun!: () => void
    const service = new ProductionAgentInstanceLifecycleService(
      store,
      allowedAuthorization,
      async (_req, options) => {
        execution = options.cooperativeExecution
        await new Promise<void>((resolve) => {
          finishRun = resolve
        })
        return completedRun()
      },
      incrementingClock()
    )
    await service.start({
      instanceId: created.id,
      expectedRevision: 0,
      actor: { kind: 'user', id: 'owner' },
      request,
      idempotencyKey: 'start'
    })
    await vi.waitFor(() => expect(execution).toBeDefined())
    const leaveTool = execution.enter('tool-invocation')
    const pausePromise = service.pause({
      instanceId: created.id,
      expectedRevision: 1,
      actor: { kind: 'user', id: 'owner' },
      idempotencyKey: 'pause'
    })
    await Promise.resolve()
    expect(store.get(created.id)?.state.status).toBe('running')
    leaveTool()
    const paused = await pausePromise
    expect(paused.state.status).toBe('paused')
    let crossed = false
    const blocked = execution.checkpoint('assistant-turn').then(() => {
      crossed = true
    })
    await Promise.resolve()
    expect(crossed).toBe(false)
    const resumed = service.resume({
      instanceId: created.id,
      expectedRevision: paused.revision,
      actor: { kind: 'user', id: 'owner' },
      idempotencyKey: 'resume'
    })
    expect(resumed.state.status).toBe('running')
    await blocked
    expect(crossed).toBe(true)
    finishRun()
    await vi.waitFor(() => expect(store.get(created.id)?.state.status).toBe('stopped'))
    eventStore.close()
  })

  it.each(['sequential', 'concurrent'])('preserves no-op pause replay with real approval and one-use grants for %s requests', async mode => {
    const { eventStore, store, created, authorization } = setup()
    let execution!: import('./cooperativeExecutionController').CooperativeExecutionController
    const service = new ProductionAgentInstanceLifecycleService(store, authorization, async (_request, options) => {
      execution = options.cooperativeExecution
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
      return completedRun()
    }, () => 10)
    const actor = { kind: 'user', id: 'owner' } as const
    const grant = (id: string, action: 'start' | 'pause' | 'resume', instance = store.get(created.id)!) => authorization.createApprovalGrant({
      grantId: id,
      request: createAgentInstanceLifecyclePolicyRequest({ actor, action, instance, ...(action === 'start' ? { requestDigest: createHash('sha256').update(canonicalPolicyJson(request as never)).digest('hex') } : {}) }),
      approvedBy: { kind: 'user', id: 'approver-1' }, issuedAt: 10, expiresAt: 1010, maxUses: 1, idempotencyKey: id
    }).grant
    const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
    try {
      const startGrant = grant('start-receipt', 'start', created)
      await service.start({ instanceId: created.id, expectedRevision: 0, actor, request, idempotencyKey: 'start-receipt', grantId: startGrant.grantId, expectedGrantUseCount: 0 })
      const firstGrant = grant('first-receipt', 'pause')
      const firstInput = { instanceId: created.id, expectedRevision: 1, actor, idempotencyKey: 'first-receipt', grantId: firstGrant.grantId, expectedGrantUseCount: 0 }
      let duplicateInput: Parameters<typeof service.pause>[0]
      let result: Awaited<ReturnType<typeof service.pause>>
      if (mode === 'concurrent') {
        const duplicateGrant = grant('duplicate-receipt', 'pause')
        duplicateInput = { ...firstInput, idempotencyKey: 'duplicate-receipt', grantId: duplicateGrant.grantId }
        const leave = execution.enter('tool-invocation')
        const first = service.pause(firstInput), second = service.pause(duplicateInput)
        try { leave(); await first; result = await second } finally { leave() }
      } else {
        await service.pause(firstInput)
        const duplicateGrant = grant('duplicate-receipt', 'pause')
        duplicateInput = { ...firstInput, expectedRevision: 2, idempotencyKey: 'duplicate-receipt', grantId: duplicateGrant.grantId }
        result = await service.pause(duplicateInput)
      }
      expect(store.get(created.id)?.revision).toBe(2)
      expect(consume).toHaveBeenCalledTimes(3)
      // Immediate lost-reply retry must not hit real already-consumed authorization.
      expect(await service.pause(duplicateInput)).toEqual(result)
      expect(consume).toHaveBeenCalledTimes(3)
      const resumeGrant = grant('resume-receipt', 'resume')
      service.resume({ instanceId: created.id, expectedRevision: 2, actor, idempotencyKey: 'resume-receipt', grantId: resumeGrant.grantId, expectedGrantUseCount: 0 })
      const authorize = vi.spyOn(authorization, 'authorize'), gate = vi.spyOn(execution, 'requestPause')
      expect(await service.pause(duplicateInput)).toEqual(result)
      expect(authorize).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled()
      expect(consume).toHaveBeenCalledTimes(4); expect(store.get(created.id)?.state.status).toBe('running')
      const reconstructed = new ProductionAgentInstanceLifecycleService(new PersistentAgentInstanceStore(eventStore), authorization, vi.fn(), () => 11)
      expect(await reconstructed.pause(duplicateInput)).toEqual(result)
      expect(authorize).not.toHaveBeenCalled(); expect(consume).toHaveBeenCalledTimes(4)
      await expect(service.pause({ ...duplicateInput, expectedGrantUseCount: 1 })).rejects.toThrow(/idempotency conflict/i)
      expect(consume).toHaveBeenCalledTimes(4)
    } finally { await service.close(); eventStore.close(); vi.restoreAllMocks() }
  })

  it('requires separate approval grants for pause and resume', async () => {
    const { eventStore, store, authorization, created } = setup()
    let finishRun!: () => void
    const service = new ProductionAgentInstanceLifecycleService(
      store,
      authorization,
      async () => {
        await new Promise<void>((resolve) => {
          finishRun = resolve
        })
        return completedRun()
      },
      () => 10
    )
    const actor = { kind: 'user', id: 'owner' } as const
    const startRequest = createAgentInstanceLifecyclePolicyRequest({
      actor,
      action: 'start',
      instance: created,
      requestDigest: createHash('sha256')
        .update(canonicalPolicyJson(request as never))
        .digest('hex')
    })
    const startGrant = authorization.createApprovalGrant({
      grantId: 'start-pause-test',
      request: startRequest,
      approvedBy: { kind: 'user', id: 'approver-1' },
      issuedAt: 10,
      expiresAt: 1010,
      maxUses: 1,
      idempotencyKey: 'start-pause-test'
    }).grant
    await service.start({
      instanceId: created.id,
      expectedRevision: 0,
      actor,
      request,
      idempotencyKey: 'start-resume',
      grantId: startGrant.grantId,
      expectedGrantUseCount: 0
    })
    const running = store.get(created.id)!
    const pauseInput = {
      instanceId: created.id,
      expectedRevision: running.revision,
      actor,
      idempotencyKey: 'pause'
    }
    await expect(service.pause(pauseInput)).rejects.toThrow(/awaiting-approval/)
    expect(store.get(created.id)?.state.status).toBe('running')
    const pauseRequest = createAgentInstanceLifecyclePolicyRequest({
      actor,
      action: 'pause',
      instance: running
    })
    const pauseGrant = authorization.createApprovalGrant({
      grantId: 'pause-grant',
      request: pauseRequest,
      approvedBy: { kind: 'user', id: 'approver-1' },
      issuedAt: 10,
      expiresAt: 1010,
      maxUses: 1,
      idempotencyKey: 'pause-grant'
    }).grant
    const paused = await service.pause({
      ...pauseInput,
      idempotencyKey: 'pause-resume',
      grantId: pauseGrant.grantId,
      expectedGrantUseCount: 0
    })
    const resumeInput = {
      instanceId: created.id,
      expectedRevision: paused.revision,
      actor,
      idempotencyKey: 'resume'
    }
    expect(() => service.resume(resumeInput)).toThrow(/awaiting-approval/)
    const resumeRequest = createAgentInstanceLifecyclePolicyRequest({
      actor,
      action: 'resume',
      instance: paused
    })
    const resumeGrant = authorization.createApprovalGrant({
      grantId: 'resume-grant',
      request: resumeRequest,
      approvedBy: { kind: 'user', id: 'approver-1' },
      issuedAt: 10,
      expiresAt: 1010,
      maxUses: 1,
      idempotencyKey: 'resume-grant'
    }).grant
    const resumed = service.resume({
      ...resumeInput,
      idempotencyKey: 'resume-granted',
      grantId: resumeGrant.grantId,
      expectedGrantUseCount: 0
    })
    expect(resumed.state.status).toBe('running')
    expect(
      await service.pause({
        ...pauseInput,
        idempotencyKey: 'pause-resume',
        grantId: pauseGrant.grantId,
        expectedGrantUseCount: 0
      })
    ).toEqual(paused)
    expect(
      service.resume({
        ...resumeInput,
        idempotencyKey: 'resume-granted',
        grantId: resumeGrant.grantId,
        expectedGrantUseCount: 0
      })
    ).toEqual(resumed)
    finishRun()
    await vi.waitFor(() => expect(store.get(created.id)?.state.status).toBe('stopped'))
    eventStore.close()
  })

  it('deny causes zero pause lifecycle side effects', async () => {
    const { eventStore, store, created } = setup('deny')
    const running = store.start({
      instanceId: created.id,
      expectedRevision: created.revision,
      transitionedAt: 2,
      idempotencyKey: 'direct-running'
    })
    const authorization = new MagicAgentPolicyAuthorizationService({
      store: eventStore,
      policyVersion: 'deny',
      storeId: 'deny',
      trustedApprovers: [{ kind: 'user', id: 'approver' }],
      rules: [
        {
          ruleId: 'deny',
          priority: 1,
          effect: 'deny',
          match: { origins: ['internal'], actions: ['agent-instance.pause'] },
          explanation: 'deny'
        }
      ]
    })
    const service = new ProductionAgentInstanceLifecycleService(
      store,
      authorization,
      async () => ({ runId: 'unused' }) as never
    )
    await expect(
      service.pause({
        instanceId: running.id,
        expectedRevision: running.revision,
        actor: { kind: 'user', id: 'owner' },
        idempotencyKey: 'pause'
      })
    ).rejects.toThrow(/denied/)
    expect(store.get(created.id)?.state.status).toBe('running')
    eventStore.close()
  })

  it('restart-recovers durable paused instances as interrupted stopped runs', () => {
    const { eventStore, store, created } = setup()
    const running = store.start({
      instanceId: created.id,
      expectedRevision: 0,
      transitionedAt: 2,
      idempotencyKey: 'running'
    })
    const paused = store.pause({
      instanceId: created.id,
      expectedRevision: running.revision,
      transitionedAt: 3,
      idempotencyKey: 'paused'
    })
    const service = new ProductionAgentInstanceLifecycleService(
      store,
      allowedAuthorization,
      async () => ({ runId: 'unused' }) as never,
      () => 20
    )
    const recovered = service.recoverInterrupted()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].state.status).toBe('stopped')
    expect(recovered[0].revision).toBe(paused.revision + 1)
    eventStore.close()
  })

  it('requires and resumes a real approval before start side effects', async () => {
    const { eventStore, store, authorization, created } = setup()
    const run = vi.fn(async () => completedRun('run-1'))
    const service = new ProductionAgentInstanceLifecycleService(store, authorization, run, () => 10)
    const input = {
      instanceId: created.id,
      expectedRevision: 0,
      actor: { kind: 'user', id: 'user-1' } as const,
      request,
      idempotencyKey: 'approved-start'
    }
    await expect(service.start(input)).rejects.toThrow(/awaiting-approval/)
    expect(store.get(created.id)?.state.status).toBe('created')
    expect(run).not.toHaveBeenCalled()
    const policyRequest = createAgentInstanceLifecyclePolicyRequest({
      actor: input.actor,
      action: 'start',
      instance: created,
      requestDigest: createHash('sha256')
        .update(canonicalPolicyJson(request as never))
        .digest('hex')
    })
    const grant = authorization.createApprovalGrant({
      grantId: 'grant-start',
      request: policyRequest,
      approvedBy: { kind: 'user', id: 'approver-1' },
      issuedAt: 10,
      expiresAt: 1_010,
      maxUses: 1,
      idempotencyKey: 'grant-start'
    }).grant
    await service.start({ ...input, grantId: grant.grantId, expectedGrantUseCount: 0 })
    await vi.waitFor(() => expect(store.get(created.id)?.state.status).toBe('stopped'))
    expect(run).toHaveBeenCalledTimes(1)
    eventStore.close()
  })

  it('authorizes and consumes before durable start and bounded dispatch', async () => {
    const { eventStore, store, created } = setup()
    let release!: () => void
    const run = vi.fn(
      () =>
        new Promise<MagicAgentPlatformRunResp>((resolve) => {
          release = () => resolve(completedRun('run-1'))
        })
    )
    const service = new ProductionAgentInstanceLifecycleService(
      store,
      allowedAuthorization,
      run,
      incrementingClock()
    )
    await service.start({
      instanceId: created.id,
      expectedRevision: 0,
      actor: { kind: 'user', id: 'user-1' },
      request,
      idempotencyKey: 'start'
    })
    expect(store.get(created.id)?.state.status).toBe('running')
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', timeoutMs: 100, allowedToolNames: ['read'] }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    release()
    await vi.waitFor(() => expect(store.get(created.id)?.state.status).toBe('stopped'))
    eventStore.close()
  })

  it('deny causes zero lifecycle and runtime side effects', async () => {
    const { eventStore, store, authorization, created } = setup('deny')
    const run = vi.fn()
    const service = new ProductionAgentInstanceLifecycleService(store, authorization, run)
    await expect(
      service.start({
        instanceId: created.id,
        expectedRevision: 0,
        actor: { kind: 'user', id: 'user-1' },
        request,
        idempotencyKey: 'start'
      })
    ).rejects.toThrow(/denied/)
    expect(store.get(created.id)?.state.status).toBe('created')
    expect(run).not.toHaveBeenCalled()
    eventStore.close()
  })

  it('stop aborts active execution and leaves a durable stopped state', async () => {
    const { eventStore, store, created } = setup()
    const run = vi.fn(
      (_req, options: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true
          })
        )
    )
    const service = new ProductionAgentInstanceLifecycleService(
      store,
      allowedAuthorization,
      run,
      incrementingClock()
    )
    await service.start({
      instanceId: created.id,
      expectedRevision: 0,
      actor: { kind: 'user', id: 'user-1' },
      request,
      idempotencyKey: 'start'
    })
    await service.stop({
      instanceId: created.id,
      expectedRevision: 1,
      actor: { kind: 'user', id: 'user-1' },
      idempotencyKey: 'stop'
    })
    expect(store.get(created.id)?.state.status).toBe('stopped')
    eventStore.close()
  })

  it('reconciles persisted running instances as interrupted after restart', () => {
    const { eventStore, store, created } = setup()
    store.start({
      instanceId: created.id,
      expectedRevision: 0,
      transitionedAt: 2,
      idempotencyKey: 'start-direct'
    })
    const service = new ProductionAgentInstanceLifecycleService(
      store,
      allowedAuthorization,
      vi.fn()
    )
    expect(service.recoverInterrupted(3)[0]?.state.status).toBe('stopped')
    eventStore.close()
  })
})
