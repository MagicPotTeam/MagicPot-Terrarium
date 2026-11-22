import { describe, expect, it, vi } from 'vitest'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { createAgentThreadToolProvider } from './agentThreadTools'
import { describeThreadNotebookRun } from './agentThreadNotebookRunCatalog'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'notebook-run-manual', threadId: 'pane' } as const
const tool = (name: string): Tool => ({ name, description: `Current admitted ${name}`, inputSchema: { type: 'object', additionalProperties: false, properties: {} } })
const context = () => ({ route, runId: 'notebook-run-manual-run', toolCallId: 'manual-info' })
const setup = (initial: Tool[] = [tool('notebook.run')]) => {
  let tools = initial
  const assertInvocation = vi.fn(), listVisibleTools = vi.fn(() => tools)
  const describeSkill = vi.fn(), invokeSkill = vi.fn(), skillContext = vi.fn(), htmlApp = vi.fn(), request = vi.fn()
  const provider = createAgentThreadToolProvider({ route, messages: [{ role: 'user', content: 'PRIVATE_NOTEBOOK_RUN_SOURCE_OR_OUTPUT_NOT_MANUAL' }], assertInvocation, listVisibleTools,
    skills: { describe: describeSkill, invoke: invokeSkill, context: skillContext } as never,
    htmlApp, interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: new AbortController().signal } })
  return { provider, assertInvocation, listVisibleTools, callbacks: [describeSkill, invokeSkill, skillContext, htmlApp, request], setVisible: (next: Tool[]) => { tools = next } }
}
const info = async (provider: ReturnType<typeof setup>['provider'], args: Record<string, unknown>) => JSON.parse((await provider.callTool('info', args, context())).content)

describe('visible-only passive Notebook run manual', () => {
  it('describes the admitted stateless run without reading, probing, approving, writing or dispatching Python', async () => {
    const { provider, callbacks } = setup()
    const result = await info(provider, { name: 'notebook.run' })
    expect(result).toMatchObject({ ...tool('notebook.run'), grantsPermission: false, documentation: {
      contract: 'magicpot-local-notebook-run-manual/v1', name: 'notebook.run', documentationOnly: true, grantsPermission: false,
      authority: { readingUnlocksTool: false, requiresExecutionOptIn: true, requiresTrustedInterpreter: true, requiresFreshFormalApproval: true, receiptIsReplayAuthority: false },
      limits: { pathSchemaCharacters: 2048, sharedScriptCallsPerRequest: 12, sharedEffectfulCallsPerRequest: 4, sharedExecutionAttemptsPerRequest: 2, selectedCodeCells: 256, selectedJsonUtf8Bytes: 262144 },
      execution: { mode: 'stateless', kernelPersistent: false, variablesPersisted: false, automaticRetry: false }
    } })
    expect(result.documentation.workflow.length).toBeGreaterThan(2)
    expect(JSON.stringify(result.documentation)).not.toContain('PRIVATE_NOTEBOOK_RUN_SOURCE_OR_OUTPUT_NOT_MANUAL')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(await info(provider, { name: 'notebook.run', kind: 'tool' })).toEqual(result)
  })
  it('detaches every catalog field and related list from subsequent direct lookups', () => {
    const tools = [tool('notebook.run'), tool('notebook.inspect')]
    const first = describeThreadNotebookRun('notebook.run', tools)!
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(16000)
    first.authority.readingUnlocksTool = true; first.authority.requiresFreshFormalApproval = false
    first.authority.receiptIsReplayAuthority = true; first.limits.pathSchemaCharacters = 1
    first.workflow[0] = 'CHANGED'; first.behavior.selection = 'CHANGED'; first.behavior.persistence = 'CHANGED'
    first.execution.states[0] = 'CHANGED'; first.execution.apply = 'CHANGED'; first.execution.variablesPersisted = true
    first.failure.automaticRetry = true; first.failure.failureProvesNoMutation = true
    first.relatedTools.push('info')
    const fresh = describeThreadNotebookRun('notebook.run', tools)!
    expect(fresh.authority).toMatchObject({ readingUnlocksTool: false, requiresFreshFormalApproval: true, receiptIsReplayAuthority: false })
    expect(fresh.limits.pathSchemaCharacters).toBe(2048)
    expect(fresh.workflow[0]).not.toBe('CHANGED'); expect(fresh.behavior.selection).not.toBe('CHANGED')
    expect(fresh.behavior.persistence).not.toBe('CHANGED'); expect(fresh.execution.states[0]).toBe('starting')
    expect(fresh.execution.apply).not.toBe('CHANGED'); expect(fresh.execution.variablesPersisted).toBe(false)
    expect(fresh.failure).toMatchObject({ automaticRetry: false, cancellationRollsBack: false, failureProvesNoMutation: false })
    expect(fresh.relatedTools).toEqual(['notebook.inspect'])
  })
  it('documents actual source-order/JSON bounds, preapproval effects, returned old CAS and post-rename uncertainty', async () => {
    const { provider } = setup(), doc = (await info(provider, { name: 'notebook.run' })).documentation
    expect(doc.behavior.selection).toContain('notebook file order')
    expect(doc.behavior.selection).toContain('after formal approval')
    expect(doc.behavior.selection).toContain('including IDs, escaping and JSON overhead')
    expect(doc.workflow[2]).toContain('before task approval or notebook SHA/generation checks')
    expect(doc.workflow[3]).toContain('payload/wrapper/starting-manifest/audit persistence')
    expect(doc.behavior.process).toContain('Selected cells share one globals dictionary')
    expect(doc.behavior.process).toContain('variables do not persist across runs')
    expect(doc.behavior.output).toContain('tighter command-log bound')
    expect(doc.behavior.output).toContain('Partial successful cells are not saved')
    expect(doc.execution.apply).toContain('old dispatch generation')
    expect(doc.execution.apply).toContain('NOT the updated notebook')
    expect(doc.execution.terminal).toContain('Error content can fulfill the tool call')
    expect(doc.failure.rule).toContain('failure after target rename can leave saved outputs/generation changed')
    expect(doc.failure.rule).toContain('do not promise continuous settings polling')
    expect(doc.execution.states).toEqual(['starting', 'running', 'completed-applied', 'completed-not-applied', 'failed', 'interrupted', 'crashed'])
    expect(doc.execution.result).toContain('mutation/writeStatus/businessTaskVerified/grantsPermission/untrustedData')
    expect(doc.behavior.parity).toContain('not a named upstream notebook_run contract')
    expect(doc.behavior.displays).toContain('SVG/HTML/JavaScript')
    expect(doc.behavior.displays).toContain('No declared-artifact/export capability')
  })
  it('filters related current names and keeps read/mutation/Python/manual/helper/listing families separate', async () => {
    const { provider, setVisible } = setup([tool('notebook.run'), tool('notebook.inspect'), tool('info'), tool('foreign')])
    expect((await info(provider, { name: 'notebook.run' })).documentation.relatedTools).toEqual(['notebook.inspect', 'info'])
    setVisible([tool('notebook.run'), tool('notebook.cell.delete'), tool('python.execute'), tool('foreign')])
    expect((await info(provider, { name: 'notebook.run' })).documentation.relatedTools).toEqual(['notebook.cell.delete'])
    expect((await info(provider, { name: 'notebook.cell.delete' })).documentation.contract).toBe('magicpot-local-notebook-cell-mutation-manual/v1')
    expect((await info(provider, { name: 'python.execute' })).documentation.contract).toBe('magicpot-local-python-execution-manual/v1')
    expect(await info(provider, {})).toEqual({ tools: ['notebook.run', 'notebook.cell.delete', 'python.execute', 'foreign'].map(name => ({ name, description: `Current admitted ${name}` })), grantsPermission: false })
    expect(await info(provider, { kind: 'subagent' })).toEqual({ kind: 'subagent', subagents: [], grantsPermission: false })
    await expect(info(provider, { name: 'notebook.run', kind: 'subagent' })).rejects.toThrow('not available')
    setVisible([])
    await expect(info(provider, { name: 'notebook.run' })).rejects.toThrow('not available')
    expect(describeThreadNotebookRun('notebook.run', [])).toBeUndefined()
  })
  it.each(['notebook.run', 'notebook_run', 'notebook_read', 'notebook_edit', 'Notebook.run', 'notebook.run ', '../notebook.run', 'notebook.execute-all', 'notebook.interrupt', 'notebook.restart', 'notebook.inspect', 'notebook.cell.delete', 'python.execute', 'shell.execute', 'stop_task', '__proto__', 'constructor', 'ui:quiz', 'search_memory', 'scratchpad'])('requires current exact admission and never creates a run-manual alias for %s', async name => {
    const { provider, callbacks } = setup([])
    await expect(info(provider, { name })).rejects.toThrow('not available')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(describeThreadNotebookRun(name, [tool('foreign')])).toBeUndefined()
    if (name !== 'notebook.run') expect(describeThreadNotebookRun(name, [tool(name)])).toBeUndefined()
  })
  it.each([{ name: 'notebook.run', kind: 'plugin' }, { name: 'notebook.run', paths: ['a.ipynb'] }, { name: 'notebook.run', offset: 0 }, { name: 'notebook.run', path: 'a.ipynb' }, { name: 'notebook.run', approved: true }, { name: 'notebook.run', expectedSha256: 'a'.repeat(64) }, { name: 'notebook.run', expectedGeneration: 0 }, { name: 'notebook.run', code: 'print(1)' }, { name: 'notebook.run', cellIds: ['c1'] }, { name: 'notebook.run', run_in_background: true }, { name: 'notebook.run', executionId: 'earlier' }])('rejects execution/authority-like extras in info %#', async args => {
    const { provider, callbacks } = setup()
    await expect(info(provider, args)).rejects.toThrow()
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('keeps disabled exact execution/read/mutation names out of generic descriptions and shallow lists', async () => {
    const { provider } = setup([]), definition = provider.listTools().find(item => item.name === 'info')!
    for (const name of ['notebook.run', 'notebook.inspect', 'notebook.browse', 'notebook.cell.delete', 'python.execute', 'python.background', 'shell.execute', 'shell.background']) {
      expect(definition.description).not.toContain(name)
      await expect(info(provider, { name })).rejects.toThrow('not available')
    }
    expect(await info(provider, {})).toEqual({ tools: [], grantsPermission: false })
  })
  it('leaves file/interaction/process/shell/Python/read/cell/helper selection precedence unchanged', async () => {
    const { provider } = setup(['files.edit', 'ask_user', 'process.stop', 'shell.execute', 'python.execute', 'notebook.inspect', 'notebook.cell.delete', 'fork', 'notebook.run'].map(tool))
    for (const [name, contract] of [['files.edit', 'magicpot-local-file-mutation-manual/v1'], ['ask_user', 'magicpot-local-interaction-manual/v1'], ['process.stop', 'magicpot-local-process-control-manual/v1'], ['shell.execute', 'magicpot-local-shell-execution-manual/v1'], ['python.execute', 'magicpot-local-python-execution-manual/v1'], ['notebook.inspect', 'magicpot-local-notebook-read-manual/v1'], ['notebook.cell.delete', 'magicpot-local-notebook-cell-mutation-manual/v1']]) expect((await info(provider, { name })).documentation.contract).toBe(contract)
    expect((await info(provider, { name: 'fork' })).kind).toBe('subagent')
    expect((await info(provider, { kind: 'subagent' })).subagents.map((item: { name: string }) => item.name)).toEqual(['fork'])
  })
  it('checks route/cancellation and late ownership without any execution/helper/approval callback', async () => {
    const { provider, assertInvocation, listVisibleTools, callbacks } = setup()
    const abort = new AbortController(); abort.abort()
    await expect(provider.callTool('info', { name: 'notebook.run' }, { ...context(), signal: abort.signal })).rejects.toThrow()
    await expect(provider.callTool('info', { name: 'notebook.run' }, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(listVisibleTools).not.toHaveBeenCalled()
    const late = new AbortController()
    listVisibleTools.mockImplementation(() => { late.abort(); return [tool('notebook.run')] })
    await expect(provider.callTool('info', { name: 'notebook.run' }, { ...context(), signal: late.signal })).rejects.toThrow()
    listVisibleTools.mockImplementation(() => { assertInvocation.mockImplementation(() => { throw new Error('Owner ended') }); return [tool('notebook.run')] })
    await expect(info(provider, { name: 'notebook.run' })).rejects.toThrow('Owner ended')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
})
