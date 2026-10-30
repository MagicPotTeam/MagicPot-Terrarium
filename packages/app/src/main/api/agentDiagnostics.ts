import {
  normalizeAgentDiagnosticsRequest,
  type AgentDiagnosticsRequest,
  type AgentDiagnosticsResponse
} from '@shared/agentDiagnostics'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { authorizeMagicAgentApprovalRenderer } from '../magicAgentRuntime/trustedRouteBinding'
import { prepareCanvasAgentTools } from './canvasAgentTools'
import { extractSkillRuntimeAllowedToolNames } from './skillRuntimeToolPolicy'
import { resolveRemoteFetchAddress, RemoteFetchAddressPolicyError } from './remoteFetchPolicy'

type Dependencies = {
  remote: boolean
  terminalEnabled: boolean
  listTools: (names: string[]) => Array<{ name: string }>
}

/** No LLM, MCP reconnect, tool call, shell, HTTP or file read. */
export async function inspectAgentCapabilities(
  raw: AgentDiagnosticsRequest,
  invocation: ServiceInvocationContext | undefined,
  deps: Dependencies
): Promise<AgentDiagnosticsResponse> {
  if (!invocation || invocation.methodName !== 'svcLLMProxy.inspectAgentCapabilities')
    throw new Error('Diagnostics require a trusted local renderer.')
  authorizeMagicAgentApprovalRenderer(invocation)
  const req = normalizeAgentDiagnosticsRequest(raw)
  const external = deps.remote || req.externalAgent === true || req.mediaMode === true
  const response: AgentDiagnosticsResponse = {
    checkedAt: Date.now(),
    scope: external ? 'external-unverified' : 'local-catalog',
    tools: [],
    modelInvocationTested: false,
    toolExecutionTested: false,
    network: { checked: false, kind: 'dns-only', results: [] }
  }
  if (external) return response
  const candidate: LLMChatReq = {
    messages: [],
    route: req.route,
    conversationId: req.conversationId,
    profileId: req.profileId,
    skillRuntime: req.skillRuntime
  }
  // Same frame/project checks as sending a message. Discard the admission closure:
  // diagnostics must never execute it or imply authorization of future effects.
  const prepared = prepareCanvasAgentTools(candidate, invocation, {
    local: true,
    terminalEnabled: deps.terminalEnabled
  }).request
  const names = extractSkillRuntimeAllowedToolNames(prepared) ?? []
  const registered = new Set(names.length ? deps.listTools(names).map((tool) => tool.name) : [])
  response.tools = names.map((name) => ({ name, registered: registered.has(name) }))
  const webAllowed = response.tools.some(
    (tool) => tool.registered && ['web_search', 'web_fetch'].includes(tool.name)
  )
  if (req.checkDns && webAllowed) {
    // Fixed hosts only. Passing DNS is NOT HTTP reachability or successful search.
    response.network.checked = true
    response.network.results = await Promise.all(
      ['api.duckduckgo.com', 'html.duckduckgo.com'].map(async (host) => {
        try {
          await resolveRemoteFetchAddress(host, { timeoutMs: 3000 })
          return { host, status: 'public_dns' as const }
        } catch (error) {
          if (error instanceof RemoteFetchAddressPolicyError)
            return { host, status: 'blocked_address' as const, reason: error.reason }
          return {
            host,
            status:
              error instanceof Error && error.name === 'TimeoutError'
                ? ('timeout' as const)
                : ('dns_error' as const)
          }
        }
      })
    )
  }
  return response
}
