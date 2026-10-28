import Ajv, { type ValidateFunction } from 'ajv'
import type { LLMChatResult, LLMStructuredOutput } from '@shared/llm'

/**
 * Provider-native structured output is only a request hint. Every provider
 * (including compatible gateways) must still satisfy the same postcondition
 * before its response crosses the main-process API boundary.
 */
const MAX_SCHEMA_DEPTH = 64
const MAX_SCHEMA_NODES = 10_000
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_OUTPUT_DEPTH = 128
const MAX_OUTPUT_NODES = 100_000
const MAX_COMPILED_SCHEMAS = 32

// `normalizeLLMStructuredOutput` detaches the schema on every IPC request, so
// an object-identity cache would miss on every call. Cache by serialized schema
// instead, with a small LRU bound so a caller cannot grow this process forever.
const compiled = new Map<string, ValidateFunction>()

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}

type ScanOptions = {
  maxDepth: number
  maxNodes: number
  rejectExternalRefs?: boolean
}

const scanJsonValue = (value: unknown, options: ScanOptions): void => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > options.maxNodes) throw new Error('structured output value has too many nodes')
    if (current.depth > options.maxDepth)
      throw new Error('structured output value is too deeply nested')

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1)
        pending.push({ value: current.value[index], depth: current.depth + 1 })
      continue
    }
    if (!current.value || typeof current.value !== 'object') continue

    for (const [key, child] of Object.entries(current.value)) {
      if (
        options.rejectExternalRefs &&
        (key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef')
      ) {
        if (typeof child !== 'string' || (child !== '#' && !child.startsWith('#/')))
          throw new Error('structured output schema contains an external reference')
      }
      pending.push({ value: child, depth: current.depth + 1 })
    }
  }
}

const getValidator = (schema: Record<string, unknown>): ValidateFunction => {
  scanJsonValue(schema, {
    maxDepth: MAX_SCHEMA_DEPTH,
    maxNodes: MAX_SCHEMA_NODES,
    rejectExternalRefs: true
  })
  const key = canonicalJson(schema)
  const cached = compiled.get(key)
  if (cached) {
    // Touch the entry so the oldest unused contract is evicted first.
    compiled.delete(key)
    compiled.set(key, cached)
    return cached
  }
  // Ajv keeps its own schema cache and global IDs. A per-contract instance
  // makes our LRU the sole owner, so eviction also releases compiler state and
  // unrelated contracts may use the same local $id without colliding.
  const validator = new Ajv({
    allErrors: false,
    strict: false,
    validateSchema: false
  })
  const validate = validator.compile(schema)
  compiled.set(key, validate)
  while (compiled.size > MAX_COMPILED_SCHEMAS) compiled.delete(compiled.keys().next().value!)
  return validate
}

/** Validate one final provider result without exposing payload details in errors. */
export const assertStructuredOutputResult = (
  result: Pick<LLMChatResult, 'content'>,
  contract: LLMStructuredOutput | undefined
): void => {
  if (!contract) return
  if (typeof result.content !== 'string' || !result.content.trim()) {
    throw new Error('Provider returned empty structured output.')
  }
  if (new TextEncoder().encode(result.content).byteLength > MAX_OUTPUT_BYTES) {
    throw new Error('Provider returned structured output that is too large.')
  }

  let value: unknown
  try {
    value = JSON.parse(result.content)
  } catch {
    throw new Error('Provider returned invalid structured output JSON.')
  }
  try {
    scanJsonValue(value, { maxDepth: MAX_OUTPUT_DEPTH, maxNodes: MAX_OUTPUT_NODES })
  } catch {
    throw new Error('Provider returned structured output that is too complex.')
  }

  let validate: ValidateFunction
  try {
    validate = getValidator(contract.schema)
  } catch {
    throw new Error('Structured output contract is invalid.')
  }
  if (!validate(value)) throw new Error('Provider output does not match the requested schema.')
}

export const LLM_STRUCTURED_OUTPUT_MAX_BYTES = MAX_OUTPUT_BYTES
