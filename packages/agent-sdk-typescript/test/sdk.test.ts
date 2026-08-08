import { describe, expect, it, vi } from 'vitest'
import {
  HttpAgentTransport,
  MagicAgentClient,
  MemoryAgentTransport,
  POLICY_REQUEST_VERSION,
  createTerminalPolicyRequest,
  evaluatePolicy,
  parseMagicAgentEnvelope
} from '../src/index'

describe('@magicpot/agent-sdk', () => {
  it('serializes graph node execution modes exactly', async () => {
    const transport = new MemoryAgentTransport(async () => ({
      runId: 'node-run',
      graphId: 'graph-1',
      status: 'completed'
    }))
    const client = new MagicAgentClient(transport)
    const route = { channel: 'sdk', scopeType: 'dm', scopeId: 'graph' } as const
    await client.runGraph({
      graphId: 'graph-1',
      input: 'explicit',
      route,
      nodeExecution: { mode: 'single-node', nodeId: 'writer', inputs: { input: 'explicit' } }
    })
    await client.runGraph({
      graphId: 'graph-1',
      input: 'continue',
      route,
      nodeExecution: { mode: 'run-from-node', nodeId: 'writer', priorRunId: 'run-prior' }
    })
    expect(transport.requests).toEqual([
      {
        method: 'graph.run',
        payload: {
          graphId: 'graph-1',
          input: 'explicit',
          route,
          nodeExecution: { mode: 'single-node', nodeId: 'writer', inputs: { input: 'explicit' } }
        }
      },
      {
        method: 'graph.run',
        payload: {
          graphId: 'graph-1',
          input: 'continue',
          route,
          nodeExecution: { mode: 'run-from-node', nodeId: 'writer', priorRunId: 'run-prior' }
        }
      }
    ])
  })

  it('preserves Graph V2 node-registry descriptors and uses the exact gateway method', async () => {
    const descriptors = [
      {
        kind: 'condition',
        category: 'Control' as const,
        title: 'Condition',
        description: 'Production condition.',
        executable: true,
        execution: { mode: 'legacy-runtime' as const, legacyKind: 'condition' as const },
        configSchema: { type: 'object', additionalProperties: false, properties: {} },
        defaultConfig: { operator: 'equals' },
        defaultInputs: [
          {
            portId: 'value',
            name: 'Value',
            direction: 'input' as const,
            role: 'data' as const,
            valueType: { kind: 'string' },
            required: true
          }
        ],
        defaultOutputs: []
      }
    ]
    const transport = new MemoryAgentTransport(async () => ({ descriptors }))

    const result = await new MagicAgentClient(transport).listGraphV2NodeRegistry()

    expect(result.descriptors).toEqual(descriptors)
    expect(transport.requests).toEqual([{ method: 'graph.v2.nodeRegistry.list', payload: {} }])
  })

  it('preserves an empty Graph V2 node registry without substituting defaults', async () => {
    const transport = new MemoryAgentTransport(async () => ({ descriptors: [] }))

    const result = await new MagicAgentClient(transport).listGraphV2NodeRegistry()

    expect(result.descriptors).toEqual([])
    expect(transport.requests).toEqual([{ method: 'graph.v2.nodeRegistry.list', payload: {} }])
  })

  it('serializes Graph V2 save/get without losing the public definition', async () => {
    const route = { channel: 'sdk', scopeType: 'dm', scopeId: 'graph' } as const
    const definition = {
      kind: 'magic-agent.graph-definition.v2-draft',
      graphMode: 'design',
      schemaVersion: 2,
      graphId: 'sdk.graph',
      name: 'SDK graph',
      description: 'round trip',
      version: '1.0.0',
      tags: ['sdk'],
      nodes: [],
      edges: [],
      variables: [],
      outputs: [],
      entryNodeIds: [],
      metadata: { nested: { exact: true } },
      legacySnapshot: {
        graphId: 'sdk.graph',
        name: 'SDK graph',
        description: 'round trip',
        version: '1.0.0',
        tags: ['sdk'],
        nodes: [],
        channels: [],
        outputs: [],
        entryNodeIds: []
      }
    } as const
    const transport = new MemoryAgentTransport(async (method) =>
      method === 'graph.v2.save'
        ? { graph: definition.legacySnapshot, definitionV2: definition }
        : { definitionV2: definition }
    )
    const client = new MagicAgentClient(transport)
    await expect(
      client.saveGraphV2({ graph: definition, route, replace: true })
    ).resolves.toMatchObject({ definitionV2: definition })
    await expect(client.getGraphV2({ graphId: definition.graphId, route })).resolves.toEqual({
      definitionV2: definition
    })
    expect(transport.requests).toEqual([
      { method: 'graph.v2.save', payload: { graph: definition, route, replace: true } },
      { method: 'graph.v2.get', payload: { graphId: definition.graphId, route } }
    ])
  })
  it('serializes session export/diff exactly and returns bounded public results', async () => {
    const exportResult = {
      format: 'jsonl',
      mimeType: 'application/x-ndjson; charset=utf-8',
      filename: 'session.jsonl',
      body: '{"redacted":true,"bounded":true}',
      availability: { messages: { status: 'available' } }
    }
    const diffResult = {
      schemaVersion: 1,
      leftSessionKey: 'generic:dm:left',
      rightSessionKey: 'generic:dm:right',
      relationship: { relationship: 'unrelated' },
      dimensions: {},
      timeline: [],
      sideBySide: []
    }
    const transport = new MemoryAgentTransport(async (method) =>
      method === 'session.export' ? exportResult : diffResult
    )
    const client = new MagicAgentClient(transport)
    const sourceRoute = { channel: 'generic', scopeType: 'dm', scopeId: 'left' } as const
    const rightRoute = { channel: 'generic', scopeType: 'dm', scopeId: 'right' } as const
    await expect(client.exportSession({ sourceRoute, format: 'jsonl' })).resolves.toEqual(
      exportResult
    )
    await expect(client.diffSessions({ leftRoute: sourceRoute, rightRoute })).resolves.toEqual(
      diffResult
    )
    expect(transport.requests).toEqual([
      { method: 'session.export', payload: { sourceRoute, format: 'jsonl' } },
      { method: 'session.diff', payload: { leftRoute: sourceRoute, rightRoute } }
    ])
    expect(JSON.stringify(transport.requests)).not.toContain('actor')
  })
  it('serializes session.fork exactly and returns the count-only public result without actor data', async () => {
    const result = {
      targetSessionKey: 'generic:dm:target',
      lineage: {
        sourceSessionKey: 'generic:dm:source',
        sourceEventId: 'event-2',
        sourceRunId: 'run-1',
        forkedAt: 123
      },
      warning: 'External side effects are not rolled back.',
      counts: { messages: 2, runs: 1, events: 3, artifacts: 1 }
    }
    const transport = new MemoryAgentTransport(async () => result)
    const client = new MagicAgentClient(transport)
    const request = {
      sourceRoute: { channel: 'generic', scopeType: 'dm', scopeId: 'source' },
      sourceEventId: 'event-2',
      targetRoute: { channel: 'generic', scopeType: 'dm', scopeId: 'target' },
      idempotencyKey: 'fork-1'
    } as const

    await expect(client.forkSessionAtEvent(request)).resolves.toEqual(result)
    expect(transport.requests).toEqual([{ method: 'session.fork', payload: request }])
    expect(JSON.stringify(transport.requests)).not.toContain('actor')
    expect(JSON.stringify(result)).not.toMatch(/content|messages\s*":\s*\[/)
  })
  it('is independently usable through a transport', async () => {
    const transport = new MemoryAgentTransport(async (method) => ({
      runId: method,
      status: 'completed',
      output: { ok: true }
    }))
    const result = await new MagicAgentClient(transport).run({
      agentId: 'agent',
      input: { value: 1 }
    })
    expect(result).toMatchObject({ runId: 'agent.run', status: 'completed' })
    expect(transport.requests).toHaveLength(1)
  })

  it('serializes pending-input inject, edit, and cancel requests exactly', async () => {
    const transport = new MemoryAgentTransport(async (_method, payload) => ({
      runId: 'run',
      pendingInputId: (payload as { pendingInputId: string }).pendingInputId,
      revision: 2,
      status: 'submitted'
    }))
    const client = new MagicAgentClient(transport)
    const common = {
      runId: 'run',
      route: { channel: 'sdk', scopeType: 'run', scopeId: 'run' },
      pendingInputId: 'pending',
      expectedRevision: 1
    } as const
    await client.injectPendingInput({ ...common, value: 'first' })
    await client.editPendingInput({ ...common, value: 'second', idempotencyKey: 'edit-1' })
    await client.cancelPendingInput(common)
    expect(transport.requests).toEqual([
      { method: 'graphRun.input.inject', payload: { ...common, value: 'first' } },
      {
        method: 'graphRun.input.edit',
        payload: { ...common, value: 'second', idempotencyKey: 'edit-1' }
      },
      { method: 'graphRun.input.cancel', payload: common }
    ])
    expect(JSON.stringify(transport.requests)).not.toContain('actor')
  })

  it('provides typed actor-free Graph Run steering methods', async () => {
    const transport = new MemoryAgentTransport(async (method) =>
      method === 'graphRun.pause'
        ? { runId: 'run', paused: true, status: 'paused' }
        : method === 'graphRun.resume'
          ? { runId: 'run', resumed: true, status: 'running' }
          : { runId: 'run', cancelled: true }
    )
    const client = new MagicAgentClient(transport)
    const request = { runId: 'run', route: { channel: 'sdk', scopeType: 'run', scopeId: 'run' } }
    await client.pauseGraphRun(request)
    await client.resumeGraphRun(request)
    await client.cancelGraphRun({ ...request, reason: 'stop' })
    expect(transport.requests.map((item) => item.method)).toEqual([
      'graphRun.pause',
      'graphRun.resume',
      'graphRun.cancel'
    ])
    expect(JSON.stringify(transport.requests)).not.toContain('actor')
  })

  it('streams typed graph-run attach events with cursor serialization', async () => {
    const stream = vi.fn((_method, payload) =>
      (async function* () {
        expect(payload).toEqual({
          runId: 'run',
          route: { channel: 'sdk', scopeType: 'run', scopeId: 'run' },
          afterEventId: 'e0'
        })
        yield {
          eventId: 'e1',
          runId: 'run',
          sequence: 1,
          kind: 'run.started',
          timestamp: 1,
          payload: {}
        }
      })()
    )
    const client = new MagicAgentClient({ request: vi.fn(), stream })
    const events = []
    for await (const event of client.attachGraphRun({
      runId: 'run',
      route: { channel: 'sdk', scopeType: 'run', scopeId: 'run' },
      afterEventId: 'e0'
    }))
      events.push(event)
    expect(events.map((event) => event.eventId)).toEqual(['e1'])
    expect(stream).toHaveBeenCalledWith('graphRun.attach', expect.any(Object), undefined)
  })

  it('provides actor-free Agent replace with approval metadata', async () => {
    const resource = {
      id: 'instance',
      revision: 1,
      state: { definitionId: 'new', configVersion: 'v2' },
      createdAt: 1,
      updatedAt: 2
    }
    const transport = new MemoryAgentTransport(async () => resource)
    const client = new MagicAgentClient(transport)
    await client.replaceAgentInstance({
      instanceId: 'instance',
      expectedRevision: 0,
      definitionId: 'new',
      name: 'New',
      configVersion: 'v2',
      replacedAt: 2,
      idempotencyKey: 'replace',
      grantId: 'grant',
      expectedGrantUseCount: 0
    })
    expect(transport.requests[0]?.method).toBe('agentInstance.replace')
    const serialized = JSON.stringify(transport.requests[0])
    expect(serialized).toContain('grantId')
    expect(serialized).not.toContain('actor')
  })

  it('provides actor-free Team methods with approval metadata', async () => {
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
    const transport = new MemoryAgentTransport(async () => resource)
    const client = new MagicAgentClient(transport)
    await client.createTeam({
      team: { id: 'team', name: 'Team', createdAt: 1 },
      idempotencyKey: 'create',
      grantId: 'grant',
      expectedGrantUseCount: 0
    })
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
    await client.replaceTeam({
      teamId: 'team',
      expectedRevision: 2,
      replacements: [
        { memberId: 'member', definitionId: 'new', name: 'New', configVersion: 'v2', replacedAt: 5 }
      ],
      idempotencyKey: 'replace'
    })
    await client.startTeam({
      teamId: 'team',
      expectedRevision: 2,
      request: { agentId: 'agent', text: 'run' },
      idempotencyKey: 'start'
    })
    await client.pauseTeam({
      teamId: 'team',
      expectedRevision: 2,
      idempotencyKey: 'pause'
    })
    await client.resumeTeam({
      teamId: 'team',
      expectedRevision: 2,
      idempotencyKey: 'resume'
    })
    await client.stopTeam({
      teamId: 'team',
      expectedRevision: 2,
      idempotencyKey: 'stop'
    })
    expect(transport.requests.map((item) => item.method)).toEqual([
      'team.create',
      'team.member.add',
      'team.member.remove',
      'team.remove',
      'team.replace',
      'team.start',
      'team.pause',
      'team.resume',
      'team.stop'
    ])
    const serialized = JSON.stringify(transport.requests)
    expect(serialized).toContain('grantId')
    expect(serialized).not.toMatch(/actor|ownerId|createdBy|addedBy/)
  })

  it('provides typed Runtime Channel read methods', async () => {
    const resource = {
      id: 'channel',
      revision: 1,
      state: { id: 'channel', name: 'Channel', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      updatedAt: 2
    }
    const transport = new MemoryAgentTransport(async (method) =>
      method === 'channel.list' ? { channels: [resource] } : { channel: resource }
    )
    const client = new MagicAgentClient(transport)
    await expect(client.listRuntimeChannels()).resolves.toEqual([resource])
    await expect(client.getRuntimeChannel('channel')).resolves.toEqual(resource)
    expect(transport.requests).toEqual([
      { method: 'channel.list', payload: {} },
      { method: 'channel.get', payload: { channelId: 'channel' } }
    ])
  })

  it('provides actor-free RuntimeChannel publish with redacted result', async () => {
    const result = { messageId: 'message', revision: 1, channelId: 'channel', status: 'published' }
    const transport = new MemoryAgentTransport(async () => result)
    const client = new MagicAgentClient(transport)
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
    ).resolves.toEqual(result)
    expect(transport.requests[0].method).toBe('channel.publish')
    expect(JSON.stringify(transport.requests[0])).not.toContain('actor')
  })

  it('provides actor-free RuntimeChannel create with approval metadata', async () => {
    const resource = {
      id: 'channel',
      revision: 0,
      state: { mode: 'queue' },
      createdAt: 1,
      updatedAt: 1
    }
    const transport = new MemoryAgentTransport(async () => ({ channel: resource }))
    const client = new MagicAgentClient(transport)
    await client.createRuntimeChannel({
      channel: { id: 'channel', name: 'Channel', mode: 'queue', capacity: 5 },
      createdAt: 1,
      idempotencyKey: 'create',
      grantId: 'grant',
      expectedGrantUseCount: 0
    })
    expect(transport.requests[0]).toEqual({
      method: 'channel.create',
      payload: expect.objectContaining({ grantId: 'grant' })
    })
    expect(JSON.stringify(transport.requests[0])).not.toContain('actor')
  })

  it('provides typed Runtime Channel Agent membership methods without actor fields', async () => {
    const channel = {
      id: 'channel',
      revision: 1,
      state: { id: 'channel', name: 'Channel', mode: 'queue', capacity: 2, members: [] },
      createdAt: 1,
      updatedAt: 2
    }
    const transport = new MemoryAgentTransport(async () => ({ channel }))
    const client = new MagicAgentClient(transport)
    const member = {
      memberId: 'member',
      agentInstanceId: 'agent',
      role: 'consumer' as const,
      joinedAt: 1
    }
    await client.joinRuntimeChannel({
      channelId: 'channel',
      expectedRevision: 0,
      member,
      joinedAt: 1,
      idempotencyKey: 'join'
    })
    await client.leaveRuntimeChannel({
      channelId: 'channel',
      expectedRevision: 1,
      memberId: 'member',
      leftAt: 2,
      idempotencyKey: 'leave'
    })
    expect(transport.requests.map((request) => request.method)).toEqual([
      'channel.join',
      'channel.leave'
    ])
    expect(JSON.stringify(transport.requests)).not.toContain('actor')
  })

  it('provides typed Runtime Channel Wire read methods', async () => {
    const wire = {
      id: 'wire',
      revision: 1,
      state: {
        id: 'wire',
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
    const transport = new MemoryAgentTransport(async (method) =>
      method === 'channel.wire.list' ? { wires: [wire] } : { wire }
    )
    const client = new MagicAgentClient(transport)
    await expect(client.listRuntimeChannelWires()).resolves.toEqual([wire])
    await expect(client.getRuntimeChannelWire('wire')).resolves.toEqual(wire)
    expect(transport.requests).toEqual([
      { method: 'channel.wire.list', payload: {} },
      { method: 'channel.wire.get', payload: { wireId: 'wire' } }
    ])
  })

  it('provides typed Runtime Channel Wire mutation methods without actor fields', async () => {
    const wire = {
      id: 'wire',
      revision: 0,
      state: {
        id: 'wire',
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
    const transport = new MemoryAgentTransport(async () => ({ wire }))
    const client = new MagicAgentClient(transport)
    await client.wireRuntimeChannel({ wire: wire.state, idempotencyKey: 'wire' })
    await client.unwireRuntimeChannel({
      wireId: 'wire',
      expectedRevision: 0,
      removedAt: 2,
      idempotencyKey: 'unwire'
    })
    expect(transport.requests.map((request) => request.method)).toEqual([
      'channel.wire',
      'channel.unwire'
    ])
    expect(JSON.stringify(transport.requests)).not.toContain('actor')
  })

  it('provides typed Runtime Channel delivery methods without actor fields', async () => {
    const transport = new MemoryAgentTransport(async (method) =>
      method === 'channel.claim'
        ? {
            messageId: 'message',
            revision: 1,
            channelId: 'channel',
            consumerMemberId: 'consumer',
            claimToken: 'token',
            leaseExpiresAt: 100
          }
        : {
            messageId: 'message',
            revision: 2,
            channelId: 'channel',
            consumerMemberId: 'consumer',
            acknowledgedAt: 20
          }
    )
    const client = new MagicAgentClient(transport)
    const claim = {
      messageId: 'message',
      expectedRevision: 0,
      consumerMemberId: 'consumer',
      claimedAt: 10,
      leaseMs: 100,
      idempotencyKey: 'claim'
    }
    const claimed = await client.claimRuntimeChannelMessage(claim)
    await expect(
      client.acknowledgeRuntimeChannelMessage({
        messageId: 'message',
        expectedRevision: claimed.revision,
        consumerMemberId: 'consumer',
        acknowledgedAt: 20,
        token: claimed.claimToken!,
        idempotencyKey: 'ack'
      })
    ).resolves.toEqual(expect.objectContaining({ acknowledgedAt: 20 }))
    expect(transport.requests[0]).toEqual({ method: 'channel.claim', payload: claim })
    expect(JSON.stringify(transport.requests)).not.toContain('actor')
  })

  it('provides actor-free pause/resume methods', async () => {
    const resource = {
      id: 'instance',
      revision: 2,
      state: { status: 'paused' },
      createdAt: 1,
      updatedAt: 2
    }
    const transport = new MemoryAgentTransport(async () => ({ instance: resource }))
    const client = new MagicAgentClient(transport)
    await client.pauseAgentInstance({
      instanceId: 'instance',
      expectedRevision: 1,
      idempotencyKey: 'pause'
    })
    await client.resumeAgentInstance({
      instanceId: 'instance',
      expectedRevision: 2,
      idempotencyKey: 'resume'
    })
    expect(transport.requests.map((request) => request.method)).toEqual([
      'agentInstance.pause',
      'agentInstance.resume'
    ])
    expect(JSON.stringify(transport.requests)).not.toContain('actor')
  })

  it('provides config version methods without raw config or actor fields', async () => {
    const resource = {
      id: 'instance',
      revision: 1,
      state: { configVersion: 'v2' },
      createdAt: 1,
      updatedAt: 2
    }
    const transport = new MemoryAgentTransport(async (method) =>
      method === 'agentInstance.config.create'
        ? { version: 'v2', definitionId: 'definition', contentDigest: 'a'.repeat(64), createdAt: 1 }
        : { instance: resource }
    )
    const client = new MagicAgentClient(transport)
    await client.createAgentConfigVersion({
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
      idempotencyKey: 'create',
      grantId: 'grant',
      expectedGrantUseCount: 0
    })
    await client.stageAgentConfig({
      instanceId: 'instance',
      expectedRevision: 0,
      configVersion: 'v2',
      stagedAt: 1,
      idempotencyKey: 'stage'
    })
    await client.activateAgentConfig({
      instanceId: 'instance',
      expectedRevision: 1,
      activatedAt: 2,
      idempotencyKey: 'activate'
    })
    await client.rollbackAgentConfig({
      instanceId: 'instance',
      expectedRevision: 2,
      rolledBackAt: 3,
      idempotencyKey: 'rollback'
    })
    expect(transport.requests.map((request) => request.method)).toEqual([
      'agentInstance.config.create',
      'agentInstance.config.stage',
      'agentInstance.config.activate',
      'agentInstance.config.rollback'
    ])
    expect(JSON.stringify(transport.requests)).not.toMatch(/actor|createdBy|contentDigest/)
    expect(JSON.stringify(transport.requests)).toContain('grant')
  })

  it('serializes create/remove approval metadata without actor', async () => {
    const resource = {
      id: 'root',
      revision: 0,
      state: { status: 'created' },
      createdAt: 1,
      updatedAt: 1
    }
    const transport = new MemoryAgentTransport(async () => ({ instance: resource }))
    const client = new MagicAgentClient(transport)
    await client.createRootAgentInstance({
      instance: { id: 'root' },
      createdAt: 1,
      idempotencyKey: 'root',
      grantId: 'create-grant',
      expectedGrantUseCount: 0
    })
    await client.createChildAgentInstance({
      parentInstanceId: 'root',
      parentExpectedRevision: 0,
      instance: { id: 'child' },
      createdAt: 2,
      idempotencyKey: 'child',
      grantId: 'child-grant',
      expectedGrantUseCount: 1
    })
    await client.removeAgentInstance({
      instanceId: 'root',
      expectedRevision: 0,
      removedAt: 3,
      idempotencyKey: 'remove',
      grantId: 'remove-grant',
      expectedGrantUseCount: 2
    })
    expect(transport.requests.map((request) => request.method)).toEqual([
      'agentInstance.createRoot',
      'agentInstance.createChild',
      'agentInstance.remove'
    ])
    expect(transport.requests[0].payload).toMatchObject({
      grantId: 'create-grant',
      expectedGrantUseCount: 0
    })
    expect(JSON.stringify(transport.requests)).not.toContain('actor')
  })

  it('provides typed AgentInstance convenience methods', async () => {
    const resource = {
      id: 'instance-1',
      revision: 0,
      state: { status: 'created' },
      createdAt: 1,
      updatedAt: 1
    }
    const transport = new MemoryAgentTransport(async (method) =>
      method === 'agentInstance.list' ? { instances: [resource] } : { instance: resource }
    )
    const client = new MagicAgentClient(transport)
    await expect(client.listAgentInstances()).resolves.toEqual([resource])
    await client.getAgentInstance('instance-1')
    await client.startAgentInstance({
      instanceId: 'instance-1',
      expectedRevision: 0,
      request: { agentId: 'agent-1', input: { prompt: 'work' } },
      idempotencyKey: 'start',
      grantId: 'grant-1',
      expectedGrantUseCount: 0
    })
    expect(transport.requests.at(-1)).toEqual({
      method: 'agentInstance.start',
      payload: {
        instanceId: 'instance-1',
        expectedRevision: 0,
        request: { agentId: 'agent-1', input: { prompt: 'work' } },
        idempotencyKey: 'start',
        grantId: 'grant-1',
        expectedGrantUseCount: 0
      }
    })
  })

  it('provides typed Drive convenience methods', async () => {
    const transport = new MemoryAgentTransport(async (method, payload) =>
      method === 'drive.list'
        ? { drives: [] }
        : { drive: { id: 'drive-1', revision: 0, state: payload, createdAt: 1, updatedAt: 1 } }
    )
    const client = new MagicAgentClient(transport)
    await expect(client.listDrives()).resolves.toEqual([])
    await expect(
      client.createDrive({ drive: { id: 'drive-1' }, createdAt: 1, idempotencyKey: 'create' })
    ).resolves.toMatchObject({ id: 'drive-1' })
    await client.transferDrive({
      driveId: 'drive-1',
      expectedRevision: 0,
      assigneeId: 'agent-2',
      transferredAt: 2,
      idempotencyKey: 'transfer'
    })
    await client.setDriveLinks({
      driveId: 'drive-1',
      expectedRevision: 1,
      links: [],
      updatedAt: 3,
      idempotencyKey: 'links'
    })
    await client.retryDriveDelivery({
      driveId: 'drive-1',
      expectedRevision: 2,
      retryAt: 4,
      idempotencyKey: 'retry'
    })
    expect(transport.requests.at(-1)).toEqual({
      method: 'drive.retryDelivery',
      payload: {
        driveId: 'drive-1',
        expectedRevision: 2,
        retryAt: 4,
        idempotencyKey: 'retry'
      }
    })
    expect(transport.requests.map(({ method }) => method)).toEqual([
      'drive.list',
      'drive.create',
      'drive.transfer',
      'drive.setLinks',
      'drive.retryDelivery'
    ])
  })

  it('provides typed Trigger runtime convenience methods', async () => {
    const transport = new MemoryAgentTransport(async (method, payload) =>
      method === 'trigger.list'
        ? { triggers: [] }
        : method === 'trigger.emit'
          ? { enqueued: 1 }
          : method === 'trigger.manualFire'
            ? {
                occurrence: { id: 'occurrence', revision: 0, state: {}, createdAt: 1, updatedAt: 1 }
              }
            : { trigger: { id: method, revision: 0, state: payload, createdAt: 1, updatedAt: 1 } }
    )
    const client = new MagicAgentClient(transport)
    await expect(client.listTriggers()).resolves.toEqual([])
    await expect(
      client.enableTrigger({
        triggerId: 'one',
        expectedTriggerRevision: 0,
        idempotencyKey: 'enable',
        requestedAt: 1
      })
    ).resolves.toMatchObject({ id: 'trigger.enable' })
    await expect(
      client.emitTriggerEvent({
        source: 'sdk',
        eventId: 'event-1',
        eventName: 'order.created',
        emittedAt: 1,
        payloadDigest: 'c'.repeat(64)
      })
    ).resolves.toBe(1)
    await expect(
      client.manualFireTrigger({
        triggerId: 'one',
        expectedTriggerRevision: 0,
        idempotencyKey: 'manual',
        requestedAt: 1,
        occurrenceId: 'occurrence'
      })
    ).resolves.toMatchObject({ id: 'occurrence' })
    expect(transport.requests.map(({ method }) => method)).toEqual([
      'trigger.list',
      'trigger.enable',
      'trigger.emit',
      'trigger.manualFire'
    ])
  })

  it('uses the production HTTP SDK boundary with bearer authentication', async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify({ runId: 'run-http', status: 'completed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    const transport = new HttpAgentTransport({
      baseUrl: 'https://magicpot.invalid/',
      token: 'test-token',
      fetch: fetch as typeof globalThis.fetch
    })
    await new MagicAgentClient(transport).run({ agentId: 'agent', input: {} })
    expect(fetch).toHaveBeenCalledWith(
      'https://magicpot.invalid/v2/sdk/agent.run',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer test-token' })
      })
    )
  })
  it('ships the canonical policy request and pure evaluator contracts', () => {
    const request = createTerminalPolicyRequest({
      requestId: 'sdk-policy-1',
      actor: { kind: 'agent', id: 'sdk-consumer' },
      target: { kind: 'tool', id: 'terminal.run' },
      command: 'node',
      args: ['--version'],
      cwd: '/workspace'
    })
    expect(request.version).toBe(POLICY_REQUEST_VERSION)
    expect(
      evaluatePolicy(
        request,
        [
          {
            ruleId: 'sdk-deny-terminal',
            priority: 1,
            effect: 'deny',
            explanation: 'SDK clients cannot execute terminal commands.',
            match: { action: ['terminal.execute'] }
          }
        ],
        { evaluatedAt: 1, policyVersion: 'sdk-test' }
      )
    ).toMatchObject({ effect: 'deny', matchedRuleIds: ['sdk-deny-terminal'] })
  })

  it('ships the canonical versioned envelope parser', () => {
    expect(
      parseMagicAgentEnvelope({
        id: 'env-1',
        type: 'agent.run.result',
        createdAt: 1,
        protocolVersion: '2.0.0',
        payload: { ok: true }
      })
    ).toMatchObject({ ok: true, value: { id: 'env-1', payload: { ok: true } } })
  })
})
