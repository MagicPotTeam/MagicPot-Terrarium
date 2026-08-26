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
