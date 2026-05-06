import {
  STORAGE_KEY_SELECTED_PROFILE,
  getBaseProfileId,
  scopedStorageKey
} from '../ChatPage/chatPageShared'
import { buildAgentRoute, getAgentSessionKey, type AgentRouteLike } from '@shared/agent'
import {
  PROJECT_CANVAS_MAX_STAGE_SCALE,
  PROJECT_CANVAS_MIN_STAGE_SCALE
} from './projectCanvasViewportScale'

const DEFAULT_GROUP_NAME_ZH_PREFIX = '\u7EC4\u5408'
const REPAIRED_DEFAULT_GROUP_NAME_PREFIXES = [
  '\u7F01\u52EB\u608E',
  '\u7F02\u509A\u5038\u934A\u6401\u5D10\u93BC\u4F78\u78F9'
]

const DEFAULT_AGENT_PANE_ID = 'agent-1'

function toChineseNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  return String(Math.floor(value))
}

function readCanvasLocalStorageValue(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function buildAgentPaneScope(projectId: string, paneId: string): string {
  return `${projectId}.${paneId}`
}

export function resolveActiveAgentPaneId(projectId: string): string {
  return readCanvasLocalStorageValue(`agent.workspace.active.${projectId}`) || DEFAULT_AGENT_PANE_ID
}

export function resolveActiveAgentScope(projectId: string): string {
  return buildAgentPaneScope(projectId, resolveActiveAgentPaneId(projectId))
}

export function resolveCanvasAgentPaneIdFromScope(
  projectId: string,
  scope?: string | null
): string | undefined {
  const normalizedScope = String(scope || '').trim()
  const prefix = `${projectId}.`
  if (!normalizedScope.startsWith(prefix)) return undefined
  const paneId = normalizedScope.slice(prefix.length).trim()
  return paneId || undefined
}

export function buildCanvasAgentRoute(projectId: string, paneId: string): AgentRouteLike {
  return buildAgentRoute({
    channel: 'canvas',
    scopeType: 'thread',
    scopeId: projectId,
    threadId: paneId
  })
}

export function resolveActiveCanvasAgentRoute(projectId: string): AgentRouteLike {
  return buildCanvasAgentRoute(projectId, resolveActiveAgentPaneId(projectId))
}

export function getCanvasAgentSessionKey(projectId: string, paneId: string): string {
  return getAgentSessionKey(buildCanvasAgentRoute(projectId, paneId))
}

export function resolveActiveCanvasAgentSessionKey(projectId: string): string {
  return getCanvasAgentSessionKey(projectId, resolveActiveAgentPaneId(projectId))
}

export function resolveCanvasAgentSessionKeyForScope(
  projectId: string,
  scope?: string | null
): string | undefined {
  const paneId = resolveCanvasAgentPaneIdFromScope(projectId, scope)
  return paneId ? getCanvasAgentSessionKey(projectId, paneId) : undefined
}

export function resolveActiveAgentProfileId(projectId: string): string | null {
  const activePaneId = resolveActiveAgentPaneId(projectId)
  const scope = buildAgentPaneScope(projectId, activePaneId)
  return getBaseProfileId(
    readCanvasLocalStorageValue(scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, scope))
  )
}

export function clampStageScale(
  scale: number,
  maxScale: number = PROJECT_CANVAS_MAX_STAGE_SCALE
): number {
  return Math.max(PROJECT_CANVAS_MIN_STAGE_SCALE, Math.min(maxScale, scale))
}

export function shouldKeepOriginalCanvasImage(src: string, fileName?: string): boolean {
  const normalizedSrc = src.toLowerCase()
  const normalizedFileName = fileName?.toLowerCase() ?? ''
  return (
    normalizedSrc.startsWith('data:image/svg+xml') ||
    normalizedSrc.startsWith('data:image/gif') ||
    normalizedFileName.endsWith('.svg') ||
    normalizedFileName.endsWith('.gif')
  )
}

export function buildNormalizedDefaultGroupName(index: number, language?: string | null): string {
  return language?.startsWith('zh')
    ? `${DEFAULT_GROUP_NAME_ZH_PREFIX}${toChineseNumber(index)}`
    : `Group ${index}`
}

export function shouldRepairNormalizedDefaultGroupName(name: string): boolean {
  return REPAIRED_DEFAULT_GROUP_NAME_PREFIXES.some((prefix) => name.includes(prefix))
}
