import { describe, expect, it, vi } from 'vitest'
import type {
  MagicAgentPlatformRunReq,
  MagicAgentPlatformRunResp
} from '../../../shared/api/svcMagicAgentPlatform'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => process.cwd()), getVersion: vi.fn(() => '1') }
}))

import { createMagicAgentConfigContent } from './persistentAgentConfigStore'
import { MagicAgentPlatformSvcImpl } from '../../api/svcMagicAgentPlatformImpl'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import {
  AGENT_INSTANCE_INVOCATION,
  ProductionAgentInstanceLifecycle
} from './productionAgentInstanceLifecycleOwner'

const completedRun = (): MagicAgentPlatformRunResp => ({
  runId: 'run',
  agentId: 'agent',
  status: 'completed',
  content: 'ok',
  messages: [],
  toolCalls: [],
  events: [],
  startedAt: 1,
  finishedAt: 2
})

describe('ProductionAgentInstanceLifecycle owner', () => {
  it('owns the shared store, reconciles restart state, and closes active work', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const authorization = new MagicAgentPolicyAuthorizationService({
      store: eventStore,
      policyVersion: 'm6',
      storeId: 'm6-owner',
      trustedApprovers: [{ kind: 'user', id: 'approver' }],
      rules: [
        {
          ruleId: 'deny',
          priority: 1,
          effect: 'deny',
          match: { origins: ['internal'] },
          explanation: 'deny'
        }
      ]
    })
    const runAgent = vi.fn()
    const lifecycle = new ProductionAgentInstanceLifecycle({
      eventStore,
      authorization,
      platformService: { runAgent },
      now: () => 10
    })
    expect(lifecycle.configStore.list()).toEqual([])
    const created = lifecycle.store.create({
      instance: {
        id: 'instance-1',
        name: 'Worker',
        definitionId: 'agent-1',
        depth: 0,
        configVersion: 'v1',
        status: 'created',
        limits: {
          maxChildren: 1,
          maxDepth: 1,
          maxConcurrency: 1,
          maxRuntimeMs: 100,
          allowedToolNames: [],
          workspaceRoots: []
        }
      },
      createdAt: 1,
      idempotencyKey: 'create'
    })
    lifecycle.store.start({
      instanceId: created.id,
      expectedRevision: 0,
      transitionedAt: 2,
      idempotencyKey: 'running'
    })
    lifecycle.start()
    expect(lifecycle.store.get(created.id)?.state.status).toBe('stopped')
    await lifecycle.close()
    eventStore.close()
    expect(AGENT_INSTANCE_INVOCATION).toMatchObject({
      methodName: 'magic-agent.instance.run',
      isMainFrame: true
    })
  })

  it('rejects unbound RuntimeChannel runs before authorization or dispatch', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const authorization = { authorize: vi.fn(), consumeExecutionPermit: vi.fn() }
    const runAgent = vi.fn()
    const lifecycle = new ProductionAgentInstanceLifecycle({
      eventStore,
      authorization: authorization as unknown as MagicAgentPolicyAuthorizationService,
      platformService: { runAgent }
    })
    const instance = lifecycle.store.create({
      instance: {
        id: 'channel-bound',
        name: 'Channel bound',
        definitionId: 'definition',
        depth: 0,
        configVersion: 'v1',
        status: 'created',
        limits: {
          maxChildren: 1,
          maxDepth: 1,
          maxConcurrency: 1,
          maxRuntimeMs: 500,
          allowedToolNames: [],
          workspaceRoots: []
        }
      },
      createdAt: 1,
      idempotencyKey: 'instance'
    })
    lifecycle.configStore.create({
      config: createMagicAgentConfigContent({
        version: 'v1',
        definitionId: 'definition',
        model: { profileId: 'model' },
        systemPrompt: 'safe',
        inference: {},
        tools: { allowedToolNames: [] },
        memory: { allowHistory: false, contextMessageLimit: 0, scope: 'session' },
        policy: { policyIds: [], workspaceRoots: [] },
        channels: { channelIds: ['allowed'] },
        budgets: { maxRuntimeMs: 100 },
        createdAt: 1,
        createdBy: { kind: 'user', id: 'owner' }
      }),
      idempotencyKey: 'config'
    })
    await expect(
      lifecycle.service.start({
        instanceId: instance.id,
        expectedRevision: 0,
        actor: { kind: 'system', id: 'runtime-channel-wakeup' },
        request: {
          text: 'wake',
          route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'denied' }
        },
        idempotencyKey: 'denied'
      })
    ).rejects.toThrow(/not allowed/)
    expect(authorization.authorize).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
    await lifecycle.close()
    eventStore.close()
  })

  it('applies active immutable config and rollback to subsequent production runs', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const authorization = {
      authorize: vi.fn(() => ({ status: 'authorized', permit: { token: 'permit' } })),
      consumeExecutionPermit: vi.fn()
    } as never
    const runAgent = vi.fn(async (_request: MagicAgentPlatformRunReq) => completedRun())
    let now = 10
    const lifecycle = new ProductionAgentInstanceLifecycle({
      eventStore,
      authorization,
      platformService: { runAgent },
      now: () => now++
    })
    const instance = lifecycle.store.create({
      instance: {
        id: 'configured',
        name: 'Configured',
        definitionId: 'definition',
        depth: 0,
        configVersion: 'v1',
        status: 'created',
        limits: {
          maxChildren: 1,
          maxDepth: 1,
          maxConcurrency: 1,
          maxRuntimeMs: 500,
          allowedToolNames: ['read', 'write'],
          workspaceRoots: []
        }
      },
      createdAt: 1,
      idempotencyKey: 'instance'
    })
    for (const [version, prompt, tools] of [
      ['v1', 'old prompt', ['read']],
      ['v2', 'new prompt', ['read', 'write']]
    ] as const)
      lifecycle.configStore.create({
        config: createMagicAgentConfigContent({
          version,
          definitionId: 'definition',
          model: { profileId: `model-${version}` },
          systemPrompt: prompt,
          inference: { maxToolIterations: 4 },
          tools: { allowedToolNames: tools },
          memory: { allowHistory: false, contextMessageLimit: 1, scope: 'session' },
          policy: { policyIds: [], workspaceRoots: [] },
          channels: { channelIds: ['private'] },
          budgets: { maxRuntimeMs: version === 'v1' ? 200 : 300, maxToolCalls: 3 },
          createdAt: 1,
          createdBy: { kind: 'user', id: 'owner' }
        }),
        idempotencyKey: version
      })
    const request = {
      text: 'work',
      route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'private' } as const,
      allowedToolNames: ['read', 'write'],
      timeoutMs: 400,
      maxToolIterations: 5
    }
    await lifecycle.service.start({
      instanceId: instance.id,
      expectedRevision: 0,
      actor: { kind: 'user', id: 'owner' },
      request,
      idempotencyKey: 'start-v1'
    })
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(lifecycle.store.get(instance.id)?.state.status).toBe('stopped'))
    const firstRunRequest = runAgent.mock.calls.at(0)?.[0]
    expect(firstRunRequest).toMatchObject({
      agentId: 'definition',
      profileId: 'model-v1',
      systemPrompt: 'old prompt',
      allowedToolNames: ['read'],
      timeoutMs: 200,
      maxToolIterations: 3,
      memory: { allowHistory: false, contextMessageLimit: 1, scope: 'session' }
    })
    const stopped = lifecycle.store.get(instance.id)!
    lifecycle.store.stageConfig({
      id: instance.id,
      expectedRevision: stopped.revision,
      configVersion: 'v2',
      stagedAt: 20,
      idempotencyKey: 'stage'
    })
    const staged = lifecycle.store.get(instance.id)!
    lifecycle.store.activateStagedConfig({
      id: instance.id,
      expectedRevision: staged.revision,
      activatedAt: 21,
      idempotencyKey: 'activate'
    })
    const active = lifecycle.store.get(instance.id)!
    lifecycle.store.rollbackConfig({
      id: instance.id,
      expectedRevision: active.revision,
      rolledBackAt: 22,
      idempotencyKey: 'rollback'
    })
    const rolledBack = lifecycle.store.get(instance.id)!
    await vi.waitFor(() => expect(lifecycle.store.get(instance.id)?.state.status).toBe('stopped'))
    now = 30
    const ready = lifecycle.store.get(instance.id)!
    await lifecycle.service.start({
      instanceId: instance.id,
      expectedRevision: ready.revision,
      actor: { kind: 'user', id: 'owner' },
      request,
      idempotencyKey: 'start-rollback'
    })
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2))
    expect(runAgent.mock.calls[1]?.[0]).toMatchObject({
      profileId: 'model-v1',
      systemPrompt: 'old prompt',
      allowedToolNames: ['read'],
      timeoutMs: 200,
      maxToolIterations: 3,
      memory: { allowHistory: false, contextMessageLimit: 1, scope: 'session' }
    })
    await lifecycle.close()
    eventStore.close()
  })

  it('forwards lifecycle abort through the real service implementation', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const authorization = {
      authorize: vi.fn(() => ({ status: 'authorized', permit: { token: 'permit' } })),
      consumeExecutionPermit: vi.fn()
    } as never
    let forwardedSignal: AbortSignal | undefined
    const adapterRun = vi.fn((_req, options?: { signal?: AbortSignal }) => {
      forwardedSignal = options?.signal
      return new Promise<never>((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true
        })
      )
    })
    process.env.MAGICPOT_MAGICAGENT_PLATFORM = '1'
    const platformService = new MagicAgentPlatformSvcImpl({
      adapter: {
        listAgents: () => [{ id: 'agent-1', name: 'Agent' }],
        runAgent: adapterRun
      } as never,
      routeAuthorizer: (route) => route as never,
      packageStore: { listAgents: vi.fn(async () => []) } as never
    })
    const lifecycle = new ProductionAgentInstanceLifecycle({
      eventStore,
      authorization,
      platformService,
      now: (() => {
        let now = 10
        return () => now++
      })()
    })
    const created = lifecycle.store.create({
      instance: {
        id: 'instance-2',
        name: 'Worker',
        definitionId: 'agent-1',
        depth: 0,
        configVersion: 'v1',
        status: 'created',
        limits: {
          maxChildren: 1,
          maxDepth: 1,
          maxConcurrency: 1,
          maxRuntimeMs: 100,
          allowedToolNames: [],
          workspaceRoots: []
        }
      },
      createdAt: 1,
      idempotencyKey: 'create-2'
    })
    await lifecycle.service.start({
      instanceId: created.id,
      expectedRevision: 0,
      actor: { kind: 'user', id: 'user-1' },
      request: {
        agentId: 'ignored',
        text: 'work',
        route: { channel: 'm6', scopeType: 'dm', scopeId: created.id }
      },
      idempotencyKey: 'start-2'
    })
    await vi.waitFor(() => expect(forwardedSignal).toBeInstanceOf(AbortSignal))
    await lifecycle.service.stop({
      instanceId: created.id,
      expectedRevision: 1,
      actor: { kind: 'user', id: 'user-1' },
      idempotencyKey: 'stop-2'
    })
    expect(forwardedSignal?.aborted).toBe(true)
    expect(lifecycle.store.get(created.id)?.state.status).toBe('stopped')
    eventStore.close()
  })
})
