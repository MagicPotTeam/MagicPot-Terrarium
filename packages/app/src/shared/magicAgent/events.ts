import {
  createMagicAgentValidationResult,
  isPlainRecord,
  makeMagicAgentIssue,
  normalizeMagicAgentId,
  normalizeMagicAgentNumber,
  normalizeMagicAgentOptionalText,
  normalizeMagicAgentRecord,
  validateMagicAgentRecord,
  validateMagicAgentRequiredText,
  type MagicAgentRecord,
  type MagicAgentValidationIssue,
  type MagicAgentValidationResult
} from './common'

export const MAGIC_AGENT_EVENT_TYPES = [
  'agent.created',
  'agent.updated',
  'agent.deleted',
  'run.started',
  'run.completed',
  'run.failed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'input.requested',
  'output.created',
  'graph.node.started',
  'graph.node.completed',
  'graph.node.failed',
  'plugin.loaded',
  'plugin.failed'
] as const

export type MagicAgentEventType = (typeof MAGIC_AGENT_EVENT_TYPES)[number]

export type MagicAgentEvent = {
  id: string
  type: MagicAgentEventType | string
  agentId: string
  createdAt: number
  runId?: string
  nodeId?: string
  toolId?: string
  pluginId?: string
  message?: string
  payload?: MagicAgentRecord
  metadata?: MagicAgentRecord
}

const EVENT_TYPE_SET = new Set<string>(MAGIC_AGENT_EVENT_TYPES)

export const isKnownMagicAgentEventType = (value: unknown): value is MagicAgentEventType =>
  EVENT_TYPE_SET.has(String(value || ''))

export const normalizeMagicAgentEventType = (value: unknown): MagicAgentEventType | string =>
  normalizeMagicAgentOptionalText(value) || 'agent.updated'

export const normalizeMagicAgentEvent = (
  event: Partial<MagicAgentEvent> & MagicAgentRecord
): MagicAgentEvent => ({
  id: normalizeMagicAgentId(event.id, 'event'),
  type: normalizeMagicAgentEventType(event.type),
  agentId: normalizeMagicAgentId(event.agentId, 'agent'),
  createdAt: normalizeMagicAgentNumber(event.createdAt, Date.now(), { min: 0, integer: true }),
  ...(normalizeMagicAgentOptionalText(event.runId)
    ? { runId: normalizeMagicAgentOptionalText(event.runId) }
    : {}),
  ...(normalizeMagicAgentOptionalText(event.nodeId)
    ? { nodeId: normalizeMagicAgentOptionalText(event.nodeId) }
    : {}),
  ...(normalizeMagicAgentOptionalText(event.toolId)
    ? { toolId: normalizeMagicAgentOptionalText(event.toolId) }
    : {}),
  ...(normalizeMagicAgentOptionalText(event.pluginId)
    ? { pluginId: normalizeMagicAgentOptionalText(event.pluginId) }
    : {}),
  ...(normalizeMagicAgentOptionalText(event.message)
    ? { message: normalizeMagicAgentOptionalText(event.message) }
    : {}),
  ...(normalizeMagicAgentRecord(event.payload)
    ? { payload: normalizeMagicAgentRecord(event.payload) }
    : {}),
  ...(normalizeMagicAgentRecord(event.metadata)
    ? { metadata: normalizeMagicAgentRecord(event.metadata) }
    : {})
})

export const validateMagicAgentEvent = (
  value: unknown
): MagicAgentValidationResult<MagicAgentEvent> => {
  const issues: MagicAgentValidationIssue[] = []
  const event = validateMagicAgentRecord(value, 'event', issues, 'event')
  validateMagicAgentRequiredText(event.id, 'event.id', issues, 'event id')
  validateMagicAgentRequiredText(event.type, 'event.type', issues, 'event type')
  validateMagicAgentRequiredText(event.agentId, 'event.agentId', issues, 'agent id')

  if (event.createdAt !== undefined && !Number.isFinite(Number(event.createdAt))) {
    issues.push(makeMagicAgentIssue('event.createdAt', 'event createdAt must be a finite number.'))
  }

  if (event.payload !== undefined && !isPlainRecord(event.payload)) {
    issues.push(makeMagicAgentIssue('event.payload', 'event payload must be an object.'))
  }

  return createMagicAgentValidationResult(normalizeMagicAgentEvent(event), issues)
}
