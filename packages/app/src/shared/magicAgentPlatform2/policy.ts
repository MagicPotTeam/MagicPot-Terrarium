import type { MagicAgentActorRef } from './envelope'

export const POLICY_REQUEST_DISCRIMINATOR = 'magic-agent.policy-request.v1' as const
export const POLICY_REQUEST_VERSION = 1 as const
export const APPROVAL_GRANT_DISCRIMINATOR = 'magic-agent.approval-grant.v1' as const
export const APPROVAL_GRANT_VERSION = 1 as const
export const APPROVAL_CONSUMPTION_INTENT_DISCRIMINATOR =
  'magic-agent.approval-consumption-intent.v1' as const
export const APPROVAL_CONSUMPTION_RECEIPT_DISCRIMINATOR =
  'magic-agent.approval-consumption-receipt.v1' as const
export const APPROVAL_CONSUMPTION_VERSION = 1 as const

export const STANDARD_POLICY_EFFECT_KINDS = [
  'filesystem.read',
  'filesystem.write',
  'filesystem.delete',
  'process.execute',
  'network.read',
  'network.write',
  'external.message',
  'agent.lifecycle',
  'agent.config',
  'tool.invoke',
  'package.install',
  'credential.read',
  'credential.write',
  'database.read',
  'database.write',
  'ui.interact'
] as const

export type PolicyJsonValue =
  | null
  | boolean
  | number
  | string
  | PolicyJsonValue[]
  | PolicyJsonRecord
export type PolicyJsonRecord = { [key: string]: PolicyJsonValue }
export type PolicyOrigin =
  | 'assistant'
  | 'graph'
  | 'mcp'
  | 'renderer'
  | 'preload'
  | 'sdk'
  | 'trigger'
  | 'internal'
  | (string & {})
export type PolicyEffectKind = (typeof STANDARD_POLICY_EFFECT_KINDS)[number] | (string & {})
export type PolicyRisk = 'read' | 'low' | 'high' | 'destructive' | (string & {})

export type PolicyEffect = {
  kind: PolicyEffectKind
  target?: string
  risk: PolicyRisk
  metadata?: PolicyJsonRecord
  [key: string]: PolicyJsonValue | undefined
}

export type PolicyConstraints = {
  allowedRoots?: string[]
  allowedToolNames?: string[]
  maxTimeoutMs?: number
  maxOutputChars?: number
  networkHosts?: string[]
  requireNoShell?: boolean
  readOnly?: boolean
  metadata?: PolicyJsonRecord
  [key: string]: PolicyJsonValue | undefined
}

export type ApprovalRequirement = {
  scopeKind: 'request' | 'action' | 'target' | 'session'
  scopeValue: string
  maxUses: number
  expiresInMs: number
  reason: string
}

export type PolicyActorRef = MagicAgentActorRef & { [key: string]: PolicyJsonValue | undefined }

export type PolicyRequest = {
  discriminator: typeof POLICY_REQUEST_DISCRIMINATOR
  version: typeof POLICY_REQUEST_VERSION
  requestId: string
  actor: PolicyActorRef
  origin: PolicyOrigin
  action: string
  target: { kind: string; id: string; source?: string; [key: string]: PolicyJsonValue | undefined }
  input: PolicyJsonRecord
  effects: PolicyEffect[]
  route?: PolicyJsonRecord
  sessionId?: string
  runId?: string
  parentRunId?: string
  graphId?: string
  graphRunId?: string
  nodeId?: string
  agentId?: string
  workspaceId?: string
  allowedToolNames?: string[] | null
  confirmation?: PolicyJsonValue
  filesystem?: {
    cwd?: string
    paths?: string[]
    allowedRoots?: string[]
    [key: string]: PolicyJsonValue | undefined
  }
  transport?: string
  budget?: PolicyJsonRecord
  metadata?: PolicyJsonRecord
}

export type PolicyDecisionEffect = 'allow' | 'deny' | 'require-approval' | 'allow-with-constraints'
export type PolicyDecision = {
  decisionId: string
  requestDigest: string
  effect: PolicyDecisionEffect
  reasonCode: string
  explanation: string
  matchedRuleIds: string[]
  constraints?: PolicyConstraints
  approvalRequirement?: ApprovalRequirement
  evaluatedAt: number
  policyVersion: string
  audit: {
    origin: string
    action: string
    actor: { kind: string; id: string }
    target: { kind: string; id: string }
    effects: Array<{
      kind: string
      declaredRisk: string
      effectiveRisk: 'read' | 'low' | 'high' | 'destructive'
      target?: string
    }>
  }
}

export type ApprovalGrant = {
  discriminator: typeof APPROVAL_GRANT_DISCRIMINATOR
  version: typeof APPROVAL_GRANT_VERSION
  grantId: string
  requestDigest: string
  actor: { kind: string; id: string }
  scope: { kind: 'request' | 'action' | 'target' | 'session'; value: string }
  issuedAt: number
  expiresAt: number
  maxUses: number
  useCount: number
  approvedBy: PolicyActorRef
  constraints?: PolicyConstraints
}

export type ApprovalConsumptionIntent = {
  discriminator: typeof APPROVAL_CONSUMPTION_INTENT_DISCRIMINATOR
  version: typeof APPROVAL_CONSUMPTION_VERSION
  intentId: string
  grantId: string
  requestDigest: string
  expectedUseCount: number
  nextUseCount: number
  actor: { kind: string; id: string }
  scope: ApprovalGrant['scope']
  evaluatedAt: number
  expiresAt: number
  authorization: false
}

export type ApprovalConsumptionReceipt = {
  discriminator: typeof APPROVAL_CONSUMPTION_RECEIPT_DISCRIMINATOR
  version: typeof APPROVAL_CONSUMPTION_VERSION
  intentId: string
  grantId: string
  requestDigest: string
  previousUseCount: number
  nextUseCount: number
  consumedAt: number
  storeRevision: string
  storeId: string
}

export type PolicyRule = {
  ruleId: string
  priority: number
  effect: PolicyDecisionEffect
  match?: {
    origins?: string[]
    actions?: string[]
    actionPrefixes?: string[]
    targetKinds?: string[]
    effectKinds?: string[]
    risks?: string[]
    actorKinds?: string[]
    transports?: string[]
    requestDigests?: string[]
  }
  constraints?: PolicyConstraints
  approvalRequirement?: ApprovalRequirement
  explanation: string
}

export type PolicyParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

type JsonObject = Record<string, unknown>
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor'])
const standardKinds = new Set<string>(STANDARD_POLICY_EFFECT_KINDS)
const riskRank = { read: 0, low: 1, high: 2, destructive: 3 } as const
type EffectivePolicyRisk = keyof typeof riskRank

export const minimumRisk = (kind: string): EffectivePolicyRisk | undefined => {
  if (kind === 'filesystem.delete') return 'destructive'
  if (['filesystem.read', 'network.read', 'database.read'].includes(kind)) return 'read'
  if (['tool.invoke', 'agent.lifecycle'].includes(kind)) return 'high'
  if (kind === 'agent.config') return 'low'
  if (
    [
      'filesystem.write',
      'process.execute',
      'network.write',
      'external.message',
      'package.install',
      'credential.read',
      'credential.write',
      'database.write',
      'ui.interact'
    ].includes(kind)
  )
    return 'high'
  return undefined
}

const effectiveRisk = (effect: PolicyEffect): EffectivePolicyRisk => {
  const floor = minimumRisk(effect.kind)
  const declared = effect.risk in riskRank ? (effect.risk as EffectivePolicyRisk) : 'high'
  return floor && riskRank[floor] > riskRank[declared] ? floor : declared
}
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
const own = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)
const fail = <T>(path: string, message: string): PolicyParseResult<T> => ({
  ok: false,
  error: path ? `${path}: ${message}` : message
})

const cloneJson = (
  value: unknown,
  path = '',
  ancestors = new Set<object>()
): PolicyParseResult<PolicyJsonValue> => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return { ok: true, value }
  if (typeof value === 'number')
    return Number.isFinite(value) ? { ok: true, value } : fail(path, 'must be finite')
  if (typeof value !== 'object') return fail(path, 'must be JSON-safe')
  if (ancestors.has(value)) return fail(path, 'must not contain cycles')
  let prototype: object | null
  let descriptors: PropertyDescriptorMap
  let symbols: symbol[]
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
    symbols = Object.getOwnPropertySymbols(value)
  } catch {
    return fail(path, 'could not be inspected safely')
  }
  if (symbols.length) return fail(path, 'must not contain symbol properties')
  ancestors.add(value)
  if (Array.isArray(value)) {
    const keys = Object.keys(descriptors).filter((key) => key !== 'length')
    if (keys.length !== value.length)
      return fail(path, 'array must be dense and have no extra properties')
    const result: PolicyJsonValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor?.enumerable || !('value' in descriptor))
        return fail(`${path}[${index}]`, 'must be a data property')
      const item = cloneJson(descriptor.value, `${path}[${index}]`, ancestors)
      if (!item.ok) return item
      result.push(item.value)
    }
    ancestors.delete(value)
    return { ok: true, value: result }
  }
  if (prototype !== Object.prototype && prototype !== null)
    return fail(path, 'must be a plain object')
  const result: PolicyJsonRecord = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (dangerousKeys.has(key)) return fail(path ? `${path}.${key}` : key, 'dangerous key')
    if (!descriptor.enumerable || !('value' in descriptor))
      return fail(path ? `${path}.${key}` : key, 'must be a data property')
    const item = cloneJson(descriptor.value, path ? `${path}.${key}` : key, ancestors)
    if (!item.ok) return item
    result[key] = item.value
  }
  ancestors.delete(value)
  return { ok: true, value: result }
}

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}

const record = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0
const nonnegativeInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0
const trim = (value: string): string => value.trim()

const validateStringArray = (
  value: unknown,
  path: string,
  allowEmpty = true
): PolicyParseResult<string[]> => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0))
    return fail(path, allowEmpty ? 'must be an array' : 'must be a non-empty array')
  const result: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    if (!nonempty(value[index])) return fail(`${path}[${index}]`, 'must be a non-empty string')
    const item = trim(value[index] as string)
    if (seen.has(item)) return fail(`${path}[${index}]`, 'must be unique')
    seen.add(item)
    result.push(item)
  }
  return { ok: true, value: result }
}

const parseConstraintsValue = (
  value: unknown,
  path = 'constraints'
): PolicyParseResult<PolicyConstraints> => {
  const cloned = cloneJson(value, path)
  if (!cloned.ok) return cloned
  if (!record(cloned.value)) return fail(path, 'must be a plain record')
  const result = cloned.value as PolicyConstraints
  for (const key of ['allowedRoots', 'allowedToolNames', 'networkHosts'] as const) {
    if (result[key] !== undefined) {
      const parsed = validateStringArray(result[key], `${path}.${key}`)
      if (!parsed.ok) return parsed
      result[key] = parsed.value
    }
  }
  for (const key of ['maxTimeoutMs', 'maxOutputChars'] as const) {
    if (result[key] !== undefined && !positiveInt(result[key]))
      return fail(`${path}.${key}`, 'must be a positive integer')
  }
  for (const key of ['requireNoShell', 'readOnly'] as const) {
    if (result[key] !== undefined && typeof result[key] !== 'boolean')
      return fail(`${path}.${key}`, 'must be boolean')
  }
  if (result.metadata !== undefined && !record(result.metadata))
    return fail(`${path}.metadata`, 'must be a record')
  return { ok: true, value: result }
}

const parseRequirement = (
  value: unknown,
  path = 'approvalRequirement'
): PolicyParseResult<ApprovalRequirement> => {
  const cloned = cloneJson(value, path)
  if (!cloned.ok || !record(cloned.value)) return fail(path, 'must be a plain record')
  const item = cloned.value as JsonObject
  if (!['request', 'action', 'target', 'session'].includes(String(item.scopeKind)))
    return fail(`${path}.scopeKind`, 'is invalid')
  if (!nonempty(item.scopeValue)) return fail(`${path}.scopeValue`, 'must be non-empty')
  if (!positiveInt(item.maxUses)) return fail(`${path}.maxUses`, 'must be a positive integer')
  if (!positiveInt(item.expiresInMs))
    return fail(`${path}.expiresInMs`, 'must be a positive integer')
  if (!nonempty(item.reason)) return fail(`${path}.reason`, 'must be non-empty')
  return { ok: true, value: item as ApprovalRequirement }
}

const parseActor = (value: unknown, path: string): PolicyParseResult<PolicyActorRef> => {
  const cloned = cloneJson(value, path)
  if (
    !cloned.ok ||
    !record(cloned.value) ||
    !nonempty(cloned.value.kind) ||
    !nonempty(cloned.value.id)
  )
    return fail(path, 'must contain non-empty kind and id')
  if (cloned.value.displayName !== undefined && !nonempty(cloned.value.displayName))
    return fail(`${path}.displayName`, 'must be non-empty')
  cloned.value.kind = trim(cloned.value.kind as string)
  cloned.value.id = trim(cloned.value.id as string)
  return { ok: true, value: cloned.value as PolicyActorRef }
}

export const parsePolicyRequest = (input: unknown): PolicyParseResult<PolicyRequest> => {
  try {
    const cloned = cloneJson(input)
    if (!cloned.ok || !record(cloned.value))
      return fail('', 'PolicyRequest must be a plain JSON-safe record')
    const value = cloned.value as JsonObject
    if (value.discriminator !== POLICY_REQUEST_DISCRIMINATOR)
      return fail('discriminator', `must equal ${POLICY_REQUEST_DISCRIMINATOR}`)
    if (value.version !== POLICY_REQUEST_VERSION)
      return fail('version', `must equal ${POLICY_REQUEST_VERSION}`)
    for (const key of ['requestId', 'origin', 'action'] as const)
      if (!nonempty(value[key])) return fail(key, 'must be a non-empty string')
    const actor = parseActor(value.actor, 'actor')
    if (!actor.ok) return actor
    if (!record(value.target) || !nonempty(value.target.kind) || !nonempty(value.target.id))
      return fail('target', 'must contain non-empty kind and id')
    if (value.target.source !== undefined && !nonempty(value.target.source))
      return fail('target.source', 'must be non-empty')
    if (!record(value.input)) return fail('input', 'must be a plain record')
    if (!Array.isArray(value.effects)) return fail('effects', 'must be an array')
    for (let index = 0; index < value.effects.length; index += 1) {
      const effect = value.effects[index]
      if (!record(effect) || !nonempty(effect.kind) || !nonempty(effect.risk))
        return fail(`effects[${index}]`, 'must contain non-empty kind and risk')
      effect.kind = trim(effect.kind as string)
      effect.risk = trim(effect.risk as string)
      if (effect.target !== undefined && !nonempty(effect.target))
        return fail(`effects[${index}].target`, 'must be non-empty')
      if (effect.metadata !== undefined && !record(effect.metadata))
        return fail(`effects[${index}].metadata`, 'must be a record')
    }
    for (const key of ['route', 'budget', 'metadata'] as const)
      if (value[key] !== undefined && !record(value[key])) return fail(key, 'must be a record')
    for (const key of [
      'sessionId',
      'runId',
      'parentRunId',
      'graphId',
      'graphRunId',
      'nodeId',
      'agentId',
      'workspaceId',
      'transport'
    ] as const) {
      if (value[key] !== undefined && !nonempty(value[key]))
        return fail(key, 'must be non-empty when present')
    }
    if (value.allowedToolNames !== undefined && value.allowedToolNames !== null) {
      const tools = validateStringArray(value.allowedToolNames, 'allowedToolNames')
      if (!tools.ok) return tools
      value.allowedToolNames = tools.value
    }
    if (value.filesystem !== undefined) {
      if (!record(value.filesystem)) return fail('filesystem', 'must be a record')
      if (value.filesystem.cwd !== undefined && !nonempty(value.filesystem.cwd))
        return fail('filesystem.cwd', 'must be non-empty')
      for (const key of ['paths', 'allowedRoots'] as const)
        if (value.filesystem[key] !== undefined) {
          const parsed = validateStringArray(value.filesystem[key], `filesystem.${key}`)
          if (!parsed.ok) return parsed
          value.filesystem[key] = parsed.value
        }
    }
    value.requestId = trim(value.requestId as string)
    value.origin = trim(value.origin as string)
    value.action = trim(value.action as string)
    return { ok: true, value: deepFreeze(value as PolicyRequest) }
  } catch {
    return fail('', 'PolicyRequest could not be read safely')
  }
}

export const assertPolicyRequest = (input: unknown): PolicyRequest => {
  const parsed = parsePolicyRequest(input)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}

export const canonicalPolicyJson = (value: PolicyJsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalPolicyJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalPolicyJson(value[key])}`)
    .join(',')}}`
}
const canonical = canonicalPolicyJson

const rotateRight = (value: number, amount: number): number =>
  (value >>> amount) | (value << (32 - amount))
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]
export const sha256PolicyText = (text: string): string => {
  const bytes = Array.from(new TextEncoder().encode(text))
  const bitLength = BigInt(bytes.length) * 8n
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (let index = 7; index >= 0; index -= 1)
    bytes.push(Number((bitLength >> BigInt(index * 8)) & 255n))
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64)
    for (let index = 0; index < 16; index += 1)
      words[index] =
        (bytes[offset + index * 4] << 24) |
        (bytes[offset + index * 4 + 1] << 16) |
        (bytes[offset + index * 4 + 2] << 8) |
        bytes[offset + index * 4 + 3] |
        0
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]
      const b = words[index - 2]
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3)
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10)
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + s1 + ch + SHA256_K[index] + words[index]) | 0
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    hash[0] = (hash[0] + a) | 0
    hash[1] = (hash[1] + b) | 0
    hash[2] = (hash[2] + c) | 0
    hash[3] = (hash[3] + d) | 0
    hash[4] = (hash[4] + e) | 0
    hash[5] = (hash[5] + f) | 0
    hash[6] = (hash[6] + g) | 0
    hash[7] = (hash[7] + h) | 0
  }
  return hash.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('')
}

export const digestPolicyRequest = (input: unknown): string => {
  const request = assertPolicyRequest(input)
  return `sha256:${sha256PolicyText(canonical(request as unknown as PolicyJsonValue))}`
}

export const parsePolicyRule = (input: unknown): PolicyParseResult<PolicyRule> => {
  const cloned = cloneJson(input)
  if (!cloned.ok || !record(cloned.value))
    return fail('', 'PolicyRule must be a plain JSON-safe record')
  const value = cloned.value as JsonObject
  if (!nonempty(value.ruleId)) return fail('ruleId', 'must be non-empty')
  if (!Number.isSafeInteger(value.priority)) return fail('priority', 'must be an integer')
  if (
    !['allow', 'deny', 'require-approval', 'allow-with-constraints'].includes(String(value.effect))
  )
    return fail('effect', 'is invalid')
  if (!nonempty(value.explanation)) return fail('explanation', 'must be non-empty')
  if (value.match !== undefined) {
    if (!record(value.match)) return fail('match', 'must be a record')
    for (const key of [
      'origins',
      'actions',
      'actionPrefixes',
      'targetKinds',
      'effectKinds',
      'risks',
      'actorKinds',
      'transports'
    ])
      if (value.match[key] !== undefined) {
        const parsed = validateStringArray(value.match[key], `match.${key}`, false)
        if (!parsed.ok) return parsed
        value.match[key] = parsed.value
      }
    if (value.match.requestDigests !== undefined) {
      const rawDigests = value.match.requestDigests
      const parsed = validateStringArray(rawDigests, 'match.requestDigests', false)
      if (!parsed.ok) return parsed
      if (
        parsed.value.some(
          (digest, index) =>
            digest !== (rawDigests as unknown[])[index] || !/^sha256:[0-9a-f]{64}$/.test(digest)
        )
      )
        return fail('match.requestDigests', 'must contain only sha256:<64 lowercase hex> digests')
      value.match.requestDigests = parsed.value
    }
  }
  if (value.constraints !== undefined) {
    if (value.effect === 'allow' || value.effect === 'deny')
      return fail('constraints', 'is only valid for require-approval or allow-with-constraints')
    const parsed = parseConstraintsValue(value.constraints)
    if (!parsed.ok) return parsed
    value.constraints = parsed.value
  }
  if (value.approvalRequirement !== undefined) {
    const parsed = parseRequirement(value.approvalRequirement)
    if (!parsed.ok) return parsed
    value.approvalRequirement = parsed.value
  }
  if (
    (value.effect === 'allow' || value.effect === 'deny') &&
    value.approvalRequirement !== undefined
  )
    return fail('approvalRequirement', 'is only valid for require-approval')
  if (
    value.effect === 'allow-with-constraints' &&
    (!record(value.constraints) || Object.keys(value.constraints).length === 0)
  )
    return fail('constraints', 'must be non-empty for allow-with-constraints')
  return { ok: true, value: deepFreeze(value as PolicyRule) }
}

export const parsePolicyRules = (input: unknown): PolicyParseResult<PolicyRule[]> => {
  if (!Array.isArray(input)) return fail('', 'rules must be an array')
  const rules: PolicyRule[] = []
  const ids = new Set<string>()
  for (let index = 0; index < input.length; index += 1) {
    const parsed = parsePolicyRule(input[index])
    if (!parsed.ok) return fail(`[${index}]`, parsed.error)
    if (ids.has(parsed.value.ruleId)) return fail(`[${index}].ruleId`, 'must be unique')
    ids.add(parsed.value.ruleId)
    rules.push(parsed.value)
  }
  rules.sort((left, right) =>
    right.priority !== left.priority
      ? right.priority - left.priority
      : left.ruleId < right.ruleId
        ? -1
        : left.ruleId > right.ruleId
          ? 1
          : 0
  )
  return { ok: true, value: deepFreeze(rules) }
}

const matches = (request: PolicyRequest, requestDigest: string, rule: PolicyRule): boolean => {
  const match = rule.match
  if (!match) return true
  if (match.origins && !match.origins.includes(request.origin)) return false
  if (match.actions && !match.actions.includes(request.action)) return false
  if (
    match.actionPrefixes &&
    !match.actionPrefixes.some((prefix) => request.action.startsWith(prefix))
  )
    return false
  if (match.targetKinds && !match.targetKinds.includes(request.target.kind)) return false
  if (match.actorKinds && !match.actorKinds.includes(request.actor.kind)) return false
  if (match.transports && (!request.transport || !match.transports.includes(request.transport)))
    return false
  if (match.requestDigests && !match.requestDigests.includes(requestDigest)) return false
  if (
    match.effectKinds &&
    !request.effects.every((effect) => match.effectKinds?.includes(effect.kind))
  )
    return false
  if (
    match.risks &&
    !request.effects.every((effect) => match.risks?.includes(effectiveRisk(effect)))
  )
    return false
  return true
}

const intersect = (
  left: string[] | undefined,
  right: string[] | undefined
): string[] | undefined => {
  if (!left) return right ? [...right] : undefined
  if (!right) return [...left]
  return left.filter((item) => right.includes(item))
}

type MergeResult =
  | { ok: true; value: PolicyConstraints | undefined }
  | { ok: false; reason: 'constraints-empty' | 'constraints-conflict' }
const mergeConstraints = (items: Array<PolicyConstraints | undefined>): MergeResult => {
  let result: PolicyConstraints | undefined
  for (const item of items) {
    if (!item) continue
    result ??= {}
    for (const key of ['allowedRoots', 'allowedToolNames', 'networkHosts'] as const) {
      const merged = intersect(result[key], item[key])
      if (result[key] && item[key] && merged?.length === 0)
        return { ok: false, reason: 'constraints-empty' }
      if (merged) result[key] = merged
    }
    for (const key of ['maxTimeoutMs', 'maxOutputChars'] as const)
      if (item[key] !== undefined)
        result[key] =
          result[key] === undefined
            ? item[key]
            : Math.min(result[key] as number, item[key] as number)
    for (const key of ['requireNoShell', 'readOnly'] as const)
      if (item[key] !== undefined) result[key] = Boolean(result[key]) || item[key]
    if (item.metadata) {
      result.metadata ??= {}
      for (const [key, value] of Object.entries(item.metadata)) {
        if (own(result.metadata, key) && canonical(result.metadata[key]) !== canonical(value))
          return { ok: false, reason: 'constraints-conflict' }
        result.metadata[key] = value
      }
    }
    for (const [key, value] of Object.entries(item)) {
      if (
        [
          'allowedRoots',
          'allowedToolNames',
          'networkHosts',
          'maxTimeoutMs',
          'maxOutputChars',
          'requireNoShell',
          'readOnly',
          'metadata'
        ].includes(key)
      )
        continue
      if (
        own(result, key) &&
        canonical(result[key] as PolicyJsonValue) !== canonical(value as PolicyJsonValue)
      )
        return { ok: false, reason: 'constraints-conflict' }
      result[key] = value as PolicyJsonValue
    }
  }
  return { ok: true, value: result }
}

const defaultClassification = (
  request: PolicyRequest
): {
  effect: PolicyDecisionEffect
  reason: string
  explanation: string
  constraints?: PolicyConstraints
  requirement?: ApprovalRequirement
} => {
  if (request.effects.some((effect) => !standardKinds.has(effect.kind)))
    return {
      effect: 'deny',
      reason: 'unknown-effect',
      explanation: 'Unknown effect kinds are denied and cannot be overridden.'
    }
  if (!request.effects.length)
    return {
      effect: 'deny',
      reason: 'no-effects',
      explanation: 'Requests without declared effects require an explicit allow rule.'
    }
  if (request.effects.some((effect) => effectiveRisk(effect) === 'destructive'))
    return {
      effect: 'require-approval',
      reason: 'destructive-effect',
      explanation: 'Destructive effects require approval.',
      requirement: {
        scopeKind: 'request',
        scopeValue: request.requestId,
        maxUses: 1,
        expiresInMs: 300000,
        reason: 'Destructive operation'
      }
    }
  if (
    request.effects.some(
      (effect) =>
        effect.kind === 'process.execute' ||
        effectiveRisk(effect) === 'high' ||
        [
          'filesystem.write',
          'filesystem.delete',
          'network.write',
          'external.message',
          'package.install',
          'credential.read',
          'credential.write',
          'database.write',
          'ui.interact'
        ].includes(effect.kind)
    )
  )
    return {
      effect: 'require-approval',
      reason: 'high-risk-effect',
      explanation: 'High-risk effects require approval by default.',
      requirement: {
        scopeKind: 'request',
        scopeValue: request.requestId,
        maxUses: 1,
        expiresInMs: 300000,
        reason: 'High-risk operation'
      }
    }
  const allReads = request.effects.every(
    (effect) =>
      effectiveRisk(effect) === 'read' &&
      ['filesystem.read', 'network.read', 'database.read'].includes(effect.kind)
  )
  if (allReads)
    return {
      effect: 'allow-with-constraints',
      reason: 'known-read-only',
      explanation: 'Known read-only effects are allowed with safety constraints.',
      constraints: { readOnly: true, requireNoShell: true }
    }
  return {
    effect: 'deny',
    reason: 'default-deny',
    explanation: 'No explicit policy rule allowed this request.'
  }
}

const makeDecision = (
  request: PolicyRequest,
  data: Omit<PolicyDecision, 'decisionId' | 'requestDigest' | 'audit'>
): PolicyDecision => {
  const requestDigest = digestPolicyRequest(request)
  const audit = {
    origin: request.origin,
    action: request.action,
    actor: { kind: request.actor.kind, id: request.actor.id },
    target: { kind: request.target.kind, id: request.target.id },
    effects: request.effects.map(({ kind, risk: declaredRisk, target, ...effect }) => ({
      kind,
      declaredRisk,
      effectiveRisk: effectiveRisk({ kind, risk: declaredRisk, target, ...effect }),
      ...(target ? { target } : {})
    }))
  }
  const seed = {
    requestDigest,
    ...data,
    ...(data.constraints !== undefined ? { constraints: data.constraints } : {}),
    ...(data.approvalRequirement !== undefined
      ? { approvalRequirement: data.approvalRequirement }
      : {}),
    audit
  }
  delete (seed as { constraints?: PolicyConstraints }).constraints
  delete (seed as { approvalRequirement?: ApprovalRequirement }).approvalRequirement
  if (data.constraints !== undefined)
    (seed as { constraints?: PolicyConstraints }).constraints = data.constraints
  if (data.approvalRequirement !== undefined)
    (seed as { approvalRequirement?: ApprovalRequirement }).approvalRequirement =
      data.approvalRequirement
  return deepFreeze({
    decisionId: `policy-decision:${sha256PolicyText(canonical(seed as unknown as PolicyJsonValue))}`,
    ...seed
  })
}

const mergeRequirements = (
  rules: PolicyRule[],
  request: PolicyRequest
): PolicyParseResult<ApprovalRequirement> => {
  const requirements = rules
    .map((rule) => rule.approvalRequirement)
    .filter(Boolean) as ApprovalRequirement[]
  if (!requirements.length)
    return {
      ok: true,
      value: {
        scopeKind: 'request',
        scopeValue: request.requestId,
        maxUses: 1,
        expiresInMs: 300000,
        reason: 'Policy approval required'
      }
    }
  const first = requirements[0]
  if (
    requirements.some(
      (item) => item.scopeKind !== first.scopeKind || item.scopeValue !== first.scopeValue
    )
  )
    return fail('approvalRequirement', 'conflicting approval scopes')
  return {
    ok: true,
    value: {
      scopeKind: first.scopeKind,
      scopeValue: first.scopeValue,
      maxUses: Math.min(...requirements.map((item) => item.maxUses)),
      expiresInMs: Math.min(...requirements.map((item) => item.expiresInMs)),
      reason: [...new Set(requirements.map((item) => item.reason))].join(' ')
    }
  }
}

const isSpecificAllow = (
  request: PolicyRequest,
  requestDigest: string,
  rule: PolicyRule,
  requireDigest: boolean
): boolean => {
  const match = rule.match
  return Boolean(
    match?.origins?.includes(request.origin) &&
    match.actions?.includes(request.action) &&
    match.actorKinds?.includes(request.actor.kind) &&
    match.targetKinds?.includes(request.target.kind) &&
    (!requireDigest || match.requestDigests?.includes(requestDigest)) &&
    (request.effects.length > 0
      ? request.effects.every((effect) => match.effectKinds?.includes(effect.kind))
      : match.effectKinds === undefined)
  )
}

export const evaluatePolicy = (
  requestInput: unknown,
  rulesInput: unknown,
  options: { evaluatedAt: number; policyVersion: string }
): PolicyDecision => {
  const request = assertPolicyRequest(requestInput)
  const requestDigest = digestPolicyRequest(request)
  if (!Number.isFinite(options?.evaluatedAt)) throw new Error('evaluatedAt must be finite')
  if (!nonempty(options?.policyVersion)) throw new Error('policyVersion must be non-empty')
  const parsedRules = parsePolicyRules(rulesInput)
  if (!parsedRules.ok) throw new Error(parsedRules.error)
  const unknown = request.effects.some((effect) => !standardKinds.has(effect.kind))
  const matching = parsedRules.value.filter((rule) => matches(request, requestDigest, rule))
  const topPriority = matching[0]?.priority
  const tier =
    topPriority === undefined ? [] : matching.filter((rule) => rule.priority === topPriority)
  const base = {
    evaluatedAt: options.evaluatedAt,
    policyVersion: options.policyVersion,
    matchedRuleIds: tier.map((rule) => rule.ruleId)
  }
  if (unknown)
    return makeDecision(request, {
      ...base,
      effect: 'deny',
      reasonCode: 'unknown-effect',
      explanation: 'Unknown effect kinds are denied and cannot be overridden.'
    })
  if (!matching.length) {
    const fallback = defaultClassification(request)
    return makeDecision(request, {
      ...base,
      effect: fallback.effect,
      reasonCode: fallback.reason,
      explanation: fallback.explanation,
      constraints: fallback.constraints,
      approvalRequirement: fallback.requirement
    })
  }
  const rank: Record<PolicyDecisionEffect, number> = {
    deny: 4,
    'require-approval': 3,
    'allow-with-constraints': 2,
    allow: 1
  }
  const winningEffect = tier.reduce(
    (effect, rule) => (rank[rule.effect] > rank[effect] ? rule.effect : effect),
    'allow' as PolicyDecisionEffect
  )
  const winners = tier.filter((rule) => rule.effect === winningEffect)
  if (winningEffect === 'deny')
    return makeDecision(request, {
      ...base,
      effect: 'deny',
      reasonCode: 'rule-deny',
      explanation: winners.map((rule) => rule.explanation).join(' ')
    })
  const merged = mergeConstraints(tier.map((rule) => rule.constraints))
  if (!merged.ok)
    return makeDecision(request, {
      ...base,
      effect: 'deny',
      reasonCode: merged.reason,
      explanation: 'Matching constraints cannot be satisfied safely.'
    })
  let finalEffect = winningEffect
  let reasonCode = `rule-${winningEffect}`
  let requirement: ApprovalRequirement | undefined
  if (winningEffect === 'allow' && Object.keys(merged.value ?? {}).length > 0) {
    finalEffect = 'allow-with-constraints'
    reasonCode = 'rule-allow-with-constraints'
  }
  if (winningEffect === 'require-approval') {
    const requirements = mergeRequirements(
      tier.filter((rule) => rule.effect === 'require-approval'),
      request
    )
    if (!requirements.ok)
      return makeDecision(request, {
        ...base,
        effect: 'deny',
        reasonCode: 'approval-requirement-conflict',
        explanation: requirements.error
      })
    requirement = requirements.value
  }
  const allowLike = winningEffect === 'allow' || winningEffect === 'allow-with-constraints'
  const destructive = request.effects.some((effect) => effectiveRisk(effect) === 'destructive')
  const risky = request.effects.some((effect) => effectiveRisk(effect) === 'high')
  const specific =
    winners.length > 0 &&
    winners.every((rule) => isSpecificAllow(request, requestDigest, rule, risky))
  if (allowLike && (destructive || risky || request.effects.length === 0) && !specific) {
    finalEffect = 'require-approval'
    reasonCode = destructive ? 'destructive-safety-floor' : 'insufficient-allow-specificity'
    requirement = {
      scopeKind: 'request',
      scopeValue: request.requestId,
      maxUses: 1,
      expiresInMs: 300000,
      reason: destructive ? 'Destructive operation' : 'Explicit approval required'
    }
  } else if (allowLike && destructive) {
    finalEffect = 'require-approval'
    reasonCode = 'destructive-safety-floor'
    requirement = {
      scopeKind: 'request',
      scopeValue: request.requestId,
      maxUses: 1,
      expiresInMs: 300000,
      reason: 'Destructive operation'
    }
  }
  return makeDecision(request, {
    ...base,
    effect: finalEffect,
    reasonCode,
    explanation: winners.map((rule) => rule.explanation).join(' '),
    constraints: merged.value,
    approvalRequirement: requirement
  })
}

const decisionAuditFor = (request: PolicyRequest): PolicyDecision['audit'] => ({
  origin: request.origin,
  action: request.action,
  actor: { kind: request.actor.kind, id: request.actor.id },
  target: { kind: request.target.kind, id: request.target.id },
  effects: request.effects.map(({ kind, risk: declaredRisk, target, ...effect }) => ({
    kind,
    declaredRisk,
    effectiveRisk: effectiveRisk({ kind, risk: declaredRisk, target, ...effect }),
    ...(target !== undefined ? { target } : {})
  }))
})

export const parsePolicyDecision = (input: unknown): PolicyParseResult<PolicyDecision> => {
  const cloned = cloneJson(input)
  if (!cloned.ok || !record(cloned.value))
    return fail('', 'PolicyDecision must be a plain JSON-safe record')
  const value = cloned.value as JsonObject
  for (const key of [
    'decisionId',
    'requestDigest',
    'reasonCode',
    'explanation',
    'policyVersion'
  ] as const)
    if (!nonempty(value[key])) return fail(key, 'must be non-empty')
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.requestDigest)))
    return fail('requestDigest', 'must be sha256:hex')
  if (!/^policy-decision:[0-9a-f]{64}$/.test(String(value.decisionId)))
    return fail('decisionId', 'must be policy-decision:hex')
  if (
    !['allow', 'deny', 'require-approval', 'allow-with-constraints'].includes(String(value.effect))
  )
    return fail('effect', 'is invalid')
  if (!Number.isFinite(value.evaluatedAt) || (value.evaluatedAt as number) < 0)
    return fail('evaluatedAt', 'must be nonnegative and finite')
  const ids = validateStringArray(value.matchedRuleIds, 'matchedRuleIds')
  if (!ids.ok) return ids
  value.matchedRuleIds = ids.value
  if (value.constraints !== undefined) {
    const parsed = parseConstraintsValue(value.constraints)
    if (!parsed.ok) return parsed
    value.constraints = parsed.value
  }
  if (value.approvalRequirement !== undefined) {
    const parsed = parseRequirement(value.approvalRequirement)
    if (!parsed.ok) return parsed
    value.approvalRequirement = parsed.value
  }
  if (value.effect === 'require-approval' && value.approvalRequirement === undefined)
    return fail('approvalRequirement', 'is required')
  if (value.effect !== 'require-approval' && value.approvalRequirement !== undefined)
    return fail('approvalRequirement', 'is only valid for require-approval')
  if (!record(value.audit) || !nonempty(value.audit.origin) || !nonempty(value.audit.action))
    return fail('audit', 'is invalid')
  for (const key of ['actor', 'target'] as const)
    if (
      !record(value.audit[key]) ||
      !nonempty(value.audit[key].kind) ||
      !nonempty(value.audit[key].id)
    )
      return fail(`audit.${key}`, 'is invalid')
  if (!Array.isArray(value.audit.effects)) return fail('audit.effects', 'must be an array')
  for (const [index, effect] of value.audit.effects.entries())
    if (
      !record(effect) ||
      !nonempty(effect.kind) ||
      !nonempty(effect.declaredRisk) ||
      !['read', 'low', 'high', 'destructive'].includes(String(effect.effectiveRisk)) ||
      (effect.target !== undefined && !nonempty(effect.target))
    )
      return fail(`audit.effects[${index}]`, 'is invalid')
  const { decisionId, ...seed } = value
  const expected = `policy-decision:${sha256PolicyText(canonical(seed as PolicyJsonRecord))}`
  if (decisionId !== expected) return fail('decisionId', 'does not match decision contents')
  return { ok: true, value: deepFreeze(value as PolicyDecision) }
}

export const parseApprovalGrant = (input: unknown): PolicyParseResult<ApprovalGrant> => {
  const cloned = cloneJson(input)
  if (!cloned.ok || !record(cloned.value))
    return fail('', 'ApprovalGrant must be a plain JSON-safe record')
  const value = cloned.value as JsonObject
  if (
    value.discriminator !== APPROVAL_GRANT_DISCRIMINATOR ||
    value.version !== APPROVAL_GRANT_VERSION
  )
    return fail('discriminator', 'invalid approval grant contract')
  for (const key of ['grantId', 'requestDigest'] as const)
    if (!nonempty(value[key])) return fail(key, 'must be non-empty')
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.requestDigest)))
    return fail('requestDigest', 'must be sha256:hex')
  const actor = parseActor(value.actor, 'actor')
  if (!actor.ok) return actor
  const approver = parseActor(value.approvedBy, 'approvedBy')
  if (!approver.ok) return approver
  if (
    !record(value.scope) ||
    !['request', 'action', 'target', 'session'].includes(String(value.scope.kind)) ||
    !nonempty(value.scope.value)
  )
    return fail('scope', 'is invalid')
  for (const key of ['issuedAt', 'expiresAt'] as const)
    if (!Number.isFinite(value[key]) || (value[key] as number) < 0)
      return fail(key, 'must be nonnegative and finite')
  if ((value.expiresAt as number) <= (value.issuedAt as number))
    return fail('expiresAt', 'must be after issuedAt')
  if (
    !positiveInt(value.maxUses) ||
    !nonnegativeInt(value.useCount) ||
    (value.useCount as number) > (value.maxUses as number)
  )
    return fail('useCount', 'is invalid')
  if (value.constraints !== undefined) {
    const parsed = parseConstraintsValue(value.constraints)
    if (!parsed.ok) return parsed
    value.constraints = parsed.value
  }
  return { ok: true, value: deepFreeze(value as ApprovalGrant) }
}

export const parseApprovalConsumptionIntent = (
  input: unknown
): PolicyParseResult<ApprovalConsumptionIntent> => {
  const cloned = cloneJson(input)
  if (!cloned.ok || !record(cloned.value))
    return fail('', 'ApprovalConsumptionIntent must be JSON-safe')
  const value = cloned.value as JsonObject
  if (
    value.discriminator !== APPROVAL_CONSUMPTION_INTENT_DISCRIMINATOR ||
    value.version !== APPROVAL_CONSUMPTION_VERSION
  )
    return fail('discriminator', 'invalid consumption intent')
  for (const key of ['intentId', 'grantId', 'requestDigest'] as const)
    if (!nonempty(value[key])) return fail(key, 'must be non-empty')
  if (
    !/^approval-intent:[0-9a-f]{64}$/.test(String(value.intentId)) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.requestDigest))
  )
    return fail('intentId', 'invalid digest format')
  if (
    !nonnegativeInt(value.expectedUseCount) ||
    value.nextUseCount !== (value.expectedUseCount as number) + 1
  )
    return fail('nextUseCount', 'must increment expectedUseCount')
  if (
    !record(value.actor) ||
    !nonempty(value.actor.kind) ||
    !nonempty(value.actor.id) ||
    !record(value.scope) ||
    !['request', 'action', 'target', 'session'].includes(String(value.scope.kind)) ||
    !nonempty(value.scope.value)
  )
    return fail('scope', 'invalid actor or scope')
  if (value.authorization !== false) return fail('authorization', 'must be false')
  if (
    !Number.isFinite(value.evaluatedAt) ||
    (value.evaluatedAt as number) < 0 ||
    !Number.isFinite(value.expiresAt) ||
    (value.expiresAt as number) <= (value.evaluatedAt as number)
  )
    return fail('expiresAt', 'invalid intent times')
  const { intentId, ...seed } = value
  if (intentId !== `approval-intent:${sha256PolicyText(canonical(seed as PolicyJsonRecord))}`)
    return fail('intentId', 'does not match intent contents')
  return { ok: true, value: deepFreeze(value as ApprovalConsumptionIntent) }
}

export const parseApprovalConsumptionReceipt = (
  input: unknown
): PolicyParseResult<ApprovalConsumptionReceipt> => {
  const cloned = cloneJson(input)
  if (!cloned.ok || !record(cloned.value))
    return fail('', 'ApprovalConsumptionReceipt must be JSON-safe')
  const value = cloned.value as JsonObject
  if (
    value.discriminator !== APPROVAL_CONSUMPTION_RECEIPT_DISCRIMINATOR ||
    value.version !== APPROVAL_CONSUMPTION_VERSION
  )
    return fail('discriminator', 'invalid consumption receipt')
  for (const key of ['intentId', 'grantId', 'requestDigest', 'storeRevision', 'storeId'] as const)
    if (!nonempty(value[key])) return fail(key, 'must be non-empty')
  if (
    !/^approval-intent:[0-9a-f]{64}$/.test(String(value.intentId)) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(value.requestDigest))
  )
    return fail('intentId', 'invalid digest format')
  if (
    !nonnegativeInt(value.previousUseCount) ||
    value.nextUseCount !== (value.previousUseCount as number) + 1
  )
    return fail('nextUseCount', 'must increment previousUseCount')
  if (!Number.isFinite(value.consumedAt) || (value.consumedAt as number) < 0)
    return fail('consumedAt', 'must be nonnegative and finite')
  return { ok: true, value: deepFreeze(value as ApprovalConsumptionReceipt) }
}

export type PolicyRequestFactoryInput = Omit<
  PolicyRequest,
  'discriminator' | 'version' | 'origin' | 'action' | 'effects' | 'input' | 'confirmation'
>
export type ToolPolicyRequestFactoryInput = PolicyRequestFactoryInput & {
  toolInput?: PolicyJsonRecord
}
export type TriggerPolicyOccurrence = Readonly<{
  occurrenceAt: number
  windowStart: number
  windowEnd: number
  missedCount: number
  nextFireAtAfter: number
  batchEndAt?: number
  occurrenceId?: string
  source?:
    | 'schedule'
    | 'manual'
    | 'startup'
    | 'channel-message'
    | 'workflow-completion'
    | 'drive-state'
    | 'calendar'
    | 'cron'
    | 'sdk'
    | 'custom'
  requestedAt?: number
  attempt?: number
}>
export type TriggerPolicySpecProjection = Readonly<{
  type: string
  title: string
  config?: PolicyJsonRecord
  metadata?: PolicyJsonRecord
}>
export type TriggerPolicyRequestFactoryInput = Omit<
  PolicyRequestFactoryInput,
  'target' | 'filesystem' | 'allowedToolNames'
> & {
  triggerId: string
  occurrence: TriggerPolicyOccurrence
  trigger: TriggerPolicySpecProjection
  effects: PolicyEffect[]
}
const factory = (
  origin: PolicyOrigin,
  input: PolicyRequestFactoryInput,
  defaults: {
    action: string
    target?: PolicyRequest['target']
    input?: PolicyJsonRecord
    effects: PolicyEffect[]
    transport?: string
    confirmation?: PolicyJsonValue
    filesystem?: PolicyRequest['filesystem']
  }
): PolicyRequest => {
  const value: Record<string, unknown> = {
    discriminator: POLICY_REQUEST_DISCRIMINATOR,
    version: POLICY_REQUEST_VERSION,
    requestId: input.requestId,
    actor: input.actor,
    origin,
    action: defaults.action,
    target: defaults.target ?? input.target,
    input: defaults.input ?? {},
    effects: defaults.effects
  }
  for (const key of [
    'route',
    'sessionId',
    'runId',
    'parentRunId',
    'graphId',
    'graphRunId',
    'nodeId',
    'agentId',
    'workspaceId',
    'allowedToolNames',
    'budget',
    'metadata'
  ] as const)
    if (input[key] !== undefined) value[key] = input[key]
  const transport = defaults.transport ?? input.transport
  if (transport !== undefined) value.transport = transport
  const confirmation = defaults.confirmation
  if (confirmation !== undefined) value.confirmation = confirmation
  const filesystem = defaults.filesystem ?? input.filesystem
  if (filesystem !== undefined && Object.keys(filesystem).length > 0) value.filesystem = filesystem
  return assertPolicyRequest(value)
}
export const createFilesToolPolicyRequest = (
  input: ToolPolicyRequestFactoryInput & {
    action:
      | 'filesystem.list'
      | 'filesystem.search'
      | 'filesystem.read'
      | 'filesystem.write'
      | 'notebook.write'
    origin?: 'assistant' | 'graph'
  }
): PolicyRequest =>
  factory(input.origin ?? 'assistant', input, {
    action: input.action,
    target: { kind: 'tool', id: input.target.id },
    input: input.toolInput ?? {},
    effects: [
      {
        kind:
          input.action === 'filesystem.write' || input.action === 'notebook.write'
            ? 'filesystem.write'
            : 'filesystem.read',
        risk:
          input.action === 'filesystem.write' || input.action === 'notebook.write'
            ? 'high'
            : 'read',
        target: input.filesystem?.paths?.[0]
      }
    ],
    filesystem: input.filesystem
  })

export const createAssistantToolPolicyRequest = (
  input: ToolPolicyRequestFactoryInput
): PolicyRequest =>
  factory('assistant', input, {
    action: 'tool.invoke',
    target: { kind: 'tool', id: input.target.id },
    input: input.toolInput ?? {},
    effects: [{ kind: 'tool.invoke', risk: 'high', target: input.target.id }]
  })
export const createGraphToolPolicyRequest = (input: ToolPolicyRequestFactoryInput): PolicyRequest =>
  factory('graph', input, {
    action: 'tool.invoke',
    target: { kind: 'tool', id: input.target.id },
    input: input.toolInput ?? {},
    effects: [{ kind: 'tool.invoke', risk: 'high', target: input.target.id }]
  })
export const createMcpToolPolicyRequest = (input: ToolPolicyRequestFactoryInput): PolicyRequest =>
  factory('mcp', input, {
    action: 'tool.invoke',
    target: { kind: 'tool', id: input.target.id },
    input: input.toolInput ?? {},
    transport: 'mcp',
    effects: [{ kind: 'tool.invoke', risk: 'high', target: input.target.id }]
  })
export const createTriggerPolicyRequest = (
  input: TriggerPolicyRequestFactoryInput
): PolicyRequest => {
  const { triggerId, occurrence, trigger, effects, ...context } = input
  if (!nonempty(triggerId)) throw new Error('triggerId must be non-empty')
  if (!record(occurrence)) throw new Error('occurrence must be a record')
  for (const key of [
    'occurrenceAt',
    'windowStart',
    'windowEnd',
    'missedCount',
    'nextFireAtAfter'
  ] as const)
    if (!Number.isFinite(occurrence[key])) throw new Error(`occurrence.${key} must be finite`)
  if (!nonnegativeInt(occurrence.missedCount))
    throw new Error('occurrence.missedCount must be a nonnegative integer')
  if (occurrence.occurrenceId !== undefined && !nonempty(occurrence.occurrenceId))
    throw new Error('occurrence.occurrenceId must be non-empty when present')
  if (
    occurrence.source !== undefined &&
    occurrence.source !== 'schedule' &&
    occurrence.source !== 'manual' &&
    occurrence.source !== 'startup' &&
    occurrence.source !== 'channel-message' &&
    occurrence.source !== 'workflow-completion' &&
    occurrence.source !== 'drive-state' &&
    occurrence.source !== 'calendar' &&
    occurrence.source !== 'cron' &&
    occurrence.source !== 'sdk' &&
    occurrence.source !== 'custom'
  )
    throw new Error('occurrence.source is invalid')
  if (occurrence.requestedAt !== undefined && !Number.isFinite(occurrence.requestedAt))
    throw new Error('occurrence.requestedAt must be finite')
  if (occurrence.attempt !== undefined && !nonnegativeInt(occurrence.attempt))
    throw new Error('occurrence.attempt must be a nonnegative integer')
  if (occurrence.batchEndAt !== undefined && !Number.isFinite(occurrence.batchEndAt))
    throw new Error('occurrence.batchEndAt must be finite when present')
  if (!record(trigger) || !nonempty(trigger.type) || !nonempty(trigger.title))
    throw new Error('trigger must contain non-empty type and title')
  if (!Array.isArray(effects) || effects.length === 0)
    throw new Error('effects must be a non-empty array')
  for (const [index, effect] of effects.entries()) {
    if (
      !record(effect) ||
      !standardKinds.has(String(effect.kind)) ||
      !Object.prototype.hasOwnProperty.call(riskRank, String(effect.risk))
    )
      throw new Error(`effects[${index}] must be a canonical PolicyEffect`)
  }
  return factory('trigger', context as PolicyRequestFactoryInput, {
    action: 'trigger.execute',
    target: { kind: 'trigger', id: triggerId },
    input: {
      occurrence: {
        occurrenceAt: occurrence.occurrenceAt,
        windowStart: occurrence.windowStart,
        windowEnd: occurrence.windowEnd,
        missedCount: occurrence.missedCount,
        nextFireAtAfter: occurrence.nextFireAtAfter,
        ...(occurrence.batchEndAt === undefined ? {} : { batchEndAt: occurrence.batchEndAt }),
        ...(occurrence.occurrenceId === undefined ? {} : { occurrenceId: occurrence.occurrenceId }),
        ...(occurrence.source === undefined ? {} : { source: occurrence.source }),
        ...(occurrence.requestedAt === undefined ? {} : { requestedAt: occurrence.requestedAt }),
        ...(occurrence.attempt === undefined ? {} : { attempt: occurrence.attempt })
      },
      trigger: {
        type: trigger.type,
        title: trigger.title,
        config: trigger.config ?? {},
        metadata: trigger.metadata ?? {}
      }
    },
    effects
  })
}
export type TerminalPolicyRequestInput = PolicyRequestFactoryInput & {
  origin?: PolicyOrigin
  command: string
  args?: string[]
  cwd?: string
  confirm?: PolicyJsonValue
}
export const createTerminalPolicyRequest = (input: TerminalPolicyRequestInput): PolicyRequest => {
  const { command, args = [], cwd, confirm, origin = 'assistant', ...context } = input
  if (!nonempty(command)) throw new Error('command must be non-empty')
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new Error('args must be an array of strings')
  if (cwd !== undefined && !nonempty(cwd)) throw new Error('cwd must be non-empty when present')
  const effects: PolicyEffect[] = [
    { kind: 'process.execute', target: command, risk: 'high', metadata: { args } }
  ]
  if (cwd !== undefined) effects.push({ kind: 'filesystem.read', target: cwd, risk: 'read' })
  return factory(origin, context, {
    action: 'terminal.execute',
    input: { command, args },
    ...(confirm !== undefined ? { confirmation: confirm } : {}),
    ...(cwd !== undefined
      ? { filesystem: { ...(context.filesystem ?? {}), cwd } }
      : context.filesystem !== undefined
        ? { filesystem: context.filesystem }
        : {}),
    effects
  })
}
