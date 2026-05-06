import type { Config } from '@shared/config/config'
import { normalizeMagicPotToolName, type MagicPotAppToolDescriptor } from '@shared/app/types'
import { buildAgentRoute } from '@shared/agent'
import type { SkillRuntimeSpec } from './chatSkillRuntime'
import { callSessionTool } from './chatToolRuntimeClient'

export type ParsedExplicitToolCommand = {
  toolName: string
  args: Record<string, unknown>
}

type ExecuteSkillToolCommandInput = {
  commandText: string
  runtime: SkillRuntimeSpec
  sessionId: string
  config: Config
  authSecret?: string
  callToolImpl?: (
    options: Parameters<typeof callSessionTool>[0]
  ) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
}

const cleanString = (value?: string | null): string => String(value || '').trim()

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const normalizeSchemaStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : []

const buildExampleValueFromSchema = (schema: unknown): unknown => {
  if (!isPlainObject(schema)) {
    return ''
  }

  const schemaType = typeof schema.type === 'string' ? schema.type : undefined

  switch (schemaType) {
    case 'object': {
      const properties = isPlainObject(schema.properties)
        ? (schema.properties as Record<string, unknown>)
        : {}
      const required = normalizeSchemaStringArray(schema.required)
      const selectedKeys =
        required.length > 0
          ? required
          : Object.keys(properties).slice(0, Math.min(2, Object.keys(properties).length))

      return Object.fromEntries(
        selectedKeys
          .filter((key) => key in properties)
          .map((key) => [key, buildExampleValueFromSchema(properties[key])])
      )
    }
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'string':
    default:
      return ''
  }
}

const formatSchemaFieldList = (schema: unknown): string[] => {
  if (!isPlainObject(schema) || typeof schema.type !== 'string') {
    return []
  }

  if (schema.type === 'object' && isPlainObject(schema.properties)) {
    return Object.keys(schema.properties).filter((key) => key.trim().length > 0)
  }

  return []
}

const validateSchemaValue = (schema: unknown, value: unknown, path: string): string[] => {
  if (!isPlainObject(schema)) {
    return []
  }

  const schemaType = typeof schema.type === 'string' ? schema.type : undefined
  const errors: string[] = []

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const matchesEnum = schema.enum.some((candidate) => Object.is(candidate, value))
    if (!matchesEnum) {
      errors.push(
        `${path} must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(', ')}`
      )
      return errors
    }
  }

  switch (schemaType) {
    case 'object': {
      if (!isPlainObject(value)) {
        errors.push(`${path} must be a JSON object`)
        return errors
      }

      const required = normalizeSchemaStringArray(schema.required)
      required.forEach((key) => {
        if (!(key in value)) {
          errors.push(`missing required field "${key}"`)
        }
      })

      const properties = isPlainObject(schema.properties)
        ? (schema.properties as Record<string, unknown>)
        : {}

      Object.entries(properties).forEach(([key, propertySchema]) => {
        if (key in value) {
          errors.push(...validateSchemaValue(propertySchema, value[key], `${path}.${key}`))
        }
      })

      if (schema.additionalProperties === false) {
        Object.keys(value).forEach((key) => {
          if (!(key in properties)) {
            errors.push(`unexpected field "${key}"`)
          }
        })
      }

      return errors
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path} must be a JSON array`)
        return errors
      }

      if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
        errors.push(`${path} must contain at least ${schema.minItems} item(s)`)
      }

      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
        errors.push(`${path} must contain at most ${schema.maxItems} item(s)`)
      }

      if (schema.items) {
        value.forEach((item, index) => {
          errors.push(...validateSchemaValue(schema.items, item, `${path}[${index}]`))
        })
      }

      return errors
    }
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path} must be a string`)
        return errors
      }

      if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
        errors.push(`${path} must be at least ${schema.minLength} character(s)`)
      }

      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
        errors.push(`${path} must be at most ${schema.maxLength} character(s)`)
      }

      return errors
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${path} must be an integer`)
        return errors
      }

      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        errors.push(`${path} must be greater than or equal to ${schema.minimum}`)
      }

      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        errors.push(`${path} must be less than or equal to ${schema.maximum}`)
      }

      return errors
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push(`${path} must be a number`)
        return errors
      }

      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        errors.push(`${path} must be greater than or equal to ${schema.minimum}`)
      }

      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        errors.push(`${path} must be less than or equal to ${schema.maximum}`)
      }

      return errors
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push(`${path} must be a boolean`)
      }
      return errors
    }
    case 'null': {
      if (value !== null) {
        errors.push(`${path} must be null`)
      }
      return errors
    }
    default:
      return errors
  }
}

const buildParsedArgsValidationPayload = (
  args: Record<string, unknown>
): { value: unknown; textFallback: boolean } => {
  const keys = Object.keys(args)
  const textFallback = keys.length === 1 && keys[0] === 'input' && typeof args.input === 'string'
  return {
    value: textFallback ? args.input : args,
    textFallback
  }
}

export const buildToolInputSchemaSummary = (
  tool: MagicPotAppToolDescriptor
): string | undefined => {
  const schema = tool.inputSchema
  if (!isPlainObject(schema) || !schema.type) {
    return undefined
  }

  const schemaType = String(schema.type)
  if (schemaType === 'object') {
    const required = normalizeSchemaStringArray(schema.required)
    const fields = formatSchemaFieldList(schema)
    const parts = ['JSON object']

    if (required.length > 0) {
      parts.push(`required: ${required.join(', ')}`)
    } else if (fields.length > 0) {
      parts.push(`fields: ${fields.slice(0, 3).join(', ')}`)
    }

    return parts.join('; ')
  }

  if (schemaType === 'array') {
    return 'JSON array'
  }

  if (schemaType === 'string') {
    return 'string'
  }

  if (schemaType === 'integer' || schemaType === 'number' || schemaType === 'boolean') {
    return schemaType
  }

  return schemaType
}

export const buildToolCommandExample = (tool: MagicPotAppToolDescriptor): string =>
  `/tool ${tool.name} ${JSON.stringify(buildExampleValueFromSchema(tool.inputSchema), null, 2)}`

export const validateToolCommandArgs = (
  tool: MagicPotAppToolDescriptor,
  args: Record<string, unknown>
): string | null => {
  const schema = tool.inputSchema
  if (!isPlainObject(schema) || !schema.type) {
    return null
  }

  const { value, textFallback } = buildParsedArgsValidationPayload(args)
  const validationTarget = textFallback && schema.type === 'object' ? args : value
  const validationErrors = validateSchemaValue(schema, validationTarget, 'input')
  if (validationErrors.length > 0) {
    return `Tool "${tool.name}" requires ${buildToolInputSchemaSummary(tool) || 'structured input'}. ${validationErrors.join(
      '; '
    )}.`
  }

  return null
}

export const parseExplicitToolCommand = (
  value?: string | null
): ParsedExplicitToolCommand | null => {
  const normalized = cleanString(value)
  if (!normalized) {
    return null
  }

  const match = normalized.match(/^\/tool\s+([a-z0-9._-]+)(?:\s+(.+))?$/i)
  const toolName = normalizeMagicPotToolName(match?.[1])
  if (!toolName) {
    return null
  }

  const argsPayload = cleanString(match?.[2])
  if (!argsPayload) {
    return {
      toolName,
      args: {}
    }
  }

  try {
    return {
      toolName,
      args: JSON.parse(argsPayload) as Record<string, unknown>
    }
  } catch {
    return {
      toolName,
      args: { input: argsPayload }
    }
  }
}

export const resolveAllowedSkillTools = (
  runtime: SkillRuntimeSpec
): MagicPotAppToolDescriptor[] => {
  const seen = new Set<string>()
  const resolved: MagicPotAppToolDescriptor[] = []

  runtime.boundBindings.forEach((binding) => {
    binding.app.capabilities.tools.forEach((tool) => {
      if (!binding.toolNames.includes(tool.name) || seen.has(tool.name)) {
        return
      }
      seen.add(tool.name)
      resolved.push(tool)
    })
  })

  return resolved
}

export const resolveAllowedSkillToolNames = (runtime: SkillRuntimeSpec): string[] =>
  resolveAllowedSkillTools(runtime).map((tool) => normalizeMagicPotToolName(tool.name))

export const buildToolRouteDraftForChatSession = (sessionId: string) =>
  ((route) => ({
    ...route,
    threadId: route.threadId || route.scopeId
  }))(
    buildAgentRoute({
      channel: 'generic',
      scopeType: 'thread',
      scopeId: sessionId,
      threadId: sessionId
    })
  )

export const executeExplicitSkillToolCommand = async (
  input: ExecuteSkillToolCommandInput
): Promise<{ content?: string; metadata?: Record<string, unknown> }> => {
  const parsed = parseExplicitToolCommand(input.commandText)
  if (!parsed) {
    throw new Error('No explicit /tool command was provided.')
  }

  const allowedToolNames = resolveAllowedSkillToolNames(input.runtime)
  if (allowedToolNames.length === 0) {
    throw new Error('The current skill does not bind any executable tools.')
  }

  if (!allowedToolNames.includes(parsed.toolName)) {
    throw new Error(`Tool "${parsed.toolName}" is not bound to the current skill.`)
  }

  const matchedTool = input.runtime.boundBindings
    .flatMap((binding) => binding.app.capabilities.tools)
    .find((tool) => normalizeMagicPotToolName(tool.name) === parsed.toolName)

  if (matchedTool) {
    const validationError = validateToolCommandArgs(matchedTool, parsed.args)
    if (validationError) {
      throw new Error(validationError)
    }
  }

  const callToolImpl = input.callToolImpl || callSessionTool
  return callToolImpl({
    config: input.config,
    authSecret: input.authSecret,
    route: buildToolRouteDraftForChatSession(input.sessionId),
    toolName: parsed.toolName,
    args: parsed.args,
    allowedToolNames
  })
}
