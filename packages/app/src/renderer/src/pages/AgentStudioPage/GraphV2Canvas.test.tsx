import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  GRAPH_V2_FIRST_PARTY_NODE_REGISTRY,
  getGraphV2NodeDescriptor,
  type GraphDefinitionV2Draft
} from '@shared/magicAgentPlatform2'
import { GraphV2Canvas } from './GraphV2Canvas'

const definition: GraphDefinitionV2Draft = {
  kind: 'magic-agent.graph-definition.v2-draft',
  graphMode: 'design',
  schemaVersion: '2.0.0',
  graphId: 'canvas-test',
  name: 'Canvas test',
  description: 'Canvas test',
  version: '1.0.0',
  tags: [],
  nodes: [
    {
      nodeId: 'input',
      kind: 'input',
      name: 'Input',
      description: 'Input node',
      position: { x: 40, y: 50 },
      inputs: [],
      outputs: [
        {
          portId: 'out',
          name: 'Output',
          direction: 'output',
          role: 'data',
          valueType: { kind: 'string' },
          required: true,
          multiple: false
        }
      ],
      config: {}
    },
    {
      nodeId: 'subgraph',
      kind: 'subgraph',
      name: 'Subgraph',
      description: 'Nested graph',
      position: { x: 650, y: 80 },
      inputs: [],
      outputs: [],
      config: {},
      subgraphRef: {
        graphId: 'nested-graph',
        version: '1.0.0',
        inputMappings: {},
        outputMappings: {}
      }
    },
    {
      nodeId: 'output',
      kind: 'output',
      name: 'Output',
      description: 'Output node',
      position: { x: 360, y: 180 },
      inputs: [
        {
          portId: 'in',
          name: 'Input',
          direction: 'input',
          role: 'data',
          valueType: { kind: 'string' },
          required: true,
          multiple: false
        }
      ],
      outputs: [],
      config: {}
    }
  ],
  edges: [
    {
      edgeId: 'input-output',
      kind: 'data',
      source: { nodeId: 'input', portId: 'out' },
      target: { nodeId: 'output', portId: 'in' }
    },
    {
      edgeId: 'input-error',
      kind: 'error',
      source: { nodeId: 'input', portId: 'out' },
      target: { nodeId: 'output', portId: 'in' },
      label: 'Fallback'
    }
  ],
  variables: [
    {
      variableId: 'prompt',
      name: 'Prompt',
      scope: 'run',
      valueType: { kind: 'string' },
      required: true,
      description: 'Prompt variable'
    },
    {
      variableId: 'api-key',
      name: 'API key',
      scope: 'workspace',
      valueType: { kind: 'string' },
      sensitive: true,
      description: 'Secret variable'
    }
  ],
  outputs: [
    {
      outputId: 'result',
      name: 'Result',
      description: 'Result output',
      source: { nodeId: 'output', portId: 'in' }
    }
  ],
  entryNodeIds: ['input'],
  metadata: {},
  legacySnapshot: {
    graphId: 'canvas-test',
    name: 'Canvas test',
    description: 'Canvas test',
    version: '1.0.0',
    tags: [],
    entryNodeIds: ['input'],
    nodes: [],
    channels: [],
    outputs: []
  }
}

describe('GraphV2Canvas', () => {
  it('invokes node execution callbacks and renders supplied durable previews', () => {
    const onTestNode = vi.fn()
    const onRunFromNode = vi.fn()
    render(
      <GraphV2Canvas
        definition={definition}
        selectedNodeId="output"
        onSelectNode={vi.fn()}
        onChange={vi.fn()}
        onTestNode={onTestNode}
        onRunFromNode={onRunFromNode}
        nodePreviews={{ output: { input: 'bounded input', output: 'bounded output' } }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Test node' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run from node' }))

    expect(onTestNode).toHaveBeenCalledWith('output')
    expect(onRunFromNode).toHaveBeenCalledWith('output')
    expect(screen.getByText(/Input preview: "bounded input"/)).toBeInTheDocument()
    expect(screen.getByText(/Output preview: "bounded output"/)).toBeInTheDocument()
  })

  it('renders the required 300-node/600-edge performance scenario without losing graph data', () => {
    const nodes = Array.from({ length: 300 }, (_, index) => ({
      nodeId: `node-${index}`,
      kind:
        index === 0 ? ('input' as const) : index === 299 ? ('output' as const) : ('tool' as const),
      name: `Node ${index}`,
      description: `Performance node ${index}`,
      position: { x: (index % 20) * 280, y: Math.floor(index / 20) * 200 },
      inputs: [
        {
          portId: 'in',
          name: 'Input',
          direction: 'input' as const,
          role: 'data' as const,
          valueType: { kind: 'string' as const },
          required: false,
          multiple: true
        }
      ],
      outputs: [
        {
          portId: 'out',
          name: 'Output',
          direction: 'output' as const,
          role: 'data' as const,
          valueType: { kind: 'string' as const },
          required: false,
          multiple: true
        }
      ],
      config: {}
    }))
    const edges = Array.from({ length: 600 }, (_, index) => ({
      edgeId: `edge-${index}`,
      kind: 'data' as const,
      source: { nodeId: `node-${index % 300}`, portId: 'out' },
      target: { nodeId: `node-${(index + 1) % 300}`, portId: 'in' }
    }))
    const largeDefinition: GraphDefinitionV2Draft = {
      ...definition,
      graphId: 'performance-300-600',
      nodes,
      edges,
      entryNodeIds: ['node-0']
    }
    const started = performance.now()
    const { container } = render(<GraphV2Canvas definition={largeDefinition} />)
    const elapsedMs = performance.now() - started

    expect(screen.getAllByTestId('graph-v2-node')).toHaveLength(300)
    expect(container.querySelectorAll('[data-testid="graph-v2-edge"]')).toHaveLength(600)
    expect(screen.getAllByTitle(/^Node \d+$/)).toHaveLength(300)
    expect(elapsedMs).toBeLessThan(10_000)
  })
  it('filters the honest executable registry and adds descriptor defaults', () => {
    const change = vi.fn()
    render(
      <GraphV2Canvas
        definition={definition}
        onChange={change}
        nodeDescriptors={GRAPH_V2_FIRST_PARTY_NODE_REGISTRY}
      />
    )
    fireEvent.change(screen.getByLabelText('Search node palette'), { target: { value: 'cond' } })
    expect(screen.getByRole('button', { name: /condition/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /subgraph/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /condition/i }))
    const descriptor = getGraphV2NodeDescriptor('condition')!
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            kind: 'condition',
            inputs: descriptor.defaultInputs,
            outputs: descriptor.defaultOutputs,
            config: descriptor.defaultConfig
          })
        ])
      })
    )
    expect(GRAPH_V2_FIRST_PARTY_NODE_REGISTRY.map(({ kind }) => kind)).toEqual([
      'input',
      'condition',
      'merge',
      'output',
      'agent',
      'channel-message',
      'automation-trigger',
      'llm',
      'tool',
      'mcp-tool',
      'memory-search',
      'coding-task',
      'comfyui-workflow',
      'subgraph'
    ])
  })

  it('uses only production-loaded descriptors to drive the palette', () => {
    const change = vi.fn()
    const descriptor = {
      ...getGraphV2NodeDescriptor('condition')!,
      kind: 'production-condition',
      title: 'Production condition'
    }
    render(
      <GraphV2Canvas definition={definition} onChange={change} nodeDescriptors={[descriptor]} />
    )

    expect(screen.getByRole('button', { name: 'Production condition' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Agent$/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Production condition' }))
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            kind: 'production-condition',
            config: descriptor.defaultConfig
          })
        ])
      })
    )
  })

  it('keeps an empty loaded registry empty and reports the offline state', () => {
    render(<GraphV2Canvas definition={definition} onChange={vi.fn()} nodeDescriptors={[]} />)

    expect(
      screen.getByText('Node registry is offline or empty. No palette nodes are available.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Input$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Agent$/ })).not.toBeInTheDocument()
  })

  it('keeps configurable loaded descriptors addable and exposes their configuration hint', () => {
    const change = vi.fn()
    const descriptor = {
      ...getGraphV2NodeDescriptor('tool')!,
      configurationNeeded: 'Configure required fields after adding: toolName.'
    }
    render(
      <GraphV2Canvas definition={definition} onChange={change} nodeDescriptors={[descriptor]} />
    )

    const button = screen.getByRole('button', { name: 'Tool' })
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('title', descriptor.configurationNeeded)
    fireEvent.click(button)
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ kind: 'tool', config: descriptor.defaultConfig })
        ])
      })
    )
  })

  it('disables unsupported loaded descriptors and exposes their reason', () => {
    const reason = 'Production runtime does not support this node.'
    const descriptor = {
      ...getGraphV2NodeDescriptor('condition')!,
      kind: 'future-node',
      title: 'Future node',
      executable: false,
      execution: { mode: 'unsupported' as const, reason }
    }
    render(
      <GraphV2Canvas definition={definition} onChange={vi.fn()} nodeDescriptors={[descriptor]} />
    )

    expect(screen.getByRole('button', { name: 'Future node' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Future node' })).toHaveAttribute('title', reason)
  })

  it('adds standard visual nodes through immutable V2 updates', () => {
    const change = vi.fn()
    const select = vi.fn()
    render(
      <GraphV2Canvas
        definition={definition}
        onChange={change}
        onSelectNode={select}
        nodeDescriptors={GRAPH_V2_FIRST_PARTY_NODE_REGISTRY}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /agent/i }))
    const descriptor = getGraphV2NodeDescriptor('agent')!
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            kind: 'agent',
            name: expect.stringContaining('Agent'),
            inputs: descriptor.defaultInputs,
            outputs: descriptor.defaultOutputs,
            config: descriptor.defaultConfig
          })
        ])
      })
    )
    expect(select).toHaveBeenCalled()
    expect(definition.nodes).toHaveLength(3)
  })

  it('renders a minimap and pans the viewport without changing graph coordinates', () => {
    render(<GraphV2Canvas definition={definition} />)
    expect(screen.getByLabelText('Graph minimap')).toBeInTheDocument()
    const canvas = screen.getByLabelText('Graph V2 canvas')
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 40, clientY: 35 })
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 40, clientY: 35 })
    expect(screen.getByLabelText('Graph node Input').parentElement).toHaveStyle({
      transform: 'translate(30px, 25px) scale(1)'
    })
    expect(definition.nodes[0].position).toEqual({ x: 40, y: 50 })
  })

  it('provides bounded viewport zoom controls and stable calculated fit', () => {
    render(<GraphV2Canvas definition={definition} />)
    expect(screen.getByText('Viewport 100%')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(screen.getByText('Viewport 110%')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Zoom out'))
    expect(screen.getByText('Viewport 100%')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Fit graph'))
    const fittedViewport = screen.getByText(/^Viewport \d+%$/).textContent
    expect(fittedViewport).toBe('Viewport 58%')
    fireEvent.click(screen.getByLabelText('Fit graph'))
    expect(screen.getByText(fittedViewport!)).toBeInTheDocument()
  })

  it('pans left and up and fits negative graph coordinates into the viewport and minimap', () => {
    const negativeDefinition: GraphDefinitionV2Draft = {
      ...definition,
      nodes: definition.nodes.map((node, index) => ({
        ...node,
        position: { x: -600 + index * 260, y: -400 + index * 120 }
      }))
    }
    render(<GraphV2Canvas definition={negativeDefinition} />)
    const canvas = screen.getByLabelText('Graph V2 canvas')
    fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 35, clientY: 20 })
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 35, clientY: 20 })
    expect(screen.getByLabelText('Graph node Input').parentElement).toHaveStyle({
      transform: 'translate(-65px, -80px) scale(1)'
    })

    fireEvent.click(screen.getByLabelText('Fit graph'))
    expect(screen.getByText('Viewport 37%')).toBeInTheDocument()
    expect(screen.getByLabelText('Graph node Input').parentElement).toHaveStyle({
      transform: 'translate(269.795918367347px, 196.3265306122449px) scale(0.3673469387755102)'
    })
    const minimap = screen.getByLabelText('Graph minimap')
    expect(minimap.querySelector('[title="Input"]')).toHaveStyle({ left: '5.405405405405405%' })
    expect(negativeDefinition.nodes[0].position).toEqual({ x: -600, y: -400 })
  })
  it('renders positioned nodes, typed ports and edges without losing the definition', () => {
    const select = vi.fn()
    render(<GraphV2Canvas definition={definition} onSelectNode={select} />)
    expect(screen.getByLabelText('Graph V2 canvas')).toBeInTheDocument()
    expect(screen.getByLabelText('Graph node Input')).toHaveStyle({ left: '40px', top: '50px' })
    expect(screen.getByLabelText('Graph node Output')).toHaveStyle({ left: '360px', top: '180px' })
    expect(screen.getByLabelText('Graph edge input-output')).toHaveAttribute('stroke', '#0ea5e9')
    fireEvent.click(screen.getByLabelText('Graph node Output'))
    expect(select).toHaveBeenCalledWith('output')
    expect(definition.edges[0].source).toEqual({ nodeId: 'input', portId: 'out' })
  })

  it('edits subgraph references through the selected-node inspector', () => {
    const change = vi.fn()
    render(<GraphV2Canvas definition={definition} selectedNodeId="subgraph" onChange={change} />)
    fireEvent.change(screen.getByLabelText('Subgraph version'), { target: { value: '2.0.0' } })
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            nodeId: 'subgraph',
            subgraphRef: expect.objectContaining({ graphId: 'nested-graph', version: '2.0.0' })
          })
        ])
      })
    )
  })

  it('edits selected error-route metadata while preserving endpoints', () => {
    const change = vi.fn()
    render(<GraphV2Canvas definition={definition} onChange={change} />)
    fireEvent.click(screen.getByLabelText('Graph edge input-error'))
    fireEvent.change(screen.getByLabelText('Error route label'), {
      target: { value: 'Retry fallback' }
    })
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        edges: expect.arrayContaining([
          expect.objectContaining({
            edgeId: 'input-error',
            kind: 'error',
            label: 'Retry fallback',
            source: { nodeId: 'input', portId: 'out' },
            target: { nodeId: 'output', portId: 'in' }
          })
        ])
      })
    )
  })

  it('edits graph output metadata while preserving its typed source endpoint', () => {
    const change = vi.fn()
    render(<GraphV2Canvas definition={definition} onChange={change} />)
    fireEvent.change(screen.getByLabelText('Output name'), { target: { value: 'Final result' } })
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            outputId: 'result',
            name: 'Final result',
            source: { nodeId: 'output', portId: 'in' }
          })
        ]
      })
    )
    expect(definition.outputs[0].name).toBe('Result')
  })

  it('edits variable metadata and identifies sensitive variables without exposing values', () => {
    const change = vi.fn()
    render(<GraphV2Canvas definition={definition} onChange={change} />)
    expect(screen.getByText('secret')).toBeInTheDocument()
    expect(screen.queryByDisplayValue(/secret variable/i)).not.toBeInTheDocument()
    const fields = screen.getAllByLabelText('Variable name')
    fireEvent.change(fields[0], { target: { value: 'User prompt' } })
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: expect.arrayContaining([
          expect.objectContaining({ variableId: 'prompt', name: 'User prompt' })
        ])
      })
    )
    expect(definition.variables[0].name).toBe('Prompt')
  })

  it('edits selected node metadata through the visual inspector without mutating source', () => {
    const change = vi.fn()
    render(<GraphV2Canvas definition={definition} selectedNodeId="input" onChange={change} />)
    fireEvent.change(screen.getByLabelText('Node name'), { target: { value: 'Prompt input' } })
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: 'input', name: 'Prompt input' })
        ])
      })
    )
    expect(definition.nodes[0].name).toBe('Input')
  })
  it('selects and deletes an edge through an immutable V2 update', () => {
    const change = vi.fn()
    render(<GraphV2Canvas definition={definition} onChange={change} />)
    fireEvent.click(screen.getByLabelText('Graph edge input-output'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected edge' }))
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        edges: [expect.objectContaining({ edgeId: 'input-error' })]
      })
    )
    expect(definition.edges).toHaveLength(2)
  })
  it('reports incompatible and duplicate visual connections without mutating the graph', () => {
    const change = vi.fn()
    render(<GraphV2Canvas definition={definition} onChange={change} />)
    fireEvent.click(screen.getByLabelText('Port input out'))
    fireEvent.click(screen.getByLabelText('Port output in'))
    expect(screen.getByRole('status')).toHaveTextContent('That connection already exists.')
    expect(change).not.toHaveBeenCalled()
  })

  it('connects compatible output and input ports through an immutable edge update', () => {
    const change = vi.fn()
    const disconnected = { ...definition, edges: [] }
    render(<GraphV2Canvas definition={disconnected} onChange={change} />)
    fireEvent.click(screen.getByLabelText('Port input out'))
    fireEvent.click(screen.getByLabelText('Port output in'))
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        edges: [
          expect.objectContaining({
            edgeId: 'input.out-output.in',
            kind: 'data',
            source: { nodeId: 'input', portId: 'out' },
            target: { nodeId: 'output', portId: 'in' }
          })
        ]
      })
    )
    expect(disconnected.edges).toEqual([])
  })

  it('supports multi-select grouping, copy/paste, undo/redo, and auto-layout', () => {
    const changes: GraphDefinitionV2Draft[] = []
    const Harness = () => {
      const [value, setValue] = useState(definition)
      return (
        <GraphV2Canvas
          definition={value}
          onChange={(next) => {
            changes.push(next)
            setValue(next)
          }}
        />
      )
    }
    render(<Harness />)

    fireEvent.click(screen.getByLabelText('Graph node Input'))
    fireEvent.click(screen.getByLabelText('Graph node Output'), { ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Group' }))
    const grouped = changes.at(-1)!
    expect(grouped.visualAnnotations?.groups).toEqual([
      expect.objectContaining({
        groupId: expect.stringMatching(/^group-/),
        title: expect.stringMatching(/^group-/),
        nodeIds: ['input', 'output']
      })
    ])
    expect(grouped.nodes.every((node) => node.metadata?.studioGroupId === undefined)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(changes.at(-1)!.nodes).toHaveLength(5)
    expect(changes.at(-1)!.edges).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(changes.at(-1)!.nodes).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(changes.at(-1)!.nodes).toHaveLength(5)

    fireEvent.click(screen.getByRole('button', { name: 'Auto-layout' }))
    expect(changes.at(-1)!.nodes.some((node) => node.position.x === 60)).toBe(true)
  })

  it('supports full canonical note CRUD without mutating its source definition', () => {
    const source: GraphDefinitionV2Draft = {
      ...definition,
      visualAnnotations: { groups: [], notes: [], reroutes: [] }
    }
    const changes: GraphDefinitionV2Draft[] = []
    const Harness = () => {
      const [value, setValue] = useState(source)
      return (
        <GraphV2Canvas
          definition={value}
          onChange={(next) => {
            changes.push(next)
            setValue(next)
          }}
        />
      )
    }
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    const note = screen.getByTestId('graph-v2-note')
    fireEvent.change(screen.getByLabelText('Note title'), { target: { value: 'Risks' } })
    fireEvent.change(screen.getByLabelText('Note body'), { target: { value: 'Check fallback' } })
    fireEvent.change(screen.getByLabelText('Note color'), { target: { value: '#abcdef' } })
    fireEvent.change(screen.getByLabelText('Note width'), { target: { value: '320' } })
    fireEvent.change(screen.getByLabelText('Note height'), { target: { value: '180' } })
    fireEvent.pointerDown(note, { pointerId: 3, clientX: 120, clientY: 120 })
    fireEvent.pointerMove(note, { pointerId: 3, clientX: -180, clientY: -220 })
    fireEvent.pointerUp(note, { pointerId: 3, clientX: -180, clientY: -220 })

    expect(changes.at(-1)!.visualAnnotations?.notes).toEqual([
      expect.objectContaining({
        title: 'Risks',
        text: 'Check fallback',
        color: '#abcdef',
        width: 320,
        height: 180,
        position: { x: -180, y: -220 }
      })
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected note' }))
    expect(changes.at(-1)!.visualAnnotations?.notes).toEqual([])
    expect(source.visualAnnotations?.notes).toEqual([])
  })

  it('selects, repositions, and deletes canonical reroutes immutably', () => {
    const source: GraphDefinitionV2Draft = {
      ...definition,
      visualAnnotations: {
        groups: [],
        notes: [],
        reroutes: [{ edgeId: 'input-output', points: [{ x: 160, y: 120 }] }]
      }
    }
    const changes: GraphDefinitionV2Draft[] = []
    const Harness = () => {
      const [value, setValue] = useState(source)
      return (
        <GraphV2Canvas
          definition={value}
          onChange={(next) => {
            changes.push(next)
            setValue(next)
          }}
        />
      )
    }
    render(<Harness />)
    const reroute = screen.getByLabelText('Reroute point input-output 0')
    fireEvent.click(reroute)
    expect(
      screen.getByRole('button', { name: 'Delete selected reroute point' })
    ).toBeInTheDocument()
    fireEvent.pointerDown(reroute, { pointerId: 4, clientX: 160, clientY: 120 })
    fireEvent.pointerMove(reroute, { pointerId: 4, clientX: -40, clientY: -80 })
    fireEvent.pointerUp(reroute, { pointerId: 4, clientX: -40, clientY: -80 })
    expect(changes.at(-1)!.visualAnnotations?.reroutes).toEqual([
      { edgeId: 'input-output', points: [{ x: -40, y: -80 }] }
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected reroute point' }))
    expect(changes.at(-1)!.visualAnnotations?.reroutes).toEqual([])
    expect(source.visualAnnotations?.reroutes).toEqual([
      { edgeId: 'input-output', points: [{ x: 160, y: 120 }] }
    ])
  })

  it('drives string, number, boolean, enum, defaults, descriptions, and validation from loaded schema', () => {
    const descriptor = {
      ...getGraphV2NodeDescriptor('input')!,
      kind: 'loaded-config',
      title: 'Loaded config',
      configSchema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          prompt: {
            type: 'string' as const,
            title: 'Prompt',
            description: 'Prompt description',
            required: true
          },
          retries: {
            type: 'number' as const,
            title: 'Retries',
            description: 'Retry count',
            default: 3
          },
          enabled: { type: 'boolean' as const, title: 'Enabled', default: true },
          mode: {
            type: 'string' as const,
            title: 'Mode',
            enum: ['fast', 'safe'],
            default: 'safe'
          }
        }
      },
      defaultConfig: {}
    }
    const source: GraphDefinitionV2Draft = {
      ...definition,
      nodes: [
        {
          ...definition.nodes[0],
          kind: descriptor.kind,
          config: { prompt: 42 }
        }
      ],
      edges: [],
      entryNodeIds: ['input']
    }
    const changes: GraphDefinitionV2Draft[] = []
    const Harness = () => {
      const [value, setValue] = useState(source)
      return (
        <GraphV2Canvas
          definition={value}
          selectedNodeId="input"
          nodeDescriptors={[descriptor]}
          onChange={(next) => {
            changes.push(next)
            setValue(next)
          }}
        />
      )
    }
    render(<Harness />)
    expect(screen.getByText('Expected string.')).toBeInTheDocument()
    expect(screen.getByLabelText('Retries')).toHaveValue(3)
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeChecked()
    expect(screen.getByLabelText('Mode')).toHaveTextContent('safe')
    fireEvent.change(screen.getByLabelText('Prompt *'), { target: { value: '' } })
    expect(screen.getByText('This field is required.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Prompt *'), { target: { value: 'Ship it' } })
    expect(screen.getByText('Prompt description')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Retries'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }))
    fireEvent.mouseDown(screen.getByLabelText('Mode'))
    fireEvent.click(screen.getByRole('option', { name: 'fast' }))
    expect(changes.at(-1)!.nodes[0].config).toEqual({
      prompt: 'Ship it',
      retries: 5,
      enabled: false,
      mode: 'fast'
    })
    expect(source.nodes[0].config).toEqual({ prompt: 42 })
  })

  it('renders canonical notes, inserts references, and adds canonical reroute points', () => {
    const noteDefinition: GraphDefinitionV2Draft = {
      ...definition,
      visualAnnotations: {
        groups: [],
        notes: [
          {
            noteId: 'note',
            text: 'Initial',
            position: { x: 80, y: 300 },
            color: '#fff7ae'
          }
        ],
        reroutes: []
      }
    }
    const change = vi.fn()
    const { rerender } = render(<GraphV2Canvas definition={noteDefinition} onChange={change} />)
    expect(screen.getByLabelText('Graph note note')).toHaveTextContent('Initial')

    const configured = {
      ...noteDefinition,
      nodes: noteDefinition.nodes.map((node) =>
        node.nodeId === 'output' ? { ...node, config: { prompt: 'Prefix ' } } : node
      )
    }
    rerender(<GraphV2Canvas definition={configured} selectedNodeId="output" onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: 'Insert Prompt' }))
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            nodeId: 'output',
            config: expect.objectContaining({ prompt: 'Prefix {{variables.prompt}}' })
          })
        ])
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Insert Input.Output' }))
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            nodeId: 'output',
            config: expect.objectContaining({ prompt: 'Prefix {{nodes.input.out}}' })
          })
        ])
      })
    )

    fireEvent.click(screen.getByLabelText('Graph edge input-output'))
    fireEvent.click(screen.getByRole('button', { name: 'Add reroute point' }))
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        visualAnnotations: expect.objectContaining({
          notes: noteDefinition.visualAnnotations?.notes,
          reroutes: [{ edgeId: 'input-output', points: [{ x: 160, y: 120 }] }]
        }),
        edges: expect.arrayContaining([expect.objectContaining({ edgeId: 'input-output' })])
      })
    )
  })

  it('enforces value-type and role compatibility and renders runtime topology/localized errors', () => {
    const incompatible: GraphDefinitionV2Draft = {
      ...definition,
      edges: [],
      nodes: definition.nodes.map((node) =>
        node.nodeId === 'output'
          ? {
              ...node,
              inputs: node.inputs.map((port) => ({
                ...port,
                valueType: { kind: 'number' as const }
              }))
            }
          : node
      )
    }
    const change = vi.fn()
    render(
      <GraphV2Canvas
        definition={incompatible}
        selectedNodeId="output"
        onChange={change}
        localizedErrors={{ output: ['Output input is invalid'] }}
        runtimeTopology={{
          kind: 'magic-agent.graph-runtime-topology-snapshot.v2',
          graphMode: 'runtime',
          definitionGraphId: definition.graphId,
          definitionVersion: definition.version,
          runId: 'run-1',
          revision: 7,
          nodes: [{ nodeId: 'input', metadata: { status: 'completed' } }],
          edges: [
            {
              edgeId: 'runtime-edge',
              sourceNodeId: 'input',
              targetNodeId: 'output',
              metadata: { kind: 'data' }
            }
          ]
        }}
      />
    )
    fireEvent.click(screen.getByLabelText('Port input out'))
    fireEvent.click(screen.getByLabelText('Port output in'))
    expect(screen.getByRole('status')).toHaveTextContent(/type/i)
    expect(change).not.toHaveBeenCalled()
    expect(screen.getByText('Output input is invalid')).toBeInTheDocument()
    expect(screen.getByText(/Runtime topology · run run-1 · revision 7/)).toBeInTheDocument()
    expect(screen.getByText(/runtime-edge/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Test node' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run from node' })).toBeDisabled()
  })

  it('deletes a selected node and its connected edges through immutable V2 updates', () => {
    const change = vi.fn()
    render(<GraphV2Canvas definition={definition} selectedNodeId="output" onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected node' }))
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: 'input' }),
          expect.objectContaining({ nodeId: 'subgraph' })
        ]),
        edges: []
      })
    )
    expect(definition.nodes).toHaveLength(3)
  })
})
