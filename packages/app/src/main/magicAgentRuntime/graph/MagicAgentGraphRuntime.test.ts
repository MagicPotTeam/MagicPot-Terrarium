import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MagicAgentGraphDefinition } from '@shared/magicAgent'
import { MagicAgentGraphRuntime } from './MagicAgentGraphRuntime'

const testRoute = { channel: 'generic', scopeType: 'dm', scopeId: 'graph-test' } as const

afterEach(() => {
  vi.restoreAllMocks()
})

const createTestGraph = (graphId = 'test.graph'): MagicAgentGraphDefinition => ({
  graphId,
  name: 'Test Graph',
  description: 'A test graph.',
  version: '1.0.0',
  tags: ['test'],
  entryNodeIds: ['planner'],
  nodes: [
    {
      nodeId: 'planner',
      kind: 'agent',
      name: 'Planner',
      description: 'Plans the work.',
      instruction: 'Plan the requested work.'
    },
    {
      nodeId: 'writer',
      kind: 'agent',
      name: 'Writer',
      description: 'Writes the final result.',
      instruction: 'Write the final result.'
    },
    {
      nodeId: 'final',
      kind: 'output',
      name: 'Final Output',
      description: 'Final output node.'
    }
  ],
  channels: [
    {
      channelId: 'plan-to-writer',
      from: 'planner',
      to: 'writer',
      kind: 'handoff',
      label: 'Plan handoff',
      required: true
    },
    {
      channelId: 'writer-to-final',
      from: 'writer',
      to: 'final',
      kind: 'artifact',
      label: 'Final artifact',
      required: true
    }
  ],
  outputs: [
    {
      outputId: 'final-doc',
      name: 'Final Document',
      description: 'Final document output.',
      sourceNodeId: 'final',
      channelId: 'writer-to-final',
      mimeType: 'text/markdown'
    }
  ]
})

describe('MagicAgentGraphRuntime', () => {
  it('lists and inspects built-in team definitions', () => {
    const runtime = new MagicAgentGraphRuntime()

    const list = runtime.list()
    expect(list.map((graph) => graph.graphId)).toEqual(
      expect.arrayContaining(['builtin.game-concept-team', 'builtin.comfy-workflow-builder-team'])
    )
    expect(list.find((graph) => graph.graphId === 'builtin.game-concept-team')?.builtIn).toBe(true)

    const gameConcept = runtime.inspect('builtin.game-concept-team')
    expect(gameConcept?.name).toBe('Game Concept Team')
    expect(gameConcept?.outputs[0]?.outputId).toBe('game-concept-pitch')

    const comfy = runtime.inspect('builtin.comfy-workflow-builder-team')
    expect(comfy?.name).toBe('Comfy Workflow Builder Team')
    expect(comfy?.outputs[0]?.outputId).toBe('comfy-workflow-blueprint')
  })

  it('creates, lists, and inspects additive graph definitions', () => {
    const runtime = new MagicAgentGraphRuntime([])
    const created = runtime.create({ graph: createTestGraph(), route: testRoute })

    expect(created.graphId).toBe('test.graph')
    expect(runtime.list()).toMatchObject([
      {
        graphId: 'test.graph',
        nodeCount: 3,
        channelCount: 2,
        outputCount: 1,
        builtIn: false
      }
    ])

    const inspected = runtime.inspect('test.graph')
    expect(inspected).toEqual(created)
    inspected?.nodes.push({
      nodeId: 'mutated',
      kind: 'agent',
      name: 'Mutated',
      description: 'Should not affect runtime.'
    })
    expect(runtime.inspect('test.graph')?.nodes).toHaveLength(3)
  })

  it('rejects missing or malformed routes instead of defaulting graph route identity', async () => {
    const runtime = new MagicAgentGraphRuntime([])

    expect(() => runtime.create({ graph: createTestGraph(), route: undefined } as never)).toThrow(
      /route is required/
    )
    expect(() =>
      runtime.create({
        graph: createTestGraph(),
        route: { channel: 'generic', scopeType: 'bad', scopeId: 'x' }
      } as never)
    ).toThrow(/route\.scopeType/)

    runtime.create({ graph: createTestGraph(), route: testRoute })
    await expect(
      runtime.run({ graphId: 'test.graph', input: 'hello', route: undefined } as never)
    ).rejects.toThrow(/route is required/)
  })

  it('runs a graph and records channel wires and outputs', async () => {
    const runtime = new MagicAgentGraphRuntime([])
    runtime.create({ graph: createTestGraph(), route: testRoute })

    const result = await runtime.run({
      graphId: 'test.graph',
      input: 'Build a tiny puzzle game.',
      route: testRoute,
      runId: 'run-1'
    })

    expect(result.status).toBe('completed')
    expect(result.channels).toHaveLength(2)
    expect(result.channels[0]).toMatchObject({
      channelId: 'plan-to-writer',
      from: 'planner',
      to: 'writer',
      kind: 'handoff'
    })
    expect(result.channels[0]?.content).toContain('Build a tiny puzzle game.')
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0]).toMatchObject({
      outputId: 'final-doc',
      sourceNodeId: 'final',
      channelId: 'writer-to-final',
      mimeType: 'text/markdown'
    })
    expect(result.outputs[0]?.content).toContain('# Final Document')
    expect(result.sessionKey).toBe('generic:dm:graph-test')
    expect(result.metadata).toMatchObject({ sessionKey: 'generic:dm:graph-test' })
    expect(runtime.getRun('run-1', 'generic:dm:graph-test')?.status).toBe('completed')
    expect(runtime.getRun('run-1', 'generic:dm:other')).toBeUndefined()
    expect(runtime.getRun('run-1', '')).toBeUndefined()
    expect(runtime.listRuns('generic:dm:graph-test')).toHaveLength(1)
    expect(runtime.listRuns('generic:dm:other')).toEqual([])
    expect(runtime.listRuns('')).toEqual([])
  })

  it('partitions and bounds graph runs by route session key and graph id', async () => {
    let timestamp = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => timestamp++)
    const runtime = new MagicAgentGraphRuntime([])
    const graphA = createTestGraph('test.graph-a')
    const graphB = createTestGraph('test.graph-b')
    const routeA = testRoute
    const routeB = { channel: 'generic', scopeType: 'dm', scopeId: 'graph-other' } as const
    runtime.create({ graph: graphA, route: routeA })
    runtime.create({ graph: graphB, route: routeA })

    await runtime.run({
      graphId: 'test.graph-a',
      input: 'Route A graph A.',
      route: routeA,
      runId: 'run-a-1'
    })
    await runtime.run({
      graphId: 'test.graph-b',
      input: 'Route A graph B.',
      route: routeA,
      runId: 'run-a-2'
    })
    await runtime.run({
      graphId: 'test.graph-a',
      input: 'Route B graph A.',
      route: routeB,
      runId: 'run-b-1'
    })

    expect(runtime.listRuns('generic:dm:graph-test').map((run) => run.runId)).toEqual([
      'run-a-2',
      'run-a-1'
    ])
    expect(
      runtime.listRuns('generic:dm:graph-test', 'test.graph-a').map((run) => run.runId)
    ).toEqual(['run-a-1'])
    expect(
      runtime.listRuns('generic:dm:graph-test', 'test.graph-b').map((run) => run.runId)
    ).toEqual(['run-a-2'])
    expect(
      runtime.listRuns('generic:dm:graph-other', 'test.graph-a').map((run) => run.runId)
    ).toEqual(['run-b-1'])
    expect(runtime.listRuns('generic:dm:graph-test', undefined, 1).map((run) => run.runId)).toEqual(
      ['run-a-2']
    )
    expect(runtime.listRuns('generic:dm:graph-test', undefined, 0).map((run) => run.runId)).toEqual(
      ['run-a-2', 'run-a-1']
    )
    expect(runtime.listRuns('generic:dm:unknown', 'test.graph-a')).toEqual([])
    expect(runtime.getRun('run-a-1', 'generic:dm:graph-test')?.runId).toBe('run-a-1')
    expect(runtime.getRun('run-a-1', 'generic:dm:graph-other')).toBeUndefined()

    const pendingRun = runtime.run({
      graphId: 'test.graph-a',
      input: 'Cancel only from the owning route.',
      route: routeA,
      runId: 'run-pending-route-a'
    })
    expect(runtime.cancel('run-pending-route-a', 'generic:dm:graph-other', 'Wrong route.')).toEqual(
      {
        runId: 'run-pending-route-a',
        cancelled: false,
        error: 'Run not found.'
      }
    )
    expect(
      runtime.cancel('run-pending-route-a', 'generic:dm:graph-test', 'Stop requested.')
    ).toEqual({
      runId: 'run-pending-route-a',
      cancelled: true,
      status: 'cancelled'
    })
    await expect(pendingRun).resolves.toMatchObject({
      runId: 'run-pending-route-a',
      status: 'cancelled',
      error: 'Stop requested.'
    })
  })

  it('can run only requested outputs', async () => {
    const runtime = new MagicAgentGraphRuntime([])
    runtime.create({
      route: testRoute,
      graph: {
        ...createTestGraph(),
        outputs: [
          ...createTestGraph().outputs,
          {
            outputId: 'brief',
            name: 'Brief',
            description: 'Short brief.',
            sourceNodeId: 'writer',
            mimeType: 'text/plain'
          }
        ]
      }
    })

    const result = await runtime.run({
      graphId: 'test.graph',
      input: 'Only brief please.',
      route: testRoute,
      outputIds: ['brief']
    })

    expect(result.status).toBe('completed')
    expect(result.outputs.map((output) => output.outputId)).toEqual(['brief'])
  })

  it('executes agent and tool nodes with fail-closed graph tool allowlists', async () => {
    const runAgent = vi.fn(async (req) => ({
      runId: `agent-run-${req.agentId}`,
      agentId: req.agentId || 'unknown',
      status: 'completed' as const,
      content: `agent:${req.agentId}:${req.text}`,
      messages: [{ role: 'assistant' as const, content: `agent:${req.agentId}:${req.text}` }],
      toolCalls: [],
      events: [],
      startedAt: 1,
      finishedAt: 2
    }))
    const callTool = vi.fn(async (req) => ({
      ok: true,
      toolName: req.name,
      source: 'magicAgentRuntime' as const,
      status: 'ok' as const,
      content: `tool:${req.name}:${String(req.args?.input || '')}`
    }))
    const runtime = new MagicAgentGraphRuntime([], { runAgent, callTool })
    runtime.create({
      route: testRoute,
      graph: {
        graphId: 'test.executable-tool',
        name: 'Executable Tool Graph',
        description: 'Runs an agent and a graph-scoped tool.',
        version: '1.0.0',
        tags: ['test'],
        entryNodeIds: ['planner'],
        nodes: [
          {
            nodeId: 'planner',
            kind: 'agent',
            name: 'Planner',
            description: 'Planner.',
            agentId: 'planner-agent',
            instruction: 'Plan with tools.'
          },
          {
            nodeId: 'formatter',
            kind: 'tool',
            name: 'Formatter',
            description: 'Formats planner output.',
            toolName: 'graph.format'
          },
          {
            nodeId: 'final',
            kind: 'output',
            name: 'Final',
            description: 'Final output.'
          }
        ],
        channels: [
          {
            channelId: 'planner-to-formatter',
            from: 'planner',
            to: 'formatter',
            kind: 'handoff',
            required: true
          },
          {
            channelId: 'formatter-to-final',
            from: 'formatter',
            to: 'final',
            kind: 'artifact',
            required: true
          }
        ],
        outputs: [
          {
            outputId: 'final-output',
            name: 'Final Output',
            description: 'Final output.',
            sourceNodeId: 'final',
            channelId: 'formatter-to-final',
            mimeType: 'text/plain'
          }
        ]
      }
    })

    await expect(
      runtime.run({
        graphId: 'test.executable-tool',
        input: 'format this',
        route: testRoute,
        runId: 'run-tool-denied'
      })
    ).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('not allowed')
    })
    expect(callTool).not.toHaveBeenCalled()

    const result = await runtime.run({
      graphId: 'test.executable-tool',
      input: 'format this',
      route: testRoute,
      runId: 'run-tool-allowed',
      allowedToolNames: ['graph.format']
    })

    expect(result.status).toBe('completed')
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'planner-agent',
        text: 'format this',
        route: testRoute,
        allowedToolNames: ['graph.format'],
        metadata: expect.objectContaining({
          graphId: 'test.executable-tool',
          graphRunId: 'run-tool-allowed',
          nodeId: 'planner',
          sessionKey: 'generic:dm:graph-test'
        })
      })
    )
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'graph.format',
        route: testRoute,
        args: expect.objectContaining({ input: expect.stringContaining('agent:planner-agent') }),
        metadata: expect.objectContaining({
          graphId: 'test.executable-tool',
          graphRunId: 'run-tool-allowed',
          nodeId: 'formatter',
          allowedToolNames: ['graph.format']
        })
      })
    )
    expect(result.nodes?.map((node) => [node.nodeId, node.status])).toEqual([
      ['planner', 'completed'],
      ['formatter', 'completed'],
      ['final', 'completed']
    ])
    expect(result.channels.map((channel) => channel.channelId)).toEqual([
      'planner-to-formatter',
      'formatter-to-final'
    ])
    expect(result.outputs[0]?.content).toContain('tool:graph.format')
    expect(result.events?.map((event) => event.type)).toEqual(
      expect.arrayContaining(['tool.invoked', 'channel.message', 'output.created'])
    )
  })

  it('skips inactive conditional branches and uses real source node output', async () => {
    const runAgent = vi.fn(async (req) => ({
      runId: `agent-run-${req.agentId}`,
      agentId: req.agentId || 'unknown',
      status: 'completed' as const,
      content: req.agentId === 'planner-agent' ? 'NO_GO' : `unexpected:${req.agentId}`,
      messages: [{ role: 'assistant' as const, content: 'NO_GO' }],
      toolCalls: [],
      events: [],
      startedAt: 1,
      finishedAt: 2
    }))
    const runtime = new MagicAgentGraphRuntime([], { runAgent })
    runtime.create({
      route: testRoute,
      graph: {
        graphId: 'test.conditional-skip',
        name: 'Conditional Skip Graph',
        description: 'Skips optional inactive branches.',
        version: '1.0.0',
        tags: ['test'],
        entryNodeIds: ['planner'],
        nodes: [
          {
            nodeId: 'planner',
            kind: 'agent',
            name: 'Planner',
            description: 'Planner.',
            agentId: 'planner-agent'
          },
          {
            nodeId: 'reviewer',
            kind: 'agent',
            name: 'Reviewer',
            description: 'Should be skipped.',
            agentId: 'reviewer-agent'
          },
          {
            nodeId: 'final',
            kind: 'output',
            name: 'Final',
            description: 'Final output.'
          }
        ],
        channels: [
          {
            channelId: 'planner-to-reviewer',
            from: 'planner',
            to: 'reviewer',
            kind: 'handoff',
            required: false,
            condition: { operator: 'contains', value: 'APPROVE' }
          },
          {
            channelId: 'planner-to-final',
            from: 'planner',
            to: 'final',
            kind: 'artifact',
            required: true
          }
        ],
        outputs: [
          {
            outputId: 'final-output',
            name: 'Final Output',
            description: 'Final output.',
            sourceNodeId: 'final',
            channelId: 'planner-to-final',
            mimeType: 'text/plain'
          }
        ]
      }
    })

    const result = await runtime.run({
      graphId: 'test.conditional-skip',
      input: 'conditional input',
      route: testRoute,
      runId: 'run-conditional-skip'
    })

    expect(result.status).toBe('completed')
    expect(runAgent).toHaveBeenCalledTimes(1)
    expect(result.channels.map((channel) => channel.channelId)).toEqual(['planner-to-final'])
    expect(result.nodes?.find((node) => node.nodeId === 'reviewer')).toMatchObject({
      status: 'skipped',
      metadata: expect.objectContaining({ reason: expect.stringContaining('No active inbound') })
    })
    expect(result.outputs[0]?.content).toContain('## Source Output\nNO_GO')
    expect(result.outputs[0]?.content).not.toContain('unexpected:reviewer-agent')
    expect(result.events?.map((event) => event.type)).toEqual(
      expect.arrayContaining(['node.skipped'])
    )
  })

  it('fails when a required channel is not delivered', async () => {
    const runAgent = vi.fn(async (req) => ({
      runId: `agent-run-${req.agentId}`,
      agentId: req.agentId || 'unknown',
      status: 'completed' as const,
      content: 'NO_GO',
      messages: [{ role: 'assistant' as const, content: 'NO_GO' }],
      toolCalls: [],
      events: [],
      startedAt: 1,
      finishedAt: 2
    }))
    const runtime = new MagicAgentGraphRuntime([], { runAgent })
    runtime.create({
      route: testRoute,
      graph: {
        graphId: 'test.required-channel',
        name: 'Required Channel Graph',
        description: 'Required conditional channel must be delivered.',
        version: '1.0.0',
        tags: ['test'],
        entryNodeIds: ['planner'],
        nodes: [
          {
            nodeId: 'planner',
            kind: 'agent',
            name: 'Planner',
            description: 'Planner.',
            agentId: 'planner-agent'
          },
          {
            nodeId: 'reviewer',
            kind: 'agent',
            name: 'Reviewer',
            description: 'Requires planner channel.',
            agentId: 'reviewer-agent'
          },
          {
            nodeId: 'final',
            kind: 'output',
            name: 'Final',
            description: 'Final output.'
          }
        ],
        channels: [
          {
            channelId: 'planner-to-reviewer',
            from: 'planner',
            to: 'reviewer',
            kind: 'handoff',
            required: true,
            condition: { operator: 'contains', value: 'APPROVE' }
          },
          {
            channelId: 'reviewer-to-final',
            from: 'reviewer',
            to: 'final',
            kind: 'artifact',
            required: true
          }
        ],
        outputs: [
          {
            outputId: 'final-output',
            name: 'Final Output',
            description: 'Final output.',
            sourceNodeId: 'final',
            channelId: 'reviewer-to-final',
            mimeType: 'text/plain'
          }
        ]
      }
    })

    const result = await runtime.run({
      graphId: 'test.required-channel',
      input: 'conditional input',
      route: testRoute,
      runId: 'run-required-missing'
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('Required MagicAgentGraph channel')
    expect(result.nodes?.find((node) => node.nodeId === 'reviewer')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('planner-to-reviewer')
    })
    expect(result.events?.map((event) => event.type)).toEqual(
      expect.arrayContaining(['node.failed', 'graph.failed'])
    )
  })

  it('cancels a pending run', () => {
    const runtime = new MagicAgentGraphRuntime([])
    runtime.create({ graph: createTestGraph(), route: testRoute })

    const runPromise = runtime.run({
      graphId: 'test.graph',
      input: 'Cancel this run.',
      route: testRoute,
      runId: 'run-cancel'
    })
    expect(runtime.cancel('run-cancel', 'generic:dm:other', 'Wrong session.')).toEqual({
      runId: 'run-cancel',
      cancelled: false,
      error: 'Run not found.'
    })
    expect(runtime.cancel('run-cancel', '', 'Missing session.')).toEqual({
      runId: 'run-cancel',
      cancelled: false,
      error: 'Run not found.'
    })
    const cancelResult = runtime.cancel('run-cancel', 'generic:dm:graph-test', 'Stop requested.')

    expect(cancelResult).toEqual({ runId: 'run-cancel', cancelled: true, status: 'cancelled' })
    return expect(runPromise).resolves.toMatchObject({
      runId: 'run-cancel',
      status: 'cancelled',
      error: 'Stop requested.'
    })
  })

  it('rejects invalid channel and output wiring', () => {
    const runtime = new MagicAgentGraphRuntime([])

    expect(() =>
      runtime.create({
        route: testRoute,
        graph: {
          ...createTestGraph(),
          channels: [
            {
              channelId: 'missing-wire',
              from: 'planner',
              to: 'missing',
              kind: 'handoff'
            }
          ]
        }
      })
    ).toThrow(/missing to node/i)

    expect(() =>
      runtime.create({
        route: testRoute,
        graph: {
          ...createTestGraph('test.invalid-output'),
          outputs: [
            {
              outputId: 'bad-output',
              name: 'Bad Output',
              description: 'Invalid output.',
              sourceNodeId: 'missing'
            }
          ]
        }
      })
    ).toThrow(/missing source node/i)
  })
})
