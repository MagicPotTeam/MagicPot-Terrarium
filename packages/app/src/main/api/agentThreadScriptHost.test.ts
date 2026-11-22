import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
import type { CommandJobsConfinementAdapter } from '../magicAgentPlatform2/toolHost'
import { executeAgentThreadScript } from './agentThreadScriptHost'
import { createAgentThreadScriptTools } from './agentThreadScriptTools'
import { createAgentThreadToolProvider } from './agentThreadTools'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
const roots: string[] = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'proj', threadId: 'pane' } as const
const notebook = () => ({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'code1', cell_type: 'code', source: ['print(2)'], metadata: {}, execution_count: 1, outputs: [{ output_type: 'display_data', data: { 'text/html': '<script>SECRET_OUTPUT</script>' }, metadata: {} }] }] })
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'thread-script-host-')); roots.push(root)
  writeFileSync(path.join(root, 'a.ipynb'), JSON.stringify(notebook()))
  const runtime = getAssistantTerminalPolicyRuntime()
  const settings = structuredClone(DEFAULT_CONFIG) as Config
  settings.project_trace_config.enable_agent_python_notebook = true
  settings.use_remote_llm = false
  const controller = new AbortController()
  const assertLive = () => controller.signal.throwIfAborted()
  const base = { route, conversationId: 'chat', namespace: 'a'.repeat(64), workspaceRoot: root, signal: controller.signal, assertLive }
  const invoke = (name: string, input: Record<string, unknown>) => executeAgentThreadScript({ ...base, name, input }, { runtime, config: () => settings })
  return { root, runtime, settings, controller, base, invoke }
}
afterEach(() => { vi.restoreAllMocks(); closeAssistantTerminalPolicyRuntime(); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })) })
describe('thread script production host', () => {
  it('separates passive read manuals from real authorized Notebook reads with execution disabled and no interpreter approval', async () => {
    const t = setup(); t.settings.project_trace_config.enable_agent_python_notebook = false; t.settings.local_comfyui_config.python_cmd = ''
    const file = path.join(t.root, 'a.ipynb'), before = readFileSync(file)
    const approval = vi.spyOn(t.runtime, 'requestTerminalApproval'), request = vi.fn()
    const execute = vi.fn(async (call: import('./agentThreadScriptTools').ThreadScriptInvocation) => t.invoke(call.name, call.input))
    const provider = createAgentThreadScriptTools({ route, conversationId: 'chat', signal: t.controller.signal, enabled: () => false, assertInvocation: vi.fn(), assertLive: t.base.assertLive, execute })
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => provider.listTools(), interactions: { request, assertLive: t.base.assertLive, dispose: vi.fn(), signal: t.controller.signal } })
    const context = { route, runId: 'notebook-manual-live-read', workspaceRootDir: t.root }
    for (let i = 0; i < 3; i++) for (const name of ['notebook.browse', 'notebook.inspect']) expect(JSON.parse((await info.callTool('info', { name }, context)).content).documentation).toMatchObject({ contract: 'magicpot-local-notebook-read-manual/v1', authority: { readingUnlocksMutation: false, requiresInterpreter: false } })
    expect(execute).not.toHaveBeenCalled(); expect(approval).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    expect(readFileSync(file)).toEqual(before); expect(existsSync(path.join(t.root, '.magicpot'))).toBe(false)
    const listed = JSON.parse((await provider.callTool('notebook.browse', {}, context)).content)
    expect(listed).toMatchObject({ path: '.', root: realpathSync.native(t.root), notebooks: [{ path: 'a.ipynb', sha256: hash(before), cellCount: 1 }], count: 1 })
    const inspected = JSON.parse((await provider.callTool('notebook.inspect', { path: 'a.ipynb', cellId: 'code1', offset: 1000, limit: 50, includeOutputs: 'summary' }, context)).content)
    expect(inspected).toMatchObject({ sha256: hash(before), generation: 0, cellCount: 1, untrustedData: true, kernelPersistent: false, outputsOmitted: true, cells: [{ id: 'code1', source: 'print(2)', outputCount: 1, outputs: [{ outputType: 'display_data', text: '', richDataOmitted: true }] }] })
    expect(inspected).not.toHaveProperty('root'); expect(inspected).not.toHaveProperty('nextOffset')
    expect(JSON.stringify(inspected)).not.toContain('SECRET_OUTPUT')
    await expect(provider.callTool('notebook.inspect', { path: '../a.ipynb' }, context)).rejects.toThrow(/traversal|outside/)
    await expect(provider.callTool('notebook.cell.replace', { path: 'a.ipynb', expectedSha256: hash(before), cellId: 'code1', source: 'changed' }, context)).rejects.toThrow('disabled')
    expect(execute).toHaveBeenCalledTimes(3); expect(approval).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    expect(readFileSync(file)).toEqual(before); expect(existsSync(path.join(t.root, '.magicpot'))).toBe(false)
  })
  it('documents the actual browse omitted-limit asymmetry without expanding the explicit schema cap', async () => {
    const t = setup(); t.settings.project_trace_config.enable_agent_python_notebook = false
    for (let i = 0; i < 100; i++) writeFileSync(path.join(t.root, `copy-${i}.ipynb`), JSON.stringify(notebook()))
    const approval = vi.spyOn(t.runtime, 'requestTerminalApproval')
    const execute = vi.fn(async (call: import('./agentThreadScriptTools').ThreadScriptInvocation) => t.invoke(call.name, call.input))
    const provider = createAgentThreadScriptTools({ route, conversationId: 'chat', signal: t.controller.signal, enabled: () => false, assertInvocation: vi.fn(), assertLive: t.base.assertLive, execute })
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => provider.listTools() })
    const context = { route, runId: 'notebook-browse-default-limit', workspaceRootDir: t.root }
    expect(JSON.parse((await info.callTool('info', { name: 'notebook.browse' }, context)).content).documentation.limits).toMatchObject({ maximumExplicitMaxEntries: 100, omittedMaxEntriesHostDefault: 1000 })
    expect(execute).not.toHaveBeenCalled()
    await expect(provider.callTool('notebook.browse', { maxEntries: 101 }, context)).rejects.toThrow('Invalid bounded')
    const defaultList = JSON.parse((await provider.callTool('notebook.browse', {}, context)).content)
    expect(defaultList).toMatchObject({ count: 101, truncated: false }); expect(defaultList.notebooks).toHaveLength(101)
    const explicitList = JSON.parse((await provider.callTool('notebook.browse', { maxEntries: 100 }, context)).content)
    expect(explicitList).toMatchObject({ count: 100, truncated: true }); expect(explicitList.notebooks).toHaveLength(100)
    expect(execute).toHaveBeenCalledTimes(2); expect(approval).not.toHaveBeenCalled()
    expect(existsSync(path.join(t.root, '.magicpot'))).toBe(false)
  })
  it('reads through production policy without interpreter or opt-in and omits raw media/HTML metadata', async () => {
    const t = setup(); t.settings.project_trace_config.enable_agent_python_notebook = false
    const result = await t.invoke('notebook.inspect', { path: 'a.ipynb' })
    expect(result).toMatchObject({ generation: 0, cells: [{ id: 'code1', source: 'print(2)', outputCount: 1 }], outputsOmitted: true })
    expect(JSON.stringify(result)).not.toContain('SECRET_OUTPUT')
    expect(await t.invoke('notebook.browse', {})).toMatchObject({ count: 1 })
    await expect(t.invoke('notebook.inspect', { path: '../a.ipynb' })).rejects.toThrow(/traversal|outside/)
  })
  it('reads saved stream/error/plain summaries without Python, approval, rich rendering or file mutation', async () => {
    const t = setup(); t.settings.project_trace_config.enable_agent_python_notebook = false
    const file = path.join(t.root, 'a.ipynb')
    const outputs = [
      { output_type: 'stream', name: 'stderr', text: ['stored ', 'warning\n'] },
      { output_type: 'error', ename: 'ValueError', evalue: 'bad input', traceback: ['trace-one', 'trace-two'] },
      { output_type: 'display_data', data: { 'text/plain': ['saved ', 'table'], 'text/html': '<script>HIDDEN_HTML</script>', 'image/png': 'HIDDEN_PNG', 'application/javascript': 'HIDDEN_JS' }, metadata: { hidden: 'HIDDEN_METADATA' } },
      { output_type: 'stream', name: 'stdout', text: 'FOURTH_OUTPUT' }
    ]
    writeFileSync(file, JSON.stringify({ ...notebook(), cells: [{ ...notebook().cells[0], outputs }] }))
    const before = readFileSync(file), approval = vi.spyOn(t.runtime, 'requestTerminalApproval')
    const result = await t.invoke('notebook.inspect', { path: 'a.ipynb', includeOutputs: 'summary' })
    expect(result).toMatchObject({ sha256: hash(before), generation: 0, kernelPersistent: false, untrustedData: true, outputsOmitted: true, cells: [{ executionCount: 1, outputCount: 4, omittedOutputCount: 1, outputsOmitted: true, outputs: [
      { outputType: 'stream', name: 'stderr', text: 'stored warning\n', truncated: false, richDataOmitted: false },
      { outputType: 'error', text: 'ValueError: bad input\ntrace-one\ntrace-two', truncated: false, richDataOmitted: false },
      { outputType: 'display_data', text: 'saved table', truncated: false, richDataOmitted: true }
    ] }] })
    for (const hidden of ['HIDDEN_HTML', 'HIDDEN_PNG', 'HIDDEN_JS', 'HIDDEN_METADATA', 'FOURTH_OUTPUT']) expect(JSON.stringify(result)).not.toContain(hidden)
    const noOutputs = await t.invoke('notebook.inspect', { path: 'a.ipynb', includeOutputs: 'none' })
    expect(noOutputs).toMatchObject({ outputsOmitted: true, cells: [{ outputCount: 4 }] })
    expect(JSON.stringify(noOutputs)).not.toContain('stored warning')
    expect(approval).not.toHaveBeenCalled(); expect(readFileSync(file)).toEqual(before)
    expect(existsSync(path.join(t.root, '.magicpot'))).toBe(false)
  })
  it('bounds saved output text per item and per page while preserving existing source pagination', async () => {
    const t = setup(), file = path.join(t.root, 'a.ipynb')
    writeFileSync(file, JSON.stringify({ ...notebook(), cells: Array.from({ length: 6 }, (_, index) => ({ ...notebook().cells[0], id: `code${index}`, outputs: Array.from({ length: 4 }, () => ({ output_type: 'execute_result', execution_count: 1, data: { 'text/plain': ['x'.repeat(1500), 'y'.repeat(1500)] }, metadata: {} })) })) }))
    const result = await t.invoke('notebook.inspect', { path: 'a.ipynb', includeOutputs: 'summary', limit: 5 }) as { nextOffset: number; outputsOmitted: boolean; cells: { outputCount: number; omittedOutputCount: number; outputs: { text: string; truncated: boolean }[] }[] }
    expect(result.nextOffset).toBe(5); expect(result.outputsOmitted).toBe(true)
    expect(result.cells).toHaveLength(5)
    expect(result.cells.flatMap(cell => cell.outputs).reduce((sum, output) => sum + output.text.length, 0)).toBe(16384)
    for (const cell of result.cells) {
      expect(cell.outputCount).toBe(4); expect(cell.omittedOutputCount).toBe(1); expect(cell.outputs).toHaveLength(3)
      for (const output of cell.outputs) { expect(output.text.length).toBeLessThanOrEqual(2048); expect(output.truncated).toBe(true) }
    }
    expect(await t.invoke('notebook.inspect', { path: 'a.ipynb', offset: 5, includeOutputs: 'summary' })).toMatchObject({ cells: [{ id: 'code5', outputs: expect.arrayContaining([{ outputType: 'execute_result', text: expect.stringContaining('x'), truncated: true, richDataOmitted: false }]) }] })
  })
  it('handles unsupported or malformed saved outputs passively and reports complete small summaries honestly', async () => {
    const t = setup(), file = path.join(t.root, 'a.ipynb')
    const cells = [
      { ...notebook().cells[0], id: 'complete', outputs: [{ output_type: 'execute_result', data: { 'text/plain': '42' }, metadata: {} }] },
      { ...notebook().cells[0], id: 'unknown', outputs: [null, { output_type: 'alien', text: 'UNSUPPORTED_RAW' }, { output_type: 'display_data', data: { 'text/plain': { nested: 'MALFORMED_RAW' }, 'text/html': 'RICH_RAW' } }] },
      { id: 'markdown', cell_type: 'markdown', source: ['passive source'], metadata: {} }
    ]
    writeFileSync(file, JSON.stringify({ ...notebook(), cells }))
    expect(await t.invoke('notebook.inspect', { path: 'a.ipynb', includeOutputs: 'summary', limit: 1 })).toMatchObject({ outputsOmitted: false, cells: [{ executionCount: 1, omittedOutputCount: 0, outputsOmitted: false, outputs: [{ outputType: 'execute_result', text: '42', truncated: false, richDataOmitted: false }] }] })
    const result = await t.invoke('notebook.inspect', { path: 'a.ipynb', offset: 1, includeOutputs: 'summary' })
    expect(result).toMatchObject({ outputsOmitted: true, cells: [{ id: 'unknown', outputsOmitted: true, outputs: [{ outputType: 'unknown', text: '', richDataOmitted: true }, { outputType: 'unknown', text: '', richDataOmitted: true }, { outputType: 'display_data', text: '', richDataOmitted: true }] }, { id: 'markdown', outputs: [], outputsOmitted: false }] })
    for (const hidden of ['UNSUPPORTED_RAW', 'MALFORMED_RAW', 'RICH_RAW']) expect(JSON.stringify(result)).not.toContain(hidden)
    await expect(t.invoke('notebook.inspect', { path: 'a.ipynb', includeOutputs: 'all' })).rejects.toThrow('output mode')
    t.controller.abort(Error('document navigated'))
    await expect(t.invoke('notebook.inspect', { path: 'a.ipynb', includeOutputs: 'summary' })).rejects.toThrow('document navigated')
  })
  it('selects one exact stored cell ID beyond the default page and keeps source/output bounds', async () => {
    const t = setup(), file = path.join(t.root, 'a.ipynb')
    t.settings.project_trace_config.enable_agent_python_notebook = false
    const cells = Array.from({ length: 27 }, (_, index) => ({ ...notebook().cells[0], id: `code${index}`, source: [index === 25 ? 's'.repeat(9000) : 'UNSELECTED_SOURCE'], outputs: index === 25 ? Array.from({ length: 4 }, () => ({ output_type: 'stream', name: 'stdout', text: ['t'.repeat(3000)] })) : [{ output_type: 'stream', name: 'stdout', text: ['UNSELECTED_OUTPUT'] }] }))
    writeFileSync(file, JSON.stringify({ ...notebook(), cells }))
    const before = readFileSync(file), approval = vi.spyOn(t.runtime, 'requestTerminalApproval')
    const result = await t.invoke('notebook.inspect', { path: 'a.ipynb', cellId: 'code25', offset: 1000, limit: 50, includeOutputs: 'summary' })
    expect(result).toMatchObject({ cellCount: 27, sha256: hash(before), generation: 0, kernelPersistent: false, untrustedData: true, outputsOmitted: true, cells: [{ id: 'code25', source: 's'.repeat(8192), sourceTruncated: true, outputCount: 4, omittedOutputCount: 1, outputs: Array.from({ length: 3 }, () => ({ text: 't'.repeat(2048), truncated: true })) }] })
    expect(result).not.toHaveProperty('nextOffset')
    for (const hidden of ['UNSELECTED_SOURCE', 'UNSELECTED_OUTPUT']) expect(JSON.stringify(result)).not.toContain(hidden)
    expect(await t.invoke('notebook.inspect', { path: 'a.ipynb', cellId: 'code25' })).toMatchObject({ outputsOmitted: true, cells: [{ id: 'code25', outputCount: 4 }] })
    expect(approval).not.toHaveBeenCalled(); expect(t.runtime.listPendingTerminalApprovals()).toEqual([])
    expect(readFileSync(file)).toEqual(before); expect(existsSync(path.join(t.root, '.magicpot'))).toBe(false)
  })
  it('never falls back to a page, case folding or synthetic cell-N when the exact cell ID is absent', async () => {
    const t = setup(), file = path.join(t.root, 'a.ipynb'), before = readFileSync(file)
    for (const cellId of ['missing', 'CODE1', 'cell-0', '', null, 1]) await expect(t.invoke('notebook.inspect', { path: 'a.ipynb', cellId, includeOutputs: 'summary', offset: 0, limit: 1 })).rejects.toThrow('cell ID not found')
    expect(await t.invoke('notebook.inspect', { path: 'a.ipynb', offset: 0, limit: 1 })).toMatchObject({ cells: [{ id: 'code1' }] })
    t.controller.abort(Error('document navigated'))
    await expect(t.invoke('notebook.inspect', { path: 'a.ipynb', cellId: 'code1' })).rejects.toThrow('document navigated')
    expect(readFileSync(file)).toEqual(before); expect(t.runtime.listPendingTerminalApprovals()).toEqual([])
  })
  it('does not bypass complete-file ID validation by selecting only a valid cell', async () => {
    const t = setup(), file = path.join(t.root, 'a.ipynb')
    writeFileSync(file, JSON.stringify({ ...notebook(), cells: [{ cell_type: 'markdown', source: ['INVALID_ID_HIDDEN_SOURCE'], metadata: {} }, ...notebook().cells] }))
    const before = readFileSync(file), approval = vi.spyOn(t.runtime, 'requestTerminalApproval')
    await expect(t.invoke('notebook.inspect', { path: 'a.ipynb', cellId: 'code1' })).rejects.toThrow('unique stable id')
    expect(readFileSync(file)).toEqual(before); expect(approval).not.toHaveBeenCalled(); expect(t.runtime.listPendingTerminalApprovals()).toEqual([])
  })
  it.each([
    { name: 'notebook.cell.insert', extra: { cell: { cellType: 'raw', source: 'new raw' }, position: 'after', referenceCellId: 'code1' } },
    { name: 'notebook.cell.replace', extra: { cellId: 'code1', source: 'new source' } },
    { name: 'notebook.cell.delete', extra: { cellIds: ['code1'] } },
    { name: 'notebook.cell.convert', extra: { cellIds: ['code1'], cellType: 'code' } },
    { name: 'notebook.cell.clear-outputs', extra: { cellIds: ['code1'] } },
    { name: 'notebook.cell.clear-outputs', extra: { cellIds: ['markdown1'] }, noncode: true }
  ])('keeps $name manuals passive before a separate exact approved real-file mutation', async ({ name, extra, noncode }) => {
    const t = setup(); t.settings.local_comfyui_config.python_cmd = ''
    const file = path.join(t.root, 'a.ipynb')
    if (noncode) writeFileSync(file, JSON.stringify({ ...notebook(), cells: [{ id: 'markdown1', cell_type: 'markdown', source: ['saved markdown'], metadata: { retained: true } }] }))
    const before = readFileSync(file), original = JSON.parse(before.toString('utf8'))
    const approval = vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementation(async request => {
      expect(readFileSync(file)).toEqual(before)
      expect(existsSync(path.join(t.root, '.magicpot/notebook-snapshots'))).toBe(true)
      expect(request).toMatchObject({ target: { id: 'notebook.write' }, action: 'notebook.write', sessionId: 'chat', route })
      expect(request.input).toMatchObject({ operation: name, path: 'a.ipynb', expectedSha256: hash(before), ...extra, ...(name.endsWith('replace') ? { clearOutputs: true } : {}) })
      return { authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) }
    })
    const execute = vi.fn(async (call: import('./agentThreadScriptTools').ThreadScriptInvocation) => t.invoke(call.name, call.input))
    const provider = createAgentThreadScriptTools({ route, conversationId: 'chat', signal: t.controller.signal, enabled: () => t.settings.project_trace_config.enable_agent_python_notebook === true, assertInvocation: vi.fn(), assertLive: t.base.assertLive, execute })
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => provider.listTools() })
    const context = { route, runId: 'notebook-cell-manual-write', workspaceRootDir: t.root }
    expect(JSON.parse((await info.callTool('info', { name }, context)).content).documentation).toMatchObject({ contract: 'magicpot-local-notebook-cell-mutation-manual/v1', authority: { requiresFreshFormalApproval: true, requiresInterpreter: false } })
    expect(execute).not.toHaveBeenCalled(); expect(approval).not.toHaveBeenCalled()
    expect(readFileSync(file)).toEqual(before); expect(existsSync(path.join(t.root, '.magicpot'))).toBe(false)
    const result = JSON.parse((await provider.callTool(name, { path: 'a.ipynb', expectedSha256: hash(before), ...extra }, context)).content)
    const after = readFileSync(file), actual = JSON.parse(after.toString('utf8'))
    expect(result).toMatchObject({ executionMode: 'stateless', kernelPersistent: false, root: realpathSync.native(t.root), path: 'a.ipynb', beforeSha256: hash(before), afterSha256: hash(after), cellCount: actual.cells.length, snapshotId: hash(before) })
    for (const key of ['state', 'status', 'writeStatus', 'mutation', 'businessTaskVerified', 'untrustedData', 'generation']) expect(result).not.toHaveProperty(key)
    expect(readFileSync(path.join(t.root, '.magicpot/notebook-snapshots', `${result.snapshotId}.ipynb`))).toEqual(before)
    expect(approval).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce()
    expect(after.toString('utf8').endsWith('\n')).toBe(true)
    if (name.endsWith('insert')) {
      expect(actual.cells).toHaveLength(2); expect(actual.cells[0]).toEqual(original.cells[0])
      expect(actual.cells[1]).toMatchObject({ id: expect.stringMatching(/^[a-f0-9]{16}$/), cell_type: 'raw', source: ['new raw'], metadata: {} })
      expect(result.cellIds).toEqual([actual.cells[1].id])
    } else if (name.endsWith('delete')) expect(actual.cells).toEqual([])
    else if (noncode) { expect(actual).toEqual(original); expect(after).not.toEqual(before) }
    else expect(actual.cells[0]).toMatchObject({ id: 'code1', source: [name.endsWith('replace') ? 'new source' : 'print(2)'], outputs: [], execution_count: null })
    await expect(t.invoke(name, { path: 'a.ipynb', expectedSha256: hash(before), ...extra })).rejects.toThrow('SHA conflict')
    expect(approval).toHaveBeenCalledOnce()
  })
  it.each(['deny', 'cancel', 'disable'])('does not let a cell manual bypass a separate %s approval outcome', async kind => {
    const t = setup(), file = path.join(t.root, 'a.ipynb'), before = readFileSync(file)
    const execute = vi.fn(async (call: import('./agentThreadScriptTools').ThreadScriptInvocation) => t.invoke(call.name, call.input))
    const provider = createAgentThreadScriptTools({ route, conversationId: 'chat', signal: t.controller.signal, enabled: () => t.settings.project_trace_config.enable_agent_python_notebook === true, assertInvocation: vi.fn(), assertLive: t.base.assertLive, execute })
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => provider.listTools() })
    const approval = vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementation(async request => {
      if (kind === 'deny') throw new Error('User rejected')
      const reference = { authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) }
      if (kind === 'cancel') t.controller.abort(Error('Document navigated'))
      else t.settings.project_trace_config.enable_agent_python_notebook = false
      return reference
    })
    const context = { route, runId: 'cell-manual-negative', workspaceRootDir: t.root }
    expect(JSON.parse((await info.callTool('info', { name: 'notebook.cell.delete' }, context)).content).grantsPermission).toBe(false)
    expect(execute).not.toHaveBeenCalled(); expect(approval).not.toHaveBeenCalled()
    await expect(provider.callTool('notebook.cell.delete', { path: 'a.ipynb', expectedSha256: hash(before), cellIds: ['code1'] }, context)).rejects.toThrow(/rejected|navigated|disabled/)
    expect(approval).toHaveBeenCalledOnce(); expect(readFileSync(file)).toEqual(before)
    expect(existsSync(path.join(t.root, '.magicpot/notebook-snapshots'))).toBe(true)
  })
  it('rejects a late owner loss after a real approved cell commit without claiming that the rejection rolled bytes back', async () => {
    const t = setup(), file = path.join(t.root, 'a.ipynb'), before = readFileSync(file)
    const approval = vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementation(async request => ({ authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) }))
    const execute = vi.fn(async (call: import('./agentThreadScriptTools').ThreadScriptInvocation) => {
      const result = await t.invoke(call.name, call.input)
      t.controller.abort(Error('Owner ended after commit'))
      return result
    })
    const provider = createAgentThreadScriptTools({ route, conversationId: 'chat', signal: t.controller.signal, enabled: () => true, assertInvocation: vi.fn(), assertLive: t.base.assertLive, execute })
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => provider.listTools() })
    const context = { route, runId: 'cell-manual-late-owner', workspaceRootDir: t.root }
    expect(JSON.parse((await info.callTool('info', { name: 'notebook.cell.replace' }, context)).content).documentation.failure).toMatchObject({ failureProvesNoMutation: false, automaticRetry: false, cancellationRollsBack: false })
    expect(approval).not.toHaveBeenCalled()
    await expect(provider.callTool('notebook.cell.replace', { path: 'a.ipynb', expectedSha256: hash(before), cellId: 'code1', source: 'committed before owner loss' }, context)).rejects.toThrow('Owner ended after commit')
    expect(JSON.parse(readFileSync(file, 'utf8')).cells[0]).toMatchObject({ source: ['committed before owner loss'], outputs: [], execution_count: null })
    expect(readFileSync(file)).not.toEqual(before)
    expect(readFileSync(path.join(t.root, '.magicpot/notebook-snapshots', `${hash(before)}.ipynb`))).toEqual(before)
    expect(approval).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce()
  })
  it('writes only the approved snapshot and records actual CAS result through the real host', async () => {
    const t = setup()
    const input = { path: 'a.ipynb', cellId: 'code1', source: 'new source', expectedSha256: hash(readFileSync(path.join(t.root, 'a.ipynb'))) }
    const approval = vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementation(async (request) => {
      expect(request.input).toMatchObject({ operation: 'notebook.cell.replace', source: 'new source', clearOutputs: true, expectedSha256: input.expectedSha256 })
      expect(request.sessionId).toBe('chat'); expect(request.route).toMatchObject(route)
      return { authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) }
    })
    expect(await t.invoke('notebook.cell.replace', input)).toMatchObject({ beforeSha256: input.expectedSha256, afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const actual = JSON.parse(readFileSync(path.join(t.root, 'a.ipynb'), 'utf8'))
    expect(actual.cells[0]).toMatchObject({ source: ['new source'], outputs: [] })
    expect(approval).toHaveBeenCalledOnce()
    await expect(t.invoke('notebook.cell.replace', input)).rejects.toThrow(/SHA conflict/)
    expect(approval).toHaveBeenCalledOnce()
  })
  it('fails closed on denial, document cancellation or revocation while waiting for approval', async () => {
    for (const kind of ['deny', 'cancel', 'disable']) {
      const t = setup(), file = path.join(t.root, 'a.ipynb'), before = readFileSync(file)
      vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementationOnce(async (request) => {
        if (kind === 'deny') throw new Error('User rejected')
        const ref = { authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) }
        if (kind === 'cancel') t.controller.abort(new Error('Document navigated'))
        else t.settings.project_trace_config.enable_agent_python_notebook = false
        return ref
      })
      await expect(t.invoke('notebook.cell.delete', { path: 'a.ipynb', cellIds: ['code1'], expectedSha256: hash(before) })).rejects.toThrow(/rejected|navigated|disabled/)
      expect(readFileSync(file)).toEqual(before)
    }
  })
  it('uses a formal pending desktop request rather than auto-approving in test mode', async () => {
    const t = setup(), file = path.join(t.root, 'a.ipynb'), before = readFileSync(file)
    const pending = t.invoke('notebook.cell.convert', { path: 'a.ipynb', cellType: 'markdown', cellIds: ['code1'], expectedSha256: hash(before) })
    const handled = pending.catch((error) => error)
    await vi.waitFor(() => expect(t.runtime.listPendingTerminalApprovals()).toHaveLength(1))
    expect(readFileSync(file)).toEqual(before)
    const approval = t.runtime.listPendingTerminalApprovals()[0]
    t.runtime.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: false })
    expect(await handled).toBeInstanceOf(Error)
    expect(readFileSync(file)).toEqual(before)
  })
  it.skipIf(!process.env.MAGICPOT_TEST_PYTHON)('runs real isolated Python through production resource confinement and applies a stateless notebook result', async () => {
    const t = setup()
    t.settings.local_comfyui_config.python_cmd = process.env.MAGICPOT_TEST_PYTHON!
    vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementation(async (request) => {
      if (request.action === 'notebook.execute') expect(request.input.approvedCells).toEqual([{ id: 'code1', source: 'print(2)' }])
      return { authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) }
    })
    const output = await t.invoke('python.execute', { code: 'print(6 * 7)', timeoutMs: 10000 })
    expect(output).toMatchObject({ job: { state: 'completed', exitCode: 0 } })
    expect((output as { stdout: string }).stdout.trim()).toBe('42')
    const file = path.join(t.root, 'a.ipynb')
    const result = await t.invoke('notebook.run', { path: 'a.ipynb', expectedSha256: hash(readFileSync(file)), expectedGeneration: 0, timeoutMs: 10000 })
    expect(result).toMatchObject({ state: 'completed-applied', kernelPersistent: false })
    expect(JSON.parse(readFileSync(file, 'utf8')).cells[0].outputs).toEqual(expect.arrayContaining([expect.objectContaining({ output_type: 'stream', text: ['2\n'] })]))
    expect(await t.invoke('notebook.inspect', { path: 'a.ipynb' })).toMatchObject({ generation: 1 })
    expect(await executeAgentThreadScript({ ...t.base, conversationId: 'other', namespace: 'b'.repeat(64), name: 'notebook.inspect', input: { path: 'a.ipynb' } }, { runtime: t.runtime, config: () => t.settings })).toMatchObject({ generation: 0 })
  }, 30000)
  it.skipIf(!process.env.MAGICPOT_TEST_PYTHON)('waits for real Python timeout/output-limit and cancellation before returning ownership', async () => {
    const t = setup(); t.settings.local_comfyui_config.python_cmd = process.env.MAGICPOT_TEST_PYTHON!
    vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementation(async (request) => ({ authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) }))
    expect(await t.invoke('python.execute', { code: 'import time;time.sleep(30)', timeoutMs: 250 })).toMatchObject({ job: { state: 'timed-out', outcome: 'known' } })
    expect(await t.invoke('python.execute', { code: 'print("x" * 10000)', maxOutputBytes: 512 })).toMatchObject({ job: { state: 'failed', logsTruncated: true } })
    const late = path.join(t.root, 'late.txt')
    const pending = t.invoke('python.execute', { code: `import time;time.sleep(2);open(${JSON.stringify(late)}, "w").write("unexpected")`, timeoutMs: 10000 })
    const result = pending.catch((error) => error)
    await new Promise((resolve) => setTimeout(resolve, 300))
    t.controller.abort(new Error('Owner document navigated'))
    expect(await result).toBeInstanceOf(Error)
    await new Promise((resolve) => setTimeout(resolve, 2100))
    expect(existsSync(late)).toBe(false)
  }, 30000)
  it('refuses unsupported resource confinement before showing an approval or materializing user code', async () => {
    const t = setup(); t.settings.local_comfyui_config.python_cmd = path.resolve(t.root, 'trusted-python.exe')
    const unsupported: CommandJobsConfinementAdapter = { platform: 'none', capabilities: { memory: false, cpu: false, processCount: false, networkDeny: false, networkHosts: false }, prepare: () => { throw new Error('must not prepare') } }
    const approval = vi.spyOn(t.runtime, 'requestTerminalApproval')
    await expect(executeAgentThreadScript({ ...t.base, name: 'python.execute', input: { code: 'print(1)' } }, { runtime: t.runtime, config: () => t.settings, confinement: unsupported })).rejects.toThrow(/unsupported/)
    expect(approval).not.toHaveBeenCalled()
    expect(existsSync(path.join(t.root, '.magicpot/python/inline'))).toBe(false)
  })
  it('holds a notebook lock across approval and snapshot writes even for another conversation in the same workspace', async () => {
    const t = setup(), file = path.join(t.root, 'a.ipynb'), before = readFileSync(file)
    let approve!: () => void
    const gate = new Promise<void>((resolve) => { approve = resolve })
    const spy = vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementation(async (request) => { await gate; return { authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) } })
    const input = { path: 'a.ipynb', cellId: 'code1', source: 'replacement', expectedSha256: hash(before) }
    const first = t.invoke('notebook.cell.replace', input)
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
    await expect(executeAgentThreadScript({ ...t.base, namespace: 'b'.repeat(64), conversationId: 'other-chat', name: 'notebook.cell.replace', input }, { runtime: t.runtime, config: () => t.settings })).rejects.toThrow(/active/)
    if (process.platform === 'win32') await expect(executeAgentThreadScript({ ...t.base, namespace: 'c'.repeat(64), conversationId: 'case-chat', name: 'notebook.cell.replace', input: { ...input, path: 'A.ipynb' } }, { runtime: t.runtime, config: () => t.settings })).rejects.toThrow(/active/)
    approve(); await first
    expect(spy).toHaveBeenCalledOnce()
  })
  it('validates opt-in and explicit interpreter before approval or user code materialization', async () => {
    const t = setup()
    const approval = vi.spyOn(t.runtime, 'requestTerminalApproval')
    t.settings.project_trace_config.enable_agent_python_notebook = false
    await expect(t.invoke('python.execute', { code: 'print(1)' })).rejects.toThrow(/disabled/)
    t.settings.project_trace_config.enable_agent_python_notebook = true
    t.settings.local_comfyui_config.python_cmd = 'python -m module'
    await expect(t.invoke('python.execute', { code: 'print(1)' })).rejects.toThrow(/absolute/)
    expect(approval).not.toHaveBeenCalled()
    expect(existsSync(path.join(t.root, '.magicpot/python/inline'))).toBe(false)
  })
})
