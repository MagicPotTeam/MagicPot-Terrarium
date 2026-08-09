import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MagicAgentPlatformRunResp } from '../../../shared/api/svcMagicAgentPlatform'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase()
  return {
    ...actual,
    default: {
      ...actual,
      realpathSync: (
        value: Parameters<typeof actual.realpathSync>[0],
        options?: Parameters<typeof actual.realpathSync>[1]
      ) =>
        normalize(String(value)).includes('/m6-e2e-')
          ? value
          : actual.realpathSync(value, options as never),
      lstatSync: (
        value: Parameters<typeof actual.lstatSync>[0],
        options?: Parameters<typeof actual.lstatSync>[1]
      ) => {
        const stat = actual.lstatSync(value, options as never)
        return normalize(String(value)).includes('/m6-e2e-') || !stat.isSymbolicLink()
          ? stat
          : Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
              isSymbolicLink: () => false
            })
      }
    }
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => process.cwd()), getVersion: vi.fn(() => '1') }
}))

import { MagicAgentEventStore } from '../persistence/eventStore'
import { ProductionRuntimeChannelLifecycle } from '../channels/productionRuntimeChannelLifecycle'
import { createMagicAgentConfigContent } from './persistentAgentConfigStore'
import { ProductionAgentInstanceLifecycle } from './productionAgentInstanceLifecycleOwner'

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

const files: string[] = []
afterEach(() => {
  for (const file of files.splice(0)) {
    try {
      rmSync(file, { recursive: true, force: true })
    } catch {
      /* Windows SQLite handles may close asynchronously. */
    }
  }
})

describe('M6 production E2E', () => {
  it('persists a three-Agent Team, wired channels, cooperative execution, config and replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm6-e2e-'))
    const databasePath = join(root, 'events.sqlite')
    files.push(root)
    let clock = 100
    const now = () => clock++
    const actor = { kind: 'user', id: 'owner' } as const
    const authorize = (_store: MagicAgentEventStore) =>
      ({
        authorize: vi.fn(() => ({ status: 'authorized', permit: { token: 'm6-e2e' } })),
        consumeExecutionPermit: vi.fn()
      }) as never
    const limits = {
      maxChildren: 2,
      maxDepth: 2,
      maxConcurrency: 2,
      maxRuntimeMs: 1_000,
      allowedToolNames: ['read', 'write'],
      workspaceRoots: []
    }
    const config = (version: string, definitionId: string, tools: readonly string[]) =>
      createMagicAgentConfigContent({
        version,
        definitionId,
        model: { profileId: `model-${version}` },
        systemPrompt: `prompt-${version}`,
        inference: { maxToolIterations: 2 },
        tools: { allowedToolNames: tools },
        memory: { allowHistory: false, contextMessageLimit: 1, scope: 'session' },
        policy: { policyIds: [], workspaceRoots: [] },
        channels: { channelIds: ['source', 'target'] },
        budgets: { maxRuntimeMs: 500, maxToolCalls: 2 },
        createdAt: now(),
        createdBy: actor
      })

    let eventStore = new MagicAgentEventStore(databasePath)
    let authorization = authorize(eventStore)
    let releaseActive: (() => void) | undefined
    let releaseRun: (() => void) | undefined
    const agents = new ProductionAgentInstanceLifecycle({
      eventStore,
      authorization,
      platformService: { runAgent: vi.fn() },
      runAgent: async (_request, { cooperativeExecution }) => {
        const leave = cooperativeExecution.enter('assistant-turn')
        await new Promise<void>((resolveRun) => {
          releaseRun = resolveRun
          releaseActive = () => {
            leave()
          }
        })
        await cooperativeExecution.checkpoint('tool-invocation')
        return completedRun()
      },
      now
    })
    const channels = new ProductionRuntimeChannelLifecycle({
      eventStore,
      authorization,
      now,
      pollIntervalMs: 60_000
    })

    const instances = [
      ['agent-1', 'definition-alpha'],
      ['agent-2', 'definition-beta'],
      ['agent-3', 'definition-replacement']
    ].map(([id, definitionId]) =>
      agents.commands.createRoot({
        actor,
        instance: {
          id,
          name: id,
          definitionId,
          depth: 0,
          configVersion: `${id}-v1`,
          status: 'created',
          limits
        },
        createdAt: now(),
        idempotencyKey: `create-${id}`
      })
    )
    expect(agents.commands.list()).toHaveLength(3)
    for (const item of [
      config('agent-3-v1', 'definition-replacement', ['read']),
      config('agent-2-v1', 'definition-beta', ['read']),
      config('agent-1-v1', 'definition-alpha', ['read']),
      config('agent-1-v2', 'definition-alpha', ['read', 'write']),
      config('replacement-v1', 'definition-replacement', ['read'])
    ])
      agents.configStore.create({ config: item, idempotencyKey: `config-${item.version}` })

    let team = agents.teams.create({
      actor,
      team: {
        id: 'team',
        name: 'M6 Team',
        ownerId: actor.id,
        status: 'active',
        members: [],
        createdAt: now(),
        createdBy: actor
      },
      idempotencyKey: 'team-create'
    })
    for (const [index, instance] of instances.entries())
      team = agents.teams.addMember({
        actor,
        teamId: team.id,
        expectedRevision: team.revision,
        member: {
          memberId: `member-${index + 1}`,
          agentInstanceId: instance.id,
          role: index === 0 ? 'leader' : 'member',
          joinedAt: now(),
          addedBy: actor
        },
        idempotencyKey: `team-${instance.id}`
      })
    expect(team.state.members.map((member) => member.agentInstanceId)).toEqual([
      'agent-1',
      'agent-2',
      'agent-3'
    ])

    let source = channels.commands.create({
      actor,
      channel: { id: 'source', name: 'Source', mode: 'queue', capacity: 10, members: [] },
      createdAt: now(),
      idempotencyKey: 'source'
    })
    let target = channels.commands.create({
      actor,
      channel: { id: 'target', name: 'Target', mode: 'queue', capacity: 10, members: [] },
      createdAt: now(),
      idempotencyKey: 'target'
    })
    source = channels.commands.join({
      actor,
      channelId: source.id,
      expectedRevision: source.revision,
      member: {
        memberId: 'source-publisher',
        agentInstanceId: 'agent-1',
        role: 'producer',
        joinedAt: now()
      },
      joinedAt: now(),
      idempotencyKey: 'source-join'
    })!
    target = channels.commands.join({
      actor,
      channelId: target.id,
      expectedRevision: target.revision,
      member: {
        memberId: 'target-publisher',
        agentInstanceId: 'agent-2',
        role: 'producer',
        joinedAt: now()
      },
      joinedAt: now(),
      idempotencyKey: 'target-join'
    })!
    channels.wireCommands.wire({
      actor,
      wire: {
        id: 'wire',
        sourceChannelId: source.id,
        targetChannelId: target.id,
        targetPublisherMemberId: 'target-publisher',
        enabled: true,
        createdAt: now(),
        maxHops: 2
      },
      idempotencyKey: 'wire'
    })
    channels.commands.publish({
      actor: { kind: 'agent', id: 'agent-1' },
      message: {
        id: 'message',
        channelId: source.id,
        publisherMemberId: 'source-publisher',
        payload: { text: 'forward me' },
        priority: 1,
        publishedAt: now()
      },
      expectedChannelRevision: source.revision,
      idempotencyKey: 'publish'
    })
    expect(channels.store.getMessage('wire:wire:message')?.state).toMatchObject({
      channelId: 'target',
      payload: { text: 'forward me' },
      wirePath: ['wire']
    })

    const staged = agents.commands.stageConfig({
      actor,
      instanceId: 'agent-1',
      expectedRevision: agents.store.get('agent-1')!.revision,
      configVersion: 'agent-1-v2',
      stagedAt: now(),
      idempotencyKey: 'stage'
    })
    await agents.commands.start({
      instanceId: 'agent-1',
      expectedRevision: staged.revision,
      actor,
      request: {
        agentId: 'definition-alpha',
        text: 'work',
        route: { channel: 'runtime-channel', scopeType: 'dm', scopeId: 'source' }
      },
      idempotencyKey: 'start'
    })
    await vi.waitFor(() => expect(releaseActive).toBeTypeOf('function'))
    const pause = agents.commands.pause({
      instanceId: 'agent-1',
      expectedRevision: agents.store.get('agent-1')!.revision,
      actor,
      idempotencyKey: 'pause'
    })
    releaseActive!()
    await pause
    expect(agents.store.get('agent-1')?.state.status).toBe('paused')
    const activated = agents.commands.activateStagedConfig({
      actor,
      instanceId: 'agent-1',
      expectedRevision: agents.store.get('agent-1')!.revision,
      activatedAt: now(),
      idempotencyKey: 'activate'
    })
    expect(activated.state.configVersion).toBe('agent-1-v2')
    const rolledBack = agents.commands.rollbackConfig({
      actor,
      instanceId: 'agent-1',
      expectedRevision: activated.revision,
      rolledBackAt: now(),
      idempotencyKey: 'rollback'
    })
    expect(rolledBack.state.configVersion).toBe('agent-1-v1')
    agents.commands.resume({
      instanceId: 'agent-1',
      expectedRevision: rolledBack.revision,
      actor,
      idempotencyKey: 'resume'
    })
    expect(agents.store.get('agent-1')?.state.status).toBe('running')
    releaseRun!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await vi.waitFor(() => expect(agents.store.get('agent-1')?.state.status).toBe('stopped'))

    const replaced = await agents.commands.replace({
      actor,
      instanceId: 'agent-1',
      expectedRevision: agents.store.get('agent-1')!.revision,
      definitionId: 'definition-replacement',
      name: 'Replacement',
      configVersion: 'replacement-v1',
      replacedAt: now(),
      idempotencyKey: 'replace'
    })
    expect(replaced.id).toBe('agent-1')
    expect(agents.teams.get('team')?.state.members[0]?.agentInstanceId).toBe(replaced.id)
    expect(channels.store.getChannel('source')?.state.members[0]?.agentInstanceId).toBe(replaced.id)

    await agents.close()
    channels.close()
    eventStore.close()
    eventStore = new MagicAgentEventStore(databasePath)
    authorization = authorize(eventStore)
    const recoveredAgents = new ProductionAgentInstanceLifecycle({
      eventStore,
      authorization,
      platformService: { runAgent: vi.fn() },
      now
    })
    const recoveredChannels = new ProductionRuntimeChannelLifecycle({
      eventStore,
      authorization,
      now,
      pollIntervalMs: 60_000
    })
    expect(recoveredAgents.commands.list()).toHaveLength(3)
    expect(recoveredAgents.teams.get('team')?.state.members).toHaveLength(3)
    expect(recoveredAgents.store.get('agent-1')?.state).toMatchObject({
      definitionId: 'definition-replacement',
      configVersion: 'replacement-v1'
    })
    expect(recoveredChannels.wires.get('wire')?.state.enabled).toBe(true)
    expect(recoveredChannels.store.getMessage('wire:wire:message')).toBeDefined()
    recoveredChannels.close()
    await recoveredAgents.close()
    eventStore.close()
  })
})
