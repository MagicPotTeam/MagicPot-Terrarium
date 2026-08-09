import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Add, FitScreen, Remove } from '@mui/icons-material'
import type { MagicAgentPlatformRuntimeGraphTopologyResp } from '@shared/api/svcMagicAgentPlatform'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import {
  type GraphV2NodeDescriptor,
  type GraphDefinitionV2Draft,
  type GraphEdgeV2,
  type GraphJsonValue,
  type GraphNodeV2,
  type GraphPortV2,
  type GraphRuntimeTopologySnapshotV2
} from '@shared/magicAgentPlatform2'

const PORT_COLOR: Record<string, string> = {
  control: '#8b5cf6',
  data: '#0ea5e9',
  message: '#10b981',
  artifact: '#f59e0b',
  error: '#ef4444',
  lifecycle: '#64748b'
}

const OFFLINE_PALETTE: readonly GraphV2NodeDescriptor[] = []

type PreviewValue = { input?: GraphJsonValue; output?: GraphJsonValue; error?: string }
type ConnectionSource = { nodeId: string; port: GraphPortV2 }
type PointerConnection = ConnectionSource & {
  pointerId: number
  start: { x: number; y: number }
  current: { x: number; y: number }
  target?: ConnectionSource
}

const jsonText = (value: unknown): string => JSON.stringify(value, null, 2)
const parseJson = (text: string, fallback: GraphJsonValue): GraphJsonValue => {
  try {
    return JSON.parse(text) as GraphJsonValue
  } catch {
    return fallback
  }
}

const getPortCompatibility = (
  source: GraphPortV2,
  target: GraphPortV2,
  existingTargetConnections = 0
): { compatible: boolean; reason: string } => {
  if (source.direction !== 'output' || target.direction !== 'input')
    return { compatible: false, reason: 'Connections must run from an output to an input.' }
  if (source.role !== target.role)
    return {
      compatible: false,
      reason: `Role mismatch: ${source.role} cannot connect to ${target.role}.`
    }
  const sourceType = source.valueType.kind
  const targetType = target.valueType.kind
  if (sourceType !== 'any' && targetType !== 'any' && sourceType !== targetType)
    return {
      compatible: false,
      reason: `Value type mismatch: ${sourceType} cannot connect to ${targetType}.`
    }
  if (
    source.valueType.schemaRef &&
    target.valueType.schemaRef &&
    source.valueType.schemaRef !== target.valueType.schemaRef
  )
    return {
      compatible: false,
      reason: `Schema mismatch: ${source.valueType.schemaRef} does not satisfy ${target.valueType.schemaRef}.`
    }
  if (
    source.valueType.mediaType &&
    target.valueType.mediaType &&
    source.valueType.mediaType !== target.valueType.mediaType
  )
    return {
      compatible: false,
      reason: `Media type mismatch: ${source.valueType.mediaType} cannot connect to ${target.valueType.mediaType}.`
    }
  if (!target.multiple && existingTargetConnections > 0)
    return { compatible: false, reason: `Input ${target.name} accepts only one connection.` }
  return { compatible: true, reason: 'Ports are compatible.' }
}

const GraphPortList: React.FC<{
  title: string
  nodeId: string
  ports: readonly GraphPortV2[]
  onPortClick?: (nodeId: string, port: GraphPortV2) => void
  onPortPointerDown?: (
    event: React.PointerEvent<HTMLElement>,
    nodeId: string,
    port: GraphPortV2
  ) => void
  onPortPointerEnter?: (nodeId: string, port: GraphPortV2) => void
  onPortPointerLeave?: (nodeId: string, port: GraphPortV2) => void
  onPortPointerUp?: (
    event: React.PointerEvent<HTMLElement>,
    nodeId: string,
    port: GraphPortV2
  ) => void
  activeTarget?: ConnectionSource
}> = ({
  title,
  nodeId,
  ports,
  onPortClick,
  onPortPointerDown,
  onPortPointerEnter,
  onPortPointerLeave,
  onPortPointerUp,
  activeTarget
}) => (
  <Stack spacing={0.5} sx={{ minWidth: 100 }}>
    <Typography variant="caption" color="text.secondary">
      {title}
    </Typography>
    {ports.map((port) => (
      <Stack
        key={port.portId}
        direction="row"
        spacing={0.75}
        alignItems="center"
        role={onPortClick ? 'button' : undefined}
        tabIndex={onPortClick ? 0 : undefined}
        aria-label={`Port ${nodeId} ${port.portId}`}
        title={`${port.role} · ${port.valueType.kind}${port.valueType.mediaType ? ` · ${port.valueType.mediaType}` : ''}${port.multiple ? ' · multiple' : ''}`}
        onClick={(event) => {
          event.stopPropagation()
          onPortClick?.(nodeId, port)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          onPortClick?.(nodeId, port)
        }}
        onPointerDown={(event) => {
          event.stopPropagation()
          onPortPointerDown?.(event, nodeId, port)
        }}
        onPointerEnter={() => onPortPointerEnter?.(nodeId, port)}
        onPointerLeave={() => onPortPointerLeave?.(nodeId, port)}
        onPointerUp={(event) => {
          event.stopPropagation()
          onPortPointerUp?.(event, nodeId, port)
        }}
        data-connection-target={
          activeTarget?.nodeId === nodeId && activeTarget.port.portId === port.portId
            ? 'active'
            : undefined
        }
        sx={{
          cursor: onPortClick ? 'crosshair' : 'default',
          outline:
            activeTarget?.nodeId === nodeId && activeTarget.port.portId === port.portId
              ? '2px solid #22c55e'
              : undefined,
          outlineOffset: 2
        }}
      >
        <Box
          sx={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            bgcolor: PORT_COLOR[port.role] ?? '#64748b'
          }}
        />
        <Typography variant="caption">{port.name}</Typography>
      </Stack>
    ))}
  </Stack>
)

export const GraphV2Canvas: React.FC<{
  definition: GraphDefinitionV2Draft
  selectedNodeId?: string
  onSelectNode?: (nodeId: string) => void
  onChange?: (definition: GraphDefinitionV2Draft) => void
  onTestNode?: (nodeId: string) => void
  onRunFromNode?: (nodeId: string) => void
  nodeDescriptors?: readonly GraphV2NodeDescriptor[]
  nodePreviews?: Readonly<Record<string, PreviewValue>>
  localizedErrors?: Readonly<Record<string, readonly string[]>>
  runtimeTopology?: MagicAgentPlatformRuntimeGraphTopologyResp | GraphRuntimeTopologySnapshotV2
}> = ({
  definition,
  selectedNodeId,
  onSelectNode,
  onChange,
  onTestNode,
  onRunFromNode,
  nodeDescriptors = OFFLINE_PALETTE,
  nodePreviews = {},
  localizedErrors = {},
  runtimeTopology
}) => {
  const descriptorByKind = useMemo(
    () => new Map(nodeDescriptors.map((descriptor) => [descriptor.kind, descriptor])),
    [nodeDescriptors]
  )
  const dragState = useRef<
    | {
        nodeId: string
        startX: number
        startY: number
        positions: Map<string, { x: number; y: number }>
      }
    | undefined
  >(undefined)
  const annotationDragState = useRef<
    | {
        kind: 'note' | 'reroute'
        id: string
        pointIndex?: number
        startX: number
        startY: number
        position: { x: number; y: number }
      }
    | undefined
  >(undefined)
  const panState = useRef<
    | {
        startX: number
        startY: number
        x: number
        y: number
        pointerId: number
      }
    | undefined
  >(undefined)
  const history = useRef<GraphDefinitionV2Draft[]>([])
  const future = useRef<GraphDefinitionV2Draft[]>([])
  const clipboard = useRef<
    { nodes: readonly GraphNodeV2[]; edges: readonly GraphEdgeV2[] } | undefined
  >(undefined)
  const [connectionSource, setConnectionSource] = useState<ConnectionSource>()
  const [pointerConnection, setPointerConnection] = useState<PointerConnection>()
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(
    selectedNodeId ? [selectedNodeId] : []
  )
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>()
  const [selectedNoteId, setSelectedNoteId] = useState<string>()
  const [selectedReroute, setSelectedReroute] = useState<{
    edgeId: string
    pointIndex: number
  }>()
  const [message, setMessage] = useState('')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [paletteQuery, setPaletteQuery] = useState('')

  useEffect(() => {
    if (selectedNodeId && !selectedNodeIds.includes(selectedNodeId))
      setSelectedNodeIds([selectedNodeId])
  }, [selectedNodeId])

  const visualPoints = [
    ...definition.nodes.map((node) => node.position),
    ...(definition.visualAnnotations?.notes.map((note) => note.position) ?? []),
    ...(definition.visualAnnotations?.reroutes.flatMap((reroute) => reroute.points) ?? [])
  ]
  const bounds = {
    minX: Math.min(0, ...visualPoints.map((point) => point.x)) - 80,
    minY: Math.min(0, ...visualPoints.map((point) => point.y)) - 80,
    maxX: Math.max(720, ...visualPoints.map((point) => point.x + 300)) + 80,
    maxY: Math.max(420, ...visualPoints.map((point) => point.y + 240)) + 80
  }
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const nodeById = useMemo(
    () => new Map(definition.nodes.map((node) => [node.nodeId, node])),
    [definition.nodes]
  )
  const selectedNode = selectedNodeIds.length === 1 ? nodeById.get(selectedNodeIds[0]) : undefined
  const selectedEdge = selectedEdgeId
    ? definition.edges.find((edge) => edge.edgeId === selectedEdgeId)
    : undefined
  const selectedNote = selectedNoteId
    ? definition.visualAnnotations?.notes.find((note) => note.noteId === selectedNoteId)
    : undefined
  const selectedDescriptor = selectedNode ? descriptorByKind.get(selectedNode.kind) : undefined

  const commit = (next: GraphDefinitionV2Draft, record = true) => {
    if (!onChange || next === definition) return
    if (record) {
      history.current.push(definition)
      if (history.current.length > 100) history.current.shift()
      future.current = []
    }
    onChange(next)
  }
  const updateNode = (nodeId: string, updater: (node: GraphNodeV2) => GraphNodeV2) =>
    commit({
      ...definition,
      nodes: definition.nodes.map((node) => (node.nodeId === nodeId ? updater(node) : node))
    })
  const updateSelectedNode = (updates: Partial<GraphNodeV2>) => {
    if (selectedNode) updateNode(selectedNode.nodeId, (node) => ({ ...node, ...updates }))
  }
  const undo = () => {
    const previous = history.current.pop()
    if (!previous) return
    future.current.push(definition)
    commit(previous, false)
  }
  const redo = () => {
    const next = future.current.pop()
    if (!next) return
    history.current.push(definition)
    commit(next, false)
  }
  const addNode = (kind: string) => {
    const descriptor = descriptorByKind.get(kind)
    if (!descriptor || !descriptor.executable) {
      setMessage(
        descriptor?.execution.mode === 'unsupported'
          ? descriptor.execution.reason
          : `Unsupported executable node kind: ${kind}.`
      )
      return
    }
    const index = definition.nodes.length + 1
    const nodeId = `${kind}-${Date.now()}-${index}`
    const node: GraphNodeV2 = {
      nodeId,
      kind: descriptor.kind,
      name: `${descriptor.title} ${index}`,
      description: descriptor.description,
      position: { x: 80 + (index % 3) * 280, y: 80 + Math.floor(index / 3) * 190 },
      inputs: descriptor.defaultInputs.map((port) => ({ ...port })),
      outputs: descriptor.defaultOutputs.map((port) => ({ ...port })),
      config: { ...descriptor.defaultConfig }
    }
    commit({ ...definition, nodes: [...definition.nodes, node] })
    setSelectedNodeIds([nodeId])
    onSelectNode?.(nodeId)
  }
  const selectNode = (nodeId: string, additive: boolean) => {
    setSelectedEdgeId(undefined)
    setSelectedNodeIds((current) =>
      additive
        ? current.includes(nodeId)
          ? current.filter((id) => id !== nodeId)
          : [...current, nodeId]
        : [nodeId]
    )
    onSelectNode?.(nodeId)
  }
  const deleteSelection = () => {
    const ids = new Set(selectedNodeIds)
    commit({
      ...definition,
      nodes: definition.nodes.filter((node) => !ids.has(node.nodeId)),
      edges: definition.edges.filter(
        (edge) =>
          edge.edgeId !== selectedEdgeId &&
          !ids.has(edge.source.nodeId) &&
          !ids.has(edge.target.nodeId)
      ),
      entryNodeIds: definition.entryNodeIds.filter((id) => !ids.has(id)),
      outputs: definition.outputs.filter((output) => !ids.has(output.source.nodeId))
    })
    setSelectedNodeIds([])
    setSelectedEdgeId(undefined)
  }
  const deleteSelectedEdge = () => {
    if (!selectedEdgeId) return
    commit({
      ...definition,
      edges: definition.edges.filter((edge) => edge.edgeId !== selectedEdgeId)
    })
    setSelectedEdgeId(undefined)
  }
  const deleteSelectedNode = () => {
    if (!selectedNode) return
    const nodeId = selectedNode.nodeId
    commit({
      ...definition,
      nodes: definition.nodes.filter((node) => node.nodeId !== nodeId),
      edges: definition.edges.filter(
        (edge) => edge.source.nodeId !== nodeId && edge.target.nodeId !== nodeId
      ),
      entryNodeIds: definition.entryNodeIds.filter((id) => id !== nodeId),
      outputs: definition.outputs.filter((output) => output.source.nodeId !== nodeId)
    })
    setSelectedNodeIds([])
  }
  const copy = () => {
    const ids = new Set(selectedNodeIds)
    clipboard.current = {
      nodes: definition.nodes.filter((node) => ids.has(node.nodeId)),
      edges: definition.edges.filter(
        (edge) => ids.has(edge.source.nodeId) && ids.has(edge.target.nodeId)
      )
    }
    setMessage(`Copied ${ids.size} node(s).`)
  }
  const paste = () => {
    if (!clipboard.current?.nodes.length) return
    const suffix = `${Date.now()}`
    const idMap = new Map(
      clipboard.current.nodes.map((node) => [node.nodeId, `${node.nodeId}-copy-${suffix}`])
    )
    const nodes = clipboard.current.nodes.map((node) => ({
      ...node,
      nodeId: idMap.get(node.nodeId)!,
      name: `${node.name} copy`,
      position: { x: node.position.x + 40, y: node.position.y + 40 }
    }))
    const edges = clipboard.current.edges.map((edge) => ({
      ...edge,
      edgeId: `${edge.edgeId}-copy-${suffix}`,
      source: { ...edge.source, nodeId: idMap.get(edge.source.nodeId)! },
      target: { ...edge.target, nodeId: idMap.get(edge.target.nodeId)! }
    }))
    commit({
      ...definition,
      nodes: [...definition.nodes, ...nodes],
      edges: [...definition.edges, ...edges]
    })
    setSelectedNodeIds(nodes.map((node) => node.nodeId))
  }
  const group = () => {
    if (selectedNodeIds.length < 2) {
      setMessage('Select at least two nodes to create a group.')
      return
    }
    const groupId = `group-${Date.now()}`
    const ids = new Set(selectedNodeIds)
    commit({
      ...definition,
      visualAnnotations: {
        groups: [
          ...(definition.visualAnnotations?.groups ?? []),
          { groupId, title: groupId, nodeIds: [...ids] }
        ],
        notes: definition.visualAnnotations?.notes ?? [],
        reroutes: definition.visualAnnotations?.reroutes ?? []
      }
    })
    setMessage(`Grouped ${ids.size} nodes as ${groupId}.`)
  }
  const autoLayout = () => {
    const incoming = new Map<string, number>()
    definition.nodes.forEach((node) => incoming.set(node.nodeId, 0))
    definition.edges.forEach((edge) =>
      incoming.set(edge.target.nodeId, (incoming.get(edge.target.nodeId) ?? 0) + 1)
    )
    const ordered = [...definition.nodes].sort(
      (a, b) =>
        (incoming.get(a.nodeId) ?? 0) - (incoming.get(b.nodeId) ?? 0) ||
        a.nodeId.localeCompare(b.nodeId)
    )
    commit({
      ...definition,
      nodes: definition.nodes.map((node) => {
        const index = ordered.findIndex((candidate) => candidate.nodeId === node.nodeId)
        return {
          ...node,
          position: { x: 60 + (index % 4) * 280, y: 60 + Math.floor(index / 4) * 190 }
        }
      })
    })
  }
  const connectPort = (nodeId: string, port: GraphPortV2, explicitSource?: ConnectionSource) => {
    const source = explicitSource ?? connectionSource
    if (port.direction === 'output') {
      setConnectionSource({ nodeId, port })
      setMessage(`Connecting ${nodeId}.${port.portId}`)
      return
    }
    if (!source) {
      setMessage('Select an output port first.')
      return
    }
    if (source.nodeId === nodeId) {
      setMessage('Self-connections are not allowed.')
      return
    }
    const edgeId = `${source.nodeId}.${source.port.portId}-${nodeId}.${port.portId}`
    if (
      definition.edges.some(
        (edge) =>
          edge.edgeId === edgeId ||
          (edge.source.nodeId === source.nodeId &&
            edge.source.portId === source.port.portId &&
            edge.target.nodeId === nodeId &&
            edge.target.portId === port.portId)
      )
    ) {
      setMessage('That connection already exists.')
      return
    }
    const count = definition.edges.filter(
      (edge) => edge.target.nodeId === nodeId && edge.target.portId === port.portId
    ).length
    const compatibility = getPortCompatibility(source.port, port, count)
    if (!compatibility.compatible) {
      setMessage(compatibility.reason)
      return
    }
    commit({
      ...definition,
      edges: [
        ...definition.edges,
        {
          edgeId,
          kind: source.port.role,
          source: { nodeId: source.nodeId, portId: source.port.portId },
          target: { nodeId, portId: port.portId }
        }
      ]
    })
    setConnectionSource(undefined)
    setMessage(`Connected ${edgeId}.`)
  }
  const beginPointerConnection = (
    event: React.PointerEvent<HTMLElement>,
    nodeId: string,
    port: GraphPortV2
  ) => {
    if (!onChange || port.direction !== 'output') return
    const point = { x: event.clientX, y: event.clientY }
    setPointerConnection({ nodeId, port, pointerId: event.pointerId, start: point, current: point })
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const finishPointerConnection = (
    event: React.PointerEvent<HTMLElement>,
    nodeId: string,
    port: GraphPortV2
  ) => {
    const active = pointerConnection
    if (!active || active.pointerId !== event.pointerId) return
    if (port.direction === 'input') connectPort(nodeId, port, active)
    setPointerConnection(undefined)
  }
  const addReroutePoint = () => {
    if (!selectedEdge) return
    const existing = definition.visualAnnotations?.reroutes.find(
      (reroute) => reroute.edgeId === selectedEdge.edgeId
    )
    const points = existing?.points ?? []
    const reroute = {
      edgeId: selectedEdge.edgeId,
      points: [...points, { x: 160 + points.length * 40, y: 120 + points.length * 30 }]
    }
    commit({
      ...definition,
      visualAnnotations: {
        groups: definition.visualAnnotations?.groups ?? [],
        notes: definition.visualAnnotations?.notes ?? [],
        reroutes: [
          ...(definition.visualAnnotations?.reroutes ?? []).filter(
            (item) => item.edgeId !== selectedEdge.edgeId
          ),
          reroute
        ]
      }
    })
  }
  const updateConfig = (key: string, value: GraphJsonValue) =>
    updateSelectedNode({ config: { ...(selectedNode?.config ?? {}), [key]: value } })
  const updateNote = (noteId: string, updates: Record<string, unknown>) =>
    commit({
      ...definition,
      visualAnnotations: {
        groups: definition.visualAnnotations?.groups ?? [],
        notes: (definition.visualAnnotations?.notes ?? []).map((note) =>
          note.noteId === noteId ? { ...note, ...updates } : note
        ),
        reroutes: definition.visualAnnotations?.reroutes ?? []
      }
    })
  const addNote = () => {
    const noteId = `note-${Date.now()}`
    commit({
      ...definition,
      visualAnnotations: {
        groups: definition.visualAnnotations?.groups ?? [],
        notes: [
          ...(definition.visualAnnotations?.notes ?? []),
          {
            noteId,
            title: 'Note',
            text: '',
            position: { x: (120 - pan.x) / zoom, y: (120 - pan.y) / zoom },
            color: '#fff7ae',
            width: 240,
            height: 140
          }
        ],
        reroutes: definition.visualAnnotations?.reroutes ?? []
      }
    })
    setSelectedNoteId(noteId)
    setSelectedNodeIds([])
    setSelectedEdgeId(undefined)
  }
  const deleteSelectedNote = () => {
    if (!selectedNoteId) return
    commit({
      ...definition,
      visualAnnotations: {
        groups: definition.visualAnnotations?.groups ?? [],
        notes: (definition.visualAnnotations?.notes ?? []).filter(
          (note) => note.noteId !== selectedNoteId
        ),
        reroutes: definition.visualAnnotations?.reroutes ?? []
      }
    })
    setSelectedNoteId(undefined)
  }
  const deleteSelectedReroute = () => {
    if (!selectedReroute) return
    commit({
      ...definition,
      visualAnnotations: {
        groups: definition.visualAnnotations?.groups ?? [],
        notes: definition.visualAnnotations?.notes ?? [],
        reroutes: (definition.visualAnnotations?.reroutes ?? []).flatMap((reroute) => {
          if (reroute.edgeId !== selectedReroute.edgeId) return [reroute]
          const points = reroute.points.filter((_, index) => index !== selectedReroute.pointIndex)
          return points.length ? [{ ...reroute, points }] : []
        })
      }
    })
    setSelectedReroute(undefined)
  }
  const insertReference = (value: string) => {
    if (!selectedNode) return
    const key = Object.keys(selectedNode.config)[0] ?? 'prompt'
    const current = selectedNode.config[key]
    updateConfig(key, `${typeof current === 'string' ? current : ''}${value}`)
  }

  const edgePath = (edge: GraphEdgeV2): string | undefined => {
    const source = nodeById.get(edge.source.nodeId)
    const target = nodeById.get(edge.target.nodeId)
    if (!source || !target) return undefined
    const start = { x: source.position.x + 240, y: source.position.y + 70 }
    const end = { x: target.position.x, y: target.position.y + 70 }
    const points =
      definition.visualAnnotations?.reroutes.find((reroute) => reroute.edgeId === edge.edgeId)
        ?.points ?? []
    if (points.length)
      return `M ${start.x} ${start.y} ${points.map((point) => `L ${point.x} ${point.y}`).join(' ')} L ${end.x} ${end.y}`
    const middle = (start.x + end.x) / 2
    return `M ${start.x} ${start.y} C ${middle} ${start.y}, ${middle} ${end.y}, ${end.x} ${end.y}`
  }

  return (
    <Stack spacing={1}>
      {message ? (
        <Typography role="status" variant="caption">
          {message}
        </Typography>
      ) : null}
      {onChange ? (
        <Stack spacing={1}>
          <TextField
            size="small"
            label="Search node palette"
            value={paletteQuery}
            onChange={(event) => setPaletteQuery(event.target.value)}
          />
          {!nodeDescriptors.length ? (
            <Typography variant="caption" color="text.secondary">
              Node registry is offline or empty. No palette nodes are available.
            </Typography>
          ) : null}
          {Array.from(new Set(nodeDescriptors.map((descriptor) => descriptor.category))).map(
            (category) => {
              const entries = nodeDescriptors.filter(
                (descriptor) =>
                  descriptor.category === category &&
                  `${descriptor.category} ${descriptor.kind} ${descriptor.title}`
                    .toLowerCase()
                    .includes(paletteQuery.trim().toLowerCase())
              )
              return entries.length ? (
                <Stack
                  key={category}
                  direction="row"
                  spacing={1}
                  flexWrap="wrap"
                  useFlexGap
                  alignItems="center"
                >
                  <Typography variant="caption" sx={{ width: 90 }}>
                    {category}
                  </Typography>
                  {entries.map((descriptor) => (
                    <Button
                      key={descriptor.kind}
                      size="small"
                      variant="outlined"
                      disabled={!descriptor.executable}
                      title={
                        descriptor.disabledReason ??
                        (descriptor.execution.mode === 'unsupported'
                          ? descriptor.execution.reason
                          : descriptor.configurationNeeded || descriptor.description)
                      }
                      onClick={() => addNode(descriptor.kind)}
                    >
                      {descriptor.title}
                    </Button>
                  ))}
                </Stack>
              ) : null
            }
          )}
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            <Button size="small" onClick={undo} disabled={!history.current.length}>
              Undo
            </Button>
            <Button size="small" onClick={redo} disabled={!future.current.length}>
              Redo
            </Button>
            <Button size="small" onClick={copy} disabled={!selectedNodeIds.length}>
              Copy
            </Button>
            <Button size="small" onClick={paste} disabled={!clipboard.current?.nodes.length}>
              Paste
            </Button>
            <Button size="small" onClick={group} disabled={selectedNodeIds.length < 2}>
              Group
            </Button>
            <Button size="small" onClick={autoLayout}>
              Auto-layout
            </Button>
            <Button size="small" variant="outlined" onClick={addNote}>
              Add note
            </Button>
            {selectedNote ? (
              <Button size="small" color="error" onClick={deleteSelectedNote}>
                Delete selected note
              </Button>
            ) : null}
            {selectedReroute ? (
              <Button size="small" color="error" onClick={deleteSelectedReroute}>
                Delete selected reroute point
              </Button>
            ) : null}
            {selectedEdgeId ? (
              <Button size="small" color="error" onClick={deleteSelectedEdge}>
                Delete selected edge
              </Button>
            ) : null}
            {selectedNode ? (
              <Button size="small" color="error" onClick={deleteSelectedNode}>
                Delete selected node
              </Button>
            ) : null}
            <Button
              size="small"
              color="error"
              onClick={deleteSelection}
              disabled={!selectedNodeIds.length && !selectedEdgeId}
            >
              Delete selection
            </Button>
          </Stack>
        </Stack>
      ) : null}

      {onChange && selectedNote ? (
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1}>
              <Typography variant="subtitle2">Note inspector</Typography>
              <TextField
                size="small"
                label="Note title"
                value={selectedNote.title ?? ''}
                onChange={(event) => updateNote(selectedNote.noteId, { title: event.target.value })}
              />
              <TextField
                size="small"
                multiline
                label="Note body"
                value={selectedNote.text}
                onChange={(event) => updateNote(selectedNote.noteId, { text: event.target.value })}
              />
              <TextField
                size="small"
                type="color"
                label="Note color"
                value={selectedNote.color ?? '#fff7ae'}
                onChange={(event) => updateNote(selectedNote.noteId, { color: event.target.value })}
              />
              <Stack direction="row" spacing={1}>
                <TextField
                  size="small"
                  type="number"
                  label="Note width"
                  value={selectedNote.width ?? 240}
                  onChange={(event) =>
                    updateNote(selectedNote.noteId, {
                      width: Math.max(80, Number(event.target.value))
                    })
                  }
                />
                <TextField
                  size="small"
                  type="number"
                  label="Note height"
                  value={selectedNote.height ?? 140}
                  onChange={(event) =>
                    updateNote(selectedNote.noteId, {
                      height: Math.max(60, Number(event.target.value))
                    })
                  }
                />
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      ) : null}

      {onChange && selectedNode ? (
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1}>
              <Typography variant="subtitle2">Node inspector</Typography>
              <TextField
                size="small"
                label="Node name"
                value={selectedNode.name}
                onChange={(event) => updateSelectedNode({ name: event.target.value })}
              />
              <TextField
                size="small"
                label={selectedNode.kind === 'note' ? 'Note text' : 'Node description'}
                multiline={selectedNode.kind === 'note'}
                value={
                  selectedNode.kind === 'note'
                    ? String(selectedNode.config.text ?? '')
                    : selectedNode.description
                }
                onChange={(event) =>
                  selectedNode.kind === 'note'
                    ? updateConfig('text', event.target.value)
                    : updateSelectedNode({ description: event.target.value })
                }
              />
              {selectedNode.kind === 'note' ? (
                <TextField
                  size="small"
                  label="Note color"
                  type="color"
                  value={String(selectedNode.config.color ?? '#fff7ae')}
                  onChange={(event) => updateConfig('color', event.target.value)}
                />
              ) : null}
              <Typography variant="caption">Schema-driven configuration</Typography>
              {Object.entries(selectedDescriptor?.configSchema.properties ?? {}).map(
                ([key, field]) => {
                  const value =
                    selectedNode.config[key] ??
                    field.default ??
                    selectedDescriptor?.defaultConfig[key]
                  const missing = field.required && (value === undefined || value === '')
                  const invalidType =
                    value !== undefined &&
                    ((field.type === 'string' && typeof value !== 'string') ||
                      (field.type === 'number' && typeof value !== 'number') ||
                      (field.type === 'boolean' && typeof value !== 'boolean'))
                  const common = {
                    size: 'small' as const,
                    label: `${field.title}${field.required ? ' *' : ''}`,
                    helperText: missing
                      ? 'This field is required.'
                      : invalidType
                        ? `Expected ${field.type}.`
                        : field.description,
                    error: Boolean(missing || invalidType)
                  }
                  if (field.enum)
                    return (
                      <TextField
                        key={key}
                        {...common}
                        select
                        value={value === undefined ? '' : String(value)}
                        onChange={(event) => {
                          const option = field.enum?.find(
                            (candidate) => String(candidate) === event.target.value
                          )
                          if (option !== undefined) updateConfig(key, option)
                        }}
                      >
                        {field.enum.map((option) => (
                          <MenuItem key={String(option)} value={String(option)}>
                            {String(option)}
                          </MenuItem>
                        ))}
                      </TextField>
                    )
                  if (field.type === 'boolean')
                    return (
                      <FormControlLabel
                        key={key}
                        label={common.label}
                        control={
                          <Checkbox
                            checked={value === true}
                            onChange={(event) => updateConfig(key, event.target.checked)}
                          />
                        }
                      />
                    )
                  return (
                    <TextField
                      key={key}
                      {...common}
                      type={field.type === 'number' ? 'number' : 'text'}
                      value={value === undefined ? '' : String(value)}
                      onChange={(event) =>
                        updateConfig(
                          key,
                          field.type === 'number' ? Number(event.target.value) : event.target.value
                        )
                      }
                    />
                  )
                }
              )}
              {!Object.keys(selectedDescriptor?.configSchema.properties ?? {}).length ? (
                <Typography variant="caption" color="text.secondary">
                  This node has no configuration fields.
                </Typography>
              ) : null}
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {definition.variables.map((variable) => (
                  <Button
                    key={variable.variableId}
                    size="small"
                    onClick={() => insertReference(`{{variables.${variable.variableId}}}`)}
                  >
                    Insert {variable.name}
                  </Button>
                ))}
                {definition.nodes
                  .filter((node) => node.nodeId !== selectedNode.nodeId)
                  .flatMap((node) =>
                    node.outputs.map((port) => (
                      <Button
                        key={`${node.nodeId}.${port.portId}`}
                        size="small"
                        onClick={() => insertReference(`{{nodes.${node.nodeId}.${port.portId}}}`)}
                      >
                        Insert {node.name}.{port.name}
                      </Button>
                    ))
                  )}
              </Stack>
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => onTestNode?.(selectedNode.nodeId)}
                  disabled={!onTestNode}
                >
                  Test node
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => onRunFromNode?.(selectedNode.nodeId)}
                  disabled={!onRunFromNode}
                >
                  Run from node
                </Button>
              </Stack>
              <Typography variant="caption">
                Input preview: {jsonText(nodePreviews[selectedNode.nodeId]?.input ?? null)}
              </Typography>
              <Typography variant="caption">
                Output preview: {jsonText(nodePreviews[selectedNode.nodeId]?.output ?? null)}
              </Typography>
              {localizedErrors[selectedNode.nodeId]?.map((error) => (
                <Alert key={error} severity="error">
                  {error}
                </Alert>
              ))}
            </Stack>
          </CardContent>
        </Card>
      ) : null}

      {onChange && selectedNode?.subgraphRef ? (
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1}>
              <Typography variant="subtitle2">Subgraph mapping</Typography>
              <TextField
                size="small"
                label="Subgraph ID"
                value={selectedNode.subgraphRef.graphId}
                onChange={(event) =>
                  updateSelectedNode({
                    subgraphRef: { ...selectedNode.subgraphRef!, graphId: event.target.value }
                  })
                }
              />
              <TextField
                size="small"
                label="Subgraph version"
                value={selectedNode.subgraphRef.version}
                onChange={(event) =>
                  updateSelectedNode({
                    subgraphRef: { ...selectedNode.subgraphRef!, version: event.target.value }
                  })
                }
              />
              <TextField
                size="small"
                multiline
                label="Input mappings"
                defaultValue={jsonText(selectedNode.subgraphRef.inputMappings)}
                onBlur={(event) =>
                  updateSelectedNode({
                    subgraphRef: {
                      ...selectedNode.subgraphRef!,
                      inputMappings: parseJson(event.target.value, {}) as Record<string, string>
                    }
                  })
                }
              />
              <TextField
                size="small"
                multiline
                label="Output mappings"
                defaultValue={jsonText(selectedNode.subgraphRef.outputMappings)}
                onBlur={(event) =>
                  updateSelectedNode({
                    subgraphRef: {
                      ...selectedNode.subgraphRef!,
                      outputMappings: parseJson(event.target.value, {}) as Record<string, string>
                    }
                  })
                }
              />
            </Stack>
          </CardContent>
        </Card>
      ) : null}

      {onChange && selectedEdge ? (
        <Stack direction="row" spacing={1}>
          <Button size="small" onClick={addReroutePoint}>
            Add reroute point
          </Button>
          {selectedEdge.kind === 'error' ? (
            <TextField
              size="small"
              label="Error route label"
              value={selectedEdge.label ?? ''}
              onChange={(event) =>
                commit({
                  ...definition,
                  edges: definition.edges.map((edge) =>
                    edge.edgeId === selectedEdge.edgeId
                      ? { ...edge, label: event.target.value }
                      : edge
                  )
                })
              }
            />
          ) : null}
        </Stack>
      ) : null}

      {onChange && definition.variables.length ? (
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1}>
              <Typography variant="subtitle2">Variables and secrets</Typography>
              {definition.variables.map((variable) => (
                <Stack key={variable.variableId} direction="row" spacing={1} alignItems="center">
                  <TextField
                    size="small"
                    label="Variable name"
                    value={variable.name}
                    onChange={(event) =>
                      commit({
                        ...definition,
                        variables: definition.variables.map((item) =>
                          item.variableId === variable.variableId
                            ? { ...item, name: event.target.value }
                            : item
                        )
                      })
                    }
                  />
                  <Chip size="small" label={variable.scope} />
                  <Chip
                    size="small"
                    color={variable.sensitive ? 'warning' : 'default'}
                    label={variable.sensitive ? 'secret' : variable.valueType.kind}
                  />
                </Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>
      ) : null}
      {onChange && definition.outputs.length ? (
        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1}>
              <Typography variant="subtitle2">Graph outputs</Typography>
              {definition.outputs.map((output) => (
                <Stack key={output.outputId} direction="row" spacing={1} alignItems="center">
                  <TextField
                    size="small"
                    label="Output name"
                    value={output.name}
                    onChange={(event) =>
                      commit({
                        ...definition,
                        outputs: definition.outputs.map((item) =>
                          item.outputId === output.outputId
                            ? { ...item, name: event.target.value }
                            : item
                        )
                      })
                    }
                  />
                  <Chip size="small" label={`${output.source.nodeId}.${output.source.portId}`} />
                </Stack>
              ))}
            </Stack>
          </CardContent>
        </Card>
      ) : null}

      <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
        <Typography variant="caption">Viewport {Math.round(zoom * 100)}%</Typography>
        <Stack direction="row">
          <Button
            size="small"
            aria-label="Zoom out"
            onClick={() => setZoom((value) => Math.max(0.25, value - 0.1))}
          >
            <Remove fontSize="small" />
          </Button>
          <Button
            size="small"
            aria-label="Fit graph"
            onClick={() => {
              const fitZoom = Math.min(1, 640 / width, 360 / height)
              setZoom(Math.max(0.25, fitZoom))
              setPan({ x: -bounds.minX * fitZoom + 20, y: -bounds.minY * fitZoom + 20 })
            }}
          >
            <FitScreen fontSize="small" />
          </Button>
          <Button
            size="small"
            aria-label="Zoom in"
            onClick={() => setZoom((value) => Math.min(3, value + 0.1))}
          >
            <Add fontSize="small" />
          </Button>
        </Stack>
      </Stack>
      <Box
        aria-label="Graph minimap"
        sx={{
          position: 'relative',
          width: 180,
          height: 100,
          border: '1px solid',
          borderColor: 'divider',
          overflow: 'hidden'
        }}
      >
        {definition.nodes.map((node) => (
          <Box
            key={node.nodeId}
            title={node.name}
            sx={{
              position: 'absolute',
              left: `${((node.position.x - bounds.minX) / width) * 100}%`,
              top: `${((node.position.y - bounds.minY) / height) * 100}%`,
              width: 18,
              height: 10,
              bgcolor: selectedNodeIds.includes(node.nodeId) ? 'primary.main' : 'text.secondary'
            }}
          />
        ))}
      </Box>
      <Box
        aria-label="Graph V2 canvas"
        tabIndex={0}
        onKeyDown={(event) => {
          if (!(event.ctrlKey || event.metaKey)) return
          if (event.key.toLowerCase() === 'c') copy()
          if (event.key.toLowerCase() === 'v') paste()
          if (event.key.toLowerCase() === 'z') event.shiftKey ? redo() : undo()
        }}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.shiftKey) setSelectedNodeIds([])
          panState.current = {
            startX: event.clientX,
            startY: event.clientY,
            x: pan.x,
            y: pan.y,
            pointerId: event.pointerId
          }
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }}
        onPointerMove={(event) => {
          const connection = pointerConnection
          if (connection?.pointerId === event.pointerId) {
            setPointerConnection({
              ...connection,
              current: { x: event.clientX, y: event.clientY }
            })
            return
          }
          const active = panState.current
          if (active?.pointerId === event.pointerId)
            setPan({
              x: active.x + event.clientX - active.startX,
              y: active.y + event.clientY - active.startY
            })
        }}
        onPointerUp={(event) => {
          if (pointerConnection?.pointerId === event.pointerId) {
            if (pointerConnection.target)
              connectPort(
                pointerConnection.target.nodeId,
                pointerConnection.target.port,
                pointerConnection
              )
            setPointerConnection(undefined)
          }
          if (panState.current?.pointerId === event.pointerId) panState.current = undefined
        }}
        onWheel={(event) => {
          if (event.ctrlKey) {
            event.preventDefault()
            setZoom((value) => Math.min(3, Math.max(0.25, value - event.deltaY * 0.001)))
          }
        }}
        sx={{
          position: 'relative',
          minHeight: 420,
          height: 420,
          overflow: 'hidden',
          border: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.default',
          backgroundImage:
            'linear-gradient(rgba(148,163,184,.12) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,.12) 1px, transparent 1px)',
          backgroundSize: '24px 24px'
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            width: 1,
            height: 1,
            overflow: 'visible',
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0'
          }}
        >
          <svg
            width={1}
            height={1}
            style={{
              position: 'absolute',
              inset: 0,
              overflow: 'visible',
              pointerEvents: pointerConnection ? 'none' : 'auto'
            }}
          >
            {pointerConnection ? (
              <line
                data-testid="graph-v2-provisional-wire"
                x1={(pointerConnection.start.x - pan.x) / zoom}
                y1={(pointerConnection.start.y - pan.y) / zoom}
                x2={(pointerConnection.current.x - pan.x) / zoom}
                y2={(pointerConnection.current.y - pan.y) / zoom}
                stroke={PORT_COLOR[pointerConnection.port.role] ?? '#64748b'}
                strokeWidth={3}
                strokeDasharray="6 4"
              />
            ) : null}
            {definition.edges.map((edge) => (
              <path
                key={edge.edgeId}
                data-testid="graph-v2-edge"
                aria-label={`Graph edge ${edge.edgeId}`}
                role="button"
                onClick={() => {
                  setSelectedEdgeId(edge.edgeId)
                  setSelectedNodeIds([])
                  setSelectedNoteId(undefined)
                  setSelectedReroute(undefined)
                }}
                d={edgePath(edge)}
                fill="none"
                stroke={
                  selectedEdgeId === edge.edgeId ? '#ec4899' : (PORT_COLOR[edge.kind] ?? '#64748b')
                }
                strokeWidth={selectedEdgeId === edge.edgeId ? 4 : 2}
                style={{ cursor: 'pointer' }}
              />
            ))}
            {(definition.visualAnnotations?.reroutes ?? []).flatMap((reroute) =>
              reroute.points.map((point, pointIndex) => (
                <circle
                  key={`${reroute.edgeId}-${pointIndex}`}
                  data-testid="graph-v2-reroute-point"
                  aria-label={`Reroute point ${reroute.edgeId} ${pointIndex}`}
                  role="button"
                  cx={point.x}
                  cy={point.y}
                  r={
                    selectedReroute?.edgeId === reroute.edgeId &&
                    selectedReroute.pointIndex === pointIndex
                      ? 8
                      : 6
                  }
                  fill="#ec4899"
                  onClick={(event) => {
                    event.stopPropagation()
                    setSelectedReroute({ edgeId: reroute.edgeId, pointIndex })
                    setSelectedEdgeId(reroute.edgeId)
                    setSelectedNodeIds([])
                    setSelectedNoteId(undefined)
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    annotationDragState.current = {
                      kind: 'reroute',
                      id: reroute.edgeId,
                      pointIndex,
                      startX: event.clientX,
                      startY: event.clientY,
                      position: point
                    }
                    event.currentTarget.setPointerCapture?.(event.pointerId)
                  }}
                  onPointerMove={(event) => {
                    const drag = annotationDragState.current
                    if (
                      drag?.kind !== 'reroute' ||
                      drag.id !== reroute.edgeId ||
                      drag.pointIndex !== pointIndex
                    )
                      return
                    const nextPoint = {
                      x: drag.position.x + (event.clientX - drag.startX) / zoom,
                      y: drag.position.y + (event.clientY - drag.startY) / zoom
                    }
                    commit(
                      {
                        ...definition,
                        visualAnnotations: {
                          groups: definition.visualAnnotations?.groups ?? [],
                          notes: definition.visualAnnotations?.notes ?? [],
                          reroutes: (definition.visualAnnotations?.reroutes ?? []).map((item) =>
                            item.edgeId === reroute.edgeId
                              ? {
                                  ...item,
                                  points: item.points.map((candidate, index) =>
                                    index === pointIndex ? nextPoint : candidate
                                  )
                                }
                              : item
                          )
                        }
                      },
                      false
                    )
                  }}
                  onPointerUp={() => {
                    annotationDragState.current = undefined
                  }}
                  style={{ cursor: 'move' }}
                />
              ))
            )}
          </svg>
          {definition.nodes.map((node) => {
            const grouped = definition.visualAnnotations?.groups.some((group) =>
              group.nodeIds.includes(node.nodeId)
            )
            return (
              <Card
                key={node.nodeId}
                data-testid="graph-v2-node"
                aria-label={`Graph node ${node.name}`}
                variant="outlined"
                onClick={(event) =>
                  selectNode(node.nodeId, event.ctrlKey || event.metaKey || event.shiftKey)
                }
                onPointerDown={(event) => {
                  if (!onChange) return
                  const ids = selectedNodeIds.includes(node.nodeId)
                    ? selectedNodeIds
                    : [node.nodeId]
                  dragState.current = {
                    nodeId: node.nodeId,
                    startX: event.clientX,
                    startY: event.clientY,
                    positions: new Map(
                      definition.nodes
                        .filter((item) => ids.includes(item.nodeId))
                        .map((item) => [item.nodeId, item.position])
                    )
                  }
                  event.currentTarget.setPointerCapture?.(event.pointerId)
                }}
                onPointerMove={(event) => {
                  const drag = dragState.current
                  if (!drag || drag.nodeId !== node.nodeId) return
                  const dx = (event.clientX - drag.startX) / zoom
                  const dy = (event.clientY - drag.startY) / zoom
                  commit(
                    {
                      ...definition,
                      nodes: definition.nodes.map((item) => {
                        const start = drag.positions.get(item.nodeId)
                        return start
                          ? {
                              ...item,
                              position: {
                                x: start.x + dx,
                                y: start.y + dy
                              }
                            }
                          : item
                      })
                    },
                    false
                  )
                }}
                onPointerUp={() => {
                  if (dragState.current) history.current.push(definition)
                  dragState.current = undefined
                }}
                sx={{
                  position: 'absolute',
                  left: node.position.x,
                  top: node.position.y,
                  width: 240,
                  cursor: 'pointer',
                  bgcolor:
                    node.kind === 'note'
                      ? String(node.config.color ?? '#fff7ae')
                      : 'background.paper',
                  borderColor: selectedNodeIds.includes(node.nodeId)
                    ? 'primary.main'
                    : localizedErrors[node.nodeId]?.length
                      ? 'error.main'
                      : 'divider',
                  borderWidth: selectedNodeIds.includes(node.nodeId) ? 2 : 1,
                  outline: grouped ? '1px dashed #8b5cf6' : undefined
                }}
              >
                <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Stack spacing={1}>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="subtitle2">{node.name}</Typography>
                      <Chip size="small" label={node.kind} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {node.kind === 'note'
                        ? String(node.config.text ?? node.description)
                        : node.description}
                    </Typography>
                    {node.kind !== 'note' ? (
                      <Stack direction="row" justifyContent="space-between">
                        <GraphPortList
                          title="Inputs"
                          nodeId={node.nodeId}
                          ports={node.inputs}
                          onPortClick={onChange ? connectPort : undefined}
                          onPortPointerDown={onChange ? beginPointerConnection : undefined}
                          onPortPointerEnter={(nodeId, port) => {
                            if (!pointerConnection || port.direction !== 'input') return
                            setPointerConnection({
                              ...pointerConnection,
                              target: { nodeId, port }
                            })
                          }}
                          onPortPointerLeave={(nodeId, port) => {
                            if (
                              pointerConnection?.target?.nodeId === nodeId &&
                              pointerConnection.target.port.portId === port.portId
                            )
                              setPointerConnection({ ...pointerConnection, target: undefined })
                          }}
                          onPortPointerUp={finishPointerConnection}
                          activeTarget={pointerConnection?.target}
                        />
                        <GraphPortList
                          title="Outputs"
                          nodeId={node.nodeId}
                          ports={node.outputs}
                          onPortClick={onChange ? connectPort : undefined}
                          onPortPointerDown={onChange ? beginPointerConnection : undefined}
                          onPortPointerEnter={(nodeId, port) => {
                            if (!pointerConnection || port.direction !== 'input') return
                            setPointerConnection({
                              ...pointerConnection,
                              target: { nodeId, port }
                            })
                          }}
                          onPortPointerLeave={(nodeId, port) => {
                            if (
                              pointerConnection?.target?.nodeId === nodeId &&
                              pointerConnection.target.port.portId === port.portId
                            )
                              setPointerConnection({ ...pointerConnection, target: undefined })
                          }}
                          onPortPointerUp={finishPointerConnection}
                          activeTarget={pointerConnection?.target}
                        />
                      </Stack>
                    ) : null}
                    {localizedErrors[node.nodeId]?.length ? (
                      <Chip
                        size="small"
                        color="error"
                        label={`${localizedErrors[node.nodeId].length} error(s)`}
                      />
                    ) : null}
                  </Stack>
                </CardContent>
              </Card>
            )
          })}
          {(definition.visualAnnotations?.notes ?? []).map((note) => (
            <Card
              key={note.noteId}
              data-testid="graph-v2-note"
              aria-label={`Graph note ${note.noteId}`}
              variant="outlined"
              onClick={(event) => {
                event.stopPropagation()
                setSelectedNoteId(note.noteId)
                setSelectedNodeIds([])
                setSelectedEdgeId(undefined)
                setSelectedReroute(undefined)
              }}
              onPointerDown={(event) => {
                event.stopPropagation()
                annotationDragState.current = {
                  kind: 'note',
                  id: note.noteId,
                  startX: event.clientX,
                  startY: event.clientY,
                  position: note.position
                }
                event.currentTarget.setPointerCapture?.(event.pointerId)
              }}
              onPointerMove={(event) => {
                const drag = annotationDragState.current
                if (drag?.kind !== 'note' || drag.id !== note.noteId) return
                updateNote(note.noteId, {
                  position: {
                    x: drag.position.x + (event.clientX - drag.startX) / zoom,
                    y: drag.position.y + (event.clientY - drag.startY) / zoom
                  }
                })
              }}
              onPointerUp={() => {
                annotationDragState.current = undefined
              }}
              sx={{
                position: 'absolute',
                left: note.position.x,
                top: note.position.y,
                width: note.width ?? 240,
                height: note.height ?? 140,
                cursor: 'move',
                bgcolor: note.color ?? '#fff7ae',
                borderColor: selectedNoteId === note.noteId ? 'primary.main' : 'divider',
                borderWidth: selectedNoteId === note.noteId ? 2 : 1
              }}
            >
              <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                {note.title ? <Typography variant="subtitle2">{note.title}</Typography> : null}
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                  {note.text}
                </Typography>
              </CardContent>
            </Card>
          ))}
        </Box>
      </Box>
      {runtimeTopology ? (
        'resources' in runtimeTopology ? (
          <Card variant="outlined" data-testid="runtime-topology">
            <CardContent>
              <Stack spacing={1}>
                <Typography variant="subtitle2">
                  Runtime topology · run {runtimeTopology.runId} · revision{' '}
                  {runtimeTopology.revision}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Durable runtime resources are rendered independently from the design definition.
                </Typography>
                <Box
                  aria-label="Runtime graph topology"
                  sx={{
                    position: 'relative',
                    minWidth: 720,
                    height: Math.max(260, Math.ceil(runtimeTopology.resources.length / 4) * 150),
                    overflow: 'auto',
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 1,
                    bgcolor: 'background.default'
                  }}
                >
                  <svg
                    aria-label="Runtime topology wire edges"
                    width="100%"
                    height="100%"
                    style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                  >
                    {runtimeTopology.resources
                      .filter((resource) => resource.kind === 'wire')
                      .map((wire) => {
                        const ordered = [...runtimeTopology.resources].sort((left, right) =>
                          `${left.kind}:${left.resourceId}`.localeCompare(
                            `${right.kind}:${right.resourceId}`
                          )
                        )
                        const sourceIndex = ordered.findIndex(
                          (resource) => resource.resourceId === wire.sourceResourceId
                        )
                        const targetIndex = ordered.findIndex(
                          (resource) => resource.resourceId === wire.targetResourceId
                        )
                        if (sourceIndex < 0 || targetIndex < 0) return null
                        const point = (index: number) => ({
                          x: 125 + (index % 4) * 180,
                          y: 70 + Math.floor(index / 4) * 150
                        })
                        const source = point(sourceIndex)
                        const target = point(targetIndex)
                        return (
                          <g key={wire.resourceId} data-testid="runtime-wire-edge">
                            <line
                              x1={source.x}
                              y1={source.y}
                              x2={target.x}
                              y2={target.y}
                              stroke="#7b1fa2"
                              strokeWidth="3"
                              strokeDasharray="7 4"
                            />
                            <text
                              x={(source.x + target.x) / 2}
                              y={(source.y + target.y) / 2 - 6}
                              fill="currentColor"
                              fontSize="11"
                            >
                              {wire.resourceId}
                            </text>
                          </g>
                        )
                      })}
                  </svg>
                  {[...runtimeTopology.resources]
                    .sort((left, right) =>
                      `${left.kind}:${left.resourceId}`.localeCompare(
                        `${right.kind}:${right.resourceId}`
                      )
                    )
                    .map((resource, index) => (
                      <Card
                        key={resource.resourceId}
                        variant="outlined"
                        data-testid={`runtime-resource-${resource.kind}`}
                        sx={{
                          position: 'absolute',
                          left: 20 + (index % 4) * 180,
                          top: 20 + Math.floor(index / 4) * 150,
                          width: 210,
                          minHeight: 100,
                          borderWidth: 2,
                          borderColor:
                            resource.kind === 'node'
                              ? 'primary.main'
                              : resource.kind === 'agent-invocation'
                                ? 'secondary.main'
                                : resource.kind === 'channel'
                                  ? 'info.main'
                                  : 'warning.main'
                        }}
                      >
                        <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
                          <Stack spacing={0.5}>
                            <Stack direction="row" spacing={0.5} alignItems="center">
                              <Chip size="small" label={resource.kind} />
                              {resource.status ? (
                                <Chip size="small" label={resource.status} />
                              ) : null}
                            </Stack>
                            <Typography variant="body2" fontWeight={600} noWrap>
                              {resource.resourceId}
                            </Typography>
                            {resource.nodeKind ? (
                              <Typography variant="caption">
                                Node kind: {resource.nodeKind}
                              </Typography>
                            ) : null}
                            <Typography variant="caption">
                              Attribution: node {resource.sourceNodeId || 'non-agent source'}
                              {resource.targetNodeId ? ` → ${resource.targetNodeId}` : ''}
                            </Typography>
                            {resource.sourceChannelId ? (
                              <Typography variant="caption">
                                Source channel: {resource.sourceChannelId}
                              </Typography>
                            ) : null}
                            {resource.sourceResourceId || resource.targetResourceId ? (
                              <Typography variant="caption">
                                Endpoints: {resource.sourceResourceId || 'external'} →{' '}
                                {resource.targetResourceId || 'external'}
                              </Typography>
                            ) : null}
                          </Stack>
                        </CardContent>
                      </Card>
                    ))}
                </Box>
              </Stack>
            </CardContent>
          </Card>
        ) : (
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={1}>
                <Typography variant="subtitle2">
                  Runtime topology · run {runtimeTopology.runId} · revision{' '}
                  {runtimeTopology.revision}
                </Typography>
                {runtimeTopology.edges.map((edge) => (
                  <Typography key={edge.edgeId} variant="caption">
                    {edge.edgeId}: {edge.sourceNodeId} → {edge.targetNodeId}
                  </Typography>
                ))}
              </Stack>
            </CardContent>
          </Card>
        )
      ) : null}
    </Stack>
  )
}
