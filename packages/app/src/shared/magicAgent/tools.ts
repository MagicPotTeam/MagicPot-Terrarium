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
  type MagicAgentRecord,
  type MagicAgentValidationIssue,
  type MagicAgentValidationResult
} from './common'

export const MAGIC_AGENT_TOOL_SCOPES = ['agent', 'session', 'workspace', 'global'] as const
export const MAGIC_AGENT_TOOL_TRANSPORTS = ['local', 'mcp', 'http', 'bridge', 'qapp'] as const

export type MagicAgentToolScope = (typeof MAGIC_AGENT_TOOL_SCOPES)[number]
export type MagicAgentToolTransport = (typeof MAGIC_AGENT_TOOL_TRANSPORTS)[number]

export type MagicAgentToolSpec = {
  id: string
  name: string
  title: string
  description: string
  scope: MagicAgentToolScope
  transport: MagicAgentToolTransport
  inputSchema?: MagicAgentJsonSchema
  outputSchema?: MagicAgentJsonSchema
  destructive: boolean
  async: boolean
  metadata?: MagicAgentRecord
}

const TOOL_SCOPE_SET = new Set<string>(MAGIC_AGENT_TOOL_SCOPES)
const TOOL_TRANSPORT_SET = new Set<string>(MAGIC_AGENT_TOOL_TRANSPORTS)

export const isMagicAgentToolScope = (value: unknown): value is MagicAgentToolScope =>
  TOOL_SCOPE_SET.has(String(value || ''))

export const isMagicAgentToolTransport = (value: unknown): value is MagicAgentToolTransport =>
  TOOL_TRANSPORT_SET.has(String(value || ''))

export const normalizeMagicAgentToolScope = (value: unknown): MagicAgentToolScope =>
  isMagicAgentToolScope(value) ? value : 'agent'

export const normalizeMagicAgentToolTransport = (value: unknown): MagicAgentToolTransport =>
  isMagicAgentToolTransport(value) ? value : 'local'

export const normalizeMagicAgentToolSpec = (
  tool: Partial<MagicAgentToolSpec> & MagicAgentRecord
): MagicAgentToolSpec => {
  const name =
    normalizeMagicAgentOptionalText(tool.name) || normalizeMagicAgentOptionalText(tool.id) || 'tool'
  const title = normalizeMagicAgentOptionalText(tool.title) || name
  return {
    id: normalizeMagicAgentId(tool.id, normalizeMagicAgentId(name, 'tool')),
    name,
    title,
    description: normalizeMagicAgentOptionalText(tool.description) || '',
    scope: normalizeMagicAgentToolScope(tool.scope),
    transport: normalizeMagicAgentToolTransport(tool.transport),
    destructive: normalizeMagicAgentBoolean(tool.destructive, false),
    async: normalizeMagicAgentBoolean(tool.async, false),
    ...(normalizeMagicAgentSchema(tool.inputSchema)
      ? { inputSchema: normalizeMagicAgentSchema(tool.inputSchema) }
      : {}),
    ...(normalizeMagicAgentSchema(tool.outputSchema)
      ? { outputSchema: normalizeMagicAgentSchema(tool.outputSchema) }
      : {}),
    ...(normalizeMagicAgentRecord(tool.metadata)
      ? { metadata: normalizeMagicAgentRecord(tool.metadata) }
      : {})
  }
}

export const validateMagicAgentToolSpec = (
  value: unknown
): MagicAgentValidationResult<MagicAgentToolSpec> => {
  const issues: MagicAgentValidationIssue[] = []
  const tool = validateMagicAgentRecord(value, 'tool', issues, 'tool')
  validateMagicAgentRequiredText(tool.id, 'tool.id', issues, 'tool id')
  validateMagicAgentRequiredText(tool.name, 'tool.name', issues, 'tool name')
  validateMagicAgentRequiredText(tool.title, 'tool.title', issues, 'tool title')

  if (tool.scope !== undefined && !isMagicAgentToolScope(tool.scope)) {
    issues.push(makeMagicAgentIssue('tool.scope', `Unsupported tool scope: ${String(tool.scope)}.`))
  }

  if (tool.transport !== undefined && !isMagicAgentToolTransport(tool.transport)) {
    issues.push(
      makeMagicAgentIssue(
        'tool.transport',
        `Unsupported tool transport: ${String(tool.transport)}.`
      )
    )
  }

  if (tool.inputSchema !== undefined && !isPlainRecord(tool.inputSchema)) {
    issues.push(makeMagicAgentIssue('tool.inputSchema', 'tool inputSchema must be an object.'))
  }

  if (tool.outputSchema !== undefined && !isPlainRecord(tool.outputSchema)) {
    issues.push(makeMagicAgentIssue('tool.outputSchema', 'tool outputSchema must be an object.'))
  }

  return createMagicAgentValidationResult(normalizeMagicAgentToolSpec(tool), issues)
}
