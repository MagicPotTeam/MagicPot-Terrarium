import {
  createMagicAgentValidationResult,
  isPlainRecord,
  makeMagicAgentIssue,
  normalizeMagicAgentBoolean,
  normalizeMagicAgentId,
  normalizeMagicAgentOptionalText,
  normalizeMagicAgentRecord,
  normalizeMagicAgentSchema,
  validateMagicAgentRecord,
  validateMagicAgentRequiredText,
  type MagicAgentJsonSchema,
  type MagicAgentJsonValue,
  type MagicAgentRecord,
  type MagicAgentValidationIssue,
  type MagicAgentValidationResult
} from './common'

export const MAGIC_AGENT_INPUT_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'json',
  'object',
  'array',
  'image',
  'video',
  'audio',
  'file',
  'select',
  'multiselect',
  'secret'
] as const

export type MagicAgentInputType = (typeof MAGIC_AGENT_INPUT_TYPES)[number]

export type MagicAgentInputChoice = {
  value: MagicAgentJsonValue
  label: string
  description?: string
}

export type MagicAgentInputSpec = {
  id: string
  type: MagicAgentInputType
  title: string
  description?: string
  required: boolean
  defaultValue?: MagicAgentJsonValue
  schema?: MagicAgentJsonSchema
  choices?: MagicAgentInputChoice[]
  ui?: MagicAgentRecord
  metadata?: MagicAgentRecord
}

const DEFAULT_INPUT_TYPE: MagicAgentInputType = 'string'
const INPUT_TYPE_SET = new Set<string>(MAGIC_AGENT_INPUT_TYPES)

export const isMagicAgentInputType = (value: unknown): value is MagicAgentInputType =>
  INPUT_TYPE_SET.has(String(value || ''))

export const normalizeMagicAgentInputType = (value: unknown): MagicAgentInputType =>
  isMagicAgentInputType(value) ? value : DEFAULT_INPUT_TYPE

export const normalizeMagicAgentInputChoice = (value: unknown): MagicAgentInputChoice | null => {
  if (!isPlainRecord(value)) {
    return null
  }

  if (!('value' in value)) {
    return null
  }

  const label = normalizeMagicAgentOptionalText(value.label) || String(value.value ?? '')
  return {
    value: value.value as MagicAgentJsonValue,
    label,
    ...(normalizeMagicAgentOptionalText(value.description)
      ? { description: normalizeMagicAgentOptionalText(value.description) }
      : {})
  }
}

export const normalizeMagicAgentInputChoices = (value: unknown): MagicAgentInputChoice[] =>
  Array.isArray(value)
    ? value
        .map((item) => normalizeMagicAgentInputChoice(item))
        .filter((item): item is MagicAgentInputChoice => Boolean(item))
    : []

export const normalizeMagicAgentInputSpec = (
  input: Partial<MagicAgentInputSpec> & MagicAgentRecord
): MagicAgentInputSpec => {
  const title =
    normalizeMagicAgentOptionalText(input.title) ||
    normalizeMagicAgentOptionalText(input.id) ||
    'Input'
  const choices = normalizeMagicAgentInputChoices(input.choices)
  return {
    id: normalizeMagicAgentId(input.id, 'input'),
    type: normalizeMagicAgentInputType(input.type),
    title,
    required: normalizeMagicAgentBoolean(input.required, false),
    ...(normalizeMagicAgentOptionalText(input.description)
      ? { description: normalizeMagicAgentOptionalText(input.description) }
      : {}),
    ...(input.defaultValue !== undefined
      ? { defaultValue: input.defaultValue as MagicAgentJsonValue }
      : {}),
    ...(normalizeMagicAgentSchema(input.schema)
      ? { schema: normalizeMagicAgentSchema(input.schema) }
      : {}),
    ...(choices.length > 0 ? { choices } : {}),
    ...(normalizeMagicAgentRecord(input.ui) ? { ui: normalizeMagicAgentRecord(input.ui) } : {}),
    ...(normalizeMagicAgentRecord(input.metadata)
      ? { metadata: normalizeMagicAgentRecord(input.metadata) }
      : {})
  }
}

export const validateMagicAgentInputSpec = (
  value: unknown
): MagicAgentValidationResult<MagicAgentInputSpec> => {
  const issues: MagicAgentValidationIssue[] = []
  const input = validateMagicAgentRecord(value, 'input', issues, 'input')
  validateMagicAgentRequiredText(input.id, 'input.id', issues, 'input id')
  validateMagicAgentRequiredText(input.title, 'input.title', issues, 'input title')

  if (input.type !== undefined && !isMagicAgentInputType(input.type)) {
    issues.push(makeMagicAgentIssue('input.type', `Unsupported input type: ${String(input.type)}.`))
  }

  if (input.choices !== undefined && !Array.isArray(input.choices)) {
    issues.push(makeMagicAgentIssue('input.choices', 'input choices must be an array.'))
  }

  if (Array.isArray(input.choices)) {
    input.choices.forEach((choice, index) => {
      if (!isPlainRecord(choice) || !('value' in choice)) {
        issues.push(
          makeMagicAgentIssue(
            `input.choices.${index}`,
            'input choice must be an object with a value.'
          )
        )
      }
    })
  }

  return createMagicAgentValidationResult(normalizeMagicAgentInputSpec(input), issues)
}
