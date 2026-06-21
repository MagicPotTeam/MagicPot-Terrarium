import {
  createMagicAgentValidationResult,
  isPlainRecord,
  makeMagicAgentIssue,
  normalizeMagicAgentId,
  normalizeMagicAgentOptionalText,
  normalizeMagicAgentRecord,
  normalizeMagicAgentSchema,
  validateMagicAgentRecord,
  validateMagicAgentRequiredText,
  type MagicAgentJsonSchema,
  type MagicAgentRecord,
  type MagicAgentValidationIssue,
  type MagicAgentValidationResult
} from './common'

export const MAGIC_AGENT_OUTPUT_TYPES = [
  'text',
  'markdown',
  'json',
  'object',
  'image',
  'video',
  'audio',
  'file',
  'artifact',
  'event'
] as const

export type MagicAgentOutputType = (typeof MAGIC_AGENT_OUTPUT_TYPES)[number]

export type MagicAgentOutputSpec = {
  id: string
  type: MagicAgentOutputType
  title: string
  description?: string
  mimeType?: string
  schema?: MagicAgentJsonSchema
  metadata?: MagicAgentRecord
}

const DEFAULT_OUTPUT_TYPE: MagicAgentOutputType = 'text'
const OUTPUT_TYPE_SET = new Set<string>(MAGIC_AGENT_OUTPUT_TYPES)

export const isMagicAgentOutputType = (value: unknown): value is MagicAgentOutputType =>
  OUTPUT_TYPE_SET.has(String(value || ''))

export const normalizeMagicAgentOutputType = (value: unknown): MagicAgentOutputType =>
  isMagicAgentOutputType(value) ? value : DEFAULT_OUTPUT_TYPE

export const normalizeMagicAgentOutputSpec = (
  output: Partial<MagicAgentOutputSpec> & MagicAgentRecord
): MagicAgentOutputSpec => {
  const title =
    normalizeMagicAgentOptionalText(output.title) ||
    normalizeMagicAgentOptionalText(output.id) ||
    'Output'

  return {
    id: normalizeMagicAgentId(output.id, 'output'),
    type: normalizeMagicAgentOutputType(output.type),
    title,
    ...(normalizeMagicAgentOptionalText(output.description)
      ? { description: normalizeMagicAgentOptionalText(output.description) }
      : {}),
    ...(normalizeMagicAgentOptionalText(output.mimeType)
      ? { mimeType: normalizeMagicAgentOptionalText(output.mimeType) }
      : {}),
    ...(normalizeMagicAgentSchema(output.schema)
      ? { schema: normalizeMagicAgentSchema(output.schema) }
      : {}),
    ...(normalizeMagicAgentRecord(output.metadata)
      ? { metadata: normalizeMagicAgentRecord(output.metadata) }
      : {})
  }
}

export const validateMagicAgentOutputSpec = (
  value: unknown
): MagicAgentValidationResult<MagicAgentOutputSpec> => {
  const issues: MagicAgentValidationIssue[] = []
  const output = validateMagicAgentRecord(value, 'output', issues, 'output')
  validateMagicAgentRequiredText(output.id, 'output.id', issues, 'output id')
  validateMagicAgentRequiredText(output.title, 'output.title', issues, 'output title')

  if (output.type !== undefined && !isMagicAgentOutputType(output.type)) {
    issues.push(
      makeMagicAgentIssue('output.type', `Unsupported output type: ${String(output.type)}.`)
    )
  }

  if (output.schema !== undefined && !isPlainRecord(output.schema)) {
    issues.push(makeMagicAgentIssue('output.schema', 'output schema must be an object.'))
  }

  return createMagicAgentValidationResult(normalizeMagicAgentOutputSpec(output), issues)
}
