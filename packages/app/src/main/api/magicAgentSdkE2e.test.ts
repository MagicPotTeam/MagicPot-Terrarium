import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpAgentTransport, MagicAgentClient } from '../../../../agent-sdk-typescript/src/index'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../magicAgentPlatform2/policy'
import {
  closeProductionTriggerLifecycle,
  startProductionTriggerLifecycle
} from '../magicAgentPlatform2/triggers/productionTriggerLifecycle'
import { MagicAgentSdkGateway } from './magicAgentSdkGateway'
import {
  startMagicAgentSdkHttpServer,
  type MagicAgentSdkHttpServer
} from './magicAgentSdkHttpServer'

let server: MagicAgentSdkHttpServer | undefined

afterEach(async () => {
  await server?.close()
  await closeProductionTriggerLifecycle()
  server = undefined
})

describe('TypeScript SDK production boundary', () => {
  it('runs through the real loopback listener and authenticated gateway', async () => {
    const runAgent = vi.fn(async () => ({
      runId: 'sdk-e2e-run',
      status: 'completed',
      agentId: 'agent-sdk',
      content: 'SDK result',
      messages: [],
      toolCalls: [],
      events: [],
      startedAt: 1,
      completedAt: 2
    }))
    server = await startMagicAgentSdkHttpServer({
      token: 'sdk-e2e-token',
      gateway: new MagicAgentSdkGateway({ runAgent } as never, 'sdk-e2e-token')
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'sdk-e2e-token' })
    )
    await expect(
      client.run({
        agentId: 'agent-sdk',
        input: { prompt: 'hello from sdk' },
        sessionId: 'sdk-e2e'
      })
    ).resolves.toMatchObject({
      runId: 'sdk-e2e-run',
      status: 'completed',
      output: { content: 'SDK result' }
    })
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello from sdk', agentId: 'agent-sdk' }),
      expect.objectContaining({ senderUrl: 'magicpot-sdk://authenticated-client' })
    )
  })

  it('uses typed Drive methods through the real listener and authenticated gateway', async () => {
    const resource = {
      id: 'sdk-drive',
      revision: 0,
      state: { status: 'active' },
      createdAt: 1,
      updatedAt: 1
    }
    const service = {
      runAgent: vi.fn(),
      listDrives: vi.fn(async () => ({ drives: [resource] })),
      getDrive: vi.fn(async () => ({ drive: resource })),
      createDrive: vi.fn(async () => ({ drive: resource })),
      transitionDrive: vi.fn(async () => ({ drive: { ...resource, revision: 1 } })),
      reportDriveProgress: vi.fn(async () => ({ drive: { ...resource, revision: 1 } }))
    }
    server = await startMagicAgentSdkHttpServer({
      token: 'sdk-drive-token',
      gateway: new MagicAgentSdkGateway(service as never, 'sdk-drive-token')
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'sdk-drive-token' })
    )
    await expect(client.listDrives()).resolves.toEqual([resource])
    await expect(client.getDrive(resource.id)).resolves.toEqual(resource)
    await expect(
      client.createDrive({ drive: resource.state, createdAt: 1, idempotencyKey: 'create' })
    ).resolves.toEqual(resource)
    await expect(
      client.transitionDrive({
        driveId: resource.id,
        expectedRevision: 0,
        status: 'completed',
        transitionedAt: 2,
        idempotencyKey: 'complete'
      })
    ).resolves.toMatchObject({ revision: 1 })
    expect(service.transitionDrive).toHaveBeenCalledOnce()
  })

  it('uses typed pending Graph input steering over authenticated HTTP', async () => {
    const result = { runId: 'run', pendingInputId: 'pending', revision: 2, status: 'awaiting' }
    const injectPendingInput = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'user', id: 'owner' })
      return { ...result, status: 'submitted' }
    })
    const editPendingInput = vi.fn(async () => result)
    const cancelPendingInput = vi.fn(async () => ({ ...result, status: 'cancelled' }))
    server = await startMagicAgentSdkHttpServer({
      token: 'pending-token',
      authenticatedActor: { kind: 'user', id: 'owner' },
      service: {
        runAgent: vi.fn(),
        injectPendingInput,
        editPendingInput,
        cancelPendingInput
      } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'pending-token' })
    )
    const common = {
      runId: 'run',
      route: { channel: 'sdk', scopeType: 'run', scopeId: 'run' },
      pendingInputId: 'pending',
      expectedRevision: 1
    }
    await client.editPendingInput({ ...common, value: 'draft', idempotencyKey: 'edit' })
    await client.injectPendingInput({ ...common, value: 'final' })
    await client.cancelPendingInput(common)
    expect(
      [editPendingInput, injectPendingInput, cancelPendingInput].every(
        (method) => method.mock.calls.length === 1
      )
    ).toBe(true)
  })

  it('uses typed Team replace over authenticated HTTP', async () => {
    const operation = {
      id: 'replace-operation',
      revision: 2,
      teamId: 'team',
      teamRevision: 1,
      action: 'replace',
      status: 'completed',
      outcomes: [],
      startedAt: 1,
      completedAt: 2
    }
    const replaceTeam = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'agent', id: 'coordinator' })
      return operation
    })
    server = await startMagicAgentSdkHttpServer({
      token: 'team-replace-token',
      authenticatedActor: { kind: 'agent', id: 'coordinator' },
      service: { runAgent: vi.fn(), replaceTeam } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'team-replace-token' })
    )
    await expect(
      client.replaceTeam({
        teamId: 'team',
        expectedRevision: 1,
        replacements: [
          {
            memberId: 'member',
            definitionId: 'new',
            name: 'New',
            configVersion: 'v2',
            replacedAt: 2
          }
        ],
        idempotencyKey: 'replace'
      })
    ).resolves.toMatchObject({ action: 'replace', status: 'completed' })
  })

  it('uses typed Team lifecycle operations over authenticated HTTP', async () => {
    const operation = {
      id: 'operation',
      revision: 2,
      teamId: 'team',
      teamRevision: 1,
      action: 'start',
      status: 'partial',
      outcomes: [{ memberId: 'm', agentInstanceId: 'agent', status: 'completed' }],
      startedAt: 1,
      completedAt: 2
    }
    const startTeam = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'user', id: 'owner' })
      return operation
    })
    const pauseTeam = vi.fn(async () => ({ ...operation, action: 'pause', status: 'completed' }))
    const resumeTeam = vi.fn(async () => ({ ...operation, action: 'resume', status: 'completed' }))
    const stopTeam = vi.fn(async () => ({ ...operation, action: 'stop', status: 'completed' }))
    server = await startMagicAgentSdkHttpServer({
      token: 'team-lifecycle-token',
      authenticatedActor: { kind: 'user', id: 'owner' },
      service: { runAgent: vi.fn(), startTeam, pauseTeam, resumeTeam, stopTeam } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'team-lifecycle-token' })
    )
    await expect(
      client.startTeam({
        teamId: 'team',
        expectedRevision: 1,
        request: { agentId: 'agent', input: { text: 'run' } },
        idempotencyKey: 'start'
      })
    ).resolves.toMatchObject({ status: 'partial' })
    await client.pauseTeam({ teamId: 'team', expectedRevision: 1, idempotencyKey: 'pause' })
    await client.resumeTeam({ teamId: 'team', expectedRevision: 1, idempotencyKey: 'resume' })
    await client.stopTeam({ teamId: 'team', expectedRevision: 1, idempotencyKey: 'stop' })
    expect(
      [startTeam, pauseTeam, resumeTeam, stopTeam].every((method) => method.mock.calls.length === 1)
    ).toBe(true)
  })

  it('uses typed Team mutations over authenticated HTTP', async () => {
    const resource = {
      id: 'team',
      revision: 0,
      state: {
        id: 'team',
        name: 'Team',
        ownerId: 'owner',
        members: [],
        createdAt: 1,
        createdBy: { kind: 'user', id: 'owner' }
      },
      createdAt: 1,
      updatedAt: 1
    }
    const createTeam = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'user', id: 'owner' })
      return resource
    })
    const addTeamMember = vi.fn(async () => ({ ...resource, revision: 1 }))
    const removeTeam = vi.fn(async () => ({ ...resource, revision: 3 }))
    const removeTeamMember = vi.fn(async () => ({ ...resource, revision: 2 }))
    server = await startMagicAgentSdkHttpServer({
      token: 'team-token',
      authenticatedActor: { kind: 'user', id: 'owner' },
      service: {
        runAgent: vi.fn(),
        createTeam,
        addTeamMember,
        removeTeamMember,
        removeTeam
      } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'team-token' })
    )
    await expect(
      client.createTeam({
        team: { id: 'team', name: 'Team', createdAt: 1 },
        idempotencyKey: 'create'
      })
    ).resolves.toMatchObject({ id: 'team' })
    await client.addTeamMember({
      teamId: 'team',
      expectedRevision: 0,
      member: { memberId: 'm', agentInstanceId: 'agent', role: 'leader', joinedAt: 2 },
      idempotencyKey: 'add'
    })
    await client.removeTeamMember({
      teamId: 'team',
      expectedRevision: 1,
      memberId: 'm',
      removedAt: 3,
      idempotencyKey: 'remove-member'
    })
    await client.removeTeam({
      teamId: 'team',
      expectedRevision: 2,
      removedAt: 4,
      idempotencyKey: 'remove'
    })
    expect(addTeamMember).toHaveBeenCalledOnce()
    expect(removeTeamMember).toHaveBeenCalledOnce()
  })

  it('uses typed Agent replace over authenticated HTTP', async () => {
    const resource = {
      id: 'instance',
      revision: 1,
      state: { definitionId: 'new', configVersion: 'v2' },
      createdAt: 1,
      updatedAt: 2
    }
    const replaceAgentInstance = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'agent', id: 'instance' })
      return resource
    })
    server = await startMagicAgentSdkHttpServer({
      token: 'replace-token',
      authenticatedActor: { kind: 'agent', id: 'instance' },
      service: { runAgent: vi.fn(), replaceAgentInstance } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'replace-token' })
    )
    await expect(
      client.replaceAgentInstance({
        instanceId: 'instance',
        expectedRevision: 0,
        definitionId: 'new',
        name: 'New',
        configVersion: 'v2',
        replacedAt: 2,
        idempotencyKey: 'replace'
      })
    ).resolves.toEqual(resource)
  })

  it('uses typed Agent create/remove over authenticated HTTP', async () => {
    const root = {
      id: 'root',
      revision: 0,
      state: { status: 'created', depth: 0 },
      createdAt: 1,
      updatedAt: 1
    }
    const child = {
      id: 'child',
      revision: 0,
      state: { status: 'created', depth: 1, parentInstanceId: 'root' },
      createdAt: 2,
      updatedAt: 2
    }
    const createRootAgentInstance = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'user', id: 'admin' })
      return { instance: root }
    })
    const createChildAgentInstance = vi.fn(async () => ({ instance: child }))
    const removeAgentInstance = vi.fn(async () => ({
      instance: { ...child, revision: 1, state: { ...child.state, status: 'removed' } }
    }))
    server = await startMagicAgentSdkHttpServer({
      token: 'create-token',
      authenticatedActor: { kind: 'user', id: 'admin' },
      service: {
        runAgent: vi.fn(),
        createRootAgentInstance,
        createChildAgentInstance,
        removeAgentInstance
      } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'create-token' })
    )
    await expect(
      client.createRootAgentInstance({
        instance: {
          id: 'root',
          name: 'Root',
          definitionId: 'agent',
          depth: 0,
          configVersion: 'v1',
          status: 'created',
          limits: {
            maxChildren: 1,
            maxDepth: 2,
            maxConcurrency: 1,
            maxRuntimeMs: 100,
            allowedToolNames: [],
            workspaceRoots: []
          }
        },
        createdAt: 1,
        idempotencyKey: 'root',
        grantId: 'root-grant',
        expectedGrantUseCount: 0
      })
    ).resolves.toEqual(root)
    await expect(
      client.createChildAgentInstance({
        parentInstanceId: 'root',
        parentExpectedRevision: 0,
        instance: {
          id: 'child',
          name: 'Child',
          definitionId: 'agent',
          configVersion: 'v1',
          limits: {
            maxChildren: 0,
            maxDepth: 2,
            maxConcurrency: 1,
            maxRuntimeMs: 100,
            allowedToolNames: [],
            workspaceRoots: []
          }
        },
        createdAt: 2,
        idempotencyKey: 'child'
      })
    ).resolves.toEqual(child)
    await expect(
      client.removeAgentInstance({
        instanceId: 'child',
        expectedRevision: 0,
        removedAt: 3,
        idempotencyKey: 'remove'
      })
    ).resolves.toMatchObject({ revision: 1, state: { status: 'removed' } })
  })

  it('uses typed Agent pause/resume over authenticated HTTP', async () => {
    const paused = {
      id: 'instance',
      revision: 2,
      state: { status: 'paused' },
      createdAt: 1,
      updatedAt: 2
    }
    const pauseAgentInstance = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'agent', id: 'instance' })
      return { instance: paused }
    })
    const resumeAgentInstance = vi.fn(async () => ({
      instance: { ...paused, revision: 3, state: { status: 'running' } }
    }))
    server = await startMagicAgentSdkHttpServer({
      token: 'pause-token',
      authenticatedActor: { kind: 'agent', id: 'instance' },
      service: { runAgent: vi.fn(), pauseAgentInstance, resumeAgentInstance } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'pause-token' })
    )
    await expect(
      client.pauseAgentInstance({
        instanceId: 'instance',
        expectedRevision: 1,
        idempotencyKey: 'pause'
      })
    ).resolves.toEqual(paused)
    await expect(
      client.resumeAgentInstance({
        instanceId: 'instance',
        expectedRevision: 2,
        idempotencyKey: 'resume'
      })
    ).resolves.toMatchObject({ revision: 3, state: { status: 'running' } })
  })

  it('uses typed Agent config version methods over authenticated HTTP', async () => {
    const instance = {
      id: 'instance',
      revision: 1,
      state: { configVersion: 'v2' },
      createdAt: 1,
      updatedAt: 2
    }
    const createAgentConfigVersion = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'agent', id: 'instance' })
      return {
        version: 'v2',
        definitionId: 'definition',
        contentDigest: 'a'.repeat(64),
        createdAt: 1
      }
    })
    const stageAgentConfig = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'agent', id: 'instance' })
      return { instance }
    })
    const activateAgentConfig = vi.fn(async () => ({ instance: { ...instance, revision: 2 } }))
    const rollbackAgentConfig = vi.fn(async () => ({
      instance: { ...instance, revision: 3, state: { configVersion: 'v1' } }
    }))
    server = await startMagicAgentSdkHttpServer({
      token: 'config-token',
      authenticatedActor: { kind: 'agent', id: 'instance' },
      service: {
        runAgent: vi.fn(),
        createAgentConfigVersion,
        stageAgentConfig,
        activateAgentConfig,
        rollbackAgentConfig
      } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'config-token' })
    )
    await expect(
      client.createAgentConfigVersion({
        config: {
          version: 'v2',
          definitionId: 'definition',
          model: { profileId: 'model' },
          systemPrompt: 'safe',
          inference: {},
          tools: { allowedToolNames: [] },
          memory: { allowHistory: false, contextMessageLimit: 1, scope: 'instance' },
          policy: { policyIds: [], workspaceRoots: [] },
          channels: { channelIds: [] },
          budgets: { maxRuntimeMs: 100 },
          createdAt: 1
        },
        idempotencyKey: 'create'
      })
    ).resolves.toMatchObject({ version: 'v2', definitionId: 'definition' })
    await expect(
      client.stageAgentConfig({
        instanceId: 'instance',
        expectedRevision: 0,
        configVersion: 'v2',
        stagedAt: 1,
        idempotencyKey: 'stage'
      })
    ).resolves.toEqual(instance)
    await expect(
      client.activateAgentConfig({
        instanceId: 'instance',
        expectedRevision: 1,
        activatedAt: 2,
        idempotencyKey: 'activate'
      })
    ).resolves.toMatchObject({ revision: 2 })
    await expect(
      client.rollbackAgentConfig({
        instanceId: 'instance',
        expectedRevision: 2,
        rolledBackAt: 3,
        idempotencyKey: 'rollback'
      })
    ).resolves.toMatchObject({ state: { configVersion: 'v1' } })
  })

  it('uses typed RuntimeChannel publish over authenticated HTTP', async () => {
    const publishRuntimeChannelMessage = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'agent', id: 'agent-1' })
      return { messageId: 'message', revision: 1, channelId: 'channel', status: 'published' }
    })
    server = await startMagicAgentSdkHttpServer({
      token: 'publish-token',
      authenticatedActor: { kind: 'agent', id: 'agent-1' },
      service: { runAgent: vi.fn(), publishRuntimeChannelMessage } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'publish-token' })
    )
    await expect(
      client.publishRuntimeChannelMessage({
        message: {
          id: 'message',
          channelId: 'channel',
          publisherMemberId: 'producer',
          payload: { text: 'hello' },
          priority: 1,
          publishedAt: 2
        },
        expectedChannelRevision: 1,
        idempotencyKey: 'publish',
        grantId: 'grant',
        expectedGrantUseCount: 0
      })
    ).resolves.toEqual({
      messageId: 'message',
      revision: 1,
      channelId: 'channel',
      status: 'published'
    })
  })

  it('uses typed RuntimeChannel create over authenticated HTTP', async () => {
    const channel = {
      id: 'created-channel',
      revision: 0,
      state: {
        id: 'created-channel',
        name: 'Created',
        mode: 'queue',
        capacity: 5,
        members: [],
        createdAt: 1
      },
      createdAt: 1,
      updatedAt: 1
    }
    const createRuntimeChannel = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'user', id: 'admin' })
      return { channel }
    })
    server = await startMagicAgentSdkHttpServer({
      token: 'channel-create-token',
      authenticatedActor: { kind: 'user', id: 'admin' },
      service: { runAgent: vi.fn(), createRuntimeChannel } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'channel-create-token' })
    )
    await expect(
      client.createRuntimeChannel({
        channel: { id: 'created-channel', name: 'Created', mode: 'queue', capacity: 5 },
        createdAt: 1,
        idempotencyKey: 'create',
        grantId: 'grant',
        expectedGrantUseCount: 0
      })
    ).resolves.toEqual(channel)
  })

  it('uses typed RuntimeChannel membership over authenticated HTTP', async () => {
    const member = {
      memberId: 'member',
      agentInstanceId: 'agent-1',
      role: 'consumer' as const,
      joinedAt: 1
    }
    const channel = {
      id: 'membership',
      revision: 1,
      state: {
        id: 'membership',
        name: 'Membership',
        mode: 'queue' as const,
        capacity: 2,
        members: [member]
      },
      createdAt: 1,
      updatedAt: 2
    }
    const joinRuntimeChannel = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'agent', id: 'agent-1' })
      return { channel }
    })
    const leaveRuntimeChannel = vi.fn(async () => ({
      channel: { ...channel, revision: 2, state: { ...channel.state, members: [] } }
    }))
    server = await startMagicAgentSdkHttpServer({
      token: 'membership-token',
      authenticatedActor: { kind: 'agent', id: 'agent-1' },
      service: { runAgent: vi.fn(), joinRuntimeChannel, leaveRuntimeChannel } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'membership-token' })
    )
    await expect(
      client.joinRuntimeChannel({
        channelId: channel.id,
        expectedRevision: 0,
        member,
        joinedAt: 1,
        idempotencyKey: 'join'
      })
    ).resolves.toEqual(channel)
    await expect(
      client.leaveRuntimeChannel({
        channelId: channel.id,
        expectedRevision: 1,
        memberId: member.memberId,
        leftAt: 2,
        idempotencyKey: 'leave'
      })
    ).resolves.toMatchObject({ revision: 2, state: { members: [] } })
  })

  it('surfaces public cycle and Policy errors without returning a Wire', async () => {
    const wireRuntimeChannel = vi.fn(async () => {
      throw new Error('Runtime Channel wire denied.')
    })
    server = await startMagicAgentSdkHttpServer({
      token: 'wire-error-token',
      authenticatedActor: { kind: 'user', id: 'owner' },
      service: { runAgent: vi.fn(), wireRuntimeChannel } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'wire-error-token' })
    )
    const request = {
      wire: {
        id: 'cycle',
        sourceChannelId: 'a',
        targetChannelId: 'a',
        targetPublisherMemberId: 'publisher',
        enabled: true,
        createdAt: 1,
        maxHops: 4
      },
      idempotencyKey: 'cycle'
    }
    await expect(client.wireRuntimeChannel(request)).rejects.toThrow(/denied/)
    wireRuntimeChannel.mockImplementationOnce(async () => {
      throw new Error('Runtime Channel wire would create a cycle.')
    })
    await expect(client.wireRuntimeChannel(request)).rejects.toThrow(/cycle/)
    expect(wireRuntimeChannel).toHaveBeenCalledTimes(2)
  })

  it('uses typed RuntimeChannel Wire mutations over authenticated HTTP', async () => {
    const wire = {
      id: 'wire-mutation',
      revision: 0,
      state: {
        id: 'wire-mutation',
        sourceChannelId: 'source',
        targetChannelId: 'target',
        targetPublisherMemberId: 'publisher',
        enabled: true,
        createdAt: 1,
        maxHops: 4
      },
      createdAt: 1,
      updatedAt: 1
    }
    const wireRuntimeChannel = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'user', id: 'owner' })
      return { wire }
    })
    const unwireRuntimeChannel = vi.fn(async () => ({
      wire: { ...wire, revision: 1, state: { ...wire.state, enabled: false } }
    }))
    server = await startMagicAgentSdkHttpServer({
      token: 'wire-mutation-token',
      authenticatedActor: { kind: 'user', id: 'owner' },
      service: { runAgent: vi.fn(), wireRuntimeChannel, unwireRuntimeChannel } as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'wire-mutation-token' })
    )
    await expect(
      client.wireRuntimeChannel({ wire: wire.state, idempotencyKey: 'wire' })
    ).resolves.toEqual(wire)
    await expect(
      client.unwireRuntimeChannel({
        wireId: wire.id,
        expectedRevision: 0,
        removedAt: 2,
        idempotencyKey: 'unwire'
      })
    ).resolves.toMatchObject({ revision: 1, state: { enabled: false } })
  })

  it('uses typed RuntimeChannel Wire methods over authenticated HTTP', async () => {
    const wire = {
      id: 'wire-http',
      revision: 1,
      state: {
        id: 'wire-http',
        sourceChannelId: 'source',
        targetChannelId: 'target',
        targetPublisherMemberId: 'publisher',
        enabled: true,
        createdAt: 1,
        maxHops: 4
      },
      createdAt: 1,
      updatedAt: 2
    }
    const service = {
      runAgent: vi.fn(),
      listRuntimeChannelWires: vi.fn(async () => ({ wires: [wire] })),
      getRuntimeChannelWire: vi.fn(async () => ({ wire }))
    }
    server = await startMagicAgentSdkHttpServer({
      token: 'wire-token',
      gateway: new MagicAgentSdkGateway(service as never, 'wire-token')
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'wire-token' })
    )
    await expect(client.listRuntimeChannelWires()).resolves.toEqual([wire])
    await expect(client.getRuntimeChannelWire(wire.id)).resolves.toEqual(wire)
    expect(service.getRuntimeChannelWire).toHaveBeenCalledWith({ wireId: wire.id })
  })

  it('uses typed RuntimeChannel claim/ack over authenticated HTTP', async () => {
    const claimRuntimeChannelMessage = vi.fn(async (_request, invocation) => {
      expect(invocation.authenticatedActor).toEqual({ kind: 'agent', id: 'agent-1' })
      return {
        messageId: 'message',
        revision: 1,
        channelId: 'channel',
        consumerMemberId: 'consumer',
        claimToken: 'claim-token',
        leaseExpiresAt: 110
      }
    })
    const acknowledgeRuntimeChannelMessage = vi.fn(async () => ({
      messageId: 'message',
      revision: 2,
      channelId: 'channel',
      consumerMemberId: 'consumer',
      acknowledgedAt: 20
    }))
    const service = {
      runAgent: vi.fn(),
      claimRuntimeChannelMessage,
      acknowledgeRuntimeChannelMessage
    }
    server = await startMagicAgentSdkHttpServer({
      token: 'delivery-token',
      authenticatedActor: { kind: 'agent', id: 'agent-1' },
      service: service as never
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'delivery-token' })
    )
    const claimed = await client.claimRuntimeChannelMessage({
      messageId: 'message',
      expectedRevision: 0,
      consumerMemberId: 'consumer',
      claimedAt: 10,
      leaseMs: 100,
      idempotencyKey: 'claim'
    })
    const acknowledged = await client.acknowledgeRuntimeChannelMessage({
      messageId: 'message',
      expectedRevision: claimed.revision,
      consumerMemberId: 'consumer',
      acknowledgedAt: 20,
      token: claimed.claimToken!,
      idempotencyKey: 'ack'
    })
    expect(acknowledged.acknowledgedAt).toBe(20)
    expect(JSON.stringify(acknowledged)).not.toContain('claim-token')
  })

  it('uses typed RuntimeChannel methods over authenticated HTTP', async () => {
    const resource = {
      id: 'channel-http',
      revision: 1,
      state: {
        id: 'channel-http',
        name: 'Channel',
        mode: 'queue' as const,
        capacity: 2,
        members: []
      },
      createdAt: 1,
      updatedAt: 2
    }
    const service = {
      runAgent: vi.fn(),
      listRuntimeChannels: vi.fn(async () => ({ channels: [resource] })),
      getRuntimeChannel: vi.fn(async () => ({ channel: resource }))
    }
    server = await startMagicAgentSdkHttpServer({
      token: 'sdk-channel-token',
      gateway: new MagicAgentSdkGateway(service as never, 'sdk-channel-token')
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'sdk-channel-token' })
    )
    await expect(client.listRuntimeChannels()).resolves.toEqual([resource])
    await expect(client.getRuntimeChannel(resource.id)).resolves.toEqual(resource)
    expect(service.getRuntimeChannel).toHaveBeenCalledWith({ channelId: resource.id })
  })

  it('uses typed AgentInstance methods over authenticated HTTP', async () => {
    const resource = {
      id: 'instance-http',
      revision: 1,
      state: { status: 'running' },
      createdAt: 1,
      updatedAt: 2
    }
    const service = {
      runAgent: vi.fn(),
      listAgentInstances: vi.fn(async () => ({ instances: [resource] })),
      startAgentInstance: vi.fn(async () => ({ instance: resource }))
    }
    server = await startMagicAgentSdkHttpServer({
      token: 'sdk-agent-token',
      gateway: new MagicAgentSdkGateway(service as never, 'sdk-agent-token')
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'sdk-agent-token' })
    )
    await expect(client.listAgentInstances()).resolves.toEqual([resource])
    await expect(
      client.startAgentInstance({
        instanceId: resource.id,
        expectedRevision: 0,
        request: { agentId: 'agent-1', input: { prompt: 'work' } },
        idempotencyKey: 'start-http'
      })
    ).resolves.toEqual(resource)
    expect(service.startAgentInstance).toHaveBeenCalledOnce()
  })

  it('uses typed Trigger methods through the real listener and authenticated gateway', async () => {
    const resource = {
      id: 'sdk-trigger',
      revision: 0,
      state: { id: 'sdk-trigger', enabled: true },
      createdAt: 1,
      updatedAt: 1
    }
    const occurrence = {
      id: 'sdk-occurrence',
      revision: 0,
      state: { status: 'pending' },
      createdAt: 2,
      updatedAt: 2
    }
    const service = {
      runAgent: vi.fn(),
      listTriggers: vi.fn(async () => ({ triggers: [resource] })),
      getTrigger: vi.fn(async () => ({ trigger: resource })),
      createTrigger: vi.fn(async () => ({ trigger: resource })),
      updateTrigger: vi.fn(),
      enableTrigger: vi.fn(),
      disableTrigger: vi.fn(),
      pauseTrigger: vi.fn(),
      resumeTrigger: vi.fn(),
      retryTrigger: vi.fn(),
      manualFireTrigger: vi.fn(async () => ({ occurrence }))
    }
    server = await startMagicAgentSdkHttpServer({
      token: 'sdk-trigger-token',
      gateway: new MagicAgentSdkGateway(service as never, 'sdk-trigger-token')
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'sdk-trigger-token' })
    )
    await expect(client.listTriggers()).resolves.toEqual([resource])
    await expect(client.getTrigger(resource.id)).resolves.toEqual(resource)
    await expect(
      client.createTrigger({
        trigger: resource.state,
        schedule: { type: 'interval', intervalMs: 100 },
        nextFireAt: 100,
        createdAt: 1,
        idempotencyKey: 'sdk-create'
      })
    ).resolves.toEqual(resource)
    await expect(
      client.manualFireTrigger({
        triggerId: resource.id,
        expectedTriggerRevision: 0,
        idempotencyKey: 'sdk-manual',
        requestedAt: 2,
        occurrenceId: occurrence.id
      })
    ).resolves.toEqual(occurrence)
    expect(service.manualFireTrigger).toHaveBeenCalledOnce()
  })

  it('emits an SDK event over authenticated HTTP into the active production runtime', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const authorization = new MagicAgentPolicyAuthorizationService({
      store: eventStore,
      rules: [
        {
          ruleId: 'allow-sdk-event',
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
          explanation: 'allow sdk event'
        }
      ],
      policyVersion: 'policy-sdk-event',
      storeId: 'store-sdk-event',
      trustedApprovers: [{ kind: 'user', id: 'approver-1' }]
    })
    const runAgent = vi.fn(async (input) => input)
    const lifecycle = startProductionTriggerLifecycle({
      policyRuntime: { eventStore, authorization } as never,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: async () => undefined,
      routeResolver: () => ({ trusted: true }),
      now: () => 1,
      pollInterval: 60_000
    })
    lifecycle.runtime.store.create(
      {
        id: 'sdk-event-trigger',
        type: 'event',
        title: 'SDK event trigger',
        enabled: true,
        config: {
          sourceKind: 'sdk',
          eventName: 'order.created',
          target: { kind: 'agent-run', agentId: 'sdk-event-agent' }
        }
      },
      0,
      'sdk-event-trigger-create'
    )
    server = await startMagicAgentSdkHttpServer({
      token: 'sdk-event-token',
      gateway: new MagicAgentSdkGateway({ runAgent: vi.fn() } as never, 'sdk-event-token')
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: server.baseUrl, token: 'sdk-event-token' })
    )
    await expect(
      client.emitTriggerEvent({
        source: 'sdk',
        eventId: 'order-event-1',
        eventName: 'order.created',
        emittedAt: 1,
        payloadDigest: 'd'.repeat(64)
      })
    ).resolves.toBe(1)
    await lifecycle.close()
    await lifecycle.runtime.occurrenceScheduler.runOnce()
    expect(runAgent).not.toHaveBeenCalled()
    expect(lifecycle.runtime.occurrences.list()[0]?.state).toMatchObject({
      source: 'sdk',
      status: 'failed',
      payloadDigest: 'd'.repeat(64)
    })
  })
})
