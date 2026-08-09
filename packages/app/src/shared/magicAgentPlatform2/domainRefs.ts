import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '../agent'

export const MAGIC_AGENT_DOMAIN_REF_DISCRIMINATOR = 'magic-agent.domain-ref.v1' as const

export const MAGIC_AGENT_DOMAIN_REF_KINDS = [
  'agent-definition',
  'agent-instance',
  'graph-definition',
  'graph-run',
  'session',
  'trigger',
  'drive',
  'channel',
  'package',
  'tool',
  'artifact'
] as const

export type MagicAgentStandardDomainRefKind = (typeof MAGIC_AGENT_DOMAIN_REF_KINDS)[number]
export type MagicAgentDomainRefKind = MagicAgentStandardDomainRefKind | (string & {})
export type MagicAgentJsonValue =
  | null
  | boolean
  | number
  | string
  | MagicAgentJsonValue[]
  | { [key: string]: MagicAgentJsonValue }
export type MagicAgentJsonRecord = { [key: string]: MagicAgentJsonValue }

type MagicAgentDomainRefBase<TKind extends MagicAgentDomainRefKind> = {
  discriminator: typeof MAGIC_AGENT_DOMAIN_REF_DISCRIMINATOR
  kind: TKind
  id: string
  namespace?: string
  version?: string
  revision?: number
  extensions?: MagicAgentJsonRecord
}

export type MagicAgentDomainRef<TKind extends MagicAgentDomainRefKind = MagicAgentDomainRefKind> =
  MagicAgentDomainRefBase<TKind> & {
    [key: string]: MagicAgentJsonValue | undefined
  }

export type MagicAgentDomainRefInput<
  TKind extends MagicAgentDomainRefKind = MagicAgentDomainRefKind
> = Omit<MagicAgentDomainRefBase<TKind>, 'discriminator'> & {
  discriminator?: typeof MAGIC_AGENT_DOMAIN_REF_DISCRIMINATOR
  [key: string]: MagicAgentJsonValue | undefined
}

export type MagicAgentExecutionRefs = {
  session?: MagicAgentDomainRef<'session'>
  run?: MagicAgentDomainRef<'graph-run'>
  rootRun?: MagicAgentDomainRef<'graph-run'>
  parentRun?: MagicAgentDomainRef<'graph-run'>
  graphDefinition?: MagicAgentDomainRef<'graph-definition'>
  agentDefinition?: MagicAgentDomainRef<'agent-definition'>
  agentInstance?: MagicAgentDomainRef<'agent-instance'>
  drive?: MagicAgentDomainRef<'drive'>
}

export type MagicAgentContractIssue = { path: string; message: string }
export type MagicAgentContractParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: MagicAgentContractIssue[]; error: string }

type JsonRecord = Record<string, unknown>
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

const failure = <T>(path: string, message: string): MagicAgentContractParseResult<T> => ({
  ok: false,
  issues: [{ path, message }],
  error: path ? `${path}: ${message}` : message
})

const cloneJsonValue = (
  value: unknown,
  path: string,
  ancestors: Set<object>
): MagicAgentContractParseResult<MagicAgentJsonValue> => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { ok: true, value }
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : failure(path, 'must be a finite number.')
  }
  if (typeof value !== 'object') return failure(path, 'must contain only JSON-safe values.')
  if (ancestors.has(value)) return failure(path, 'must not contain cycles.')

  let prototype: object | null
  let descriptors: PropertyDescriptorMap
  let symbols: symbol[]
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
    symbols = Object.getOwnPropertySymbols(value)
  } catch {
    return failure(path, 'could not be inspected safely.')
  }
  if (symbols.length > 0) return failure(path, 'must not contain symbol properties.')

  ancestors.add(value)
  if (Array.isArray(value)) {
    const descriptorKeys = Object.keys(descriptors).filter((key) => key !== 'length')
    if (descriptorKeys.length !== value.length) {
      ancestors.delete(value)
      return failure(path, 'arrays must be dense and have no extra properties.')
    }
    const clone: MagicAgentJsonValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        ancestors.delete(value)
        return failure(`${path}[${index}]`, 'must be an enumerable data property.')
      }
      const item = cloneJsonValue(descriptor.value, `${path}[${index}]`, ancestors)
      if (!item.ok) {
        ancestors.delete(value)
        return item
      }
      clone.push(item.value)
    }
    ancestors.delete(value)
    return { ok: true, value: clone }
  }

  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.delete(value)
    return failure(path, 'must be a plain object.')
  }
  const clone: MagicAgentJsonRecord = Object.create(null) as MagicAgentJsonRecord
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const childPath = path ? `${path}.${key}` : key
    if (DANGEROUS_KEYS.has(key)) {
      ancestors.delete(value)
      return failure(childPath, 'uses a dangerous key.')
    }
    if (!descriptor.enumerable || !('value' in descriptor)) {
      ancestors.delete(value)
      return failure(childPath, 'must be an enumerable data property.')
    }
    const child = cloneJsonValue(descriptor.value, childPath, ancestors)
    if (!child.ok) {
      ancestors.delete(value)
      return child
    }
    clone[key] = child.value
  }
  ancestors.delete(value)
  return { ok: true, value: clone }
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const isTrimmedNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

const parseDomainRefClone = (
  input: unknown
): MagicAgentContractParseResult<MagicAgentDomainRef> => {
  const cloned = cloneJsonValue(input, '', new Set())
  if (!cloned.ok) return cloned
  if (Array.isArray(cloned.value) || cloned.value === null || typeof cloned.value !== 'object') {
    return failure('', 'DomainRef must be a plain object.')
  }
  const value = cloned.value as JsonRecord
  if (value.discriminator !== MAGIC_AGENT_DOMAIN_REF_DISCRIMINATOR) {
    return failure('discriminator', `must equal "${MAGIC_AGENT_DOMAIN_REF_DISCRIMINATOR}".`)
  }
  if (!isTrimmedNonEmptyString(value.kind)) return failure('kind', 'must be a non-empty string.')
  if (!isTrimmedNonEmptyString(value.id)) return failure('id', 'must be a non-empty string.')
  if (hasControlCharacter(value.id)) return failure('id', 'must not contain control characters.')
  for (const field of ['namespace', 'version'] as const) {
    if (value[field] !== undefined && !isTrimmedNonEmptyString(value[field])) {
      return failure(field, 'must be a non-empty string when present.')
    }
  }
  if (
    value.revision !== undefined &&
    (typeof value.revision !== 'number' ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0)
  ) {
    return failure('revision', 'must be a non-negative safe integer when present.')
  }
  if (
    value.extensions !== undefined &&
    (value.extensions === null ||
      typeof value.extensions !== 'object' ||
      Array.isArray(value.extensions))
  ) {
    return failure('extensions', 'must be a plain JSON-safe record when present.')
  }
  return { ok: true, value: deepFreeze(value as MagicAgentDomainRef) }
}

export const parseMagicAgentDomainRef = (
  input: unknown
): MagicAgentContractParseResult<MagicAgentDomainRef> => {
  try {
    return parseDomainRefClone(input)
  } catch {
    return failure('', 'DomainRef could not be read safely.')
  }
}

export const assertMagicAgentDomainRef = <
  TKind extends MagicAgentDomainRefKind = MagicAgentDomainRefKind
>(
  input: unknown
): MagicAgentDomainRef<TKind> => {
  const result = parseMagicAgentDomainRef(input)
  if (!result.ok) throw new Error(result.error)
  return result.value as MagicAgentDomainRef<TKind>
}

export const createMagicAgentDomainRef = <TKind extends MagicAgentDomainRefKind>(
  input: MagicAgentDomainRefInput<TKind>
): MagicAgentDomainRef<TKind> =>
  assertMagicAgentDomainRef<TKind>({
    ...input,
    discriminator: MAGIC_AGENT_DOMAIN_REF_DISCRIMINATOR
  })

export const createSessionDomainRef = (route: AgentRouteLike): MagicAgentDomainRef<'session'> =>
  createMagicAgentDomainRef({
    kind: 'session',
    id: getAgentSessionKey(normalizeAgentRoute(route))
  })

export const createGraphDefinitionDomainRef = (
  graphId: string,
  version?: string
): MagicAgentDomainRef<'graph-definition'> =>
  createMagicAgentDomainRef({
    kind: 'graph-definition',
    id: graphId,
    ...(version !== undefined ? { version } : {})
  })

export const createGraphRunDomainRef = (runId: string): MagicAgentDomainRef<'graph-run'> =>
  createMagicAgentDomainRef({ kind: 'graph-run', id: runId })

export const createAgentDefinitionDomainRef = (
  agentId: string,
  version?: string
): MagicAgentDomainRef<'agent-definition'> =>
  createMagicAgentDomainRef({
    kind: 'agent-definition',
    id: agentId,
    ...(version !== undefined ? { version } : {})
  })

export const createAgentInstanceDomainRef = (
  instanceId: string
): MagicAgentDomainRef<'agent-instance'> =>
  createMagicAgentDomainRef({ kind: 'agent-instance', id: instanceId })

const EXECUTION_REF_KINDS: Record<keyof MagicAgentExecutionRefs, MagicAgentStandardDomainRefKind> =
  {
    session: 'session',
    run: 'graph-run',
    rootRun: 'graph-run',
    parentRun: 'graph-run',
    graphDefinition: 'graph-definition',
    agentDefinition: 'agent-definition',
    agentInstance: 'agent-instance',
    drive: 'drive'
  }

export const parseMagicAgentExecutionRefs = (
  input: unknown
): MagicAgentContractParseResult<MagicAgentExecutionRefs> => {
  try {
    const cloned = cloneJsonValue(input, '', new Set())
    if (!cloned.ok) return cloned
    if (cloned.value === null || typeof cloned.value !== 'object' || Array.isArray(cloned.value)) {
      return failure('', 'Execution refs must be a plain object.')
    }
    const record = cloned.value as JsonRecord
    const fields = Object.keys(record)
    if (fields.length === 0) return failure('', 'Execution refs must contain at least one field.')
    for (const field of fields) {
      if (!(field in EXECUTION_REF_KINDS))
        return failure(field, 'is not a supported execution ref field.')
      const parsed = parseDomainRefClone(record[field])
      if (!parsed.ok) {
        return failure(field, parsed.error)
      }
      const expectedKind = EXECUTION_REF_KINDS[field as keyof MagicAgentExecutionRefs]
      if (parsed.value.kind !== expectedKind) {
        return failure(`${field}.kind`, `must equal "${expectedKind}".`)
      }
      record[field] = parsed.value
    }
    return { ok: true, value: deepFreeze(record as MagicAgentExecutionRefs) }
  } catch {
    return failure('', 'Execution refs could not be read safely.')
  }
}

export const assertMagicAgentExecutionRefs = (input: unknown): MagicAgentExecutionRefs => {
  const result = parseMagicAgentExecutionRefs(input)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

export const createMagicAgentExecutionRefs = (
  input: MagicAgentExecutionRefs
): MagicAgentExecutionRefs => assertMagicAgentExecutionRefs(input)
