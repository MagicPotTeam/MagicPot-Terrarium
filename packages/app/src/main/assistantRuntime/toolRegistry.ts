import { Config } from '@shared/config/config'
import type { PolicyJsonRecord } from '../../shared/magicAgentPlatform2'
import { throwIfAborted } from '@shared/agent'
import { MAGICPOT_SESSION_STATUS_TOOL_NAME, normalizeMagicPotToolName } from '@shared/app/types'
import type { ProjectTraceDocument, ProjectTraceProjectRef } from '@shared/projectTrace'
import { ASSISTANT_SESSION_STORE_LIMITS, AssistantSessionStore } from './sessionStore'
import {
  AssistantPinnedContext,
  AssistantReusableContextPack,
  AssistantRoute,
  AssistantTaskContext,
  AssistantTaskGroupState,
  AssistantTaskState,
  AssistantRuntimeResult,
  AssistantWorkspaceAccessMode,
  AssistantWorkspaceGovernanceAction,
  getAssistantSessionKey
} from './types'
import {
  formatAssistantPinnedContext,
  buildAssistantContextSnapshot,
  detachAssistantWorkspaceBinding,
  clearAssistantReusableContext,
  ensureAssistantWorkspaceBinding,
  ensureAssistantWorkspaceState,
  getAssistantWorkspaceState,
  manageAssistantWorkspaceGovernance,
  persistAssistantContextSnapshot,
  readAssistantReusableContextPackFromFiles,
  updateAssistantWorkspaceMeta,
  updateAssistantPinnedContext
} from './workspace'
import { McpClientManager } from '../mcp/clientManager'
import { getMcpClientManager } from '../mcp/runtime'
import { getMcpRuntimeStatus } from '../mcp/status'
import { prepareAgentTerminalCommand } from './agentTerminal'
import {
  getAssistantTerminalPolicyRuntime,
  type AssistantTerminalPolicyRuntime
} from '../magicAgentPlatform2/productionRuntime'
import {
  createFilesToolPolicyRequest,
  createTerminalPolicyRequest,
  assertPolicyRequest,
  type PolicyRequest
} from '@shared/magicAgentPlatform2'
import {
  FilesToolHost,
  GitToolHost,
  CommandJobsToolHost,
  type CommandJobsConfinementAdapter,
  PythonToolHost,
  NotebookToolHost,
  NotebookExecutionCoordinator,
  PythonNotebookExecutionBoundary,
  probePythonInterpreter,
  createProductionCommandJobsConfinementAdapter,
  createMagicAgentToolAuditSink
} from '../magicAgentPlatform2/toolHost'
import { randomUUID } from 'node:crypto'
import { ProjectTraceFSCli } from '../projectTrace/fs'
import {
  buildProjectTraceReplayBundle,
  buildProjectTraceVerificationBundle,
  normalizeProjectTraceVerificationEvents
} from './projectTraceTools'

export type AssistantToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type AssistantToolCallContext = {
  config: Config
  route: AssistantRoute
  sessionStore: AssistantSessionStore
  taskState: AssistantTaskState
  signal?: AbortSignal
  workspaceMemoryPreview?: string
  workspaceTaskContext?: AssistantTaskContext
  workspacePinnedContext?: AssistantPinnedContext
  workspaceReusableContext?: AssistantReusableContextPack
  workspaceRootDir?: string
  toolPolicyOrigin?: 'assistant' | 'graph'
  terminalPolicyRuntime?: AssistantTerminalPolicyRuntime
  commandConfinementAdapter?: CommandJobsConfinementAdapter
  terminalApproval?: (
    request: PolicyRequest
  ) => { grantId: string; expectedGrantUseCount: number } | undefined
  resumeRun?: (
    route: AssistantRoute,
    runId: string,
    options?: {
      async?: boolean
    }
  ) => Promise<AssistantRuntimeResult>
  resumeWorkflow?: (
    workflowId: string,
    route?: AssistantRoute,
    options?: {
      async?: boolean
    }
  ) => Promise<AssistantRuntimeResult>
  startTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      title?: string
      description?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  progressTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      label?: string
      completed?: number
      total?: number
      percent?: number
      title?: string
      description?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  approveTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      approvedBy?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  exportTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      exportTarget?: string
      exportArtifactIds?: string[]
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  cancelTaskGroup?: (
    route: AssistantRoute,
    options?: {
      taskGroupId?: string
      workspaceRunId?: string
    }
  ) => Promise<AssistantTaskGroupState | null>
  resumeTaskGroup?: (
    route: AssistantRoute,
    taskGroupId: string,
    options?: {
      async?: boolean
    }
  ) => Promise<AssistantRuntimeResult>
}

export type AssistantToolCallResult = {
  content: string
  metadata?: Record<string, unknown>
}

type AssistantToolHandler = (
  args: Record<string, unknown>,
  context: AssistantToolCallContext
) => Promise<AssistantToolCallResult>

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const jsonToolResult = (
  value: unknown,
  metadata: Record<string, unknown> | undefined = isPlainRecord(value) ? value : undefined
): AssistantToolCallResult => ({
  content: JSON.stringify(value, null, 2),
  ...(metadata ? { metadata } : {})
})

const validateValueAgainstToolSchema = (
  value: unknown,
  schema: unknown,
  path: string
): string[] => {
  if (!isPlainRecord(schema)) {
    return []
  }

  const schemaType = typeof schema.type === 'string' ? schema.type : undefined
  const enumValues = Array.isArray(schema.enum) ? schema.enum : null
  const errors: string[] = []

  if (enumValues && !enumValues.includes(value)) {
    errors.push(
      `${path} must be one of: ${enumValues.map((item) => JSON.stringify(item)).join(', ')}`
    )
    return errors
  }

  switch (schemaType) {
    case 'object': {
      if (!isPlainRecord(value)) {
        return [`${path} must be an object.`]
      }

      const properties = isPlainRecord(schema.properties)
        ? (schema.properties as Record<string, unknown>)
        : {}
      const required = Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === 'string')
        : []

      for (const key of required) {
        if (!(key in value)) {
          errors.push(`${path}.${key} is required.`)
        }
      }

      for (const [key, propertySchema] of Object.entries(properties)) {
        if (key in value) {
          errors.push(
            ...validateValueAgainstToolSchema(value[key], propertySchema, `${path}.${key}`)
          )
        }
      }

      if (schema.additionalProperties === false) {
        const allowedKeys = new Set(Object.keys(properties))
        for (const key of Object.keys(value)) {
          if (!allowedKeys.has(key)) {
            errors.push(`${path}.${key} is not allowed.`)
          }
        }
      }

      return errors
    }
    case 'string': {
      if (typeof value !== 'string') {
        return [`${path} must be a string.`]
      }
      return []
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return [`${path} must be an integer.`]
      }
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        errors.push(`${path} must be >= ${schema.minimum}.`)
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        errors.push(`${path} must be <= ${schema.maximum}.`)
      }
      return errors
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return [`${path} must be a number.`]
      }
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        errors.push(`${path} must be >= ${schema.minimum}.`)
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        errors.push(`${path} must be <= ${schema.maximum}.`)
      }
      return errors
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return [`${path} must be a boolean.`]
      }
      return []
    }
    case 'array': {
      if (!Array.isArray(value)) {
        return [`${path} must be an array.`]
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => {
          errors.push(...validateValueAgainstToolSchema(item, schema.items, `${path}[${index}]`))
        })
      }
      return errors
    }
    default:
      return []
  }
}

const assertValidToolArgs = (
  name: string,
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>
): void => {
  const errors = validateValueAgainstToolSchema(args, inputSchema, 'input')
  if (!errors.length) {
    return
  }

  throw new Error(
    `Invalid input for tool "${name}": ${errors.join(' ')} Use /tools ${name} to inspect its input schema.`
  )
}

const clampToolLimit = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
}

const toPreviewText = (value?: string | null): string | undefined => {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return undefined
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized
}

const projectTraceProjectRefSchema = {
  type: 'object',
  properties: {
    projectId: {
      type: 'string'
    },
    projectName: {
      type: 'string'
    },
    projectStorageDirName: {
      type: 'string'
    },
    projectRootDir: {
      type: 'string'
    }
  },
  required: ['projectId'],
  additionalProperties: false
}

const projectTraceEventSummarySchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string'
    },
    safeSummary: {
      type: 'string'
    },
    movementDistancePx: {
      type: 'number'
    },
    maxScaleChangeRatio: {
      type: 'number'
    },
    maxRotationDeltaDeg: {
      type: 'number'
    },
    removedItemCount: {
      type: 'number'
    },
    maxLayerDelta: {
      type: 'number'
    },
    affectedItemCount: {
      type: 'number'
    },
    riskSignals: {
      type: 'array',
      items: {
        type: 'string'
      }
    }
  }
}

const readProjectTraceProjectRef = (value: unknown): ProjectTraceProjectRef => {
  if (!isPlainRecord(value)) {
    throw new Error('project.trace requires a project object.')
  }
  const projectId = String(value.projectId || '').trim()
  if (!projectId) {
    throw new Error('project.trace requires project.projectId.')
  }

  const project: ProjectTraceProjectRef = {
    projectId
  }
  for (const key of ['projectName', 'projectStorageDirName', 'projectRootDir'] as const) {
    const rawValue = value[key]
    if (typeof rawValue === 'string' && rawValue.trim()) {
      project[key] = rawValue.trim()
    }
  }
  return project
}

const readProjectTraceId = (value: unknown, label = 'traceId'): string => {
  const traceId = String(value || '').trim()
  if (!traceId) {
    throw new Error(`project.trace requires ${label}.`)
  }
  return traceId
}

const readProjectTraceIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    throw new Error('project.trace requires traceIds.')
  }
  const traceIds = Array.from(
    new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))
  ).slice(0, 20)
  if (!traceIds.length) {
    throw new Error('project.trace requires at least one trace id.')
  }
  return traceIds
}

const createProjectTraceCli = (context: AssistantToolCallContext): ProjectTraceFSCli =>
  new ProjectTraceFSCli(context.config)

const summarizeTaskState = (taskState: AssistantTaskState): Record<string, unknown> => ({
  sessionKey: taskState.sessionKey,
  running: taskState.running,
  queuedCount: taskState.queuedCount,
  activeRunId: taskState.activeRunId,
  activeStatus: taskState.activeStatus,
  cancelRequested: taskState.cancelRequested,
  updatedAt: taskState.updatedAt
})

const formatTaskGroupStatusLines = (taskGroup?: AssistantTaskGroupState | null): string[] => {
  if (!taskGroup) {
    return []
  }

  const lines = [`Task group: ${taskGroup.taskGroupId}`, `Task group status: ${taskGroup.status}`]

  if (taskGroup.title) {
    lines.push(`Task group title: ${taskGroup.title}`)
  }
  if (taskGroup.progress?.label) {
    lines.push(`Task group progress: ${taskGroup.progress.label}`)
  }
  if (taskGroup.workspaceRunId) {
    lines.push(`Workspace run: ${taskGroup.workspaceRunId}`)
  }

  return lines
}

const summarizeStoreLimits = async (
  context: AssistantToolCallContext
): Promise<Record<string, unknown>> => {
  const session = await context.sessionStore.getSession(context.route)
  const sessions = await context.sessionStore.listSessions()
  const retention = await context.sessionStore.getRetentionState()

  return {
    retention: {
      maxHistoryMessages: ASSISTANT_SESSION_STORE_LIMITS.maxHistoryMessages,
      minHistoryMessages: ASSISTANT_SESSION_STORE_LIMITS.minHistoryMessages,
      maxRunRecords: ASSISTANT_SESSION_STORE_LIMITS.maxRunRecords,
      maxEventLogEntries: ASSISTANT_SESSION_STORE_LIMITS.maxEventLogEntries,
      maxArtifactRecords: ASSISTANT_SESSION_STORE_LIMITS.maxArtifactRecords,
      ...retention
    },
    storage: {
      sessionCount: sessions.length,
      currentSessionKey: getAssistantSessionKey(context.route),
      currentMessageCount: session?.messages.length || 0,
      currentRunCount: session?.runs.length || 0,
      currentEventCount: session?.eventLog.length || 0,
      currentArtifactCount: session?.artifacts.length || 0
    }
  }
}

const baseDefinitions: AssistantToolDefinition[] = [
  {
    name: 'files.tree',
    description: 'List a bounded, deterministic tree within the current route workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        maxDepth: { type: 'integer', minimum: 0, maximum: 12 },
        maxEntries: { type: 'integer', minimum: 1, maximum: 2000 },
        maxStringLength: { type: 'integer', minimum: 1, maximum: 1048576 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.read',
    description:
      'Read bounded UTF-8 text, allowlisted PNG/JPEG/GIF/WebP bytes, or conservatively extracted PDF text and metadata from a regular workspace file. Media type is verified by magic bytes; binary payloads are never audited.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
        maxStringLength: { type: 'integer', minimum: 1, maximum: 1048576 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.glob',
    description:
      'Match bounded workspace-relative files and directories using *, ?, and ** segments.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', maxLength: 512 },
        path: { type: 'string' },
        maxDepth: { type: 'integer', minimum: 0, maximum: 12 },
        maxFiles: { type: 'integer', minimum: 1, maximum: 2000 },
        maxStringLength: { type: 'integer', minimum: 1, maximum: 1048576 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.grep',
    description:
      'Search bounded UTF-8 workspace files with a literal or restricted regular expression.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', maxLength: 512 },
        mode: { type: 'string', enum: ['literal', 'regex'] },
        path: { type: 'string' },
        fileGlob: { type: 'string', maxLength: 512 },
        caseSensitive: { type: 'boolean' },
        maxDepth: { type: 'integer', minimum: 0, maximum: 12 },
        maxFiles: { type: 'integer', minimum: 1, maximum: 2000 },
        maxMatches: { type: 'integer', minimum: 1, maximum: 2000 },
        maxReadBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
        maxSnippetLength: { type: 'integer', minimum: 1, maximum: 2000 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.json.read',
    description: 'Read, select, bound, and redact a UTF-8 JSON file within the workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string' },
        pointer: { type: 'string' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
        maxDepth: { type: 'integer', minimum: 0, maximum: 12 },
        maxEntries: { type: 'integer', minimum: 1, maximum: 10000 },
        maxStringLength: { type: 'integer', minimum: 1, maximum: 1048576 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.write',
    description:
      'Create or fully replace a bounded UTF-8 regular file with CAS and a pre-write snapshot.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string', maxLength: 1048576 },
        create: { type: 'boolean' },
        expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
        maxDiffBytes: { type: 'integer', minimum: 1, maximum: 262144 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.edit',
    description: 'Apply ordered exact text replacements to one CAS-protected UTF-8 regular file.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'expectedSha256', 'replacements'],
      properties: {
        path: { type: 'string' },
        expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        replacements: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['old', 'new', 'expectedOccurrences'],
            properties: {
              old: { type: 'string', minLength: 1 },
              new: { type: 'string' },
              expectedOccurrences: { type: 'integer', minimum: 1 }
            }
          }
        },
        maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
        maxDiffBytes: { type: 'integer', minimum: 1, maximum: 262144 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.patch',
    description: 'Apply one exact-path complete-file unified patch with SHA-256 CAS and snapshot.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'patch', 'expectedSha256'],
      properties: {
        path: { type: 'string' },
        patch: { type: 'string', minLength: 1, maxLength: 262144 },
        expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
        maxDiffBytes: { type: 'integer', minimum: 1, maximum: 262144 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.multi-edit',
    description:
      'Atomically apply validated CAS edits across distinct workspace files with rollback.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['edits'],
      properties: {
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'expectedSha256', 'replacements'],
            properties: {
              path: { type: 'string' },
              expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              replacements: {
                type: 'array',
                minItems: 1,
                maxItems: 100,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['old', 'new', 'expectedOccurrences'],
                  properties: {
                    old: { type: 'string', minLength: 1 },
                    new: { type: 'string' },
                    expectedOccurrences: { type: 'integer', minimum: 1 }
                  }
                }
              }
            }
          }
        },
        maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
        maxDiffBytes: { type: 'integer', minimum: 1, maximum: 262144 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.json.write',
    description:
      'Write canonical pretty JSON or update one safe existing JSON path with CAS and snapshot.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string' },
        value: {},
        update: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'value'],
          properties: { path: { type: 'string' }, value: {} }
        },
        create: { type: 'boolean' },
        expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
        maxDiffBytes: { type: 'integer', minimum: 1, maximum: 262144 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.diff',
    description: 'Compare current workspace text with supplied text or a validated snapshot.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string' },
        text: { type: 'string', maxLength: 1048576 },
        snapshotToken: { type: 'string' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
        maxDiffBytes: { type: 'integer', minimum: 1, maximum: 262144 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.snapshot.list',
    description: 'List bounded snapshot manifest metadata without exposing snapshot content.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        maxEntries: { type: 'integer', minimum: 1, maximum: 1000 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'files.snapshot.restore',
    description: 'CAS-restore a validated snapshot after creating a safety snapshot.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'restoreToken', 'expectedSha256'],
      properties: {
        path: { type: 'string' },
        restoreToken: { type: 'string' },
        expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
      }
    }
  },
  {
    name: 'notebook.list',
    description: 'List bounded valid nbformat-v4 notebooks in the route workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        maxEntries: { type: 'integer', minimum: 1, maximum: 1000 }
      }
    }
  },
  {
    name: 'notebook.read',
    description: 'Read and strictly validate one workspace nbformat-v4 notebook.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' } }
    }
  },
  ...(['insert', 'replace', 'delete', 'convert', 'clear-outputs'] as const).map((operation) => ({
    name: `notebook.${operation}`,
    description: `Stateless CAS notebook ${operation} with one approved notebook.write mutation.`,
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['path', 'expectedSha256'],
      properties: {
        path: { type: 'string' },
        expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }
      }
    }
  })),
  ...(['execute-cell', 'execute-all'] as const).map((operation) => ({
    name: `notebook.${operation}`,
    description:
      'Execute notebook code cells in one bounded stateless Python invocation; outputs commit atomically after SHA/generation CAS.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'expectedSha256', 'expectedGeneration'],
      properties: {
        path: { type: 'string' },
        expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        expectedGeneration: { type: 'integer', minimum: 0 },
        cellIds: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string' } },
        artifacts: { type: 'array', maxItems: 32, items: { type: 'string' } },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
        maxOutputBytes: { type: 'integer', minimum: 1, maximum: 4194304 }
      }
    }
  })),
  ...(['status', 'interrupt', 'restart'] as const).map((operation) => ({
    name: `notebook.${operation}`,
    description: `Stateless notebook execution ${operation}.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' }, executionId: { type: 'string' } }
    }
  })),
  {
    name: 'git.status',
    description:
      'Return bounded structured Git working-tree status for a workspace-contained repository.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repository: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
        maxOutputBytes: { type: 'integer', minimum: 1, maximum: 524288 }
      }
    }
  },
  {
    name: 'git.diff',
    description: 'Return a bounded text-only Git diff and deterministic file statistics.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repository: { type: 'string' },
        revision: { type: 'string' },
        pathspecs: { type: 'array', maxItems: 64, items: { type: 'string' } },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
        maxOutputBytes: { type: 'integer', minimum: 1, maximum: 524288 }
      }
    }
  },
  {
    name: 'git.log',
    description: 'Return bounded, deterministically parsed local Git commit history.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repository: { type: 'string' },
        revision: { type: 'string' },
        pathspecs: { type: 'array', maxItems: 64, items: { type: 'string' } },
        maxCommits: { type: 'integer', minimum: 1, maximum: 100 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
        maxOutputBytes: { type: 'integer', minimum: 1, maximum: 524288 }
      }
    }
  },
  {
    name: 'git.show',
    description: 'Show one bounded local commit with metadata, text diff, and file statistics.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['revision'],
      properties: {
        repository: { type: 'string' },
        revision: { type: 'string' },
        pathspecs: { type: 'array', maxItems: 64, items: { type: 'string' } },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
        maxOutputBytes: { type: 'integer', minimum: 1, maximum: 524288 }
      }
    }
  },
  {
    name: 'git.branch',
    description: 'Create one new local branch at the CAS-validated current HEAD.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['branch', 'expectedHead'],
      properties: {
        repository: { type: 'string' },
        branch: { type: 'string' },
        expectedHead: { type: 'string', pattern: '^[0-9a-f]{40}$' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
        maxOutputBytes: { type: 'integer', minimum: 1, maximum: 524288 }
      }
    }
  },
  {
    name: 'git.checkout',
    description: 'Checkout an existing local branch only from a clean CAS-validated worktree.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['branch', 'expectedHead', 'expectedStatusDigest'],
      properties: {
        repository: { type: 'string' },
        branch: { type: 'string' },
        expectedHead: { type: 'string', pattern: '^[0-9a-f]{40}$' },
        expectedStatusDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
        maxOutputBytes: { type: 'integer', minimum: 1, maximum: 524288 }
      }
    }
  },
  {
    name: 'git.add',
    description: 'Stage exact bounded repository-relative paths with index snapshot and rollback.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pathspecs', 'expectedHead', 'expectedStatusDigest'],
      properties: {
        repository: { type: 'string' },
        pathspecs: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string' } },
        expectedHead: { type: 'string', pattern: '^[0-9a-f]{40}$' },
        expectedStatusDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
        maxOutputBytes: { type: 'integer', minimum: 1, maximum: 524288 }
      }
    }
  },
  {
    name: 'git.commit',
    description: 'Create one normal hook-running local commit from a CAS-validated staged diff.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['message', 'expectedHead', 'expectedStagedDiffDigest'],
      properties: {
        repository: { type: 'string' },
        message: { type: 'string', minLength: 1, maxLength: 16384 },
        expectedHead: { type: 'string', pattern: '^[0-9a-f]{40}$' },
        expectedStagedDiffDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
        maxOutputBytes: { type: 'integer', minimum: 1, maximum: 524288 }
      }
    }
  },
  {
    name: MAGICPOT_SESSION_STATUS_TOOL_NAME,
    description: 'Describe the current chat session and task state.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'session.summary',
    description:
      'Return a concise summary of the current chat session, including runs, artifacts, and ' +
      'workspace state.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'session.history',
    description: 'Return recent chat history for the current chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100
        }
      }
    }
  },
  {
    name: 'events.list',
    description: 'Return recent runtime events recorded for the current chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100
        }
      }
    }
  },
  {
    name: 'session.cleanup',
    description:
      'Clear the current session or prune stale sessions older than a requested threshold.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['clear', 'prune']
        },
        olderThanDays: {
          type: 'integer',
          minimum: 1,
          maximum: 3650
        }
      }
    }
  },
  {
    name: 'sessions.list',
    description: 'List recent chat sessions tracked by the local session store.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50
        }
      }
    }
  },
  {
    name: 'workspaces.list',
    description: 'List recorded workspace identities aggregated from persisted chat sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50
        }
      }
    }
  },
  {
    name: 'workflows.list',
    description:
      'List persisted workflow records aggregated from run lineage for the current route.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50
        }
      }
    }
  },
  {
    name: 'workspace.inspect',
    description: 'Inspect a recorded workspace identity by workspaceId.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string'
        },
        runLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['workspaceId']
    }
  },
  {
    name: 'workflow.inspect',
    description: 'Inspect a persisted workflow record by workflow id or root run id.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string'
        },
        runLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 100
        },
        eventLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 200
        },
        artifactLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 200
        }
      },
      required: ['workflowId']
    }
  },
  {
    name: 'workflow.resume',
    description:
      'Requeue the latest failed or cancelled run in a persisted workflow record using phase-1 resume semantics.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string'
        },
        async: {
          type: 'boolean'
        }
      },
      required: ['workflowId']
    }
  },
  {
    name: 'project.trace.list',
    description:
      'List redacted project trace summaries for a project using the read-only trace store.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectTraceProjectRefSchema,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['project']
    }
  },
  {
    name: 'project.trace.read',
    description: 'Read one redacted project trace document by id.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectTraceProjectRefSchema,
        traceId: {
          type: 'string'
        }
      },
      required: ['project', 'traceId']
    }
  },
  {
    name: 'project.trace.references',
    description: 'Read compact redacted references for selected project trace ids.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectTraceProjectRefSchema,
        traceIds: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        maxCharsPerTrace: {
          type: 'integer',
          minimum: 400,
          maximum: 1600
        }
      },
      required: ['project', 'traceIds']
    }
  },
  {
    name: 'project.trace.replay',
    description:
      'Build a deterministic replay bundle from one redacted trace document, references, rules, and event steps.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectTraceProjectRefSchema,
        traceId: {
          type: 'string'
        },
        maxCharsPerTrace: {
          type: 'integer',
          minimum: 400,
          maximum: 1600
        },
        markdownLimit: {
          type: 'integer',
          minimum: 400,
          maximum: 8000
        }
      },
      required: ['project', 'traceId']
    }
  },
  {
    name: 'project.trace.verify',
    description:
      'Compare supplied runtime event summaries against project trace rules and return deterministic deviation hints.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectTraceProjectRefSchema,
        traceIds: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        operationSummary: {
          type: 'string'
        },
        eventSummaries: {
          type: 'array',
          items: projectTraceEventSummarySchema
        },
        maxCharsPerTrace: {
          type: 'integer',
          minimum: 400,
          maximum: 1600
        }
      },
      required: ['project', 'traceIds']
    }
  },
  {
    name: 'task.group.list',
    description: 'List persisted task-group workflow summaries for the current route.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50
        }
      }
    }
  },
  {
    name: 'task.group.inspect',
    description: 'Inspect a task-group workflow summary by taskGroupId or workflow id.',
    inputSchema: {
      type: 'object',
      properties: {
        taskGroupId: {
          type: 'string'
        },
        runLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['taskGroupId']
    }
  },
  {
    name: 'task.group.start',
    description: 'Start or attach metadata for a task-group workflow run.',
    inputSchema: {
      type: 'object',
      properties: {
        taskGroupId: {
          type: 'string'
        },
        title: {
          type: 'string'
        },
        description: {
          type: 'string'
        }
      },
      required: ['taskGroupId']
    }
  },
  {
    name: 'task.group.progress',
    description: 'Record task-group progress on the latest matching run.',
    inputSchema: {
      type: 'object',
      properties: {
        taskGroupId: {
          type: 'string'
        },
        label: {
          type: 'string'
        },
        completed: {
          type: 'integer',
          minimum: 0,
          maximum: 100000
        },
        total: {
          type: 'integer',
          minimum: 0,
          maximum: 100000
        },
        percent: {
          type: 'number',
          minimum: 0,
          maximum: 100
        }
      },
      required: ['taskGroupId']
    }
  },
  {
    name: 'task.group.approve',
    description: 'Mark a task-group workflow as approved.',
    inputSchema: {
      type: 'object',
      properties: {
        taskGroupId: {
          type: 'string'
        },
        approvedBy: {
          type: 'string'
        }
      },
      required: ['taskGroupId']
    }
  },
  {
    name: 'task.group.export',
    description: 'Mark a task-group workflow as exported and capture lineage references.',
    inputSchema: {
      type: 'object',
      properties: {
        taskGroupId: {
          type: 'string'
        },
        exportTarget: {
          type: 'string'
        },
        exportArtifactIds: {
          type: 'array',
          items: {
            type: 'string'
          }
        }
      },
      required: ['taskGroupId']
    }
  },
  {
    name: 'task.group.cancel',
    description: 'Cancel the current route and record task-group cancellation metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        taskGroupId: {
          type: 'string'
        }
      },
      required: ['taskGroupId']
    }
  },
  {
    name: 'task.group.resume',
    description: 'Resume a task-group workflow by its workflow/task-group identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        taskGroupId: {
          type: 'string'
        },
        async: {
          type: 'boolean'
        }
      },
      required: ['taskGroupId']
    }
  },
  {
    name: 'task.group.retry',
    description: 'Retry a task-group workflow using the existing resume semantics.',
    inputSchema: {
      type: 'object',
      properties: {
        taskGroupId: {
          type: 'string'
        },
        async: {
          type: 'boolean'
        }
      },
      required: ['taskGroupId']
    }
  },
  {
    name: 'workspace.attach',
    description:
      'Attach the current route to a workspace identity and optionally update shared workspace metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string'
        },
        title: {
          type: 'string'
        },
        description: {
          type: 'string'
        },
        accessMode: {
          type: 'string',
          enum: ['private', 'shared']
        },
        sharedNote: {
          type: 'string'
        }
      },
      required: ['workspaceId']
    }
  },
  {
    name: 'workspace.detach',
    description:
      'Detach the current route from a shared workspace and restore its default workspace.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'workspace.manage',
    description:
      'Apply workspace governance actions such as share, privatize, archive, or revive for the current owner route.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['share', 'privatize', 'archive', 'revive']
        },
        workspaceId: {
          type: 'string'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'workspace.context',
    description: 'Return the stored workspace and desktop context snapshot for this session.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'memory.recent',
    description: 'Return the recent memory preview for this session.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'context.pinned',
    description: 'List, add, remove, or clear pinned reusable context notes for this session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'clear']
        },
        text: {
          type: 'string'
        },
        index: {
          type: 'integer',
          minimum: 1,
          maximum: 8
        },
        noteId: {
          type: 'string'
        }
      }
    }
  },
  {
    name: 'agent.terminal.run',
    description:
      'Request approval, then run a read-only allowlisted terminal command in an allowed cwd.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string'
        },
        args: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        cwd: {
          type: 'string'
        },
        confirm: {
          type: 'boolean'
        },
        timeoutMs: {
          type: 'integer',
          minimum: 100,
          maximum: 30000
        },
        maxOutputChars: {
          type: 'integer',
          minimum: 100,
          maximum: 60000
        }
      },
      required: ['command'],
      additionalProperties: false
    }
  },
  {
    name: 'python.run',
    description:
      'Run bounded Python from exactly one inline snippet or contained .py file. No OS sandbox, network/native-extension confinement, package install, stdin, or user argv.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', maxLength: 262144 },
        file: { type: 'string' },
        cwd: { type: 'string' },
        artifacts: { type: 'array', maxItems: 32, items: { type: 'string' } },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
        maxOutputBytes: { type: 'integer', minimum: 1, maximum: 2097152 }
      }
    }
  },
  {
    name: 'python.background',
    description:
      'Start durable bounded Python execution; use commands.status/read/stop with the returned job identity.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', maxLength: 262144 },
        file: { type: 'string' },
        cwd: { type: 'string' },
        artifacts: { type: 'array', maxItems: 32, items: { type: 'string' } },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
        maxOutputBytes: { type: 'integer', minimum: 1, maximum: 2097152 }
      }
    }
  },
  {
    name: 'commands.background',
    description: 'Start an approved, bounded, no-shell command job in the route workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string' },
        args: { type: 'array', maxItems: 128, items: { type: 'string' } },
        cwd: { type: 'string' },
        env: { type: 'object', maxProperties: 64, additionalProperties: { type: 'string' } },
        shell: { type: 'boolean', enum: [false] },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
        maxLogBytes: { type: 'integer', minimum: 1, maximum: 2097152 }
      }
    }
  },
  {
    name: 'commands.status',
    description: 'Get route/session-owned background command job status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['jobId'],
      properties: { jobId: { type: 'string' } }
    }
  },
  {
    name: 'commands.read',
    description: 'Read bounded redacted background command output using a byte cursor.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['jobId', 'stream'],
      properties: {
        jobId: { type: 'string' },
        stream: { type: 'string', enum: ['stdout', 'stderr'] },
        cursor: { type: 'integer', minimum: 0 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 131072 }
      }
    }
  },
  {
    name: 'commands.stop',
    description: 'Idempotently stop a route/session-owned live background command tree.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['jobId'],
      properties: { jobId: { type: 'string' } }
    }
  },
  {
    name: 'runs.list',
    description: 'List recent run records for the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20
        }
      }
    }
  },
  {
    name: 'runs.get',
    description: 'Return a recorded run by runId from the current chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string'
        }
      },
      required: ['runId']
    }
  },
  {
    name: 'run.inspect',
    description: 'Alias for runs.get.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string'
        }
      },
      required: ['runId']
    }
  },
  {
    name: 'run.trace',
    description: 'Return a correlated trace timeline for a recorded run in the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string'
        }
      },
      required: ['runId']
    }
  },
  {
    name: 'run.lineage',
    description: 'Return the related run chain, ancestors, and descendants for a recorded run.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string'
        }
      },
      required: ['runId']
    }
  },
  {
    name: 'run.replay',
    description: 'Return a replay bundle derived from a run trace and lineage record.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string'
        }
      },
      required: ['runId']
    }
  },
  {
    name: 'run.resume',
    description:
      'Requeue a failed or cancelled run from its stored request text using phase-1 resume semantics.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string'
        },
        async: {
          type: 'boolean'
        }
      },
      required: ['runId']
    }
  },
  {
    name: 'run.retry',
    description: 'Retry a failed or cancelled run using the existing resume semantics.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string'
        },
        async: {
          type: 'boolean'
        }
      },
      required: ['runId']
    }
  },
  {
    name: 'artifacts.list',
    description: 'List recorded artifacts for the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20
        }
      }
    }
  },
  {
    name: 'artifacts.get',
    description: 'Return a recorded artifact by artifactId from the current chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: {
          type: 'string'
        }
      },
      required: ['artifactId']
    }
  },
  {
    name: 'limits.status',
    description: 'Return session store retention and current usage visibility.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'audit.timeline',
    description: 'Return a correlated audit timeline for recent runs, events, and artifacts.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100
        },
        runId: {
          type: 'string'
        }
      }
    }
  },
  {
    name: 'ops.status',
    description: 'Return derived operational counters and latency summaries for bot activity.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20
        }
      }
    }
  },
  {
    name: 'mcp.status',
    description: 'Describe current MCP client connections and the local MagicPot MCP server state.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
]

const inspectRunRecord = async (
  args: Record<string, unknown>,
  context: AssistantToolCallContext
) => {
  const runId = String(args.runId || '')
    .trim()
    .replace(/^"|"$/g, '')
  if (!runId) {
    throw new Error('runs.get requires a runId.')
  }

  const session = await context.sessionStore.getSession(context.route)
  const run = session?.runs.find((item) => item.runId === runId) || null
  return jsonToolResult({
    sessionKey: session?.sessionKey || getAssistantSessionKey(context.route),
    runId,
    found: Boolean(run),
    run
  })
}

const buildSessionStatusToolResult: AssistantToolHandler = async (_args, context) => {
  const session = await context.sessionStore.getSession(context.route)
  const latestTaskGroup =
    [...(session?.runs || [])]
      .reverse()
      .map((run) => run.taskGroup || undefined)
      .find((taskGroup): taskGroup is AssistantTaskGroupState => Boolean(taskGroup)) ||
    context.taskState.taskGroup
  return {
    content: [
      `Session: ${getAssistantSessionKey(context.route)}`,
      `Running: ${context.taskState.running ? 'yes' : 'no'}`,
      `Queued: ${context.taskState.queuedCount}`,
      ...formatTaskGroupStatusLines(latestTaskGroup),
      `Messages: ${session?.messages.length || 0}`,
      `Runs: ${session?.runs.length || 0}`,
      `Artifacts: ${session?.artifacts.length || 0}`,
      `Events: ${session?.eventLog.length || 0}`
    ].join('\n')
  }
}

const defaultCommandConfinementAdapter = createProductionCommandJobsConfinementAdapter()
const commandJobHosts = new Map<string, CommandJobsToolHost>()
const commandConfinementAdapterIds = new WeakMap<object, number>()
let nextCommandConfinementAdapterId = 1
const commandConfinementAdapterKey = (adapter?: CommandJobsConfinementAdapter): string => {
  if (!adapter) return 'unconfined'
  let id = commandConfinementAdapterIds.get(adapter)
  if (id === undefined) {
    id = nextCommandConfinementAdapterId++
    commandConfinementAdapterIds.set(adapter, id)
  }
  return `${adapter.platform}:${id}`
}

const commandPolicyRuntimeIds = new WeakMap<object, number>()
let nextCommandPolicyRuntimeId = 1
const commandPolicyRuntimeKey = (runtime: AssistantTerminalPolicyRuntime): string => {
  let id = commandPolicyRuntimeIds.get(runtime)
  if (id === undefined) {
    id = nextCommandPolicyRuntimeId++
    commandPolicyRuntimeIds.set(runtime, id)
  }
  return `runtime:${id}`
}

const getCommandJobHost = (context: AssistantToolCallContext): CommandJobsToolHost => {
  const confinementAdapter = context.commandConfinementAdapter ?? defaultCommandConfinementAdapter
  if (!context.workspaceRootDir)
    throw new Error('Background commands require a route workspace root.')
  const sessionId = getAssistantSessionKey(context.route)
  const runtime = context.terminalPolicyRuntime ?? getAssistantTerminalPolicyRuntime()
  const key = `${context.workspaceRootDir}\u0000${sessionId}\u0000${commandConfinementAdapterKey(confinementAdapter)}\u0000${commandPolicyRuntimeKey(runtime)}`
  let host = commandJobHosts.get(key)
  if (!host) {
    host = new CommandJobsToolHost(runtime.authorization, {
      workspaceRoot: context.workspaceRootDir,
      allowedEnvironmentKeys: ['PIP_NO_INDEX', 'PIP_DISABLE_PIP_VERSION_CHECK', 'PYTHONNOUSERSITE'],
      auditSink: runtime.eventStore,
      ...(confinementAdapter ? { confinementAdapter } : {})
    })
    commandJobHosts.set(key, host)
  }
  return host
}

const pythonHosts = new Map<string, PythonToolHost>()

const getPythonHost = (context: AssistantToolCallContext): PythonToolHost => {
  if (!context.workspaceRootDir) throw new Error('Python tools require a route workspace root.')
  const interpreter = context.config.local_comfyui_config.python_cmd?.trim()
  if (!interpreter)
    throw new Error(
      'Python tools require one explicit trusted interpreter in local_comfyui_config.python_cmd.'
    )
  const runtime = context.terminalPolicyRuntime ?? getAssistantTerminalPolicyRuntime()
  const manager = getCommandJobHost(context)
  const key = `${context.workspaceRootDir}\u0000${interpreter}\u0000${commandConfinementAdapterKey(context.commandConfinementAdapter ?? defaultCommandConfinementAdapter)}\u0000${commandPolicyRuntimeKey(runtime)}`
  let host = pythonHosts.get(key)
  if (!host) {
    host = new PythonToolHost({
      workspaceRoot: context.workspaceRootDir,
      interpreter,
      authorization: runtime.authorization,
      manager
    })
    pythonHosts.set(key, host)
  }
  return host
}

const notebookExecutionHosts = new Map<string, NotebookExecutionCoordinator>()

const getNotebookExecutionHost = (
  context: AssistantToolCallContext
): NotebookExecutionCoordinator => {
  if (!context.workspaceRootDir)
    throw new Error('Notebook execution requires a route workspace root.')
  const interpreter = context.config.local_comfyui_config.python_cmd?.trim()
  if (!interpreter) throw new Error('Notebook execution requires one explicit trusted interpreter.')
  const runtime = context.terminalPolicyRuntime ?? getAssistantTerminalPolicyRuntime()
  const manager = getCommandJobHost(context)
  const key = `${context.workspaceRootDir}\u0000${interpreter}\u0000${commandConfinementAdapterKey(context.commandConfinementAdapter ?? defaultCommandConfinementAdapter)}\u0000${commandPolicyRuntimeKey(runtime)}`
  let host = notebookExecutionHosts.get(key)
  if (!host) {
    const provenance = probePythonInterpreter(interpreter)
    host = new NotebookExecutionCoordinator(
      runtime.authorization,
      new PythonNotebookExecutionBoundary(manager, provenance.executable),
      { workspaceRoot: context.workspaceRootDir, provenance, auditSink: runtime.eventStore }
    )
    notebookExecutionHosts.set(key, host)
  }
  return host
}

const runPythonTool = async (
  target: 'python.run' | 'python.background',
  args: Record<string, unknown>,
  context: AssistantToolCallContext
): Promise<AssistantToolCallResult> => {
  const host = getPythonHost(context)
  const sessionId = getAssistantSessionKey(context.route)
  const common = {
    routeKey: JSON.stringify(context.route),
    sessionId,
    code: typeof args.code === 'string' ? args.code : undefined,
    file: typeof args.file === 'string' ? args.file : undefined,
    cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
    artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(String) : undefined,
    timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
    maxOutputBytes: typeof args.maxOutputBytes === 'number' ? args.maxOutputBytes : undefined
  }
  const request = host.createPolicyRequest({
    ...common,
    target,
    origin: context.toolPolicyOrigin ?? 'assistant',
    route: { ...context.route }
  })
  const runtime = context.terminalPolicyRuntime ?? getAssistantTerminalPolicyRuntime()
  const approval =
    process.env.NODE_ENV === 'test'
      ? { ...runtime.createTrustedApproval(request), authorizationId: randomUUID() }
      : context.terminalApproval
        ? { ...context.terminalApproval(request), authorizationId: randomUUID() }
        : await runtime.requestTerminalApproval(request)
  const input = {
    ...common,
    request,
    authorizationId: approval.authorizationId ?? randomUUID(),
    idempotencyKey: randomUUID(),
    ...approval
  }
  const result = target === 'python.run' ? await host.run(input) : await host.background(input)
  return jsonToolResult(result)
}

const toolHandlers: Record<string, AssistantToolHandler> = {
  [MAGICPOT_SESSION_STATUS_TOOL_NAME]: buildSessionStatusToolResult,
  'session.summary': async (_args, context) => {
    const session = await context.sessionStore.getSession(context.route)
    const latestRun = session?.runs ? session.runs[session.runs.length - 1] : undefined
    const summary = session
      ? {
          sessionKey: session.sessionKey,
          route: session.route,
          messageCount: session.messages.length,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          workspace: session.workspace,
          contextSnapshot: session.contextSnapshot || null,
          runCount: session.runs.length,
          artifactCount: session.artifacts.length,
          eventCount: session.eventLog.length,
          latestRun: latestRun
            ? {
                runId: latestRun.runId,
                status: latestRun.status,
                updatedAt: latestRun.updatedAt,
                profileId: latestRun.profileId,
                queuePosition: latestRun.queuePosition,
                errorMessage: latestRun.errorMessage
              }
            : null,
          lastUserText: toPreviewText(
            session.messages.filter((message) => message.role === 'user').at(-1)?.content
          ),
          lastAssistantText: toPreviewText(
            session.messages.filter((message) => message.role === 'assistant').at(-1)?.content
          )
        }
      : null

    return jsonToolResult({
      summary,
      taskState: summarizeTaskState(context.taskState)
    })
  },
  'session.history': async (args, context) => {
    const limit = clampToolLimit(args.limit, 20, 1, 100)
    const session = await context.sessionStore.getSession(context.route)
    const messages = session?.messages.slice(-limit) || []

    return {
      content: JSON.stringify(
        {
          sessionKey: session?.sessionKey || getAssistantSessionKey(context.route),
          route: context.route,
          messageCount: session?.messages.length || 0,
          limit,
          returnedCount: messages.length,
          messages
        },
        null,
        2
      ),
      metadata: {
        sessionKey: session?.sessionKey || getAssistantSessionKey(context.route),
        messageCount: session?.messages.length || 0,
        limit,
        returnedCount: messages.length,
        messages
      }
    }
  },
  'events.list': async (args, context) => {
    const limit = clampToolLimit(args.limit, 20, 1, 100)
    const events = await context.sessionStore.listEvents(limit, context.route)
    return jsonToolResult({
      sessionKey: getAssistantSessionKey(context.route),
      limit,
      eventCount: events.length,
      events
    })
  },
  'agent.terminal.run': async (args, context) => {
    const contextSnapshot = context.workspaceReusableContext?.contextSnapshot
    const workspaceRoots = [
      contextSnapshot?.downloadDir,
      contextSnapshot?.outputDir,
      contextSnapshot?.workflowDir
    ].filter((entry): entry is string => Boolean(entry))
    const prepared = await prepareAgentTerminalCommand(args, {
      config: context.config,
      signal: context.signal,
      workspaceRoots
    })
    const sessionId = getAssistantSessionKey(context.route)
    const policyRuntime = context.terminalPolicyRuntime ?? getAssistantTerminalPolicyRuntime()
    const request = policyRuntime.createRequest({
      route: context.route,
      sessionId,
      command: prepared.executable,
      args: prepared.args,
      cwd: prepared.cwd,
      allowedRoots: prepared.allowedRoots
    })
    const approval =
      process.env.NODE_ENV === 'test'
        ? { ...policyRuntime.createTrustedApproval(request), authorizationId: randomUUID() }
        : context.terminalApproval
          ? { ...context.terminalApproval(request), authorizationId: randomUUID() }
          : await policyRuntime.requestTerminalApproval(request)
    const result = await policyRuntime.run({
      authorizationId: approval.authorizationId ?? randomUUID(),
      idempotencyKey: randomUUID(),
      request,
      command: prepared.executable,
      args: prepared.args,
      cwd: prepared.cwd,
      timeoutMs: prepared.timeoutMs,
      maxOutputChars: prepared.maxOutputChars,
      ...(approval ?? {})
    })

    return jsonToolResult(result)
  },
  'python.run': async (args, context) => runPythonTool('python.run', args, context),
  'python.background': async (args, context) => runPythonTool('python.background', args, context),
  'commands.background': async (args, context) => {
    if (!context.workspaceRootDir)
      throw new Error('Background commands require a route workspace root.')
    const prepared = await prepareAgentTerminalCommand(
      { ...args, cwd: args.cwd ?? context.workspaceRootDir },
      { config: context.config, signal: context.signal, workspaceRoots: [context.workspaceRootDir] }
    )
    const sessionId = getAssistantSessionKey(context.route)
    const runtime = context.terminalPolicyRuntime ?? getAssistantTerminalPolicyRuntime()
    const request = createTerminalPolicyRequest({
      requestId: randomUUID(),
      origin: context.toolPolicyOrigin ?? 'assistant',
      actor: { kind: 'system', id: 'commands-background-tool-host' },
      target: { kind: 'tool', id: 'commands.background' },
      route: { ...context.route },
      sessionId,
      command: prepared.executable,
      args: prepared.args,
      cwd: prepared.cwd,
      filesystem: { cwd: prepared.cwd, allowedRoots: [context.workspaceRootDir] }
    })
    const approval =
      process.env.NODE_ENV === 'test'
        ? { ...runtime.createTrustedApproval(request), authorizationId: randomUUID() }
        : context.terminalApproval
          ? { ...context.terminalApproval(request), authorizationId: randomUUID() }
          : await runtime.requestTerminalApproval(request)
    const result = await getCommandJobHost(context).background({
      authorizationId: approval.authorizationId ?? randomUUID(),
      idempotencyKey: randomUUID(),
      request,
      routeKey: JSON.stringify(context.route),
      sessionId,
      command: prepared.executable,
      args: prepared.args,
      cwd: prepared.cwd,
      env: (args.env ?? {}) as Record<string, string>,
      shell: false,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : prepared.timeoutMs,
      maxLogBytes: typeof args.maxLogBytes === 'number' ? args.maxLogBytes : undefined,
      ...approval
    })
    return jsonToolResult(result)
  },
  'commands.status': async (args, context) => {
    const result = getCommandJobHost(context).status({
      jobId: String(args.jobId),
      routeKey: JSON.stringify(context.route),
      sessionId: getAssistantSessionKey(context.route)
    })
    return jsonToolResult(result)
  },
  'commands.read': async (args, context) => {
    const result = getCommandJobHost(context).read({
      jobId: String(args.jobId),
      routeKey: JSON.stringify(context.route),
      sessionId: getAssistantSessionKey(context.route),
      stream: args.stream as 'stdout' | 'stderr',
      cursor: args.cursor as number | undefined,
      maxBytes: args.maxBytes as number | undefined
    })
    return jsonToolResult(result)
  },
  'commands.stop': async (args, context) => {
    const result = await getCommandJobHost(context).stop({
      jobId: String(args.jobId),
      routeKey: JSON.stringify(context.route),
      sessionId: getAssistantSessionKey(context.route)
    })
    return jsonToolResult(result)
  },
  'session.cleanup': async (args, context) => {
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: context.route,
      sessionId: getAssistantSessionKey(context.route),
      toolName: 'session.cleanup',
      toolInput: args as PolicyJsonRecord
    })
    const mode = String(args.mode || 'clear')
      .trim()
      .toLowerCase()

    if (mode === 'prune') {
      const olderThanDays = Number(args.olderThanDays)
      if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
        throw new Error('session.cleanup prune requires olderThanDays.')
      }

      const beforeUpdatedAt = Date.now() - Math.trunc(olderThanDays) * 24 * 60 * 60 * 1000
      const pruneResult = await context.sessionStore.pruneSessions(beforeUpdatedAt)
      await Promise.all(
        pruneResult.removedSessions.map(async (session) => {
          await clearAssistantReusableContext(getAssistantWorkspaceState(session.route))
        })
      )

      const payload = {
        mode: 'prune',
        olderThanDays: Math.trunc(olderThanDays),
        ...pruneResult
      }

      return jsonToolResult(payload)
    }

    const existing = await context.sessionStore.getSession(context.route)
    await context.sessionStore.clearSession(context.route)
    await clearAssistantReusableContext(getAssistantWorkspaceState(context.route))

    const payload = {
      mode: 'clear',
      sessionKey: getAssistantSessionKey(context.route),
      cleared: Boolean(existing),
      retention: await context.sessionStore.getRetentionState()
    }

    return jsonToolResult(payload)
  },
  'sessions.list': async (args, context) => {
    const limit = clampToolLimit(args.limit, 10, 1, 50)
    const allSessions = await context.sessionStore.listSessionSummaries()
    const sessions = allSessions.slice(0, limit)
    return jsonToolResult({
      limit,
      returnedCount: sessions.length,
      sessionCount: allSessions.length,
      sessions
    })
  },
  'workspaces.list': async (args, context) => {
    const limit = clampToolLimit(args.limit, 10, 1, 50)
    const allWorkspaces = await context.sessionStore.listWorkspaceSummaries()
    const workspaces = allWorkspaces.slice(0, limit)
    return jsonToolResult({
      limit,
      returnedCount: workspaces.length,
      workspaceCount: allWorkspaces.length,
      workspaces
    })
  },
  'workflows.list': async (args, context) => {
    const limit = clampToolLimit(args.limit, 10, 1, 50)
    const allWorkflows = await context.sessionStore.listWorkflowSummaries({
      limit: 1000,
      route: context.route
    })
    const workflows = allWorkflows.slice(0, limit)
    return jsonToolResult({
      limit,
      returnedCount: workflows.length,
      workflowCount: allWorkflows.length,
      workflows
    })
  },
  'workspace.inspect': async (args, context) => {
    const workspaceId = String(args.workspaceId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!workspaceId) {
      throw new Error('workspace.inspect requires a workspaceId.')
    }

    const runLimit = clampToolLimit(args.runLimit, 20, 1, 100)
    const workspace = await context.sessionStore.getWorkspaceInspection(workspaceId, { runLimit })
    return jsonToolResult({
      workspaceId,
      found: Boolean(workspace),
      workspace
    })
  },
  'workflow.inspect': async (args, context) => {
    const workflowId = String(args.workflowId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!workflowId) {
      throw new Error('workflow.inspect requires a workflowId.')
    }

    const runLimit = clampToolLimit(args.runLimit, 50, 1, 100)
    const eventLimit = clampToolLimit(args.eventLimit, 50, 1, 200)
    const artifactLimit = clampToolLimit(args.artifactLimit, 50, 1, 200)
    const workflow = await context.sessionStore.getWorkflowInspection(workflowId, {
      route: context.route,
      runLimit,
      eventLimit,
      artifactLimit
    })
    const workspaceInspection = workflow
      ? await context.sessionStore.getWorkspaceInspection(workflow.workspaceId, {
          runLimit
        })
      : null
    return jsonToolResult({
      workflowId,
      found: Boolean(workflow),
      workspaceInspection,
      workflow
    })
  },
  'workflow.resume': async (args, context) => {
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: context.route,
      sessionId: getAssistantSessionKey(context.route),
      toolName: 'workflow.resume',
      toolInput: args as PolicyJsonRecord
    })
    const workflowId = String(args.workflowId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!workflowId) {
      throw new Error('workflow.resume requires a workflowId.')
    }
    if (!context.resumeWorkflow) {
      throw new Error('workflow.resume is not available without runtime control support.')
    }

    const asyncMode = typeof args.async === 'boolean' ? args.async : false
    const result = await context.resumeWorkflow(workflowId, context.route, {
      async: asyncMode
    })

    return jsonToolResult({
      resumedFromWorkflowId: workflowId,
      accepted: asyncMode,
      result
    })
  },
  'project.trace.list': async (args, context) => {
    const project = readProjectTraceProjectRef(args.project)
    const limit = clampToolLimit(args.limit, 20, 1, 100)
    const traces = await createProjectTraceCli(context).listTraces(project)
    const limitedTraces = traces.slice(0, limit)
    const payload = {
      projectId: project.projectId,
      limit,
      returnedCount: limitedTraces.length,
      traceCount: traces.length,
      traces: limitedTraces
    }

    return jsonToolResult(payload)
  },
  'project.trace.read': async (args, context) => {
    const project = readProjectTraceProjectRef(args.project)
    const traceId = readProjectTraceId(args.traceId)
    const trace = await createProjectTraceCli(context).readTrace(project, traceId)
    const payload = {
      projectId: project.projectId,
      traceId,
      found: Boolean(trace),
      trace
    }

    return jsonToolResult(payload)
  },
  'project.trace.references': async (args, context) => {
    const project = readProjectTraceProjectRef(args.project)
    const traceIds = readProjectTraceIds(args.traceIds)
    const maxCharsPerTrace = clampToolLimit(args.maxCharsPerTrace, 1200, 400, 1600)
    const cli = createProjectTraceCli(context)
    const traceResults = await Promise.all(
      traceIds.map(async (traceId) => ({
        traceId,
        trace: await cli.readTrace(project, traceId)
      }))
    )
    const foundTraceIds = traceResults
      .filter((result) => Boolean(result.trace))
      .map((result) => result.traceId)
    const references = await cli.readTraceReferences(project, foundTraceIds, maxCharsPerTrace)
    const foundIds = new Set(references.map((reference) => reference.id))
    const payload = {
      projectId: project.projectId,
      requestedTraceIds: traceIds,
      foundTraceIds: references.map((reference) => reference.id),
      blockedTraceIds: foundTraceIds.filter((traceId) => !foundIds.has(traceId)),
      missingTraceIds: traceIds.filter(
        (traceId) => !traceResults.some((result) => result.traceId === traceId && result.trace)
      ),
      referenceCount: references.length,
      references
    }

    return jsonToolResult(payload)
  },
  'project.trace.replay': async (args, context) => {
    const project = readProjectTraceProjectRef(args.project)
    const traceId = readProjectTraceId(args.traceId)
    const maxCharsPerTrace = clampToolLimit(args.maxCharsPerTrace, 1200, 400, 1600)
    const markdownLimit = clampToolLimit(args.markdownLimit, 4000, 400, 8000)
    const cli = createProjectTraceCli(context)
    const trace = await cli.readTrace(project, traceId)
    const references = await cli.readTraceReferences(project, [traceId], maxCharsPerTrace)
    const payload = buildProjectTraceReplayBundle(trace, references, {
      traceId,
      markdownLimit
    })

    return jsonToolResult(payload)
  },
  'project.trace.verify': async (args, context) => {
    const project = readProjectTraceProjectRef(args.project)
    const traceIds = readProjectTraceIds(args.traceIds)
    const maxCharsPerTrace = clampToolLimit(args.maxCharsPerTrace, 1200, 400, 1600)
    const cli = createProjectTraceCli(context)
    const traceResults = await Promise.all(
      traceIds.map(async (traceId) => ({
        traceId,
        trace: await cli.readTrace(project, traceId)
      }))
    )
    const traces = traceResults
      .map((result) => result.trace)
      .filter((trace): trace is ProjectTraceDocument => Boolean(trace))
    const foundIds = new Set(traces.map((trace) => trace.manifest.id))
    const references = await cli.readTraceReferences(
      project,
      traces.map((trace) => trace.manifest.id),
      maxCharsPerTrace
    )
    const payload = buildProjectTraceVerificationBundle({
      requestedTraceIds: traceIds,
      traces,
      references,
      missingTraceIds: traceIds.filter((traceId) => !foundIds.has(traceId)),
      operationSummary: typeof args.operationSummary === 'string' ? args.operationSummary : '',
      eventSummaries: normalizeProjectTraceVerificationEvents(args.eventSummaries)
    })

    return jsonToolResult(payload)
  },
  'task.group.list': async (args, context) => {
    const limit = clampToolLimit(args.limit, 10, 1, 50)
    const allTaskGroups = (
      await context.sessionStore.listWorkflowSummaries({
        limit: 1000,
        route: context.route
      })
    ).filter((workflow) => Boolean(workflow.taskGroup))
    const taskGroups = allTaskGroups.slice(0, limit)
    return jsonToolResult({
      limit,
      returnedCount: taskGroups.length,
      taskGroupCount: allTaskGroups.length,
      taskGroups
    })
  },
  'task.group.inspect': async (args, context) => {
    const taskGroupId = String(args.taskGroupId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!taskGroupId) {
      throw new Error('task.group.inspect requires a taskGroupId.')
    }

    const runLimit = clampToolLimit(args.runLimit, 50, 1, 100)
    const workflowSummary = (
      await context.sessionStore.listWorkflowSummaries({
        limit: 1000,
        route: context.route
      })
    ).find((item) => item.taskGroup?.taskGroupId === taskGroupId)
    const workflow = workflowSummary
      ? await context.sessionStore.getWorkflowInspection(workflowSummary.workflowId, {
          route: context.route,
          runLimit,
          eventLimit: runLimit,
          artifactLimit: runLimit
        })
      : null
    const taskGroup = workflow?.taskGroup
    const workspaceInspection = workflow
      ? await context.sessionStore.getWorkspaceInspection(workflow.workspaceId, {
          runLimit
        })
      : null
    return jsonToolResult({
      taskGroupId,
      found: Boolean(taskGroup),
      taskGroup,
      workspaceInspection,
      workflow
    })
  },
  'task.group.start': async (args, context) => {
    const taskGroupId = String(args.taskGroupId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!taskGroupId) {
      throw new Error('task.group.start requires a taskGroupId.')
    }
    if (!context.startTaskGroup) {
      throw new Error('task.group.start is not available without runtime control support.')
    }

    const taskGroup = await context.startTaskGroup(context.route, {
      taskGroupId,
      ...(typeof args.title === 'string' ? { title: args.title } : {}),
      ...(typeof args.description === 'string' ? { description: args.description } : {})
    })
    return jsonToolResult({ taskGroupId, taskGroup })
  },
  'task.group.progress': async (args, context) => {
    const taskGroupId = String(args.taskGroupId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!taskGroupId) {
      throw new Error('task.group.progress requires a taskGroupId.')
    }
    if (!context.progressTaskGroup) {
      throw new Error('task.group.progress is not available without runtime control support.')
    }

    const taskGroup = await context.progressTaskGroup(context.route, {
      taskGroupId,
      ...(typeof args.label === 'string' ? { label: args.label } : {}),
      ...(Number.isFinite(Number(args.completed)) ? { completed: Number(args.completed) } : {}),
      ...(Number.isFinite(Number(args.total)) ? { total: Number(args.total) } : {}),
      ...(Number.isFinite(Number(args.percent)) ? { percent: Number(args.percent) } : {})
    })
    return jsonToolResult({ taskGroupId, taskGroup })
  },
  'task.group.approve': async (args, context) => {
    const taskGroupId = String(args.taskGroupId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!taskGroupId) {
      throw new Error('task.group.approve requires a taskGroupId.')
    }
    if (!context.approveTaskGroup) {
      throw new Error('task.group.approve is not available without runtime control support.')
    }

    const taskGroup = await context.approveTaskGroup(context.route, {
      taskGroupId,
      ...(typeof args.approvedBy === 'string' ? { approvedBy: args.approvedBy } : {})
    })
    return jsonToolResult({ taskGroupId, taskGroup })
  },
  'task.group.export': async (args, context) => {
    const taskGroupId = String(args.taskGroupId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!taskGroupId) {
      throw new Error('task.group.export requires a taskGroupId.')
    }
    if (!context.exportTaskGroup) {
      throw new Error('task.group.export is not available without runtime control support.')
    }

    const taskGroup = await context.exportTaskGroup(context.route, {
      taskGroupId,
      ...(typeof args.exportTarget === 'string' ? { exportTarget: args.exportTarget } : {}),
      ...(Array.isArray(args.exportArtifactIds)
        ? {
            exportArtifactIds: args.exportArtifactIds.filter(
              (item): item is string => typeof item === 'string'
            )
          }
        : {})
    })
    const exportBundle = taskGroup
      ? {
          taskGroupId: taskGroup.taskGroupId,
          status: taskGroup.status,
          ...(taskGroup.workspaceRunId ? { workspaceRunId: taskGroup.workspaceRunId } : {}),
          ...(taskGroup.rootRunId ? { rootRunId: taskGroup.rootRunId } : {}),
          ...(taskGroup.exportTarget ? { exportTarget: taskGroup.exportTarget } : {}),
          ...(taskGroup.exportArtifactIds?.length
            ? { exportArtifactIds: taskGroup.exportArtifactIds }
            : {}),
          ...(taskGroup.qualityGate ? { qualityGate: taskGroup.qualityGate } : {}),
          ...(taskGroup.exportedAt ? { exportedAt: taskGroup.exportedAt } : {})
        }
      : null
    return jsonToolResult({ taskGroupId, taskGroup, exportBundle })
  },
  'task.group.cancel': async (args, context) => {
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: context.route,
      sessionId: getAssistantSessionKey(context.route),
      toolName: 'task.group.cancel',
      toolInput: args as PolicyJsonRecord
    })
    const taskGroupId = String(args.taskGroupId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!taskGroupId) {
      throw new Error('task.group.cancel requires a taskGroupId.')
    }
    if (!context.cancelTaskGroup) {
      throw new Error('task.group.cancel is not available without runtime control support.')
    }

    const taskGroup = await context.cancelTaskGroup(context.route, {
      taskGroupId
    })
    return jsonToolResult({ taskGroupId, taskGroup })
  },
  'task.group.resume': async (args, context) => {
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: context.route,
      sessionId: getAssistantSessionKey(context.route),
      toolName: 'task.group.resume',
      toolInput: args as PolicyJsonRecord
    })
    const taskGroupId = String(args.taskGroupId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!taskGroupId) {
      throw new Error('task.group.resume requires a taskGroupId.')
    }
    if (!context.resumeTaskGroup) {
      throw new Error('task.group.resume is not available without runtime control support.')
    }

    const result = await context.resumeTaskGroup(context.route, taskGroupId, {
      async: typeof args.async === 'boolean' ? args.async : false
    })
    return jsonToolResult({
      resumedFromTaskGroupId: taskGroupId,
      accepted: typeof args.async === 'boolean' ? args.async : false,
      result
    })
  },
  'task.group.retry': async (args, context) => {
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: context.route,
      sessionId: getAssistantSessionKey(context.route),
      toolName: 'task.group.retry',
      toolInput: args as PolicyJsonRecord
    })
    const taskGroupId = String(args.taskGroupId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!taskGroupId) {
      throw new Error('task.group.retry requires a taskGroupId.')
    }
    if (!context.resumeTaskGroup) {
      throw new Error('task.group.retry is not available without runtime control support.')
    }

    const result = await context.resumeTaskGroup(context.route, taskGroupId, {
      async: typeof args.async === 'boolean' ? args.async : false
    })
    return jsonToolResult({
      retriedFromTaskGroupId: taskGroupId,
      accepted: typeof args.async === 'boolean' ? args.async : false,
      result
    })
  },
  'workspace.attach': async (args, context) => {
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: context.route,
      sessionId: getAssistantSessionKey(context.route),
      toolName: 'workspace.attach',
      toolInput: args as PolicyJsonRecord
    })
    const workspaceId = String(args.workspaceId || '')
      .trim()
      .replace(/^"|"$/g, '')
    const accessMode = String(args.accessMode || '')
      .trim()
      .toLowerCase() as AssistantWorkspaceAccessMode | ''
    if (!workspaceId) {
      throw new Error('workspace.attach requires a workspaceId.')
    }

    const workspace = await ensureAssistantWorkspaceState(context.route, workspaceId)
    await ensureAssistantWorkspaceBinding(workspace, context.route, {
      ...(accessMode === 'private' || accessMode === 'shared' ? { accessMode } : {})
    })
    const contextSnapshot = buildAssistantContextSnapshot(
      context.route,
      context.config,
      workspaceId
    )
    await persistAssistantContextSnapshot(workspace, contextSnapshot)
    await context.sessionStore.attachWorkspace(context.route, workspace, contextSnapshot)

    if (args.title || args.description || args.sharedNote || accessMode) {
      await updateAssistantWorkspaceMeta(workspace, {
        ...(accessMode === 'private' || accessMode === 'shared' ? { accessMode } : {}),
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
        ...(typeof args.sharedNote === 'string' ? { appendSharedNote: args.sharedNote } : {})
      })
    }

    const workspaceInspection = await context.sessionStore.getWorkspaceInspection(workspaceId, {
      runLimit: 20
    })

    return jsonToolResult({
      workspaceId,
      attached: true,
      workspace: workspaceInspection
    })
  },
  'workspace.detach': async (_args, context) => {
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: context.route,
      sessionId: getAssistantSessionKey(context.route),
      toolName: 'workspace.detach',
      toolInput: {}
    })
    const currentWorkspaceId =
      context.workspaceReusableContext?.contextSnapshot?.workspaceId ||
      context.workspaceTaskContext?.workspaceId ||
      getAssistantWorkspaceState(context.route).workspaceId
    const defaultWorkspace = getAssistantWorkspaceState(context.route)
    const detached = currentWorkspaceId !== defaultWorkspace.workspaceId

    if (detached) {
      await detachAssistantWorkspaceBinding(currentWorkspaceId, context.route)
    }

    const workspace = await ensureAssistantWorkspaceState(
      context.route,
      defaultWorkspace.workspaceId
    )
    await ensureAssistantWorkspaceBinding(workspace, context.route)
    const contextSnapshot = buildAssistantContextSnapshot(
      context.route,
      context.config,
      defaultWorkspace.workspaceId
    )
    await persistAssistantContextSnapshot(workspace, contextSnapshot)
    await context.sessionStore.attachWorkspace(context.route, workspace, contextSnapshot)

    const workspaceInspection = await context.sessionStore.getWorkspaceInspection(
      workspace.workspaceId,
      {
        runLimit: 20
      }
    )
    const previousWorkspace = detached
      ? await context.sessionStore.getWorkspaceInspection(currentWorkspaceId, { runLimit: 20 })
      : undefined

    return jsonToolResult({
      detached,
      previousWorkspaceId: currentWorkspaceId,
      workspace: workspaceInspection,
      ...(previousWorkspace ? { previousWorkspace } : {})
    })
  },
  'workspace.manage': async (args, context) => {
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: context.route,
      sessionId: getAssistantSessionKey(context.route),
      toolName: 'workspace.manage',
      toolInput: args as PolicyJsonRecord
    })
    const action = String(args.action || '')
      .trim()
      .toLowerCase() as AssistantWorkspaceGovernanceAction | ''
    if (!action || !['share', 'privatize', 'archive', 'revive'].includes(action)) {
      throw new Error('workspace.manage requires action=share|privatize|archive|revive.')
    }

    const workspaceId =
      String(args.workspaceId || '')
        .trim()
        .replace(/^"|"$/g, '') ||
      context.workspaceReusableContext?.contextSnapshot?.workspaceId ||
      context.workspaceTaskContext?.workspaceId ||
      getAssistantWorkspaceState(context.route).workspaceId

    const workspace = await ensureAssistantWorkspaceState(context.route, workspaceId)
    await manageAssistantWorkspaceGovernance(workspace, context.route, action)
    const workspaceInspection = await context.sessionStore.getWorkspaceInspection(workspaceId, {
      runLimit: 20
    })

    return jsonToolResult({
      workspaceId,
      action,
      workspace: workspaceInspection
    })
  },
  'workspace.context': async (_args, context) => {
    const workspaceId =
      context.workspaceTaskContext?.workspaceId ||
      context.workspaceReusableContext?.contextSnapshot?.workspaceId
    const workspaceSummary = workspaceId
      ? await context.sessionStore.getWorkspaceInspection(workspaceId, { runLimit: 10 })
      : null
    const payload = {
      ...(context.workspaceReusableContext || {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceSummary ? { workspaceSummary } : {})
    }
    return jsonToolResult(payload)
  },
  'memory.recent': async (_args, context) => ({
    content: context.workspaceMemoryPreview || 'No memory has been stored for this session yet.'
  }),
  'context.pinned': async (args, context) => {
    const action = String(args.action || 'list')
      .trim()
      .toLowerCase()
    if (action === 'list') {
      return {
        content: formatAssistantPinnedContext(context.workspacePinnedContext),
        metadata: {
          pinnedContext: context.workspacePinnedContext || null
        }
      }
    }

    return {
      content: 'Pinned context operation is not available.',
      metadata: {
        pinnedContext: context.workspacePinnedContext || null
      }
    }
  },
  'runs.list': async (args, context) => {
    const limit = clampToolLimit(args.limit, 5, 1, 20)
    const session = await context.sessionStore.getSession(context.route)
    return {
      content: JSON.stringify((session?.runs || []).slice(-limit).reverse(), null, 2),
      metadata: {
        sessionKey: session?.sessionKey || getAssistantSessionKey(context.route),
        limit
      }
    }
  },
  'runs.get': inspectRunRecord,
  'run.inspect': inspectRunRecord,
  'run.trace': async (args, context) => {
    const runId = String(args.runId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!runId) {
      throw new Error('run.trace requires a runId.')
    }

    const trace = await context.sessionStore.getRunTrace(runId, context.route)
    return jsonToolResult({
      sessionKey: getAssistantSessionKey(context.route),
      runId,
      found: Boolean(trace),
      trace
    })
  },
  'run.lineage': async (args, context) => {
    const runId = String(args.runId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!runId) {
      throw new Error('run.lineage requires a runId.')
    }

    const lineage = await context.sessionStore.getRunLineage(runId, context.route)
    return jsonToolResult({
      sessionKey: getAssistantSessionKey(context.route),
      runId,
      found: Boolean(lineage),
      lineage
    })
  },
  'run.replay': async (args, context) => {
    const runId = String(args.runId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!runId) {
      throw new Error('run.replay requires a runId.')
    }

    const [trace, lineage] = await Promise.all([
      context.sessionStore.getRunTrace(runId, context.route),
      context.sessionStore.getRunLineage(runId, context.route)
    ])
    const replayable = Boolean(trace && lineage)
    const suggestedRetryTool =
      lineage?.resumeEligible && context.resumeRun ? 'run.retry' : undefined
    const replay = {
      runId,
      replayable,
      ...(trace ? { trace } : {}),
      ...(lineage ? { lineage } : {}),
      ...(suggestedRetryTool ? { suggestedRetryTool } : {})
    }

    return jsonToolResult({
      sessionKey: getAssistantSessionKey(context.route),
      runId,
      found: replayable,
      replay
    })
  },
  'run.resume': async (args, context) => {
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: context.route,
      sessionId: getAssistantSessionKey(context.route),
      toolName: 'run.resume',
      toolInput: args as PolicyJsonRecord
    })
    const runId = String(args.runId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!runId) {
      throw new Error('run.resume requires a runId.')
    }
    if (!context.resumeRun) {
      throw new Error('run.resume is not available without runtime control support.')
    }

    const result = await context.resumeRun(context.route, runId, {
      async: Boolean(args.async)
    })
    return jsonToolResult({
      resumedFromRunId: runId,
      accepted: Boolean(args.async),
      result
    })
  },
  'run.retry': async (args, context) => {
    const runId = String(args.runId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!runId) {
      throw new Error('run.retry requires a runId.')
    }
    if (!context.resumeRun) {
      throw new Error('run.retry is not available without runtime control support.')
    }

    const result = await context.resumeRun(context.route, runId, {
      async: Boolean(args.async)
    })
    return jsonToolResult({
      retriedFromRunId: runId,
      accepted: Boolean(args.async),
      result
    })
  },
  'artifacts.list': async (args, context) => {
    const limit = clampToolLimit(args.limit, 5, 1, 20)
    const session = await context.sessionStore.getSession(context.route)
    return {
      content: JSON.stringify((session?.artifacts || []).slice(-limit).reverse(), null, 2),
      metadata: {
        sessionKey: session?.sessionKey || getAssistantSessionKey(context.route),
        limit
      }
    }
  },
  'artifacts.get': async (args, context) => {
    const artifactId = String(args.artifactId || '')
      .trim()
      .replace(/^"|"$/g, '')
    if (!artifactId) {
      throw new Error('artifacts.get requires an artifactId.')
    }

    const session = await context.sessionStore.getSession(context.route)
    const artifact = session?.artifacts.find((item) => item.artifactId === artifactId) || null

    return jsonToolResult({
      sessionKey: session?.sessionKey || getAssistantSessionKey(context.route),
      artifactId,
      found: Boolean(artifact),
      artifact
    })
  },
  'limits.status': async (_args, context) => {
    const payload = await summarizeStoreLimits(context)
    return jsonToolResult(payload)
  },
  'audit.timeline': async (args, context) => {
    const limit = clampToolLimit(args.limit, 20, 1, 100)
    const runId = String(args.runId || '').trim()
    const timeline = await context.sessionStore.listAuditTimeline({
      limit,
      route: context.route,
      ...(runId ? { runId } : {})
    })
    const payload = {
      sessionKey: getAssistantSessionKey(context.route),
      limit,
      ...(runId ? { runId } : {}),
      returnedCount: timeline.length,
      timeline
    }

    return jsonToolResult(payload)
  },
  'ops.status': async (args, context) => {
    const limit = clampToolLimit(args.limit, 5, 1, 20)
    const payload = {
      currentRoute: await context.sessionStore.getOpsStatus({
        limit,
        route: context.route
      }),
      global: await context.sessionStore.getOpsStatus({ limit })
    }

    return jsonToolResult(payload)
  }
}

export class AssistantToolRegistry {
  private readonly mcpClientManager: McpClientManager

  constructor(mcpClientManager: McpClientManager = getMcpClientManager()) {
    this.mcpClientManager = mcpClientManager
  }

  listTools(): AssistantToolDefinition[] {
    return [...baseDefinitions, ...this.mcpClientManager.listToolsSnapshot()]
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context: Omit<AssistantToolCallContext, 'workspaceMemoryPreview'> & {
      workspaceMemoryFile?: string
      workspaceTaskContextFile?: string
      workspaceContextFile?: string
      workspacePinnedContextFile?: string
      workspaceMetaFile?: string
      workspaceRootDir?: string
      toolPolicyOrigin?: 'assistant' | 'graph'
    }
  ): Promise<AssistantToolCallResult> {
    throwIfAborted(context.signal)
    const normalizedName = normalizeMagicPotToolName(name)

    if (
      [
        'git.status',
        'git.diff',
        'git.log',
        'git.show',
        'git.branch',
        'git.checkout',
        'git.add',
        'git.commit'
      ].includes(normalizedName)
    ) {
      if (!context.workspaceRootDir) throw new Error('Git tools require a route workspace root.')
      const runtime = context.terminalPolicyRuntime ?? getAssistantTerminalPolicyRuntime()
      const repository =
        typeof args.repository === 'string' && args.repository ? args.repository : '.'
      const pathspecs = Array.isArray(args.pathspecs)
        ? args.pathspecs.filter((v): v is string => typeof v === 'string')
        : []
      const revision = typeof args.revision === 'string' ? args.revision : undefined
      const request = assertPolicyRequest({
        discriminator: 'magic-agent.policy-request.v1',
        version: 1,
        requestId: randomUUID(),
        actor: { kind: 'system', id: 'git-tool-host' },
        origin: context.toolPolicyOrigin ?? 'assistant',
        action: normalizedName,
        target: { kind: 'tool', id: normalizedName },
        route: { ...context.route },
        sessionId: getAssistantSessionKey(context.route),
        input: { repository, pathspecs, ...(revision ? { revision } : {}) },
        effects: [
          {
            kind:
              normalizedName === 'git.branch'
                ? 'git.branch'
                : normalizedName === 'git.checkout'
                  ? 'git.checkout'
                  : normalizedName === 'git.add'
                    ? 'git.add'
                    : normalizedName === 'git.commit'
                      ? 'git.commit'
                      : 'filesystem.read',
            risk: ['git.branch', 'git.checkout', 'git.add', 'git.commit'].includes(normalizedName)
              ? 'high'
              : normalizedName === 'git.status' || normalizedName === 'git.log'
                ? 'read'
                : 'low',
            target: repository
          }
        ],
        filesystem: {
          cwd: context.workspaceRootDir,
          paths: [repository, ...pathspecs],
          allowedRoots: [context.workspaceRootDir]
        }
      })
      const host = await GitToolHost.create(runtime.authorization, {
        allowedRoots: [context.workspaceRootDir],
        onAudit: createMagicAgentToolAuditSink(runtime.eventStore, `git:${request.requestId}`)
      })
      const writeTool = ['git.branch', 'git.checkout', 'git.add', 'git.commit'].includes(
        normalizedName
      )
      const approval = writeTool
        ? context.terminalApproval
          ? context.terminalApproval(request)
          : process.env.NODE_ENV === 'test'
            ? runtime.createTrustedApproval(request)
            : await runtime.requestTerminalApproval(request)
        : undefined
      const common = {
        authorizationId: randomUUID(),
        idempotencyKey: `assistant-git:${request.requestId}`,
        request,
        input: { ...args, repository },
        signal: context.signal,
        ...(approval ?? {})
      }
      let output: unknown
      if (normalizedName === 'git.status') output = await host.status(common)
      else if (normalizedName === 'git.diff')
        output = await host.diff(common as Parameters<GitToolHost['diff']>[0])
      else if (normalizedName === 'git.log')
        output = await host.log(common as Parameters<GitToolHost['log']>[0])
      else if (normalizedName === 'git.show')
        output = await host.show(common as Parameters<GitToolHost['show']>[0])
      else if (normalizedName === 'git.branch')
        output = await host.branch(common as Parameters<GitToolHost['branch']>[0])
      else if (normalizedName === 'git.checkout')
        output = await host.checkout(common as Parameters<GitToolHost['checkout']>[0])
      else if (normalizedName === 'git.add')
        output = await host.add(common as Parameters<GitToolHost['add']>[0])
      else output = await host.commit(common as Parameters<GitToolHost['commit']>[0])
      return jsonToolResult(output)
    }

    if (
      [
        'notebook.execute-cell',
        'notebook.execute-all',
        'notebook.status',
        'notebook.interrupt',
        'notebook.restart'
      ].includes(normalizedName)
    ) {
      if (!context.workspaceRootDir)
        throw new Error('Notebook execution requires a route workspace root.')
      const host = getNotebookExecutionHost(context)
      const runtime = context.terminalPolicyRuntime ?? getAssistantTerminalPolicyRuntime()
      const pathValue = typeof args.path === 'string' ? args.path.replace(/\\/g, '/') : ''
      const routeKey = JSON.stringify(context.route)
      const sessionId = getAssistantSessionKey(context.route)
      if (normalizedName === 'notebook.status') {
        const output = host.status({
          routeKey,
          sessionId,
          path: pathValue,
          executionId: typeof args.executionId === 'string' ? args.executionId : undefined
        })
        return jsonToolResult(output)
      }
      const target = normalizedName as
        'notebook.execute-cell' | 'notebook.execute-all' | 'notebook.interrupt' | 'notebook.restart'
      const request = host.createPolicyRequest({
        target,
        origin: context.toolPolicyOrigin ?? 'assistant',
        route: { ...context.route },
        routeKey,
        sessionId,
        path: pathValue,
        expectedSha256: typeof args.expectedSha256 === 'string' ? args.expectedSha256 : undefined,
        expectedGeneration:
          typeof args.expectedGeneration === 'number' ? args.expectedGeneration : undefined,
        cellIds: Array.isArray(args.cellIds) ? args.cellIds.map(String) : undefined,
        artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(String) : undefined
      })
      const approval =
        process.env.NODE_ENV === 'test'
          ? { ...runtime.createTrustedApproval(request), authorizationId: randomUUID() }
          : context.terminalApproval
            ? { ...context.terminalApproval(request), authorizationId: randomUUID() }
            : await runtime.requestTerminalApproval(request)
      const common = {
        authorizationId: approval.authorizationId ?? randomUUID(),
        idempotencyKey:
          typeof args.idempotencyKey === 'string' ? args.idempotencyKey : randomUUID(),
        request,
        routeKey,
        sessionId,
        path: pathValue,
        grantId: approval.grantId,
        expectedGrantUseCount: approval.expectedGrantUseCount
      }
      let output
      if (target === 'notebook.execute-cell')
        output = await host.executeCell({
          ...common,
          expectedSha256: String(args.expectedSha256),
          expectedGeneration: Number(args.expectedGeneration),
          cellIds: Array.isArray(args.cellIds) ? args.cellIds.map(String) : undefined,
          artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(String) : undefined,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          maxOutputBytes: typeof args.maxOutputBytes === 'number' ? args.maxOutputBytes : undefined
        })
      else if (target === 'notebook.execute-all')
        output = await host.executeAll({
          ...common,
          expectedSha256: String(args.expectedSha256),
          expectedGeneration: Number(args.expectedGeneration),
          artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(String) : undefined,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          maxOutputBytes: typeof args.maxOutputBytes === 'number' ? args.maxOutputBytes : undefined
        })
      else if (target === 'notebook.interrupt')
        output = await host.interrupt({
          ...common,
          executionId: typeof args.executionId === 'string' ? args.executionId : undefined
        })
      else
        output = await host.restart({
          ...common,
          executionId: typeof args.executionId === 'string' ? args.executionId : undefined
        })
      return jsonToolResult(output)
    }

    if (
      [
        'notebook.list',
        'notebook.read',
        'notebook.insert',
        'notebook.replace',
        'notebook.delete',
        'notebook.convert',
        'notebook.clear-outputs'
      ].includes(normalizedName)
    ) {
      if (!context.workspaceRootDir)
        throw new Error('Notebook tools require a route workspace root.')
      const runtime = context.terminalPolicyRuntime ?? getAssistantTerminalPolicyRuntime()
      const requestedPath =
        typeof args.path === 'string' && args.path ? args.path.replace(/\\/g, '/') : '.'
      const writeTool = !['notebook.list', 'notebook.read'].includes(normalizedName)
      const policyTool = writeTool ? 'notebook.write' : normalizedName
      const request = createFilesToolPolicyRequest({
        requestId: randomUUID(),
        origin: context.toolPolicyOrigin ?? 'assistant',
        actor: { kind: 'system', id: 'notebook-tool-host' },
        target: { kind: 'tool', id: policyTool },
        route: { ...context.route },
        sessionId: getAssistantSessionKey(context.route),
        action: writeTool
          ? 'notebook.write'
          : normalizedName === 'notebook.list'
            ? 'filesystem.list'
            : 'filesystem.read',
        toolInput: { path: requestedPath },
        filesystem: { paths: [requestedPath], allowedRoots: [context.workspaceRootDir] }
      })
      const host = await NotebookToolHost.create(runtime.authorization, {
        allowedRoots: [context.workspaceRootDir],
        onAudit: createMagicAgentToolAuditSink(runtime.eventStore, `notebook:${request.requestId}`)
      })
      const approval = writeTool
        ? context.terminalApproval
          ? context.terminalApproval(request)
          : process.env.NODE_ENV === 'test'
            ? runtime.createTrustedApproval(request)
            : await runtime.requestTerminalApproval(request)
        : undefined
      const common = {
        authorizationId: randomUUID(),
        idempotencyKey: `assistant-notebook:${request.requestId}`,
        request,
        input: { ...args, path: requestedPath },
        signal: context.signal,
        ...(approval ?? {})
      }
      let output: unknown
      if (normalizedName === 'notebook.list')
        output = await host.list(common as Parameters<NotebookToolHost['list']>[0])
      else if (normalizedName === 'notebook.read')
        output = await host.read(common as Parameters<NotebookToolHost['read']>[0])
      else if (normalizedName === 'notebook.insert')
        output = await host.insert(common as Parameters<NotebookToolHost['insert']>[0])
      else if (normalizedName === 'notebook.replace')
        output = await host.replace(common as Parameters<NotebookToolHost['replace']>[0])
      else if (normalizedName === 'notebook.delete')
        output = await host.delete(common as Parameters<NotebookToolHost['delete']>[0])
      else if (normalizedName === 'notebook.convert')
        output = await host.convert(common as Parameters<NotebookToolHost['convert']>[0])
      else
        output = await host.clearOutputs(common as Parameters<NotebookToolHost['clearOutputs']>[0])
      return jsonToolResult(output)
    }

    if (
      [
        'files.tree',
        'files.read',
        'files.glob',
        'files.grep',
        'files.json.read',
        'files.write',
        'files.edit',
        'files.patch',
        'files.multi-edit',
        'files.json.write',
        'files.diff',
        'files.snapshot.list',
        'files.snapshot.restore'
      ].includes(normalizedName)
    ) {
      if (!context.workspaceRootDir) throw new Error('File tools require a route workspace root.')
      const runtime = context.terminalPolicyRuntime ?? getAssistantTerminalPolicyRuntime()
      const requestedPath =
        typeof args.path === 'string' && args.path ? args.path.replace(/\\/g, '/') : '.'
      const request = createFilesToolPolicyRequest({
        requestId: randomUUID(),
        origin: context.toolPolicyOrigin ?? 'assistant',
        actor: { kind: 'system', id: 'files-tool-host' },
        target: { kind: 'tool', id: normalizedName },
        route: { ...context.route },
        sessionId: getAssistantSessionKey(context.route),
        action: [
          'files.write',
          'files.edit',
          'files.patch',
          'files.multi-edit',
          'files.json.write',
          'files.snapshot.restore'
        ].includes(normalizedName)
          ? 'filesystem.write'
          : ['files.tree', 'files.glob', 'files.snapshot.list'].includes(normalizedName)
            ? 'filesystem.list'
            : normalizedName === 'files.grep'
              ? 'filesystem.search'
              : 'filesystem.read',
        toolInput: { path: requestedPath },
        filesystem: { paths: [requestedPath], allowedRoots: [context.workspaceRootDir] }
      })
      const host = await FilesToolHost.create(runtime.authorization, {
        allowedRoots: [context.workspaceRootDir],
        onAudit: createMagicAgentToolAuditSink(runtime.eventStore, `files:${request.requestId}`)
      })
      const input = { ...args, path: requestedPath }
      const writeTool = [
        'files.write',
        'files.edit',
        'files.patch',
        'files.multi-edit',
        'files.json.write',
        'files.snapshot.restore'
      ].includes(normalizedName)
      const approval = writeTool
        ? context.terminalApproval
          ? context.terminalApproval(request)
          : process.env.NODE_ENV === 'test'
            ? runtime.createTrustedApproval(request)
            : await runtime.requestTerminalApproval(request)
        : undefined
      const common = {
        authorizationId: randomUUID(),
        idempotencyKey: `assistant-files:${request.requestId}`,
        request,
        input,
        signal: context.signal,
        ...(approval ?? {})
      }
      let output: unknown
      if (normalizedName === 'files.tree') output = await host.tree(common)
      else if (normalizedName === 'files.read')
        output = await host.read(common as Parameters<FilesToolHost['read']>[0])
      else if (normalizedName === 'files.glob')
        output = await host.glob(common as Parameters<FilesToolHost['glob']>[0])
      else if (normalizedName === 'files.grep')
        output = await host.grep(common as Parameters<FilesToolHost['grep']>[0])
      else if (normalizedName === 'files.write')
        output = await host.write(common as Parameters<FilesToolHost['write']>[0])
      else if (normalizedName === 'files.edit')
        output = await host.edit(common as Parameters<FilesToolHost['edit']>[0])
      else if (normalizedName === 'files.patch')
        output = await host.patch(common as Parameters<FilesToolHost['patch']>[0])
      else if (normalizedName === 'files.multi-edit')
        output = await host.multiEdit(
          common as unknown as Parameters<FilesToolHost['multiEdit']>[0]
        )
      else if (normalizedName === 'files.json.write')
        output = await host.jsonWrite(common as Parameters<FilesToolHost['jsonWrite']>[0])
      else if (normalizedName === 'files.diff')
        output = await host.diff(common as Parameters<FilesToolHost['diff']>[0])
      else if (normalizedName === 'files.snapshot.list')
        output = await host.snapshotList(common as Parameters<FilesToolHost['snapshotList']>[0])
      else if (normalizedName === 'files.snapshot.restore')
        output = await host.snapshotRestore(
          common as Parameters<FilesToolHost['snapshotRestore']>[0]
        )
      else output = await host.jsonRead(common as Parameters<FilesToolHost['jsonRead']>[0])
      return jsonToolResult(output)
    }

    const toolDefinition = this.listTools().find(
      (tool) => normalizeMagicPotToolName(tool.name) === normalizedName
    )
    if (toolDefinition) {
      assertValidToolArgs(normalizedName, args, toolDefinition.inputSchema)
    }

    if (normalizedName === 'mcp.status') {
      const status = await getMcpRuntimeStatus(context.config, this.mcpClientManager)
      return jsonToolResult(status)
    }

    const handler = Object.prototype.hasOwnProperty.call(toolHandlers, normalizedName)
      ? toolHandlers[normalizedName as keyof typeof toolHandlers]
      : undefined

    const workspaceReusableContext = await readAssistantReusableContextPackFromFiles({
      contextFile: context.workspaceContextFile,
      taskContextFile: context.workspaceTaskContextFile,
      pinnedContextFile: context.workspacePinnedContextFile,
      memoryFile: context.workspaceMemoryFile,
      workspaceMetaFile: context.workspaceMetaFile
    })
    throwIfAborted(context.signal)
    const workspaceMemoryPreview = workspaceReusableContext.memoryPreview
    const workspaceTaskContext = workspaceReusableContext.taskContext
    const workspacePinnedContext = workspaceReusableContext.pinnedContext

    if (name === 'context.pinned') {
      const action = String(args.action || 'list')
        .trim()
        .toLowerCase()
      if (action !== 'list') {
        let mutationAction: 'add' | 'remove' | 'clear'
        switch (action) {
          case 'add':
          case 'remove':
          case 'clear':
            mutationAction = action
            break
          default:
            throw new Error(`Unsupported pinned context action: ${action}`)
        }
        if (!context.workspacePinnedContextFile) {
          throw new Error('Pinned context file is not available for this session.')
        }

        const workspaceId =
          workspaceTaskContext?.workspaceId || workspaceReusableContext.contextSnapshot?.workspaceId
        const workspace = getAssistantWorkspaceState(context.route, workspaceId)

        const nextPinnedContext = await updateAssistantPinnedContext(
          {
            ...workspace,
            memoryFile: context.workspaceMemoryFile || workspace.memoryFile,
            contextFile: context.workspaceContextFile || workspace.contextFile,
            taskContextFile: context.workspaceTaskContextFile || workspace.taskContextFile,
            pinnedContextFile: context.workspacePinnedContextFile || workspace.pinnedContextFile
          },
          {
            route: context.route,
            action: mutationAction,
            text: typeof args.text === 'string' ? args.text : undefined,
            noteId: typeof args.noteId === 'string' ? args.noteId : undefined,
            index: Number.isFinite(Number(args.index)) ? Number(args.index) : undefined
          }
        )

        return {
          content:
            action === 'add'
              ? `Pinned note saved.\n\n${formatAssistantPinnedContext(nextPinnedContext)}`
              : action === 'clear'
                ? 'Pinned context notes cleared for this session.'
                : `Pinned note removed.\n\n${formatAssistantPinnedContext(nextPinnedContext)}`,
          metadata: {
            pinnedContext: nextPinnedContext
          }
        }
      }
    }

    if (handler) {
      throwIfAborted(context.signal)
      return handler(args, {
        ...context,
        workspaceMemoryPreview,
        workspaceTaskContext,
        workspacePinnedContext,
        workspaceReusableContext
      })
    }

    const externalResult = await this.mcpClientManager.callToolByAlias(
      normalizedName,
      args,
      context.signal
    )
    if (externalResult) {
      return externalResult
    }

    throw new Error(`Unknown chat tool: ${name}`)
  }
}
