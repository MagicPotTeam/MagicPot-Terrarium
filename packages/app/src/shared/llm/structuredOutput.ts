/**
 * Provider-neutral description of a JSON output contract.
 *
 * The contract is a request hint, never an execution grant. Providers which do
 * not expose native structured output may ignore it; callers must still
 * validate the returned value against their own schema.
 */
export type LLMStructuredOutput = {
  name: string
  schema: Record<string, unknown>
  strict?: boolean
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MAX_SCHEMA_BYTES = 32 * 1024
const MAX_SCHEMA_DEPTH = 64
const MAX_SCHEMA_NODES = 10_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength

/**
 * Bound schema traversal before a contract is handed to a provider. This is
 * intentionally dialect-neutral: provider-specific keywords remain intact,
 * while references cannot escape the detached schema document.
 */
const scanSchema = (schema: unknown): void => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > MAX_SCHEMA_NODES) {
      throw new TypeError('Structured output contract schema has too many nodes.')
    }
    if (current.depth > MAX_SCHEMA_DEPTH) {
      throw new TypeError('Structured output contract schema is too deeply nested.')
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], depth: current.depth + 1 })
      }
      continue
    }
    if (!current.value || typeof current.value !== 'object') continue
    for (const [key, child] of Object.entries(current.value)) {
      if (key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef') {
        if (typeof child !== 'string' || (child !== '#' && !child.startsWith('#/'))) {
          throw new TypeError('Structured output contract schema contains an external reference.')
        }
      }
      pending.push({ value: child, depth: current.depth + 1 })
    }
  }
}

/**
 * Clone and bound an untrusted contract before it reaches a provider client.
 * No defaults are applied to the schema itself, so provider-specific keywords
 * remain available while the request stays within the bridge budget.
 */
export const normalizeLLMStructuredOutput = (value: unknown): LLMStructuredOutput | undefined => {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new TypeError('Structured output contract must be an object.')

  const name = value.name
  const schema = value.schema
  const strict = value.strict
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new TypeError('Structured output contract has an invalid name.')
  }
  if (!isRecord(schema)) {
    throw new TypeError('Structured output contract schema must be an object.')
  }
  if (strict !== undefined && typeof strict !== 'boolean') {
    throw new TypeError('Structured output contract strict flag must be boolean.')
  }

  let serialized: string
  try {
    serialized = JSON.stringify(schema)
  } catch {
    throw new TypeError('Structured output contract schema is not serializable.')
  }
  if (!serialized || utf8Bytes(serialized) > MAX_SCHEMA_BYTES) {
    throw new TypeError('Structured output contract schema is too large.')
  }

  // JSON round-tripping detaches getters/proxies and prevents later mutation
  // of the caller's object from changing an in-flight provider request.
  let detached: unknown
  try {
    detached = JSON.parse(serialized)
  } catch {
    throw new TypeError('Structured output contract schema is not valid JSON.')
  }
  if (!isRecord(detached)) {
    throw new TypeError('Structured output contract schema must be an object.')
  }
  scanSchema(detached)
  return {
    name,
    schema: detached,
    ...(strict === undefined ? {} : { strict })
  }
}

export const LLM_STRUCTURED_OUTPUT_MAX_SCHEMA_BYTES = MAX_SCHEMA_BYTES
