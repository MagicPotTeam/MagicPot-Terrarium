import { describe, expect, it, vi } from 'vitest'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { createAgentThreadToolProvider } from './agentThreadTools'
import { describeThreadPython } from './agentThreadPythonCatalog'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'python-manual', threadId: 'pane' } as const
const names = ['python.execute', 'python.background'] as const
const tool = (name: string): Tool => ({ name, description: `Current admitted ${name}`, inputSchema: { type: 'object', additionalProperties: false, properties: {} } })
const context = () => ({ route, runId: 'python-manual-run', toolCallId: 'manual-info' })
const setup = (initial: Tool[] = names.map(tool)) => {
  let tools = initial
  const assertInvocation = vi.fn(), listVisibleTools = vi.fn(() => tools)
  const describeSkill = vi.fn(), invokeSkill = vi.fn(), skillContext = vi.fn(), htmlApp = vi.fn(), request = vi.fn()
  const provider = createAgentThreadToolProvider({ route, messages: [{ role: 'user', content: 'PRIVATE_PYTHON_SOURCE_AND_HISTORY_NOT_DOCUMENTATION' }], assertInvocation, listVisibleTools,
    skills: { describe: describeSkill, invoke: invokeSkill, context: skillContext } as never,
    htmlApp, interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: new AbortController().signal } })
  return { provider, assertInvocation, listVisibleTools, callbacks: [describeSkill, invokeSkill, skillContext, htmlApp, request], setVisible: (next: Tool[]) => { tools = next } }
}
const info = async (provider: ReturnType<typeof setup>['provider'], args: Record<string, unknown>) => JSON.parse((await provider.callTool('info', args, context())).content)

describe('visible-only passive configured-Python execution manuals', () => {
  it.each(names)('documents the admitted %s without probing an interpreter, starting code or approving anything', async name => {
    const { provider, callbacks } = setup()
    const result = await info(provider, { name })
    expect(result).toMatchObject({ ...tool(name), grantsPermission: false, documentation: {
      contract: 'magicpot-local-python-execution-manual/v1', name,
      documentationOnly: true, grantsPermission: false,
      authority: { readingUnlocksTool: false, requiresFreshFormalApproval: true, requiresExplicitOptIn: true, filesystemNetworkSandbox: false, receiptIsAuthority: false },
      limits: { codeUtf8Bytes: 262144, minimumTimeoutMs: 1, maximumTimeoutMs: 120000, defaultTimeoutMs: 30000, minimumOutputBytes: 1, maximumOutputBytes: 262144, defaultOutputBytes: 65536, mandatoryMemoryBytes: 536870912, mandatoryCpuMs: 60000 }
    } })
    expect(result.documentation.workflow.length).toBeGreaterThan(2)
    expect(JSON.stringify(result.documentation)).not.toContain('PRIVATE_PYTHON_SOURCE_AND_HISTORY_NOT_DOCUMENTATION')
    expect(result.documentation.failure.automaticRetry).toBe(false)
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(await info(provider, { name, kind: 'tool' })).toEqual(result)
  })
  it.each(names)('deep clones the direct Python catalog for %s, not merely a parsed JSON result', name => {
    const tools = [...names, 'process.read', 'info'].map(tool)
    const first = describeThreadPython(name, tools)!
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(16000)
    first.workflow[0] = 'CHANGED'; first.authority.readingUnlocksTool = true
    first.authority.requiresFreshFormalApproval = false; first.authority.filesystemNetworkSandbox = true
    first.behavior.input = 'CHANGED'; first.execution.mode = 'changed'
    first.failure.automaticRetry = true; first.relatedTools.push('process.stop')
    first.limits.codeUtf8Bytes = 1; first.limits.interpreterProbeTimeoutMs = 1
    const fresh = describeThreadPython(name, tools)!
    expect(fresh.workflow[0]).not.toBe('CHANGED')
    expect(fresh.authority).toMatchObject({ readingUnlocksTool: false, requiresFreshFormalApproval: true, requiresExplicitOptIn: true, filesystemNetworkSandbox: false, receiptIsAuthority: false })
    expect(fresh.behavior.input).not.toBe('CHANGED')
    expect(fresh.execution.mode).toBe(name === 'python.execute' ? 'foreground' : 'background')
    expect(fresh.failure).toMatchObject({ automaticRetry: false, cancellationIsRollback: false, unknownIsSuccess: false })
    expect(fresh.limits).toMatchObject({ codeUtf8Bytes: 262144, interpreterProbeTimeoutMs: 5000 })
    expect(fresh.relatedTools).toEqual([...names, 'process.read', 'info'].filter(item => item !== name))
  })
  it('documents actual Python-specific source, pre-task probe, nested result and shared budgets, not copied shell limits', async () => {
    const { provider } = setup()
    const sync = (await info(provider, { name: 'python.execute' })).documentation
    const background = (await info(provider, { name: 'python.background' })).documentation
    expect(sync.limits).toMatchObject({ sharedScriptCallsPerRequest: 12, sharedEffectfulScriptAttemptsPerRequest: 4, sharedScriptExecutionAttemptsPerRequest: 2 })
    expect(sync.limits).not.toHaveProperty('backgroundStartAttemptsPerRequest')
    expect(background.limits).toMatchObject({ backgroundStartAttemptsPerRequest: 2, passiveJsonArgumentBytes: 1100000 })
    expect(background.execution.budget).toContain('shared with shell.background')
    expect(background.execution.input).toContain('nonblank, NUL-free')
    expect(background.execution.input).toContain('1100000 serialized UTF-8 bytes')
    expect(background.execution.input).toContain('not the foreground shell')
    expect(sync.behavior.input).toContain('foreground host rejects zero-byte')
    expect(sync.behavior.input).toContain('does not add the shell tool')
    expect(sync.behavior.interpreter).toContain('-I -S -B -u')
    expect(sync.behavior.interpreter).toContain('third-party packages may consequently be unavailable')
    expect(sync.behavior.probe).toContain('Before task approval')
    expect(sync.behavior.probe).toContain('real host-code execution')
    expect(sync.behavior.resources).toContain('Permit timeout/output caps can be stricter')
    expect(sync.behavior.risks).toContain('NOT a filesystem/network/native-extension security sandbox')
    expect(sync.behavior.output).toContain('before final one-shot permit consumption')
    expect(sync.execution.result).toContain('{job,stdout,stderr,provenance,artifacts}')
    expect(sync.execution.result).toContain('does not add top-level businessTaskVerified')
    expect(background.execution.result).toContain('submittedOnly:true')
    expect(background.execution.result).toContain('not interpreter initialization')
    expect(background.execution.lifetime).toContain('Only successful parent release')
    expect(sync.behavior.parity).toContain('not upstream python or stop_task aliases')
  })
  it('filters related current tools, separates Notebook read manuals from execution, and preserves helper/listing selectors', async () => {
    const { provider, setVisible } = setup([tool('python.execute'), tool('process.stop'), tool('info'), tool('foreign')])
    expect((await info(provider, { name: 'python.execute' })).documentation.relatedTools).toEqual(['process.stop', 'info'])
    setVisible([tool('python.background'), tool('python.execute'), tool('notebook.run'), tool('notebook.inspect')])
    expect((await info(provider, { name: 'python.execute' })).documentation.relatedTools).toEqual(['python.background'])
    expect(await info(provider, { name: 'notebook.run' })).toMatchObject({ ...tool('notebook.run'), grantsPermission: false, documentation: { contract: 'magicpot-local-notebook-run-manual/v1', name: 'notebook.run' } })
    expect(await info(provider, { name: 'notebook.inspect' })).toMatchObject({ ...tool('notebook.inspect'), grantsPermission: false, documentation: { contract: 'magicpot-local-notebook-read-manual/v1', name: 'notebook.inspect' } })
    expect(await info(provider, {})).toEqual({ tools: ['python.background', 'python.execute', 'notebook.run', 'notebook.inspect'].map(name => ({ name, description: `Current admitted ${name}` })), grantsPermission: false })
    expect(await info(provider, { kind: 'subagent' })).toEqual({ kind: 'subagent', subagents: [], grantsPermission: false })
    for (const name of names) await expect(info(provider, { name, kind: 'subagent' })).rejects.toThrow('not available')
    expect(describeThreadPython('notebook.run', [tool('notebook.run')])).toBeUndefined()
    expect(describeThreadPython('notebook.inspect', [tool('notebook.inspect')])).toBeUndefined()
    setVisible([])
    await expect(info(provider, { name: 'python.execute' })).rejects.toThrow('not available')
    expect(describeThreadPython('python.execute', [])).toBeUndefined()
  })
  it.each(['python.execute', 'python.background', 'python', 'PYTHON', 'python.execute ', '../python.execute', 'bash', 'shell.execute', 'shell.background', 'stop_task', 'notebook.run', 'ui:quiz', '__proto__', 'constructor', 'search_memory', 'scratchpad'])('never discloses an unadmitted name or fallback %s', async name => {
    const { provider, callbacks } = setup([])
    await expect(info(provider, { name })).rejects.toThrow('not available')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(describeThreadPython(name, [tool('foreign')])).toBeUndefined()
    if (!names.some(item => item === name)) expect(describeThreadPython(name, [tool(name)])).toBeUndefined()
  })
  it.each([{ kind: 'plugin', name: 'python.execute' }, { name: 'python.execute', paths: ['x.py'] }, { name: 'python.background', offset: 0 }, { name: 'python.execute', code: 'print(1)' }, { name: 'python.execute', approved: true }, { name: 'python.background', run_in_background: true }, { name: 'python.execute', interpreter: '/trusted/python' }, { name: 'python.execute', env: { SECRET: 'no' } }])('rejects execution/authority-like documentation arguments %#', async args => {
    const { provider, callbacks } = setup()
    await expect(info(provider, args)).rejects.toThrow()
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('does not mention disabled exact execution names in generic info description or default lists', async () => {
    const { provider } = setup([])
    const definition = provider.listTools().find(item => item.name === 'info')!
    for (const name of [...names, 'shell.execute', 'shell.background']) {
      expect(definition.description).not.toContain(name)
      await expect(info(provider, { name })).rejects.toThrow('not available')
    }
    expect(await info(provider, {})).toEqual({ tools: [], grantsPermission: false })
  })
  it('preserves existing family precedence and helper-only filtering', async () => {
    const { provider } = setup(['files.edit', 'ask_user', 'process.stop', 'shell.execute', 'fork', ...names].map(tool))
    expect((await info(provider, { name: 'files.edit' })).documentation.contract).toBe('magicpot-local-file-mutation-manual/v1')
    expect((await info(provider, { name: 'ask_user' })).documentation.contract).toBe('magicpot-local-interaction-manual/v1')
    expect((await info(provider, { name: 'process.stop' })).documentation.contract).toBe('magicpot-local-process-control-manual/v1')
    expect((await info(provider, { name: 'shell.execute' })).documentation.contract).toBe('magicpot-local-shell-execution-manual/v1')
    expect((await info(provider, { name: 'fork' })).kind).toBe('subagent')
    expect((await info(provider, { kind: 'subagent' })).subagents.map((item: { name: string }) => item.name)).toEqual(['fork'])
  })
  it('rechecks current route, cancellation and late admission without probing or calling an execution callback', async () => {
    const { provider, assertInvocation, listVisibleTools, callbacks } = setup()
    const abort = new AbortController(); abort.abort()
    await expect(provider.callTool('info', { name: 'python.execute' }, { ...context(), signal: abort.signal })).rejects.toThrow()
    await expect(provider.callTool('info', { name: 'python.execute' }, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(listVisibleTools).not.toHaveBeenCalled()
    const late = new AbortController()
    listVisibleTools.mockImplementation(() => { late.abort(); return names.map(tool) })
    await expect(provider.callTool('info', { name: 'python.background' }, { ...context(), signal: late.signal })).rejects.toThrow()
    listVisibleTools.mockImplementation(() => { assertInvocation.mockImplementation(() => { throw new Error('Owner ended') }); return names.map(tool) })
    await expect(info(provider, { name: 'python.execute' })).rejects.toThrow('Owner ended')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
})
