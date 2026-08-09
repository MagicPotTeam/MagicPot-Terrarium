import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import {
  createMagicAgentConfigContent,
  PersistentAgentConfigStore
} from './persistentAgentConfigStore'
import { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import {
  AgentInstanceCommandError,
  AgentInstanceCommandService
} from './agentInstanceCommandService'
import type { ProductionAgentInstanceLifecycleService } from './productionAgentInstanceLifecycle'

const state = (
  id: string,
  limits = {
    maxChildren: 1,
    maxDepth: 2,
    maxConcurrency: 1,
    maxRuntimeMs: 100,
    allowedToolNames: ['read'],
    workspaceRoots: ['C:\\workspace']
  }
) => ({
  id,
  name: id,
  definitionId: `definition-${id}`,
  depth: 0,
  configVersion: 'v1',
  status: 'created' as const,
  limits
})
const setup = () => {
  const eventStore = new MagicAgentEventStore(':memory:')
  const store = new PersistentAgentInstanceStore(eventStore)
  const lifecycle = {
    quiesceForReplacement: vi.fn(async (instanceId: string) => store.get(instanceId)!),
    isAtSafePoint: vi.fn(() => true),
    authorizeLifecycleMutation: vi.fn(() => true),
    authorizeConfigMutation: vi.fn(() => true),
    activateStagedConfigAtSafePoint: vi.fn(),
    rollbackConfigAtSafePoint: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined)
  }
  return {
    eventStore,
    store,
    lifecycle,
    service: new AgentInstanceCommandService(
      store,
      lifecycle as unknown as ProductionAgentInstanceLifecycleService,
      new PersistentAgentConfigStore(eventStore)
    )
  }
}

describe('AgentInstanceCommandService', () => {
  it('preserves Team and RuntimeChannel references because replace keeps AgentInstance identity', async () => {
    const { eventStore, lifecycle, service } = setup()
    const created = service.createRoot({
      actor: { kind: 'user', id: 'owner' },
      instance: state('stable-id'),
      createdAt: 1,
      idempotencyKey: 'create'
    })
    service.configStore!.create({
      config: createMagicAgentConfigContent({
        version: 'v2',
        definitionId: 'new-definition',
        model: { profileId: 'model' },
        systemPrompt: 'new',
        inference: {},
        tools: { allowedToolNames: [] },
        memory: { allowHistory: false, contextMessageLimit: 0, scope: 'session' },
        policy: { policyIds: [], workspaceRoots: [] },
        channels: { channelIds: ['channel'] },
        budgets: { maxRuntimeMs: 100 },
        createdAt: 2,
        createdBy: { kind: 'user', id: 'owner' }
      }),
      idempotencyKey: 'config'
    })
    const externalRefs = {
      teamMember: { agentInstanceId: created.id },
      channelMember: { agentInstanceId: created.id }
    }
    const replaced = await service.replace({
      actor: { kind: 'user', id: 'owner' },
      instanceId: created.id,
      expectedRevision: created.revision,
      definitionId: 'new-definition',
      name: 'New',
      configVersion: 'v2',
      replacedAt: 3,
      idempotencyKey: 'replace'
    })
    expect(replaced.id).toBe(created.id)
    expect(externalRefs.teamMember.agentInstanceId).toBe(replaced.id)
    expect(externalRefs.channelMember.agentInstanceId).toBe(replaced.id)
    expect(lifecycle.authorizeLifecycleMutation).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'replace' })
    )
    eventStore.close()
  })

  it('Policy-gates safe-point Agent replacement with self/user ownership and replay', async () => {
    const { eventStore, lifecycle, service } = setup()
    const created = service.createRoot({
      actor: { kind: 'user', id: 'owner' },
      instance: state('replace'),
      createdAt: 1,
      idempotencyKey: 'create'
    })
    service.configStore!.create({
      config: createMagicAgentConfigContent({
        version: 'v2',
        definitionId: 'definition-new',
        model: { profileId: 'model' },
        systemPrompt: 'new',
        inference: {},
        tools: { allowedToolNames: [] },
        memory: { allowHistory: false, contextMessageLimit: 0, scope: 'session' },
        policy: { policyIds: [], workspaceRoots: [] },
        channels: { channelIds: [] },
        budgets: { maxRuntimeMs: 100 },
        createdAt: 2,
        createdBy: { kind: 'user', id: 'owner' }
      }),
      idempotencyKey: 'config'
    })
    await expect(
      service.replace({
        actor: { kind: 'agent', id: 'other' },
        instanceId: created.id,
        expectedRevision: created.revision,
        definitionId: 'definition-new',
        name: 'New',
        configVersion: 'v2',
        replacedAt: 3,
        idempotencyKey: 'replace'
      })
    ).rejects.toThrow(/itself/)
    const input = {
      actor: { kind: 'user' as const, id: 'owner' },
      instanceId: created.id,
      expectedRevision: created.revision,
      definitionId: 'definition-new',
      name: 'New',
      configVersion: 'v2',
      replacedAt: 3,
      idempotencyKey: 'replace'
    }
    const replaced = await service.replace(input)
    expect(replaced.state.definitionId).toBe('definition-new')
    ;(lifecycle.authorizeLifecycleMutation as ReturnType<typeof vi.fn>).mockClear()
    await expect(service.replace(input)).resolves.toEqual(replaced)
    expect(lifecycle.authorizeLifecycleMutation).not.toHaveBeenCalled()
    eventStore.close()
  })

  it('routes config stage/activate/rollback through the lifecycle safe-point boundary', () => {
    const { eventStore, store, lifecycle, service } = setup()
    const root = store.create({ instance: state('root'), createdAt: 1, idempotencyKey: 'root' })
    for (const [version, tools] of [
      ['v1', ['read']],
      ['v2', ['read', 'write']]
    ] as const)
      service.configStore!.create({
        config: createMagicAgentConfigContent({
          version,
          definitionId: root.state.definitionId,
          model: { profileId: 'default' },
          systemPrompt: version,
          inference: {},
          tools: { allowedToolNames: tools },
          memory: { allowHistory: false, contextMessageLimit: 1, scope: 'instance' },
          policy: { policyIds: [], workspaceRoots: [] },
          channels: { channelIds: [] },
          budgets: { maxRuntimeMs: 100 },
          createdAt: 1,
          createdBy: { kind: 'user', id: 'owner' }
        }),
        idempotencyKey: version
      })
    const actor = { kind: 'user', id: 'owner' } as const
    const staged = service.stageConfig({
      actor,
      instanceId: root.id,
      expectedRevision: root.revision,
      configVersion: 'v2',
      stagedAt: 2,
      idempotencyKey: 'stage'
    })
    expect(staged.state.pendingConfigVersion).toBe('v2')
    ;(lifecycle.activateStagedConfigAtSafePoint as ReturnType<typeof vi.fn>).mockReturnValue({
      ...staged,
      revision: 2,
      state: { ...staged.state, configVersion: 'v2' }
    })
    ;(lifecycle.rollbackConfigAtSafePoint as ReturnType<typeof vi.fn>).mockReturnValue({
      ...staged,
      revision: 3,
      state: { ...staged.state, configVersion: 'v1' }
    })
    expect(
      service.activateStagedConfig({
        actor,
        instanceId: root.id,
        expectedRevision: staged.revision,
        activatedAt: 3,
        idempotencyKey: 'activate'
      }).state.configVersion
    ).toBe('v2')
    expect(lifecycle.authorizeConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'activate-config',
        configVersion: 'v2',
        privilegeChange: 'expansion'
      })
    )
    expect(
      service.rollbackConfig({
        actor,
        instanceId: root.id,
        expectedRevision: 2,
        rolledBackAt: 4,
        idempotencyKey: 'rollback'
      }).state.configVersion
    ).toBe('v1')
    eventStore.close()
  })

  it('Policy-gates immutable config version creation and exact replay', () => {
    const { eventStore, lifecycle, service } = setup()
    service.createRoot({
      actor: { kind: 'user', id: 'owner' },
      instance: state('managed'),
      createdAt: 1,
      idempotencyKey: 'managed'
    })
    const config = createMagicAgentConfigContent({
      version: 'config-v2',
      definitionId: 'definition-managed',
      model: { profileId: 'default' },
      systemPrompt: 'updated',
      inference: {},
      tools: { allowedToolNames: ['read'] },
      memory: { allowHistory: false, contextMessageLimit: 10, scope: 'instance' },
      policy: { policyIds: ['base'], workspaceRoots: ['/workspace'] },
      channels: { channelIds: [] },
      budgets: { maxRuntimeMs: 1000 },
      createdAt: 2,
      createdBy: { kind: 'user', id: 'owner' }
    })
    ;(lifecycle.authorizeConfigMutation as ReturnType<typeof vi.fn>).mockClear()
    const created = service.createConfigVersion({ config, idempotencyKey: 'config-create' })
    expect(created.state.systemPrompt).toBe('updated')
    expect(lifecycle.authorizeConfigMutation).toHaveBeenCalledOnce()
    ;(lifecycle.authorizeConfigMutation as ReturnType<typeof vi.fn>).mockClear()
    expect(service.createConfigVersion({ config, idempotencyKey: 'config-create' })).toEqual(
      created
    )
    expect(lifecycle.authorizeConfigMutation).not.toHaveBeenCalled()
    eventStore.close()
  })

  it('rejects config creation before durable mutation when Policy denies', () => {
    const { eventStore, lifecycle, service } = setup()
    service.createRoot({
      actor: { kind: 'user', id: 'owner' },
      instance: state('managed-deny'),
      createdAt: 1,
      idempotencyKey: 'managed-deny'
    })
    ;(lifecycle.authorizeConfigMutation as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('denied')
    })
    const config = createMagicAgentConfigContent({
      version: 'config-denied',
      definitionId: 'definition-managed-deny',
      model: { profileId: 'default' },
      systemPrompt: 'denied',
      inference: {},
      tools: { allowedToolNames: [] },
      memory: { allowHistory: false, contextMessageLimit: 1, scope: 'instance' },
      policy: { policyIds: [], workspaceRoots: [] },
      channels: { channelIds: [] },
      budgets: { maxRuntimeMs: 100 },
      createdAt: 2,
      createdBy: { kind: 'user', id: 'owner' }
    })
    expect(() => service.createConfigVersion({ config, idempotencyKey: 'denied' })).toThrow(
      AgentInstanceCommandError
    )
    expect(service.configStore?.get(config.version)).toBeUndefined()
    eventStore.close()
  })

  it('Policy-gates root creation before durable mutation', () => {
    const { eventStore, store, lifecycle, service } = setup()
    ;(lifecycle.authorizeLifecycleMutation as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() =>
      service.createRoot({
        actor: { kind: 'user', id: 'user' },
        instance: state('denied'),
        createdAt: 1,
        idempotencyKey: 'denied'
      })
    ).toThrow(AgentInstanceCommandError)
    expect(store.get('denied')).toBeUndefined()
    eventStore.close()
  })

  it('replays root create and remove before Policy or stale-state validation', () => {
    const { eventStore, lifecycle, service } = setup()
    const input = {
      actor: { kind: 'user', id: 'user' } as const,
      instance: state('replay'),
      createdAt: 1,
      idempotencyKey: 'create-replay'
    }
    const created = service.createRoot(input)
    ;(lifecycle.authorizeLifecycleMutation as ReturnType<typeof vi.fn>).mockClear()
    expect(service.createRoot(input)).toEqual(created)
    expect(lifecycle.authorizeLifecycleMutation).not.toHaveBeenCalled()
    const removed = service.remove({
      actor: input.actor,
      instanceId: created.id,
      expectedRevision: created.revision,
      removedAt: 2,
      idempotencyKey: 'remove-replay'
    })
    ;(lifecycle.authorizeLifecycleMutation as ReturnType<typeof vi.fn>).mockClear()
    expect(
      service.remove({
        actor: input.actor,
        instanceId: created.id,
        expectedRevision: created.revision,
        removedAt: 2,
        idempotencyKey: 'remove-replay'
      })
    ).toEqual(removed)
    expect(lifecycle.authorizeLifecycleMutation).not.toHaveBeenCalled()
    eventStore.close()
  })

  it('creates children with inherited parent/depth identity', () => {
    const { eventStore, service, lifecycle } = setup()
    const parent = service.createRoot({
      actor: { kind: 'user', id: 'user' },
      instance: state('parent'),
      createdAt: 1,
      idempotencyKey: 'parent'
    })
    const child = service.createChild({
      actor: { kind: 'user', id: 'user' },
      parentInstanceId: parent.id,
      parentExpectedRevision: 0,
      instance: state('child'),
      createdAt: 2,
      idempotencyKey: 'child'
    })
    const replay = service.createChild({
      actor: { kind: 'user', id: 'user' },
      parentInstanceId: parent.id,
      parentExpectedRevision: parent.revision,
      instance: state('child'),
      createdAt: 2,
      idempotencyKey: 'child'
    })
    expect(replay).toEqual(child)
    expect(lifecycle.authorizeLifecycleMutation).toHaveBeenCalledTimes(2)
    expect(child.state).toMatchObject({ parentInstanceId: 'parent', depth: 1, status: 'created' })
    eventStore.close()
  })

  it('rejects child count, depth, tool and workspace privilege expansion', () => {
    const { eventStore, service } = setup()
    const parent = service.createRoot({
      actor: { kind: 'user', id: 'user' },
      instance: state('parent'),
      createdAt: 1,
      idempotencyKey: 'parent'
    })
    service.createChild({
      actor: { kind: 'user', id: 'user' },
      parentInstanceId: parent.id,
      parentExpectedRevision: 0,
      instance: state('child'),
      createdAt: 2,
      idempotencyKey: 'child'
    })
    expect(() =>
      service.createChild({
        actor: { kind: 'user', id: 'user' },
        parentInstanceId: parent.id,
        parentExpectedRevision: 1,
        instance: state('extra'),
        createdAt: 3,
        idempotencyKey: 'extra'
      })
    ).toThrow(AgentInstanceCommandError)
    const other = setup()
    const otherParent = other.service.createRoot({
      actor: { kind: 'user', id: 'user' },
      instance: state('other-parent', { ...state('x').limits, maxChildren: 2 }),
      createdAt: 1,
      idempotencyKey: 'other-parent'
    })
    const broad = state('broad', { ...state('x').limits, allowedToolNames: ['read', 'write'] })
    expect(() =>
      other.service.createChild({
        actor: { kind: 'user', id: 'user' },
        parentInstanceId: otherParent.id,
        parentExpectedRevision: 0,
        instance: broad,
        createdAt: 3,
        idempotencyKey: 'broad'
      })
    ).toThrow(/limit/i)
    other.eventStore.close()
    eventStore.close()
  })

  it('enforces sibling concurrency before lifecycle start', async () => {
    const { eventStore, store, lifecycle, service } = setup()
    const parent = service.createRoot({
      actor: { kind: 'user', id: 'user' },
      instance: state('parent', { ...state('x').limits, maxChildren: 2 }),
      createdAt: 1,
      idempotencyKey: 'parent'
    })
    const child1 = service.createChild({
      actor: { kind: 'user', id: 'user' },
      parentInstanceId: parent.id,
      parentExpectedRevision: 0,
      instance: state('child-1'),
      createdAt: 2,
      idempotencyKey: 'child-1'
    })
    const child2 = service.createChild({
      actor: { kind: 'user', id: 'user' },
      parentInstanceId: parent.id,
      parentExpectedRevision: 1,
      instance: state('child-2'),
      createdAt: 3,
      idempotencyKey: 'child-2'
    })
    store.start({
      instanceId: child1.id,
      expectedRevision: 0,
      transitionedAt: 4,
      idempotencyKey: 'running'
    })
    await expect(
      service.start({
        instanceId: child2.id,
        expectedRevision: 0,
        actor: { kind: 'user', id: 'user' },
        request: {
          agentId: 'ignored',
          text: 'x',
          route: { channel: 'm6', scopeType: 'dm', scopeId: child2.id }
        },
        idempotencyKey: 'start'
      })
    ).rejects.toMatchObject({ code: 'limit-exceeded' })
    expect(lifecycle.start).not.toHaveBeenCalled()
    eventStore.close()
  })

  it('prevents removing a parent with non-removed children', () => {
    const { eventStore, service } = setup()
    const parent = service.createRoot({
      actor: { kind: 'user', id: 'user' },
      instance: state('parent'),
      createdAt: 1,
      idempotencyKey: 'parent'
    })
    service.createChild({
      actor: { kind: 'user', id: 'user' },
      parentInstanceId: parent.id,
      parentExpectedRevision: 0,
      instance: state('child'),
      createdAt: 2,
      idempotencyKey: 'child'
    })
    expect(() =>
      service.remove({
        actor: { kind: 'user', id: 'user' },
        instanceId: parent.id,
        expectedRevision: 0,
        removedAt: 3,
        idempotencyKey: 'remove'
      })
    ).toThrow(/active children/)
    eventStore.close()
  })
})
