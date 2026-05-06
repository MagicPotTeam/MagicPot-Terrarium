import type { LLMChatSkillRuntime } from '@shared/api/svcLLMProxy'

type JsonSchema = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const formatPath = (path: string): string => (path ? path : '$')

const validateAgainstSchema = (value: unknown, schema: JsonSchema, path = '$'): string | null => {
  const schemaType = typeof schema.type === 'string' ? schema.type : undefined
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined

  if (enumValues && !enumValues.some((item) => Object.is(item, value))) {
    return `${formatPath(path)} must be one of ${enumValues.map((item) => JSON.stringify(item)).join(', ')}`
  }

  switch (schemaType) {
    case 'object': {
      if (!isRecord(value)) {
        return `${formatPath(path)} must be an object`
      }

      const required = Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === 'string')
        : []
      for (const key of required) {
        if (!(key in value)) {
          return `${formatPath(path)} is missing required property "${key}"`
        }
      }

      const properties = isRecord(schema.properties) ? schema.properties : {}
      for (const [key, childSchema] of Object.entries(properties)) {
        if (!(key in value) || !isRecord(childSchema)) {
          continue
        }
        const childError = validateAgainstSchema(
          value[key],
          childSchema,
          path === '$' ? key : `${path}.${key}`
        )
        if (childError) {
          return childError
        }
      }

      return null
    }
    case 'array': {
      if (!Array.isArray(value)) {
        return `${formatPath(path)} must be an array`
      }

      if (isRecord(schema.items)) {
        for (let index = 0; index < value.length; index += 1) {
          const childError = validateAgainstSchema(
            value[index],
            schema.items,
            `${formatPath(path)}[${index}]`
          )
          if (childError) {
            return childError
          }
        }
      }

      return null
    }
    case 'string':
      return typeof value === 'string' ? null : `${formatPath(path)} must be a string`
    case 'number':
      return typeof value === 'number' ? null : `${formatPath(path)} must be a number`
    case 'integer':
      return Number.isInteger(value) ? null : `${formatPath(path)} must be an integer`
    case 'boolean':
      return typeof value === 'boolean' ? null : `${formatPath(path)} must be a boolean`
    default:
      return null
  }
}

const parseStructuredJson = (content: string): unknown => {
  const trimmed = content.trim()
  if (!trimmed) {
    throw new Error('Structured output validation failed: empty response content.')
  }

  try {
    return JSON.parse(trimmed)
  } catch (error) {
    throw new Error(
      `Structured output validation failed: response is not valid JSON. ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

export const validateStructuredSkillOutput = (
  content: string,
  skillRuntime?: LLMChatSkillRuntime
): string | null => {
  if (skillRuntime?.execution?.outputMode !== 'structured') {
    return null
  }

  const parsed = parseStructuredJson(content)
  const outputSchema = isRecord(skillRuntime.outputSchema) ? skillRuntime.outputSchema : undefined
  if (!outputSchema) {
    return JSON.stringify(parsed, null, 2)
  }

  const validationError = validateAgainstSchema(parsed, outputSchema)
  if (validationError) {
    throw new Error(`Structured output validation failed: ${validationError}.`)
  }

  return JSON.stringify(parsed, null, 2)
}
