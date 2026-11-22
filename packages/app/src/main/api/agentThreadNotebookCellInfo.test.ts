import { describe, expect, it, vi } from 'vitest'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { createAgentThreadToolProvider } from './agentThreadTools'
import { describeThreadNotebookCellMutation } from './agentThreadNotebookCellCatalog'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'notebook-cell-manual', threadId: 'pane' } as const
const names = ['notebook.cell.insert', 'notebook.cell.replace', 'notebook.cell.delete', 'notebook.cell.convert', 'notebook.cell.clear-outputs'] as const
const tool = (name: string): Tool => ({ name, description: `Current admitted ${name}`, inputSchema: { type: 'object', additionalProperties: false, properties: {} } })
const context = () => ({ route, runId: 'notebook-cell-manual-run', toolCallId: 'manual-info' })
const setup = (initial: Tool[] = names.map(tool)) => {
  let tools = initial
  const assertInvocation = vi.fn(), listVisibleTools = vi.fn(() => tools)
  const describeSkill = vi.fn(), invokeSkill = vi.fn(), skillContext = vi.fn(), htmlApp = vi.fn(), request = vi.fn()
  const provider = createAgentThreadToolProvider({ route, messages: [{ role: 'user', content: 'PRIVATE_NOTEBOOK_MUTATION_SOURCE_HISTORY_NOT_MANUAL' }], assertInvocation, listVisibleTools,
    skills: { describe: describeSkill, invoke: invokeSkill, context: skillContext } as never,
    htmlApp, interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: new AbortController().signal } })
  return { provider, assertInvocation, listVisibleTools, callbacks: [describeSkill, invokeSkill, skillContext, htmlApp, request], setVisible: (next: Tool[]) => { tools = next } }
}
const info = async (provider: ReturnType<typeof setup>['provider'], args: Record<string, unknown>) => JSON.parse((await provider.callTool('info', args, context())).content)

describe('visible-only passive Notebook cell-mutation manuals', () => {
  it.each(names)('documents the admitted %s without opening, approving, writing or executing a notebook', async name => {
    const { provider, callbacks } = setup()
    const result = await info(provider, { name })
    expect(result).toMatchObject({ ...tool(name), grantsPermission: false, documentation: {
      contract: 'magicpot-local-notebook-cell-mutation-manual/v1', name,
      documentationOnly: true, grantsPermission: false,
      authority: { readingUnlocksTool: false, requiresMutationOptIn: true, requiresInterpreter: false, requiresFreshFormalApproval: true, shaIsPermission: false },
      limits: { pathSchemaCharacters: 2048, sharedScriptCallsPerRequest: 12, sharedEffectfulCallsPerRequest: 4, notebookBytes: 8388608, notebookCells: 1000 }
    } })
    expect(result.documentation.workflow.length).toBeGreaterThan(2)
    expect(JSON.stringify(result.documentation)).not.toContain('PRIVATE_NOTEBOOK_MUTATION_SOURCE_HISTORY_NOT_MANUAL')
    expect(result.documentation.failure.automaticRetry).toBe(false)
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(await info(provider, { name, kind: 'tool' })).toEqual(result)
  })
  it.each(names)('clones every direct catalog field for %s without widening or reusing related names', name => {
    const tools = [tool(name), tool('notebook.inspect'), tool('info')]
    const first = describeThreadNotebookCellMutation(name, tools)!
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(16000)
    first.workflow[0] = 'CHANGED'; first.authority.readingUnlocksTool = true
    first.authority.requiresFreshFormalApproval = false; first.authority.shaIsPermission = true
    first.limits.pathSchemaCharacters = 1; first.mutation.operation = 'CHANGED'
    first.mutation.input = 'CHANGED'; first.mutation.effect = 'CHANGED'
    first.behavior.commit = 'CHANGED'; first.behavior.result = 'CHANGED'
    first.failure.automaticRetry = true; first.failure.failureProvesNoMutation = true
    first.relatedTools.push('notebook.run')
    const fresh = describeThreadNotebookCellMutation(name, tools)!
    expect(fresh.workflow[0]).not.toBe('CHANGED')
    expect(fresh.authority).toMatchObject({ readingUnlocksTool: false, requiresFreshFormalApproval: true, shaIsPermission: false, requiresInterpreter: false })
    expect(fresh.limits.pathSchemaCharacters).toBe(2048)
    expect(fresh.mutation.operation).toBe(name.slice('notebook.cell.'.length))
    expect(fresh.mutation.input).not.toBe('CHANGED'); expect(fresh.mutation.effect).not.toBe('CHANGED')
    expect(fresh.behavior.commit).not.toBe('CHANGED'); expect(fresh.behavior.result).not.toBe('CHANGED')
    expect(fresh.failure).toMatchObject({ automaticRetry: false, failureProvesNoMutation: false, cancellationRollsBack: false })
    expect(fresh.relatedTools).toEqual(['notebook.inspect', 'info'])
  })
  it('describes actual per-operation semantics, approval/storage order and ambiguous failure without inventing result fields', async () => {
    const { provider } = setup()
    const docs = await Promise.all(names.map(async name => (await info(provider, { name })).documentation))
    const [insert, replace, deletion, convert, clear] = docs
    expect(insert.mutation.input).toContain('before/after requires an exact referenceCellId')
    expect(insert.mutation.input).toContain('generates a16-hex-character ID')
    expect(replace.mutation.input).toContain('forces clearOutputs:true')
    expect(replace.mutation.effect).toContain('even if source/type was logically unchanged')
    expect(deletion.mutation.effect).toContain('rather than deleting the found subset')
    expect(convert.mutation.effect).toContain('including code→code')
    expect(clear.mutation.effect).toContain('selected noncode cells have no logical change')
    expect(clear.behavior.commit).toContain('even a logical no-op can change bytes')
    expect(clear.behavior.backup).toContain('after permit consumption')
    expect(clear.workflow[2]).toContain('before approval')
    expect(clear.failure.rule).toContain('rename may already have replaced bytes')
    expect(clear.behavior.result).toContain('No top-level state/status/writeStatus/mutation/businessTaskVerified/untrustedData')
    for (const doc of docs) {
      expect(doc.limits).toMatchObject({ pathSchemaCharacters: 2048, sourceSchemaCharacters: 262144, sourceHostUtf8BytesPerCell: 1048576, maximumCellIds: 256 })
      expect(doc.authority.rule).toContain('fresh exact one-use formal approval')
      expect(doc.behavior.parity).toContain('not notebook_edit aliases')
      expect(doc.behavior.budgets).toContain('do not consume the two execution attempts')
      expect(doc.behavior.paths).toContain('existing single-link regular .ipynb')
      expect(doc.behavior.commit).toContain('no ordered edits array')
    }
  })
  it('uses only currently visible related names, separate read/run families and existing listing/helper selectors', async () => {
    const { provider, setVisible } = setup([tool('notebook.cell.replace'), tool('notebook.inspect'), tool('foreign')])
    expect((await info(provider, { name: 'notebook.cell.replace' })).documentation.relatedTools).toEqual(['notebook.inspect'])
    setVisible([tool('notebook.cell.delete'), tool('notebook.cell.replace'), tool('notebook.run'), tool('notebook.inspect'), tool('info')])
    expect((await info(provider, { name: 'notebook.cell.replace' })).documentation.relatedTools).toEqual(['notebook.inspect', 'notebook.cell.delete', 'notebook.run', 'info'])
    expect((await info(provider, { name: 'notebook.inspect' })).documentation.contract).toBe('magicpot-local-notebook-read-manual/v1')
    expect(await info(provider, { name: 'notebook.run' })).toMatchObject({ ...tool('notebook.run'), grantsPermission: false, documentation: { contract: 'magicpot-local-notebook-run-manual/v1', name: 'notebook.run' } })
    expect(describeThreadNotebookCellMutation('notebook.inspect', [tool('notebook.inspect')])).toBeUndefined()
    expect(describeThreadNotebookCellMutation('notebook.run', [tool('notebook.run')])).toBeUndefined()
    expect(await info(provider, {})).toEqual({ tools: ['notebook.cell.delete', 'notebook.cell.replace', 'notebook.run', 'notebook.inspect', 'info'].map(name => ({ name, description: `Current admitted ${name}` })), grantsPermission: false })
    expect(await info(provider, { kind: 'subagent' })).toEqual({ kind: 'subagent', subagents: [], grantsPermission: false })
    for (const name of names) await expect(info(provider, { name, kind: 'subagent' })).rejects.toThrow('not available')
    setVisible([])
    await expect(info(provider, { name: 'notebook.cell.replace' })).rejects.toThrow('not available')
    expect(describeThreadNotebookCellMutation('notebook.cell.replace', [])).toBeUndefined()
  })
  it.each([...names, 'notebook_edit', 'notebook_read', 'notebook.cell.Replace', 'notebook.cell.replace ', '../notebook.cell.replace', 'notebook.run', 'notebook.inspect', 'python.execute', 'shell.execute', '__proto__', 'constructor', 'ui:quiz', 'search_memory', 'scratchpad'])('requires current exact admission and does not invent a mutation manual for %s', async name => {
    const { provider, callbacks } = setup([])
    await expect(info(provider, { name })).rejects.toThrow('not available')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(describeThreadNotebookCellMutation(name, [tool('foreign')])).toBeUndefined()
    if (!names.some(item => item === name)) expect(describeThreadNotebookCellMutation(name, [tool(name)])).toBeUndefined()
  })
  it.each([{ kind: 'plugin', name: 'notebook.cell.replace' }, { name: 'notebook.cell.replace', paths: ['a.ipynb'] }, { name: 'notebook.cell.replace', path: 'a.ipynb' }, { name: 'notebook.cell.replace', approved: true }, { name: 'notebook.cell.replace', expectedSha256: 'a'.repeat(64) }, { name: 'notebook.cell.replace', source: 'print(1)' }, { name: 'notebook.cell.replace', clearOutputs: false }, { name: 'notebook.cell.replace', edits: [] }, { name: 'notebook.cell.replace', strict: false }])('rejects write data and authority-like extras in passive info %#', async args => {
    const { provider, callbacks } = setup()
    await expect(info(provider, args)).rejects.toThrow()
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('keeps disabled exact mutation/Python/shell names out of generic discovery', async () => {
    const { provider } = setup([]), definition = provider.listTools().find(item => item.name === 'info')!
    for (const name of [...names, 'notebook.run', 'python.execute', 'python.background', 'shell.execute', 'shell.background']) {
      expect(definition.description).not.toContain(name)
      await expect(info(provider, { name })).rejects.toThrow('not available')
    }
    expect(await info(provider, {})).toEqual({ tools: [], grantsPermission: false })
  })
  it('preserves file, interaction, process, shell, Python, read and helper manuals before the mutation fallback', async () => {
    const { provider } = setup(['files.edit', 'ask_user', 'process.stop', 'shell.execute', 'python.execute', 'notebook.inspect', 'fork', ...names].map(tool))
    for (const [name, contract] of [['files.edit', 'magicpot-local-file-mutation-manual/v1'], ['ask_user', 'magicpot-local-interaction-manual/v1'], ['process.stop', 'magicpot-local-process-control-manual/v1'], ['shell.execute', 'magicpot-local-shell-execution-manual/v1'], ['python.execute', 'magicpot-local-python-execution-manual/v1'], ['notebook.inspect', 'magicpot-local-notebook-read-manual/v1']]) expect((await info(provider, { name })).documentation.contract).toBe(contract)
    expect((await info(provider, { name: 'fork' })).kind).toBe('subagent')
    expect((await info(provider, { kind: 'subagent' })).subagents.map((item: { name: string }) => item.name)).toEqual(['fork'])
  })
  it('checks route, cancellation and late ownership before returning even a static mutation manual', async () => {
    const { provider, assertInvocation, listVisibleTools, callbacks } = setup()
    const abort = new AbortController(); abort.abort()
    await expect(provider.callTool('info', { name: 'notebook.cell.replace' }, { ...context(), signal: abort.signal })).rejects.toThrow()
    await expect(provider.callTool('info', { name: 'notebook.cell.replace' }, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(listVisibleTools).not.toHaveBeenCalled()
    const late = new AbortController()
    listVisibleTools.mockImplementation(() => { late.abort(); return names.map(tool) })
    await expect(provider.callTool('info', { name: 'notebook.cell.replace' }, { ...context(), signal: late.signal })).rejects.toThrow()
    listVisibleTools.mockImplementation(() => { assertInvocation.mockImplementation(() => { throw new Error('Owner ended') }); return names.map(tool) })
    await expect(info(provider, { name: 'notebook.cell.replace' })).rejects.toThrow('Owner ended')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
})
