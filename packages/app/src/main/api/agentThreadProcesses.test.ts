import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentThreadProcesses } from './agentThreadProcesses'
import type { ThreadProcessControl } from './agentThreadProcessHost'
import type { CommandJobRecord } from '../magicAgentPlatform2/toolHost'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: electron.fromId }, BrowserWindow: { fromWebContents: electron.parent } }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'chat' }, url = 'file:///D:/app/index.html#/canvas?id=project'
const invocation = (name = 'chat') => ({ methodName: `svcLLMProxy.${name}`, senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url })
let processes: AgentThreadProcesses, sender: EventEmitter & { id: number; isDestroyed(): boolean; getURL(): string }
const list = () => processes.list(scope, invocation('listAgentProcesses'))
const launch = (extras: Partial<Parameters<AgentThreadProcesses['start']>[0]> = {}) => {
  let onStart!: () => void, finish!: () => void, childSignal!: AbortSignal, release!: (success: boolean) => void, stopping!: () => void
  const approval = new Promise<void>((resolve) => { onStart = resolve }), execution = new Promise<void>((resolve) => { finish = resolve }), stopGate = new Promise<void>((resolve) => { stopping = resolve })
  let delayedStop = false
  let record: CommandJobRecord = { jobId: 'host-id', routeKey: JSON.stringify(route), sessionId: 'chat', state: 'running', outcome: 'unknown', command: 'SECRET_COMMAND', args: ['SECRET_CODE'], cwd: 'C:/workspace', createdAt: 1, stdoutBytes: 12, stderrBytes: 0, logsTruncated: false }
  const control: ThreadProcessControl = { jobId: 'host-id', status: () => ({ ...record }), read: vi.fn((_stream, cursor, maxBytes) => ({ data: 'result text'.slice(cursor, cursor + maxBytes), nextCursor: Math.min(11, cursor + maxBytes), eof: record.state !== 'running', truncated: false })), stop: vi.fn(async () => { if (delayedStop) await stopGate; record = { ...record, state: 'stopped', outcome: 'known' }; finish(); return record }) }
  const pending = processes.start({ request: { ...scope, messages: [], cancellationId: 'parent-a' }, invocation: invocation(), kind: 'python', registerRelease: (fn) => { release = fn },
    execute: async (signal, assertLive, started) => {
      childSignal = signal
      signal.addEventListener('abort', () => { onStart(); if (!delayedStop) { record = { ...record, state: 'stopped', outcome: 'known' }; finish() } }, { once: true })
      await approval; assertLive(); started(control); await execution; signal.throwIfAborted()
    }, ...extras }).then((job) => ({ job }), (error: Error) => ({ error }))
  return { pending, control, start: () => onStart(), signal: () => childSignal, release: (success: boolean) => release(success), delayStop: () => { delayedStop = true }, finishStop: () => { stopping(); finish() }, finish: (state: CommandJobRecord['state'] = 'completed', outcome: CommandJobRecord['outcome'] = 'known') => { record = { ...record, state, outcome, exitCode: 0 }; finish() } }
}
beforeEach(() => {
  processes = new AgentThreadProcesses()
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url }); sender.setMaxListeners(0)
  electron.fromId.mockReturnValue(sender); electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender })
})
afterEach(async () => { await processes.dispose(); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks(); vi.useRealTimers() })
describe('owned approved background processes', () => {
  it('does not return an ID until actual start and retains independent work after successful parent release', async () => {
    const parent = new AbortController(), t = launch({ parentSignal: parent.signal })
    let returned = false; void t.pending.then(() => { returned = true })
    await Promise.resolve(); expect(returned).toBe(false)
    expect(list()).toMatchObject([{ status: 'preparing' }]); expect(JSON.stringify(list())).not.toContain('SECRET')
    t.start(); const started = await t.pending; expect(started).toHaveProperty('job')
    t.release(true); parent.abort(); expect(t.signal().aborted).toBe(false)
    t.finish(); await vi.waitFor(() => expect(list()[0]).toMatchObject({ status: 'completed', operationSettled: true }))
    const result = processes.read({ ...scope, jobId: list()[0].id, stream: 'stdout' }, invocation('readAgentProcess'))
    expect(result.data).toBe('result text'); expect(result).toHaveProperty('untrustedData', true)
  })
  it.each(['parent', 'failure', 'navigation', 'crash', 'destroyed'])('cancels independent execution on %s without leaking late data into a successor document', async (reason) => {
    const parent = new AbortController(), t = launch({ parentSignal: parent.signal }); t.start(); await t.pending
    if (reason === 'parent') parent.abort()
    else if (reason === 'failure') t.release(false)
    else sender.emit(reason === 'navigation' ? 'did-start-navigation' : reason === 'crash' ? 'render-process-gone' : 'destroyed')
    expect(t.signal().aborted).toBe(true)
    await Promise.resolve(); await Promise.resolve()
    if (!['parent', 'failure'].includes(reason)) expect(list()).toEqual([])
  })
  it('waits for real stop cleanup rather than immediately reporting cancelled', async () => {
    const t = launch(); t.start(); await t.pending; t.delayStop()
    const id = list()[0].id; let settled = false
    const stopping = processes.stop({ ...scope, jobId: id }, invocation('stopAgentProcess')).then((job) => { settled = true; return job })
    await Promise.resolve(); expect(settled).toBe(false); expect(list()[0].status).toBe('stopping')
    t.finishStop(); expect(await stopping).toMatchObject({ status: 'stopped', operationSettled: true, outcome: 'known' })
  })
  it('finishes stop cleanup but does not return old metadata after document navigation during the wait', async () => {
    const t = launch(); t.start(); await t.pending; t.delayStop()
    const pending = processes.stop({ ...scope, jobId: list()[0].id }, invocation('stopAgentProcess')).catch((error) => error)
    sender.emit('did-start-navigation'); t.finishStop()
    expect(await pending).toBeInstanceOf(Error)
    expect(list()).toEqual([])
  })
  it('retains unknown outcomes as admission blockers and does not treat parent promise settlement as completion', async () => {
    const t = launch(); t.start(); await t.pending
    t.finish('stopped', 'unknown'); await vi.waitFor(() => expect(list()[0].status).toBe('unknown'))
    const next = launch(); expect(await next.pending).toHaveProperty('error.message', expect.stringContaining('concurrency'))
    expect(list()[0].outcome).toBe('unknown')
  })
  it('isolates conversation/thread/sender and rejects inherited IPC methods', async () => {
    const t = launch(); t.start(); await t.pending; const id = list()[0].id
    for (const other of [{ ...scope, conversationId: 'other' }, { ...scope, route: { ...route, threadId: 'other' } }]) {
      expect(processes.list(other, invocation('listAgentProcesses'))).toEqual([])
      await expect(processes.stop({ ...other, jobId: id }, invocation('stopAgentProcess'))).rejects.toThrow('not available')
    }
    expect(() => processes.list(scope, { ...invocation('listAgentProcesses'), isMainFrame: false })).toThrow()
    expect(() => processes.list(scope, { ...invocation('listAgentProcesses'), senderId: 72 })).toThrow()
    expect(() => processes.read({ ...scope, jobId: id, stream: 'stdout' }, invocation())).toThrow()
    t.finish()
  })
  it('cancels only a matching parent request identity and bounds log access', async () => {
    const t = launch(); t.start(); await t.pending; const id = list()[0].id
    expect(processes.cancelConversation('chat', 'wrong', invocation('cancelConversation'))).toBe(false)
    expect(processes.cancelConversation('chat', 'parent-a')).toBe(false)
    expect(() => processes.read({ ...scope, jobId: id, stream: 'stdout', maxBytes: 16385 }, invocation('readAgentProcess'))).toThrow('range')
    expect(processes.cancelConversation('chat', 'parent-a', invocation('cancelConversation'))).toBe(true)
    expect(t.signal().aborted).toBe(true)
  })
  it('wait cancellation stops waiting only, not the independent process', async () => {
    const t = launch(); t.start(); await t.pending; t.release(true)
    const abort = new AbortController(), waiting = processes.wait({ ...scope, jobId: list()[0].id }, invocation(), 30, abort.signal).catch((error) => error)
    abort.abort(); expect(await waiting).toBeInstanceOf(Error); expect(t.signal().aborted).toBe(false)
    t.finish()
  })
  it('keeps a post-spawn setup failure with unconfirmed termination globally quarantined even without successful start', async () => {
    const uncertain: CommandJobRecord = { jobId: 'owned-unknown', routeKey: 'r', sessionId: 's', state: 'stopped', outcome: 'unknown', command: 'secret', args: [], cwd: 'root', createdAt: 1, stdoutBytes: 0, stderrBytes: 0, logsTruncated: false }
    const control: ThreadProcessControl = { jobId: uncertain.jobId, status: () => uncertain, read: () => ({ data: '', nextCursor: 0, eof: false, truncated: false }), stop: async () => uncertain }
    for (let i = 0; i < 4; i++) {
      const pending = processes.start({ request: { ...scope, conversationId: `uncertain-${i}`, messages: [] }, invocation: invocation(), kind: 'shell', registerRelease: () => undefined,
        execute: async (_signal, _live, _started, owned) => { owned(control); throw new Error('setup failure after spawn') } }).catch((e) => e)
      expect(await pending).toBeInstanceOf(Error)
      expect(processes.list({ ...scope, conversationId: `uncertain-${i}` }, invocation('listAgentProcesses'))[0]).toMatchObject({ status: 'unknown', outcome: 'unknown', operationSettled: true })
    }
    const t = launch(); expect(await t.pending).toHaveProperty('error.message', expect.stringContaining('concurrency'))
    await processes.dispose()
    const afterDispose = launch(); expect(await afterDispose.pending).toHaveProperty('error.message', expect.stringContaining('concurrency'))
  })
  it('approval denial never yields a submitted process id or raw error body', async () => {
    const t = launch({ execute: async () => { throw new Error('SECRET_PROVIDER') } })
    const result = await t.pending
    expect(result).toHaveProperty('error'); expect(String('error' in result && result.error)).not.toContain('SECRET_PROVIDER')
    expect(list()[0]).toMatchObject({ status: 'failed', operationSettled: true })
  })
})
