import { describe, expect, it, vi } from 'vitest'
import { MagicAgentSdkGateway } from './magicAgentSdkGateway'
import type { MagicAgentPlatformGraphRunReq } from '@shared/api/svcMagicAgentPlatform'

describe('MagicAgentSdkGateway', () => {
  it('forwards graph node execution without losing explicit inputs or prior-run selection', async () => {
    const runGraph = vi.fn(async (_request: MagicAgentPlatformGraphRunReq) => ({
      runId: 'run-node',
      status: 'completed'
    }))
    const gateway = new MagicAgentSdkGateway({ runGraph } as never, 'secret')
    const route = { channel: 'sdk', scopeType: 'dm', scopeId: 'graph' }
    const requests = [
      {
        graphId: 'graph-1',
        input: 'explicit',
        route,
        nodeExecution: { mode: 'single-node', nodeId: 'writer', inputs: { input: 'explicit' } }
      },
      {
        graphId: 'graph-1',
        input: 'continue',
        route,
        nodeExecution: { mode: 'run-from-node', nodeId: 'writer', priorRunId: 'run-prior' }
      }
    ]
    for (const payload of requests)
      await expect(
        gateway.dispatch({ method: 'graph.run', payload, authorization: 'Bearer secret' })
      ).resolves.toMatchObject({ status: 200 })

    expect(runGraph.mock.calls.map(([request]) => request)).toEqual(requests)
  })

  it('routes authenticated semantic-memory link and scope methods without payload actors', async () => {
    const methods = {
      ingestMemoryScope: vi.fn(async () => ({ discovered: 1, upserted: 1 })),
      linkMemoryAgentSession: vi.fn(async () => []),
      unlinkMemoryAgentSession: vi.fn(async () => []),
      listMemoryAgentSessions: vi.fn(async () => [])
    }
    const gateway = new MagicAgentSdkGateway(methods as never, 'secret', {
      kind: 'user',
      id: 'owner'
    })
    const authorization = 'Bearer secret'
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'owner' }
    const calls = [
      [
        'memory.ingestScope',
        { scope: { kind: 'workspace', id: 'workspace-1', sourceRoute: route } }
      ],
      ['memory.linkAgentSession', { agentId: 'agent-1', sourceRoute: route }],
      ['memory.listAgentSessions', { agentId: 'agent-1' }],
      ['memory.unlinkAgentSession', { agentId: 'agent-1', sourceRoute: route }]
    ] as const
    for (const [method, payload] of calls)
      await expect(gateway.dispatch({ method, payload, authorization })).resolves.toMatchObject({
        status: 200
      })
    for (const fn of Object.values(methods))
      expect(fn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'owner' } })
      )
    await expect(
      gateway.dispatch({
        method: 'memory.ingestScope',
        payload: { ...calls[0][1], actor: { kind: 'user', id: 'attacker' } },
        authorization
      })
    ).resolves.toMatchObject({ status: 400 })
  })

  it('strictly validates session export and diff payloads before service dispatch', async () => {
    const exportSession = vi.fn()
    const diffSessions = vi.fn()
    const gateway = new MagicAgentSdkGateway({ exportSession, diffSessions } as never, 'secret', {
      kind: 'user',
      id: 'owner'
    })
    const authorization = 'Bearer secret'
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'source' }
    for (const payload of [
      { sourceRoute: route, format: 'pdf' },
      { sourceRoute: { ...route, extra: true }, format: 'markdown' },
      { sourceRoute: route, format: 'markdown', actor: { kind: 'user', id: 'attacker' } }
    ]) {
      await expect(
        gateway.dispatch({ method: 'session.export', authorization, payload })
      ).resolves.toMatchObject({ status: 400 })
    }
    await expect(
      gateway.dispatch({
        method: 'session.diff',
        authorization,
        payload: {
          leftRoute: route,
          rightRoute: { channel: 'generic', scopeType: 'dm', scopeId: '' }
        }
      })
    ).resolves.toMatchObject({ status: 400 })
    expect(exportSession).not.toHaveBeenCalled()
    expect(diffSessions).not.toHaveBeenCalled()
  })

  it('rejects missing or invalid bearer tokens without dispatching', async () => {
    const runAgent = vi.fn()
    const gateway = new MagicAgentSdkGateway({ runAgent } as never, 'secret')
    await expect(gateway.dispatch({ method: 'agent.run', payload: {} })).resolves.toMatchObject({
      status: 401
    })
    await expect(
      gateway.dispatch({ method: 'agent.run', payload: {}, authorization: 'Bearer wrong' })
    ).resolves.toMatchObject({ status: 401 })
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('maps authenticated SDK agent.run onto the production service boundary', async () => {
    const runAgent = vi.fn(async () => ({
      runId: 'run-1',
      status: 'completed',
      agentId: 'agent-1',
      content: 'done',
      messages: [],
      toolCalls: [],
      events: [],
      startedAt: 1,
      completedAt: 2
    }))
    const gateway = new MagicAgentSdkGateway({ runAgent } as never, 'secret')
    const response = await gateway.dispatch({
      method: 'agent.run',
      authorization: 'Bearer secret',
      payload: { agentId: 'agent-1', input: { prompt: 'hello' }, sessionId: 'session-1' }
    })
    expect(response).toMatchObject({
      status: 200,
      body: { runId: 'run-1', status: 'completed', output: { content: 'done' } }
    })
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        text: 'hello',
        route: { channel: 'sdk', scopeType: 'dm', scopeId: 'session-1' }
      }),
      expect.objectContaining({
        methodName: 'agent.run',
        senderUrl: 'magicpot-sdk://authenticated-client'
      })
    )
  })

  it('binds an authenticated actor to the trusted invocation instead of request payload', async () => {
    let invocation: unknown
    const runAgent = vi.fn(async (_request: unknown, context: unknown) => {
      invocation = context
      return {
        runId: 'run',
        status: 'completed',
        content: '',
        messages: [],
        toolCalls: [],
        events: [],
        startedAt: 1
      }
    })
    const gateway = new MagicAgentSdkGateway({ runAgent } as never, 'secret', {
      kind: 'agent',
      id: 'agent-1'
    })
    await gateway.dispatch({
      method: 'agent.run',
      payload: { actor: { kind: 'agent', id: 'attacker' } },
      authorization: 'Bearer secret'
    })
    expect(invocation).toEqual(
      expect.objectContaining({ authenticatedActor: { kind: 'agent', id: 'agent-1' } })
    )
  })

  it('redacts service errors for channel acknowledgement', async () => {
    const gateway = new MagicAgentSdkGateway(
      {
        runAgent: vi.fn(),
        acknowledgeRuntimeChannelMessage: vi.fn(async () => {
          throw new Error('token claim-token-must-not-leak mismatch')
        })
      } as never,
      'secret',
      { kind: 'agent', id: 'agent-1' }
    )
    const result = await gateway.dispatch({
      method: 'channel.ack',
      authorization: 'Bearer secret',
      payload: {
        messageId: 'message',
        expectedRevision: 1,
        consumerMemberId: 'consumer',
        acknowledgedAt: 2,
        token: 'claim-token-must-not-leak',
        idempotencyKey: 'ack'
      }
    })
    expect(result).toEqual({
      status: 400,
      body: { code: 'invalid_request', message: 'Runtime Channel acknowledgement failed.' }
    })
    expect(JSON.stringify(result)).not.toContain('claim-token-must-not-leak')
  })

  it('routes Channel delivery with only the configured authenticated actor', async () => {
    const claimRuntimeChannelMessage = vi.fn(async () => ({ claimToken: 'secret' }))
    const acknowledgeRuntimeChannelMessage = vi.fn(async () => ({ acknowledgedAt: 2 }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), claimRuntimeChannelMessage, acknowledgeRuntimeChannelMessage } as never,
      'secret',
      { kind: 'agent', id: 'agent-1' }
    )
    const authorization = 'Bearer secret'
    const claim = {
      messageId: 'message',
      expectedRevision: 0,
      consumerMemberId: 'consumer',
      claimedAt: 1,
      leaseMs: 100,
      idempotencyKey: 'claim'
    }
    await expect(
      gateway.dispatch({
        method: 'channel.claim',
        payload: { ...claim, actor: { kind: 'agent', id: 'attacker' } },
        authorization
      })
    ).resolves.toEqual(expect.objectContaining({ status: 400 }))
    await gateway.dispatch({ method: 'channel.claim', payload: claim, authorization })
    const ack = {
      messageId: 'message',
      expectedRevision: 1,
      consumerMemberId: 'consumer',
      acknowledgedAt: 2,
      token: 'secret',
      idempotencyKey: 'ack'
    }
    await gateway.dispatch({ method: 'channel.ack', payload: ack, authorization })
    expect(claimRuntimeChannelMessage).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ authenticatedActor: { kind: 'agent', id: 'agent-1' } })
    )
    expect(acknowledgeRuntimeChannelMessage).toHaveBeenCalledWith(
      ack,
      expect.objectContaining({ authenticatedActor: { kind: 'agent', id: 'agent-1' } })
    )
  })

  it('routes Agent replace with configured actor and rejects spoofing', async () => {
    const replaceAgentInstance = vi.fn(async () => ({
      id: 'instance',
      revision: 1,
      state: {},
      createdAt: 1,
      updatedAt: 2
    }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), replaceAgentInstance } as never,
      'secret',
      { kind: 'agent', id: 'instance' }
    )
    const payload = {
      instanceId: 'instance',
      expectedRevision: 0,
      definitionId: 'new',
      name: 'New',
      configVersion: 'v2',
      replacedAt: 2,
      idempotencyKey: 'replace'
    }
    await expect(
      gateway.dispatch({
        method: 'agentInstance.replace',
        payload: { ...payload, actor: { kind: 'agent', id: 'other' } },
        authorization: 'Bearer secret'
      })
    ).resolves.toEqual(expect.objectContaining({ status: 400 }))
    await gateway.dispatch({
      method: 'agentInstance.replace',
      payload,
      authorization: 'Bearer secret'
    })
    expect(replaceAgentInstance).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ authenticatedActor: { kind: 'agent', id: 'instance' } })
    )
  })

  it('routes pause/resume with configured authenticated actor and rejects spoofing', async () => {
    const pauseAgentInstance = vi.fn(async () => ({
      instance: { id: 'instance', state: { status: 'paused' } }
    }))
    const resumeAgentInstance = vi.fn(async () => ({
      instance: { id: 'instance', state: { status: 'running' } }
    }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), pauseAgentInstance, resumeAgentInstance } as never,
      'secret',
      { kind: 'agent', id: 'instance' }
    )
    const authorization = 'Bearer secret'
    const pause = { instanceId: 'instance', expectedRevision: 1, idempotencyKey: 'pause' }
    await expect(
      gateway.dispatch({
        method: 'agentInstance.pause',
        payload: { ...pause, actor: { kind: 'agent', id: 'other' } },
        authorization
      })
    ).resolves.toMatchObject({ status: 400 })
    await gateway.dispatch({ method: 'agentInstance.pause', payload: pause, authorization })
    await gateway.dispatch({
      method: 'agentInstance.resume',
      payload: { ...pause, expectedRevision: 2, idempotencyKey: 'resume' },
      authorization
    })
    expect(pauseAgentInstance).toHaveBeenCalledWith(
      pause,
      expect.objectContaining({ authenticatedActor: { kind: 'agent', id: 'instance' } })
    )
    expect(resumeAgentInstance).toHaveBeenCalledOnce()
  })

  it('routes Team lifecycle with configured Agent principal', async () => {
    const startTeam = vi.fn(async () => ({
      id: 'operation',
      revision: 1,
      teamId: 'team',
      teamRevision: 1,
      action: 'start',
      status: 'completed',
      outcomes: [],
      startedAt: 1,
      completedAt: 2
    }))
    const gateway = new MagicAgentSdkGateway({ runAgent: vi.fn(), startTeam } as never, 'secret', {
      kind: 'agent',
      id: 'coordinator'
    })
    const payload = {
      teamId: 'team',
      expectedRevision: 1,
      request: { text: 'start', route: { channel: 'test', scopeType: 'team', scopeId: 'team' } },
      idempotencyKey: 'start'
    }
    await gateway.dispatch({ method: 'team.start', payload, authorization: 'Bearer secret' })
    expect(startTeam).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ authenticatedActor: { kind: 'agent', id: 'coordinator' } })
    )
  })

  it('routes Team mutations with configured actor and rejects authority spoofing', async () => {
    const createTeam = vi.fn(async () => ({
      id: 'team',
      revision: 0,
      state: {},
      createdAt: 1,
      updatedAt: 1
    }))
    const addTeamMember = vi.fn(async () => ({
      id: 'team',
      revision: 1,
      state: {},
      createdAt: 1,
      updatedAt: 2
    }))
    const removeTeam = vi.fn(async () => ({
      id: 'team',
      revision: 3,
      state: {},
      createdAt: 1,
      updatedAt: 4
    }))
    const removeTeamMember = vi.fn(async () => ({
      id: 'team',
      revision: 2,
      state: {},
      createdAt: 1,
      updatedAt: 3
    }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), createTeam, addTeamMember, removeTeamMember, removeTeam } as never,
      'secret',
      { kind: 'user', id: 'owner' }
    )
    const authorization = 'Bearer secret'
    const valid = { team: { id: 'team', name: 'Team', createdAt: 1 }, idempotencyKey: 'create' }
    for (const payload of [
      { ...valid, actor: { kind: 'user', id: 'spoof' } },
      { ...valid, team: { ...valid.team, ownerId: 'spoof' } }
    ])
      await expect(
        gateway.dispatch({ method: 'team.create', payload, authorization })
      ).resolves.toEqual(expect.objectContaining({ status: 400 }))
    await gateway.dispatch({ method: 'team.create', payload: valid, authorization })
    await gateway.dispatch({
      method: 'team.remove',
      payload: { teamId: 'team', expectedRevision: 0, removedAt: 2, idempotencyKey: 'remove' },
      authorization
    })
    expect(removeTeam).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team' }),
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'owner' } })
    )
    expect(createTeam).toHaveBeenCalledWith(
      valid,
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'owner' } })
    )
  })

  it('routes immutable config creation with configured actor and rejects creator/digest spoofing', async () => {
    const createAgentConfigVersion = vi.fn(async () => ({
      version: 'v2',
      definitionId: 'agent',
      contentDigest: 'a'.repeat(64),
      createdAt: 1
    }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), createAgentConfigVersion } as never,
      'secret',
      { kind: 'user', id: 'owner' }
    )
    const config = {
      version: 'v2',
      definitionId: 'agent',
      model: { profileId: 'model' },
      systemPrompt: 'safe',
      inference: {},
      tools: { allowedToolNames: [] },
      memory: { allowHistory: false, contextMessageLimit: 1, scope: 'instance' },
      policy: { policyIds: [], workspaceRoots: [] },
      channels: { channelIds: [] },
      budgets: { maxRuntimeMs: 100 },
      createdAt: 1
    }
    for (const payload of [
      { config, idempotencyKey: 'create', actor: { kind: 'user', id: 'attacker' } },
      {
        config: { ...config, createdBy: { kind: 'user', id: 'attacker' } },
        idempotencyKey: 'create'
      },
      { config: { ...config, contentDigest: '0'.repeat(64) }, idempotencyKey: 'create' }
    ])
      await expect(
        gateway.dispatch({
          method: 'agentInstance.config.create',
          payload,
          authorization: 'Bearer secret'
        })
      ).resolves.toEqual(expect.objectContaining({ status: 400 }))
    await gateway.dispatch({
      method: 'agentInstance.config.create',
      payload: { config, idempotencyKey: 'create' },
      authorization: 'Bearer secret'
    })
    expect(createAgentConfigVersion).toHaveBeenCalledWith(
      { config, idempotencyKey: 'create' },
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'owner' } })
    )
  })

  it('routes config version mutations with configured authenticated actor and no raw config', async () => {
    const stageAgentConfig = vi.fn(async () => ({ instance: { id: 'instance' } }))
    const activateAgentConfig = vi.fn(async () => ({ instance: { id: 'instance' } }))
    const rollbackAgentConfig = vi.fn(async () => ({ instance: { id: 'instance' } }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), stageAgentConfig, activateAgentConfig, rollbackAgentConfig } as never,
      'secret',
      { kind: 'agent', id: 'instance' }
    )
    const authorization = 'Bearer secret'
    const stage = {
      instanceId: 'instance',
      expectedRevision: 0,
      configVersion: 'v2',
      stagedAt: 1,
      idempotencyKey: 'stage'
    }
    await expect(
      gateway.dispatch({
        method: 'agentInstance.config.stage',
        payload: { ...stage, config: { prompt: 'secret' } },
        authorization
      })
    ).resolves.toEqual(expect.objectContaining({ status: 400 }))
    await gateway.dispatch({ method: 'agentInstance.config.stage', payload: stage, authorization })
    await gateway.dispatch({
      method: 'agentInstance.config.activate',
      payload: {
        instanceId: 'instance',
        expectedRevision: 1,
        activatedAt: 2,
        idempotencyKey: 'activate'
      },
      authorization
    })
    await gateway.dispatch({
      method: 'agentInstance.config.rollback',
      payload: {
        instanceId: 'instance',
        expectedRevision: 2,
        rolledBackAt: 3,
        idempotencyKey: 'rollback'
      },
      authorization
    })
    expect(stageAgentConfig).toHaveBeenCalledWith(
      stage,
      expect.objectContaining({ authenticatedActor: { kind: 'agent', id: 'instance' } })
    )
  })

  it('routes channel publish with configured actor and rejects spoofing', async () => {
    const publishRuntimeChannelMessage = vi.fn(async () => ({
      messageId: 'message',
      revision: 1,
      channelId: 'channel',
      status: 'published'
    }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), publishRuntimeChannelMessage } as never,
      'secret',
      { kind: 'agent', id: 'agent-1' }
    )
    const authorization = 'Bearer secret'
    const payload = {
      message: {
        id: 'message',
        channelId: 'channel',
        publisherMemberId: 'producer',
        payload: { text: 'hello' },
        priority: 1,
        publishedAt: 2
      },
      expectedChannelRevision: 1,
      idempotencyKey: 'publish'
    }
    await expect(
      gateway.dispatch({
        method: 'channel.publish',
        payload: { ...payload, actor: { kind: 'agent', id: 'other' } },
        authorization
      })
    ).resolves.toMatchObject({ status: 400 })
    await gateway.dispatch({ method: 'channel.publish', payload, authorization })
    expect(publishRuntimeChannelMessage).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ authenticatedActor: { kind: 'agent', id: 'agent-1' } })
    )
  })

  it('routes channel creation with configured user principal and rejects spoofing', async () => {
    const createRuntimeChannel = vi.fn(async () => ({ channel: { id: 'channel' } }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), createRuntimeChannel } as never,
      'secret',
      { kind: 'user', id: 'admin' }
    )
    const authorization = 'Bearer secret'
    const payload = {
      channel: { id: 'channel', name: 'Channel', mode: 'queue', capacity: 5 },
      createdAt: 1,
      idempotencyKey: 'create'
    }
    await expect(
      gateway.dispatch({
        method: 'channel.create',
        payload: { ...payload, actor: { kind: 'user', id: 'other' } },
        authorization
      })
    ).resolves.toMatchObject({ status: 400 })
    await gateway.dispatch({ method: 'channel.create', payload, authorization })
    expect(createRuntimeChannel).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'admin' } })
    )
  })

  it('routes membership mutations with configured authenticated actor', async () => {
    const joinRuntimeChannel = vi.fn(async () => ({ channel: { id: 'channel' } }))
    const leaveRuntimeChannel = vi.fn(async () => ({ channel: { id: 'channel' } }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), joinRuntimeChannel, leaveRuntimeChannel } as never,
      'secret',
      { kind: 'agent', id: 'agent-1' }
    )
    const authorization = 'Bearer secret'
    const join = {
      channelId: 'channel',
      expectedRevision: 0,
      member: { memberId: 'member', agentInstanceId: 'agent-1', role: 'consumer', joinedAt: 1 },
      joinedAt: 1,
      idempotencyKey: 'join'
    }
    await expect(
      gateway.dispatch({
        method: 'channel.join',
        payload: { ...join, actor: { kind: 'agent', id: 'attacker' } },
        authorization
      })
    ).resolves.toEqual(expect.objectContaining({ status: 400 }))
    await gateway.dispatch({ method: 'channel.join', payload: join, authorization })
    const leave = {
      channelId: 'channel',
      expectedRevision: 1,
      memberId: 'member',
      leftAt: 2,
      idempotencyKey: 'leave'
    }
    await gateway.dispatch({ method: 'channel.leave', payload: leave, authorization })
    expect(joinRuntimeChannel).toHaveBeenCalledWith(
      join,
      expect.objectContaining({ authenticatedActor: { kind: 'agent', id: 'agent-1' } })
    )
    expect(leaveRuntimeChannel).toHaveBeenCalledWith(
      leave,
      expect.objectContaining({ authenticatedActor: { kind: 'agent', id: 'agent-1' } })
    )
  })

  it('routes Wire mutations with only the configured authenticated actor', async () => {
    const wireRuntimeChannel = vi.fn(async () => ({ wire: { id: 'wire' } }))
    const unwireRuntimeChannel = vi.fn(async () => ({ wire: { id: 'wire' } }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), wireRuntimeChannel, unwireRuntimeChannel } as never,
      'secret',
      { kind: 'user', id: 'owner' }
    )
    const authorization = 'Bearer secret'
    const wire = {
      wire: {
        id: 'wire',
        sourceChannelId: 'source',
        targetChannelId: 'target',
        targetPublisherMemberId: 'publisher',
        enabled: true,
        createdAt: 1,
        maxHops: 4
      },
      idempotencyKey: 'wire'
    }
    await expect(
      gateway.dispatch({
        method: 'channel.wire',
        payload: { ...wire, actor: { kind: 'user', id: 'attacker' } },
        authorization
      })
    ).resolves.toEqual(expect.objectContaining({ status: 400 }))
    await gateway.dispatch({ method: 'channel.wire', payload: wire, authorization })
    const unwire = { wireId: 'wire', expectedRevision: 0, removedAt: 2, idempotencyKey: 'unwire' }
    await gateway.dispatch({ method: 'channel.unwire', payload: unwire, authorization })
    expect(wireRuntimeChannel).toHaveBeenCalledWith(
      wire,
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'owner' } })
    )
    expect(unwireRuntimeChannel).toHaveBeenCalledWith(
      unwire,
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'owner' } })
    )
  })

  it('routes authenticated Runtime Channel Wire list/get', async () => {
    const service = {
      runAgent: vi.fn(),
      listRuntimeChannelWires: vi.fn(async () => ({ wires: [{ id: 'wire' }] })),
      getRuntimeChannelWire: vi.fn(async (payload) => ({ wire: { id: payload.wireId } }))
    }
    const gateway = new MagicAgentSdkGateway(service as never, 'secret')
    const authorization = 'Bearer secret'
    await expect(
      gateway.dispatch({ method: 'channel.wire.list', payload: {}, authorization })
    ).resolves.toEqual({ status: 200, body: { wires: [{ id: 'wire' }] } })
    await expect(
      gateway.dispatch({ method: 'channel.wire.get', payload: { wireId: 'wire' }, authorization })
    ).resolves.toEqual({ status: 200, body: { wire: { id: 'wire' } } })
    expect(service.getRuntimeChannelWire).toHaveBeenCalledWith({ wireId: 'wire' })
  })

  it('routes authenticated Runtime Channel list/get through the redacted service boundary', async () => {
    const service = {
      runAgent: vi.fn(),
      listRuntimeChannels: vi.fn(async () => ({ channels: [{ id: 'channel' }] })),
      getRuntimeChannel: vi.fn(async (payload) => ({ channel: { id: payload.channelId } }))
    }
    const gateway = new MagicAgentSdkGateway(service as never, 'secret')
    const authorization = 'Bearer secret'
    await expect(
      gateway.dispatch({ method: 'channel.list', payload: {}, authorization })
    ).resolves.toEqual({ status: 200, body: { channels: [{ id: 'channel' }] } })
    await expect(
      gateway.dispatch({ method: 'channel.get', payload: { channelId: 'channel' }, authorization })
    ).resolves.toEqual({ status: 200, body: { channel: { id: 'channel' } } })
    expect(service.listRuntimeChannels).toHaveBeenCalledWith({})
    expect(service.getRuntimeChannel).toHaveBeenCalledWith({ channelId: 'channel' })
  })

  it('routes authenticated Trigger query and command methods through the public service', async () => {
    const service = {
      runAgent: vi.fn(),
      listTriggers: vi.fn(async () => ({ triggers: [] })),
      getTrigger: vi.fn(async (payload) => ({ trigger: payload.triggerId })),
      createTrigger: vi.fn(async () => ({ trigger: { id: 'created' } })),
      updateTrigger: vi.fn(async () => ({ trigger: { id: 'updated' } })),
      enableTrigger: vi.fn(async () => ({ trigger: { id: 'enabled' } })),
      disableTrigger: vi.fn(),
      pauseTrigger: vi.fn(),
      resumeTrigger: vi.fn(),
      retryTrigger: vi.fn(),
      manualFireTrigger: vi.fn(async () => ({ occurrence: { id: 'occurrence' } }))
    }
    const gateway = new MagicAgentSdkGateway(service as never, 'secret')
    const authorization = 'Bearer secret'
    await expect(
      gateway.dispatch({ method: 'trigger.list', payload: {}, authorization })
    ).resolves.toMatchObject({ status: 200, body: { triggers: [] } })
    await gateway.dispatch({ method: 'trigger.get', payload: { triggerId: 'one' }, authorization })
    await gateway.dispatch({ method: 'trigger.create', payload: { id: 'create' }, authorization })
    await gateway.dispatch({ method: 'trigger.update', payload: { id: 'update' }, authorization })
    await gateway.dispatch({ method: 'trigger.enable', payload: { id: 'enable' }, authorization })
    await gateway.dispatch({
      method: 'trigger.manualFire',
      payload: { id: 'manual' },
      authorization
    })
    expect(service.getTrigger).toHaveBeenCalledWith({ triggerId: 'one' })
    expect(service.createTrigger).toHaveBeenCalledWith({ id: 'create' })
    expect(service.updateTrigger).toHaveBeenCalledWith({ id: 'update' })
    expect(service.enableTrigger).toHaveBeenCalledWith({ id: 'enable' })
    expect(service.manualFireTrigger).toHaveBeenCalledWith({ id: 'manual' })
  })

  it('routes create/remove with the configured authenticated actor', async () => {
    const createRootAgentInstance = vi.fn(async () => ({ instance: { id: 'root' } }))
    const createChildAgentInstance = vi.fn(async () => ({ instance: { id: 'child' } }))
    const removeAgentInstance = vi.fn(async () => ({
      instance: { id: 'child', state: { status: 'removed' } }
    }))
    const gateway = new MagicAgentSdkGateway(
      {
        runAgent: vi.fn(),
        createRootAgentInstance,
        createChildAgentInstance,
        removeAgentInstance
      } as never,
      'secret',
      { kind: 'user', id: 'admin' }
    )
    const authorization = 'Bearer secret'
    await gateway.dispatch({
      method: 'agentInstance.createRoot',
      payload: { instance: { id: 'root' }, createdAt: 1, idempotencyKey: 'root' },
      authorization
    })
    await gateway.dispatch({
      method: 'agentInstance.createChild',
      payload: {
        parentInstanceId: 'root',
        parentExpectedRevision: 0,
        instance: { id: 'child' },
        createdAt: 2,
        idempotencyKey: 'child'
      },
      authorization
    })
    await gateway.dispatch({
      method: 'agentInstance.remove',
      payload: { instanceId: 'child', expectedRevision: 0, removedAt: 3, idempotencyKey: 'remove' },
      authorization
    })
    expect(createRootAgentInstance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'admin' } })
    )
    expect(createChildAgentInstance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'admin' } })
    )
    expect(removeAgentInstance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'admin' } })
    )
  })

  it('routes authenticated AgentInstance start through the public service', async () => {
    const startAgentInstance = vi.fn(async () => ({ instance: { id: 'instance-1', revision: 1 } }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), startAgentInstance } as never,
      'secret',
      { kind: 'user', id: 'user-1' }
    )
    const payload = {
      instanceId: 'instance-1',
      expectedRevision: 0,
      request: { agentId: 'agent-1', input: { prompt: 'work' } },
      idempotencyKey: 'start',
      grantId: 'grant-1',
      expectedGrantUseCount: 0
    }
    await expect(
      gateway.dispatch({ method: 'agentInstance.start', payload, authorization: 'Bearer secret' })
    ).resolves.toMatchObject({ status: 200, body: { instance: { id: 'instance-1', revision: 1 } } })
    expect(startAgentInstance).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ authenticatedActor: { kind: 'user', id: 'user-1' } })
    )
  })

  it('routes authenticated Drive delivery retry through the public service', async () => {
    const retryDelivery = vi.fn(async () => ({ drive: { id: 'drive-1', revision: 4 } }))
    const gateway = new MagicAgentSdkGateway(
      { runAgent: vi.fn(), retryDelivery } as never,
      'secret'
    )
    const payload = {
      driveId: 'drive-1',
      expectedRevision: 3,
      retryAt: 40,
      idempotencyKey: 'retry-drive'
    }
    await expect(
      gateway.dispatch({ method: 'drive.retryDelivery', payload, authorization: 'Bearer secret' })
    ).resolves.toMatchObject({ status: 200, body: { drive: { id: 'drive-1', revision: 4 } } })
    expect(retryDelivery).toHaveBeenCalledWith(payload)
  })

  it('rejects invalid trigger.emit payloads before resolving the runtime', async () => {
    const service = { runAgent: vi.fn() }
    const gateway = new MagicAgentSdkGateway(service as never, 'secret')
    await expect(
      gateway.dispatch({
        method: 'trigger.emit',
        payload: { source: 'sdk', eventId: '', eventName: 'x', emittedAt: 1 },
        authorization: 'Bearer secret'
      })
    ).resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } })
    await expect(
      gateway.dispatch({
        method: 'trigger.emit',
        payload: {
          source: 'custom',
          eventId: 'event',
          eventName: 'x',
          emittedAt: 1,
          payloadDigest: 'raw secret'
        },
        authorization: 'Bearer secret'
      })
    ).resolves.toMatchObject({ status: 400, body: { code: 'invalid_request' } })
  })

  it('fails closed for unsupported methods', async () => {
    const gateway = new MagicAgentSdkGateway({ runAgent: vi.fn() } as never, 'secret')
    await expect(
      gateway.dispatch({ method: 'tool.invoke', payload: {}, authorization: 'Bearer secret' })
    ).resolves.toMatchObject({ status: 404, body: { code: 'method_not_found' } })
  })
})
