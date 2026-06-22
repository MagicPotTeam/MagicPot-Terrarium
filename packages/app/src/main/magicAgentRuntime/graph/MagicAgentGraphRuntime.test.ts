import { describe, expect, it } from 'vitest'
import type { MagicAgentGraphDefinition } from '@shared/magicAgent'
import { MagicAgentGraphRuntime } from './MagicAgentGraphRuntime'

const testRoute = { channel: 'generic', scopeType: 'dm', scopeId: 'graph-test' } as const

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
