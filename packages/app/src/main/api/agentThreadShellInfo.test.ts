import { describe, expect, it, vi } from 'vitest'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { createAgentThreadToolProvider } from './agentThreadTools'
import { describeThreadShell } from './agentThreadShellCatalog'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'shell-manual', threadId: 'pane' } as const
const names = ['shell.execute', 'shell.background'] as const
const tool = (name: string): Tool => ({ name, description: `Current admitted ${name}`, inputSchema: { type: 'object', additionalProperties: false, properties: {} } })
const context = () => ({ route, runId: 'shell-manual-run', toolCallId: 'manual-info' })
const setup = (initial: Tool[] = names.map(tool)) => {
  let tools = initial
  const assertInvocation = vi.fn(), listVisibleTools = vi.fn(() => tools)
  const describeSkill = vi.fn(), invokeSkill = vi.fn(), skillContext = vi.fn(), htmlApp = vi.fn(), request = vi.fn()
  const provider = createAgentThreadToolProvider({ route, messages: [{ role: 'user', content: 'PRIVATE_SHELL_SOURCE_AND_HISTORY_NOT_DOCUMENTATION' }], assertInvocation, listVisibleTools,
    skills: { describe: describeSkill, invoke: invokeSkill, context: skillContext } as never,
    htmlApp, interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: new AbortController().signal } })
  return { provider, assertInvocation, listVisibleTools, callbacks: [describeSkill, invokeSkill, skillContext, htmlApp, request], setVisible: (next: Tool[]) => { tools = next } }
}
const info = async (provider: ReturnType<typeof setup>['provider'], args: Record<string, unknown>) => JSON.parse((await provider.callTool('info', args, context())).content)

describe('visible-only passive general-shell manuals', () => {
  it.each(names)('documents the actual admitted %s without starting code or approving anything', async name => {
    const { provider, callbacks } = setup()
    const result = await info(provider, { name })
    expect(result).toMatchObject({ ...tool(name), grantsPermission: false, documentation: {
      contract: 'magicpot-local-shell-execution-manual/v1', name,
      documentationOnly: true, grantsPermission: false,
      authority: { readingUnlocksTool: false, requiresFreshFormalApproval: true, requiresExplicitOptIn: true, filesystemNetworkSandbox: false, receiptIsAuthority: false },
      limits: { codeUtf8Bytes: 6000, minimumTimeoutMs: 100, maximumTimeoutMs: 120000, defaultTimeoutMs: 30000, minimumOutputBytes: 512, maximumOutputBytes: 262144, defaultOutputBytes: 65536, mandatoryMemoryBytes: 536870912, mandatoryCpuMs: 60000 }
    } })
    expect(result.documentation.workflow.length).toBeGreaterThan(2)
    expect(JSON.stringify(result.documentation)).not.toContain('PRIVATE_SHELL_SOURCE_AND_HISTORY_NOT_DOCUMENTATION')
    expect(result.documentation.failure.automaticRetry).toBe(false)
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(await info(provider, { name, kind: 'tool' })).toEqual(result)
  })
  it.each(names)('deep clones the actual catalog for %s, including nested authority, limits and mode', name => {
    const tools = [...names, 'process.read', 'info'].map(tool)
    const first = describeThreadShell(name, tools)!
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(14000)
    first.workflow[0] = 'CHANGED'; first.authority.readingUnlocksTool = true
    first.authority.requiresFreshFormalApproval = false; first.authority.filesystemNetworkSandbox = true
    first.behavior.input = 'CHANGED'; first.execution.mode = 'changed'
    first.failure.automaticRetry = true; first.relatedTools.push('process.stop')
    first.limits.codeUtf8Bytes = 1; first.limits.defaultTimeoutMs = 1
    const fresh = describeThreadShell(name, tools)!
    expect(fresh.workflow[0]).not.toBe('CHANGED')
    expect(fresh.authority).toMatchObject({ readingUnlocksTool: false, requiresFreshFormalApproval: true, requiresExplicitOptIn: true, filesystemNetworkSandbox: false, receiptIsAuthority: false })
    expect(fresh.behavior.input).not.toBe('CHANGED')
    expect(fresh.execution.mode).toBe(name === 'shell.execute' ? 'foreground' : 'background')
    expect(fresh.failure).toMatchObject({ automaticRetry: false, cancellationIsRollback: false, unknownIsSuccess: false })
    expect(fresh.limits).toMatchObject({ codeUtf8Bytes: 6000, defaultTimeoutMs: 30000 })
    expect(fresh.relatedTools).toEqual([...names, 'process.read', 'info'].filter(item => item !== name))
  })
  it('documents actual local schema bounds, non-sandbox risk, formal identity and distinct foreground/background evidence', async () => {
    const { provider } = setup()
    const sync = (await info(provider, { name: 'shell.execute' })).documentation
    const background = (await info(provider, { name: 'shell.background' })).documentation
    expect(sync.limits).toMatchObject({ synchronousAttemptsPerRequest: 2, sharedLiveProcessesPerWorkspace: 2, sharedActiveOperationsGlobal: 4, cwdSchemaCharacters: 512 })
    expect(sync.limits).not.toHaveProperty('backgroundStartAttemptsPerRequest')
    expect(background.limits.backgroundStartAttemptsPerRequest).toBe(2)
    expect(background.limits).not.toHaveProperty('synchronousAttemptsPerRequest')
    expect(background.execution.budget).toContain('shared with python.background')
    expect(background.execution.budget).toContain('not two per family')
    expect(background.execution.budget).toContain('conflicting replay is rejected')
    expect(sync.behavior.input).toContain('milliseconds and bytes')
    expect(sync.behavior.interpreter).toContain('--noprofile --norc -c')
    expect(sync.behavior.interpreter).toContain('-NoLogo -NoProfile -NonInteractive -EncodedCommand')
    expect(sync.behavior.interpreter).toContain('general shell interpreter')
    expect(sync.behavior.risk).toContain('NOT a filesystem/network sandbox')
    expect(sync.behavior.risk).toContain('install software, change Git')
    expect(sync.behavior.resources).toContain('Existing uncertain termination blocks')
    expect(sync.behavior.output).toContain('share one bounded output budget')
    expect(sync.behavior.output).toContain('not secret storage')
    expect(sync.behavior.parity).toContain('not upstream bash or stop_task aliases')
    expect(sync.execution.result).toContain('businessTaskVerified:false')
    expect(background.execution.result).toContain('submittedOnly:true')
    expect(background.execution.result).toContain('not interpreter initialization')
    expect(background.execution.lifetime).toContain('Only successful parent release')
    expect(background.execution.lifetime).toContain('No arbitrary PID/sub-agent')
  })
  it('filters related current tools while keeping Python-family manuals separate and helper/listing selectors unchanged', async () => {
    const { provider, setVisible } = setup([tool('shell.execute'), tool('process.stop'), tool('info'), tool('foreign')])
    expect((await info(provider, { name: 'shell.execute' })).documentation.relatedTools).toEqual(['process.stop', 'info'])
    setVisible([tool('shell.background'), tool('shell.execute'), tool('python.execute')])
    expect((await info(provider, { name: 'shell.execute' })).documentation.relatedTools).toEqual(['shell.background'])
    expect(await info(provider, { name: 'python.execute' })).toMatchObject({ ...tool('python.execute'), grantsPermission: false, documentation: { contract: 'magicpot-local-python-execution-manual/v1', name: 'python.execute' } })
    expect(await info(provider, {})).toEqual({ tools: ['shell.background', 'shell.execute', 'python.execute'].map(name => ({ name, description: `Current admitted ${name}` })), grantsPermission: false })
    expect(await info(provider, { kind: 'subagent' })).toEqual({ kind: 'subagent', subagents: [], grantsPermission: false })
    for (const name of names) await expect(info(provider, { name, kind: 'subagent' })).rejects.toThrow('not available')
    expect(describeThreadShell('python.execute', [tool('python.execute')])).toBeUndefined()
    setVisible([])
    await expect(info(provider, { name: 'shell.execute' })).rejects.toThrow('not available')
    expect(describeThreadShell('shell.execute', [])).toBeUndefined()
  })
  it.each(['shell.execute', 'shell.background', 'shell', 'bash', 'BASH', 'shell.execute ', '../shell.execute', 'stop_task', 'python.execute', 'python.background', 'notebook.run', 'ui:quiz', '__proto__', 'constructor', 'search_memory', 'scratchpad'])('cannot disclose an unadmitted name or fallback %s', async name => {
    const { provider, callbacks } = setup([])
    await expect(info(provider, { name })).rejects.toThrow('not available')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(describeThreadShell(name, [tool('foreign')])).toBeUndefined()
    if (!names.some(item => item === name)) expect(describeThreadShell(name, [tool(name)])).toBeUndefined()
  })
  it.each([{ kind: 'plugin', name: 'shell.execute' }, { name: 'shell.execute', paths: ['x.ts'] }, { name: 'shell.background', offset: 0 }, { name: 'shell.execute', code: 'echo not-run' }, { name: 'shell.execute', approved: true }, { name: 'shell.background', run_in_background: true }, { name: 'shell.execute', type: 'bash' }])('rejects execution or authority-like documentation arguments %#', async args => {
    const { provider, callbacks } = setup()
    await expect(info(provider, args)).rejects.toThrow()
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('does not leak disabled exact shell names through the generic info description in tool discovery', async () => {
    const { provider } = setup([])
    const infoTool = provider.listTools().find(item => item.name === 'info')!
    for (const name of names) {
      expect(infoTool.description).not.toContain(name)
      await expect(info(provider, { name })).rejects.toThrow('not available')
    }
    expect(await info(provider, {})).toEqual({ tools: [], grantsPermission: false })
  })
  it('keeps existing family precedence, process/manual distinction and helper-only filtering', async () => {
    const { provider } = setup(['files.edit', 'show_card', 'process.stop', 'fork', ...names].map(tool))
    expect((await info(provider, { name: 'files.edit' })).documentation.contract).toBe('magicpot-local-file-mutation-manual/v1')
    expect((await info(provider, { name: 'show_card' })).documentation.contract).toBe('magicpot-local-interaction-manual/v1')
    expect((await info(provider, { name: 'process.stop' })).documentation.contract).toBe('magicpot-local-process-control-manual/v1')
    expect((await info(provider, { name: 'fork' })).kind).toBe('subagent')
    expect((await info(provider, { kind: 'subagent' })).subagents.map((item: { name: string }) => item.name)).toEqual(['fork'])
  })
  it('rechecks cancellation, current route and late admission without requesting execution', async () => {
    const { provider, assertInvocation, listVisibleTools, callbacks } = setup()
    const abort = new AbortController(); abort.abort()
    await expect(provider.callTool('info', { name: 'shell.execute' }, { ...context(), signal: abort.signal })).rejects.toThrow()
    await expect(provider.callTool('info', { name: 'shell.execute' }, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(listVisibleTools).not.toHaveBeenCalled()
    const late = new AbortController()
    listVisibleTools.mockImplementation(() => { late.abort(); return names.map(tool) })
    await expect(provider.callTool('info', { name: 'shell.background' }, { ...context(), signal: late.signal })).rejects.toThrow()
    listVisibleTools.mockImplementation(() => { assertInvocation.mockImplementation(() => { throw new Error('Owner ended') }); return names.map(tool) })
    await expect(info(provider, { name: 'shell.execute' })).rejects.toThrow('Owner ended')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
})
