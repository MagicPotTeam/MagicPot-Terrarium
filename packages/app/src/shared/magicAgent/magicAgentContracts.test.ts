import { describe, expect, it } from 'vitest'
import {
  MAGIC_AGENT_PACKAGE_MAGIC,
  createMagicAgentPackage,
  normalizeMagicAgentSpec,
  validateMagicAgentGraphSpec,
  validateMagicAgentInputSpec,
  validateMagicAgentPackage,
  validateMagicAgentSpec,
  validateMagicAgentToolSpec,
  type AgentSpec
} from './index'

const minimalAgent: AgentSpec = {
  contractVersion: 1,
  id: 'demo.agent',
  title: 'Demo Agent',
  version: '1.2.3',
  tags: ['demo'],
  instructions: 'Help with demo tasks.',
  tools: [
    {
      id: 'tool.generate',
      name: 'generate',
      title: 'Generate',
      description: 'Generate an artifact.',
      scope: 'agent',
      transport: 'local',
      destructive: false,
      async: true,
      inputSchema: { type: 'object' }
    }
  ],
  triggers: [
    {
      id: 'manual',
      type: 'manual',
      title: 'Manual',
      enabled: true
    }
  ],
  inputs: [
    {
      id: 'prompt',
      type: 'string',
      title: 'Prompt',
      required: true
    }
  ],
  outputs: [
    {
      id: 'result',
      type: 'markdown',
      title: 'Result'
    }
  ],
  plugins: [
    {
      id: 'memory',
      kind: 'memory',
      title: 'Memory',
      version: '1.0.0',
      permissions: ['session.read']
    }
  ],
  events: {
    emits: ['run.started', 'run.completed'],
    consumes: ['input.requested']
  },
  graph: {
    nodes: [
      { id: 'prompt', type: 'input', title: 'Prompt' },
      { id: 'generate', type: 'tool', title: 'Generate', ref: 'tool.generate' },
      { id: 'result', type: 'output', title: 'Result' }
    ],
    edges: [
      { id: 'prompt-generate', from: 'prompt', to: 'generate' },
      { id: 'generate-result', from: 'generate', to: 'result' }
    ],
    entryNodeIds: ['prompt'],
    outputNodeIds: ['result']
  }
}

describe('MagicAgent contracts', () => {
  it('normalizes AgentSpec fields and nested contracts', () => {
    const normalized = normalizeMagicAgentSpec({
      id: ' demo agent ',
      title: ' Demo Agent ',
      version: '',
      tags: [' demo ', 'demo', '', 'image'],
      instructions: '  Follow instructions.  ',
      tools: [
        {
          id: ' tool.one ',
          name: ' one ',
          title: ' One ',
          description: ' First tool ',
          transport: 'mcp',
          async: true
        }
      ],
      triggers: [{ id: ' start ', title: ' Start ' }],
      inputs: [{ id: ' prompt ', type: 'string', title: ' Prompt ', required: true }],
      outputs: [{ id: ' answer ', type: 'markdown', title: ' Answer ' }],
      plugins: [{ id: ' memory ', kind: 'memory', title: ' Memory ', permissions: [' read '] }],
      events: { emits: [' run.started ', 'run.started'], consumes: ['input.requested'] },
      graph: {
        nodes: [{ id: ' prompt ', type: 'input', title: ' Prompt ' }],
        edges: [],
        entryNodeIds: ['prompt', 'prompt'],
        outputNodeIds: ['answer']
      }
    })

    expect(normalized).toMatchObject({
      id: 'demo-agent',
      title: 'Demo Agent',
      version: '1.0.0',
      tags: ['demo', 'image'],
      instructions: 'Follow instructions.',
      tools: [
        {
          id: 'tool.one',
          name: 'one',
          title: 'One',
          scope: 'agent',
          transport: 'mcp',
          destructive: false,
          async: true
        }
      ],
      triggers: [{ id: 'start', type: 'manual', title: 'Start', enabled: true }],
      inputs: [{ id: 'prompt', type: 'string', title: 'Prompt', required: true }],
      outputs: [{ id: 'answer', type: 'markdown', title: 'Answer' }],
      plugins: [{ id: 'memory', kind: 'memory', title: 'Memory', version: '1.0.0' }],
      events: { emits: ['run.started'], consumes: ['input.requested'] },
      graph: { entryNodeIds: ['prompt'], outputNodeIds: ['answer'] }
    })
  })

  it('validates AgentSpec and reports nested contract errors', () => {
    expect(validateMagicAgentSpec(minimalAgent).ok).toBe(true)

    const invalid = validateMagicAgentSpec({
      id: '',
      title: '',
      tools: [{ id: '', name: '', title: '', scope: 'bad-scope' }],
      inputs: [{ id: 'prompt', title: 'Prompt', type: 'not-real' }],
      graph: {
        nodes: [{ id: '', title: '', type: 'unknown' }],
        edges: [{ from: '', to: '' }]
      }
    })

    expect(invalid.ok).toBe(false)
    expect(invalid.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'agent.id',
        'agent.title',
        'agent.tools.0.tool.id',
        'agent.tools.0.tool.scope',
        'agent.inputs.0.input.type',
        'agent.graph.nodes.0.id',
        'agent.graph.nodes.0.type',
        'agent.graph.edges.0.from'
      ])
    )
  })

  it('validates standalone tools, inputs, and graph contracts', () => {
    expect(
      validateMagicAgentToolSpec({
        id: 'tool.search',
        name: 'search',
        title: 'Search',
        scope: 'workspace',
        transport: 'http',
        inputSchema: { type: 'object' }
      })
    ).toMatchObject({ ok: true })

    const inputResult = validateMagicAgentInputSpec({
      id: 'choice',
      type: 'select',
      title: 'Choice',
      choices: [{ value: 'a', label: 'A' }]
    })
    expect(inputResult).toMatchObject({
      ok: true,
      value: { id: 'choice', type: 'select', choices: [{ value: 'a', label: 'A' }] }
    })

    expect(
      validateMagicAgentGraphSpec({
        nodes: [{ id: 'start', type: 'input', title: 'Start' }],
        edges: [],
        entryNodeIds: ['start'],
        outputNodeIds: []
      })
    ).toMatchObject({ ok: true })
  })

  it('creates and validates MagicAgent packages', () => {
    const pkg = createMagicAgentPackage({
      agent: minimalAgent,
      manifest: {
        author: 'MagicPot',
        keywords: ['demo', 'demo', 'agent']
      },
      createdAt: '2025-01-01T00:00:00.000Z'
    })

    expect(pkg).toMatchObject({
      magic: MAGIC_AGENT_PACKAGE_MAGIC,
      packageVersion: 1,
      contractVersion: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      manifest: {
        id: 'demo.agent',
        name: 'Demo Agent',
        version: '1.2.3',
        author: 'MagicPot',
        keywords: ['demo', 'agent']
      }
    })
    expect(validateMagicAgentPackage(pkg).ok).toBe(true)

    const invalid = validateMagicAgentPackage({
      magic: 'WRONG',
      manifest: { id: '', name: '' },
      agent: { id: '', title: '' },
      assets: []
    })
    expect(invalid.ok).toBe(false)
    expect(invalid.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'package.magic',
        'package.manifest.id',
        'package.agent.id',
        'package.assets'
      ])
    )
  })
})
