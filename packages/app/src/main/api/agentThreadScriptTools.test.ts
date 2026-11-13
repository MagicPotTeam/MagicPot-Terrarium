import { describe, expect, it, vi } from 'vitest'
import { createAgentThreadScriptTools } from './agentThreadScriptTools'
import { createAgentThreadToolProvider } from './agentThreadTools'
import { threadNotebookNamespace } from './agentThreadScriptSchemas'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
function setup(enabled = true) {
  const parent = new AbortController()
  const execute = vi.fn(async (_input: import('./agentThreadScriptTools').ThreadScriptInvocation) => ({ state: 'completed', stdout: 'ok' }))
  const assertInvocation = vi.fn(), assertLive = vi.fn()
  const settings = { enabled }
  const provider = createAgentThreadScriptTools({ route, conversationId: 'chat', signal: parent.signal, enabled: () => settings.enabled, assertInvocation, assertLive, execute })
  const context = { route, runId: 'run', workspaceRootDir: 'D:/main-owned/workspace' }
  return { parent, execute, assertInvocation, assertLive, settings, provider, context }
}
describe('thread script tools', () => {
  it('binds the run manual to actual schema bounds without consuming or expanding the shared execution budget', async () => {
    const t = setup(), request = vi.fn()
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: t.assertInvocation, listVisibleTools: () => t.provider.listTools(), interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: t.parent.signal } })
    for (let i = 0; i < 4; i++) {
      const result = JSON.parse((await info.callTool('info', { name: 'notebook.run' }, t.context)).content)
      expect(result.inputSchema).toEqual(t.provider.listTools().find(tool => tool.name === 'notebook.run')!.inputSchema)
      const properties = result.inputSchema.properties, limits = result.documentation.limits
      expect(result.inputSchema.required).toEqual(['path', 'expectedSha256', 'expectedGeneration'])
      expect(properties.path).toMatchObject({ minLength: 1, maxLength: 2048 })
      expect(properties.expectedSha256).toEqual({ type: 'string', pattern: '^[a-f0-9]{64}$' })
      expect(properties.expectedGeneration).toEqual({ type: 'integer', minimum: 0 })
      expect(properties.cellIds).toMatchObject({ minItems: 1, maxItems: 256, uniqueItems: true, items: { pattern: '^[A-Za-z0-9_-]{1,64}$' } })
      expect(limits.pathSchemaCharacters).toBe(properties.path.maxLength)
      expect(limits.selectedCodeCells).toBe(properties.cellIds.maxItems)
      expect(properties.timeoutMs).toEqual({ type: 'integer', minimum: 1, maximum: 120000 })
      expect(properties.maxOutputBytes).toEqual({ type: 'integer', minimum: 1, maximum: 262144 })
      expect(limits).toMatchObject({ timeoutMsMinimum: properties.timeoutMs.minimum, timeoutMsMaximum: properties.timeoutMs.maximum, maxOutputBytesMinimum: properties.maxOutputBytes.minimum, maxOutputBytesMaximum: properties.maxOutputBytes.maximum, timeoutMsDefault: 30000, maxOutputBytesDefault: 65536, selectedJsonUtf8Bytes: 262144, sharedScriptCallsPerRequest: 12, sharedEffectfulCallsPerRequest: 4, sharedExecutionAttemptsPerRequest: 2 })
      expect(result.documentation.authority).toMatchObject({ readingUnlocksTool: false, requiresFreshFormalApproval: true, requiresTrustedInterpreter: true, requiresExecutionOptIn: true })
    }
    expect(t.execute).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    const base = { path: 'a.ipynb', expectedSha256: 'a'.repeat(64), expectedGeneration: 0 }
    for (const args of [{ path: 'a.ipynb', expectedSha256: 'a'.repeat(64) }, { ...base, expectedGeneration: -1 }, { ...base, expectedGeneration: 0.5 }, { ...base, expectedSha256: 'A'.repeat(64) }, { ...base, path: 'x'.repeat(2049) }, { ...base, cellIds: [] }, { ...base, cellIds: ['c1', 'c1'] }, { ...base, cellIds: Array.from({ length: 257 }, (_, i) => `c${i}`) }, { ...base, timeoutMs: 0 }, { ...base, timeoutMs: 120001 }, { ...base, maxOutputBytes: 262145 }, { ...base, code: 'pass' }, { ...base, approved: true }, { ...base, artifacts: ['out.json'] }, { ...base, run_in_background: true }, { ...base, timeout_s: 1 }]) await expect(t.provider.callTool('notebook.run', args, t.context)).rejects.toThrow('Invalid bounded')
    expect(t.execute).not.toHaveBeenCalled()
    await t.provider.callTool('notebook.run', { ...base, cellIds: Array.from({ length: 256 }, (_, i) => `c${i}`), timeoutMs: 1, maxOutputBytes: 1 }, t.context)
    await t.provider.callTool('python.execute', { code: 'pass', timeoutMs: 120000, maxOutputBytes: 262144 }, t.context)
    expect(t.execute).toHaveBeenCalledTimes(2)
    await expect(t.provider.callTool('notebook.run', base, t.context)).rejects.toThrow('budget')
    expect(t.execute).toHaveBeenCalledTimes(2); expect(request).not.toHaveBeenCalled()
  })
  it('does not unlock initially hidden or now-disabled runs or refund a host-failed execution after info', async () => {
    const hidden = setup(false)
    const hiddenInfo = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => hidden.provider.listTools() })
    const args = { path: 'a.ipynb', expectedSha256: 'a'.repeat(64), expectedGeneration: 0 }
    for (const enabled of [false, true]) {
      hidden.settings.enabled = enabled
      await expect(hiddenInfo.callTool('info', { name: 'notebook.run' }, hidden.context)).rejects.toThrow('not available')
    }
    await expect(hidden.provider.callTool('notebook.run', args, hidden.context)).rejects.toThrow('outside')
    expect(hidden.execute).not.toHaveBeenCalled()
    const current = setup(), info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => current.provider.listTools() })
    await info.callTool('info', { name: 'notebook.run' }, current.context)
    current.settings.enabled = false
    await expect(current.provider.callTool('notebook.run', args, current.context)).rejects.toThrow('disabled')
    expect(current.execute).not.toHaveBeenCalled()
    const failed = setup(), failedInfo = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => failed.provider.listTools() })
    await failedInfo.callTool('info', { name: 'notebook.run' }, failed.context)
    failed.execute.mockRejectedValueOnce(Error('fresh formal approval denied'))
    await expect(failed.provider.callTool('notebook.run', args, failed.context)).rejects.toThrow('formal approval denied')
    await failed.provider.callTool('notebook.run', args, failed.context)
    await expect(failed.provider.callTool('python.execute', { code: 'pass' }, failed.context)).rejects.toThrow('budget')
    expect(failed.execute).toHaveBeenCalledTimes(2)
  })
  it('preserves the original total/effectful budgets after run-manual reads and a late rejected apply', async () => {
    const t = setup(), info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => t.provider.listTools() })
    for (let i = 0; i < 3; i++) await info.callTool('info', { name: 'notebook.run' }, t.context)
    const run = { path: 'a.ipynb', expectedSha256: 'a'.repeat(64), expectedGeneration: 0 }
    await t.provider.callTool('notebook.run', run, t.context)
    for (let i = 0; i < 3; i++) await t.provider.callTool('notebook.cell.clear-outputs', { path: 'a.ipynb', expectedSha256: 'a'.repeat(64), cellIds: ['c1'] }, t.context)
    for (let i = 0; i < 8; i++) await t.provider.callTool('notebook.browse', {}, t.context)
    expect(t.execute).toHaveBeenCalledTimes(12)
    await expect(t.provider.callTool('notebook.browse', {}, t.context)).rejects.toThrow('budget')
    const effect = setup(), effectInfo = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => effect.provider.listTools() })
    await effectInfo.callTool('info', { name: 'notebook.run' }, effect.context)
    await effect.provider.callTool('notebook.run', run, effect.context)
    for (let i = 0; i < 3; i++) await effect.provider.callTool('notebook.cell.clear-outputs', { path: 'a.ipynb', expectedSha256: 'a'.repeat(64), cellIds: ['c1'] }, effect.context)
    await expect(effect.provider.callTool('notebook.run', run, effect.context)).rejects.toThrow('budget')
    expect(effect.execute).toHaveBeenCalledTimes(4)
    const late = setup(), lateInfo = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => late.provider.listTools() })
    await lateInfo.callTool('info', { name: 'notebook.run' }, late.context)
    late.execute.mockImplementationOnce(async () => { late.parent.abort(Error('owner gone after apply')); return { state: 'completed-applied', stdout: 'DISCARD_APPLIED_RECEIPT' } })
    await expect(late.provider.callTool('notebook.run', run, late.context)).rejects.toThrow('owner gone after apply')
    expect(late.execute).toHaveBeenCalledOnce()
  })
  it('binds all five cell manuals to actual path/source/ID schemas without spending or expanding the shared effectful budget', async () => {
    const t = setup(), request = vi.fn()
    const names = ['notebook.cell.insert', 'notebook.cell.replace', 'notebook.cell.delete', 'notebook.cell.convert', 'notebook.cell.clear-outputs']
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: t.assertInvocation, listVisibleTools: () => t.provider.listTools(), interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: t.parent.signal } })
    for (let i = 0; i < 3; i++) for (const name of names) {
      const result = JSON.parse((await info.callTool('info', { name }, t.context)).content)
      expect(result.inputSchema).toEqual(t.provider.listTools().find(tool => tool.name === name)!.inputSchema)
      expect(result.inputSchema.properties.path).toMatchObject({ minLength: 1, maxLength: 2048 })
      expect(result.documentation.limits.pathSchemaCharacters).toBe(result.inputSchema.properties.path.maxLength)
      expect(result.documentation.authority).toMatchObject({ readingUnlocksTool: false, requiresFreshFormalApproval: true, requiresInterpreter: false, requiresMutationOptIn: true })
      if (name === 'notebook.cell.insert' || name === 'notebook.cell.replace') {
        const source = name.endsWith('insert') ? result.inputSchema.properties.cell.properties.source : result.inputSchema.properties.source
        expect(source).toMatchObject({ type: 'string', maxLength: 262144 })
        expect(result.documentation.limits.sourceSchemaCharacters).toBe(source.maxLength)
      } else {
        expect(result.inputSchema.properties.cellIds).toMatchObject({ minItems: 1, maxItems: 256, uniqueItems: true })
        expect(result.documentation.limits.maximumCellIds).toBe(result.inputSchema.properties.cellIds.maxItems)
      }
    }
    expect(t.execute).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    const base = { path: 'a.ipynb', expectedSha256: 'a'.repeat(64) }
    for (const [name, args] of [
      ['notebook.cell.insert', { ...base, cell: { cellType: 'code', source: 'x', metadata: {} }, position: 'end' }],
      ['notebook.cell.insert', { ...base, cell: { cellType: 'code', source: ['x'] }, position: 'end' }],
      ['notebook.cell.insert', { ...base, cell: { cellType: 'code', source: 'x' } }],
      ['notebook.cell.replace', { ...base, cellId: 'code1', source: 'x', clearOutputs: false }],
      ['notebook.cell.replace', { ...base, cellId: 'code1' }],
      ['notebook.cell.replace', { ...base, cellId: 'code1', source: 'x'.repeat(262145) }],
      ['notebook.cell.delete', { ...base, cellIds: ['code1', 'code1'] }],
      ['notebook.cell.convert', { ...base, cellIds: [], cellType: 'raw' }],
      ['notebook.cell.clear-outputs', { ...base, cellIds: Array.from({ length: 257 }, (_, i) => `cell${i}`) }],
      ['notebook.cell.clear-outputs', { ...base, cellIds: ['code1'], approved: true }]
    ] as Array<[string, Record<string, unknown>]>) await expect(t.provider.callTool(name, args, t.context)).rejects.toThrow('Invalid bounded')
    expect(t.execute).not.toHaveBeenCalled()
    await t.provider.callTool('notebook.cell.insert', { ...base, cell: { cellType: 'raw', source: '' }, position: 'end' }, t.context)
    await t.provider.callTool('notebook.cell.replace', { ...base, cellId: 'code1', source: 'x'.repeat(262144) }, t.context)
    await t.provider.callTool('notebook.cell.delete', { ...base, cellIds: Array.from({ length: 256 }, (_, i) => `cell${i}`) }, t.context)
    await t.provider.callTool('notebook.cell.convert', { ...base, cellIds: ['code1'], cellType: 'code' }, t.context)
    expect(t.execute).toHaveBeenCalledTimes(4)
    await expect(t.provider.callTool('notebook.cell.clear-outputs', { ...base, cellIds: ['code1'] }, t.context)).rejects.toThrow('budget')
    expect(t.execute).toHaveBeenCalledTimes(4); expect(request).not.toHaveBeenCalled()
  })
  it('does not unlock cell mutations that were initially hidden or currently revoked by settings', async () => {
    const hidden = setup(false)
    const infoHidden = createAgentThreadToolProvider({ route, messages: [], assertInvocation: hidden.assertInvocation, listVisibleTools: () => hidden.provider.listTools() })
    const args = { path: 'a.ipynb', expectedSha256: 'a'.repeat(64), cellIds: ['code1'] }
    await expect(infoHidden.callTool('info', { name: 'notebook.cell.delete' }, hidden.context)).rejects.toThrow('not available')
    hidden.settings.enabled = true
    await expect(infoHidden.callTool('info', { name: 'notebook.cell.delete' }, hidden.context)).rejects.toThrow('not available')
    await expect(hidden.provider.callTool('notebook.cell.delete', args, hidden.context)).rejects.toThrow('outside')
    expect(hidden.execute).not.toHaveBeenCalled()
    const current = setup()
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: current.assertInvocation, listVisibleTools: () => current.provider.listTools() })
    expect(JSON.parse((await info.callTool('info', { name: 'notebook.cell.delete' }, current.context)).content).documentation.authority.requiresMutationOptIn).toBe(true)
    current.settings.enabled = false
    await expect(current.provider.callTool('notebook.cell.delete', args, current.context)).rejects.toThrow('disabled')
    expect(current.execute).not.toHaveBeenCalled()
  })
  it('reads Notebook manuals while execution stays disabled and leaves the twelve-call read budget and schemas intact', async () => {
    const t = setup(false), request = vi.fn()
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: t.assertInvocation, listVisibleTools: () => t.provider.listTools(), interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: t.parent.signal } })
    for (let i = 0; i < 3; i++) for (const name of ['notebook.browse', 'notebook.inspect']) {
      const result = JSON.parse((await info.callTool('info', { name }, t.context)).content)
      expect(result.inputSchema).toEqual(t.provider.listTools().find(tool => tool.name === name)!.inputSchema)
      expect(result.inputSchema.properties.path).toMatchObject({ minLength: 1, maxLength: 2048 })
      expect(result.documentation.limits.pathSchemaCharacters).toBe(result.inputSchema.properties.path.maxLength)
      expect(result.documentation).toMatchObject({ contract: 'magicpot-local-notebook-read-manual/v1', authority: { requiresExecutionOptIn: false, requiresInterpreter: false, readingUnlocksMutation: false }, limits: { sharedScriptCallsPerRequest: 12 } })
    }
    expect(t.execute).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    for (const [name, args] of [
      ['notebook.browse', { maxEntries: 0 }], ['notebook.browse', { maxEntries: 101 }], ['notebook.browse', { path: '' }], ['notebook.inspect', {}], ['notebook.inspect', { path: 'a.ipynb', limit: 0 }], ['notebook.inspect', { path: 'a.ipynb', limit: 51 }], ['notebook.inspect', { path: 'a.ipynb', includeOutputs: 'all' }], ['notebook.inspect', { path: 'a.ipynb', approved: true }], ['notebook.inspect', { path: 'a.ipynb', offset: 1001 }]
    ] as Array<[string, Record<string, unknown>]>) await expect(t.provider.callTool(name, args, t.context)).rejects.toThrow('Invalid bounded')
    expect(t.execute).not.toHaveBeenCalled()
    for (let i = 0; i < 12; i++) {
      const name = i % 2 ? 'notebook.inspect' : 'notebook.browse'
      await t.provider.callTool(name, name === 'notebook.inspect' ? { path: 'a.ipynb', cellId: 'stable', offset: 1000, limit: 50, includeOutputs: 'summary' } : { maxEntries: 100 }, t.context)
    }
    expect(t.execute).toHaveBeenCalledTimes(12)
    await expect(t.provider.callTool('notebook.browse', {}, t.context)).rejects.toThrow('budget')
    await expect(info.callTool('info', { name: 'notebook.run' }, t.context)).rejects.toThrow('not available')
    await expect(t.provider.callTool('notebook.run', { path: 'a.ipynb', expectedSha256: 'a'.repeat(64), expectedGeneration: 0 }, t.context)).rejects.toThrow('disabled')
    expect(t.execute).toHaveBeenCalledTimes(12); expect(request).not.toHaveBeenCalled()
  })
  it('reads the actual Python schema without executing or spending the shared two execution attempts', async () => {
    const t = setup(), request = vi.fn()
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: t.assertInvocation, listVisibleTools: () => t.provider.listTools(), interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: t.parent.signal } })
    for (let i = 0; i < 3; i++) {
      const result = JSON.parse((await info.callTool('info', { name: 'python.execute' }, t.context)).content)
      expect(result.inputSchema).toEqual(t.provider.listTools().find(tool => tool.name === 'python.execute')!.inputSchema)
      expect(result.documentation).toMatchObject({ contract: 'magicpot-local-python-execution-manual/v1', limits: { sharedScriptCallsPerRequest: 12, sharedEffectfulScriptAttemptsPerRequest: 4, sharedScriptExecutionAttemptsPerRequest: 2, minimumTimeoutMs: 1, minimumOutputBytes: 1 } })
    }
    expect(t.execute).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    for (const args of [{ code: 'pass', approved: true }, { code: 'pass', cwd: '.' }, { code: 'pass', timeoutMs: 0 }, { code: 'pass', maxOutputBytes: 0 }, { code: 'x'.repeat(262145) }]) await expect(t.provider.callTool('python.execute', args, t.context)).rejects.toThrow('Invalid bounded')
    expect(t.execute).not.toHaveBeenCalled()
    await t.provider.callTool('python.execute', { code: 'pass', timeoutMs: 1, maxOutputBytes: 1 }, t.context)
    await t.provider.callTool('python.execute', { code: 'x'.repeat(262144), timeoutMs: 120000, maxOutputBytes: 262144 }, t.context)
    expect(t.execute).toHaveBeenCalledTimes(2)
    expect(t.execute).toHaveBeenLastCalledWith(expect.objectContaining({ input: { code: 'x'.repeat(262144), timeoutMs: 120000, maxOutputBytes: 262144 } }))
    await expect(t.provider.callTool('python.execute', { code: 'pass' }, t.context)).rejects.toThrow('budget')
    expect(t.execute).toHaveBeenCalledTimes(2); expect(request).not.toHaveBeenCalled()
  })
  it('does not unlock initially hidden Python and still rejects execution after current disablement', async () => {
    const off = setup(false)
    const hidden = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => off.provider.listTools() })
    for (const enabled of [false, true]) {
      off.settings.enabled = enabled
      await expect(hidden.callTool('info', { name: 'python.execute' }, off.context)).rejects.toThrow('not available')
    }
    await expect(off.provider.callTool('python.execute', { code: 'pass' }, off.context)).rejects.toThrow('outside')
    expect(off.execute).not.toHaveBeenCalled()
    const t = setup(), info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => t.provider.listTools() })
    expect(JSON.parse((await info.callTool('info', { name: 'python.execute' }, t.context)).content).documentation.authority.readingUnlocksTool).toBe(false)
    t.settings.enabled = false
    await expect(t.provider.callTool('python.execute', { code: 'pass' }, t.context)).rejects.toThrow('disabled')
    expect(t.execute).not.toHaveBeenCalled()
  })
  it('leaves original total and effectful script budgets intact after repeated manual reads', async () => {
    const t = setup(), info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => t.provider.listTools() })
    for (let i = 0; i < 3; i++) await info.callTool('info', { name: 'python.execute' }, t.context)
    for (let i = 0; i < 4; i++) await t.provider.callTool('notebook.cell.clear-outputs', { path: 'a.ipynb', expectedSha256: 'a'.repeat(64), cellIds: ['one'] }, t.context)
    await expect(t.provider.callTool('notebook.cell.clear-outputs', { path: 'a.ipynb', expectedSha256: 'a'.repeat(64), cellIds: ['one'] }, t.context)).rejects.toThrow('budget')
    expect(t.execute).toHaveBeenCalledTimes(4)
    const reads = setup(false), readInfo = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => reads.provider.listTools() })
    for (let i = 0; i < 3; i++) await readInfo.callTool('info', {}, reads.context)
    for (let i = 0; i < 12; i++) await reads.provider.callTool('notebook.browse', {}, reads.context)
    await expect(reads.provider.callTool('notebook.browse', {}, reads.context)).rejects.toThrow('budget')
    expect(reads.execute).toHaveBeenCalledTimes(12)
  })
  it('only exposes bounded notebook reads by default; new settings cannot expand an existing turn', async () => {
    const t = setup(false)
    expect(t.provider.listTools().map((tool) => tool.name)).toEqual(['notebook.browse', 'notebook.inspect'])
    t.settings.enabled = true
    await expect(t.provider.callTool('python.execute', { code: 'pass' }, t.context)).rejects.toThrow(/outside/)
    expect(t.execute).not.toHaveBeenCalled()
  })
  it('rejects foreign route, nonexistent workspace and disabled writes before loading execution code', async () => {
    const t = setup()
    await expect(t.provider.callTool('notebook.inspect', { path: 'a.ipynb' }, { ...t.context, route: { ...route, threadId: 'other' } })).rejects.toThrow(/outside/)
    await expect(t.provider.callTool('notebook.inspect', { path: 'a.ipynb' }, { ...t.context, workspaceRootDir: undefined })).rejects.toThrow(/main-owned/)
    t.settings.enabled = false
    await expect(t.provider.callTool('python.execute', { code: 'pass' }, t.context)).rejects.toThrow(/disabled/)
    expect(t.execute).not.toHaveBeenCalled()
  })
  it.each([
    ['python.execute', { code: 'pass', file: 'other.py' }], ['python.execute', { code: 'pass', run_in_background: true }], ['python.execute', { code: 'pass', timeoutMs: 120001 }],
    ['notebook.run', { path: 'x.ipynb', expectedSha256: 'a'.repeat(64) }], ['notebook.cell.delete', { path: 'x.ipynb', expectedSha256: 'a'.repeat(64), cellIds: [] }],
    ['notebook.inspect', { path: 'a.ipynb', limit: 51 }], ['python.execute', { code: 'pass', env: { SECRET: 'value' } }]
  ])('strict schema rejects %s privileged/oversize args', async (name, args) => {
    const t = setup()
    await expect(t.provider.callTool(name, args, t.context)).rejects.toThrow(/Invalid bounded/)
    expect(t.execute).not.toHaveBeenCalled()
  })
  it('accepts only an explicit passive output-summary mode on the existing read tool', async () => {
    const t = setup(false)
    await t.provider.callTool('notebook.inspect', { path: 'a.ipynb', includeOutputs: 'summary' }, t.context)
    await t.provider.callTool('notebook.inspect', { path: 'a.ipynb', includeOutputs: 'none' }, t.context)
    expect(t.execute).toHaveBeenCalledTimes(2)
    expect(t.execute.mock.calls[0][0]).toMatchObject({ name: 'notebook.inspect', input: { includeOutputs: 'summary' } })
    for (const includeOutputs of ['all', true, {}, 'SUMMARY']) await expect(t.provider.callTool('notebook.inspect', { path: 'a.ipynb', includeOutputs }, t.context)).rejects.toThrow('Invalid bounded')
    expect(t.execute).toHaveBeenCalledTimes(2)
    await expect(t.provider.callTool('notebook.inspect', { path: 'a.ipynb', includeOutputs: 'summary' }, { ...t.context, route: { ...route, threadId: 'other' } })).rejects.toThrow('outside')
  })
  it('validates exact stable cell selectors without expanding scope or resetting the shared read budget', async () => {
    const t = setup(false)
    for (const cellId of ['', 'a'.repeat(65), '../code1', ['code1'], null, 1]) await expect(t.provider.callTool('notebook.inspect', { path: 'a.ipynb', cellId }, t.context)).rejects.toThrow('Invalid bounded')
    expect(t.execute).not.toHaveBeenCalled()
    await t.provider.callTool('notebook.inspect', { path: 'a.ipynb', cellId: 'a'.repeat(64), offset: 1000, limit: 50, includeOutputs: 'summary' }, t.context)
    expect(t.execute.mock.calls[0][0]).toMatchObject({ name: 'notebook.inspect', input: { cellId: 'a'.repeat(64) } })
    await expect(t.provider.callTool('notebook.inspect', { path: 'a.ipynb', cellId: 'code1' }, { ...t.context, route: { ...route, threadId: 'other' } })).rejects.toThrow('outside')
    t.execute.mockRejectedValueOnce(Error('Notebook cell ID not found.'))
    await expect(t.provider.callTool('notebook.inspect', { path: 'a.ipynb', cellId: 'missing' }, t.context)).rejects.toThrow('cell ID not found')
    for (let index = 0; index < 10; index++) await t.provider.callTool('notebook.inspect', { path: 'a.ipynb', cellId: 'code1' }, t.context)
    await expect(t.provider.callTool('notebook.inspect', { path: 'a.ipynb', cellId: 'code1' }, t.context)).rejects.toThrow('budget')
    expect(t.execute).toHaveBeenCalledTimes(12)
    const cancelled = setup(false); cancelled.parent.abort(Error('document navigated'))
    await expect(cancelled.provider.callTool('notebook.inspect', { path: 'a.ipynb', cellId: 'code1' }, cancelled.context)).rejects.toThrow('document navigated')
    expect(cancelled.execute).not.toHaveBeenCalled()
    const revoked = setup(false)
    revoked.execute.mockImplementationOnce(async () => { revoked.parent.abort(Error('document navigated after read')); return { state: 'completed', stdout: 'DISCARD_RESULT' } })
    await expect(revoked.provider.callTool('notebook.inspect', { path: 'a.ipynb', cellId: 'code1' }, revoked.context)).rejects.toThrow('document navigated after read')
    expect(revoked.execute).toHaveBeenCalledOnce()
  })
  it('deep snapshots args and binds main workspace/conversation instead of caller metadata', async () => {
    const t = setup()
    const args = { path: 'a.ipynb', expectedSha256: 'a'.repeat(64), cellIds: ['one'] }
    await t.provider.callTool('notebook.cell.delete', args, t.context)
    args.cellIds[0] = 'different'
    expect(t.execute.mock.calls[0][0]).toMatchObject({ input: { cellIds: ['one'] }, workspaceRoot: t.context.workspaceRootDir, conversationId: 'chat' })
    expect(t.assertInvocation).toHaveBeenCalledWith('notebook.cell.delete')
    expect(threadNotebookNamespace('route', 'chat')).not.toEqual(threadNotebookNamespace('route', 'other-chat'))
    const schema = t.provider.listTools(); schema[0].name = 'evil'
    expect(t.provider.listTools()[0].name).toBe('notebook.browse')
  })
  it('bounds total and expensive calls without resetting budget on error', async () => {
    const t = setup()
    await t.provider.callTool('python.execute', { code: 'pass' }, t.context)
    await t.provider.callTool('python.execute', { code: 'pass' }, t.context)
    await expect(t.provider.callTool('python.execute', { code: 'pass' }, t.context)).rejects.toThrow(/budget/)
    expect(t.execute).toHaveBeenCalledTimes(2)
    const reads = setup(false)
    for (let n = 0; n < 12; n++) await reads.provider.callTool('notebook.browse', {}, reads.context)
    await expect(reads.provider.callTool('notebook.browse', {}, reads.context)).rejects.toThrow(/budget/)
  })
  it('binds parent and invocation cancellation and discards a result after document revocation', async () => {
    const t = setup()
    t.parent.abort(new Error('document navigated'))
    await expect(t.provider.callTool('python.execute', { code: 'pass' }, t.context)).rejects.toThrow(/navigated/)
    expect(t.execute).not.toHaveBeenCalled()
    const other = setup(), signal = new AbortController()
    signal.abort(new Error('request stopped'))
    await expect(other.provider.callTool('notebook.browse', {}, { ...other.context, signal: signal.signal })).rejects.toThrow(/stopped/)
  })
})
