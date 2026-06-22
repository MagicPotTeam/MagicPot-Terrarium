import {
  MAGIC_AGENT_CONTRACT_VERSION,
  MAGIC_AGENT_DEFAULT_VERSION,
  createMagicAgentValidationResult,
  isPlainRecord,
  makeMagicAgentIssue,
  normalizeMagicAgentId,
  normalizeMagicAgentNumber,
  normalizeMagicAgentOptionalText,
  normalizeMagicAgentRecord,
  normalizeMagicAgentTags,
  normalizeMagicAgentVersion,
  validateMagicAgentRecord,
  validateMagicAgentRequiredText,
  type MagicAgentRecord,
  type MagicAgentValidationIssue,
  type MagicAgentValidationResult
} from './common'
import {
  normalizeMagicAgentEventType,
  type MagicAgentEvent,
  type MagicAgentEventType
} from './events'
import {
  normalizeMagicAgentGraphSpec,
  validateMagicAgentGraphSpec,
  type MagicAgentGraphSpec
} from './graph'
import {
  normalizeMagicAgentInputSpec,
  validateMagicAgentInputSpec,
  type MagicAgentInputSpec
} from './input'
import {
  normalizeMagicAgentOutputSpec,
  validateMagicAgentOutputSpec,
  type MagicAgentOutputSpec
} from './output'
import {
  normalizeMagicAgentPluginSpec,
  validateMagicAgentPluginSpec,
  type MagicAgentPluginSpec
} from './plugins'
import {
  normalizeMagicAgentToolSpec,
  validateMagicAgentToolSpec,
  type MagicAgentToolSpec
} from './tools'
import {
  normalizeMagicAgentTriggerSpec,
  validateMagicAgentTriggerSpec,
  type MagicAgentTriggerSpec
} from './triggers'

export type MagicAgentModelSpec = {
  provider?: string
  model?: string
  temperature?: number
  maxTokens?: number
  config?: MagicAgentRecord
}

export type MagicAgentEventSubscriptionSpec = {
  emits: Array<MagicAgentEventType | string>
  consumes: Array<MagicAgentEventType | string>
}

export type AgentSpec = {
  contractVersion: number
  id: string
  title: string
  version: string
  description?: string
  author?: string
  tags: string[]
  instructions: string
  model?: MagicAgentModelSpec
  tools: MagicAgentToolSpec[]
  triggers: MagicAgentTriggerSpec[]
  inputs: MagicAgentInputSpec[]
  outputs: MagicAgentOutputSpec[]
  plugins: MagicAgentPluginSpec[]
  events: MagicAgentEventSubscriptionSpec
  graph?: MagicAgentGraphSpec
  runtime?: MagicAgentRecord
  metadata?: MagicAgentRecord
}

const normalizeMagicAgentModelSpec = (value: unknown): MagicAgentModelSpec | undefined => {
  if (!isPlainRecord(value)) {
    return undefined
  }

  return {
    ...(normalizeMagicAgentOptionalText(value.provider)
      ? { provider: normalizeMagicAgentOptionalText(value.provider) }
      : {}),
    ...(normalizeMagicAgentOptionalText(value.model)
      ? { model: normalizeMagicAgentOptionalText(value.model) }
      : {}),
    ...(value.temperature !== undefined
      ? { temperature: normalizeMagicAgentNumber(value.temperature, 0, { min: 0, max: 2 }) }
      : {}),
    ...(value.maxTokens !== undefined
      ? { maxTokens: normalizeMagicAgentNumber(value.maxTokens, 0, { min: 0, integer: true }) }
      : {}),
    ...(normalizeMagicAgentRecord(value.config)
      ? { config: normalizeMagicAgentRecord(value.config) }
      : {})
  }
}

const normalizeMagicAgentEventSubscriptionSpec = (
  value: unknown
): MagicAgentEventSubscriptionSpec => {
  const record = isPlainRecord(value) ? value : {}
  const normalizeEvents = (events: unknown): Array<MagicAgentEventType | string> =>
    Array.isArray(events)
      ? [
          ...new Set(
            events
              .map((event) => normalizeMagicAgentEventType(event))
              .filter((event) => Boolean(event))
          )
        ]
      : []

  return {
    emits: normalizeEvents(record.emits),
    consumes: normalizeEvents(record.consumes)
  }
}

const normalizeSpecArray = <T>(
  value: unknown,
  normalizeItem: (item: MagicAgentRecord) => T
): T[] =>
  Array.isArray(value)
    ? value.filter(isPlainRecord).map((item) => normalizeItem(item as MagicAgentRecord))
    : []

const prefixIssues = (
  prefix: string,
  issues: MagicAgentValidationIssue[]
): MagicAgentValidationIssue[] =>
  issues.map((issue) => ({
    ...issue,
    path: `${prefix}.${issue.path}`
  }))

const validateSpecArray = <T>(
  value: unknown,
  path: string,
  issues: MagicAgentValidationIssue[],
  validateItem: (item: unknown) => MagicAgentValidationResult<T>
): void => {
  if (value === undefined) {
    return
  }

  if (!Array.isArray(value)) {
    issues.push(makeMagicAgentIssue(path, `${path} must be an array.`))
    return
  }

  value.forEach((item, index) => {
    const result = validateItem(item)
    issues.push(...prefixIssues(`${path}.${index}`, result.issues))
  })
}

export const normalizeMagicAgentSpec = (value: unknown): AgentSpec => {
  const spec = isPlainRecord(value) ? value : {}
  const id = normalizeMagicAgentId(spec.id, 'agent')
  const title = normalizeMagicAgentOptionalText(spec.title) || id

  return {
    contractVersion: normalizeMagicAgentNumber(spec.contractVersion, MAGIC_AGENT_CONTRACT_VERSION, {
      min: 1,
      integer: true
    }),
    id,
    title,
    version: normalizeMagicAgentVersion(spec.version || MAGIC_AGENT_DEFAULT_VERSION),
    tags: normalizeMagicAgentTags(spec.tags),
    instructions: normalizeMagicAgentOptionalText(spec.instructions) || '',
    tools: normalizeSpecArray(spec.tools, normalizeMagicAgentToolSpec),
    triggers: normalizeSpecArray(spec.triggers, normalizeMagicAgentTriggerSpec),
    inputs: normalizeSpecArray(spec.inputs, normalizeMagicAgentInputSpec),
    outputs: normalizeSpecArray(spec.outputs, normalizeMagicAgentOutputSpec),
    plugins: normalizeSpecArray(spec.plugins, normalizeMagicAgentPluginSpec),
    events: normalizeMagicAgentEventSubscriptionSpec(spec.events),
    ...(normalizeMagicAgentOptionalText(spec.description)
      ? { description: normalizeMagicAgentOptionalText(spec.description) }
      : {}),
    ...(normalizeMagicAgentOptionalText(spec.author)
      ? { author: normalizeMagicAgentOptionalText(spec.author) }
      : {}),
    ...(normalizeMagicAgentModelSpec(spec.model)
      ? { model: normalizeMagicAgentModelSpec(spec.model) }
      : {}),
    ...(isPlainRecord(spec.graph) ? { graph: normalizeMagicAgentGraphSpec(spec.graph) } : {}),
    ...(normalizeMagicAgentRecord(spec.runtime)
      ? { runtime: normalizeMagicAgentRecord(spec.runtime) }
      : {}),
    ...(normalizeMagicAgentRecord(spec.metadata)
      ? { metadata: normalizeMagicAgentRecord(spec.metadata) }
      : {})
  }
}

export const validateMagicAgentSpec = (value: unknown): MagicAgentValidationResult<AgentSpec> => {
  const issues: MagicAgentValidationIssue[] = []
  const spec = validateMagicAgentRecord(value, 'agent', issues, 'agent')
  validateMagicAgentRequiredText(spec.id, 'agent.id', issues, 'agent id')
  validateMagicAgentRequiredText(spec.title, 'agent.title', issues, 'agent title')

  if (spec.contractVersion !== undefined && !Number.isFinite(Number(spec.contractVersion))) {
    issues.push(
      makeMagicAgentIssue('agent.contractVersion', 'agent contractVersion must be a number.')
    )
  }

  if (spec.tags !== undefined && !Array.isArray(spec.tags)) {
    issues.push(makeMagicAgentIssue('agent.tags', 'agent tags must be an array.'))
  }

  if (spec.model !== undefined && !isPlainRecord(spec.model)) {
    issues.push(makeMagicAgentIssue('agent.model', 'agent model must be an object.'))
  }

  validateSpecArray(spec.tools, 'agent.tools', issues, validateMagicAgentToolSpec)
  validateSpecArray(spec.triggers, 'agent.triggers', issues, validateMagicAgentTriggerSpec)
  validateSpecArray(spec.inputs, 'agent.inputs', issues, validateMagicAgentInputSpec)
  validateSpecArray(spec.outputs, 'agent.outputs', issues, validateMagicAgentOutputSpec)
  validateSpecArray(spec.plugins, 'agent.plugins', issues, validateMagicAgentPluginSpec)

  if (spec.events !== undefined) {
    if (!isPlainRecord(spec.events)) {
      issues.push(makeMagicAgentIssue('agent.events', 'agent events must be an object.'))
    } else {
      if (spec.events.emits !== undefined && !Array.isArray(spec.events.emits)) {
        issues.push(
          makeMagicAgentIssue('agent.events.emits', 'agent emitted events must be an array.')
        )
      }
      if (spec.events.consumes !== undefined && !Array.isArray(spec.events.consumes)) {
        issues.push(
          makeMagicAgentIssue('agent.events.consumes', 'agent consumed events must be an array.')
        )
      }
    }
  }

  if (spec.graph !== undefined) {
    const graphResult = validateMagicAgentGraphSpec(spec.graph)
    issues.push(...prefixIssues('agent', graphResult.issues))
  }

  return createMagicAgentValidationResult(normalizeMagicAgentSpec(spec), issues)
}

export const isMagicAgentSpec = (value: unknown): value is AgentSpec =>
  validateMagicAgentSpec(value).ok

export type MagicAgentRuntimeEvent = MagicAgentEvent
