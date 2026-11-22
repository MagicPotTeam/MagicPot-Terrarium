import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentThreadProcessTools } from './agentThreadProcessTools'
import { createAgentThreadToolProvider } from './agentThreadTools'
import { agentThreadProcesses } from './agentThreadProcesses'
import type { ThreadScriptInvocation } from './agentThreadScriptTools'
import type { ThreadProcessControl } from './agentThreadProcessHost'
import type { CommandJobRecord } from '../magicAgentPlatform2/toolHost'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: electron.fromId }, BrowserWindow: { fromWebContents: electron.parent } }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'chat' }, url = 'file:///D:/app/index.html#/canvas?id=project'
const invocation = { methodName: 'svcLLMProxy.chat', senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url }
let sender: EventEmitter & { id: number; isDestroyed(): boolean; getURL(): string }
beforeEach(() => {
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  electron.fromId.mockReturnValue(sender); electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender })
})
afterEach(async () => { await agentThreadProcesses.dispose(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks() })
function setup(enabled = true) {
  let allowed = enabled, finish!: () => void, start!: () => void
  const controller = new AbortController(), gate = new Promise<void>((resolve) => { start = resolve }), done = new Promise<void>((resolve) => { finish = resolve })
  let record: CommandJobRecord = { jobId: 'real-owned-id', routeKey: JSON.stringify(route), sessionId: 'chat', command: 'secret', args: [], cwd: 'C:/owned', createdAt: 1, state: 'running', outcome: 'unknown', stdoutBytes: 8, stderrBytes: 0, logsTruncated: false }
  const control: ThreadProcessControl = { jobId: record.jobId, status: () => ({ ...record }), read: () => ({ data: 'evidence', nextCursor: 8, eof: record.state !== 'running', truncated: false }), stop: async () => { record = { ...record, state: 'stopped', outcome: 'known' }; finish(); return record } }
  const execute = vi.fn(async (call: ThreadScriptInvocation) => {
    call.signal.addEventListener('abort', () => { start(); void control.stop() }, { once: true })
    await gate; call.assertLive(); call.onOwned?.(control); call.onStarted?.(control); await done; call.signal.throwIfAborted(); return {}
  })
  const provider = createAgentThreadProcessTools({ request: { ...scope, messages: [] }, invocation, signal: controller.signal, pythonEnabled: () => allowed, shellEnabled: () => allowed, assertLive: vi.fn(), assertInvocation: vi.fn(), execute })
  const call = (name: string, args: Record<string, unknown>, id = name) => provider.callTool(name, args, { route, runId: 'r', toolCallId: id, signal: controller.signal, workspaceRootDir: 'C:/owned' })
  return { provider, call, execute, start, controller, disable: () => { allowed = false }, finish: () => { record = { ...record, state: 'completed', outcome: 'known' }; finish() } }
}
describe('request-owned background process tools', () => {
  it('reads actual admitted control manuals while starts stay disabled and does not consume their 32-call budget', async () => {
    const t = setup(false), request = vi.fn()
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => t.provider.listTools(), interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: t.controller.signal } })
    for (const tool of t.provider.listTools()) {
      const result = JSON.parse((await info.callTool('info', { name: tool.name }, { route, runId: 'info', toolCallId: tool.name })).content)
      expect(result.inputSchema).toEqual(tool.inputSchema)
      expect(result.documentation).toMatchObject({ name: tool.name, contract: 'magicpot-local-process-control-manual/v1', grantsPermission: false })
      expect(result.documentation.relatedTools).not.toContain('python.background')
      expect(result.documentation.relatedTools).not.toContain('shell.background')
    }
    expect(t.execute).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    expect(agentThreadProcesses.list(scope, { ...invocation, methodName: 'svcLLMProxy.listAgentProcesses' })).toEqual([])
    await expect(info.callTool('info', { name: 'python.background' }, { route, runId: 'info' })).rejects.toThrow('not available')
    await expect(t.call('python.background', { code: 'print(1)' })).rejects.toThrow('outside')
    for (let i = 0; i < 32; i++) expect(JSON.parse((await t.call('process.list', {})).content)).toEqual({ jobs: [] })
    await expect(t.call('process.list', {})).rejects.toThrow('budget')
    expect(t.execute).not.toHaveBeenCalled(); t.provider.release(true)
  })
  it('keeps the real owned registry/provider with a fake host independent of passive manuals and rejects invented/foreign authority before explicit controls', async () => {
    const t = setup(), request = vi.fn()
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => t.provider.listTools(), interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: t.controller.signal } })
    const readManual = async (name: string) => JSON.parse((await info.callTool('info', { name }, { route, runId: 'info', toolCallId: name })).content).documentation
    for (const name of ['process.list', 'process.status', 'process.read', 'process.wait', 'process.stop']) expect(await readManual(name)).toMatchObject({ grantsPermission: false, documentationOnly: true })
    expect(t.execute).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    const foreignId = '00000000-0000-0000-0000-000000000000'
    await expect(t.call('process.status', { job_id: foreignId })).rejects.toThrow('not available')
    const started = t.call('python.background', { code: 'print(1)' }); expect(t.execute).toHaveBeenCalledOnce(); t.start()
    const id = JSON.parse((await started).content).job.id
    expect((await readManual('process.stop')).behavior.result).toContain('awaits owned host stop')
    expect(t.execute).toHaveBeenCalledOnce()
    const current = JSON.parse((await t.call('process.status', { job_id: id })).content).job
    expect(current).toMatchObject({ status: 'running', operationSettled: false, outcome: 'unknown', cancellationRequested: false })
    expect(JSON.stringify(current)).not.toContain('secret')
    await expect(t.provider.callTool('process.stop', { job_id: id }, { route: { ...route, threadId: 'other' }, runId: 'foreign' })).rejects.toThrow('outside')
    await expect(t.call('process.stop', { job_id: id, approved: true })).rejects.toThrow('arguments')
    const foreignScope = { ...scope, conversationId: 'other', jobId: id }
    await expect(agentThreadProcesses.stop(foreignScope, { ...invocation, methodName: 'svcLLMProxy.stopAgentProcess' })).rejects.toThrow('not available')
    const read = JSON.parse((await t.call('process.read', { job_id: id, stream: 'stdout', cursor: 0, maxBytes: 16 })).content)
    expect(read).toMatchObject({ data: 'evidence', nextCursor: 8, eof: false, truncated: false, untrustedData: true })
    for (const timeout_seconds of [0, 31, 1.5]) await expect(t.call('process.wait', { job_id: id, timeout_seconds })).rejects.toThrow('arguments')
    const waiting = t.call('process.wait', { job_id: id, timeout_seconds: 1 })
    let waitReturned = false
    void waiting.then(() => { waitReturned = true })
    await Promise.resolve()
    expect(waitReturned).toBe(false)
    t.disable()
    const stopped = JSON.parse((await t.call('process.stop', { job_id: id })).content).job
    expect(stopped).toMatchObject({ status: 'stopped', operationSettled: true, outcome: 'known', cancellationRequested: true })
    expect(JSON.parse((await waiting).content).job).toMatchObject({ status: 'stopped', operationSettled: true })
    expect((await readManual('process.stop')).authority.readingUnlocksTool).toBe(false)
    expect(t.execute).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled(); t.provider.release(true)
  })
  it('reads the admitted shell-background manual without starting or consuming shared start attempts, retaining exact replay and current owned cleanup', async () => {
    const off = setup(false)
    const hidden = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => off.provider.listTools() })
    await expect(hidden.callTool('info', { name: 'shell.background' }, { route, runId: 'info' })).rejects.toThrow('not available')
    expect(off.execute).not.toHaveBeenCalled(); off.provider.release(true)
    const t = setup(), request = vi.fn()
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => t.provider.listTools(), interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: t.controller.signal } })
    for (let i = 0; i < 3; i++) {
      const result = JSON.parse((await info.callTool('info', { name: 'shell.background' }, { route, runId: 'info' })).content)
      expect(result.inputSchema).toEqual(t.provider.listTools().find(tool => tool.name === 'shell.background')!.inputSchema)
      expect(result.documentation).toMatchObject({ contract: 'magicpot-local-shell-execution-manual/v1', execution: { mode: 'background' }, limits: { backgroundStartAttemptsPerRequest: 2 } })
      expect(result.documentation.execution.budget).toContain('shared with python.background')
    }
    expect(t.execute).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    await expect(t.call('shell.background', { code: 'echo never', approved: true })).rejects.toThrow('arguments')
    const args = { code: 'echo reviewed', timeoutMs: 1000, maxOutputBytes: 512 }
    let returned = false
    const first = t.call('shell.background', args, 'shell-owned-start'), replay = t.call('shell.background', args, 'shell-owned-start')
    void first.then(() => { returned = true })
    await Promise.resolve(); expect(returned).toBe(false)
    await expect(t.call('shell.background', { code: 'changed' }, 'shell-owned-start')).rejects.toThrow('replay conflict')
    expect(t.execute).toHaveBeenCalledOnce()
    expect(t.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'shell.execute', background: true, input: args }))
    t.start()
    const submitted = JSON.parse((await first).content)
    expect(await replay).toEqual(await first)
    expect(submitted).toMatchObject({ background: true, submittedOnly: true, businessTaskVerified: false, job: { kind: 'shell', status: 'running', operationSettled: false } })
    expect(request).not.toHaveBeenCalled(); t.disable()
    expect(JSON.parse((await t.call('process.stop', { job_id: submitted.job.id })).content).job).toMatchObject({ status: 'stopped', outcome: 'known', operationSettled: true })
    expect(t.execute).toHaveBeenCalledOnce(); t.provider.release(true)
  })
  it('reads Python background documentation without spending starts, preserving its larger envelope and stricter source checks', async () => {
    const off = setup(false)
    const hidden = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => off.provider.listTools() })
    await expect(hidden.callTool('info', { name: 'python.background' }, { route, runId: 'info' })).rejects.toThrow('not available')
    await expect(off.call('python.background', { code: 'pass' })).rejects.toThrow('outside')
    expect(off.execute).not.toHaveBeenCalled(); off.provider.release(true)
    const t = setup(), request = vi.fn()
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => t.provider.listTools(), interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: t.controller.signal } })
    for (let i = 0; i < 3; i++) {
      const result = JSON.parse((await info.callTool('info', { name: 'python.background' }, { route, runId: 'info' })).content)
      expect(result.inputSchema).toEqual(t.provider.listTools().find(tool => tool.name === 'python.background')!.inputSchema)
      expect(result.documentation).toMatchObject({ contract: 'magicpot-local-python-execution-manual/v1', limits: { codeUtf8Bytes: 262144, backgroundStartAttemptsPerRequest: 2, passiveJsonArgumentBytes: 1100000, minimumTimeoutMs: 1, minimumOutputBytes: 1 } })
    }
    expect(t.execute).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    const escapedCode = `x${'\u0001'.repeat(183332)}`
    expect(Buffer.byteLength(escapedCode, 'utf8')).toBeLessThan(262144)
    expect(Buffer.byteLength(JSON.stringify({ code: escapedCode }), 'utf8')).toBeGreaterThan(1100000)
    for (const args of [{ code: ' ' }, { code: 'x\u0000' }, { code: 'a'.repeat(262145) }, { code: escapedCode }, { code: 'pass', approved: true }, { code: 'pass', timeoutMs: 0 }, { code: 'pass', maxOutputBytes: 0 }, { code: 'pass', env: { SECRET: 'no' } }]) await expect(t.call('python.background', args)).rejects.toThrow()
    expect(t.execute).not.toHaveBeenCalled()
    const args = { code: 'x'.repeat(262144), timeoutMs: 1, maxOutputBytes: 1 }
    let returned = false
    const first = t.call('python.background', args, 'python-owned-start'), replay = t.call('python.background', args, 'python-owned-start')
    void first.then(() => { returned = true })
    await Promise.resolve(); expect(returned).toBe(false)
    await expect(t.call('python.background', { code: 'changed' }, 'python-owned-start')).rejects.toThrow('replay conflict')
    expect(t.execute).toHaveBeenCalledOnce()
    expect(t.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'python.execute', input: args, background: true }))
    t.start()
    const submitted = JSON.parse((await first).content)
    expect(await replay).toEqual(await first)
    expect(submitted).toMatchObject({ background: true, submittedOnly: true, businessTaskVerified: false, job: { kind: 'python', status: 'running', operationSettled: false } })
    expect(JSON.parse((await t.call('process.stop', { job_id: submitted.job.id })).content).job.status).toBe('stopped')
    await t.call('shell.background', { code: 'echo ok' }, 'shared-second-start')
    await expect(t.call('python.background', { code: 'pass' }, 'shared-third-start')).rejects.toThrow('budget')
    expect(t.execute).toHaveBeenCalledTimes(2); expect(request).not.toHaveBeenCalled(); t.provider.release(true)
  })
  it('reserves concurrent exact replay before awaiting startup and rejects conflicting replay', async () => {
    const t = setup(), args = { code: 'print(1)' }
    const first = t.call('python.background', args, 'same'), second = t.call('python.background', args, 'same')
    await expect(t.call('python.background', { code: 'print(2)' }, 'same')).rejects.toThrow('replay conflict')
    expect(t.execute).toHaveBeenCalledOnce()
    t.start(); expect(await first).toEqual(await second)
    for (let i = 0; i < 4; i++) expect(await t.call('python.background', args, 'same')).toEqual(await first)
    expect(t.execute.mock.calls[0][0]).toMatchObject({ name: 'python.execute', background: true, conversationId: 'chat' })
    t.provider.release(true); t.controller.abort(); t.finish()
  })
  it('keeps control available when new starts are disabled and does not expose launches by default', async () => {
    const off = setup(false)
    expect(off.provider.listTools().map((tool) => tool.name)).toEqual(['process.list', 'process.status', 'process.read', 'process.wait', 'process.stop'])
    await expect(off.call('python.background', { code: 'print(1)' })).rejects.toThrow('outside')
    off.provider.release(true)
    const t = setup(), pending = t.call('shell.background', { code: 'echo x' }); t.start()
    const id = JSON.parse((await pending).content).job.id
    t.disable()
    expect(JSON.parse((await t.call('process.status', { job_id: id })).content).job.status).toBe('running')
    expect(JSON.parse((await t.call('process.read', { job_id: id, stream: 'stdout' })).content).data).toBe('evidence')
    expect(JSON.parse((await t.call('process.stop', { job_id: id })).content).job.status).toBe('stopped')
    t.provider.release(true)
  })
  it('bounds management calls, rejects extra authority fields and refuses post-navigation start', async () => {
    const t = setup()
    await expect(t.call('python.background', { code: 'print(1)', command: 'override' })).rejects.toThrow('arguments')
    await expect(t.call('process.stop', { job_id: 'foreign', pid: 123 })).rejects.toThrow('arguments')
    for (let i = 0; i < 32; i++) await t.call('process.list', {})
    await expect(t.call('process.list', {})).rejects.toThrow('budget')
    const pending = t.call('python.background', { code: 'print(1)' }).catch((e) => e)
    sender.emit('did-start-navigation'); t.start(); expect(await pending).toBeInstanceOf(Error)
    t.provider.release(false)
  })
})
