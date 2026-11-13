import { isProxy } from 'node:util/types'

/** MAIN-only pure row decoder prerequisite: not a query, snapshot certificate or read grant. */
export type AgentInstanceIdentityProjection = Readonly<{
  status: 'available'
  instanceId: string
  definitionId: string
  configVersion: string
  instanceRevision: number
  configRevision: number
}> | Readonly<{ status: 'unavailable'; reason: 'unavailable' }>

export const AGENT_INSTANCE_IDENTITY_PROJECTION_LIMITS = Object.freeze({
  instanceBytes: 16 * 1024,
  configBytes: 64 * 1024,
  identityBytes: 256,
  maxDepth: 32,
  maxNodes: 4096
})
const limits = AGENT_INSTANCE_IDENTITY_PROJECTION_LIMITS
const unavailable = Object.freeze({ status: 'unavailable', reason: 'unavailable' } as const)
const rowKeys = ['instanceId', 'instanceRevision', 'instanceDeleted', 'instanceStateJson', 'configId', 'configRevision', 'configDeleted', 'configStateJson'] as const
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor'])
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const wellFormed = (text: string): boolean => {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}
const boundedText = (value: unknown, cap: number): value is string =>
  typeof value === 'string' && value.length <= cap && Buffer.byteLength(value, 'utf8') <= cap && wellFormed(value)
const identity = (value: unknown): value is string => {
  if (!boundedText(value, limits.identityBytes) || value.length === 0 || value !== value.trim()) return false
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x1f || unit === 0x7f) return false
  }
  return true
}
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Only call on JSON.parse output after the iterative depth/node/string guards below. */
const canonical = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const parseState = (text: string): Record<string, JsonValue> | null => {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const pending: [unknown, number][] = [[parsed, 0]]
  let visited = 0
  while (pending.length) {
    const [value, depth] = pending.pop()!
    if (++visited > limits.maxNodes || depth > limits.maxDepth) return null
    if (typeof value === 'string') { if (!wellFormed(value)) return null }
    else if (typeof value === 'number') { if (!Number.isFinite(value)) return null }
    else if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value)
      if (visited + pending.length + keys.length > limits.maxNodes) return null
      for (const key of keys) {
        if (dangerousKeys.has(key) || !wellFormed(key)) return null
        pending.push([(value as Record<string, unknown>)[key], depth + 1])
      }
    } else if (value !== null && typeof value !== 'boolean') return null
  }
  // Full capped JSON is processed internally, including nonidentity fields. Exact
  // equality rejects duplicate keys and noncanonical representations, not strips them.
  if (canonical(parsed as JsonValue) !== text) return null
  return parsed as Record<string, JsonValue>
}

/** Decode complete capped row JSON; no store, query, readiness or permission fallback. */
export const projectAgentInstanceIdentityRow = (
  expectedInstanceId: unknown,
  row: unknown
): AgentInstanceIdentityProjection => {
  try {
    // Validate the primitive selection before reflecting on the row at all.
    if (!identity(expectedInstanceId) || !row || typeof row !== 'object' || isProxy(row) || Array.isArray(row)) return unavailable
    const prototype = Object.getPrototypeOf(row)
    if (prototype !== Object.prototype && prototype !== null) return unavailable
    const descriptors = Object.getOwnPropertyDescriptors(row), keys = Reflect.ownKeys(descriptors)
    if (keys.length !== rowKeys.length || !rowKeys.every(key => {
      const descriptor = descriptors[key]
      return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
    })) return unavailable
    const instanceId: unknown = descriptors.instanceId.value, instanceRevision: unknown = descriptors.instanceRevision.value,
      instanceDeleted: unknown = descriptors.instanceDeleted.value, instanceStateJson: unknown = descriptors.instanceStateJson.value,
      configId: unknown = descriptors.configId.value, configRevision: unknown = descriptors.configRevision.value,
      configDeleted: unknown = descriptors.configDeleted.value, configStateJson: unknown = descriptors.configStateJson.value
    if (!identity(instanceId) || instanceId !== expectedInstanceId || !identity(configId) ||
      !revision(instanceRevision) || !revision(configRevision) || instanceDeleted !== 0 || configDeleted !== 0) return unavailable
    // BOTH complete text caps precede ANY parsing, including multibyte inputs.
    if (!boundedText(instanceStateJson, limits.instanceBytes) || !boundedText(configStateJson, limits.configBytes)) return unavailable
    const instance = parseState(instanceStateJson), config = parseState(configStateJson)
    if (!instance || !config || instance.id !== instanceId || !identity(instance.definitionId) ||
      !identity(instance.configVersion) || !['created', 'running', 'paused', 'stopped'].includes(instance.status as string) ||
      instance.configVersion !== configId || config.version !== configId || config.definitionId !== instance.definitionId) return unavailable
    return Object.freeze({ status: 'available', instanceId, definitionId: instance.definitionId, configVersion: instance.configVersion, instanceRevision, configRevision })
  } catch {
    // Never inspect parse/reflection exception diagnostics or retain raw state.
    return unavailable
  }
}
