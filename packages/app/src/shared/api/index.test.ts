import { describe, expect, it } from 'vitest'
import { apiDef } from './index'
import {
  ServiceValidationError,
  type ServiceValidator,
  validateServiceValue
} from './apiUtils/serviceValidation'

describe('apiDef', () => {
  it('exposes the managed media derivative contract', () => {
    expect(apiDef.svcManagedMedia.ensureDerivative.type).toBe('unary')
    expect(apiDef.svcManagedMedia.ensureDerivative.request).toBeDefined()
  })

  it('validates ComfyUI batch control and authorized start requests', () => {
    expect(() =>
      validateServiceValue({ batchId: '  ' }, apiDef.svcComfyBatch.getBatch.request)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          sourceRoot: 'C:/photos',
          userAuthorized: false,
          workflow: {},
          binding: { inputNodeId: '1', inputField: 'image', outputNodeId: '2' }
        },
        apiDef.svcComfyBatch.startBatch.request
      )
    ).toThrow(ServiceValidationError)
    expect(
      validateServiceValue(
        {
          sourceRoot: 'C:/photos',
          userAuthorized: true,
          workflow: {},
          binding: { inputNodeId: '1', inputField: 'image', outputNodeId: '2' }
        },
        apiDef.svcComfyBatch.startBatch.request
      )
    ).toMatchObject({ userAuthorized: true, sourceRoot: 'C:/photos' })
  })

  it('rejects unsafe remote ComfyUI origins and unknown instance mutation fields', () => {
    expect(() =>
      validateServiceValue(
        {
          id: 'remote-private',
          name: 'Private',
          origin: 'http://169.254.169.254:8188/',
          kind: 'remote',
          maxConcurrency: 1,
          enabled: true
        },
        apiDef.svcComfyBatch.putInstance.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          id: 'instance',
          expectedRevision: 0,
          patch: { enabled: true, unexpected: 'field' }
        },
        apiDef.svcComfyBatch.updateInstance.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          id: 'spoofed-local',
          name: 'Spoofed local',
          origin: 'http://127.0.0.1:8188/',
          kind: 'local',
          maxConcurrency: 1,
          enabled: true
        },
        apiDef.svcComfyBatch.putInstance.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          id: 'instance',
          expectedRevision: 0,
          patch: { kind: 'local' }
        },
        apiDef.svcComfyBatch.updateInstance.request
      )
    ).toThrow(ServiceValidationError)
    expect(
      validateServiceValue(
        {
          id: 'public-remote',
          name: 'Public remote',
          origin: 'https://comfy.example.com/',
          kind: 'remote',
          maxConcurrency: 1,
          enabled: true
        },
        apiDef.svcComfyBatch.putInstance.request
      )
    ).toMatchObject({ kind: 'remote', origin: 'https://comfy.example.com/' })
  })

  it('exposes the project canvas thumbnail service contract', () => {
    expect(apiDef.svcCanvasThumbnail).toBeDefined()
    expect(apiDef.svcCanvasThumbnail.getSourceFileMetadata.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.getThumbnailCacheRoot.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.readThumbnailManifest.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.writeThumbnailSet.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.generateThumbnailSet.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.createNativeThumbnail.type).toBe('unary')
  })

  it('exposes the app update service contract', () => {
    expect(apiDef.svcAppUpdate).toBeDefined()
    expect(apiDef.svcAppUpdate.getStatus.type).toBe('unary')
    expect(apiDef.svcAppUpdate.checkForUpdates.type).toBe('unary')
    expect(apiDef.svcAppUpdate.downloadUpdate.type).toBe('unary')
    expect(apiDef.svcAppUpdate.installUpdate.type).toBe('unary')
    expect(apiDef.svcAppUpdate.watchStatus.type).toBe('serverStreaming')
  })

  it('exposes the MagicAgent Platform v1 service contract', () => {
    expect(apiDef.svcMagicAgentPlatform).toBeDefined()
    expect(apiDef.svcMagicAgentPlatform.getStatus.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.listTools.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.callTool.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.runAgent.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.listRuntimeChannels.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.getRuntimeChannel.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.listRuntimeChannelWires.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.getRuntimeChannelWire.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.claimRuntimeChannelMessage.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.acknowledgeRuntimeChannelMessage.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.listGraphs.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.runGraph.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.getRuntimeGraphTopology.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.watchGraphRun.type).toBe('serverStreaming')
    expect(apiDef.svcMagicAgentPlatform.listPendingApprovals.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.watchPendingApprovals.type).toBe('serverStreaming')
    expect(apiDef.svcMagicAgentPlatform.resolvePendingApproval.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.validatePackageManifest.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.installPackage.type).toBe('unary')
    expect(apiDef.svcMagicAgentPlatform.callTool.request).toBeDefined()
    expect(apiDef.svcMagicAgentPlatform.runAgent.request).toBeDefined()
    expect(apiDef.svcMagicAgentPlatform.watchGraphRun.request).toBeDefined()
    expect(apiDef.svcMagicAgentPlatform.watchPendingApprovals.request).toBeDefined()
    expect(apiDef.svcMagicAgentPlatform.resolvePendingApproval.request).toBeDefined()
    expect(apiDef.svcMagicAgentPlatform.installPackage.request).toBeDefined()
  })

  it('strictly validates least-privilege runtime topology requests', () => {
    const validator = apiDef.svcMagicAgentPlatform.getRuntimeGraphTopology.request
    const request = {
      runId: 'run-1',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' }
    }
    expect(validateServiceValue(request, validator)).toEqual(request)
    expect(() =>
      validateServiceValue({ ...request, sessionKey: 'private-session' }, validator)
    ).toThrow(ServiceValidationError)
    expect(() => validateServiceValue({ ...request, route: undefined }, validator)).toThrow(
      ServiceValidationError
    )
  })

  it('strictly validates Runtime Channel reads', () => {
    const validator = apiDef.svcMagicAgentPlatform.getRuntimeChannel.request
    expect(validateServiceValue({ channelId: 'channel-1' }, validator)).toEqual({
      channelId: 'channel-1'
    })
    expect(() => validateServiceValue({ channelId: 'channel-1', extra: true }, validator)).toThrow(
      ServiceValidationError
    )
  })

  it('strictly validates create/remove grant metadata and rejects actor injection', () => {
    const remove = {
      instanceId: 'instance',
      expectedRevision: 1,
      removedAt: 2,
      idempotencyKey: 'remove',
      grantId: 'grant',
      expectedGrantUseCount: 0
    }
    expect(
      validateServiceValue(remove, apiDef.svcMagicAgentPlatform.removeAgentInstance.request)
    ).toEqual(remove)
    expect(() =>
      validateServiceValue(
        { ...remove, actor: { kind: 'user', id: 'caller' } },
        apiDef.svcMagicAgentPlatform.removeAgentInstance.request
      )
    ).toThrow(ServiceValidationError)
  })

  it('strictly validates Agent pause/resume and rejects actor injection', () => {
    const pause = { instanceId: 'instance', expectedRevision: 1, idempotencyKey: 'pause' }
    expect(
      validateServiceValue(pause, apiDef.svcMagicAgentPlatform.pauseAgentInstance.request)
    ).toEqual(pause)
    expect(() =>
      validateServiceValue(
        { ...pause, actor: { kind: 'agent', id: 'other' } },
        apiDef.svcMagicAgentPlatform.pauseAgentInstance.request
      )
    ).toThrow(ServiceValidationError)
    expect(
      validateServiceValue(
        { ...pause, idempotencyKey: 'resume' },
        apiDef.svcMagicAgentPlatform.resumeAgentInstance.request
      )
    ).toEqual({ ...pause, idempotencyKey: 'resume' })
  })

  it('strictly validates actor-free Agent replace', () => {
    const validator = apiDef.svcMagicAgentPlatform.replaceAgentInstance.request
    const request = {
      instanceId: 'instance',
      expectedRevision: 0,
      definitionId: 'new',
      name: 'New',
      configVersion: 'v2',
      replacedAt: 2,
      idempotencyKey: 'replace'
    }
    expect(validateServiceValue(request, validator)).toEqual(request)
    expect(() =>
      validateServiceValue({ ...request, actor: { kind: 'agent', id: 'spoof' } }, validator)
    ).toThrow(ServiceValidationError)
  })

  it('strictly validates actor-free Team mutations', () => {
    const create = apiDef.svcMagicAgentPlatform.createTeam.request
    const add = apiDef.svcMagicAgentPlatform.addTeamMember.request
    const remove = apiDef.svcMagicAgentPlatform.removeTeamMember.request
    const createReq = { team: { id: 'team', name: 'Team', createdAt: 1 }, idempotencyKey: 'create' }
    const addReq = {
      teamId: 'team',
      expectedRevision: 0,
      member: { memberId: 'member', agentInstanceId: 'agent', role: 'leader', joinedAt: 2 },
      idempotencyKey: 'add'
    }
    const removeReq = {
      teamId: 'team',
      expectedRevision: 1,
      memberId: 'member',
      removedAt: 3,
      idempotencyKey: 'remove'
    }
    expect(validateServiceValue(createReq, create)).toEqual(createReq)
    expect(validateServiceValue(addReq, add)).toEqual(addReq)
    expect(validateServiceValue(removeReq, remove)).toEqual(removeReq)
    const removeTeam = apiDef.svcMagicAgentPlatform.removeTeam.request
    const removeTeamReq = {
      teamId: 'team',
      expectedRevision: 2,
      removedAt: 4,
      idempotencyKey: 'remove-team'
    }
    expect(validateServiceValue(removeTeamReq, removeTeam)).toEqual(removeTeamReq)
    expect(() =>
      validateServiceValue({ ...removeTeamReq, actor: { kind: 'user', id: 'spoof' } }, removeTeam)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue({ ...createReq, actor: { kind: 'user', id: 'spoof' } }, create)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue({ ...createReq, team: { ...createReq.team, ownerId: 'spoof' } }, create)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        { ...addReq, member: { ...addReq.member, addedBy: { kind: 'user', id: 'spoof' } } },
        add
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue({ ...addReq, member: { ...addReq.member, role: 'admin' } }, add)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue({ ...removeReq, actor: { kind: 'user', id: 'spoof' } }, remove)
    ).toThrow(ServiceValidationError)
  })

  it('deeply validates immutable Agent config content and rejects authority injection', () => {
    const request = {
      config: {
        version: 'v2',
        definitionId: 'definition',
        model: { profileId: 'model' },
        systemPrompt: 'safe',
        inference: { temperature: 0.2, maxTokens: 100 },
        tools: { allowedToolNames: ['read'] },
        memory: { allowHistory: false, contextMessageLimit: 10, scope: 'instance' },
        policy: { policyIds: ['base'], workspaceRoots: ['/workspace'] },
        channels: { channelIds: [] },
        budgets: { maxRuntimeMs: 1000, maxToolCalls: 2 },
        createdAt: 1
      },
      idempotencyKey: 'create'
    }
    const validator = apiDef.svcMagicAgentPlatform.createAgentConfigVersion.request
    expect(validateServiceValue(request, validator)).toEqual(request)
    for (const injected of [
      { ...request, actor: { kind: 'user', id: 'attacker' } },
      { ...request, config: { ...request.config, createdBy: { kind: 'user', id: 'attacker' } } },
      { ...request, config: { ...request.config, contentDigest: '0'.repeat(64) } },
      {
        ...request,
        config: { ...request.config, tools: { allowedToolNames: ['read'], permit: 'secret' } }
      }
    ])
      expect(() => validateServiceValue(injected, validator)).toThrow(ServiceValidationError)
  })

  it('strictly validates Agent config version commands and rejects actor/config payload injection', () => {
    const stage = {
      instanceId: 'instance',
      expectedRevision: 0,
      configVersion: 'v2',
      stagedAt: 1,
      idempotencyKey: 'stage'
    }
    const validator = apiDef.svcMagicAgentPlatform.stageAgentConfig.request
    expect(validateServiceValue(stage, validator)).toEqual(stage)
    expect(() =>
      validateServiceValue({ ...stage, actor: { kind: 'agent', id: 'attacker' } }, validator)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue({ ...stage, config: { prompt: 'secret' } }, validator)
    ).toThrow(ServiceValidationError)
  })

  it('strictly validates Runtime Channel publish and rejects actor injection', () => {
    const publish = {
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
    }
    expect(
      validateServiceValue(
        publish,
        apiDef.svcMagicAgentPlatform.publishRuntimeChannelMessage.request
      )
    ).toEqual(publish)
    expect(() =>
      validateServiceValue(
        { ...publish, actor: { kind: 'agent', id: 'other' } },
        apiDef.svcMagicAgentPlatform.publishRuntimeChannelMessage.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        { ...publish, message: { ...publish.message, claimToken: 'secret' } },
        apiDef.svcMagicAgentPlatform.publishRuntimeChannelMessage.request
      )
    ).toThrow(ServiceValidationError)
  })

  it('strictly validates Runtime Channel create and rejects actor/member injection', () => {
    const create = {
      channel: { id: 'channel', name: 'Channel', mode: 'queue', capacity: 5 },
      createdAt: 1,
      idempotencyKey: 'create',
      grantId: 'grant',
      expectedGrantUseCount: 0
    }
    expect(
      validateServiceValue(create, apiDef.svcMagicAgentPlatform.createRuntimeChannel.request)
    ).toEqual(create)
    expect(() =>
      validateServiceValue(
        { ...create, actor: { kind: 'user', id: 'caller' } },
        apiDef.svcMagicAgentPlatform.createRuntimeChannel.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        { ...create, channel: { ...create.channel, members: [] } },
        apiDef.svcMagicAgentPlatform.createRuntimeChannel.request
      )
    ).toThrow(ServiceValidationError)
  })

  it('strictly validates Runtime Channel Agent membership mutation', () => {
    const join = {
      channelId: 'channel',
      expectedRevision: 0,
      member: { memberId: 'member', agentInstanceId: 'agent', role: 'consumer', joinedAt: 1 },
      joinedAt: 1,
      idempotencyKey: 'join'
    }
    const validator = apiDef.svcMagicAgentPlatform.joinRuntimeChannel.request
    expect(validateServiceValue(join, validator)).toEqual(join)
    expect(() =>
      validateServiceValue({ ...join, actor: { kind: 'agent', id: 'attacker' } }, validator)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        { ...join, member: { ...join.member, graphTargetId: 'graph' } },
        validator
      )
    ).toThrow(ServiceValidationError)
  })

  it('strictly validates Runtime Channel wire mutation and rejects actor injection', () => {
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
    const validator = apiDef.svcMagicAgentPlatform.wireRuntimeChannel.request
    expect(validateServiceValue(wire, validator)).toEqual(wire)
    expect(() =>
      validateServiceValue({ ...wire, actor: { kind: 'agent', id: 'attacker' } }, validator)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue({ ...wire, wire: { ...wire.wire, enabled: 'yes' } }, validator)
    ).toThrow(ServiceValidationError)
  })

  it('strictly validates Runtime Channel wire lookup', () => {
    const validator = apiDef.svcMagicAgentPlatform.getRuntimeChannelWire.request
    expect(validateServiceValue({ wireId: 'wire' }, validator)).toEqual({ wireId: 'wire' })
    expect(() => validateServiceValue({ wireId: 'wire', forwarding: true }, validator)).toThrow(
      ServiceValidationError
    )
  })

  it('strictly validates Runtime Channel delivery without accepting actor injection', () => {
    const claim = {
      messageId: 'message',
      expectedRevision: 0,
      consumerMemberId: 'consumer',
      claimedAt: 1,
      leaseMs: 100,
      idempotencyKey: 'claim'
    }
    expect(
      validateServiceValue(claim, apiDef.svcMagicAgentPlatform.claimRuntimeChannelMessage.request)
    ).toEqual(claim)
    expect(() =>
      validateServiceValue(
        { ...claim, actor: { kind: 'agent', id: 'attacker' } },
        apiDef.svcMagicAgentPlatform.claimRuntimeChannelMessage.request
      )
    ).toThrow(ServiceValidationError)
    const ack = {
      messageId: 'message',
      expectedRevision: 1,
      consumerMemberId: 'consumer',
      acknowledgedAt: 2,
      token: 'secret-token',
      idempotencyKey: 'ack'
    }
    expect(
      validateServiceValue(
        ack,
        apiDef.svcMagicAgentPlatform.acknowledgeRuntimeChannelMessage.request
      )
    ).toEqual(ack)
    expect(() =>
      validateServiceValue(
        { ...ack, actor: { kind: 'agent', id: 'attacker' } },
        apiDef.svcMagicAgentPlatform.acknowledgeRuntimeChannelMessage.request
      )
    ).toThrow(ServiceValidationError)
  })

  it('validates MagicAgent Platform renderer requests at the API boundary', () => {
    expect(() =>
      validateServiceValue({ name: 123 }, apiDef.svcMagicAgentPlatform.callTool.request)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue({ text: '' }, apiDef.svcMagicAgentPlatform.runAgent.request)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        { name: 'creative.echo', source: 'creative' },
        apiDef.svcMagicAgentPlatform.callTool.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue({ text: 'hello' }, apiDef.svcMagicAgentPlatform.runAgent.request)
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        { text: 'hello', route: { channel: 'generic', scopeType: 'bad', scopeId: 'demo' } },
        apiDef.svcMagicAgentPlatform.runAgent.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          text: 'hello',
          route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' },
          allowedToolNames: ['']
        },
        apiDef.svcMagicAgentPlatform.runAgent.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          text: 'hello',
          route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' },
          timeoutMs: 0
        },
        apiDef.svcMagicAgentPlatform.runAgent.request
      )
    ).toThrow(ServiceValidationError)
    expect(
      validateServiceValue(
        {
          name: 'creative.echo',
          args: { prompt: 'hi' },
          source: 'creative',
          route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
        },
        apiDef.svcMagicAgentPlatform.callTool.request
      )
    ).toMatchObject({
      name: 'creative.echo',
      args: { prompt: 'hi' },
      source: 'creative',
      route: { channel: 'generic', scopeType: 'dm', scopeId: 'demo' }
    })
    expect(
      validateServiceValue(
        {
          agentId: 'agent-1',
          text: 'continue',
          sessionId: 'session-1',
          route: { channel: 'drive', scopeType: 'channel', scopeId: 'drive-1' }
        },
        apiDef.svcMagicAgentPlatform.runAgent.request
      )
    ).toMatchObject({ sessionId: 'session-1' })
  })

  it('requires route binding for mutating and run-scoped MagicAgent graph requests', () => {
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'graph-demo' }
    const graph = {
      graphId: 'graph.demo',
      name: 'Demo Graph',
      description: 'Demo graph.',
      version: '1.0.0',
      tags: [],
      nodes: [
        {
          nodeId: 'input',
          kind: 'input',
          name: 'Input',
          description: 'Receives the graph input.'
        },
        {
          nodeId: 'final',
          kind: 'output',
          name: 'Final',
          description: 'Produces the final output.'
        }
      ],
      channels: [
        {
          channelId: 'input-to-final',
          from: 'input',
          to: 'final',
          kind: 'artifact'
        }
      ],
      outputs: [
        {
          outputId: 'final-doc',
          name: 'Final Document',
          description: 'Final document output.',
          sourceNodeId: 'final',
          channelId: 'input-to-final'
        }
      ],
      entryNodeIds: ['input']
    }

    const routeRequiredCases: Array<[unknown, ServiceValidator<unknown> | undefined]> = [
      [{ graph }, apiDef.svcMagicAgentPlatform.createGraph.request as ServiceValidator<unknown>],
      [
        { graphId: 'graph.demo', input: 'hello' },
        apiDef.svcMagicAgentPlatform.runGraph.request as ServiceValidator<unknown>
      ],
      [
        { graphId: 'graph.demo' },
        apiDef.svcMagicAgentPlatform.listGraphRuns.request as ServiceValidator<unknown>
      ],
      [
        { runId: 'run-1' },
        apiDef.svcMagicAgentPlatform.getGraphRun.request as ServiceValidator<unknown>
      ],
      [
        { runId: 'run-1' },
        apiDef.svcMagicAgentPlatform.watchGraphRun.request as ServiceValidator<unknown>
      ],
      [
        { runId: 'run-1' },
        apiDef.svcMagicAgentPlatform.cancelGraphRun.request as ServiceValidator<unknown>
      ]
    ]

    for (const [request, validator] of routeRequiredCases) {
      expect(() => validateServiceValue(request, validator)).toThrow(ServiceValidationError)
    }

    expect(() =>
      validateServiceValue(
        { graph: { ...graph, nodes: [] }, route },
        apiDef.svcMagicAgentPlatform.createGraph.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          graph: {
            ...graph,
            nodes: [{ ...graph.nodes[0], kind: 'unsupported' }]
          },
          route
        },
        apiDef.svcMagicAgentPlatform.createGraph.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        {
          graph: {
            ...graph,
            outputs: [{ ...graph.outputs[0], channelId: 'missing-channel' }]
          },
          route
        },
        apiDef.svcMagicAgentPlatform.createGraph.request
      )
    ).toThrow(ServiceValidationError)

    expect(
      validateServiceValue(
        { graph, route, replace: true },
        apiDef.svcMagicAgentPlatform.createGraph.request
      )
    ).toMatchObject({ graph: { graphId: 'graph.demo' }, route, replace: true })
    expect(
      validateServiceValue(
        { graphId: 'graph.demo', input: 'hello', route },
        apiDef.svcMagicAgentPlatform.runGraph.request
      )
    ).toMatchObject({ graphId: 'graph.demo', input: 'hello', route })
    expect(
      validateServiceValue(
        {
          graphId: 'graph.demo',
          input: 'hello',
          route,
          nodeExecution: { mode: 'single-node', nodeId: 'final', inputs: { input: 'explicit' } }
        },
        apiDef.svcMagicAgentPlatform.runGraph.request
      )
    ).toMatchObject({
      nodeExecution: { mode: 'single-node', nodeId: 'final', inputs: { input: 'explicit' } }
    })
    expect(
      validateServiceValue(
        {
          graphId: 'graph.demo',
          input: 'hello',
          route,
          nodeExecution: { mode: 'run-from-node', nodeId: 'final', priorRunId: 'run-prior' }
        },
        apiDef.svcMagicAgentPlatform.runGraph.request
      )
    ).toMatchObject({
      nodeExecution: { mode: 'run-from-node', nodeId: 'final', priorRunId: 'run-prior' }
    })
    expect(() =>
      validateServiceValue(
        {
          graphId: 'graph.demo',
          input: 'hello',
          route,
          nodeExecution: { mode: 'single-node', nodeId: 'final' }
        },
        apiDef.svcMagicAgentPlatform.runGraph.request
      )
    ).toThrow(ServiceValidationError)
    expect(
      validateServiceValue(
        { graphId: 'graph.demo', route, limit: 50 },
        apiDef.svcMagicAgentPlatform.listGraphRuns.request
      )
    ).toMatchObject({ graphId: 'graph.demo', route, limit: 50 })
    expect(() =>
      validateServiceValue(
        { graphId: 'graph.demo', route, limit: 0 },
        apiDef.svcMagicAgentPlatform.listGraphRuns.request
      )
    ).toThrow(ServiceValidationError)
    expect(() =>
      validateServiceValue(
        { graphId: 'graph.demo', route, limit: 1.5 },
        apiDef.svcMagicAgentPlatform.listGraphRuns.request
      )
    ).toThrow(ServiceValidationError)
    expect(
      validateServiceValue(
        { runId: 'run-1', route },
        apiDef.svcMagicAgentPlatform.getGraphRun.request
      )
    ).toMatchObject({ runId: 'run-1', route })
    expect(
      validateServiceValue(
        { runId: 'run-1', route },
        apiDef.svcMagicAgentPlatform.watchGraphRun.request
      )
    ).toMatchObject({ runId: 'run-1', route })
    expect(
      validateServiceValue(
        { runId: 'run-1', route, reason: 'stop' },
        apiDef.svcMagicAgentPlatform.cancelGraphRun.request
      )
    ).toMatchObject({ runId: 'run-1', route, reason: 'stop' })
  })
})
