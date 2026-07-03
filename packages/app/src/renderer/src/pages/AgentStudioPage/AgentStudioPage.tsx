import React, { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Grid,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { api } from '@renderer/utils/windowUtils'
import type { AgentRouteLike } from '@shared/agent'
import type {
  MagicAgentPlatformAgentDefinition,
  MagicAgentPlatformGraphListResp,
  MagicAgentPlatformListToolsResp,
  MagicAgentPlatformPackageListResp,
  MagicAgentPlatformStatusResp
} from '@shared/api/svcMagicAgentPlatform'
import type { MagicAgentGraphRunRecord, MagicAgentGraphRunStatus } from '@shared/magicAgent'

const MAGIC_AGENT_FLAG_HELP = 'Set MAGICPOT_MAGICAGENT_PLATFORM=1 to enable Agent Studio actions.'
const AGENT_STUDIO_ROUTE: AgentRouteLike = {
  channel: 'generic',
  scopeType: 'dm',
  scopeId: 'agent-studio'
}
const DEFAULT_GRAPH_PROMPT = 'Create a concise game concept pitch for a cozy puzzle adventure.'
const GRAPH_RUN_HISTORY_LIMIT = 50

const terminalGraphRunStatuses = new Set<MagicAgentGraphRunStatus>([
  'completed',
  'failed',
  'cancelled'
])

const graphRunStatusColor: Record<
  MagicAgentGraphRunStatus,
  'default' | 'primary' | 'success' | 'error' | 'warning'
> = {
  pending: 'default',
  running: 'primary',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning'
}

type StudioState = {
  status?: MagicAgentPlatformStatusResp
  agents: MagicAgentPlatformAgentDefinition[]
  tools: MagicAgentPlatformListToolsResp['tools']
  graphs: MagicAgentPlatformGraphListResp['graphs']
  packages: MagicAgentPlatformPackageListResp['packages']
}

const emptyState: StudioState = {
  agents: [],
  tools: [],
  graphs: [],
  packages: []
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const formatTimestamp = (timestamp?: number): string =>
  timestamp === undefined ? '—' : new Date(timestamp).toLocaleString()

const sortRuns = (runs: MagicAgentGraphRunRecord[]): MagicAgentGraphRunRecord[] =>
  [...runs].sort(
    (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt
  )

const isGraphRunCancellable = (run?: MagicAgentGraphRunRecord | null): boolean =>
  Boolean(run && !terminalGraphRunStatuses.has(run.status))

const formatGraphRunText = (run?: MagicAgentGraphRunRecord | null): string => {
  if (!run) return ''
  if (run.outputs.length) {
    return run.outputs
      .map((output) => [`## ${output.name || output.outputId}`, output.content].join('\n\n'))
      .join('\n\n---\n\n')
  }
  if (run.error) return run.error
  if (run.channels.length) {
    return run.channels
      .map((channel) =>
        [`${channel.from} → ${channel.to} (${channel.kind})`, channel.content].join('\n')
      )
      .join('\n\n')
  }
  return `Run ${run.runId} is ${run.status}. No output returned yet.`
}

const AgentStudioPage: React.FC = () => {
  const [state, setState] = useState<StudioState>(emptyState)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [selectedGraphId, setSelectedGraphId] = useState('')
  const [prompt, setPrompt] = useState(DEFAULT_GRAPH_PROMPT)
  const [activeRun, setActiveRun] = useState<MagicAgentGraphRunRecord | null>(null)
  const [runHistory, setRunHistory] = useState<MagicAgentGraphRunRecord[]>([])
  const [refreshingRunId, setRefreshingRunId] = useState<string | null>(null)
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null)
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)

  const platformEnabled = Boolean(state.status?.enabled)
  const selectedGraph = useMemo(
    () => state.graphs.find((graph) => graph.graphId === selectedGraphId),
    [selectedGraphId, state.graphs]
  )
  const outputFallback = result && !activeRun?.outputs.length ? result : ''

  const refreshGraphRuns = async (
    graphId = selectedGraphId
  ): Promise<MagicAgentGraphRunRecord[]> => {
    if (!state.status?.enabled || !graphId) {
      setRunHistory([])
      return []
    }

    setHistoryLoading(true)
    try {
      const response = await api().svcMagicAgentPlatform.listGraphRuns({
        route: AGENT_STUDIO_ROUTE,
        graphId,
        limit: GRAPH_RUN_HISTORY_LIMIT
      })
      const runs = sortRuns(response.runs)
      setRunHistory(runs)
      return runs
    } catch (err) {
      setError(getErrorMessage(err))
      return []
    } finally {
      setHistoryLoading(false)
    }
  }

  const loadStudio = async () => {
    setLoading(true)
    setError(null)
    try {
      const status = await api().svcMagicAgentPlatform.getStatus({})
      if (!status.enabled) {
        setState({ ...emptyState, status })
        setSelectedGraphId('')
        setActiveRun(null)
        setRunHistory([])
        setResult(MAGIC_AGENT_FLAG_HELP)
        return
      }

      const [agents, tools, graphs, packages] = await Promise.all([
        api().svcMagicAgentPlatform.listAgents({}),
        api().svcMagicAgentPlatform.listTools({}),
        api().svcMagicAgentPlatform.listGraphs({}),
        api().svcMagicAgentPlatform.listPackages({})
      ])
      const nextGraphId =
        selectedGraphId && graphs.graphs.some((graph) => graph.graphId === selectedGraphId)
          ? selectedGraphId
          : graphs.graphs[0]?.graphId || ''
      const nextHistory = nextGraphId
        ? sortRuns(
            (
              await api().svcMagicAgentPlatform.listGraphRuns({
                route: AGENT_STUDIO_ROUTE,
                graphId: nextGraphId,
                limit: GRAPH_RUN_HISTORY_LIMIT
              })
            ).runs
          )
        : []

      setState({
        status,
        agents: agents.agents,
        tools: tools.tools,
        graphs: graphs.graphs,
        packages: packages.packages
      })
      setSelectedGraphId(nextGraphId)
      setRunHistory(nextHistory)
      setActiveRun((current) => {
        if (current && nextHistory.some((run) => run.runId === current.runId)) return current
        return nextHistory[0] || null
      })
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadStudio()
  }, [])

  const handleGraphChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const graphId = event.target.value
    setSelectedGraphId(graphId)
    setActiveRun(null)
    setResult('')
    setError(null)
    void refreshGraphRuns(graphId)
  }

  const runSelectedGraph = async () => {
    const input = prompt.trim()
    if (!platformEnabled) {
      setResult(MAGIC_AGENT_FLAG_HELP)
      return
    }
    if (!selectedGraphId || !input) return

    setRunning(true)
    setError(null)
    try {
      const response = await api().svcMagicAgentPlatform.runGraph({
        graphId: selectedGraphId,
        input,
        route: AGENT_STUDIO_ROUTE,
        metadata: { source: 'agent-studio' }
      })
      setActiveRun(response)
      setResult(formatGraphRunText(response))
      await refreshGraphRuns(response.graphId)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setRunning(false)
    }
  }

  const refreshGraphRun = async (runId: string) => {
    if (!platformEnabled) {
      setResult(MAGIC_AGENT_FLAG_HELP)
      return
    }

    setRefreshingRunId(runId)
    setError(null)
    try {
      const response = await api().svcMagicAgentPlatform.getGraphRun({
        runId,
        route: AGENT_STUDIO_ROUTE
      })
      if (!response.run) {
        setError(`Graph run ${runId} was not found for the Agent Studio route.`)
        return
      }
      setActiveRun(response.run)
      setSelectedGraphId(response.run.graphId)
      setResult(formatGraphRunText(response.run))
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setRefreshingRunId(null)
    }
  }

  const cancelGraphRun = async (runId: string) => {
    if (!platformEnabled) {
      setResult(MAGIC_AGENT_FLAG_HELP)
      return
    }

    setCancellingRunId(runId)
    setError(null)
    try {
      const cancelResult = await api().svcMagicAgentPlatform.cancelGraphRun({
        runId,
        route: AGENT_STUDIO_ROUTE,
        reason: 'Cancelled from Agent Studio'
      })
      if (cancelResult.error) {
        setError(cancelResult.error)
      }
      const response = await api().svcMagicAgentPlatform.getGraphRun({
        runId,
        route: AGENT_STUDIO_ROUTE
      })
      if (response.run) {
        setActiveRun(response.run)
        setSelectedGraphId(response.run.graphId)
        setResult(formatGraphRunText(response.run))
        await refreshGraphRuns(response.run.graphId)
      } else {
        await refreshGraphRuns(selectedGraphId)
      }
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setCancellingRunId(null)
    }
  }

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 3, bgcolor: 'background.default' }}>
      <Stack spacing={3}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
          <Box>
            <Typography variant="h4" fontWeight={700}>
              Agent Studio
            </Typography>
            <Typography variant="body2" color="text.secondary">
              MagicAgent Platform v1: agents, creative tools, graph teams, and package inventory.
            </Typography>
          </Box>
          <Button variant="outlined" onClick={() => void loadStudio()} disabled={loading}>
            Refresh
          </Button>
        </Stack>

        {error ? <Alert severity="error">{error}</Alert> : null}
        {state.status && !state.status.enabled ? (
          <Alert severity="info">{MAGIC_AGENT_FLAG_HELP}</Alert>
        ) : null}

        {loading ? (
          <Stack alignItems="center" sx={{ py: 6 }}>
            <CircularProgress size={28} />
          </Stack>
        ) : (
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 3 }}>
              <Card>
                <CardContent>
                  <Typography color="text.secondary" variant="body2">
                    Agents
                  </Typography>
                  <Typography variant="h4">
                    {state.status?.agentCount ?? state.agents.length}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid size={{ xs: 12, md: 3 }}>
              <Card>
                <CardContent>
                  <Typography color="text.secondary" variant="body2">
                    Tools
                  </Typography>
                  <Typography variant="h4">
                    {state.status?.toolCount ?? state.tools.length}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid size={{ xs: 12, md: 3 }}>
              <Card>
                <CardContent>
                  <Typography color="text.secondary" variant="body2">
                    Graphs
                  </Typography>
                  <Typography variant="h4">
                    {state.status?.graphCount ?? state.graphs.length}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid size={{ xs: 12, md: 3 }}>
              <Card>
                <CardContent>
                  <Typography color="text.secondary" variant="body2">
                    Packages
                  </Typography>
                  <Typography variant="h4">
                    {state.status?.packageCount ?? state.packages.length}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        )}

        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Box>
                <Typography variant="h6">Graph Run Center</Typography>
                <Typography variant="body2" color="text.secondary">
                  Select a graph, submit a prompt, then inspect outputs, channel traffic, and run
                  history for the Agent Studio route.
                </Typography>
              </Box>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="stretch">
                <Box sx={{ minWidth: 280, flex: 1 }}>
                  <Typography
                    component="label"
                    htmlFor="agent-studio-graph-select"
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mb: 0.5 }}
                  >
                    Graph
                  </Typography>
                  <select
                    id="agent-studio-graph-select"
                    value={selectedGraphId}
                    onChange={handleGraphChange}
                    disabled={loading || !platformEnabled || !state.graphs.length}
                    style={{
                      width: '100%',
                      minHeight: 44,
                      borderRadius: 8,
                      border: '1px solid rgba(0, 0, 0, 0.23)',
                      padding: '10px 12px',
                      background: 'transparent',
                      color: 'inherit'
                    }}
                  >
                    {state.graphs.length ? (
                      state.graphs.map((graph) => (
                        <option key={graph.graphId} value={graph.graphId}>
                          {graph.name} ({graph.graphId})
                        </option>
                      ))
                    ) : (
                      <option value="">No graphs available</option>
                    )}
                  </select>
                  {selectedGraph ? (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mt: 0.75 }}
                    >
                      {selectedGraph.description || 'No description'} · {selectedGraph.nodeCount}{' '}
                      nodes · {selectedGraph.channelCount} channels · {selectedGraph.outputCount}{' '}
                      outputs
                    </Typography>
                  ) : null}
                </Box>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Button
                    variant="contained"
                    onClick={() => void runSelectedGraph()}
                    disabled={
                      running || loading || !platformEnabled || !selectedGraphId || !prompt.trim()
                    }
                  >
                    Run Graph
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={() => {
                      setError(null)
                      void refreshGraphRuns()
                    }}
                    disabled={historyLoading || loading || !platformEnabled || !selectedGraphId}
                  >
                    Refresh History
                  </Button>
                  {activeRun ? (
                    <Button
                      variant="outlined"
                      onClick={() => void refreshGraphRun(activeRun.runId)}
                      disabled={refreshingRunId === activeRun.runId || !platformEnabled}
                    >
                      Refresh Active Run
                    </Button>
                  ) : null}
                  {activeRun && isGraphRunCancellable(activeRun) ? (
                    <Button
                      color="warning"
                      variant="outlined"
                      onClick={() => void cancelGraphRun(activeRun.runId)}
                      disabled={cancellingRunId === activeRun.runId || !platformEnabled}
                    >
                      Cancel Active Run
                    </Button>
                  ) : null}
                  {running || historyLoading ? <CircularProgress size={22} /> : null}
                </Stack>
              </Stack>
              <TextField
                label="Prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                multiline
                minRows={3}
                fullWidth
                disabled={!platformEnabled}
              />
            </Stack>
          </CardContent>
        </Card>

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 4 }}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6">Run Status</Typography>
                <Divider sx={{ my: 1 }} />
                {activeRun ? (
                  <Stack spacing={1}>
                    <Stack
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      flexWrap="wrap"
                      useFlexGap
                    >
                      <Chip
                        label={activeRun.status}
                        color={graphRunStatusColor[activeRun.status]}
                        size="small"
                      />
                      <Typography variant="body2" fontWeight={600}>
                        {activeRun.runId}
                      </Typography>
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      Graph: {activeRun.graphId}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Created: {formatTimestamp(activeRun.createdAt)}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Updated: {formatTimestamp(activeRun.updatedAt)}
                    </Typography>
                    {activeRun.error ? <Alert severity="error">{activeRun.error}</Alert> : null}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    Run a graph or select a history item to inspect its status.
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6">Run Output</Typography>
                <Divider sx={{ my: 1 }} />
                {activeRun?.outputs.length ? (
                  <Stack spacing={1.5}>
                    {activeRun.outputs.map((output) => (
                      <Box key={output.outputId}>
                        <Typography fontWeight={600}>{output.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {output.outputId} · {output.sourceNodeId}
                          {output.mimeType ? ` · ${output.mimeType}` : ''}
                        </Typography>
                        <Box
                          component="pre"
                          sx={{
                            whiteSpace: 'pre-wrap',
                            m: 0,
                            mt: 1,
                            p: 2,
                            bgcolor: 'action.hover'
                          }}
                        >
                          {output.content}
                        </Box>
                      </Box>
                    ))}
                  </Stack>
                ) : outputFallback ? (
                  <Box
                    component="pre"
                    sx={{ whiteSpace: 'pre-wrap', m: 0, p: 2, bgcolor: 'action.hover' }}
                  >
                    {outputFallback}
                  </Box>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    No graph output yet.
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Typography variant="h6">Channels</Typography>
                <Divider sx={{ my: 1 }} />
                {activeRun?.channels.length ? (
                  <Stack spacing={1.5}>
                    {activeRun.channels.map((channel) => (
                      <Box key={`${channel.channelId}:${channel.createdAt}`}>
                        <Stack
                          direction="row"
                          spacing={1}
                          alignItems="center"
                          flexWrap="wrap"
                          useFlexGap
                        >
                          <Chip label={channel.kind} size="small" variant="outlined" />
                          <Typography variant="body2" fontWeight={600}>
                            {channel.from} → {channel.to}
                          </Typography>
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          {channel.channelId} · {formatTimestamp(channel.createdAt)}
                        </Typography>
                        <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
                          {channel.content}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    No channel records yet.
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12 }}>
            <Card>
              <CardContent>
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  spacing={2}
                >
                  <Typography variant="h6">Run History</Typography>
                  {historyLoading ? <CircularProgress size={18} /> : null}
                </Stack>
                <Divider sx={{ my: 1 }} />
                {runHistory.length ? (
                  <Stack spacing={1.5}>
                    {runHistory.map((run) => (
                      <Box
                        key={run.runId}
                        sx={{
                          p: 1.5,
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 1
                        }}
                      >
                        <Stack
                          direction={{ xs: 'column', md: 'row' }}
                          spacing={1}
                          alignItems={{ xs: 'flex-start', md: 'center' }}
                          justifyContent="space-between"
                        >
                          <Box>
                            <Stack
                              direction="row"
                              spacing={1}
                              alignItems="center"
                              flexWrap="wrap"
                              useFlexGap
                            >
                              <Chip
                                label={run.status}
                                color={graphRunStatusColor[run.status]}
                                size="small"
                              />
                              <Typography fontWeight={600}>{run.runId}</Typography>
                              <Typography variant="caption" color="text.secondary">
                                {formatTimestamp(run.updatedAt)}
                              </Typography>
                            </Stack>
                            <Typography variant="body2" color="text.secondary">
                              {run.input}
                            </Typography>
                            {run.error ? (
                              <Typography variant="caption" color="error">
                                {run.error}
                              </Typography>
                            ) : null}
                          </Box>
                          <Stack direction="row" spacing={1}>
                            <Button
                              size="small"
                              onClick={() => void refreshGraphRun(run.runId)}
                              disabled={refreshingRunId === run.runId || !platformEnabled}
                            >
                              View {run.runId}
                            </Button>
                            {isGraphRunCancellable(run) ? (
                              <Button
                                size="small"
                                color="warning"
                                onClick={() => void cancelGraphRun(run.runId)}
                                disabled={cancellingRunId === run.runId || !platformEnabled}
                              >
                                Cancel {run.runId}
                              </Button>
                            ) : null}
                          </Stack>
                        </Stack>
                      </Box>
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    No graph runs recorded for this route yet.
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Typography variant="h6">Agents</Typography>
                <Divider sx={{ my: 1 }} />
                <Stack spacing={1}>
                  {state.agents.map((agent) => (
                    <Box key={agent.id}>
                      <Typography fontWeight={600}>{agent.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {agent.id}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Typography variant="h6">Creative + Assistant Tools</Typography>
                <Divider sx={{ my: 1 }} />
                <Stack direction="row" gap={1} flexWrap="wrap">
                  {state.tools.slice(0, 80).map((tool) => (
                    <Chip
                      key={`${tool.source}:${tool.name}`}
                      label={`${tool.source}:${tool.name}`}
                      color={tool.status === 'unavailable' ? 'default' : 'primary'}
                      variant={tool.status === 'unavailable' ? 'outlined' : 'filled'}
                      size="small"
                    />
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Typography variant="h6">Graphs</Typography>
                <Divider sx={{ my: 1 }} />
                <Stack spacing={1}>
                  {state.graphs.map((graph) => (
                    <Box key={graph.graphId}>
                      <Typography fontWeight={600}>{graph.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {graph.graphId} · {graph.nodeCount} nodes · {graph.channelCount} channels
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Typography variant="h6">Packages</Typography>
                <Divider sx={{ my: 1 }} />
                <Stack spacing={1}>
                  {state.packages.length ? (
                    state.packages.map((pkg) => (
                      <Box key={pkg.id}>
                        <Typography fontWeight={600}>{pkg.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {pkg.id}@{pkg.version}
                        </Typography>
                      </Box>
                    ))
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      No MagicPot packages installed.
                    </Typography>
                  )}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Stack>
    </Box>
  )
}

export default AgentStudioPage
