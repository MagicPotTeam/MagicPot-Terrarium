import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Grid,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { api } from '@renderer/utils/windowUtils'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import type { AgentRouteLike } from '@shared/agent'
import type {
  MagicAgentPlatformAgentDefinition,
  MagicAgentPlatformGraphListResp,
  MagicAgentPlatformListToolsResp,
  MagicAgentPlatformPackageListResp,
  MagicAgentPlatformStatusResp
} from '@shared/api/svcMagicAgentPlatform'
import type {
  MagicAgentGraphDefinition,
  MagicAgentGraphNodeDefinition,
  MagicAgentGraphRunRecord,
  MagicAgentGraphRunStatus,
  MagicAgentGraphRunStreamEvent
} from '@shared/magicAgent'

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

type RecordLike = Record<string, unknown>
type GraphListItem = MagicAgentPlatformGraphListResp['graphs'][number]
type GraphCatalogMetadata = {
  source?: string
  runnable?: boolean
  readOnly?: boolean
  forkable?: boolean
  unavailable?: boolean
  unavailableReason?: string
  allowedToolNames?: string[] | null
}
type GraphSnapshot = {
  graphId: string
  name?: string
  source?: string
  runnable?: boolean
  readOnly?: boolean
  forkable?: boolean
  unavailable?: boolean
  unavailableReason?: string
  nodeCount?: number
  channelCount?: number
  outputCount?: number
  nodes?: MagicAgentGraphNodeDefinition[]
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

const isRecord = (value: unknown): value is RecordLike =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

const readBoolean = (...values: unknown[]): boolean | undefined => {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
  return undefined
}

const readStringArray = (...values: unknown[]): string[] | null | undefined => {
  for (const value of values) {
    if (value === null) return null
    if (Array.isArray(value)) {
      const normalized = value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
      if (normalized.length || value.length === 0) return normalized
    }
  }
  return undefined
}

const formatTimestamp = (timestamp?: number): string =>
  timestamp === undefined ? '—' : new Date(timestamp).toLocaleString()

const sortRuns = (runs: MagicAgentGraphRunRecord[]): MagicAgentGraphRunRecord[] =>
  [...runs].sort(
    (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt
  )

const upsertRunHistory = (
  runs: MagicAgentGraphRunRecord[],
  run: MagicAgentGraphRunRecord
): MagicAgentGraphRunRecord[] =>
  sortRuns([run, ...runs.filter((candidate) => candidate.runId !== run.runId)]).slice(
    0,
    GRAPH_RUN_HISTORY_LIMIT
  )

const createAgentStudioGraphRunId = (): string =>
  `agent-studio-graph-run-${
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }`

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

const getGraphNestedMetadata = (
  graph?: GraphListItem | MagicAgentGraphDefinition
): { metadata: RecordLike; catalog: RecordLike; permissions: RecordLike } => {
  const record = graph as unknown as RecordLike | undefined
  const metadata = isRecord(record?.metadata) ? record.metadata : {}
  const catalog = isRecord(metadata.catalog) ? metadata.catalog : {}
  const permissions = isRecord(metadata.permissions) ? metadata.permissions : {}
  return { metadata, catalog, permissions }
}

const getGraphCatalogMetadata = (
  graph?: GraphListItem | MagicAgentGraphDefinition
): GraphCatalogMetadata => {
  if (!graph) return {}
  const record = graph as unknown as RecordLike
  const { metadata, catalog, permissions } = getGraphNestedMetadata(graph)
  const packageInfo = isRecord(metadata.package) ? metadata.package : {}
  const sourcePackage = readString(
    record.sourcePackageName,
    record.sourcePackageId,
    metadata.sourcePackageName,
    metadata.sourcePackageId,
    packageInfo.name,
    packageInfo.id
  )
  const builtIn = readBoolean(record.builtIn, metadata.builtIn) === true
  const source =
    readString(record.source, catalog.source, metadata.source) ||
    (sourcePackage ? `package:${sourcePackage}` : builtIn ? 'built-in' : 'workspace')
  const explicitRunnable = readBoolean(record.runnable, catalog.runnable, permissions.runnable)
  const explicitReadOnly = readBoolean(
    record.readOnly,
    record.readonly,
    catalog.readOnly,
    catalog.readonly,
    permissions.readOnly,
    permissions.readonly,
    metadata.readOnly,
    metadata.readonly
  )
  const readOnly = explicitReadOnly ?? (builtIn || Boolean(sourcePackage))
  const forkable = readBoolean(record.forkable, catalog.forkable, permissions.forkable) ?? false
  const unavailableReason = readString(
    record.unavailableReason,
    catalog.unavailableReason,
    metadata.unavailableReason
  )
  const runnable = explicitRunnable ?? !unavailableReason
  const unavailable =
    readBoolean(record.unavailable, catalog.unavailable, metadata.unavailable) ??
    (runnable === false || Boolean(unavailableReason))
  const allowedToolNames = readStringArray(
    record.allowedToolNames,
    catalog.allowedToolNames,
    permissions.allowedToolNames,
    metadata.allowedToolNames
  )
  return {
    source,
    runnable,
    readOnly,
    forkable,
    unavailable,
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(allowedToolNames !== undefined ? { allowedToolNames } : {})
  }
}

const getGraphRequiredToolNames = (graph?: MagicAgentGraphDefinition | null): string[] => {
  if (!graph) return []
  return [
    ...new Set(
      graph.nodes
        .filter((node) => node.kind === 'tool')
        .map((node) =>
          readString(
            node.toolName,
            isRecord(node.config) ? node.config.toolName : undefined,
            isRecord(node.metadata) ? node.metadata.toolName : undefined
          )
        )
        .filter((toolName): toolName is string => Boolean(toolName))
    )
  ].sort((left, right) => left.localeCompare(right))
}

const areStringArraysEqual = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const getAvailableToolNames = (
  tools: MagicAgentPlatformListToolsResp['tools'],
  names: string[]
): string[] => {
  const requested = new Set(names)
  return tools
    .filter((tool) => requested.has(tool.name) && tool.status !== 'unavailable')
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right))
}

const buildGraphSnapshot = (
  graph?: GraphListItem,
  graphDetail?: MagicAgentGraphDefinition | null
): GraphSnapshot | undefined => {
  if (!graph && !graphDetail) return undefined
  const source = graph || (graphDetail as unknown as GraphListItem)
  const catalog = getGraphCatalogMetadata(source)
  return {
    graphId: source.graphId,
    name: source.name,
    source: catalog.source,
    runnable: catalog.runnable,
    readOnly: catalog.readOnly,
    forkable: catalog.forkable,
    unavailable: catalog.unavailable,
    unavailableReason: catalog.unavailableReason,
    nodeCount: graph?.nodeCount ?? graphDetail?.nodes.length,
    channelCount: graph?.channelCount ?? graphDetail?.channels.length,
    outputCount: graph?.outputCount ?? graphDetail?.outputs.length,
    ...(graphDetail?.nodes ? { nodes: graphDetail.nodes } : {})
  }
}

const stringifySnapshot = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const AgentStudioPage: React.FC = () => {
  const [state, setState] = useState<StudioState>(emptyState)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [selectedGraphId, setSelectedGraphId] = useState('')
  const selectedGraphIdRef = useRef(selectedGraphId)
  selectedGraphIdRef.current = selectedGraphId
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
  const [selectedGraphDetail, setSelectedGraphDetail] = useState<MagicAgentGraphDefinition | null>(
    null
  )
  const [graphDetailLoading, setGraphDetailLoading] = useState(false)
  const selectedGraphCatalog = useMemo(
    () => getGraphCatalogMetadata(selectedGraph),
    [selectedGraph]
  )
  const selectedGraphRequiredToolNames = useMemo(
    () => getGraphRequiredToolNames(selectedGraphDetail),
    [selectedGraphDetail]
  )
  const selectedGraphSuggestedToolNames = useMemo(() => {
    const catalogAllowed = selectedGraphCatalog.allowedToolNames
    if (Array.isArray(catalogAllowed) && catalogAllowed.length > 0)
      return [...catalogAllowed].sort()
    return getAvailableToolNames(state.tools, selectedGraphRequiredToolNames)
  }, [selectedGraphCatalog.allowedToolNames, selectedGraphRequiredToolNames, state.tools])
  const [allowedToolNames, setAllowedToolNames] = useState<string[]>([])
  const preflightMissingToolNames = useMemo(
    () =>
      selectedGraphRequiredToolNames.filter(
        (toolName) =>
          !state.tools.some((tool) => tool.name === toolName && tool.status !== 'unavailable')
      ),
    [selectedGraphRequiredToolNames, state.tools]
  )
  const preflightUnavailableToolNames = useMemo(
    () =>
      selectedGraphRequiredToolNames.filter(
        (toolName) =>
          !allowedToolNames.includes(toolName) && !preflightMissingToolNames.includes(toolName)
      ),
    [allowedToolNames, preflightMissingToolNames, selectedGraphRequiredToolNames]
  )
  const runDisabledByToolPermissions =
    graphDetailLoading ||
    preflightMissingToolNames.length > 0 ||
    preflightUnavailableToolNames.length > 0
  const graphSnapshot = useMemo(
    () => buildGraphSnapshot(selectedGraph, selectedGraphDetail),
    [selectedGraph, selectedGraphDetail]
  )
  const activeRunGraphSnapshot = isRecord(activeRun?.metadata)
    ? activeRun.metadata.graphSnapshot
    : undefined
  const activeRunPermissionSnapshot = isRecord(activeRun?.metadata)
    ? activeRun.metadata.permissionSnapshot
    : undefined
  const permissionSnapshot = useMemo(
    () => ({
      allowedToolNames,
      requiredToolNames: selectedGraphRequiredToolNames,
      missingToolNames: preflightMissingToolNames,
      unavailableToolNames: preflightUnavailableToolNames
    }),
    [
      allowedToolNames,
      preflightMissingToolNames,
      preflightUnavailableToolNames,
      selectedGraphRequiredToolNames
    ]
  )
  const runDisabledByGraph =
    selectedGraphCatalog.unavailable || selectedGraphCatalog.runnable === false
  const outputFallback = result && !activeRun?.outputs.length ? result : ''
  const activeWatchAbortRef = useRef<(() => void) | null>(null)

  const stopActiveGraphRunWatch = useCallback(() => {
    activeWatchAbortRef.current?.()
    activeWatchAbortRef.current = null
  }, [])

  const applyGraphRunUpdate = useCallback((run: MagicAgentGraphRunRecord) => {
    setActiveRun(run)
    setSelectedGraphId(run.graphId)
    setResult(formatGraphRunText(run))
    setRunHistory((current) => upsertRunHistory(current, run))
  }, [])

  const loadGraphDetail = useCallback(async (graphId: string) => {
    const inspectGraph = api().svcMagicAgentPlatform.inspectGraph
    if (!graphId || !inspectGraph) {
      setSelectedGraphDetail(null)
      return
    }
    setGraphDetailLoading(true)
    try {
      const response = await inspectGraph({ graphId })
      setSelectedGraphDetail(response.graph || null)
    } catch {
      setSelectedGraphDetail(null)
    } finally {
      setGraphDetailLoading(false)
    }
  }, [])

  const startGraphRunWatch = useCallback(
    (runId: string) => {
      if (!runId) return
      stopActiveGraphRunWatch()
      const [abortSender, abortReceiver] = newAbortHandler()
      let aborted = false
      const abortWatch = (): void => {
        if (aborted) return
        aborted = true
        abortSender.abort()
      }
      activeWatchAbortRef.current = abortWatch

      void api()
        .svcMagicAgentPlatform.watchGraphRun(
          { runId, route: AGENT_STUDIO_ROUTE },
          {
            abortReceiver,
            onData: (event: MagicAgentGraphRunStreamEvent) => {
              if (aborted || activeWatchAbortRef.current !== abortWatch || event.runId !== runId) {
                return
              }
              if (event.run?.runId === runId) {
                applyGraphRunUpdate(event.run)
              }
              if (event.type === 'closed') {
                activeWatchAbortRef.current = null
              }
            }
          }
        )
        .catch((err) => {
          const message = getErrorMessage(err)
          if (
            !aborted &&
            activeWatchAbortRef.current === abortWatch &&
            !message.includes('was not found for this route')
          ) {
            setError(message)
          }
        })
        .finally(() => {
          if (activeWatchAbortRef.current === abortWatch) {
            activeWatchAbortRef.current = null
          }
        })
    },
    [applyGraphRunUpdate, stopActiveGraphRunWatch]
  )

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

  const loadStudio = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const status = await api().svcMagicAgentPlatform.getStatus({})
      if (!status.enabled) {
        stopActiveGraphRunWatch()
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
      const currentSelectedGraphId = selectedGraphIdRef.current
      const nextGraphId =
        currentSelectedGraphId &&
        graphs.graphs.some((graph) => graph.graphId === currentSelectedGraphId)
          ? currentSelectedGraphId
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
  }, [stopActiveGraphRunWatch])

  useEffect(() => {
    void loadStudio()
  }, [loadStudio])

  useEffect(() => () => stopActiveGraphRunWatch(), [stopActiveGraphRunWatch])

  useEffect(() => {
    if (!platformEnabled || !selectedGraphId) {
      setSelectedGraphDetail(null)
      setGraphDetailLoading(false)
      return
    }
    void loadGraphDetail(selectedGraphId)
  }, [loadGraphDetail, platformEnabled, selectedGraphId])

  useEffect(() => {
    setAllowedToolNames((current) =>
      areStringArraysEqual(current, selectedGraphSuggestedToolNames)
        ? current
        : selectedGraphSuggestedToolNames
    )
  }, [selectedGraphSuggestedToolNames])

  const setToolAllowed = (toolName: string, checked: boolean) => {
    setAllowedToolNames((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(toolName)
      } else {
        next.delete(toolName)
      }
      return selectedGraphSuggestedToolNames.filter((suggestedToolName) =>
        next.has(suggestedToolName)
      )
    })
  }

  const handleGraphChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const graphId = event.target.value
    stopActiveGraphRunWatch()
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
    if (!selectedGraphId || !input || runDisabledByGraph || runDisabledByToolPermissions) return

    setRunning(true)
    setError(null)
    try {
      const runId = createAgentStudioGraphRunId()
      const runPromise = api().svcMagicAgentPlatform.runGraph({
        runId,
        graphId: selectedGraphId,
        input,
        route: AGENT_STUDIO_ROUTE,
        ...(allowedToolNames.length ? { allowedToolNames } : {}),
        metadata: {
          source: 'agent-studio',
          graphSnapshot,
          permissionSnapshot
        }
      })
      startGraphRunWatch(runId)
      const response = await runPromise
      applyGraphRunUpdate(response)
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
      applyGraphRunUpdate(response.run)
      if (isGraphRunCancellable(response.run)) {
        startGraphRunWatch(response.run.runId)
      } else {
        stopActiveGraphRunWatch()
      }
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
        applyGraphRunUpdate(response.run)
        if (!isGraphRunCancellable(response.run)) {
          stopActiveGraphRunWatch()
        }
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
                      running ||
                      loading ||
                      !platformEnabled ||
                      !selectedGraphId ||
                      !prompt.trim() ||
                      runDisabledByGraph ||
                      runDisabledByToolPermissions
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
              {selectedGraphRequiredToolNames.length > 0 || graphDetailLoading ? (
                <Box>
                  <Typography variant="subtitle2">Tool permissions</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    Agent Studio sends an explicit per-run tool allowlist for graphs that invoke
                    tools.
                  </Typography>
                  {graphDetailLoading ? (
                    <Typography variant="body2" color="text.secondary">
                      Loading graph permissions...
                    </Typography>
                  ) : null}
                  {preflightMissingToolNames.length > 0 ? (
                    <Alert severity="warning" sx={{ mb: 1 }}>
                      Missing platform tools: {preflightMissingToolNames.join(', ')}
                    </Alert>
                  ) : null}
                  {preflightUnavailableToolNames.length > 0 ? (
                    <Alert severity="warning" sx={{ mb: 1 }}>
                      Allow required tools before running:{' '}
                      {preflightUnavailableToolNames.join(', ')}
                    </Alert>
                  ) : null}
                  {selectedGraphSuggestedToolNames.length > 0 ? (
                    <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                      {selectedGraphSuggestedToolNames.map((toolName) => (
                        <FormControlLabel
                          key={toolName}
                          control={
                            <Checkbox
                              size="small"
                              checked={allowedToolNames.includes(toolName)}
                              onChange={(event) => setToolAllowed(toolName, event.target.checked)}
                              disabled={running || loading || !platformEnabled}
                            />
                          }
                          label={toolName}
                        />
                      ))}
                    </Stack>
                  ) : null}
                </Box>
              ) : null}
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
