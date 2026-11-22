import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentThreadJobs } from './agentThreadJobs'
import { AGENT_THREAD_JOB_LIMITS } from '@shared/api/agentThreadJob'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'

const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: electron.fromId }, BrowserWindow: { fromWebContents: electron.parent } }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'conversation' }
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invocation = (method = 'chat') => ({ methodName: `svcLLMProxy.${method}`, senderId: 71, isMainFrame: true, senderUrl: url, frameUrl: url })
let jobs: AgentThreadJobs
let sender: EventEmitter & { id: number; isDestroyed: () => boolean; getURL: () => string }
const report = (status = 'completed', content = 'Report') => ({ content: JSON.stringify({ status, content, advisoryOnly: true }) })
const launch = (execute: Parameters<AgentThreadJobs['start']>[0]['execute'], extras: Partial<Parameters<AgentThreadJobs['start']>[0]> = {}) => jobs.start({ request: { ...scope, messages: [] }, invocation: invocation(), kind: 'explore', task: 'Inspect files', execute, ...extras })
const list = () => jobs.list(scope, invocation('listAgentJobs'))
const read = (jobId: string) => jobs.read({ ...scope, jobId }, invocation('readAgentJob'))
beforeEach(() => {
  vi.useFakeTimers()
  jobs = new AgentThreadJobs()
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  electron.fromId.mockReturnValue(sender)
  electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender })
})
afterEach(() => { jobs.dispose(); clearMagicAgentTrustedRouteBindingsForTest(); vi.useRealTimers(); vi.clearAllMocks() })

describe('owned background Agent jobs', () => {
  it('returns running immediately, survives successful parent release and exposes the completed report only on read', async () => {
    let finish!: (value: { content: string }) => void
    const execute = vi.fn(() => new Promise<{ content: string }>((resolve) => { finish = resolve }))
    const { job, release } = launch(execute)
    expect(job.status).toBe('running')
    release(true)
    expect(list()).toHaveLength(1)
    finish(report())
    await vi.advanceTimersByTimeAsync(0)
    expect(list()[0]).toMatchObject({ id: job.id, status: 'completed' })
    expect(list()[0]).not.toHaveProperty('result')
    expect(read(job.id)).toMatchObject({ text: report().content, untrustedData: true })
    expect(execute).toHaveBeenCalledOnce()
  })
  it.each(['incomplete', 'budget_exhausted'])('does not turn %s into completed', async (status) => {
    const { job } = launch(async () => report(status))
    await vi.advanceTimersByTimeAsync(0)
    expect(list()[0].status).toBe(status)
    expect(read(job.id).text).toContain(status)
  })
  it.each(['parent-abort', 'release-failed', 'stop'])('cancels on %s and refuses late results', async (reason) => {
    const controller = new AbortController()
    let finish!: (value: { content: string }) => void
    let childSignal!: AbortSignal
    const { job, release } = launch((signal) => { childSignal = signal; return new Promise((resolve) => { finish = resolve }) }, { parentSignal: controller.signal })
    if (reason === 'parent-abort') controller.abort()
    else if (reason === 'release-failed') release(false)
    else jobs.stop({ ...scope, jobId: job.id }, invocation('stopAgentJob'))
    expect(childSignal.aborted).toBe(true)
    finish(report('completed', 'LATE RESULT'))
    await vi.advanceTimersByTimeAsync(0)
    expect(read(job.id)).toMatchObject({ job: { status: 'cancelled' }, text: '' })
    expect(jobs.stop({ ...scope, jobId: job.id }, invocation('stopAgentJob')).status).toBe('cancelled')
  })
  it.each(['release-failed', 'parent-abort'])('revokes an already completed report when parent later ends with %s', async (reason) => {
    const controller = new AbortController()
    const { job, release } = launch(async () => report(), { parentSignal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    expect(read(job.id).job.status).toBe('completed')
    if (reason === 'parent-abort') controller.abort()
    else release(false)
    expect(read(job.id)).toMatchObject({ job: { status: 'cancelled' }, text: '' })
  })
  it('retains valid JSON and an explicit truncation flag for escaped reports', async () => {
    const { job } = launch(async () => report('completed', '\\"\n'.repeat(6000)))
    await vi.advanceTimersByTimeAsync(0)
    const entry = read(job.id)
    let text = ''
    for (let offset = 0; offset < entry.totalCharacters; offset += 16000) text += jobs.read({ ...scope, jobId: job.id, offset, limit: 16000 }, invocation('readAgentJob')).text
    expect(entry.totalCharacters).toBeLessThanOrEqual(32000)
    expect(entry.job.resultTruncated).toBe(true)
    expect(JSON.parse(text)).toMatchObject({ truncated: true, advisoryOnly: true })
  })
  it('detaches the old request abort signal after successful release', async () => {
    const controller = new AbortController()
    let finish!: (value: { content: string }) => void
    const started = launch(() => new Promise((resolve) => { finish = resolve }), { parentSignal: controller.signal })
    started.release(true); controller.abort()
    expect(list()[0].status).toBe('running')
    finish(report()); await vi.advanceTimersByTimeAsync(0)
    expect(read(started.job.id).job.status).toBe('completed')
  })
  it.each(['did-start-navigation', 'render-process-gone', 'destroyed'])('revokes and removes results on %s including same-URL reload', async (event) => {
    const { job } = launch(async () => report())
    await vi.advanceTimersByTimeAsync(0)
    sender.emit(event, { isMainFrame: true })
    expect(list()).toEqual([])
    expect(() => read(job.id)).toThrow('not available')
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('ignores subframe navigation and expires retained results', async () => {
    const { job } = launch(async () => report())
    await vi.advanceTimersByTimeAsync(0)
    sender.emit('did-start-navigation', { isMainFrame: false })
    expect(read(job.id).job.status).toBe('completed')
    await vi.advanceTimersByTimeAsync(AGENT_THREAD_JOB_LIMITS.retentionMs)
    expect(list()).toEqual([])
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
  it('isolates conversation, pane, project, sender and trusted main-frame access', async () => {
    const { job } = launch(async () => report())
    await vi.advanceTimersByTimeAsync(0)
    for (const other of [{ ...scope, conversationId: 'other' }, { ...scope, route: { ...route, threadId: 'other' } }]) {
      expect(jobs.list(other, invocation('listAgentJobs'))).toEqual([])
      expect(() => jobs.stop({ ...other, jobId: job.id }, invocation('stopAgentJob'))).toThrow('not available')
    }
    expect(() => jobs.list({ ...scope, route: { ...route, scopeId: 'other' } }, invocation('listAgentJobs'))).toThrow('denied')
    expect(() => jobs.list(scope, { ...invocation('listAgentJobs'), senderId: 72 })).toThrow()
    expect(() => jobs.list(scope, { ...invocation('listAgentJobs'), isMainFrame: false })).toThrow()
    expect(() => jobs.list(scope, undefined)).toThrow()
    expect(() => jobs.list(scope, invocation('chat'))).toThrow()
  })
  it('limits active/retained jobs and cancels only matching user request identities', async () => {
    const one = launch(() => new Promise(() => {}), { request: { ...scope, cancellationId: 'request-a', messages: [] } })
    const two = launch(() => new Promise(() => {}), { request: { ...scope, cancellationId: 'request-b', messages: [] } })
    expect(() => launch(async () => report())).toThrow('concurrency')
    one.release(true); two.release(true)
    expect(jobs.cancelConversation(scope.conversationId, 'request-a')).toBe(false)
    expect(jobs.cancelConversation(scope.conversationId, 'wrong', invocation('cancelConversation'))).toBe(false)
    expect(jobs.cancelConversation(scope.conversationId, 'request-a', invocation('cancelConversation'))).toBe(true)
    expect(list().find((item) => item.id === two.job.id)?.status).toBe('running')
    expect(jobs.cancelConversation(scope.conversationId, undefined, invocation('cancelConversation'))).toBe(true)
  })
  it('returns bounded ranges and protects expired job IDs', async () => {
    const { job } = launch(async () => report('completed', 'x'.repeat(20000)))
    await vi.advanceTimersByTimeAsync(0)
    expect(jobs.read({ ...scope, jobId: job.id, limit: 100 }, invocation('readAgentJob')).text).toHaveLength(100)
    expect(() => jobs.read({ ...scope, jobId: job.id, offset: -1 }, invocation('readAgentJob'))).toThrow('range')
    expect(() => jobs.read({ ...scope, jobId: job.id, limit: 20000 }, invocation('readAgentJob'))).toThrow('range')
    await vi.advanceTimersByTimeAsync(AGENT_THREAD_JOB_LIMITS.retentionMs)
    expect(() => read(job.id)).toThrow('not available')
  })
  it('wait is bounded and cancelling a wait does not stop the independent job', async () => {
    const { job } = launch(() => new Promise(() => {}))
    const controller = new AbortController()
    const waiting = jobs.wait({ ...scope, jobId: job.id }, invocation(), 1, controller.signal).catch((e) => e)
    controller.abort(); expect(await waiting).toMatchObject({ name: 'AbortError' })
    expect(list()[0].status).toBe('running')
    const timeout = jobs.wait({ ...scope, jobId: job.id }, invocation(), 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await timeout).toMatchObject({ job: { status: 'running' } })
  })
  it('caps per-scope retention and rejects wall-clock expiry before timer dispatch', async () => {
    sender.setMaxListeners(0)
    const first = launch(async () => report())
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 12; index++) {
      const task = launch(async () => report())
      task.release(true)
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(list()).toHaveLength(12)
    expect(() => read(first.job.id)).toThrow('not available')
    vi.setSystemTime(Date.now() + AGENT_THREAD_JOB_LIMITS.retentionMs + 1)
    expect(list()).toEqual([])
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
  it('does not let a foreign parent-cancel shortcut revoke background authority', () => {
    launch(() => new Promise(() => {}))
    expect(jobs.cancelConversation(scope.conversationId, undefined)).toBe(false)
    expect(jobs.cancelConversation(scope.conversationId, undefined, { ...invocation('cancelConversation'), senderId: 72 })).toBe(false)
    expect(list()[0].status).toBe('running')
  })
  it('sanitizes failures and distinguishes timeout', async () => {
    launch(async () => { throw new Error('secret-key=/private/file') })
    launch(async () => { throw new DOMException('deadline', 'TimeoutError') })
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.stringify(list())).not.toContain('secret-key')
    expect(list().map((item) => item.status)).toEqual(['timeout', 'failed'])
  })
})
