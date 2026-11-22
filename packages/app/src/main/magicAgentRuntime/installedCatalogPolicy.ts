import { isProxy } from 'node:util/types'
import {
  canonicalPolicyJson,
  evaluatePolicy,
  parsePolicyRequest,
  POLICY_REQUEST_DISCRIMINATOR,
  POLICY_REQUEST_VERSION,
  type PolicyDecision,
  type PolicyJsonValue,
  type PolicyRequest,
  type PolicyRule
} from '@shared/magicAgentPlatform2/policy'

const expectedRequest = (requestId: string) => ({
  discriminator: POLICY_REQUEST_DISCRIMINATOR, version: POLICY_REQUEST_VERSION, requestId,
  // A MAIN service principal, not an authenticated human or an assistant-file-tool alias.
  actor: { kind: 'service', id: 'main-management-installed-catalog-reader' },
  origin: 'renderer', action: 'management.installed-catalog.read', transport: 'electron-ipc',
  target: { kind: 'installed-package-catalog', id: 'main-user-data-installed-packages' }, input: {},
  effects: [{ kind: 'filesystem.read', risk: 'read', target: 'main-user-data-installed-packages' }]
} satisfies PolicyRequest)
const deny: PolicyRule = {
  ruleId: 'management-installed-catalog-read-default-deny', priority: 0, effect: 'deny',
  explanation: 'This endpoint accepts only its exact MAIN-owned installed-metadata read contract.'
}
const allow: PolicyRule = {
  ruleId: 'management-installed-catalog-read-exact', priority: 100, effect: 'allow-with-constraints',
  match: { origins: ['renderer'], actions: ['management.installed-catalog.read'], actorKinds: ['service'],
    targetKinds: ['installed-package-catalog'], effectKinds: ['filesystem.read'], risks: ['read'], transports: ['electron-ipc'] },
  constraints: { readOnly: true, requireNoShell: true, maxTimeoutMs: 2000, maxOutputChars: 131072 },
  explanation: 'Explicit bounded final-installed metadata projection only; no runtime, mutation, shell or network.'
}
const invalid = Symbol('invalid-policy-input')

/** Bound and detach before the generic parser; never traverse accessors/proxies or arbitrary trees. */
function boundedSnapshot(input: unknown): PolicyJsonValue | typeof invalid {
  let nodes = 0
  const ancestors = new WeakSet<object>()
  const visit = (value: unknown, depth: number): PolicyJsonValue | typeof invalid => {
    if (++nodes > 64 || depth > 6) return invalid
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : invalid
    if (typeof value === 'string') return value.length <= 256 ? value : invalid
    if (!value || typeof value !== 'object' || isProxy(value) || ancestors.has(value)) return invalid
    const prototype = Object.getPrototypeOf(value)
    if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid
    const keys = Reflect.ownKeys(value)
    if (keys.length > 16 || keys.some(key => typeof key !== 'string' || key.length > 64 || ['__proto__', 'prototype', 'constructor'].includes(key))) return invalid
    const descriptors = Object.getOwnPropertyDescriptors(value)
    ancestors.add(value)
    if (Array.isArray(value)) {
      if (value.length > 4 || keys.length !== value.length + 1) return invalid
      const output: PolicyJsonValue[] = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)]
        if (!descriptor?.enumerable || !('value' in descriptor)) return invalid
        const item = visit(descriptor.value, depth + 1)
        if (item === invalid) return invalid
        output.push(item)
      }
      ancestors.delete(value)
      return output
    }
    const output: Record<string, PolicyJsonValue> = {}
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !('value' in descriptor)) return invalid
      const item = visit(descriptor.value, depth + 1)
      if (item === invalid) return invalid
      output[key] = item
    }
    ancestors.delete(value)
    return output
  }
  try { return visit(input, 0) } catch { return invalid }
}

/** Pure endpoint decision only: caller still needs live MAIN admission, fixed root and bounded reader. */
export function evaluateInstalledCatalogReadPolicy(request: unknown, evaluatedAt: number): PolicyDecision | null {
  if (!Number.isSafeInteger(evaluatedAt) || evaluatedAt < 0) return null
  const snapshot = boundedSnapshot(request)
  if (snapshot === invalid) return null
  const parsed = parsePolicyRequest(snapshot)
  if (!parsed.ok || !/^installed-catalog-read:[A-Za-z0-9_-]{1,96}$/.test(parsed.value.requestId)) return null
  // Match raw detached data, not parser-normalized claims. Actor/target IDs and the exact
  // nonempty effect set are enforced here; generic rules only match kinds/every(effect).
  const exact = canonicalPolicyJson(snapshot) === canonicalPolicyJson(expectedRequest(parsed.value.requestId))
  return evaluatePolicy(parsed.value, exact ? [allow, deny] : [deny], {
    evaluatedAt, policyVersion: 'management-installed-catalog-read/v1'
  })
}
