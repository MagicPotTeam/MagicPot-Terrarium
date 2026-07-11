import { normalizeMagicPotToolName } from '@shared/app/types'
import type {
  MagicAgentGraphDefinition,
  MagicAgentGraphPermissionSnapshot,
  MagicAgentGraphPreflightIssue,
  MagicAgentGraphPreflightSnapshot,
  MagicAgentGraphToolPermissionSnapshot
} from '@shared/magicAgent'
import type { MagicAgentPlatformToolDefinition } from '@shared/api/svcMagicAgentPlatform'
import { isMagicAgentPlatformDeniedToolName } from '../toolPolicy'

export type MagicAgentGraphPreflightToolNode = MagicAgentGraphToolPermissionSnapshot

export type MagicAgentGraphPreflightResult = {
  ok: boolean
  safeToRun: boolean
  requiresExplicitToolAllowlist: boolean
  hasToolNodes: boolean
  toolNodes: MagicAgentGraphPreflightToolNode[]
  issues: MagicAgentGraphPreflightIssue[]
}

export type MagicAgentGraphPreflightOptions = {
  allowedToolNames?: string[] | null
  availableTools?: Array<
    Pick<
      MagicAgentPlatformToolDefinition,
      | 'name'
      | 'source'
      | 'status'
      | 'permissionLevel'
      | 'requiresConfirmation'
      | 'unavailableReason'
      | 'metadata'
    >
  >
  explicit?: boolean
  checkedAt?: number
  metadata?: Record<string, unknown>
}

const cleanString = (value: unknown): string => String(value || '').trim()

const normalizeToolName = (value: unknown): string => normalizeMagicPotToolName(cleanString(value))

export const normalizeMagicAgentGraphAllowedToolNames = (
  allowedToolNames?: string[] | null
): string[] | null | undefined => {
  if (allowedToolNames === null) return null
  if (!Array.isArray(allowedToolNames)) return undefined
  return [
    ...new Set(
      allowedToolNames
        .map(normalizeToolName)
        .filter((toolName) => Boolean(toolName) && !isMagicAgentPlatformDeniedToolName(toolName))
    )
  ].sort((left, right) => left.localeCompare(right))
}

const getNodeToolName = (node: MagicAgentGraphDefinition['nodes'][number]): string => {
  const config = node.config && typeof node.config === 'object' ? node.config : undefined
  return normalizeToolName(node.toolName) || normalizeToolName(config?.toolName)
}

export const preflightMagicAgentGraph = (
  graph: MagicAgentGraphDefinition,
  options: MagicAgentGraphPreflightOptions = {}
): MagicAgentGraphPreflightResult => {
  const normalizedAllowedToolNames = normalizeMagicAgentGraphAllowedToolNames(
    options.allowedToolNames
  )
  const allowedToolNames = Array.isArray(normalizedAllowedToolNames)
    ? new Set(normalizedAllowedToolNames)
    : new Set<string>()
  const hasExplicitAllowlist = Array.isArray(options.allowedToolNames)
  const toolCatalog = new Map(
    (options.availableTools || [])
      .map((tool) => [normalizeToolName(tool.name), tool] as const)
      .filter(([name]) => Boolean(name))
  )
  const hasToolCatalog = toolCatalog.size > 0
  const toolNodes: MagicAgentGraphPreflightToolNode[] = []
  const issues: MagicAgentGraphPreflightIssue[] = []

  for (const node of graph.nodes) {
    if (node.kind !== 'tool') continue
    const toolName = getNodeToolName(node)
    const definition = toolName ? toolCatalog.get(toolName) : undefined
    const denied = !toolName || isMagicAgentPlatformDeniedToolName(toolName)
    const hasAllowlistEntry = toolName ? allowedToolNames.has(toolName) : false
    const requiresAllowlist = !hasAllowlistEntry
    const available = Boolean(
      definition && (!definition.status || definition.status === 'available')
    )
    const unknown = hasToolCatalog && toolName && !definition
    const unavailable = hasToolCatalog && (!definition || definition.status === 'unavailable')

    toolNodes.push({
      nodeId: node.nodeId,
      ...(toolName ? { toolName } : {}),
      allowed: Boolean(toolName && hasAllowlistEntry && !denied),
      available: hasToolCatalog ? available : Boolean(toolName),
      denied,
      requiresAllowlist,
      ...(definition?.source ? { source: definition.source } : {}),
      ...(definition?.status ? { status: definition.status } : {}),
      ...(definition?.permissionLevel ? { permissionLevel: definition.permissionLevel } : {}),
      ...(definition?.requiresConfirmation !== undefined
        ? { requiresConfirmation: definition.requiresConfirmation }
        : {}),
      ...(definition?.unavailableReason ? { unavailableReason: definition.unavailableReason } : {}),
      ...(definition?.metadata ? { metadata: { ...definition.metadata } } : {})
    })

    issues.push({
      severity: 'warning',
      code: 'tool-node-detected',
      message: `MagicAgentGraph node "${node.nodeId}" invokes a tool${toolName ? `: ${toolName}` : ''}.`,
      nodeId: node.nodeId,
      ...(toolName ? { toolName } : {})
    })

    if (!toolName) {
      issues.push({
        severity: 'error',
        code: 'tool-unknown',
        message: `MagicAgentGraph tool node "${node.nodeId}" is missing toolName.`,
        nodeId: node.nodeId
      })
      continue
    }

    if (denied) {
      issues.push({
        severity: 'error',
        code: 'tool-denied',
        message: `MagicAgentGraph tool "${toolName}" is denied by platform policy.`,
        nodeId: node.nodeId,
        toolName
      })
    }

    if (requiresAllowlist) {
      issues.push({
        severity: 'error',
        code: 'tool-missing-allowlist',
        message: hasExplicitAllowlist
          ? `MagicAgentGraph tool "${toolName}" is missing from allowedToolNames.`
          : `MagicAgentGraph tool "${toolName}" requires an explicit allowedToolNames list.`,
        nodeId: node.nodeId,
        toolName
      })
    }

    if (unknown) {
      issues.push({
        severity: 'error',
        code: 'tool-unknown',
        message: `MagicAgentGraph tool "${toolName}" is not present in the platform tool catalog.`,
        nodeId: node.nodeId,
        toolName
      })
    } else if (unavailable) {
      issues.push({
        severity: 'error',
        code: 'tool-unavailable',
        message:
          definition?.unavailableReason || `MagicAgentGraph tool "${toolName}" is unavailable.`,
        nodeId: node.nodeId,
        toolName,
        ...(definition?.unavailableReason
          ? { metadata: { unavailableReason: definition.unavailableReason } }
          : {})
      })
    }
  }

  const hasErrors = issues.some((issue) => issue.severity === 'error')
  return {
    ok: !hasErrors,
    safeToRun: !hasErrors,
    requiresExplicitToolAllowlist: toolNodes.some((toolNode) => toolNode.requiresAllowlist),
    hasToolNodes: toolNodes.length > 0,
    toolNodes,
    issues
  }
}

export const createMagicAgentGraphPreflightSnapshot = (
  graph: MagicAgentGraphDefinition,
  options: MagicAgentGraphPreflightOptions = {}
): MagicAgentGraphPreflightSnapshot => {
  const result = preflightMagicAgentGraph(graph, options)
  const normalizedAllowedToolNames = normalizeMagicAgentGraphAllowedToolNames(
    options.allowedToolNames
  )
  const permissions: MagicAgentGraphPermissionSnapshot = {
    ...(normalizedAllowedToolNames !== undefined
      ? { allowedToolNames: normalizedAllowedToolNames }
      : {}),
    tools: result.toolNodes.map((toolNode) => ({ ...toolNode })),
    issues: result.issues.map((issue) => ({ ...issue }))
  }
  return {
    graphId: graph.graphId,
    checkedAt: Number.isFinite(options.checkedAt) ? Number(options.checkedAt) : Date.now(),
    ok: result.ok,
    safeToRun: result.safeToRun,
    requiresExplicitToolAllowlist: result.requiresExplicitToolAllowlist,
    hasToolNodes: result.hasToolNodes,
    toolNodes: result.toolNodes.map((toolNode) => ({ ...toolNode })),
    issues: result.issues.map((issue) => ({ ...issue })),
    permissions,
    ...(options.metadata ? { metadata: { ...options.metadata } } : {})
  }
}

export const isMagicAgentGraphSafeWithoutExplicitTools = (
  graph: MagicAgentGraphDefinition
): boolean => !graph.nodes.some((node) => node.kind === 'tool')
