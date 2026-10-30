import { normalizeAgentRoute, type AgentRouteLike } from './agent'
import type { LLMChatSkillRuntime } from './api/svcLLMProxy'

/** Bounded read-only input. Never carries prompts, credentials or tool arguments. */
export type AgentDiagnosticsRequest = {
  route?: AgentRouteLike
  conversationId?: string
  profileId?: string
  skillRuntime?: Pick<LLMChatSkillRuntime, 'skillId' | 'bindings'>
  externalAgent?: boolean
  mediaMode?: boolean
  checkDns?: boolean
}
export type AgentDnsStatus = 'public_dns' | 'blocked_address' | 'timeout' | 'dns_error'
export type AgentDiagnosticsResponse = {
  checkedAt: number
  scope: 'local-catalog' | 'external-unverified'
  tools: Array<{ name: string; registered: boolean }>
  modelInvocationTested: false
  toolExecutionTested: false
  network: {
    checked: boolean
    kind: 'dns-only'
    results: Array<{
      host: string
      status: AgentDnsStatus
      reason?: 'reserved-benchmark' | 'private-or-local'
    }>
  }
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid diagnostics object.')
  return value as Record<string, unknown>
}
const text = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length > 256 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('Invalid diagnostics identifier.')
  return value
}

/** Also used by the UI: hidden prompts/resource URIs never cross this boundary. */
export function normalizeAgentDiagnosticsRequest(value: unknown): AgentDiagnosticsRequest {
  const raw = record(value)
  const out: AgentDiagnosticsRequest = {}
  for (const key of ['conversationId', 'profileId'] as const) {
    if (raw[key] !== undefined) out[key] = text(raw[key])
  }
  for (const key of ['checkDns', 'externalAgent', 'mediaMode'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'boolean') throw new Error('Invalid diagnostics flag.')
      out[key] = raw[key]
    }
  }
  if (raw.route !== undefined) {
    const route = record(raw.route)
    for (const key of ['channel', 'scopeType', 'scopeId', 'threadId']) {
      if (route[key] !== undefined) text(route[key])
    }
    out.route = normalizeAgentRoute(route as AgentRouteLike)
  }
  if (raw.skillRuntime !== undefined) {
    const runtime = record(raw.skillRuntime)
    out.skillRuntime = {}
    if (runtime.skillId !== undefined) out.skillRuntime.skillId = text(runtime.skillId)
    if (runtime.bindings !== undefined) {
      if (!Array.isArray(runtime.bindings) || runtime.bindings.length > 32)
        throw new Error('Too many diagnostics bindings.')
      let count = 0
      out.skillRuntime.bindings = runtime.bindings.map((value) => {
        const binding = record(value)
        const result: NonNullable<LLMChatSkillRuntime['bindings']>[number] = {
          appId: text(binding.appId)
        }
        if (binding.source !== undefined) result.source = text(binding.source)
        if (binding.toolNames !== undefined) {
          if (!Array.isArray(binding.toolNames) || (count += binding.toolNames.length) > 128)
            throw new Error('Too many diagnostics tools.')
          result.toolNames = binding.toolNames.map(text)
        }
        return result
      })
    }
  }
  return out
}

/** Fail closed on old/malformed IPC responses rather than rendering a false success. */
export function normalizeAgentDiagnosticsResponse(value: unknown): AgentDiagnosticsResponse {
  const raw = record(value)
  if (
    typeof raw.checkedAt !== 'number' ||
    !Number.isFinite(raw.checkedAt) ||
    raw.checkedAt < 0 ||
    raw.checkedAt > 8.64e15 ||
    !['local-catalog', 'external-unverified'].includes(String(raw.scope)) ||
    raw.modelInvocationTested !== false ||
    raw.toolExecutionTested !== false ||
    !Array.isArray(raw.tools) ||
    raw.tools.length > 128
  )
    throw new Error('Invalid diagnostics response.')
  const network = record(raw.network)
  if (
    typeof network.checked !== 'boolean' ||
    network.kind !== 'dns-only' ||
    !Array.isArray(network.results) ||
    network.results.length > 2
  )
    throw new Error('Invalid diagnostics network result.')
  const results = network.results.map((value) => {
    const item = record(value)
    if (
      !['api.duckduckgo.com', 'html.duckduckgo.com'].includes(String(item.host)) ||
      !['public_dns', 'blocked_address', 'timeout', 'dns_error'].includes(String(item.status)) ||
      (item.reason !== undefined &&
        !['reserved-benchmark', 'private-or-local'].includes(String(item.reason)))
    )
      throw new Error('Invalid diagnostics DNS result.')
    return {
      host: text(item.host),
      status: item.status as AgentDnsStatus,
      ...(item.reason === undefined
        ? {}
        : { reason: item.reason as 'reserved-benchmark' | 'private-or-local' })
    }
  })
  if (
    (!network.checked && results.length) ||
    new Set(results.map((item) => item.host)).size !== results.length
  )
    throw new Error('Invalid diagnostics DNS evidence.')
  return {
    checkedAt: raw.checkedAt,
    scope: raw.scope as AgentDiagnosticsResponse['scope'],
    modelInvocationTested: false,
    toolExecutionTested: false,
    tools: raw.tools.map((value) => {
      const tool = record(value)
      if (typeof tool.registered !== 'boolean') throw new Error('Invalid diagnostics tool result.')
      return { name: text(tool.name), registered: tool.registered }
    }),
    network: { checked: network.checked, kind: 'dns-only', results }
  }
}
