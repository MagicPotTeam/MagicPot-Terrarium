import {
  canonicalPolicyJson,
  createTriggerPolicyRequest,
  sha256PolicyText,
  type PolicyEffect,
  type PolicyJsonRecord,
  type PolicyRequest,
  type TriggerPolicyRequestFactoryInput
} from '../../../shared/magicAgentPlatform2/policy'

export type TrustedTriggerExecutionTarget = Readonly<
  | {
      kind: 'agent-run'
      agentId: string
      prompt: string
      sessionId?: string
    }
  | {
      kind: 'graph-run'
      graphId: string
      input: PolicyJsonRecord
      sessionId?: string
    }
>

type TrustedTriggerInput = Omit<TriggerPolicyRequestFactoryInput, 'trigger' | 'effects'> & {
  triggerBase: {
    type: string
    title: string
    config?: PolicyJsonRecord
    metadata?: PolicyJsonRecord
  }
  trustedTarget: unknown
}

export type TrustedTriggerAdaptation = Readonly<{
  executionTarget: TrustedTriggerExecutionTarget
  policyRequestInput: TriggerPolicyRequestFactoryInput
  request: PolicyRequest
}>

const controlKeys = new Set([
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

const required = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be non-empty`)
  return value
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype

const jsonValue = (value: unknown, path: string): PolicyJsonRecord[string] => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`))
  if (!isRecord(value)) throw new Error(`${path} must be JSON data`)
  const result: PolicyJsonRecord = {}
  for (const [key, child] of Object.entries(value)) {
    if (controlKeys.has(key)) throw new Error(`${path}.${key} is not accepted`)
    result[key] = jsonValue(child, `${path}.${key}`)
  }
  return result
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

const validateTarget = (value: unknown): TrustedTriggerExecutionTarget => {
  if (!isRecord(value)) throw new Error('trustedTarget must be an object')
  const kind = value.kind
  const allowed =
    kind === 'agent-run'
      ? new Set(['kind', 'agentId', 'prompt', 'sessionId'])
      : kind === 'graph-run'
        ? new Set(['kind', 'graphId', 'input', 'sessionId'])
        : undefined
  if (!allowed) throw new Error('unsupported trustedTarget kind')
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`trustedTarget.${key} is not accepted`)
  const sessionId =
    value.sessionId === undefined ? undefined : required(value.sessionId, 'sessionId')
  if (kind === 'agent-run') {
    if (typeof value.prompt !== 'string') throw new Error('trustedTarget.prompt must be a string')
    return deepFreeze({
      kind: 'agent-run' as const,
      agentId: required(value.agentId, 'trustedTarget.agentId'),
      prompt: value.prompt,
      ...(sessionId === undefined ? {} : { sessionId })
    })
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'input'))
    throw new Error('trustedTarget.input must be present')
  const input = jsonValue(value.input, 'trustedTarget.input')
  if (!isRecord(input)) throw new Error('trustedTarget.input must be an object')
  return deepFreeze({
    kind: 'graph-run' as const,
    graphId: required(value.graphId, 'trustedTarget.graphId'),
    input,
    ...(sessionId === undefined ? {} : { sessionId })
  })
}

const buildPolicyInput = (
  input: TrustedTriggerInput,
  executionTarget: TrustedTriggerExecutionTarget
): TriggerPolicyRequestFactoryInput => {
  const destinationId =
    executionTarget.kind === 'agent-run' ? executionTarget.agentId : executionTarget.graphId
  const payload: PolicyJsonRecord = {}
  if (executionTarget.kind === 'agent-run') payload.prompt = executionTarget.prompt
  else payload.input = executionTarget.input
  const payloadDigest = `sha256:${sha256PolicyText(canonicalPolicyJson(payload))}`
  const config: PolicyJsonRecord = {
    targetKind: executionTarget.kind,
    destinationId,
    ...(executionTarget.sessionId === undefined ? {} : { sessionId: executionTarget.sessionId }),
    payloadDigest
  }
  const toolName = executionTarget.kind === 'agent-run' ? 'agent.run' : 'graph.run'
  const effects: PolicyEffect[] = [
    { kind: 'tool.invoke', risk: 'high', target: destinationId, metadata: { toolName } }
  ]
  return {
    requestId: input.requestId,
    actor: input.actor,
    triggerId: input.triggerId,
    occurrence: input.occurrence,
    trigger: { type: input.triggerBase.type, title: input.triggerBase.title, config },
    effects,
    ...(input.route === undefined ? {} : { route: input.route }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
    ...(input.graphId === undefined ? {} : { graphId: input.graphId }),
    ...(input.graphRunId === undefined ? {} : { graphRunId: input.graphRunId }),
    ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.transport === undefined ? {} : { transport: input.transport })
  }
}

export const adaptTrustedTriggerTarget = (input: TrustedTriggerInput): TrustedTriggerAdaptation => {
  const executionTarget = validateTarget(input.trustedTarget)
  const policyRequestInput = buildPolicyInput(input, executionTarget)
  const request = createTriggerPolicyRequest(policyRequestInput)
  return deepFreeze({ executionTarget, policyRequestInput, request })
}
