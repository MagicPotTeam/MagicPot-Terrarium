import { isProxy } from 'node:util/types'
import { AGENT_INSTANCE_IDENTITY_PROJECTION_LIMITS as limits } from './agentInstanceIdentityProjection'

/** Provisional supplied-text header only: never a final identity, query or read grant. */
export type AgentInstanceIdentityCandidate = Readonly<{
  stage: 'provisional'
  instanceId: string
  definitionId: string
  configVersion: string
  instanceRevision: number
}>

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
const rowKeys = ['instanceId', 'instanceRevision', 'instanceDeleted', 'instanceStateJson'] as const
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor'])

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

/** Only used on parsed values after iterative depth/node/key/value checks. */
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
  // Full capped JSON, including nonidentity fields, is processed and then discarded.
  // Exact equality rejects duplicate/noncanonical input, rather than stripping it.
  if (canonical(parsed as JsonValue) !== text) return null
  return parsed as Record<string, JsonValue>
}

/** No store or fabricated config: a candidate must never be published as a final identity. */
export const decodeAgentInstanceIdentityCandidate = (
  expectedInstanceId: unknown,
  row: unknown
): AgentInstanceIdentityCandidate | null => {
  try {
    if (!identity(expectedInstanceId) || !row || typeof row !== 'object' || isProxy(row) || Array.isArray(row)) return null
    const prototype = Object.getPrototypeOf(row)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(row), keys = Reflect.ownKeys(descriptors)
    if (keys.length !== rowKeys.length || !rowKeys.every(key => {
      const descriptor = descriptors[key]
      return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
    })) return null
    const instanceId: unknown = descriptors.instanceId.value, instanceRevision: unknown = descriptors.instanceRevision.value,
      instanceDeleted: unknown = descriptors.instanceDeleted.value, instanceStateJson: unknown = descriptors.instanceStateJson.value
    if (!identity(instanceId) || instanceId !== expectedInstanceId || typeof instanceRevision !== 'number' ||
      !Number.isSafeInteger(instanceRevision) || instanceRevision < 0 || instanceDeleted !== 0 ||
      !boundedText(instanceStateJson, limits.instanceBytes)) return null
    const state = parseState(instanceStateJson)
    if (!state || state.id !== instanceId || !identity(state.definitionId) || !identity(state.configVersion) ||
      !['created', 'running', 'paused', 'stopped'].includes(state.status as string)) return null
    return Object.freeze({ stage: 'provisional', instanceId, definitionId: state.definitionId, configVersion: state.configVersion, instanceRevision })
  } catch {
    // Catch the original thrown value without inspecting its diagnostics.
    return null
  }
}
