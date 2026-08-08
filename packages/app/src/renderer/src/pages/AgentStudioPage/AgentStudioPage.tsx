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
import { GraphV2Canvas } from './GraphV2Canvas'
import { M6TopologyPanel } from './M6TopologyPanel'
import { M6RendererManagementPanel } from './M6RendererManagementPanel'
import { M5OperationsPanel } from './M5OperationsPanel'
import { SessionExportComparePanel } from './SessionExportComparePanel'
import { SemanticMemoryPanel } from './SemanticMemoryPanel'
import type {
  MagicAgentPlatformAgentDefinition,
  MagicAgentPlatformDriveResource,
  MagicAgentPlatformGraphListResp,
  MagicAgentPlatformListToolsResp,
  MagicAgentPlatformPackageListResp,
  MagicAgentPlatformRuntimeGraphTopologyResp,
  MagicAgentPlatformStatusResp,
  MagicAgentPlatformTriggerResource
} from '@shared/api/svcMagicAgentPlatform'
import {
  validateGraphDefinitionV2Draft,
  type GraphDefinitionV2Draft,
  type GraphV2NodeDescriptor
} from '@shared/magicAgentPlatform2'
import type {
  MagicAgentGraphDefinition,
  MagicAgentGraphNodeDefinition,
  MagicAgentGraphRunPublicEvent,
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
const ATTACH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const
const ATTACH_STALE_AFTER_MS = 30_000
const NODE_PREVIEW_MAX_CHARS = 2_000

const durableNodePreview = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const redacted = value.replace(
    /\b(api[-_]?key|authorization|password|secret|token)\b\s*[:=]\s*[^\s,;}]+/gi,
    '$1=[redacted]'
  )
  return redacted.length <= NODE_PREVIEW_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, NODE_PREVIEW_MAX_CHARS)}…[truncated]`
}

type GraphRunAttachStatus = 'connecting' | 'live' | 'stale' | 'retrying' | 'ended' | 'failed'

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
  pausing: 'warning',
  paused: 'warning',
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
  triggers: readonly MagicAgentPlatformTriggerResource[]
  drives: readonly MagicAgentPlatformDriveResource[]
}

const emptyState: StudioState = {
  agents: [],
  tools: [],
  graphs: [],
  packages: [],
  triggers: [],
  drives: []
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isPermanentAttachError = (error: unknown): boolean => {
  const visited = new Set<unknown>()
  const inspect = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object' || visited.has(value)) return false
    visited.add(value)
    const record = value as RecordLike
    for (const key of ['status', 'statusCode', 'httpStatus', 'code']) {
      const code = record[key]
      if (
        code === 401 ||
        code === 403 ||
        code === 404 ||
        code === '401' ||
        code === '403' ||
        code === '404'
      )
        return true
    }
    return inspect(record.cause) || inspect(record.error)
  }
  return inspect(error)
}

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

const summarizePublicPayload = (payload: Record<string, unknown>): string => {
  const sensitiveKey = /authorization|cookie|credential|password|secret|token/i
  const parts = Object.entries(payload)
    .slice(0, 6)
    .flatMap(([key, value]) => {
      if (sensitiveKey.test(key)) return [`${key}: [redacted]`]
      if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        return [`${key}: ${String(value)}`]
      }
      if (typeof value === 'string') {
        return [`${key}: ${value.length > 120 ? `${value.slice(0, 117)}…` : value}`]
      }
      if (Array.isArray(value)) return [`${key}: [${value.length} items]`]
      if (isRecord(value)) return [`${key}: {…}`]
      return []
    })
  return parts.length ? parts.join(' · ') : 'No public payload'
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
  const [runTimeline, setRunTimeline] = useState<MagicAgentGraphRunPublicEvent[]>([])
  const [attachStatus, setAttachStatus] = useState<GraphRunAttachStatus>('ended')
  const [lastAttachEventAt, setLastAttachEventAt] = useState<number>()
  const [runHistory, setRunHistory] = useState<MagicAgentGraphRunRecord[]>([])
  const [refreshingRunId, setRefreshingRunId] = useState<string | null>(null)
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null)
  const [steeringRunId, setSteeringRunId] = useState<string | null>(null)
  const [pendingInputValue, setPendingInputValue] = useState('')
  const [pendingInputAction, setPendingInputAction] = useState<'inject' | 'edit' | 'cancel' | null>(
    null
  )
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [opsLoading, setOpsLoading] = useState(false)
  const [opsAction, setOpsAction] = useState<string | null>(null)

  const platformEnabled = Boolean(state.status?.enabled)
  const loadOperations = useCallback(async () => {
    setOpsLoading(true)
    try {
      const [triggers, drives] = await Promise.all([
        api().svcMagicAgentPlatform.listTriggers({}),
        api().svcMagicAgentPlatform.listDrives({})
      ])
      setState((current) => ({ ...current, triggers: triggers.triggers, drives: drives.drives }))
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setOpsLoading(false)
    }
  }, [])
  const triggerAction = async (
    trigger: MagicAgentPlatformTriggerResource,
    action: 'enable' | 'disable' | 'pause' | 'resume' | 'retry' | 'manualFire'
  ) => {
    setOpsAction(`${action}:${trigger.id}`)
    const base = {
      triggerId: trigger.id,
      expectedTriggerRevision: trigger.revision,
      idempotencyKey: `agent-studio-${action}-${trigger.id}-${Date.now()}`,
      requestedAt: Date.now()
    }
    try {
      const svc = api().svcMagicAgentPlatform
      if (action === 'manualFire')
        await svc.manualFireTrigger({ ...base, occurrenceId: `manual-${Date.now()}` })
      else await svc[`${action}Trigger` as 'enableTrigger'](base)
      await loadOperations()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setOpsAction(null)
    }
  }
  const selectedGraph = useMemo(
    () => state.graphs.find((graph) => graph.graphId === selectedGraphId),
    [selectedGraphId, state.graphs]
  )
  const [selectedGraphDetail, setSelectedGraphDetail] = useState<MagicAgentGraphDefinition | null>(
    null
  )
  const [selectedGraphV2, setSelectedGraphV2] = useState<GraphDefinitionV2Draft | undefined>(
    undefined
  )
  const [graphV2DraftText, setGraphV2DraftText] = useState('')
  const [savingGraphV2, setSavingGraphV2] = useState(false)
  const [publishingGraphV2, setPublishingGraphV2] = useState(false)
  const [publishedGraphVersions, setPublishedGraphVersions] = useState<GraphDefinitionV2Draft[]>([])
  const [graphV2NodeRegistryCount, setGraphV2NodeRegistryCount] = useState(0)
  const [graphV2NodeDescriptors, setGraphV2NodeDescriptors] = useState<
    readonly GraphV2NodeDescriptor[]
  >([])
  const [selectedGraphV2NodeId, setSelectedGraphV2NodeId] = useState<string>()
  const [graphV2Issues, setGraphV2Issues] = useState<Readonly<Record<string, readonly string[]>>>(
    {}
  )
  const [runtimeTopology, setRuntimeTopology] =
    useState<MagicAgentPlatformRuntimeGraphTopologyResp>()
  const [runtimeTopologyError, setRuntimeTopologyError] = useState<string>()
  useEffect(() => {
    let cancelled = false
    if (!activeRun?.runId || !platformEnabled) {
      setRuntimeTopology(undefined)
      setRuntimeTopologyError(undefined)
      return () => {
        cancelled = true
      }
    }
    const getRuntimeGraphTopology = api().svcMagicAgentPlatform.getRuntimeGraphTopology
    if (typeof getRuntimeGraphTopology !== 'function') {
      setRuntimeTopology(undefined)
      setRuntimeTopologyError('Runtime topology service is unavailable.')
      return () => {
        cancelled = true
      }
    }
    setRuntimeTopologyError(undefined)
    void getRuntimeGraphTopology({
      runId: activeRun.runId,
      route: AGENT_STUDIO_ROUTE
    })
      .then((snapshot) => {
        if (!cancelled) {
          setRuntimeTopology(snapshot)
          setRuntimeTopologyError(undefined)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRuntimeTopology(undefined)
          setRuntimeTopologyError(getErrorMessage(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    activeRun?.runId,
    activeRun?.updatedAt,
    activeRun?.runtimeTopology?.revision,
    platformEnabled
  ])
  const nodePreviews = useMemo(
    () =>
      Object.fromEntries(
        (activeRun?.nodes ?? []).map((node) => [
          node.nodeId,
          {
            input: durableNodePreview(node.input) ?? null,
            output: durableNodePreview(node.output) ?? null
          }
        ])
      ),
    [activeRun]
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
  const activeAttachAbortRef = useRef<(() => void) | null>(null)
  const attachedRunIdRef = useRef<string | null>(null)
  const activeRunRef = useRef(activeRun)
  activeRunRef.current = activeRun
  const attachGenerationRef = useRef(0)
  const attachRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attachStaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timelineByRunRef = useRef(new Map<string, MagicAgentGraphRunPublicEvent[]>())
  const cursorByRunRef = useRef(new Map<string, string>())

  const stopActiveGraphRunWatch = useCallback(() => {
    activeWatchAbortRef.current?.()
    activeWatchAbortRef.current = null
  }, [])

  const stopActiveGraphRunAttach = useCallback(() => {
    attachGenerationRef.current += 1
    if (attachRetryTimerRef.current) clearTimeout(attachRetryTimerRef.current)
    if (attachStaleTimerRef.current) clearTimeout(attachStaleTimerRef.current)
    attachRetryTimerRef.current = null
    attachStaleTimerRef.current = null
    activeAttachAbortRef.current?.()
    activeAttachAbortRef.current = null
    attachedRunIdRef.current = null
  }, [])

  const startGraphRunAttach = useCallback(
    (runId: string) => {
      if (!runId || attachedRunIdRef.current === runId) return
      stopActiveGraphRunAttach()
      setRunTimeline(timelineByRunRef.current.get(runId) || [])
      setLastAttachEventAt(undefined)
      const generation = attachGenerationRef.current
      let retryIndex = 0

      const clearStaleTimer = (): void => {
        if (attachStaleTimerRef.current) clearTimeout(attachStaleTimerRef.current)
        attachStaleTimerRef.current = null
      }
      const armStaleTimer = (): void => {
        clearStaleTimer()
        attachStaleTimerRef.current = setTimeout(() => {
          if (attachGenerationRef.current === generation && attachedRunIdRef.current === runId)
            setAttachStatus('stale')
        }, ATTACH_STALE_AFTER_MS)
      }
      const runIsTerminal = (): boolean => {
        const run = activeRunRef.current
        return Boolean(run?.runId === runId && terminalGraphRunStatuses.has(run.status))
      }
      const attemptAttach = (): void => {
        if (attachGenerationRef.current !== generation || attachedRunIdRef.current !== runId) return
        setAttachStatus('connecting')
        armStaleTimer()
        const [abortSender, abortReceiver] = newAbortHandler()
        let aborted = false
        const abortAttach = (): void => {
          if (aborted) return
          aborted = true
          abortSender.abort()
        }
        activeAttachAbortRef.current = abortAttach
        const afterEventId = cursorByRunRef.current.get(runId)

        void api()
          .svcMagicAgentPlatform.attachGraphRun(
            { runId, route: AGENT_STUDIO_ROUTE, ...(afterEventId ? { afterEventId } : {}) },
            {
              abortReceiver,
              onData: (event: MagicAgentGraphRunPublicEvent) => {
                if (
                  aborted ||
                  attachGenerationRef.current !== generation ||
                  activeAttachAbortRef.current !== abortAttach ||
                  event.runId !== runId
                )
                  return
                const current = timelineByRunRef.current.get(runId) || []
                if (
                  current.some(
                    (item) => item.eventId === event.eventId || item.sequence === event.sequence
                  )
                )
                  return
                const next = [...current, event].sort(
                  (left, right) =>
                    left.sequence - right.sequence || left.timestamp - right.timestamp
                )
                timelineByRunRef.current.set(runId, next)
                const lastEvent = next[next.length - 1]
                if (lastEvent) cursorByRunRef.current.set(runId, lastEvent.eventId)
                retryIndex = 0
                setLastAttachEventAt(event.timestamp)
                setAttachStatus('live')
                armStaleTimer()
                setRunTimeline(next)
              }
            }
          )
          .then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error })
          )
          .then(({ error }) => {
            if (
              aborted ||
              attachGenerationRef.current !== generation ||
              activeAttachAbortRef.current !== abortAttach
            )
              return
            activeAttachAbortRef.current = null
            clearStaleTimer()
            if (runIsTerminal()) {
              attachedRunIdRef.current = null
              setAttachStatus('ended')
              return
            }
            if (error !== undefined && isPermanentAttachError(error)) {
              attachedRunIdRef.current = null
              setAttachStatus('failed')
              setError(getErrorMessage(error))
              return
            }
            const delay =
              ATTACH_RETRY_DELAYS_MS[Math.min(retryIndex, ATTACH_RETRY_DELAYS_MS.length - 1)]
            retryIndex += 1
            setAttachStatus('retrying')
            attachRetryTimerRef.current = setTimeout(() => {
              attachRetryTimerRef.current = null
              if (attachGenerationRef.current !== generation || runIsTerminal()) {
                if (attachGenerationRef.current === generation) {
                  attachedRunIdRef.current = null
                  setAttachStatus('ended')
                }
                return
              }
              attemptAttach()
            }, delay)
          })
      }

      attachedRunIdRef.current = runId
      attemptAttach()
    },
    [stopActiveGraphRunAttach]
  )

  const applyGraphRunUpdate = useCallback((run: MagicAgentGraphRunRecord) => {
    activeRunRef.current = run
    setActiveRun(run)
    setSelectedGraphId(run.graphId)
    setResult(formatGraphRunText(run))
    setRunHistory((current) => upsertRunHistory(current, run))
  }, [])

  const loadGraphDetail = useCallback(async (graphId: string) => {
    const inspectGraph = api().svcMagicAgentPlatform.inspectGraph
    const getGraphV2 = api().svcMagicAgentPlatform.getGraphV2
    const listPublishedGraphsV2 = api().svcMagicAgentPlatform.listPublishedGraphsV2
    const listGraphV2NodeRegistry = api().svcMagicAgentPlatform.listGraphV2NodeRegistry
    if (!graphId || !inspectGraph) {
      setSelectedGraphDetail(null)
      setSelectedGraphV2(undefined)
      setGraphV2DraftText('')
      return
    }
    setGraphDetailLoading(true)
    try {
      const [response, v2Response, publishedResponse, registryResponse] = await Promise.all([
        inspectGraph({ graphId }),
        getGraphV2
          ? getGraphV2({ graphId, route: AGENT_STUDIO_ROUTE })
          : Promise.resolve({ definitionV2: undefined }),
        listPublishedGraphsV2
          ? listPublishedGraphsV2({ graphId, route: AGENT_STUDIO_ROUTE })
          : Promise.resolve({ definitionsV2: [] }),
        listGraphV2NodeRegistry ? listGraphV2NodeRegistry({}) : Promise.resolve({ descriptors: [] })
      ])
      setSelectedGraphDetail(response.graph || null)
      setSelectedGraphV2(v2Response.definitionV2)
      setPublishedGraphVersions([...publishedResponse.definitionsV2])
      setGraphV2NodeRegistryCount(registryResponse.descriptors.length)
      setGraphV2NodeDescriptors(registryResponse.descriptors)
      setGraphV2DraftText(
        v2Response.definitionV2 ? JSON.stringify(v2Response.definitionV2, null, 2) : ''
      )
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
        stopActiveGraphRunAttach()
        setState({ ...emptyState, status })
        setSelectedGraphId('')
        setActiveRun(null)
        setRunHistory([])
        setResult(MAGIC_AGENT_FLAG_HELP)
        return
      }

      const [agents, tools, graphs, packages, triggers, drives] = await Promise.all([
        api().svcMagicAgentPlatform.listAgents({}),
        api().svcMagicAgentPlatform.listTools({}),
        api().svcMagicAgentPlatform.listGraphs({}),
        api().svcMagicAgentPlatform.listPackages({}),
        api().svcMagicAgentPlatform.listTriggers({}),
        api().svcMagicAgentPlatform.listDrives({})
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
        packages: packages.packages,
        triggers: triggers.triggers,
        drives: drives.drives
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
  }, [stopActiveGraphRunAttach, stopActiveGraphRunWatch])

  useEffect(() => {
    void loadStudio()
  }, [loadStudio])

  useEffect(
    () => () => {
      stopActiveGraphRunWatch()
      stopActiveGraphRunAttach()
    },
    [stopActiveGraphRunAttach, stopActiveGraphRunWatch]
  )

  useEffect(() => {
    if (!platformEnabled || !activeRun?.runId) {
      stopActiveGraphRunAttach()
      setAttachStatus('ended')
      setLastAttachEventAt(undefined)
      setRunTimeline([])
      return
    }
    startGraphRunAttach(activeRun.runId)
  }, [activeRun?.runId, platformEnabled, startGraphRunAttach, stopActiveGraphRunAttach])

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
    stopActiveGraphRunAttach()
    setSelectedGraphId(graphId)
    setActiveRun(null)
    setRunTimeline([])
    setResult('')
    setError(null)
    void refreshGraphRuns(graphId)
  }

  const preflightGraphV2 = async (): Promise<boolean> => {
    if (!selectedGraphV2 || !selectedGraphId) return false
    const validation = validateGraphDefinitionV2Draft(selectedGraphV2)
    const localized: Record<string, string[]> = {}
    for (const issue of validation.issues) {
      const match = issue.path.match(/nodes\[(\d+)\]/)
      const node = match ? selectedGraphV2.nodes[Number(match[1])] : undefined
      const key = node?.nodeId ?? '$graph'
      localized[key] = [...(localized[key] ?? []), `${issue.path}: ${issue.message}`]
    }
    try {
      const response = await api().svcMagicAgentPlatform.preflightGraphRun({
        graphId: selectedGraphId,
        route: AGENT_STUDIO_ROUTE,
        ...(allowedToolNames.length ? { allowedToolNames } : {})
      })
      for (const issue of response.preflight.issues) {
        const nodeId = typeof issue.nodeId === 'string' ? issue.nodeId : '$graph'
        localized[nodeId] = [...(localized[nodeId] ?? []), issue.message]
      }
      setGraphV2Issues(localized)
      const ok = validation.valid && response.preflight.safeToRun
      setResult(
        ok
          ? 'Preflight passed. Graph is safe to run.'
          : 'Preflight failed. Select highlighted nodes for details.'
      )
      return ok
    } catch (error) {
      setGraphV2Issues({ $graph: [getErrorMessage(error)] })
      setError(getErrorMessage(error))
      return false
    }
  }

  const saveGraphV2Draft = async () => {
    const saveGraphV2 = api().svcMagicAgentPlatform.saveGraphV2
    if (!saveGraphV2 || !selectedGraphId || !graphV2DraftText.trim()) return
    setSavingGraphV2(true)
    try {
      const definitionV2 = JSON.parse(graphV2DraftText) as GraphDefinitionV2Draft
      const response = await saveGraphV2({
        graph: definitionV2,
        route: AGENT_STUDIO_ROUTE,
        replace: true
      })
      setSelectedGraphDetail(response.graph)
      setSelectedGraphV2(response.definitionV2)
      setGraphV2DraftText(JSON.stringify(response.definitionV2, null, 2))
      setResult(`Saved Graph V2 ${response.graph.graphId}.`)
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingGraphV2(false)
    }
  }

  const publishGraphV2Draft = async () => {
    const publishGraphV2 = api().svcMagicAgentPlatform.publishGraphV2
    const listPublishedGraphsV2 = api().svcMagicAgentPlatform.listPublishedGraphsV2
    if (!publishGraphV2 || !selectedGraphId) return
    setPublishingGraphV2(true)
    try {
      const response = await publishGraphV2({ graphId: selectedGraphId, route: AGENT_STUDIO_ROUTE })
      setSelectedGraphV2(response.definitionV2)
      setGraphV2DraftText(JSON.stringify(response.definitionV2, null, 2))
      const listed = listPublishedGraphsV2
        ? await listPublishedGraphsV2({ graphId: selectedGraphId, route: AGENT_STUDIO_ROUTE })
        : { definitionsV2: [response.definitionV2] }
      setPublishedGraphVersions([...listed.definitionsV2])
      setResult(`Published Graph V2 ${selectedGraphId} version ${response.definitionV2.version}.`)
    } catch (error) {
      setResult(getErrorMessage(error))
    } finally {
      setPublishingGraphV2(false)
    }
  }

  const loadPublishedGraphV2 = async (version: string) => {
    const getPublishedGraphV2 = api().svcMagicAgentPlatform.getPublishedGraphV2
    if (!getPublishedGraphV2 || !selectedGraphId) return
    try {
      const response = await getPublishedGraphV2({
        graphId: selectedGraphId,
        route: AGENT_STUDIO_ROUTE,
        version
      })
      if (!response.definitionV2) return
      setSelectedGraphV2(response.definitionV2)
      setGraphV2DraftText(JSON.stringify(response.definitionV2, null, 2))
      setResult(`Loaded published Graph V2 version ${version}.`)
    } catch (error) {
      setResult(getErrorMessage(error))
    }
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
        ...(selectedGraphV2 ? { definitionV2: selectedGraphV2 } : {}),
        metadata: {
          source: 'agent-studio',
          graphSnapshot,
          permissionSnapshot
        }
      })
      startGraphRunWatch(runId)
      startGraphRunAttach(runId)
      const response = await runPromise
      applyGraphRunUpdate(response)
      await refreshGraphRuns(response.graphId)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setRunning(false)
    }
  }

  const runGraphFromCanvasNode = async (nodeId: string, mode: 'single-node' | 'run-from-node') => {
    const input = prompt.trim()
    if (!platformEnabled) {
      setResult(MAGIC_AGENT_FLAG_HELP)
      return
    }
    if (!selectedGraphId || !input || runDisabledByGraph || runDisabledByToolPermissions) {
      if (!input) setError('Enter an explicit input before testing a node.')
      return
    }

    const requiresPriorRun =
      mode === 'run-from-node' &&
      Boolean(selectedGraphDetail?.channels.some((channel) => channel.to === nodeId))
    const priorRunId =
      requiresPriorRun && activeRun?.graphId === selectedGraphId ? activeRun.runId : undefined
    if (requiresPriorRun && !priorRunId) {
      setError('Select a prior durable run before running from this node.')
      return
    }

    setRunning(true)
    setError(null)
    try {
      const runId = createAgentStudioGraphRunId()
      const nodeExecution =
        mode === 'single-node'
          ? { mode, nodeId, inputs: { input } }
          : { mode, nodeId, ...(priorRunId ? { priorRunId } : {}) }
      const runPromise = api().svcMagicAgentPlatform.runGraph({
        runId,
        graphId: selectedGraphId,
        input,
        route: AGENT_STUDIO_ROUTE,
        nodeExecution,
        ...(allowedToolNames.length ? { allowedToolNames } : {}),
        ...(selectedGraphV2 ? { definitionV2: selectedGraphV2 } : {}),
        metadata: {
          source: 'agent-studio-node-execution',
          graphSnapshot,
          permissionSnapshot
        }
      })
      startGraphRunWatch(runId)
      startGraphRunAttach(runId)
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

  const steerGraphRun = async (runId: string, action: 'pause' | 'resume') => {
    if (!platformEnabled) {
      setResult(MAGIC_AGENT_FLAG_HELP)
      return
    }
    setSteeringRunId(runId)
    setError(null)
    try {
      const request = { runId, route: AGENT_STUDIO_ROUTE }
      const result =
        action === 'pause'
          ? await api().svcMagicAgentPlatform.pauseGraphRun(request)
          : await api().svcMagicAgentPlatform.resumeGraphRun(request)
      if (result.error) setError(result.error)
      const response = await api().svcMagicAgentPlatform.getGraphRun(request)
      if (response.run) {
        applyGraphRunUpdate(response.run)
        await refreshGraphRuns(response.run.graphId)
      }
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSteeringRunId(null)
    }
  }

  const mutatePendingInput = async (action: 'inject' | 'edit' | 'cancel') => {
    const pendingInput = activeRun?.pendingInput
    if (!activeRun || !pendingInput) return
    setPendingInputAction(action)
    setError(null)
    try {
      const request = {
        runId: activeRun.runId,
        route: AGENT_STUDIO_ROUTE,
        pendingInputId: pendingInput.pendingInputId,
        expectedRevision: pendingInput.revision,
        idempotencyKey: `agent-studio-input-${action}-${pendingInput.pendingInputId}-${pendingInput.revision}`
      }
      if (action === 'inject') {
        await api().svcMagicAgentPlatform.injectPendingInput({
          ...request,
          value: pendingInputValue
        })
      } else if (action === 'edit') {
        await api().svcMagicAgentPlatform.editPendingInput({
          ...request,
          value: pendingInputValue
        })
      } else {
        await api().svcMagicAgentPlatform.cancelPendingInput(request)
      }
      await refreshGraphRun(activeRun.runId)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setPendingInputAction(null)
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
        {runtimeTopologyError ? (
          <Alert severity="error" data-testid="runtime-topology-error">
            Failed to load runtime topology: {runtimeTopologyError}
          </Alert>
        ) : null}
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

        <M6TopologyPanel />
        <M6RendererManagementPanel />
        <M5OperationsPanel />
        <SessionExportComparePanel />
        <SemanticMemoryPanel />

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
                  {activeRun?.status === 'running' ? (
                    <Button
                      variant="outlined"
                      onClick={() => void steerGraphRun(activeRun.runId, 'pause')}
                      disabled={steeringRunId === activeRun.runId || !platformEnabled}
                    >
                      Pause Active Run
                    </Button>
                  ) : null}
                  {activeRun?.status === 'paused' ? (
                    <Button
                      variant="outlined"
                      onClick={() => void steerGraphRun(activeRun.runId, 'resume')}
                      disabled={steeringRunId === activeRun.runId || !platformEnabled}
                    >
                      Resume Active Run
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
              {selectedGraphV2 ? (
                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={1.5}>
                      <Stack
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        flexWrap="wrap"
                        useFlexGap
                      >
                        <Typography variant="subtitle2">Graph V2 visual canvas</Typography>
                        <Chip size="small" label={`registry ${graphV2NodeRegistryCount}`} />
                        <Chip
                          size="small"
                          label={`${publishedGraphVersions.length} published`}
                          color={publishedGraphVersions.length ? 'success' : 'warning'}
                        />
                        <Button size="small" onClick={() => void preflightGraphV2()}>
                          Preflight
                        </Button>
                        <Button
                          size="small"
                          onClick={() => void publishGraphV2Draft()}
                          disabled={publishingGraphV2 || savingGraphV2}
                        >
                          {publishingGraphV2 ? 'Publishing…' : 'Publish'}
                        </Button>
                        {publishedGraphVersions.map((definition) => (
                          <Button
                            key={definition.version}
                            size="small"
                            onClick={() => void loadPublishedGraphV2(definition.version)}
                          >
                            Load {definition.version}
                          </Button>
                        ))}
                      </Stack>
                      {graphV2Issues.$graph?.map((issue) => (
                        <Alert key={issue} severity="error">
                          {issue}
                        </Alert>
                      ))}
                      <GraphV2Canvas
                        definition={selectedGraphV2}
                        nodeDescriptors={graphV2NodeDescriptors}
                        selectedNodeId={selectedGraphV2NodeId}
                        onSelectNode={setSelectedGraphV2NodeId}
                        localizedErrors={graphV2Issues}
                        runtimeTopology={runtimeTopology}
                        nodePreviews={nodePreviews}
                        onTestNode={(nodeId) => void runGraphFromCanvasNode(nodeId, 'single-node')}
                        onRunFromNode={(nodeId) =>
                          void runGraphFromCanvasNode(nodeId, 'run-from-node')
                        }
                        onChange={(definition) => {
                          setGraphV2Issues({})
                          setSelectedGraphV2(definition)
                          setGraphV2DraftText(JSON.stringify(definition, null, 2))
                        }}
                      />
                    </Stack>
                  </CardContent>
                </Card>
              ) : null}
              {selectedGraphV2 ? (
                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={1.5}>
                      <Typography variant="subtitle2">Graph V2 authoring document</Typography>
                      <TextField
                        label="Graph V2 JSON"
                        multiline
                        minRows={10}
                        value={graphV2DraftText}
                        onChange={(event) => setGraphV2DraftText(event.target.value)}
                        fullWidth
                        inputProps={{ 'aria-label': 'Graph V2 JSON' }}
                      />
                      <Button
                        variant="contained"
                        onClick={() => void saveGraphV2Draft()}
                        disabled={savingGraphV2 || !graphV2DraftText.trim()}
                      >
                        {savingGraphV2 ? 'Saving Graph V2…' : 'Save Graph V2'}
                      </Button>
                    </Stack>
                  </CardContent>
                </Card>
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
                    {activeRun.pendingInput ? (
                      <Stack spacing={1.25} sx={{ mt: 1 }}>
                        <Divider />
                        <Typography variant="subtitle2">Pending input</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {activeRun.pendingInput.pendingInputId} · node{' '}
                          {activeRun.pendingInput.nodeId} · revision{' '}
                          {activeRun.pendingInput.revision} · {activeRun.pendingInput.status}
                        </Typography>
                        <TextField
                          label="Pending input value"
                          value={pendingInputValue}
                          onChange={(event) => setPendingInputValue(event.target.value)}
                          multiline
                          minRows={2}
                          size="small"
                        />
                        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                          <Button
                            variant="contained"
                            size="small"
                            disabled={!pendingInputValue || pendingInputAction !== null}
                            onClick={() => void mutatePendingInput('inject')}
                          >
                            Inject
                          </Button>
                          <Button
                            variant="outlined"
                            size="small"
                            disabled={!pendingInputValue || pendingInputAction !== null}
                            onClick={() => void mutatePendingInput('edit')}
                          >
                            Edit
                          </Button>
                          <Button
                            color="warning"
                            size="small"
                            disabled={pendingInputAction !== null}
                            onClick={() => void mutatePendingInput('cancel')}
                          >
                            Cancel input
                          </Button>
                        </Stack>
                      </Stack>
                    ) : null}
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
                  direction={{ xs: 'column', sm: 'row' }}
                  justifyContent="space-between"
                  alignItems={{ xs: 'flex-start', sm: 'center' }}
                  spacing={1}
                >
                  <Typography variant="h6">Event Timeline</Typography>
                  <Stack
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    flexWrap="wrap"
                    useFlexGap
                    role="status"
                    aria-live="polite"
                    aria-label={`Event timeline connection ${attachStatus}`}
                  >
                    <Chip
                      size="small"
                      variant="outlined"
                      color={
                        attachStatus === 'live'
                          ? 'success'
                          : attachStatus === 'stale' || attachStatus === 'retrying'
                            ? 'warning'
                            : attachStatus === 'failed'
                              ? 'error'
                              : 'default'
                      }
                      label={`Client status: ${attachStatus}`}
                    />
                    <Typography variant="caption" color="text.secondary">
                      Last event: {formatTimestamp(lastAttachEventAt)}
                    </Typography>
                  </Stack>
                </Stack>
                <Divider sx={{ my: 1 }} />
                {activeRun && runTimeline.length ? (
                  <Stack spacing={0.75} aria-label="Graph run event timeline">
                    {runTimeline.map((event) => (
                      <Box
                        key={event.eventId}
                        data-testid={`timeline-event-${event.eventId}`}
                        sx={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 1 }}
                      >
                        <Typography variant="caption" fontWeight={700}>
                          {event.sequence}
                        </Typography>
                        <Box>
                          <Typography variant="caption" fontWeight={600}>
                            {event.kind} · {formatTimestamp(event.timestamp)}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" display="block">
                            {summarizePublicPayload(event.payload)}
                          </Typography>
                        </Box>
                      </Box>
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    No durable run events received yet.
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12 }}>
            <Card>
              <CardContent>
                <Stack spacing={2}>
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
                </Stack>
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
        </Grid>

        <Grid container spacing={2}>
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

        <Card>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="h6">Trigger & Drive Operations</Typography>
              <Button size="small" onClick={() => void loadOperations()} disabled={opsLoading}>
                Refresh Operations
              </Button>
            </Stack>
            <Divider sx={{ my: 1 }} />
            <Typography variant="subtitle2">Triggers</Typography>
            <Stack spacing={1} sx={{ mt: 1 }}>
              {state.triggers.map((trigger) => {
                const record = isRecord(trigger.state) ? trigger.state : {}
                return (
                  <Stack
                    key={trigger.id}
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    flexWrap="wrap"
                  >
                    <Typography fontWeight={600}>
                      {readString(record.title, record.name) || trigger.id}
                    </Typography>
                    <Chip size="small" label={readString(record.status) || 'unknown'} />
                    {(['enable', 'disable', 'pause', 'resume', 'retry', 'manualFire'] as const).map(
                      (action) => (
                        <Button
                          key={action}
                          size="small"
                          disabled={opsAction !== null}
                          onClick={() => void triggerAction(trigger, action)}
                        >
                          {action === 'manualFire' ? 'manual fire' : action}
                        </Button>
                      )
                    )}
                  </Stack>
                )
              })}
            </Stack>
            <Divider sx={{ my: 1 }} />
            <Typography variant="subtitle2">Drives</Typography>
            <Stack spacing={1} sx={{ mt: 1 }}>
              {state.drives.map((drive) => {
                const record = isRecord(drive.state) ? drive.state : {}
                const delivery = isRecord(record.delivery) ? record.delivery : {}
                return (
                  <Box key={drive.id}>
                    <Typography fontWeight={600}>
                      {readString(record.title, record.name) || drive.id}{' '}
                      <Chip size="small" label={readString(record.status) || 'unknown'} />
                    </Typography>
                    <Typography variant="caption">
                      {drive.id} · priority {String(record.priority ?? '—')} · delivery{' '}
                      {stringifySnapshot(delivery)}
                    </Typography>
                  </Box>
                )
              })}
            </Stack>
          </CardContent>
        </Card>
      </Stack>
    </Box>
  )
}

export default AgentStudioPage
