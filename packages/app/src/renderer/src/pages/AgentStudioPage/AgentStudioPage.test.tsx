import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { theme } from '@renderer/theme'
import type { AgentRouteLike } from '@shared/agent'
import type { MagicAgentGraphRunRecord } from '@shared/magicAgent'
import AgentStudioPage from './AgentStudioPage'

const platformApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listAgents: vi.fn(),
  listTools: vi.fn(),
  listGraphs: vi.fn(),
  listPackages: vi.fn(),
  listGraphRuns: vi.fn(),
  runGraph: vi.fn(),
  getGraphRun: vi.fn(),
  cancelGraphRun: vi.fn()
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
  platformApi.runGraph.mockResolvedValue(makeRun())
  platformApi.getGraphRun.mockResolvedValue({ run: makeRun() })
  platformApi.cancelGraphRun.mockResolvedValue({
    runId: 'run-alpha',
    cancelled: true,
    status: 'cancelled'
  })
}

describe('AgentStudioPage Graph Run Center', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedEnabled()
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
      expect(platformApi.runGraph).toHaveBeenCalledWith({
        graphId: 'graph-alpha',
        input: 'Build a lava level',
        route: ROUTE,
        metadata: { source: 'agent-studio' }
      })
    })
    expect(screen.getByText('Lava level pitch')).toBeInTheDocument()
    expect(platformApi.listGraphRuns).toHaveBeenLastCalledWith({
      route: ROUTE,
      graphId: 'graph-alpha',
      limit: GRAPH_RUN_HISTORY_LIMIT
    })
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
    expect(
      screen.getByText('Graph run run-missing was not found for the Agent Studio route.')
    ).toBeInTheDocument()
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
