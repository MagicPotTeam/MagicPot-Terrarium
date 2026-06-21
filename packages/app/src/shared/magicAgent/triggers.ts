import {
  createMagicAgentValidationResult,
  isPlainRecord,
  makeMagicAgentIssue,
  normalizeMagicAgentBoolean,
  normalizeMagicAgentId,
  normalizeMagicAgentOptionalText,
  normalizeMagicAgentRecord,
  validateMagicAgentRecord,
  validateMagicAgentRequiredText,
  type MagicAgentRecord,
  type MagicAgentValidationIssue,
  type MagicAgentValidationResult
} from './common'

export const MAGIC_AGENT_TRIGGER_TYPES = [
  'manual',
  'schedule',
  'event',
  'webhook',
  'file',
  'message',
  'startup'
] as const

export type MagicAgentTriggerType = (typeof MAGIC_AGENT_TRIGGER_TYPES)[number]

export type MagicAgentTriggerSpec = {
  id: string
  type: MagicAgentTriggerType
  title: string
  description?: string
  enabled: boolean
  config?: MagicAgentRecord
  metadata?: MagicAgentRecord
}

const TRIGGER_TYPE_SET = new Set<string>(MAGIC_AGENT_TRIGGER_TYPES)

export const isMagicAgentTriggerType = (value: unknown): value is MagicAgentTriggerType =>
  TRIGGER_TYPE_SET.has(String(value || ''))

export const normalizeMagicAgentTriggerType = (value: unknown): MagicAgentTriggerType =>
  isMagicAgentTriggerType(value) ? value : 'manual'

export const normalizeMagicAgentTriggerSpec = (
  trigger: Partial<MagicAgentTriggerSpec> & MagicAgentRecord
): MagicAgentTriggerSpec => {
  const title =
    normalizeMagicAgentOptionalText(trigger.title) ||
    normalizeMagicAgentOptionalText(trigger.id) ||
    'Trigger'

  return {
    id: normalizeMagicAgentId(trigger.id, 'trigger'),
    type: normalizeMagicAgentTriggerType(trigger.type),
    title,
    enabled: normalizeMagicAgentBoolean(trigger.enabled, true),
    ...(normalizeMagicAgentOptionalText(trigger.description)
      ? { description: normalizeMagicAgentOptionalText(trigger.description) }
      : {}),
    ...(normalizeMagicAgentRecord(trigger.config)
      ? { config: normalizeMagicAgentRecord(trigger.config) }
      : {}),
    ...(normalizeMagicAgentRecord(trigger.metadata)
      ? { metadata: normalizeMagicAgentRecord(trigger.metadata) }
      : {})
  }
}

export const validateMagicAgentTriggerSpec = (
  value: unknown
): MagicAgentValidationResult<MagicAgentTriggerSpec> => {
  const issues: MagicAgentValidationIssue[] = []
  const trigger = validateMagicAgentRecord(value, 'trigger', issues, 'trigger')
  validateMagicAgentRequiredText(trigger.id, 'trigger.id', issues, 'trigger id')
  validateMagicAgentRequiredText(trigger.title, 'trigger.title', issues, 'trigger title')

  if (trigger.type !== undefined && !isMagicAgentTriggerType(trigger.type)) {
    issues.push(
      makeMagicAgentIssue('trigger.type', `Unsupported trigger type: ${String(trigger.type)}.`)
    )
  }

  if (trigger.config !== undefined && !isPlainRecord(trigger.config)) {
    issues.push(makeMagicAgentIssue('trigger.config', 'trigger config must be an object.'))
  }

  return createMagicAgentValidationResult(normalizeMagicAgentTriggerSpec(trigger), issues)
}
