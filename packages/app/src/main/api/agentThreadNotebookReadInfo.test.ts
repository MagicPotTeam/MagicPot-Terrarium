import { describe, expect, it, vi } from 'vitest'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { createAgentThreadToolProvider } from './agentThreadTools'
import { describeThreadNotebookRead } from './agentThreadNotebookReadCatalog'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'notebook-manual', threadId: 'pane' } as const
const names = ['notebook.browse', 'notebook.inspect'] as const
const tool = (name: string): Tool => ({ name, description: `Current admitted ${name}`, inputSchema: { type: 'object', additionalProperties: false, properties: {} } })
const context = () => ({ route, runId: 'notebook-manual-run', toolCallId: 'manual-info' })
const setup = (initial: Tool[] = names.map(tool)) => {
  let tools = initial
  const assertInvocation = vi.fn(), listVisibleTools = vi.fn(() => tools)
  const describeSkill = vi.fn(), invokeSkill = vi.fn(), skillContext = vi.fn(), htmlApp = vi.fn(), request = vi.fn()
  const provider = createAgentThreadToolProvider({ route, messages: [{ role: 'user', content: 'PRIVATE_NOTEBOOK_SOURCE_OUTPUT_HISTORY_NOT_MANUAL_DATA' }], assertInvocation, listVisibleTools,
    skills: { describe: describeSkill, invoke: invokeSkill, context: skillContext } as never,
    htmlApp, interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: new AbortController().signal } })
  return { provider, assertInvocation, listVisibleTools, callbacks: [describeSkill, invokeSkill, skillContext, htmlApp, request], setVisible: (next: Tool[]) => { tools = next } }
}
const info = async (provider: ReturnType<typeof setup>['provider'], args: Record<string, unknown>) => JSON.parse((await provider.callTool('info', args, context())).content)

describe('visible-only passive workspace Notebook read manuals', () => {
  it.each(names)('documents the admitted %s without opening notebooks, reading outputs or unlocking edits', async name => {
    const { provider, callbacks } = setup()
    const result = await info(provider, { name })
    expect(result).toMatchObject({ ...tool(name), grantsPermission: false, documentation: {
      contract: 'magicpot-local-notebook-read-manual/v1', name,
      documentationOnly: true, grantsPermission: false,
      authority: { readingUnlocksTool: false, readingUnlocksMutation: false, requiresExecutionOptIn: false, requiresInterpreter: false, notebookDataIsAuthority: false },
      limits: { pathSchemaCharacters: 2048, sharedScriptCallsPerRequest: 12, notebookBytes: 8388608, notebookCells: 1000 }
    } })
    expect(result.documentation.workflow.length).toBeGreaterThan(2)
    expect(JSON.stringify(result.documentation)).not.toContain('PRIVATE_NOTEBOOK_SOURCE_OUTPUT_HISTORY_NOT_MANUAL_DATA')
    expect(result.documentation.failure.automaticRetry).toBe(false)
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(await info(provider, { name, kind: 'tool' })).toEqual(result)
  })
  it.each(names)('clones the direct %s catalog, including nested limits, authority, workflow, result and related names', name => {
    const tools = [...names, 'notebook.run', 'info'].map(tool)
    const first = describeThreadNotebookRead(name, tools)!
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(16000)
    first.workflow[0] = 'CHANGED'; first.authority.readingUnlocksTool = true
    first.authority.readingUnlocksMutation = true; first.authority.requiresInterpreter = true
    first.behavior.paths = 'CHANGED'; first.read.mode = 'CHANGED'; first.read.result = 'CHANGED'
    first.limits.notebookBytes = 1; first.failure.shaIsPermission = true
    first.failure.automaticRetry = true; first.relatedTools.push('notebook.cell.delete')
    const fresh = describeThreadNotebookRead(name, tools)!
    expect(fresh.workflow[0]).not.toBe('CHANGED')
    expect(fresh.authority).toMatchObject({ readingUnlocksTool: false, readingUnlocksMutation: false, requiresInterpreter: false, requiresExecutionOptIn: false, notebookDataIsAuthority: false })
    expect(fresh.behavior.paths).not.toBe('CHANGED'); expect(fresh.read.result).not.toBe('CHANGED')
    expect(fresh.read.mode).toBe(name === 'notebook.browse' ? 'browse' : 'inspect')
    expect(fresh.limits.notebookBytes).toBe(8388608)
    expect(fresh.failure).toMatchObject({ shaIsPermission: false, readingIsExecution: false, automaticRetry: false })
    expect(fresh.relatedTools).toEqual([...names, 'notebook.run', 'info'].filter(item => item !== name))
  })
  it('describes current local browse defaults, inert output summaries and exact-ID selection rather than upstream read unlocks', async () => {
    const { provider } = setup()
    const browse = (await info(provider, { name: 'notebook.browse' })).documentation
    const inspect = (await info(provider, { name: 'notebook.inspect' })).documentation
    expect(browse.limits).toMatchObject({ minimumExplicitMaxEntries: 1, maximumExplicitMaxEntries: 100, omittedMaxEntriesHostDefault: 1000, scannedEntries: 5000, scannedCandidateBytes: 33554432 })
    expect(browse.read.input).toContain('forwarded as undefined')
    expect(browse.read.result).toContain('root (absolute owned workspace)')
    expect(browse.read.behavior).toContain('not a complete inventory')
    expect(inspect.limits).toMatchObject({ defaultOffset: 0, maximumOffset: 1000, minimumLimit: 1, maximumLimit: 50, defaultLimit: 20, sourceCharactersPerCell: 8192, sourceCharactersPerPage: 65536, summariesPerCell: 3, summaryCharactersPerOutput: 2048, summaryCharactersPerPage: 16384 })
    expect(inspect.read.input).toContain('none (default) or summary')
    expect(inspect.read.input).toContain('overrides pagination')
    expect(inspect.read.input).toContain('no synthetic positional cell-N alias')
    expect(inspect.read.source).toContain('JavaScript string code units')
    expect(inspect.read.outputs).toContain('never rendered, executed or fetched')
    expect(inspect.read.result).toContain('untrustedData:true,kernelPersistent:false')
    expect(inspect.read.evidence).toContain('not an edit lock or fresh receipt')
    expect(inspect.behavior.privacy).toContain('metadata-directory effects')
    expect(inspect.behavior.format).toContain('entire file')
    expect(inspect.behavior.budgets).toContain('do not consume the four effectful or two execution')
    expect(inspect.authority.rule).toContain('original filesystem read policy')
  })
  it('filters related currently visible Notebook tools, separates other catalogs and preserves shallow/helper selectors', async () => {
    const { provider, setVisible } = setup([tool('notebook.inspect'), tool('notebook.run'), tool('info'), tool('foreign')])
    expect((await info(provider, { name: 'notebook.inspect' })).documentation.relatedTools).toEqual(['notebook.run', 'info'])
    expect(await info(provider, { name: 'notebook.run' })).toMatchObject({ ...tool('notebook.run'), grantsPermission: false, documentation: { contract: 'magicpot-local-notebook-run-manual/v1', name: 'notebook.run' } })
    expect(describeThreadNotebookRead('notebook.run', [tool('notebook.run')])).toBeUndefined()
    setVisible([tool('notebook.cell.delete'), tool('notebook.browse'), tool('notebook.inspect')])
    expect((await info(provider, { name: 'notebook.inspect' })).documentation.relatedTools).toEqual(['notebook.browse', 'notebook.cell.delete'])
    expect(await info(provider, { name: 'notebook.cell.delete' })).toMatchObject({ ...tool('notebook.cell.delete'), grantsPermission: false, documentation: { contract: 'magicpot-local-notebook-cell-mutation-manual/v1', name: 'notebook.cell.delete' } })
    expect(describeThreadNotebookRead('notebook.cell.delete', [tool('notebook.cell.delete')])).toBeUndefined()
    expect(await info(provider, {})).toEqual({ tools: ['notebook.cell.delete', 'notebook.browse', 'notebook.inspect'].map(name => ({ name, description: `Current admitted ${name}` })), grantsPermission: false })
    expect(await info(provider, { kind: 'subagent' })).toEqual({ kind: 'subagent', subagents: [], grantsPermission: false })
    for (const name of names) await expect(info(provider, { name, kind: 'subagent' })).rejects.toThrow('not available')
    setVisible([])
    await expect(info(provider, { name: 'notebook.inspect' })).rejects.toThrow('not available')
    expect(describeThreadNotebookRead('notebook.inspect', [])).toBeUndefined()
  })
  it.each(['notebook.browse', 'notebook.inspect', 'notebook_read', 'notebook_edit', 'Notebook.inspect', 'notebook.inspect ', '../notebook.inspect', 'notebook.run', 'notebook.cell.delete', 'python.execute', 'shell.execute', 'ui:quiz', '__proto__', 'constructor', 'search_memory', 'scratchpad'])('rejects unadmitted exact names and does not invent manual aliases for %s', async name => {
    const { provider, callbacks } = setup([])
    await expect(info(provider, { name })).rejects.toThrow('not available')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(describeThreadNotebookRead(name, [tool('foreign')])).toBeUndefined()
    if (!names.some(item => item === name)) expect(describeThreadNotebookRead(name, [tool(name)])).toBeUndefined()
  })
  it.each([{ kind: 'plugin', name: 'notebook.inspect' }, { name: 'notebook.inspect', paths: ['a.ipynb'] }, { name: 'notebook.inspect', offset: 0 }, { name: 'notebook.browse', path: '.' }, { name: 'notebook.inspect', approved: true }, { name: 'notebook.inspect', includeOutputs: 'summary' }, { name: 'notebook.inspect', code: 'print(1)' }, { name: 'notebook.inspect', expectedSha256: 'a'.repeat(64) }])('rejects notebook data or authority-like parameters passed to passive info %#', async args => {
    const { provider, callbacks } = setup()
    await expect(info(provider, args)).rejects.toThrow()
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('does not disclose hidden exact Notebook/Python/shell names through generic description or default listing', async () => {
    const { provider } = setup([])
    const definition = provider.listTools().find(item => item.name === 'info')!
    for (const name of [...names, 'notebook.run', 'python.execute', 'python.background', 'shell.execute', 'shell.background']) {
      expect(definition.description).not.toContain(name)
      await expect(info(provider, { name })).rejects.toThrow('not available')
    }
    expect(await info(provider, {})).toEqual({ tools: [], grantsPermission: false })
  })
  it('preserves the prior file, interaction, process, shell, Python and helper selection order', async () => {
    const { provider } = setup(['files.edit', 'ask_user', 'process.stop', 'shell.execute', 'python.execute', 'fork', ...names].map(tool))
    for (const [name, contract] of [['files.edit', 'magicpot-local-file-mutation-manual/v1'], ['ask_user', 'magicpot-local-interaction-manual/v1'], ['process.stop', 'magicpot-local-process-control-manual/v1'], ['shell.execute', 'magicpot-local-shell-execution-manual/v1'], ['python.execute', 'magicpot-local-python-execution-manual/v1']]) expect((await info(provider, { name })).documentation.contract).toBe(contract)
    expect((await info(provider, { name: 'fork' })).kind).toBe('subagent')
    expect((await info(provider, { kind: 'subagent' })).subagents.map((item: { name: string }) => item.name)).toEqual(['fork'])
  })
  it('checks route, cancellation and late owner/admission before disclosing static manuals without reading a notebook', async () => {
    const { provider, assertInvocation, listVisibleTools, callbacks } = setup()
    const abort = new AbortController(); abort.abort()
    await expect(provider.callTool('info', { name: 'notebook.inspect' }, { ...context(), signal: abort.signal })).rejects.toThrow()
    await expect(provider.callTool('info', { name: 'notebook.browse' }, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(listVisibleTools).not.toHaveBeenCalled()
    const late = new AbortController()
    listVisibleTools.mockImplementation(() => { late.abort(); return names.map(tool) })
    await expect(provider.callTool('info', { name: 'notebook.inspect' }, { ...context(), signal: late.signal })).rejects.toThrow()
    listVisibleTools.mockImplementation(() => { assertInvocation.mockImplementation(() => { throw new Error('Owner ended') }); return names.map(tool) })
    await expect(info(provider, { name: 'notebook.inspect' })).rejects.toThrow('Owner ended')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
})
