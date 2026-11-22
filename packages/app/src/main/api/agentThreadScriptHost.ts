import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { assertPolicyRequest, createFilesToolPolicyRequest, type PolicyJsonRecord } from '@shared/magicAgentPlatform2'
import type { Config } from '@shared/config/config'
import type { AssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { NotebookToolHost, NotebookExecutionCoordinator, PythonNotebookExecutionBoundary, PythonToolHost, createMagicAgentToolAuditSink, type CommandJobsConfinementAdapter, type PythonProbe } from '../magicAgentPlatform2/toolHost'
import type { ThreadScriptInvocation } from './agentThreadScriptTools'

import { acquireThreadProcessOperation, assertThreadProcessAvailable, ensureThreadProcessDirectory as directory, getThreadProcessHost, threadProcessControl } from './agentThreadProcessHost'
const locks = new Set<string>()
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function generation(root: string, namespace: string, requested: string): number {
  const relative = `.magicpot/notebook-executions/${namespace}`
  const file = path.join(root, relative, `generation-${hash(requested)}.json`)
  if (!existsSync(file)) return 0
  directory(root, relative)
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error('Invalid notebook generation file.')
  const value = JSON.parse(readFileSync(file, 'utf8')) as { path: string; generation: number }
  if (value.path !== requested || !Number.isSafeInteger(value.generation) || value.generation < 0) throw new Error('Invalid notebook generation state.')
  return value.generation
}
function summarizeNotebookOutput(value: unknown, maxChars: number) {
  // The notebook host already parsed and bounded passive JSON. Never coerce rich
  // values to text or follow MIME links; only select known stored text fields.
  const record = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)
  const output = record(value) ? value : {}
  const outputType = typeof output.output_type === 'string' && ['stream', 'error', 'display_data', 'execute_result'].includes(output.output_type) ? output.output_type : 'unknown'
  let text = '', truncated = false, richDataOmitted = outputType === 'unknown'
  const append = (item: unknown, separator = '') => {
    const parts = typeof item === 'string' ? [item] : Array.isArray(item) && item.every(part => typeof part === 'string') ? item as string[] : undefined
    if (!parts) { if (item !== undefined) richDataOmitted = true; return }
    for (let index = 0; index < parts.length; index++) {
      const part = `${index ? separator : ''}${parts[index]}`, copied = part.slice(0, Math.max(0, maxChars - text.length))
      text += copied; truncated ||= copied.length < part.length
    }
  }
  if (outputType === 'stream') append(output.text)
  else if (outputType === 'error') {
    append(output.ename)
    if (typeof output.ename === 'string' && output.ename && typeof output.evalue === 'string' && output.evalue) append(': ')
    append(output.evalue)
    if ((output.ename || output.evalue) && (typeof output.traceback === 'string' ? output.traceback.length : Array.isArray(output.traceback) && output.traceback.length)) append('\n')
    append(output.traceback, '\n')
  } else if (outputType !== 'unknown') {
    if (record(output.data)) {
      append(output.data['text/plain'])
      richDataOmitted ||= Object.keys(output.data).some(mime => mime !== 'text/plain')
    } else richDataOmitted = true
  }
  const name = outputType === 'stream' && ['stdout', 'stderr'].includes(output.name as string) ? output.name as string : undefined
  if (outputType === 'stream' && output.name !== undefined && name === undefined) richDataOmitted = true
  return { outputType, ...(name ? { name } : {}), text, truncated, richDataOmitted }
}
const mutations = {
  'notebook.cell.insert': 'insert', 'notebook.cell.replace': 'replace', 'notebook.cell.delete': 'delete',
  'notebook.cell.convert': 'convert', 'notebook.cell.clear-outputs': 'clearOutputs'
} as const
export async function executeAgentThreadScript(call: ThreadScriptInvocation, dependencies: {
  config?: () => Config
  runtime?: AssistantTerminalPolicyRuntime
  confinement?: CommandJobsConfinementAdapter
  probe?: PythonProbe
} = {}): Promise<unknown> {
  call.assertLive()
  const { name, input, signal } = call
  const root = path.resolve(realpathSync.native(call.workspaceRoot))
  const runtime = dependencies.runtime ?? (await import('../magicAgentPlatform2/productionRuntime')).getAssistantTerminalPolicyRuntime()
  const config = dependencies.config ?? (await import('../config/config')).getConfig
  const effect = !['notebook.browse', 'notebook.inspect'].includes(name)
  const check = (availability = true) => {
    call.assertLive()
    if (effect) {
      if (config().use_remote_llm || config().project_trace_config?.enable_agent_python_notebook !== true) throw new Error('Local Python/Notebook mutations are disabled.')
      if (availability) assertThreadProcessAvailable(runtime, root)
    }
  }
  check()
  const identity = { routeKey: JSON.stringify(call.route), sessionId: call.conversationId }
  const requested = typeof input.path === 'string' ? input.path.replace(/\\/g, '/') : '.'
  const write = Object.prototype.hasOwnProperty.call(mutations, name)
  const notebookRequest = (tool: string, isWrite = false) => createFilesToolPolicyRequest({
    requestId: randomUUID(), actor: { kind: 'system', id: 'notebook-tool-host' }, target: { kind: 'tool', id: isWrite ? 'notebook.write' : tool }, route: { ...call.route }, sessionId: call.conversationId,
    action: isWrite ? 'notebook.write' : tool === 'notebook.list' ? 'filesystem.list' : 'filesystem.read',
    toolInput: { ...input, path: requested, operation: name, ...(name === 'notebook.cell.replace' ? { clearOutputs: true } : {}) } as PolicyJsonRecord,
    filesystem: { paths: [requested], allowedRoots: [root] }
  })
  const notebook = await NotebookToolHost.create(runtime.authorization, { allowedRoots: [root], onAudit: createMagicAgentToolAuditSink(runtime.eventStore, `thread-notebook:${randomUUID()}`) })
  const read = async () => notebook.read({ authorizationId: randomUUID(), idempotencyKey: randomUUID(), request: notebookRequest('notebook.read'), input: { path: requested }, signal })
  if (name === 'notebook.browse') {
    const result = await notebook.list({ authorizationId: randomUUID(), idempotencyKey: randomUUID(), request: notebookRequest('notebook.list'), input: { path: requested, maxEntries: input.maxEntries as number | undefined }, signal })
    check(); return result
  }
  if (name === 'notebook.inspect') {
    const includeOutputs = input.includeOutputs ?? 'none'
    if (includeOutputs !== 'none' && includeOutputs !== 'summary') throw new Error('Invalid notebook output mode.')
    const result = await read(); check()
    const offset = Number(input.offset ?? 0), end = Math.min(result.notebook.cells.length, offset + Number(input.limit ?? 20))
    const selected = input.cellId === undefined ? result.notebook.cells.slice(offset, end) : result.notebook.cells.filter(cell => cell.id === input.cellId)
    if (input.cellId !== undefined && selected.length !== 1) throw new Error('Notebook cell ID not found.')
    let remaining = 65536, outputRemaining = 16384
    const cells = selected.map((cell) => {
      const source = cell.source.join(''), content = source.slice(0, Math.min(remaining, 8192))
      remaining -= content.length
      const outputs = includeOutputs === 'summary' ? (cell.outputs ?? []).slice(0, 3).map(value => {
        const output = summarizeNotebookOutput(value, Math.min(2048, outputRemaining))
        outputRemaining -= output.text.length
        return output
      }) : undefined
      const omittedOutputCount = (cell.outputs?.length ?? 0) - (outputs?.length ?? 0)
      return { id: cell.id, cellType: cell.cell_type, source: content, sourceTruncated: content.length < source.length, outputCount: cell.outputs?.length ?? 0, ...(cell.cell_type === 'code' ? { executionCount: cell.execution_count ?? null } : {}), ...(outputs ? { outputs, omittedOutputCount, outputsOmitted: omittedOutputCount > 0 || outputs.some(output => output.truncated || output.richDataOmitted) } : {}) }
    })
    return { path: result.path, sha256: result.sha256, bytes: result.bytes, cellCount: result.notebook.cells.length, generation: generation(root, call.namespace, requested), cells, ...(input.cellId === undefined && end < result.notebook.cells.length ? { nextOffset: end } : {}), outputsOmitted: includeOutputs === 'none' || cells.some(cell => cell.outputsOmitted), untrustedData: true, kernelPersistent: false }
  }
  const filesystemKey = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const lock = `${filesystemKey(root)}\0${call.namespace}`
  const notebookLock = name.startsWith('notebook.') ? `notebook:${filesystemKey(realpathSync.native(path.resolve(root, requested)))}` : undefined
  if (locks.has(lock) || (notebookLock && locks.has(notebookLock))) throw new Error('Another Python/Notebook mutation is active for this conversation or notebook.')
  const releaseOperation = acquireThreadProcessOperation(root, call.namespace)
  locks.add(lock); if (notebookLock) locks.add(notebookLock)
  try {
    check()
    if (write) {
      const before = await read(); check()
      if (before.sha256 !== input.expectedSha256) throw new Error('Notebook SHA conflict; inspect again before editing.')
      directory(root, '.magicpot/notebook-snapshots')
      const operation = mutations[name as keyof typeof mutations]
      const request = notebookRequest('notebook.write', true)
      const reference = await runtime.requestTerminalApproval(request, signal)
      check()
      const common = { ...reference, authorizationId: reference.authorizationId!, idempotencyKey: randomUUID(), request, signal, beforeCommit: check, input: { ...input, path: requested, ...(operation === 'replace' ? { clearOutputs: true } : {}) } }
      return await notebook[operation](common as never)
    }
    if (!['python.execute', 'notebook.run'].includes(name)) throw new Error('Unknown thread script tool.')
    const interpreter = config().local_comfyui_config.python_cmd?.trim()
    if (!interpreter || !path.isAbsolute(interpreter)) throw new Error('Configure an explicit absolute trusted Python executable in environment settings. Shell commands and PATH fallback are not allowed.')
    const manager = getThreadProcessHost(runtime, root, dependencies.confinement)
    const python = new PythonToolHost({ workspaceRoot: root, interpreter, manager, authorization: runtime.authorization, ...(dependencies.probe ? { probe: dependencies.probe } : {}) })
    const limits = { timeoutMs: Number(input.timeoutMs ?? 30000), maxOutputBytes: Number(input.maxOutputBytes ?? 65536) }
    if (name === 'python.execute') {
      const code = input.code as string
      const base = python.createPolicyRequest({ ...identity, target: 'python.run', code, ...limits })
      const request = assertPolicyRequest({ ...base, route: { ...call.route }, input: { ...base.input, code, ...(call.background ? { background: true, survivesSuccessfulParentOnly: true } : {}) } })
      const reference = await runtime.requestTerminalApproval(request, signal)
      check()
      const validateCurrent = (availability = true) => { check(availability); if (config().local_comfyui_config.python_cmd?.trim() !== interpreter) throw new Error('Python configuration changed during execution approval.') }
      return await python.run({ ...identity, code, request, ...reference, authorizationId: reference.authorizationId!, idempotencyKey: randomUUID(), signal, timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes,
        beforeDispatch: validateCurrent, onPoll: () => validateCurrent(false), onOwned: call.onOwned ? (job) => call.onOwned!(threadProcessControl(manager, job)) : undefined, onStarted: call.onStarted ? (job) => call.onStarted!(threadProcessControl(manager, job)) : undefined })
    }
    const before = await read(); check()
    if (before.sha256 !== input.expectedSha256) throw new Error('Notebook SHA conflict; inspect again before running.')
    directory(root, `.magicpot/notebook-executions/${call.namespace}`)
    directory(root, '.magicpot/notebook-snapshots')
    const coordinator = new NotebookExecutionCoordinator(runtime.authorization, new PythonNotebookExecutionBoundary(manager, python.provenance.executable), { workspaceRoot: root, provenance: python.provenance, namespace: call.namespace, auditSink: runtime.eventStore })
    const state = { ...identity, path: requested, expectedSha256: input.expectedSha256 as string, expectedGeneration: Number(input.expectedGeneration), ...(input.cellIds ? { cellIds: input.cellIds as string[] } : {}), ...limits }
    if (generation(root, call.namespace, requested) !== input.expectedGeneration) throw new Error('Notebook generation conflict; inspect again before running.')
    const selected = before.notebook.cells.filter((cell) => cell.cell_type === 'code' && (!input.cellIds || (input.cellIds as string[]).includes(cell.id))).map((cell) => ({ id: cell.id, source: cell.source.join('') }))
    if (!selected.length || selected.length > 256 || Buffer.byteLength(JSON.stringify(selected), 'utf8') > 262144 || (input.cellIds && selected.length !== (input.cellIds as string[]).length)) throw new Error('Notebook execution requires at most 256 selected code cells and 256 KiB of source.')
    const base = coordinator.createPolicyRequest({ ...state, target: input.cellIds ? 'notebook.execute-cell' : 'notebook.execute-all' })
    const request = assertPolicyRequest({ ...base, input: { ...base.input, approvedCells: selected }, route: { ...call.route }, metadata: { warning: 'Local Python can access host files and network; OS resource limits are not a security sandbox.' } })
    const reference = await runtime.requestTerminalApproval(request, signal)
    check()
    // Re-probe interpreter identity after the user approves and before the coordinator writes payload/spawns.
    const current = new PythonToolHost({ workspaceRoot: root, interpreter, manager, ...(dependencies.probe ? { probe: dependencies.probe } : {}) })
    if (current.provenance.sha256 !== python.provenance.sha256) throw new Error('Trusted Python interpreter changed while awaiting approval.')
    return await coordinator.executeAndWait({ ...state, request, ...reference, authorizationId: reference.authorizationId!, idempotencyKey: randomUUID(), signal })
  } finally { locks.delete(lock); if (notebookLock) locks.delete(notebookLock); releaseOperation() }
}
