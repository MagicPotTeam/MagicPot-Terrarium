import { isProxy } from 'node:util/types'
import { canonicalPolicyJson, evaluatePolicy, parsePolicyRequest, POLICY_REQUEST_DISCRIMINATOR, POLICY_REQUEST_VERSION, type PolicyDecision, type PolicyJsonValue, type PolicyRequest, type PolicyRule } from '@shared/magicAgentPlatform2/policy'

const expectedRequest = (requestId: string) => ({
  discriminator: POLICY_REQUEST_DISCRIMINATOR, version: POLICY_REQUEST_VERSION, requestId,
  actor: { kind: 'service', id: 'main-management-startup-storage-reader' },
  origin: 'renderer', action: 'management.startup-storage-metadata.read', transport: 'electron-ipc',
  target: { kind: 'startup-storage-metadata', id: 'main-startup-storage-snapshot' }, input: {},
  // A cached scalar projection has no modeled external effects. This specific explicit grant
  // is required; generic empty-effect requests still default to deny. Not filesystem.read.
  effects: []
} satisfies PolicyRequest)
const deny: PolicyRule = { ruleId: 'management-startup-storage-read-default-deny', priority: 0, effect: 'deny', explanation: 'Only the exact MAIN-owned startup memory projection is accepted.' }
const allow: PolicyRule = {
  ruleId: 'management-startup-storage-read-exact', priority: 100, effect: 'allow-with-constraints',
  match: { origins: ['renderer'], actions: ['management.startup-storage-metadata.read'], actorKinds: ['service'], targetKinds: ['startup-storage-metadata'], transports: ['electron-ipc'] },
  constraints: { readOnly: true, requireNoShell: true, maxTimeoutMs: 2000, maxOutputChars: 256 },
  explanation: 'Explicit bounded startup-applied source/layout projection in memory only, no external effects.'
}
const invalid = Symbol('invalid-storage-policy-input')
function boundedSnapshot(input: unknown): PolicyJsonValue | typeof invalid {
  let nodes = 0
  const ancestors = new WeakSet<object>()
  const visit = (value: unknown, depth: number): PolicyJsonValue | typeof invalid => {
    if (++nodes > 48 || depth > 5) return invalid
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : invalid
    if (typeof value === 'string') return value.length <= 256 ? value : invalid
    if (!value || typeof value !== 'object' || isProxy(value) || ancestors.has(value)) return invalid
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid
    const keys = Reflect.ownKeys(value)
    if (keys.length > 16 || keys.some(key => typeof key !== 'string' || key.length > 64 || ['__proto__', 'prototype', 'constructor'].includes(key))) return invalid
    const descriptors = Object.getOwnPropertyDescriptors(value)
    ancestors.add(value)
    if (array) {
      const length = descriptors.length?.value
      if (!Number.isSafeInteger(length) || length < 0 || length > 4 || keys.length !== length + 1) return invalid
      const output: PolicyJsonValue[] = []
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)]
        if (!descriptor?.enumerable || !('value' in descriptor)) return invalid
        const item = visit(descriptor.value, depth + 1); if (item === invalid) return invalid
        output.push(item)
      }
      ancestors.delete(value); return output
    }
    const output: Record<string, PolicyJsonValue> = {}
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !('value' in descriptor)) return invalid
      const item = visit(descriptor.value, depth + 1); if (item === invalid) return invalid
      output[key] = item
    }
    ancestors.delete(value); return output
  }
  try { return visit(input, 0) } catch { return invalid }
}
/** Independent pure endpoint rule, never catalog entitlement or runtime/durable authorization. */
export function evaluateStartupStorageReadPolicy(request: unknown, evaluatedAt: number): PolicyDecision | null {
  if (!Number.isSafeInteger(evaluatedAt) || evaluatedAt < 0) return null
  const snapshot = boundedSnapshot(request)
  if (snapshot === invalid) return null
  const parsed = parsePolicyRequest(snapshot)
  if (!parsed.ok || !/^startup-storage-read:[A-Za-z0-9_-]{1,96}$/.test(parsed.value.requestId)) return null
  const exact = canonicalPolicyJson(snapshot) === canonicalPolicyJson(expectedRequest(parsed.value.requestId))
  return evaluatePolicy(parsed.value, exact ? [allow, deny] : [deny], { evaluatedAt, policyVersion: 'management-startup-storage-read/v1' })
}
