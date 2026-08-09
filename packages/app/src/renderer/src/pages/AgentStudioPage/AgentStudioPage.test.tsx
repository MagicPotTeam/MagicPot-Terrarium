import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { theme } from '@renderer/theme'
import type { AgentRouteLike } from '@shared/agent'
import type { MagicAgentGraphDefinition, MagicAgentGraphRunRecord } from '@shared/magicAgent'
import AgentStudioPage from './AgentStudioPage'

const platformApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listAgents: vi.fn(),
  listTools: vi.fn(),
  listGraphs: vi.fn(),
  listPackages: vi.fn(),
  listGraphRuns: vi.fn(),
  inspectGraph: vi.fn(),
  getGraphV2: vi.fn(),
  listPublishedGraphsV2: vi.fn(),
  listGraphV2NodeRegistry: vi.fn(),
  saveGraphV2: vi.fn(),
  runGraph: vi.fn(),
  attachGraphRun: vi.fn(),
  watchGraphRun: vi.fn(),
  getGraphRun: vi.fn(),
  getRuntimeGraphTopology: vi.fn(),
  cancelGraphRun: vi.fn(),
  listTriggers: vi.fn(),
  listDrives: vi.fn(),
  listAgentInstances: vi.fn(),
  listTeams: vi.fn(),
  listRuntimeChannels: vi.fn(),
  listRuntimeChannelWires: vi.fn(),
  enableTrigger: vi.fn(),
  disableTrigger: vi.fn(),
  pauseTrigger: vi.fn(),
  resumeTrigger: vi.fn(),
  retryTrigger: vi.fn(),
  manualFireTrigger: vi.fn()
}))

vi.mock('./M6TopologyPanel', () => ({ M6TopologyPanel: () => null }))
vi.mock('./M6RendererManagementPanel', () => ({ M6RendererManagementPanel: () => null }))
vi.mock('./SessionExportComparePanel', () => ({ SessionExportComparePanel: () => null }))
vi.mock('./SemanticMemoryPanel', () => ({
  SemanticMemoryPanel: () => <div data-testid="semantic-memory-panel" />
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcMagicAgentPlatform: platformApi })
}))

const FLAG_HELP = 'Set MAGICPOT_MAGICAGENT_PLATFORM=1 to enable Agent Studio actions.'
const GRAPH_RUN_HISTORY_LIMIT = 50
const ROUTE: AgentRouteLike = { channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' }
const graphs = [
  {
    graphId: 'graph-alpha',
    name: 'Cozy Graph',
    description: 'Designs cozy product pitches',
    version: '1.0.0',
    tags: ['demo'],
    nodeCount: 2,
    channelCount: 1,
    outputCount: 1,
    builtIn: true
  },
  {
    graphId: 'graph-beta',
    name: 'Storyboard Graph',
    description: 'Builds storyboard beats',
    version: '1.0.0',
    tags: ['demo'],
    nodeCount: 3,
    channelCount: 2,
    outputCount: 1,
    builtIn: true
  }
]

const makeGraphDetail = (
  patch: Partial<MagicAgentGraphDefinition> = {}
): MagicAgentGraphDefinition => ({
  graphId: 'graph-alpha',
  name: 'Cozy Graph',
  description: 'Designs cozy product pitches',
  version: '1.0.0',
  tags: ['demo'],
  nodes: [
    {
      nodeId: 'writer',
      kind: 'agent',
      name: 'Writer',
      description: 'Writes the final response'
    }
  ],
  channels: [],
  outputs: [],
  entryNodeIds: ['writer'],
  ...patch
})

const makeRun = (patch: Partial<MagicAgentGraphRunRecord> = {}): MagicAgentGraphRunRecord => ({
  runId: 'run-alpha',
  graphId: 'graph-alpha',
  status: 'completed',
  input: 'Create a cozy pitch',
  route: ROUTE,
  sessionKey: 'generic:dm:agent-studio',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_005_000,
  channels: [
    {
      channelId: 'channel-alpha',
      from: 'planner',
      to: 'writer',
      kind: 'message',
      content: 'Draft a concise pitch.',
      createdAt: 1_700_000_002_000
    }
  ],
  outputs: [
    {
      outputId: 'output-alpha',
      name: 'Pitch',
      content: 'Cozy puzzle pitch',
      sourceNodeId: 'writer',
      channelId: 'channel-alpha',
      mimeType: 'text/markdown'
    }
  ],
  ...patch
})

const renderPage = () =>
  render(
    <ThemeProvider theme={theme}>
      <AgentStudioPage />
    </ThemeProvider>
  )

const seedEnabled = () => {
  platformApi.getStatus.mockResolvedValue({
    enabled: true,
    featureFlag: 'MAGICPOT_MAGICAGENT_PLATFORM',
    platformVersion: 1,
    assistantRuntimeCompatible: true,
    agentCount: 1,
    toolCount: 2,
    assistantToolCount: 1,
    creativeToolCount: 1,
    graphCount: graphs.length,
    packageCount: 1
  })
  platformApi.listAgents.mockResolvedValue({
    agents: [{ id: 'agent-designer', name: 'Designer Agent' }]
  })
  platformApi.listTools.mockResolvedValue({
    tools: [
      {
        name: 'pitch.create',
        description: 'Create a pitch',
        inputSchema: {},
        source: 'magicAgentRuntime',
        status: 'available'
      }
    ]
  })
  platformApi.listGraphs.mockResolvedValue({ graphs })
  platformApi.listPackages.mockResolvedValue({
    packages: [{ id: 'pkg-demo', name: 'Demo Package', version: '0.1.0' }]
  })
  platformApi.listGraphRuns.mockResolvedValue({ runs: [makeRun()] })
  platformApi.inspectGraph.mockResolvedValue({ graph: makeGraphDetail() })
  platformApi.getGraphV2.mockResolvedValue({})
  platformApi.listPublishedGraphsV2.mockResolvedValue({ definitionsV2: [] })
  platformApi.listGraphV2NodeRegistry.mockResolvedValue({ descriptors: [] })
  platformApi.runGraph.mockResolvedValue(makeRun())
  platformApi.attachGraphRun.mockResolvedValue(undefined)
  platformApi.watchGraphRun.mockResolvedValue(undefined)
  platformApi.getGraphRun.mockResolvedValue({ run: makeRun() })
  platformApi.getRuntimeGraphTopology.mockResolvedValue({
    runId: 'run-alpha',
    graphId: 'graph-alpha',
    status: 'completed',
    revision: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
    resources: []
  })
  platformApi.cancelGraphRun.mockResolvedValue({
    runId: 'run-alpha',
    cancelled: true,
    status: 'cancelled'
  })
}

describe('AgentStudioPage Graph Run Center', () => {
  beforeEach(() => {
    Object.values(platformApi).forEach((mock) => mock.mockReset())
    platformApi.listTriggers.mockResolvedValue({ triggers: [] })
    platformApi.listDrives.mockResolvedValue({ drives: [] })
    platformApi.listAgentInstances.mockResolvedValue({ instances: [] })
    platformApi.listTeams.mockResolvedValue([])
    platformApi.listRuntimeChannels.mockResolvedValue({ channels: [] })
    platformApi.listRuntimeChannelWires.mockResolvedValue({ wires: [] })
    seedEnabled()
  })

  it('renders the semantic memory child through an isolated mock', async () => {
    renderPage()
    expect(await screen.findByTestId('semantic-memory-panel')).toBeInTheDocument()
  })

  it('attaches selected runs, orders and dedupes events, resumes by cursor, and aborts cleanup', async () => {
    const attachments: Array<{
      request: { runId: string; afterEventId?: string }
      stream: {
        abortReceiver: { isAborted: () => boolean; onAbort: (handler: () => void) => void }
        onData: (event: {
          eventId: string
          runId: string
          sequence: number
          kind: 'node.started' | 'node.completed'
          timestamp: number
          payload: Record<string, unknown>
        }) => void
      }
    }> = []
    platformApi.attachGraphRun.mockImplementation(async (request, stream) => {
      attachments.push({ request, stream })
      await new Promise<void>((resolve) => stream.abortReceiver.onAbort(resolve))
    })
    platformApi.listGraphRuns.mockResolvedValueOnce({
      runs: [
        makeRun({ runId: 'run-newest', updatedAt: 3 }),
        makeRun({ runId: 'run-older', updatedAt: 2 })
      ]
    })
    platformApi.getGraphRun.mockImplementation(async ({ runId }) => ({
      run: makeRun({ runId, updatedAt: runId === 'run-newest' ? 3 : 2 })
    }))

    const view = renderPage()
    await waitFor(() => expect(attachments).toHaveLength(1))
    expect(attachments[0].request).toEqual({ runId: 'run-newest', route: ROUTE })

    attachments[0].stream.onData({
      eventId: 'event-2',
      runId: 'run-newest',
      sequence: 2,
      kind: 'node.completed',
      timestamp: 2,
      payload: { message: 'done', secretToken: 'hidden' }
    })
    attachments[0].stream.onData({
      eventId: 'event-1',
      runId: 'run-newest',
      sequence: 1,
      kind: 'node.started',
      timestamp: 1,
      payload: { nodeId: 'writer' }
    })
    attachments[0].stream.onData({
      eventId: 'event-2',
      runId: 'run-newest',
      sequence: 2,
      kind: 'node.completed',
      timestamp: 2,
      payload: { message: 'duplicate' }
    })

    await waitFor(() => expect(screen.getAllByTestId(/timeline-event-/)).toHaveLength(2))
    expect(screen.getAllByTestId(/timeline-event-/).map((node) => node.dataset.testid)).toEqual([
      'timeline-event-event-1',
      'timeline-event-event-2'
    ])
    expect(screen.getByText(/secretToken: \[redacted\]/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'View run-older' }))
    await waitFor(() => expect(attachments).toHaveLength(2))
    expect(attachments[0].stream.abortReceiver.isAborted()).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'View run-newest' }))
    await waitFor(() => expect(attachments).toHaveLength(3))
    expect(attachments[2].request).toEqual({
      runId: 'run-newest',
      route: ROUTE,
      afterEventId: 'event-2'
    })
    expect(attachments[1].stream.abortReceiver.isAborted()).toBe(true)

    view.unmount()
    expect(attachments[2].stream.abortReceiver.isAborted()).toBe(true)
  })

  it('retries a transient attach from its saved cursor and resets backoff after an event', async () => {
    vi.useFakeTimers()
    try {
      const attachments: Array<{ request: Record<string, unknown>; stream: any }> = []
      const attempts: Array<{
        resolve: () => void
        reject: (error: unknown) => void
      }> = []
      platformApi.listGraphRuns.mockResolvedValueOnce({
        runs: [makeRun({ runId: 'run-live', status: 'running' })]
      })
      platformApi.attachGraphRun.mockImplementation((request, stream) => {
        attachments.push({ request, stream })
        return new Promise<void>((resolve, reject) => attempts.push({ resolve, reject }))
      })

      renderPage()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(attachments).toHaveLength(1)

      act(() => {
        attachments[0].stream.onData({
          eventId: 'cursor-1',
          runId: 'run-live',
          sequence: 1,
          kind: 'node.started',
          timestamp: 1,
          payload: {}
        })
      })
      await act(async () => attempts[0].reject(new Error('temporary transport failure')))
      expect(screen.getByText('Client status: retrying')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(attachments).toHaveLength(2)
      expect(attachments[1].request).toEqual({
        runId: 'run-live',
        route: ROUTE,
        afterEventId: 'cursor-1'
      })

      act(() => {
        attachments[1].stream.onData({
          eventId: 'cursor-2',
          runId: 'run-live',
          sequence: 2,
          kind: 'node.completed',
          timestamp: 2,
          payload: {}
        })
      })
      await act(async () => attempts[1].reject(new Error('temporary again')))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(999)
      })
      expect(attachments).toHaveLength(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(attachments).toHaveLength(3)
      expect(attachments[2].request).toEqual({
        runId: 'run-live',
        route: ROUTE,
        afterEventId: 'cursor-2'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks client-observed silence stale and returns live when an event arrives', async () => {
    vi.useFakeTimers()
    try {
      let stream: any
      platformApi.listGraphRuns.mockResolvedValueOnce({
        runs: [makeRun({ runId: 'run-live', status: 'running' })]
      })
      platformApi.attachGraphRun.mockImplementation(async (_request, nextStream) => {
        stream = nextStream
        await new Promise<void>((resolve) => nextStream.abortReceiver.onAbort(resolve))
      })

      renderPage()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('Client status: connecting')).toBeInTheDocument()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(screen.getByText('Client status: stale')).toBeInTheDocument()

      act(() => {
        stream.onData({
          eventId: 'event-live',
          runId: 'run-live',
          sequence: 1,
          kind: 'node.started',
          timestamp: 1,
          payload: {}
        })
      })
      expect(screen.getByText('Client status: live')).toBeInTheDocument()
      expect(screen.getByText(/Last event: (?!—)/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry terminal or structured permanent attach failures', async () => {
    vi.useFakeTimers()
    try {
      platformApi.attachGraphRun.mockResolvedValueOnce(undefined)
      renderPage()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(platformApi.attachGraphRun).toHaveBeenCalledTimes(1)
      expect(screen.getByText('Client status: ended')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }

    vi.clearAllMocks()
    seedEnabled()
    platformApi.listTriggers.mockResolvedValue({ triggers: [] })
    platformApi.listDrives.mockResolvedValue({ drives: [] })
    platformApi.listGraphRuns.mockResolvedValueOnce({
      runs: [makeRun({ runId: 'run-live', status: 'running' })]
    })
    platformApi.attachGraphRun.mockRejectedValueOnce({ status: 403, message: 'Forbidden' })
    vi.useFakeTimers()
    try {
      renderPage()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(platformApi.attachGraphRun).toHaveBeenCalledTimes(1)
      expect(screen.getByText('Client status: failed')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up pending attach retry timers on unmount', async () => {
    vi.useFakeTimers()
    try {
      platformApi.listGraphRuns.mockResolvedValueOnce({
        runs: [makeRun({ runId: 'run-live', status: 'running' })]
      })
      platformApi.attachGraphRun.mockRejectedValue(new Error('temporary'))
      const view = renderPage()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(platformApi.attachGraphRun).toHaveBeenCalledTimes(1)
      view.unmount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(platformApi.attachGraphRun).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps graph actions disabled and skips catalog/history calls when the platform flag is off', async () => {
    platformApi.getStatus.mockResolvedValueOnce({
      enabled: false,
      featureFlag: 'MAGICPOT_MAGICAGENT_PLATFORM',
      platformVersion: 1,
      assistantRuntimeCompatible: true,
      agentCount: 0,
      toolCount: 0,
      assistantToolCount: 0,
      creativeToolCount: 0,
      graphCount: 0,
      packageCount: 0
    })

    renderPage()

    await waitFor(() => expect(platformApi.getStatus).toHaveBeenCalledTimes(1))

    expect(screen.getAllByText(FLAG_HELP).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Run Graph' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh History' })).toBeDisabled()
    expect(screen.getByLabelText('Prompt')).toBeDisabled()
    expect(platformApi.listAgents).not.toHaveBeenCalled()
    expect(platformApi.listTools).not.toHaveBeenCalled()
    expect(platformApi.listGraphs).not.toHaveBeenCalled()
    expect(platformApi.listPackages).not.toHaveBeenCalled()
    expect(platformApi.listGraphRuns).not.toHaveBeenCalled()
    expect(platformApi.watchGraphRun).not.toHaveBeenCalled()
  })

  it('loads inventory, default graph, route-scoped history, and newest active run', async () => {
    const older = makeRun({
      runId: 'run-older',
      input: 'Older prompt',
      updatedAt: 2,
      outputs: [{ outputId: 'old', name: 'Old', content: 'Older output', sourceNodeId: 'writer' }]
    })
    const newest = makeRun({
      runId: 'run-newest',
      input: 'Latest prompt',
      updatedAt: 3,
      outputs: [{ outputId: 'new', name: 'New', content: 'Newest output', sourceNodeId: 'writer' }]
    })
    platformApi.listGraphRuns.mockResolvedValueOnce({ runs: [older, newest] })

    renderPage()

    await screen.findByText('Newest output')

    expect(platformApi.listGraphRuns).toHaveBeenCalledWith({
      route: ROUTE,
      graphId: 'graph-alpha',
      limit: GRAPH_RUN_HISTORY_LIMIT
    })
    expect(screen.getByRole('combobox', { name: 'Graph' })).toHaveValue('graph-alpha')
    expect(
      screen.getByText(/Designs cozy product pitches.*2 nodes.*1 channels.*1 outputs/)
    ).toBeInTheDocument()
    expect(screen.getAllByText('run-newest').length).toBeGreaterThan(0)
    expect(screen.getByText('Latest prompt')).toBeInTheDocument()
    expect(screen.getByText('Designer Agent')).toBeInTheDocument()
    expect(screen.getByText('magicAgentRuntime:pitch.create')).toBeInTheDocument()
    expect(screen.getByText('pkg-demo@0.1.0')).toBeInTheDocument()
  })

  it('refreshes route-scoped history and clears active output when switching graphs', async () => {
    platformApi.listGraphRuns.mockImplementation(
      async ({ graphId }: { graphId?: string; limit?: number }) => ({
        runs:
          graphId === 'graph-beta'
            ? [
                makeRun({
                  runId: 'run-beta',
                  graphId: 'graph-beta',
                  input: 'Beta prompt',
                  outputs: [],
                  channels: []
                })
              ]
            : [
                makeRun({
                  outputs: [
                    {
                      outputId: 'alpha',
                      name: 'Alpha',
                      content: 'Alpha output',
                      sourceNodeId: 'writer'
                    }
                  ]
                })
              ]
      })
    )

    renderPage()

    await screen.findByText('Alpha output')
    fireEvent.change(screen.getByRole('combobox', { name: 'Graph' }), {
      target: { value: 'graph-beta' }
    })

    await waitFor(() => {
      expect(platformApi.listGraphRuns).toHaveBeenLastCalledWith({
        route: ROUTE,
        graphId: 'graph-beta',
        limit: GRAPH_RUN_HISTORY_LIMIT
      })
    })

    expect(screen.getByRole('combobox', { name: 'Graph' })).toHaveValue('graph-beta')
    expect(
      screen.getByText(/Builds storyboard beats.*3 nodes.*2 channels.*1 outputs/)
    ).toBeInTheDocument()
    expect(screen.queryByText('Alpha output')).not.toBeInTheDocument()
    expect(screen.getByText('No graph output yet.')).toBeInTheDocument()
    expect(screen.getByText('Beta prompt')).toBeInTheDocument()
  })

  it('trims prompts and runs the selected graph through the Agent Studio route', async () => {
    const user = userEvent.setup()
    const created = makeRun({
      runId: 'run-created',
      input: 'Build a lava level',
      outputs: [
        {
          outputId: 'created',
          name: 'Created Pitch',
          content: 'Lava level pitch',
          sourceNodeId: 'writer'
        }
      ]
    })
    platformApi.listGraphRuns
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValueOnce({ runs: [created] })
    platformApi.runGraph.mockResolvedValueOnce(created)

    renderPage()

    await waitFor(() => expect(platformApi.listGraphRuns).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: '  Build a lava level  ' }
    })
    await user.click(screen.getByRole('button', { name: 'Run Graph' }))

    await waitFor(() => {
      expect(platformApi.runGraph).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: expect.stringMatching(/^agent-studio-graph-run-/),
          graphId: 'graph-alpha',
          input: 'Build a lava level',
          route: ROUTE,
          metadata: expect.objectContaining({ source: 'agent-studio' })
        })
      )
    })
    const runReq = platformApi.runGraph.mock.calls[0]?.[0]
    expect(platformApi.watchGraphRun).toHaveBeenCalledWith(
      { runId: runReq.runId, route: ROUTE },
      expect.objectContaining({ onData: expect.any(Function), abortReceiver: expect.any(Object) })
    )
    expect(screen.getByText('Lava level pitch')).toBeInTheDocument()
    expect(platformApi.listGraphRuns).toHaveBeenLastCalledWith({
      route: ROUTE,
      graphId: 'graph-alpha',
      limit: GRAPH_RUN_HISTORY_LIMIT
    })
  })

  it('drives the visual palette from production-loaded node descriptors', async () => {
    const detail = makeGraphDetail()
    const definitionV2 = {
      kind: 'magic-agent.graph-definition.v2-draft',
      graphMode: 'design',
      schemaVersion: '2.0.0',
      graphId: detail.graphId,
      name: detail.name,
      description: detail.description,
      version: detail.version,
      tags: [],
      nodes: [],
      edges: [],
      variables: [],
      outputs: [],
      entryNodeIds: [],
      metadata: {},
      legacySnapshot: detail
    }
    const reason = 'Only available after the production executor is installed.'
    platformApi.getGraphV2.mockResolvedValue({ definitionV2 })
    platformApi.listGraphV2NodeRegistry.mockResolvedValue({
      descriptors: [
        {
          kind: 'production-only',
          category: 'Automation',
          title: 'Production only',
          description: 'Loaded from the production registry.',
          executable: false,
          execution: { mode: 'unsupported', reason },
          configSchema: { type: 'object', additionalProperties: false, properties: {} },
          defaultConfig: {},
          defaultInputs: [],
          defaultOutputs: []
        }
      ]
    })

    renderPage()

    const loaded = await screen.findByRole('button', { name: 'Production only' })
    expect(loaded).toBeDisabled()
    expect(loaded).toHaveAttribute('title', reason)
    expect(screen.getByText('registry 1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Agent$/ })).not.toBeInTheDocument()
  })

  it('keeps an empty production registry empty and shows its offline notice', async () => {
    const detail = makeGraphDetail()
    platformApi.getGraphV2.mockResolvedValue({
      definitionV2: {
        kind: 'magic-agent.graph-definition.v2-draft',
        graphMode: 'design',
        schemaVersion: '2.0.0',
        graphId: detail.graphId,
        name: detail.name,
        description: detail.description,
        version: detail.version,
        tags: [],
        nodes: [],
        edges: [],
        variables: [],
        outputs: [],
        entryNodeIds: [],
        metadata: {},
        legacySnapshot: detail
      }
    })

    renderPage()

    expect(
      await screen.findByText('Node registry is offline or empty. No palette nodes are available.')
    ).toBeInTheDocument()
    expect(screen.getByText('registry 0')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Input$/ })).not.toBeInTheDocument()
  })

  it('edits and saves a V2 authoring document through the typed service', async () => {
    const user = userEvent.setup()
    const detail = makeGraphDetail()
    const definitionV2 = {
      kind: 'magic-agent.graph-definition.v2-draft',
      schemaVersion: 2,
      graphId: detail.graphId,
      name: detail.name,
      description: detail.description,
      version: detail.version,
      tags: [],
      nodes: [],
      edges: [],
      variables: [],
      secrets: [],
      subgraphs: [],
      errorRoutes: [],
      inputs: [],
      outputs: [],
      metadata: {},
      legacySnapshot: detail
    }
    platformApi.getGraphV2.mockResolvedValue({ definitionV2 })
    platformApi.saveGraphV2.mockResolvedValue({ graph: detail, definitionV2 })
    renderPage()
    const editor = await screen.findByLabelText('Graph V2 JSON')
    await user.clear(editor)
    fireEvent.change(editor, {
      target: { value: JSON.stringify({ ...definitionV2, description: 'Edited V2' }) }
    })
    await user.click(screen.getByRole('button', { name: 'Save Graph V2' }))
    await waitFor(() =>
      expect(platformApi.saveGraphV2).toHaveBeenCalledWith(
        expect.objectContaining({
          graph: expect.objectContaining({ description: 'Edited V2' }),
          route: ROUTE,
          replace: true
        })
      )
    )
  })

  it('renders the distinct least-privilege runtime graph DTO instead of synthesizing topology', async () => {
    const detail = makeGraphDetail()
    const definitionV2 = {
      kind: 'magic-agent.graph-definition.v2-draft',
      schemaVersion: 2,
      graphId: detail.graphId,
      name: detail.name,
      description: detail.description,
      version: detail.version,
      tags: [],
      nodes: [],
      edges: [],
      variables: [],
      secrets: [],
      subgraphs: [],
      errorRoutes: [],
      inputs: [],
      outputs: [],
      metadata: {},
      legacySnapshot: detail
    }
    const run = makeRun({ runId: 'run-runtime-topology', nodes: undefined })
    platformApi.getGraphV2.mockResolvedValue({ definitionV2 })
    platformApi.listGraphRuns.mockResolvedValueOnce({ runs: [run] })
    platformApi.getRuntimeGraphTopology.mockResolvedValueOnce({
      runId: run.runId,
      graphId: run.graphId,
      status: run.status,
      revision: 7,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      resources: [
        {
          resourceId: 'runtime-node-planner',
          kind: 'node',
          nodeKind: 'agent',
          status: 'completed',
          sourceNodeId: 'planner',
          createdAt: run.createdAt
        },
        {
          resourceId: 'runtime-channel-planner-writer',
          kind: 'channel',
          status: 'delivered',
          sourceNodeId: 'planner',
          targetNodeId: 'writer',
          sourceChannelId: 'planner-writer',
          createdAt: run.updatedAt
        },
        {
          resourceId: 'runtime-wire-planner-writer',
          kind: 'wire',
          status: 'delivered',
          sourceChannelId: 'planner-writer',
          sourceResourceId: 'runtime-node-planner',
          targetResourceId: 'runtime-channel-planner-writer',
          createdAt: run.updatedAt
        }
      ]
    })

    renderPage()

    expect(
      await screen.findByText(/Runtime topology · run run-runtime-topology · revision 7/)
    ).toBeInTheDocument()
    expect(screen.getByText('runtime-node-planner')).toBeInTheDocument()
    expect(screen.getByText('runtime-channel-planner-writer')).toBeInTheDocument()
    expect(screen.getAllByText('runtime-wire-planner-writer').length).toBeGreaterThan(0)
    expect(screen.getByTestId('runtime-wire-edge')).toBeInTheDocument()
    expect(platformApi.getRuntimeGraphTopology).toHaveBeenCalledWith({
      runId: run.runId,
      route: ROUTE
    })
  })

  it('renders runtime topology service errors', async () => {
    platformApi.getRuntimeGraphTopology.mockRejectedValueOnce(new Error('topology unavailable'))

    renderPage()

    const alert = await screen.findByTestId('runtime-topology-error')
    expect(alert).toHaveRole('alert')
    expect(alert).toHaveTextContent(/failed to load runtime topology/i)
    expect(alert).toHaveTextContent(/topology unavailable/i)
  })

  it('refreshes runtime topology when the active run revision changes', async () => {
    const initial = makeRun({ runtimeTopology: { revision: 1 } as never })
    const refreshed = makeRun({
      updatedAt: initial.updatedAt + 1,
      runtimeTopology: { revision: 2 } as never
    })
    platformApi.listGraphRuns.mockResolvedValueOnce({ runs: [initial] })
    platformApi.getGraphRun.mockResolvedValueOnce({ run: refreshed })

    renderPage()
    await waitFor(() => expect(platformApi.getRuntimeGraphTopology).toHaveBeenCalledTimes(1))

    fireEvent.click(await screen.findByRole('button', { name: `View ${initial.runId}` }))

    await waitFor(() => expect(platformApi.getRuntimeGraphTopology).toHaveBeenCalledTimes(2))
    expect(platformApi.getRuntimeGraphTopology).toHaveBeenLastCalledWith({
      runId: refreshed.runId,
      route: ROUTE
    })
  })

  it('wires canvas node execution to production runs and uses durable redacted previews', async () => {
    const user = userEvent.setup()
    const detail = makeGraphDetail({
      nodes: [
        { nodeId: 'planner', kind: 'agent', name: 'Planner', description: 'Plans' },
        { nodeId: 'writer', kind: 'agent', name: 'Writer', description: 'Writes' }
      ],
      channels: [
        {
          channelId: 'planner-writer',
          from: 'planner',
          to: 'writer',
          kind: 'message',
          required: true
        }
      ]
    })
    const node = {
      nodeId: 'writer',
      kind: 'agent' as const,
      name: 'Writer',
      description: 'Writes',
      position: { x: 10, y: 10 },
      inputs: [],
      outputs: [],
      config: {}
    }
    const definitionV2 = {
      kind: 'magic-agent.graph-definition.v2-draft' as const,
      graphMode: 'design' as const,
      schemaVersion: '2.0.0',
      graphId: detail.graphId,
      name: detail.name,
      description: detail.description,
      version: detail.version,
      tags: [],
      nodes: [node],
      edges: [],
      variables: [],
      outputs: [],
      entryNodeIds: ['writer'],
      metadata: {},
      legacySnapshot: detail
    }
    const priorRun = makeRun({
      nodes: [
        {
          nodeId: 'writer',
          kind: 'agent',
          status: 'completed',
          input: 'token=private-value',
          output: `password=hunter2 ${'x'.repeat(2_100)}`
        }
      ]
    })
    platformApi.inspectGraph.mockResolvedValue({ graph: detail })
    platformApi.getGraphV2.mockResolvedValue({ definitionV2 })
    platformApi.listGraphRuns.mockResolvedValueOnce({ runs: [priorRun] })
    platformApi.runGraph.mockResolvedValue(makeRun({ runId: 'node-run' }))

    renderPage()
    await user.click(await screen.findByLabelText('Graph node Writer'))

    expect(screen.getByText(/Input preview: "token=\[redacted\]"/)).toBeInTheDocument()
    expect(
      screen.getByText(/Output preview:.*password=\[redacted\].*truncated/)
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Test node' }))
    await waitFor(() =>
      expect(platformApi.runGraph).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: 'graph-alpha',
          nodeExecution: {
            mode: 'single-node',
            nodeId: 'writer',
            inputs: { input: 'Create a concise game concept pitch for a cozy puzzle adventure.' }
          }
        })
      )
    )

    platformApi.runGraph.mockClear()
    await user.click(screen.getByRole('button', { name: 'Run from node' }))
    await waitFor(() =>
      expect(platformApi.runGraph).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeExecution: { mode: 'run-from-node', nodeId: 'writer', priorRunId: 'node-run' }
        })
      )
    )
  })

  it('loads a V2 sidecar and includes it in the production run request', async () => {
    const user = userEvent.setup()
    const detail = makeGraphDetail()
    const definitionV2 = {
      kind: 'magic-agent.graph-definition.v2-draft',
      schemaVersion: 2,
      graphId: detail.graphId,
      name: detail.name,
      description: detail.description,
      version: detail.version,
      tags: [],
      nodes: [],
      edges: [],
      variables: [],
      secrets: [],
      subgraphs: [],
      errorRoutes: [],
      inputs: [],
      outputs: [],
      metadata: {},
      legacySnapshot: detail
    }
    platformApi.getGraphV2.mockResolvedValue({ definitionV2 })
    platformApi.runGraph.mockResolvedValue(makeRun({ runId: 'run-v2' }))
    renderPage()
    await waitFor(() => expect(platformApi.getGraphV2).toHaveBeenCalled())
    await user.type(screen.getByLabelText('Prompt'), 'Run V2')
    await user.click(screen.getByRole('button', { name: 'Run Graph' }))
    await waitFor(() =>
      expect(platformApi.runGraph).toHaveBeenCalledWith(expect.objectContaining({ definitionV2 }))
    )
  })
  it('defaults tool graph runs to the suggested explicit tool allowlist', async () => {
    const user = userEvent.setup()
    platformApi.inspectGraph.mockResolvedValueOnce({
      graph: makeGraphDetail({
        nodes: [
          {
            nodeId: 'planner',
            kind: 'agent',
            name: 'Planner',
            description: 'Plans the work'
          },
          {
            nodeId: 'tool-create-pitch',
            kind: 'tool',
            name: 'Create Pitch',
            description: 'Creates a pitch',
            toolName: 'pitch.create'
          }
        ]
      })
    })
    platformApi.listGraphRuns.mockResolvedValueOnce({ runs: [] })

    renderPage()

    const toolCheckbox = await screen.findByRole('checkbox', { name: 'pitch.create' })
    await waitFor(() => expect(toolCheckbox).toBeChecked())

    await user.click(screen.getByRole('button', { name: 'Run Graph' }))

    await waitFor(() => {
      expect(platformApi.runGraph).toHaveBeenCalledWith(
        expect.objectContaining({
          graphId: 'graph-alpha',
          route: ROUTE,
          allowedToolNames: ['pitch.create']
        })
      )
    })
  })

  it('disables tool graph runs when a required tool is not allowed', async () => {
    const user = userEvent.setup()
    platformApi.inspectGraph.mockResolvedValueOnce({
      graph: makeGraphDetail({
        nodes: [
          {
            nodeId: 'planner',
            kind: 'agent',
            name: 'Planner',
            description: 'Plans the work'
          },
          {
            nodeId: 'tool-create-pitch',
            kind: 'tool',
            name: 'Create Pitch',
            description: 'Creates a pitch',
            toolName: 'pitch.create'
          }
        ]
      })
    })

    renderPage()

    const runButton = screen.getByRole('button', { name: 'Run Graph' })
    const toolCheckbox = await screen.findByRole('checkbox', { name: 'pitch.create' })
    await waitFor(() => expect(toolCheckbox).toBeChecked())
    await user.click(toolCheckbox)

    expect(toolCheckbox).not.toBeChecked()
    expect(runButton).toBeDisabled()
    expect(
      screen.getByText(/Allow required tools before running: pitch\.create/)
    ).toBeInTheDocument()
    expect(platformApi.runGraph).not.toHaveBeenCalled()
  })

  it('handles missing route-scoped run lookups', async () => {
    const user = userEvent.setup()
    platformApi.listGraphRuns.mockResolvedValueOnce({ runs: [makeRun({ runId: 'run-missing' })] })
    platformApi.getGraphRun.mockResolvedValueOnce({ run: undefined })

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'View run-missing' }))

    await waitFor(() => {
      expect(platformApi.getGraphRun).toHaveBeenCalledWith({ runId: 'run-missing', route: ROUTE })
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Graph run run-missing was not found for the Agent Studio route.'
    )
  })

  it('cancels cancellable runs with the documented reason and refreshes the record', async () => {
    const user = userEvent.setup()
    const running = makeRun({
      runId: 'run-running',
      status: 'running',
      outputs: [],
      channels: [],
      updatedAt: 4
    })
    const cancelled = makeRun({
      runId: 'run-running',
      status: 'cancelled',
      outputs: [],
      channels: [],
      error: 'Cancelled from Agent Studio',
      updatedAt: 5
    })
    platformApi.listGraphRuns
      .mockResolvedValueOnce({ runs: [running] })
      .mockResolvedValueOnce({ runs: [cancelled] })
    platformApi.cancelGraphRun.mockResolvedValueOnce({
      runId: 'run-running',
      cancelled: true,
      status: 'cancelled'
    })
    platformApi.getGraphRun.mockResolvedValueOnce({ run: cancelled })

    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Cancel Active Run' }))

    await waitFor(() => {
      expect(platformApi.cancelGraphRun).toHaveBeenCalledWith({
        runId: 'run-running',
        route: ROUTE,
        reason: 'Cancelled from Agent Studio'
      })
    })
    expect(platformApi.getGraphRun).toHaveBeenCalledWith({ runId: 'run-running', route: ROUTE })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Cancel Active Run' })).not.toBeInTheDocument()
    })
    expect(screen.getAllByText('Cancelled from Agent Studio').length).toBeGreaterThan(0)
  })
})
