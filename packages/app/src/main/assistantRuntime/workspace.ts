import fs from 'fs/promises'
import fsSync from 'fs'
import type { Dirent } from 'fs'
import path from 'path'
import { Config } from '@shared/config/config'
import { getBuildEnv } from '../config/buildEnv'
import {
  AssistantWorkspaceAccessMode,
  AssistantWorkspaceGovernanceAction,
  AssistantArtifactRef,
  AssistantContextSnapshot,
  AssistantPinnedContext,
  AssistantPinnedNote,
  AssistantRoute,
  AssistantReusableContextPack,
  AssistantRunOrigin,
  AssistantQualityGateState,
  AssistantTaskContext,
  AssistantTaskContextArtifact,
  AssistantTaskContextRun,
  AssistantTaskGroupAction,
  AssistantTaskGroupState,
  AssistantRunStatus,
  AssistantWorkspaceMeta,
  AssistantWorkspaceState,
  getAssistantSessionKey
} from './types'

const WORKSPACE_ROOT_DIRNAME = 'chat-workspaces'
const WORKSPACE_IDENTITY_DIRNAME = '_workspaces'
const MAX_TASK_CONTEXT_RUNS = 8
const MAX_TASK_CONTEXT_ARTIFACT_IDS = 24
const MAX_TASK_CONTEXT_ARTIFACTS = 12
const MAX_TASK_CONTEXT_TOOL_NAMES = 24
const MAX_PINNED_NOTES = 8
const MAX_WORKSPACE_SHARED_NOTES = 8
const MAX_PROMPT_MEMORY_CHARS = 2000
const MAX_PROMPT_TEXT_CHARS = 400
const QUALITY_GATE_STATUSES = new Set<AssistantQualityGateState['status']>([
  'unknown',
  'pending',
  'passing',
  'warning',
  'failed'
])

const sanitizePathSegment = (value: string): string =>
  String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'default'

const normalizeQualityGateState = (
  qualityGate?: Partial<AssistantQualityGateState> | null
): AssistantQualityGateState | undefined => {
  const gateId = cleanString(qualityGate?.gateId, 120)
  if (!gateId) return undefined

  const status = cleanString(qualityGate?.status, 32)
  const checks = Array.isArray(qualityGate?.checks)
    ? qualityGate.checks
        .map((check) => {
          const checkId = cleanString(check?.checkId, 120)
          const checkStatus = cleanString(check?.status, 32)
          if (
            !checkId ||
            !checkStatus ||
            !QUALITY_GATE_STATUSES.has(checkStatus as AssistantQualityGateState['status'])
          ) {
            return undefined
          }

          return {
            checkId,
            ...(cleanString(check?.label, 120) ? { label: cleanString(check?.label, 120) } : {}),
            status: checkStatus as AssistantQualityGateState['status'],
            ...(cleanString(check?.detail, 400) ? { detail: cleanString(check?.detail, 400) } : {}),
            updatedAt: Number.isFinite(check?.updatedAt) ? Number(check?.updatedAt) : Date.now()
          }
        })
        .filter((check): check is NonNullable<typeof check> => Boolean(check))
    : []

  return {
    gateId,
    status:
      status && QUALITY_GATE_STATUSES.has(status as AssistantQualityGateState['status'])
        ? (status as AssistantQualityGateState['status'])
        : 'unknown',
    updatedAt: Number.isFinite(qualityGate?.updatedAt)
      ? Number(qualityGate?.updatedAt)
      : Date.now(),
    ...(cleanString(qualityGate?.summary, 400)
      ? { summary: cleanString(qualityGate?.summary, 400) }
      : {}),
    ...(checks.length ? { checks } : {})
  }
}

export const getAssistantWorkspaceBaseDir = (): string => {
  const baseDir = getBuildEnv().pathMap.data
  return path.join(baseDir, WORKSPACE_ROOT_DIRNAME)
}

const getDefaultWorkspaceId = (route: AssistantRoute): string =>
  `workspace-${sanitizePathSegment(getAssistantSessionKey(route))}`

export const getDefaultAssistantWorkspaceId = (route: AssistantRoute): string =>
  getDefaultWorkspaceId(route)

export const isDefaultAssistantWorkspaceId = (
  route: AssistantRoute,
  workspaceId?: string
): boolean => cleanString(workspaceId, 120) === getDefaultWorkspaceId(route)

const getAssistantWorkspaceIdentityDir = (workspaceId: string): string =>
  path.join(
    getAssistantWorkspaceBaseDir(),
    WORKSPACE_IDENTITY_DIRNAME,
    sanitizePathSegment(workspaceId)
  )

export const getAssistantWorkspaceIdentityState = (
  workspaceId: string
): Pick<AssistantWorkspaceState, 'workspaceId' | 'workspaceRootDir' | 'workspaceMetaFile'> => {
  const resolvedWorkspaceId = cleanString(workspaceId, 120) || 'workspace-default'
  const workspaceRootDir = getAssistantWorkspaceIdentityDir(resolvedWorkspaceId)
  return {
    workspaceId: resolvedWorkspaceId,
    workspaceRootDir,
    workspaceMetaFile: path.join(workspaceRootDir, 'workspace.json')
  }
}

export const getAssistantWorkspaceState = (
  route: AssistantRoute,
  workspaceId?: string
): AssistantWorkspaceState => {
  const sessionKey = getAssistantSessionKey(route)
  const rootDir = path.join(getAssistantWorkspaceBaseDir(), sanitizePathSegment(sessionKey))
  const resolvedWorkspaceId = cleanString(workspaceId, 120) || getDefaultWorkspaceId(route)
  const workspaceRootDir = getAssistantWorkspaceIdentityDir(resolvedWorkspaceId)
  const memoryDir = path.join(rootDir, 'memory')
  const dateToken = new Date().toISOString().slice(0, 10)

  return {
    workspaceId: resolvedWorkspaceId,
    workspaceRootDir,
    workspaceMetaFile: path.join(workspaceRootDir, 'workspace.json'),
    rootDir,
    memoryDir,
    memoryFile: path.join(memoryDir, `${dateToken}.md`),
    contextFile: path.join(rootDir, 'context.json'),
    taskContextFile: path.join(rootDir, 'task-context.json'),
    pinnedContextFile: path.join(rootDir, 'pinned-context.json')
  }
}

export const ensureAssistantWorkspaceState = async (
  route: AssistantRoute,
  workspaceId?: string
): Promise<AssistantWorkspaceState> => {
  const workspace = getAssistantWorkspaceState(route, workspaceId)
  await fs.mkdir(workspace.memoryDir, { recursive: true })
  await fs.mkdir(workspace.workspaceRootDir, { recursive: true })
  return workspace
}

export const buildAssistantContextSnapshot = (
  route: AssistantRoute,
  config: Config,
  workspaceId?: string
): AssistantContextSnapshot => ({
  clientId: config.client_id,
  sessionKey: getAssistantSessionKey(route),
  workspaceId: cleanString(workspaceId, 120) || getDefaultWorkspaceId(route),
  route,
  generatedAt: Date.now(),
  workflowDir: config.workflow_dir,
  outputDir: config.output_dir,
  downloadDir: config.download_dir,
  useRemoteComfyUI: Boolean(config.use_remote_comfyui),
  useRemoteLLM: Boolean(config.use_remote_llm),
  localLLMServerEnabled: Boolean(config.local_llm_server_config?.enable_server)
})

export const persistAssistantContextSnapshot = async (
  workspace: AssistantWorkspaceState,
  snapshot: AssistantContextSnapshot
): Promise<void> => {
  await fs.mkdir(path.dirname(workspace.contextFile), { recursive: true })
  await fs.writeFile(workspace.contextFile, JSON.stringify(snapshot, null, 2), 'utf8')
}

export const readAssistantWorkspaceMeta = async (
  workspace: AssistantWorkspaceState
): Promise<AssistantWorkspaceMeta | undefined> => {
  const raw = await readOptionalTextFile(workspace.workspaceMetaFile)
  if (!raw) return undefined

  try {
    return JSON.parse(raw) as AssistantWorkspaceMeta
  } catch (error) {
    console.warn('[AssistantWorkspace] Failed to parse workspace metadata:', error)
    return undefined
  }
}

export const readAssistantWorkspaceMetaById = async (
  workspaceId: string
): Promise<AssistantWorkspaceMeta | undefined> => {
  const workspace = getAssistantWorkspaceIdentityState(workspaceId)
  const raw = await readOptionalTextFile(workspace.workspaceMetaFile)
  if (!raw) return undefined

  try {
    return JSON.parse(raw) as AssistantWorkspaceMeta
  } catch (error) {
    console.warn('[AssistantWorkspace] Failed to parse workspace metadata by id:', error)
    return undefined
  }
}

export const listAssistantWorkspaceMetas = async (
  limit?: number
): Promise<AssistantWorkspaceMeta[]> => {
  const identityRoot = path.join(getAssistantWorkspaceBaseDir(), WORKSPACE_IDENTITY_DIRNAME)
  let entries: Dirent[]
  try {
    entries = await fs.readdir(identityRoot, { withFileTypes: true })
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') return []
    throw error
  }

  const metas = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const raw = await readOptionalTextFile(
          path.join(identityRoot, entry.name, 'workspace.json')
        )
        if (!raw) return undefined
        try {
          return JSON.parse(raw) as AssistantWorkspaceMeta
        } catch (error) {
          console.warn('[AssistantWorkspace] Failed to parse workspace metadata entry:', error)
          return undefined
        }
      })
  )

  const normalized = metas
    .filter((meta): meta is AssistantWorkspaceMeta => Boolean(meta?.workspaceId))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))

  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return normalized
  }

  return normalized.slice(0, Math.trunc(Number(limit)))
}

export const ensureAssistantWorkspaceBinding = async (
  workspace: AssistantWorkspaceState,
  route: AssistantRoute,
  options?: {
    accessMode?: AssistantWorkspaceAccessMode
  }
): Promise<AssistantWorkspaceMeta> => {
  const existing = await readAssistantWorkspaceMeta(workspace)
  const now = Date.now()
  const sessionKey = getAssistantSessionKey(route)
  const accessMode: AssistantWorkspaceAccessMode =
    options?.accessMode ||
    existing?.accessMode ||
    (isDefaultAssistantWorkspaceId(route, workspace.workspaceId) ? 'private' : 'shared')
  const ownerSessionKey = cleanString(existing?.ownerSessionKey, 200) || sessionKey
  const ownerRoute = existing?.ownerRoute || route
  const foreignAttachedSessionKeys = (existing?.attachedSessionKeys || []).filter(
    (key) => key !== ownerSessionKey
  )
  if (accessMode === 'private' && ownerSessionKey !== sessionKey) {
    throw new Error(
      `Workspace ${workspace.workspaceId} is private to ${ownerSessionKey}. Reattach its owner route with accessMode "shared" before attaching a different route.`
    )
  }
  if (accessMode === 'private' && foreignAttachedSessionKeys.length > 0) {
    throw new Error(
      `Workspace ${workspace.workspaceId} cannot become private while other routes remain attached. Detach the other routes first.`
    )
  }
  const attachedSessionKeys = Array.from(
    new Set(
      accessMode === 'private'
        ? [ownerSessionKey]
        : [...(existing?.attachedSessionKeys || []), sessionKey]
    )
  )
  const routeKeys = new Set<string>()
  const attachedRoutes =
    accessMode === 'private'
      ? [ownerRoute]
      : [...(existing?.attachedRoutes || []), route].filter((candidate) => {
          const key = getAssistantSessionKey(candidate)
          if (routeKeys.has(key)) return false
          routeKeys.add(key)
          return true
        })
  const next: AssistantWorkspaceMeta = {
    workspaceId: workspace.workspaceId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    status: 'active',
    accessMode,
    attachedSessionKeys,
    attachedRoutes,
    ownerSessionKey,
    ownerRoute,
    ...(cleanString(existing?.title, 160) ? { title: cleanString(existing?.title, 160) } : {}),
    ...(cleanString(existing?.description, 600)
      ? { description: cleanString(existing?.description, 600) }
      : {}),
    ...(Array.isArray(existing?.sharedNotes) && existing?.sharedNotes.length
      ? {
          sharedNotes: dedupeStrings(
            existing.sharedNotes.map((note) => cleanString(note, MAX_PROMPT_TEXT_CHARS)),
            MAX_WORKSPACE_SHARED_NOTES
          )
        }
      : {})
  }

  await fs.mkdir(path.dirname(workspace.workspaceMetaFile), { recursive: true })
  await fs.writeFile(workspace.workspaceMetaFile, JSON.stringify(next, null, 2), 'utf8')
  return next
}

export const manageAssistantWorkspaceGovernance = async (
  workspace: Pick<AssistantWorkspaceState, 'workspaceId' | 'workspaceMetaFile'>,
  route: AssistantRoute,
  action: AssistantWorkspaceGovernanceAction
): Promise<AssistantWorkspaceMeta> => {
  const existing = await readAssistantWorkspaceMetaById(workspace.workspaceId)
  if (!existing) {
    throw new Error(
      `Workspace ${workspace.workspaceId} has no recorded governance metadata yet. Attach it before managing policy.`
    )
  }

  const sessionKey = getAssistantSessionKey(route)
  const ownerSessionKey = cleanString(existing.ownerSessionKey, 200) || sessionKey
  const ownerRoute = existing.ownerRoute || route

  if (ownerSessionKey !== sessionKey) {
    throw new Error(
      `Only the workspace owner (${ownerSessionKey}) can ${action} workspace ${workspace.workspaceId}.`
    )
  }

  const attachedSessionKeys = Array.from(new Set(existing.attachedSessionKeys || []))
  const attachedRoutes = (existing.attachedRoutes || []).filter(Boolean)
  const foreignAttachedSessionKeys = attachedSessionKeys.filter((key) => key !== ownerSessionKey)

  const next: AssistantWorkspaceMeta = {
    workspaceId: workspace.workspaceId,
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
    status: existing.status || (attachedSessionKeys.length > 0 ? 'active' : 'archived'),
    accessMode: existing.accessMode || 'shared',
    attachedSessionKeys,
    attachedRoutes,
    ownerSessionKey,
    ownerRoute,
    ...(existing.archivedAt !== undefined ? { archivedAt: existing.archivedAt } : {}),
    ...(cleanString(existing.title, 160) ? { title: cleanString(existing.title, 160) } : {}),
    ...(cleanString(existing.description, 600)
      ? { description: cleanString(existing.description, 600) }
      : {}),
    ...(Array.isArray(existing.sharedNotes) && existing.sharedNotes.length
      ? {
          sharedNotes: dedupeStrings(
            existing.sharedNotes.map((note) => cleanString(note, MAX_PROMPT_TEXT_CHARS)),
            MAX_WORKSPACE_SHARED_NOTES
          )
        }
      : {})
  }

  switch (action) {
    case 'share':
      next.accessMode = 'shared'
      break
    case 'privatize':
      if (foreignAttachedSessionKeys.length > 0) {
        throw new Error(
          `Workspace ${workspace.workspaceId} cannot become private while other routes remain attached. Detach the other routes first.`
        )
      }
      next.accessMode = 'private'
      next.attachedSessionKeys = attachedSessionKeys.includes(ownerSessionKey)
        ? [ownerSessionKey]
        : []
      next.attachedRoutes = attachedRoutes.filter(
        (candidate) => getAssistantSessionKey(candidate) === ownerSessionKey
      )
      if (next.attachedSessionKeys.length > 0 && next.attachedRoutes.length === 0) {
        next.attachedRoutes = [ownerRoute]
      }
      break
    case 'archive':
      if (attachedSessionKeys.length > 0) {
        throw new Error(
          `Workspace ${workspace.workspaceId} cannot be archived while routes remain attached. Detach the routes first.`
        )
      }
      next.status = 'archived'
      next.archivedAt = Date.now()
      break
    case 'revive':
      next.status = 'active'
      delete next.archivedAt
      break
  }

  await fs.mkdir(path.dirname(workspace.workspaceMetaFile), { recursive: true })
  await fs.writeFile(workspace.workspaceMetaFile, JSON.stringify(next, null, 2), 'utf8')
  return next
}

export const detachAssistantWorkspaceBinding = async (
  workspaceId: string,
  route: AssistantRoute
): Promise<AssistantWorkspaceMeta | undefined> => {
  const normalizedWorkspaceId = cleanString(workspaceId, 120)
  if (!normalizedWorkspaceId) return undefined

  const workspace = getAssistantWorkspaceIdentityState(normalizedWorkspaceId)
  const existing = await readAssistantWorkspaceMetaById(normalizedWorkspaceId)
  if (!existing) return undefined

  const sessionKey = getAssistantSessionKey(route)
  const attachedSessionKeys = (existing.attachedSessionKeys || []).filter(
    (key) => key !== sessionKey
  )
  const attachedRoutes = (existing.attachedRoutes || []).filter(
    (candidate) => getAssistantSessionKey(candidate) !== sessionKey
  )
  const archivedAt = attachedSessionKeys.length === 0 ? Date.now() : undefined
  const next: AssistantWorkspaceMeta = {
    workspaceId: normalizedWorkspaceId,
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
    status: attachedSessionKeys.length === 0 ? 'archived' : 'active',
    accessMode: existing.accessMode || 'shared',
    attachedSessionKeys,
    attachedRoutes,
    ...(cleanString(existing.ownerSessionKey, 200)
      ? { ownerSessionKey: cleanString(existing.ownerSessionKey, 200) }
      : {}),
    ...(existing.ownerRoute ? { ownerRoute: existing.ownerRoute } : {}),
    ...(archivedAt !== undefined ? { archivedAt } : {}),
    ...(cleanString(existing.title, 160) ? { title: cleanString(existing.title, 160) } : {}),
    ...(cleanString(existing.description, 600)
      ? { description: cleanString(existing.description, 600) }
      : {}),
    ...(Array.isArray(existing.sharedNotes) && existing.sharedNotes.length
      ? {
          sharedNotes: dedupeStrings(
            existing.sharedNotes.map((note) => cleanString(note, MAX_PROMPT_TEXT_CHARS)),
            MAX_WORKSPACE_SHARED_NOTES
          )
        }
      : {})
  }

  await fs.mkdir(path.dirname(workspace.workspaceMetaFile), { recursive: true })
  await fs.writeFile(workspace.workspaceMetaFile, JSON.stringify(next, null, 2), 'utf8')
  return next
}

export const updateAssistantWorkspaceMeta = async (
  workspace: Pick<AssistantWorkspaceState, 'workspaceId' | 'workspaceMetaFile'>,
  updates: {
    title?: string
    description?: string
    setSharedNotes?: string[]
    appendSharedNote?: string
    accessMode?: AssistantWorkspaceAccessMode
  }
): Promise<AssistantWorkspaceMeta> => {
  const existing = await readAssistantWorkspaceMetaById(workspace.workspaceId)
  if (updates.accessMode === 'private' && new Set(existing?.attachedSessionKeys || []).size > 1) {
    throw new Error(
      `Workspace ${workspace.workspaceId} cannot become private while other routes remain attached. Detach the other routes first.`
    )
  }
  const nextSharedNotes = dedupeStrings(
    [
      ...(updates.setSharedNotes || existing?.sharedNotes || []).map((note) =>
        cleanString(note, MAX_PROMPT_TEXT_CHARS)
      ),
      cleanString(updates.appendSharedNote, MAX_PROMPT_TEXT_CHARS)
    ],
    MAX_WORKSPACE_SHARED_NOTES
  )

  const next: AssistantWorkspaceMeta = {
    workspaceId: workspace.workspaceId,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    status:
      (existing?.attachedSessionKeys?.length || 0) > 0
        ? 'active'
        : existing?.status === 'archived'
          ? 'archived'
          : 'active',
    accessMode:
      updates.accessMode ||
      existing?.accessMode ||
      (existing?.attachedSessionKeys?.length === 1 ? 'private' : 'shared'),
    attachedSessionKeys: existing?.attachedSessionKeys || [],
    attachedRoutes: existing?.attachedRoutes || [],
    ...(cleanString(existing?.ownerSessionKey, 200)
      ? { ownerSessionKey: cleanString(existing?.ownerSessionKey, 200) }
      : {}),
    ...(existing?.ownerRoute ? { ownerRoute: existing.ownerRoute } : {}),
    ...(existing?.status === 'archived' && existing?.archivedAt !== undefined
      ? { archivedAt: existing.archivedAt }
      : {}),
    ...(cleanString(updates.title, 160) || cleanString(existing?.title, 160)
      ? { title: cleanString(updates.title, 160) || cleanString(existing?.title, 160) }
      : {}),
    ...(cleanString(updates.description, 600) || cleanString(existing?.description, 600)
      ? {
          description:
            cleanString(updates.description, 600) || cleanString(existing?.description, 600)
        }
      : {}),
    ...(nextSharedNotes.length ? { sharedNotes: nextSharedNotes } : {})
  }

  await fs.mkdir(path.dirname(workspace.workspaceMetaFile), { recursive: true })
  await fs.writeFile(workspace.workspaceMetaFile, JSON.stringify(next, null, 2), 'utf8')
  return next
}

export const appendAssistantMemoryLog = async (
  workspace: AssistantWorkspaceState,
  entry: {
    title: string
    requestText?: string
    responseText?: string
    status: string
    profileId?: string
  }
): Promise<void> => {
  await fs.mkdir(workspace.memoryDir, { recursive: true })
  const lines = [
    `## ${new Date().toISOString()}`,
    `- Title: ${entry.title}`,
    `- Status: ${entry.status}`,
    ...(entry.profileId ? [`- Profile: ${entry.profileId}`] : []),
    ...(entry.requestText ? [`- Request: ${entry.requestText}`] : []),
    ...(entry.responseText ? [`- Response: ${entry.responseText}`] : []),
    ''
  ]
  await fs.appendFile(workspace.memoryFile, `${lines.join('\n')}\n`, 'utf8')
}

const readOptionalTextFile = async (filePath: string): Promise<string | undefined> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const trimmed = raw.trim()
    return trimmed || undefined
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') return undefined
    throw error
  }
}

const cleanString = (
  value?: string | null,
  maxLength = MAX_PROMPT_TEXT_CHARS
): string | undefined => {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized
}

const dedupeStrings = (values: Array<string | undefined>, limit: number): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = cleanString(value, 200)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= limit) break
  }
  return result
}

export const normalizeArtifactLineage = (
  lineage?: Partial<AssistantArtifactRef['lineage']> | null
): AssistantArtifactRef['lineage'] | undefined => {
  if (!lineage) return undefined

  const taskGroupId = cleanString(lineage.taskGroupId, 120)
  const taskGroupAction = cleanString(lineage.taskGroupAction, 32) as
    | AssistantTaskGroupAction
    | undefined
  const workspaceRunId = cleanString(lineage.workspaceRunId, 120)
  const workspaceId = cleanString(lineage.workspaceId, 120)
  const rootRunId = cleanString(lineage.rootRunId, 120)
  const parentArtifactId = cleanString(lineage.parentArtifactId, 120)

  if (
    !taskGroupId &&
    !taskGroupAction &&
    !workspaceRunId &&
    !workspaceId &&
    !rootRunId &&
    !parentArtifactId
  ) {
    return undefined
  }

  return {
    ...(taskGroupId ? { taskGroupId } : {}),
    ...(taskGroupAction ? { taskGroupAction } : {}),
    ...(workspaceRunId ? { workspaceRunId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(rootRunId ? { rootRunId } : {}),
    ...(parentArtifactId ? { parentArtifactId } : {})
  }
}

export const normalizeTaskGroupState = (
  taskGroup?: Partial<AssistantTaskGroupState> | null
): AssistantTaskGroupState | undefined => {
  const taskGroupId = cleanString(taskGroup?.taskGroupId, 120)
  if (!taskGroupId) return undefined

  const status = cleanString(taskGroup?.status, 32)
  const approvedBy = cleanString(taskGroup?.approvedBy, 120)
  const exportTarget = cleanString(taskGroup?.exportTarget, 400)
  const workspaceRunId = cleanString(taskGroup?.workspaceRunId, 120)
  const rootRunId = cleanString(taskGroup?.rootRunId, 120)
  const approvedAt = Number.isFinite(taskGroup?.approvedAt)
    ? Number(taskGroup?.approvedAt)
    : undefined
  const exportedAt = Number.isFinite(taskGroup?.exportedAt)
    ? Number(taskGroup?.exportedAt)
    : undefined
  const exportArtifactIds = Array.isArray(taskGroup?.exportArtifactIds)
    ? dedupeStrings(taskGroup.exportArtifactIds, MAX_TASK_CONTEXT_ARTIFACT_IDS)
    : []
  const updatedAt = Number.isFinite(taskGroup?.updatedAt)
    ? Number(taskGroup?.updatedAt)
    : Date.now()
  const qualityGate =
    normalizeQualityGateState(taskGroup?.qualityGate) ||
    normalizeQualityGateState({
      gateId: `${taskGroupId}:quality-gate`,
      status:
        status && ['approved', 'exported'].includes(status)
          ? 'passing'
          : status === 'cancelled'
            ? 'failed'
            : status === 'running'
              ? 'pending'
              : 'unknown',
      updatedAt,
      ...(cleanString(taskGroup?.title, 160)
        ? { summary: `${cleanString(taskGroup?.title, 160)} quality gate` }
        : {}),
      checks: [
        {
          checkId: `${taskGroupId}:status`,
          ...(cleanString(taskGroup?.title, 160)
            ? { label: cleanString(taskGroup?.title, 160) }
            : {}),
          status:
            status && ['approved', 'exported'].includes(status)
              ? 'passing'
              : status === 'cancelled'
                ? 'failed'
                : status === 'running'
                  ? 'pending'
                  : 'unknown',
          ...(cleanString(taskGroup?.description, 600)
            ? { detail: cleanString(taskGroup?.description, 600) }
            : {}),
          updatedAt
        }
      ]
    })
  return {
    taskGroupId,
    ...(cleanString(taskGroup?.title, 160) ? { title: cleanString(taskGroup?.title, 160) } : {}),
    ...(cleanString(taskGroup?.description, 600)
      ? { description: cleanString(taskGroup?.description, 600) }
      : {}),
    status:
      status &&
      ['draft', 'running', 'waiting-approval', 'approved', 'exported', 'cancelled'].includes(status)
        ? (status as AssistantTaskGroupState['status'])
        : 'draft',
    ...(taskGroup?.progress
      ? {
          progress: {
            ...(Number.isFinite(taskGroup.progress.completed)
              ? { completed: Number(taskGroup.progress.completed) }
              : {}),
            ...(Number.isFinite(taskGroup.progress.total)
              ? { total: Number(taskGroup.progress.total) }
              : {}),
            ...(Number.isFinite(taskGroup.progress.percent)
              ? { percent: Number(taskGroup.progress.percent) }
              : {}),
            ...(cleanString(taskGroup.progress.label, 160)
              ? { label: cleanString(taskGroup.progress.label, 160) }
              : {}),
            updatedAt: Number.isFinite(taskGroup.progress.updatedAt)
              ? Number(taskGroup.progress.updatedAt)
              : Date.now()
          }
        }
      : {}),
    ...(approvedAt !== undefined ? { approvedAt } : {}),
    ...(approvedBy ? { approvedBy } : {}),
    ...(exportedAt !== undefined ? { exportedAt } : {}),
    ...(exportTarget ? { exportTarget } : {}),
    ...(exportArtifactIds.length ? { exportArtifactIds } : {}),
    ...(workspaceRunId ? { workspaceRunId } : {}),
    ...(rootRunId ? { rootRunId } : {}),
    qualityGate,
    updatedAt
  }
}

const normalizeTaskContextArtifact = (
  artifact?: Partial<AssistantTaskContextArtifact> | Partial<AssistantArtifactRef> | null
): AssistantTaskContextArtifact | undefined => {
  const artifactId = cleanString(artifact?.artifactId, 120)
  const runId = cleanString(artifact?.runId, 120)
  const kind = cleanString(artifact?.kind, 32) as AssistantTaskContextArtifact['kind'] | undefined
  const source = cleanString(artifact?.source, 32) as
    | AssistantTaskContextArtifact['source']
    | undefined

  if (!artifactId || !runId || !kind || !source) return undefined

  return {
    artifactId,
    runId,
    kind,
    ...(cleanString(artifact?.url, 400) ? { url: cleanString(artifact?.url, 400) } : {}),
    ...(cleanString(artifact?.mimeType, 120)
      ? { mimeType: cleanString(artifact?.mimeType, 120) }
      : {}),
    ...(cleanString(artifact?.fileName, 160)
      ? { fileName: cleanString(artifact?.fileName, 160) }
      : {}),
    createdAt: Number.isFinite(artifact?.createdAt) ? Number(artifact?.createdAt) : Date.now(),
    source,
    ...(artifact?.lineage ? { lineage: normalizeArtifactLineage(artifact.lineage) } : {})
  }
}

const dedupeArtifacts = (
  artifacts: Array<Partial<AssistantTaskContextArtifact> | Partial<AssistantArtifactRef> | null>,
  limit: number
): AssistantTaskContextArtifact[] => {
  const seen = new Set<string>()
  const result: AssistantTaskContextArtifact[] = []

  for (const artifact of artifacts) {
    const normalized = normalizeTaskContextArtifact(artifact)
    if (!normalized || seen.has(normalized.artifactId)) continue
    seen.add(normalized.artifactId)
    result.push(normalized)
    if (result.length >= limit) break
  }

  return result
}

const normalizePinnedNote = (
  note?: Partial<AssistantPinnedNote> | null
): AssistantPinnedNote | undefined => {
  const noteId = cleanString(note?.noteId, 120)
  const text = cleanString(note?.text, MAX_PROMPT_TEXT_CHARS)

  if (!noteId || !text) return undefined

  return {
    noteId,
    text,
    createdAt: Number.isFinite(note?.createdAt) ? Number(note?.createdAt) : Date.now(),
    updatedAt: Number.isFinite(note?.updatedAt) ? Number(note?.updatedAt) : Date.now()
  }
}

const normalizePinnedContext = (
  route: AssistantRoute,
  pinnedContext?: Partial<AssistantPinnedContext> | null
): AssistantPinnedContext => {
  const sessionKey = getAssistantSessionKey(route)
  const notes = Array.isArray(pinnedContext?.notes)
    ? pinnedContext.notes
        .map((note) => normalizePinnedNote(note))
        .filter((note): note is AssistantPinnedNote => Boolean(note))
        .slice(0, MAX_PINNED_NOTES)
    : []

  return {
    sessionKey,
    route,
    createdAt: Number.isFinite(pinnedContext?.createdAt)
      ? Number(pinnedContext?.createdAt)
      : Date.now(),
    updatedAt: Number.isFinite(pinnedContext?.updatedAt)
      ? Number(pinnedContext?.updatedAt)
      : Date.now(),
    notes
  }
}

export const readAssistantMemoryPreview = async (
  workspace: AssistantWorkspaceState
): Promise<string | undefined> => {
  return readOptionalTextFile(workspace.memoryFile)
}

export const readAssistantMemoryPreviewFromFile = async (
  memoryFile: string
): Promise<string | undefined> => readOptionalTextFile(memoryFile)

const normalizeTaskContext = (
  route: AssistantRoute,
  taskContext?: Partial<AssistantTaskContext> | null
): AssistantTaskContext => {
  const sessionKey = getAssistantSessionKey(route)
  const recentRuns = Array.isArray(taskContext?.recentRuns)
    ? taskContext.recentRuns
        .filter((run): run is AssistantTaskContextRun => Boolean(run?.runId))
        .slice(0, MAX_TASK_CONTEXT_RUNS)
    : []

  return {
    sessionKey,
    workspaceId: cleanString(taskContext?.workspaceId, 120) || getDefaultWorkspaceId(route),
    route,
    createdAt: Number.isFinite(taskContext?.createdAt)
      ? Number(taskContext?.createdAt)
      : Date.now(),
    updatedAt: Number.isFinite(taskContext?.updatedAt)
      ? Number(taskContext?.updatedAt)
      : Date.now(),
    latestStatus: taskContext?.latestStatus,
    latestProfileId: cleanString(taskContext?.latestProfileId),
    latestRequestText: cleanString(taskContext?.latestRequestText),
    latestResponseText: cleanString(taskContext?.latestResponseText),
    latestErrorMessage: cleanString(taskContext?.latestErrorMessage),
    recentArtifactIds: dedupeStrings(
      taskContext?.recentArtifactIds || [],
      MAX_TASK_CONTEXT_ARTIFACT_IDS
    ),
    recentArtifacts: dedupeArtifacts(
      taskContext?.recentArtifacts || [],
      MAX_TASK_CONTEXT_ARTIFACTS
    ),
    recentToolNames: dedupeStrings(taskContext?.recentToolNames || [], MAX_TASK_CONTEXT_TOOL_NAMES),
    ...(taskContext?.taskGroup
      ? { taskGroup: normalizeTaskGroupState(taskContext.taskGroup) }
      : {}),
    recentRuns: recentRuns.map((run) => ({
      runId: run.runId,
      workspaceId:
        cleanString((run as { workspaceId?: string } | undefined)?.workspaceId, 120) ||
        getDefaultWorkspaceId(route),
      status: run.status as AssistantRunStatus,
      runOrigin:
        (cleanString(
          (run as { runOrigin?: string } | undefined)?.runOrigin,
          32
        ) as AssistantRunOrigin) || 'new',
      updatedAt: Number.isFinite(run.updatedAt) ? Number(run.updatedAt) : Date.now(),
      rootRunId:
        cleanString((run as { rootRunId?: string } | undefined)?.rootRunId, 120) || run.runId,
      ...(cleanString((run as { parentRunId?: string } | undefined)?.parentRunId, 120)
        ? {
            parentRunId: cleanString(
              (run as { parentRunId?: string } | undefined)?.parentRunId,
              120
            )
          }
        : {}),
      ...(cleanString((run as { resumeSourceRunId?: string } | undefined)?.resumeSourceRunId, 120)
        ? {
            resumeSourceRunId: cleanString(
              (run as { resumeSourceRunId?: string } | undefined)?.resumeSourceRunId,
              120
            )
          }
        : {}),
      ...(Number.isFinite((run as { resumeAttempt?: number } | undefined)?.resumeAttempt)
        ? {
            resumeAttempt: Number((run as { resumeAttempt?: number } | undefined)?.resumeAttempt)
          }
        : {}),
      ...(cleanString((run as { resumeMode?: string } | undefined)?.resumeMode, 32)
        ? {
            resumeMode: cleanString(
              (run as { resumeMode?: string } | undefined)?.resumeMode,
              32
            ) as 'requeue'
          }
        : {}),
      profileId: cleanString(run.profileId),
      requestText: cleanString(run.requestText),
      responseText: cleanString(run.responseText),
      errorMessage: cleanString(run.errorMessage),
      artifactIds: dedupeStrings(run.artifactIds || [], MAX_TASK_CONTEXT_ARTIFACT_IDS),
      toolNames: dedupeStrings(run.toolNames || [], MAX_TASK_CONTEXT_TOOL_NAMES),
      ...(run.taskGroup ? { taskGroup: normalizeTaskGroupState(run.taskGroup) } : {})
    }))
  }
}

export const readAssistantTaskContext = async (
  workspace: AssistantWorkspaceState
): Promise<AssistantTaskContext | undefined> =>
  readAssistantTaskContextFromFile(workspace.taskContextFile)

export const readAssistantPinnedContext = async (
  workspace: AssistantWorkspaceState
): Promise<AssistantPinnedContext | undefined> =>
  readAssistantPinnedContextFromFile(workspace.pinnedContextFile)

export const readAssistantContextSnapshot = async (
  workspace: AssistantWorkspaceState
): Promise<AssistantContextSnapshot | undefined> =>
  readAssistantContextSnapshotFromFile(workspace.contextFile)

export const readAssistantContextSnapshotFromFile = async (
  contextFile: string
): Promise<AssistantContextSnapshot | undefined> => {
  const raw = await readOptionalTextFile(contextFile)
  if (!raw) return undefined

  try {
    return JSON.parse(raw) as AssistantContextSnapshot
  } catch (error) {
    console.warn('[AssistantWorkspace] Failed to parse context snapshot:', error)
    return undefined
  }
}

export const readAssistantTaskContextFromFile = async (
  taskContextFile: string
): Promise<AssistantTaskContext | undefined> => {
  const raw = await readOptionalTextFile(taskContextFile)
  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw) as Partial<AssistantTaskContext>
    if (!parsed?.route) return undefined
    return normalizeTaskContext(parsed.route, parsed)
  } catch (error) {
    console.warn('[AssistantWorkspace] Failed to parse task context:', error)
    return undefined
  }
}

export const readAssistantPinnedContextFromFile = async (
  pinnedContextFile: string
): Promise<AssistantPinnedContext | undefined> => {
  const raw = await readOptionalTextFile(pinnedContextFile)
  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw) as Partial<AssistantPinnedContext>
    if (!parsed?.route) return undefined
    return normalizePinnedContext(parsed.route, parsed)
  } catch (error) {
    console.warn('[AssistantWorkspace] Failed to parse pinned context:', error)
    return undefined
  }
}

export const updateAssistantTaskContext = async (
  workspace: AssistantWorkspaceState,
  entry: {
    route: AssistantRoute
    runId: string
    workspaceId: string
    status: AssistantRunStatus
    runOrigin?: AssistantRunOrigin
    updatedAt?: number
    parentRunId?: string
    rootRunId?: string
    resumeSourceRunId?: string
    resumeAttempt?: number
    resumeMode?: 'requeue'
    profileId?: string
    requestText?: string
    responseText?: string
    errorMessage?: string
    artifactIds?: string[]
    artifacts?: AssistantArtifactRef[]
    toolCalls?: Array<{
      toolName: string
    }>
    taskGroup?: Partial<AssistantTaskGroupState> | null
  }
): Promise<AssistantTaskContext> => {
  const previous = await readAssistantTaskContext(workspace)
  const updatedAt = Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : Date.now()
  const nextRun: AssistantTaskContextRun = {
    runId: entry.runId,
    workspaceId: cleanString(entry.workspaceId, 120) || getDefaultWorkspaceId(entry.route),
    status: entry.status,
    runOrigin: entry.runOrigin || 'new',
    updatedAt,
    ...(cleanString(entry.parentRunId, 120)
      ? { parentRunId: cleanString(entry.parentRunId, 120) }
      : {}),
    rootRunId: cleanString(entry.rootRunId, 120) || entry.runId,
    ...(cleanString(entry.resumeSourceRunId, 120)
      ? { resumeSourceRunId: cleanString(entry.resumeSourceRunId, 120) }
      : {}),
    ...(Number.isFinite(entry.resumeAttempt) ? { resumeAttempt: Number(entry.resumeAttempt) } : {}),
    ...(cleanString(entry.resumeMode, 32)
      ? { resumeMode: cleanString(entry.resumeMode, 32) as 'requeue' }
      : {}),
    ...(cleanString(entry.profileId) ? { profileId: cleanString(entry.profileId) } : {}),
    ...(cleanString(entry.requestText) ? { requestText: cleanString(entry.requestText) } : {}),
    ...(cleanString(entry.responseText) ? { responseText: cleanString(entry.responseText) } : {}),
    ...(cleanString(entry.errorMessage) ? { errorMessage: cleanString(entry.errorMessage) } : {}),
    artifactIds: dedupeStrings(entry.artifactIds || [], MAX_TASK_CONTEXT_ARTIFACT_IDS),
    toolNames: dedupeStrings(
      (entry.toolCalls || []).map((toolCall) => toolCall.toolName),
      MAX_TASK_CONTEXT_TOOL_NAMES
    ),
    ...(entry.taskGroup ? { taskGroup: normalizeTaskGroupState(entry.taskGroup) } : {})
  }

  const normalized = normalizeTaskContext(entry.route, {
    ...(previous || {}),
    workspaceId: cleanString(entry.workspaceId, 120) || previous?.workspaceId,
    updatedAt,
    latestStatus: entry.status,
    latestProfileId: cleanString(entry.profileId) || previous?.latestProfileId,
    latestRequestText: cleanString(entry.requestText) || previous?.latestRequestText,
    latestResponseText: cleanString(entry.responseText) || previous?.latestResponseText,
    latestErrorMessage: cleanString(entry.errorMessage),
    recentArtifactIds: [...nextRun.artifactIds, ...(previous?.recentArtifactIds || [])],
    recentArtifacts: [...(entry.artifacts || []), ...(previous?.recentArtifacts || [])],
    recentToolNames: [...nextRun.toolNames, ...(previous?.recentToolNames || [])],
    recentRuns: [
      nextRun,
      ...(previous?.recentRuns || []).filter((run) => run.runId !== entry.runId)
    ]
  })

  await fs.mkdir(path.dirname(workspace.taskContextFile), { recursive: true })
  await fs.writeFile(workspace.taskContextFile, JSON.stringify(normalized, null, 2), 'utf8')
  return normalized
}

export const updateAssistantPinnedContext = async (
  workspace: AssistantWorkspaceState,
  entry: {
    route: AssistantRoute
    action: 'add' | 'remove' | 'clear'
    text?: string
    noteId?: string
    index?: number
    updatedAt?: number
  }
): Promise<AssistantPinnedContext> => {
  const previous = await readAssistantPinnedContext(workspace)
  const updatedAt = Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : Date.now()
  const normalizedRoute = entry.route
  const current = normalizePinnedContext(normalizedRoute, previous)
  let notes = [...current.notes]

  if (entry.action === 'add') {
    const text = cleanString(entry.text, MAX_PROMPT_TEXT_CHARS)
    if (!text) {
      throw new Error('Pinned note text is required.')
    }
    notes = [
      {
        noteId: crypto.randomUUID(),
        text,
        createdAt: updatedAt,
        updatedAt
      },
      ...notes
    ].slice(0, MAX_PINNED_NOTES)
  } else if (entry.action === 'remove') {
    const noteId = cleanString(entry.noteId, 120)
    const index =
      Number.isFinite(entry.index) && Number(entry.index) > 0 ? Math.trunc(Number(entry.index)) : 0
    const nextNotes = noteId
      ? notes.filter((note) => note.noteId !== noteId)
      : index > 0
        ? notes.filter((_note, noteIndex) => noteIndex !== index - 1)
        : notes

    if (nextNotes.length === notes.length) {
      throw new Error('Pinned note not found.')
    }
    notes = nextNotes
  } else {
    notes = []
  }

  const normalized = normalizePinnedContext(normalizedRoute, {
    ...(previous || {}),
    updatedAt,
    notes
  })

  await fs.mkdir(path.dirname(workspace.pinnedContextFile), { recursive: true })
  await fs.writeFile(workspace.pinnedContextFile, JSON.stringify(normalized, null, 2), 'utf8')
  return normalized
}

export const formatAssistantPinnedContext = (pinnedContext?: AssistantPinnedContext): string => {
  if (!pinnedContext?.notes.length) {
    return 'No pinned context notes for this session yet.'
  }

  return [
    'Pinned context notes:',
    ...pinnedContext.notes.map((note, index) => `${index + 1}. [${note.noteId}] ${note.text}`)
  ].join('\n')
}

export const readAssistantReusableContextPack = async (
  workspace: AssistantWorkspaceState
): Promise<AssistantReusableContextPack> =>
  readAssistantReusableContextPackFromFiles({
    contextFile: workspace.contextFile,
    taskContextFile: workspace.taskContextFile,
    pinnedContextFile: workspace.pinnedContextFile,
    memoryFile: workspace.memoryFile,
    workspaceMetaFile: workspace.workspaceMetaFile
  })

export const readAssistantReusableContextPackFromFiles = async (files: {
  contextFile?: string
  taskContextFile?: string
  pinnedContextFile?: string
  memoryFile?: string
  workspaceMetaFile?: string
}): Promise<AssistantReusableContextPack> => {
  const [contextSnapshot, taskContext, pinnedContext, memoryPreview, workspaceMeta] =
    await Promise.all([
      files.contextFile
        ? readAssistantContextSnapshotFromFile(files.contextFile)
        : Promise.resolve(undefined),
      files.taskContextFile
        ? readAssistantTaskContextFromFile(files.taskContextFile)
        : Promise.resolve(undefined),
      files.pinnedContextFile
        ? readAssistantPinnedContextFromFile(files.pinnedContextFile)
        : Promise.resolve(undefined),
      files.memoryFile
        ? readAssistantMemoryPreviewFromFile(files.memoryFile)
        : Promise.resolve(undefined),
      files.workspaceMetaFile
        ? readOptionalWorkspaceMetaFile(files.workspaceMetaFile)
        : Promise.resolve(undefined)
    ])

  return {
    ...(contextSnapshot ? { contextSnapshot } : {}),
    ...(taskContext ? { taskContext } : {}),
    ...(pinnedContext ? { pinnedContext } : {}),
    ...(memoryPreview ? { memoryPreview } : {}),
    ...(workspaceMeta ? { workspaceMeta } : {})
  }
}

export const clearAssistantReusableContext = async (
  workspace: AssistantWorkspaceState
): Promise<void> => {
  await fs.rm(workspace.taskContextFile, { force: true })
  await fs.rm(workspace.pinnedContextFile, { force: true })
  await fs.rm(workspace.memoryDir, { recursive: true, force: true })
  await fs.mkdir(workspace.memoryDir, { recursive: true })
}

export const buildAssistantReusableContextPrompt = (
  pack: AssistantReusableContextPack
): string | undefined => {
  const contextSnapshot = pack.contextSnapshot
  const taskContext = pack.taskContext
  const pinnedContext = pack.pinnedContext
  const memoryPreview = cleanString(pack.memoryPreview, MAX_PROMPT_MEMORY_CHARS)
  const workspaceMeta = pack.workspaceMeta

  if (!contextSnapshot && !taskContext && !pinnedContext && !memoryPreview && !workspaceMeta) {
    return undefined
  }

  const promptPayload = taskContext
    ? {
        sessionKey: taskContext.sessionKey,
        latestStatus: taskContext.latestStatus,
        latestProfileId: taskContext.latestProfileId,
        latestRequestText: taskContext.latestRequestText,
        latestResponseText: taskContext.latestResponseText,
        latestErrorMessage: taskContext.latestErrorMessage,
        recentToolNames: taskContext.recentToolNames,
        recentArtifactIds: taskContext.recentArtifactIds,
        recentArtifacts: taskContext.recentArtifacts,
        recentRuns: taskContext.recentRuns,
        ...(taskContext.taskGroup ? { taskGroup: taskContext.taskGroup } : {})
      }
    : undefined

  const pinnedPayload = pinnedContext?.notes.length
    ? {
        sessionKey: pinnedContext.sessionKey,
        notes: pinnedContext.notes
      }
    : undefined
  const workspacePayload = workspaceMeta
    ? {
        workspaceId: workspaceMeta.workspaceId,
        ...(workspaceMeta.title ? { title: workspaceMeta.title } : {}),
        ...(workspaceMeta.description ? { description: workspaceMeta.description } : {}),
        ...(workspaceMeta.sharedNotes?.length ? { sharedNotes: workspaceMeta.sharedNotes } : {})
      }
    : undefined

  return [
    'MagicPot reusable session context. Treat this as background workspace state rather than a user message.',
    ...(workspacePayload
      ? [
          JSON.stringify(
            {
              workspaceMeta: workspacePayload
            },
            null,
            2
          )
        ]
      : []),
    ...(contextSnapshot ? [JSON.stringify(contextSnapshot, null, 2)] : []),
    ...(pinnedPayload
      ? [
          JSON.stringify(
            {
              pinnedContext: pinnedPayload
            },
            null,
            2
          )
        ]
      : []),
    ...(promptPayload ? [JSON.stringify(promptPayload, null, 2)] : []),
    ...(memoryPreview ? [`Recent workspace memory:\n${memoryPreview}`] : []),
    'Use this context when it clarifies the current request, but do not quote it back unless it is directly relevant.'
  ].join('\n\n')
}

const readOptionalWorkspaceMetaFile = async (
  workspaceMetaFile: string
): Promise<AssistantWorkspaceMeta | undefined> => {
  const raw = await readOptionalTextFile(workspaceMetaFile)
  if (!raw) return undefined

  try {
    return JSON.parse(raw) as AssistantWorkspaceMeta
  } catch (error) {
    console.warn('[AssistantWorkspace] Failed to parse reusable workspace metadata:', error)
    return undefined
  }
}
