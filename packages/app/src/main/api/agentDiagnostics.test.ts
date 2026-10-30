import dns from 'node:dns/promises'
import https from 'node:https'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAgentDiagnosticsRequest } from '@shared/agentDiagnostics'
import { llmProxySvcDef } from '@shared/api/svcLLMProxy'
import { inspectAgentCapabilities } from './agentDiagnostics'
import { prepareCanvasAgentTools } from './canvasAgentTools'
import { extractSkillRuntimeAllowedToolNames } from './skillRuntimeToolPolicy'
import {
  registerMagicAgentTrustedRouteBinding,
  clearMagicAgentTrustedRouteBindingsForTest
} from '../magicAgentRuntime/trustedRouteBinding'

const url = 'file:///D:/owned/app/out/renderer/index.html#/canvas?id=project-a'
const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project-a',
  threadId: 'pane-a'
} as const
const invocation = {
  methodName: 'svcLLMProxy.inspectAgentCapabilities',
  senderId: 42,
  frameUrl: url,
  senderUrl: url,
  isMainFrame: true
}
const req = { route, conversationId: 'conversation-a', profileId: 'model-a' }
const deps = () => ({
  remote: false,
  terminalEnabled: false,
  listTools: vi.fn((names: string[]) => names.map((name) => ({ name })))
})
beforeEach(() => {
  registerMagicAgentTrustedRouteBinding(42, route, {
    trustedUrl: url,
    trustedWebContents: { id: 42, isDestroyed: () => false }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  clearMagicAgentTrustedRouteBindingsForTest()
})

describe('read-only Agent capability diagnostics', () => {
  it('registers a validated unary IPC endpoint', () => {
    expect(llmProxySvcDef.inspectAgentCapabilities.type).toBe('unary')
    expect(llmProxySvcDef.inspectAgentCapabilities.request).toBe(normalizeAgentDiagnosticsRequest)
  })
  it('uses the same catalogue as a normal canvas chat without running anything', async () => {
    const lookup = vi.spyOn(dns, 'lookup')
    const http = vi.spyOn(https, 'request')
    const input = { ...req, messages: [] }
    const normal = prepareCanvasAgentTools(
      input,
      { ...invocation, methodName: 'svcLLMProxy.chatStream' },
      { local: true, terminalEnabled: false }
    ).request
    const result = await inspectAgentCapabilities(req, invocation, deps())
    expect(result.tools.map((tool) => tool.name)).toEqual(
      extractSkillRuntimeAllowedToolNames(normal)
    )
    expect(result.tools.map((tool) => tool.name)).toContain('web_search')
    expect(result.modelInvocationTested).toBe(false)
    expect(result.toolExecutionTested).toBe(false)
    expect(result.network.checked).toBe(false)
    expect(lookup).not.toHaveBeenCalled()
    expect(http).not.toHaveBeenCalled()
  })
  it.each([
    undefined,
    { ...invocation, senderId: 43 },
    { ...invocation, isMainFrame: false },
    { ...invocation, methodName: 'svcLLMProxy.chat' }
  ])('rejects an untrusted inspector before lookup', async (context) => {
    const dependency = deps()
    const lookup = vi.spyOn(dns, 'lookup')
    await expect(
      inspectAgentCapabilities({ ...req, checkDns: true }, context, dependency)
    ).rejects.toThrow()
    expect(dependency.listTools).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
  })
  it('does not give a different canvas project the current canvas defaults', async () => {
    const result = await inspectAgentCapabilities(
      { ...req, route: { ...route, scopeId: 'other-project' } },
      invocation,
      deps()
    )
    expect(result.tools).toEqual([])
  })
  it.each([
    {},
    { bindings: [] },
    { bindings: [{ appId: 'app', source: 'assistant-runtime', toolNames: [] }] }
  ])('preserves explicit skill restrictions %j', async (skillRuntime) => {
    const lookup = vi.spyOn(dns, 'lookup')
    const result = await inspectAgentCapabilities(
      { ...req, skillRuntime, checkDns: true },
      invocation,
      deps()
    )
    expect(result.tools).toEqual([])
    expect(lookup).not.toHaveBeenCalled()
  })
  it('reports missing registrations without widening the configured list', async () => {
    const dependency = deps()
    dependency.listTools.mockReturnValue([{ name: 'web_search' }, { name: 'unbound.secret' }])
    const result = await inspectAgentCapabilities(
      {
        ...req,
        skillRuntime: { bindings: [{ appId: 'app', toolNames: ['web_search', 'mcp.missing'] }] }
      },
      invocation,
      dependency
    )
    expect(result.tools).toEqual([
      { name: 'web_search', registered: true },
      { name: 'mcp.missing', registered: false }
    ])
  })
  it.each([{ remote: true }, { externalAgent: true }, { mediaMode: true }])(
    'does not claim local capabilities for external/media paths %j',
    async (flags) => {
      const dependency = { ...deps(), remote: 'remote' in flags }
      const result = await inspectAgentCapabilities(
        { ...req, ...flags, checkDns: true },
        invocation,
        dependency
      )
      expect(result.scope).toBe('external-unverified')
      expect(result.tools).toEqual([])
      expect(result.network.checked).toBe(false)
      expect(dependency.listTools).not.toHaveBeenCalled()
    }
  )
  it.each(['198.18.1.9', '198.19.2.3', '127.0.0.1'])(
    'reports the existing DNS rejection for %s without opening a socket',
    async (address) => {
      const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address, family: 4 }] as never)
      const http = vi.spyOn(https, 'request')
      const result = await inspectAgentCapabilities({ ...req, checkDns: true }, invocation, deps())
      expect(result.network.results).toEqual(
        ['api.duckduckgo.com', 'html.duckduckgo.com'].map((host) => ({
          host,
          status: 'blocked_address',
          reason: address.startsWith('198.') ? 'reserved-benchmark' : 'private-or-local'
        }))
      )
      expect(lookup).toHaveBeenCalledTimes(2)
      expect(http).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain(address)
    }
  )
  it('labels public DNS as DNS-only, never a successful search', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never)
    const result = await inspectAgentCapabilities({ ...req, checkDns: true }, invocation, deps())
    expect(result.network.kind).toBe('dns-only')
    expect(result.network.results.every((item) => item.status === 'public_dns')).toBe(true)
    expect(result.toolExecutionTested).toBe(false)
  })
  it('does not expose DNS exception text', async () => {
    vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('PRIVATE diagnostic data'))
    const result = await inspectAgentCapabilities({ ...req, checkDns: true }, invocation, deps())
    expect(result.network.results.every((item) => item.status === 'dns_error')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
})
