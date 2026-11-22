import { describe, expect, it, vi } from 'vitest'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { createAgentThreadToolProvider } from './agentThreadTools'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const context = () => ({ route, runId: 'run', toolCallId: 'call' })
const helper = (name: string): Tool => ({ name, description: `${name} visible helper`, inputSchema: { type: 'object', required: ['task'], properties: { task: { type: 'string' }, run_in_background: { type: 'boolean' } } } })
const setup = (initial: Tool[] = [helper('explore'), helper('critic'), helper('fork')]) => {
  let tools = initial
  const assertInvocation = vi.fn(), listVisibleTools = vi.fn(() => tools)
  const provider = createAgentThreadToolProvider({ route, messages: [{ role: 'user', content: 'PRIVATE_PARENT_TEXT' }], assertInvocation, listVisibleTools })
  return { provider, assertInvocation, listVisibleTools, setVisible: (next: Tool[]) => { tools = next } }
}
const info = async (provider: ReturnType<typeof setup>['provider'], args: Record<string, unknown>) => JSON.parse((await provider.callTool('info', args, context())).content)

describe('visible-only read-only subagent documentation', () => {
  it('adds a subagent selector without changing the default tool listing', async () => {
    const { provider } = setup()
    expect(provider.listTools().find(tool => tool.name === 'info')!.inputSchema).toMatchObject({ properties: { kind: { enum: ['tool', 'skill', 'subagent'] } } })
    expect(await info(provider, {})).toEqual({ tools: ['explore', 'critic', 'fork'].map(name => ({ name, description: `${name} visible helper` })), grantsPermission: false })
    const listed = await info(provider, { kind: 'subagent' })
    expect(listed).toMatchObject({ kind: 'subagent', subagents: ['explore', 'critic', 'fork'].map(name => ({ name, description: `${name} visible helper` })), grantsPermission: false })
    expect(JSON.stringify(listed)).not.toContain('PRIVATE_PARENT_TEXT')
  })
  it.each(['explore', 'critic', 'fork'])('returns local bounded docs for %s through both explicit and default info', async name => {
    const { provider } = setup()
    const result = await info(provider, { kind: 'subagent', name })
    expect(result).toMatchObject({ name, description: `${name} visible helper`, inputSchema: helper(name).inputSchema, kind: 'subagent', grantsPermission: false, documentation: {
      readOnly: true, advisoryOnly: true, limits: { delegations: 3, modelSteps: 8, toolCalls: 12, timeoutSeconds: 120, maxTimeoutSeconds: 180 },
      execution: { startsOnInfo: false, modelUsage: 'additional-to-parent', providerEligibilityCheckedOnExecution: true }
    } })
    expect(result.documentation.forbidden).toEqual(expect.arrayContaining(['writes', 'shell', 'tests/builds', 'network', 'recursive-delegation', 'user-interaction', 'media-generation']))
    expect(result.documentation.readToolsCeiling).toEqual(['files.read', 'files.tree', 'files.glob', 'files.grep', 'files.json.read'])
    expect(result.documentation.context).toMatchObject({ inheritsParentText: name === 'fork' })
    expect(await info(provider, { name })).toEqual(result)
    expect(await info(provider, { kind: 'tool', name })).toEqual(result)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PARENT_TEXT')
  })
  it('does not disclose unbound helpers, aliases, plugins or arbitrary path docs', async () => {
    const { provider, setVisible } = setup([helper('critic'), helper('files.read'), helper('think')])
    expect((await info(provider, { kind: 'subagent' })).subagents).toEqual([{ name: 'critic', description: 'critic visible helper' }])
    for (const name of ['explore', 'fork', 'think', 'files.read', '__proto__', 'constructor', '../critic.md', 'scratchpad', 'search_memory', 'plugin:secret']) {
      await expect(info(provider, { kind: 'subagent', name })).rejects.toThrow('not available')
    }
    expect((await info(provider, { name: 'files.read' })).documentation).toBeUndefined()
    setVisible([])
    expect((await info(provider, { kind: 'subagent' })).subagents).toEqual([])
    await expect(info(provider, { name: 'critic' })).rejects.toThrow('not available')
  })
  it.each([{ kind: 'subagent', paths: ['src/x.ts'] }, { kind: 'subagent', offset: 0 }, { kind: 'plugin', name: 'x' }, { kind: 'subagent', execute: true }, { kind: 'subagent', name: '' }])('rejects unsupported or authority-like arguments %j', async args => {
    const { provider } = setup()
    await expect(info(provider, args)).rejects.toThrow()
  })
  it('keeps documentation detached and reports background controls only if all are visible', async () => {
    const { provider, setVisible } = setup()
    const first = await info(provider, { name: 'fork' })
    expect(first.documentation.background).toMatchObject({ available: false, autoWake: false, restartResume: false })
    setVisible([helper('fork'), ...['jobs.list', 'jobs.status', 'jobs.read', 'jobs.wait', 'stop_task'].map(helper)])
    const second = await info(provider, { name: 'fork' })
    expect(second.documentation.background).toMatchObject({ available: true, controls: ['jobs.list', 'jobs.status', 'jobs.read', 'jobs.wait', 'stop_task'], autoWake: false, restartResume: false })
    second.documentation.limits.toolCalls = 999
    expect((await info(provider, { name: 'fork' })).documentation.limits.toolCalls).toBe(12)
    setVisible([helper('fork'), helper('jobs.read')])
    expect((await info(provider, { name: 'fork' })).documentation.background.available).toBe(false)
  })
  it('does not call procedural skills, interaction channels or HTML hosts while reading a helper manual', async () => {
    const describe = vi.fn(async () => ({ secret: 'SKILL_BODY_MUST_NOT_READ' })), invoke = vi.fn(), context = vi.fn()
    const request = vi.fn(), htmlApp = vi.fn(), assertLive = vi.fn()
    const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => [helper('critic')],
      skills: { describe, invoke, context } as never, htmlApp,
      interactions: { request, assertLive, dispose: vi.fn(), signal: new AbortController().signal } })
    expect((await info(provider, { name: 'critic' })).documentation.contract).toBe('magicpot-local-bounded-read-only-helper')
    for (const callback of [describe, invoke, context, request, htmlApp, assertLive]) expect(callback).not.toHaveBeenCalled()
  })
  it('checks cancellation/scope/liveness before exposing docs and rechecks after discovery', async () => {
    const { provider, assertInvocation, listVisibleTools } = setup()
    const controller = new AbortController(); controller.abort()
    await expect(provider.callTool('info', { kind: 'subagent' }, { ...context(), signal: controller.signal })).rejects.toThrow()
    await expect(provider.callTool('info', { kind: 'subagent' }, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(listVisibleTools).not.toHaveBeenCalled()
    const fresh = new AbortController()
    listVisibleTools.mockImplementation(() => { fresh.abort(); return [helper('critic')] })
    await expect(provider.callTool('info', { kind: 'subagent', name: 'critic' }, { ...context(), signal: fresh.signal })).rejects.toThrow()
    listVisibleTools.mockImplementation(() => { assertInvocation.mockImplementation(() => { throw new Error('request ended') }); return [helper('critic')] })
    await expect(info(provider, { name: 'critic' })).rejects.toThrow('request ended')
  })
})
