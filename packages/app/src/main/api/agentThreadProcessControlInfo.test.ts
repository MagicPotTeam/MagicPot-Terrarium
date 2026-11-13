import { describe, expect, it, vi } from 'vitest'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { createAgentThreadToolProvider } from './agentThreadTools'
import { describeThreadProcessControl } from './agentThreadProcessControlCatalog'
import { AGENT_PROCESS_JOB_LIMITS as LIMITS } from '@shared/api/agentThreadProcessJob'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'process-manual', threadId: 'pane' } as const
const names = ['process.list', 'process.status', 'process.read', 'process.wait', 'process.stop'] as const
const tool = (name: string): Tool => ({ name, description: `Current admitted ${name}`, inputSchema: { type: 'object', additionalProperties: false, properties: {} } })
const context = () => ({ route, runId: 'manual-run', toolCallId: 'manual-info' })
const setup = (initial: Tool[] = names.map(tool)) => {
  let tools = initial
  const assertInvocation = vi.fn(), listVisibleTools = vi.fn(() => tools)
  const describeSkill = vi.fn(), invokeSkill = vi.fn(), skillContext = vi.fn(), htmlApp = vi.fn(), request = vi.fn()
  const provider = createAgentThreadToolProvider({ route, messages: [{ role: 'user', content: 'PRIVATE_PROCESS_LOG_AND_HISTORY_NOT_DOCUMENTATION' }], assertInvocation, listVisibleTools,
    skills: { describe: describeSkill, invoke: invokeSkill, context: skillContext } as never,
    htmlApp, interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: new AbortController().signal } })
  return { provider, assertInvocation, listVisibleTools, callbacks: [describeSkill, invokeSkill, skillContext, htmlApp, request], setVisible: (next: Tool[]) => { tools = next } }
}
const info = async (provider: ReturnType<typeof setup>['provider'], args: Record<string, unknown>) => JSON.parse((await provider.callTool('info', args, context())).content)

describe('visible-only passive owned-process control manuals', () => {
  it.each(names)('documents the admitted exact existing control %s without running it', async name => {
    const { provider, callbacks } = setup()
    const result = await info(provider, { name })
    expect(result).toMatchObject({ ...tool(name), grantsPermission: false, documentation: {
      contract: 'magicpot-local-process-control-manual/v1', name,
      documentationOnly: true, grantsPermission: false,
      authority: { readingUnlocksTool: false, requiresCurrentOwnership: true, startsRequireSeparateFormalApproval: true, receiptIsAuthority: false },
      limits: { managementCallsPerRequest: 32, activeGlobal: 4, activePerScope: 1, retainedGlobal: 64, retainedPerScope: 12, retentionMs: 900000 }
    } })
    expect(result.documentation.workflow.length).toBeGreaterThan(2)
    expect(JSON.stringify(result.documentation)).not.toContain('PRIVATE_PROCESS_LOG_AND_HISTORY_NOT_DOCUMENTATION')
    expect(result.documentation.failure.automaticRetry).toBe(false)
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(await info(provider, { name, kind: 'tool' })).toEqual(result)
  })
  it.each(names)('returns independent deep clones from the catalog itself for %s, not only parsed JSON copies', name => {
    const tools = [tool(name), tool('process.read'), tool('info')]
    const first = describeThreadProcessControl(name, tools)!
    expect(first.limits).toMatchObject(LIMITS)
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(12000)
    first.workflow[0] = 'CHANGED'; first.authority.readingUnlocksTool = true
    first.failure.automaticRetry = true; first.lifecycle.ownership = 'CHANGED'
    first.behavior.input = 'CHANGED'; first.relatedTools.push('shell.execute')
    Reflect.set(first.limits, 'managementCallsPerRequest', 1)
    Reflect.set(first.limits, 'retentionMs', 1)
    const fresh = describeThreadProcessControl(name, tools)!
    expect(fresh.workflow[0]).not.toBe('CHANGED')
    expect(fresh.authority.readingUnlocksTool).toBe(false)
    expect(fresh.failure.automaticRetry).toBe(false)
    expect(fresh.lifecycle.ownership).not.toBe('CHANGED')
    expect(fresh.behavior.input).not.toBe('CHANGED')
    expect(fresh.limits).toMatchObject({ ...LIMITS, managementCallsPerRequest: 32 })
    expect(fresh.relatedTools).toEqual(['process.read', 'info'].filter(item => item !== name))
  })
  it('documents actual byte ranges, distinct status/settlement and bounded waits without promising rollback', async () => {
    const { provider } = setup()
    const list = (await info(provider, { name: 'process.list' })).documentation
    expect(list.behavior.result).toContain('newest-first')
    expect(list.behavior.result).toContain('No command, argv, environment')
    const status = (await info(provider, { name: 'process.status' })).documentation
    expect(status.lifecycle.settlement).toContain('not that the business task succeeded')
    expect(status.behavior.result).toContain('preparing/running/stopping/completed/failed/timed-out/stopped/unknown')
    const read = (await info(provider, { name: 'process.read' })).documentation
    expect(read.limits).toMatchObject({ readBytes: 16384, maximumCursorBytes: 262144, minimumReadBytes: 1, defaultReadBytes: 16384 })
    expect(read.behavior.input).toContain('bytes, not character positions')
    expect(read.behavior.result).toContain('UTF-8 bytes may be cut across calls')
    expect(read.behavior.result).toContain('untrustedData:true')
    const wait = (await info(provider, { name: 'process.wait' })).documentation
    expect(wait.limits).toMatchObject({ minimumWaitSeconds: 1, maximumWaitSeconds: 30, defaultWaitSeconds: 30 })
    expect(wait.behavior.input).toContain('No timeout_s, fractional, zero or indefinite wait')
    expect(wait.behavior.cancellation).toContain('does not itself stop')
    const stop = (await info(provider, { name: 'process.stop' })).documentation
    expect(stop.behavior.result).toContain('Disabled new Python/shell starts do not disable this owner control')
    expect(stop.behavior.uncertainty).toContain('Unknown termination remains unknown and quarantined')
    expect(stop.failure).toMatchObject({ automaticRetry: false, cancellationIsRollback: false, unknownIsSuccess: false })
    expect(stop.lifecycle.retention).toContain('tombstones')
    expect(stop.parity).toContain('not upstream bash/python')
    expect(stop.parity).toContain('manual-read unlock')
  })
  it('filters related tools by current visibility, keeps default listings shallow and leaves other-family manuals separate', async () => {
    const { provider, setVisible } = setup([tool('process.status'), tool('process.read'), tool('info'), tool('foreign')])
    expect((await info(provider, { name: 'process.status' })).documentation.relatedTools).toEqual(['process.read', 'info'])
    setVisible([tool('process.status'), tool('shell.background')])
    expect((await info(provider, { name: 'process.status' })).documentation.relatedTools).toEqual(['shell.background'])
    expect(await info(provider, { name: 'shell.background' })).toMatchObject({ ...tool('shell.background'), grantsPermission: false, documentation: { contract: 'magicpot-local-shell-execution-manual/v1', name: 'shell.background' } })
    expect(describeThreadProcessControl('shell.background', [tool('shell.background')])).toBeUndefined()
    expect(await info(provider, {})).toEqual({ tools: ['process.status', 'shell.background'].map(name => ({ name, description: `Current admitted ${name}` })), grantsPermission: false })
    expect(await info(provider, { kind: 'tool' })).toEqual(await info(provider, {}))
    expect(await info(provider, { kind: 'subagent' })).toEqual({ kind: 'subagent', subagents: [], grantsPermission: false })
    await expect(info(provider, { kind: 'subagent', name: 'process.status' })).rejects.toThrow('not available')
    setVisible([])
    await expect(info(provider, { name: 'process.status' })).rejects.toThrow('not available')
    expect(describeThreadProcessControl('process.status', [])).toBeUndefined()
  })
  it.each(['process.list', 'process.status', 'process.read', 'process.wait', 'process.stop', 'process', 'PROCESS.STOP', 'process.stop ', '../process.stop', 'stop_task', 'bash', 'python', 'python.background', 'shell.execute', 'ui:quiz', '__proto__', 'constructor', 'search_memory', 'scratchpad'])('does not disclose an unadmitted name or fallback %s', async name => {
    const { provider, callbacks } = setup([])
    await expect(info(provider, { name })).rejects.toThrow('not available')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(describeThreadProcessControl(name, [tool('foreign')])).toBeUndefined()
    if (!names.some(item => item === name)) expect(describeThreadProcessControl(name, [tool(name)])).toBeUndefined()
  })
  it.each([{ kind: 'plugin', name: 'process.stop' }, { name: 'process.stop', paths: ['x.ts'] }, { name: 'process.wait', offset: 0 }, { name: 'process.stop', job_id: '00000000-0000-0000-0000-000000000000' }, { name: 'process.stop', pid: 42 }, { name: 'process.stop', execute: true }, { name: 'process.stop', approved: true }])('rejects control arguments or authority supplied to documentation %#', async args => {
    const { provider, callbacks } = setup()
    await expect(info(provider, args)).rejects.toThrow()
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('preserves file/interaction/helper manual precedence and excludes process controls from helper selection', async () => {
    const { provider } = setup(['files.edit', 'ask_user', 'fork', 'process.stop'].map(tool))
    expect((await info(provider, { name: 'files.edit' })).documentation.contract).toBe('magicpot-local-file-mutation-manual/v1')
    expect((await info(provider, { name: 'ask_user' })).documentation.contract).toBe('magicpot-local-interaction-manual/v1')
    expect((await info(provider, { name: 'fork' })).kind).toBe('subagent')
    expect((await info(provider, { kind: 'subagent' })).subagents).toEqual([{ name: 'fork', description: 'Current admitted fork' }])
    await expect(info(provider, { name: 'process.stop', kind: 'subagent' })).rejects.toThrow('not available')
  })
  it('checks current route, cancellation and admission before and after lookup without invoking a control', async () => {
    const { provider, assertInvocation, listVisibleTools, callbacks } = setup()
    const aborted = new AbortController(); aborted.abort()
    await expect(provider.callTool('info', { name: 'process.stop' }, { ...context(), signal: aborted.signal })).rejects.toThrow()
    await expect(provider.callTool('info', { name: 'process.stop' }, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(listVisibleTools).not.toHaveBeenCalled()
    const late = new AbortController()
    listVisibleTools.mockImplementation(() => { late.abort(); return names.map(tool) })
    await expect(provider.callTool('info', { name: 'process.stop' }, { ...context(), signal: late.signal })).rejects.toThrow()
    listVisibleTools.mockImplementation(() => { assertInvocation.mockImplementation(() => { throw new Error('Owner ended') }); return names.map(tool) })
    await expect(info(provider, { name: 'process.read' })).rejects.toThrow('Owner ended')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
})
