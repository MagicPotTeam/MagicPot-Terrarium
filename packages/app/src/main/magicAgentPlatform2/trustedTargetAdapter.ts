import { createHash } from 'node:crypto'
import {
  digestPolicyRequest,
  type PolicyEffect,
  type PolicyJsonRecord,
  type PolicyRequest
} from '../../shared/magicAgentPlatform2'
import { redactPolicyRequestForAudit, type RedactedPolicyRequest } from './policy/redaction'

export const TRUSTED_TARGET_ADAPTER_DISCRIMINATOR = 'magic-agent.trusted-target.v1' as const
export const TRUSTED_TARGET_ADAPTER_VERSION = 1 as const
export type TrustedTargetKind = 'agent-run' | 'graph-run'
export type TrustedTargetInput = Readonly<{
  targetKind: TrustedTargetKind
  targetId: string
  requestId: string
  actorId: string
  input?: PolicyJsonRecord
  route?: PolicyJsonRecord
  sessionId?: string
  runId?: string
  graphId?: string
  graphRunId?: string
  nodeId?: string
  workspaceId?: string
}>
export type TrustedTargetRequest = Readonly<
  PolicyRequest & {
    target: PolicyRequest['target'] & { kind: TrustedTargetKind }
    effects: [PolicyEffect]
    metadata: {
      adapter: typeof TRUSTED_TARGET_ADAPTER_DISCRIMINATOR
      effectsFixed: true
      digestMarker: string
    }
  }
>

const EFFECTS: Readonly<Record<TrustedTargetKind, readonly [PolicyEffect]>> = {
  'agent-run': [{ kind: 'tool.invoke', target: 'agent.run', risk: 'high' }],
  'graph-run': [{ kind: 'tool.invoke', target: 'graph.run', risk: 'high' }]
}
const CONTROL_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'authorization',
  'approval',
  'decision',
  'effects',
  'permit',
  'policy',
  'policyDecision'
])
const requiredId = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${path} must be a non-empty string.`)
  return value
}
const jsonValue = (value: unknown, path: string): PolicyJsonRecord[string] => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`))
  return jsonRecord(value, path)
}
const jsonRecord = (value: unknown, path: string): PolicyJsonRecord => {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path} must be a JSON object.`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${path} must have a safe JSON object prototype.`)
  const result: PolicyJsonRecord = {}
  for (const key of Object.getOwnPropertyNames(value)) {
    if (CONTROL_KEYS.has(key)) throw new Error(`${path}.${key} is not accepted.`)
    result[key] = jsonValue((value as Record<string, unknown>)[key], `${path}.${key}`)
  }
  return result
}
const digestMarker = (request: PolicyRequest): string =>
  `trusted-target:${createHash('sha256').update(digestPolicyRequest(request)).digest('hex')}`

export const createTrustedTargetRequest = (input: TrustedTargetInput): TrustedTargetRequest => {
  if (input.targetKind !== 'agent-run' && input.targetKind !== 'graph-run')
    throw new Error('Unsupported trusted target kind.')
  const targetId = requiredId(input.targetId, 'targetId')
  const request = {
    discriminator: 'magic-agent.policy-request.v1' as const,
    version: 1 as const,
    requestId: requiredId(input.requestId, 'requestId'),
    actor: { kind: 'trusted-target-adapter', id: requiredId(input.actorId, 'actorId') },
    origin: 'internal' as const,
    action: input.targetKind === 'agent-run' ? 'agent.run' : 'graph.run',
    target: { kind: input.targetKind, id: targetId },
    input: jsonRecord(input.input, 'input'),
    effects: [...EFFECTS[input.targetKind]],
    ...(input.route === undefined ? {} : { route: jsonRecord(input.route, 'route') }),
    ...(input.sessionId === undefined
      ? {}
      : { sessionId: requiredId(input.sessionId, 'sessionId') }),
    ...(input.runId === undefined ? {} : { runId: requiredId(input.runId, 'runId') }),
    ...(input.graphId === undefined ? {} : { graphId: requiredId(input.graphId, 'graphId') }),
    ...(input.graphRunId === undefined
      ? {}
      : { graphRunId: requiredId(input.graphRunId, 'graphRunId') }),
    ...(input.nodeId === undefined ? {} : { nodeId: requiredId(input.nodeId, 'nodeId') }),
    ...(input.workspaceId === undefined
      ? {}
      : { workspaceId: requiredId(input.workspaceId, 'workspaceId') })
  } satisfies PolicyRequest
  return Object.freeze({
    ...request,
    metadata: {
      adapter: TRUSTED_TARGET_ADAPTER_DISCRIMINATOR,
      effectsFixed: true,
      digestMarker: digestMarker(request)
    }
  }) as TrustedTargetRequest
}
export const redactTrustedTargetRequest = (request: TrustedTargetRequest): RedactedPolicyRequest =>
  redactPolicyRequestForAudit(request)
export const parseTrustedTargetRequest = (value: unknown): TrustedTargetRequest => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Trusted target request must be an object.')
  const candidate = value as Record<string, unknown>
  if (candidate.discriminator !== 'magic-agent.policy-request.v1' || candidate.version !== 1)
    throw new Error('Unsupported trusted target request version.')
  const metadata = candidate.metadata as Record<string, unknown> | undefined
  if (!metadata || metadata.effectsFixed !== true)
    throw new Error('Trusted target effects must be fixed.')
  const target = candidate.target as Record<string, unknown> | undefined
  if (!target || (target.kind !== 'agent-run' && target.kind !== 'graph-run'))
    throw new Error('Unsupported trusted target kind.')
  if (JSON.stringify(candidate.effects) !== JSON.stringify(EFFECTS[target.kind]))
    throw new Error('Trusted target effects are invalid.')
  const request = createTrustedTargetRequest({
    targetKind: target.kind,
    targetId: String(target.id ?? ''),
    requestId: String(candidate.requestId ?? ''),
    actorId: String((candidate.actor as Record<string, unknown> | undefined)?.id ?? ''),
    input: candidate.input as PolicyJsonRecord,
    route: candidate.route as PolicyJsonRecord | undefined,
    sessionId: candidate.sessionId as string | undefined,
    runId: candidate.runId as string | undefined,
    graphId: candidate.graphId as string | undefined,
    graphRunId: candidate.graphRunId as string | undefined,
    nodeId: candidate.nodeId as string | undefined,
    workspaceId: candidate.workspaceId as string | undefined
  })
  if (metadata.digestMarker !== request.metadata.digestMarker)
    throw new Error('Trusted target digest marker mismatch.')
  return request
}
