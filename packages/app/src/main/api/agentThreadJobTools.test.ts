import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareCanvasAgentTools } from './canvasAgentTools'
import { agentThreadJobs } from './agentThreadJobs'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'

const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: electron.fromId }, BrowserWindow: { fromWebContents: electron.parent } }))
vi.mock('../config/config', () => ({ getConfig: () => ({}) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'conversation' }
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invocation = (method = 'chat') => ({ methodName: `svcLLMProxy.${method}`, senderId: 71, isMainFrame: true, senderUrl: url, frameUrl: url })
let sender: EventEmitter & { id: number; isDestroyed: () => boolean; getURL: () => string }
const read = { name: 'files.read', description: 'Read text', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } }
beforeEach(() => {
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  electron.fromId.mockReturnValue(sender)
  electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender })
})
afterEach(() => { agentThreadJobs.dispose(); clearMagicAgentTrustedRouteBindingsForTest(); vi.clearAllMocks() })

const make = (assertTeamActive?: () => void) => {
  const sample = vi.fn().mockResolvedValue({ content: 'Report from child' })
  const callReadTool = vi.fn(async () => ({ content: 'Evidence' }))
  const prepared = prepareCanvasAgentTools({ ...scope, messages: [{ role: 'user' as const, content: 'Visible parent text' }] }, invocation(), {
    local: true, terminalEnabled: false, createSubagentClient: async () => ({ chat: sample, supportsIsolatedReadOnlyTurns: true }), listTools: () => [read],
    ...(assertTeamActive ? { assertTeamActive } : {}),
    callSubagentReadTool: (name, args, context, assertLive) => prepared.readAdmission!.run(name, context.signal, () => callReadTool(), assertLive)
  })
  const call = (name: string, args: Record<string, unknown>, id = `${name}-call`) => prepared.admission!.run(name, undefined, () => prepared.toolProvider!.callTool(name, args, { route, runId: 'parent-run', toolCallId: id }))
  return { prepared, call, sample, callReadTool }
}

describe('thread job tools and detached read admission', () => {
  it('keeps reading after parent success and follow-up request can inspect the same conversation', async () => {
    const first = make()
    let resume!: (value: unknown) => void
    first.sample.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve }))
    const launched = JSON.parse((await first.call('explore', { task: 'Investigate readme.md', run_in_background: true })).content)
    expect(launched).toMatchObject({ background: true, job: { status: 'running' } })
    await vi.waitFor(() => expect(first.sample).toHaveBeenCalledOnce())
    first.prepared.dispose!(true)
    resume({ content: '{"toolName":"files.read","args":{"path":"readme.md"}}' })
    await vi.waitFor(() => expect(first.callReadTool).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(agentThreadJobs.list(scope, invocation('listAgentJobs'))[0].status).toBe('completed'))
    const next = make()
    try {
      expect(JSON.parse((await next.call('jobs.list', {})).content).jobs).toHaveLength(1)
      expect(JSON.parse((await next.call('jobs.read', { job_id: launched.job.id })).content).text).toContain('Report from child')
      expect(JSON.parse((await next.call('jobs.status', { job_id: launched.job.id })).content).job.status).toBe('completed')
    } finally { next.prepared.dispose!() }
    await expect(first.call('info', {})).rejects.toThrow('ended')
    await expect(first.prepared.readAdmission!.run('files.write', new AbortController().signal, async () => undefined, () => {})).rejects.toThrow('read-only')
    await expect(first.prepared.readAdmission!.run('files.read', new AbortController().signal, async () => undefined)).rejects.toThrow('ended')
  })
  it('deduplicates the exact tool call identity and rejects conflicting replay', async () => {
    const { prepared, call, sample } = make()
    try {
      sample.mockImplementation(() => new Promise(() => {}))
      const a = await call('explore', { task: 'Inspect', run_in_background: true }, 'duplicate')
      const b = await call('explore', { task: 'Inspect', run_in_background: true }, 'duplicate')
      for (let index = 0; index < 5; index++) expect(await call('explore', { task: 'Inspect', run_in_background: true }, 'duplicate')).toEqual(a)
      await call('critic', { task: 'Second distinct job', run_in_background: true }, 'second')
      expect(a).toEqual(b)
      expect(agentThreadJobs.list(scope, invocation('listAgentJobs'))).toHaveLength(2)
      await expect(call('explore', { task: 'Changed', run_in_background: true }, 'duplicate')).rejects.toThrow('replay conflict')
    } finally { prepared.dispose!() }
  })
  it('revokes a pending jobs.wait when its document navigates', async () => {
    const { prepared, call, sample } = make()
    sample.mockImplementation(() => new Promise(() => {}))
    try {
      const launched = JSON.parse((await call('explore', { task: 'Wait', run_in_background: true })).content)
      const waiting = call('jobs.wait', { job_id: launched.job.id, timeout_seconds: 30 }).catch((e) => e)
      sender.emit('did-start-navigation', { isMainFrame: true })
      expect(await waiting).toBeInstanceOf(Error)
      expect(agentThreadJobs.list(scope, invocation('listAgentJobs'))).toEqual([])
    } finally { prepared.dispose!() }
  })
  it('stop_task stops only one child and malformed/cross-scope queries fail', async () => {
    const { prepared, call, sample } = make()
    sample.mockImplementation(() => new Promise(() => {}))
    try {
      const a = JSON.parse((await call('fork', { task: 'A', run_in_background: true }, 'a')).content)
      const b = JSON.parse((await call('critic', { task: 'B', run_in_background: true }, 'b')).content)
      expect(JSON.parse((await call('stop_task', { job_id: a.job.id })).content).job.status).toBe('cancelled')
      expect(JSON.parse((await call('jobs.status', { job_id: b.job.id })).content).job.status).toBe('running')
      await expect(call('jobs.read', { job_id: b.job.id, conversationId: 'other' })).rejects.toThrow('arguments')
      await expect(call('jobs.wait', { job_id: b.job.id, timeout_seconds: 31 })).rejects.toThrow('arguments')
      await expect(call('stop_task', { job_id: 'other-session' })).rejects.toThrow('not available')
    } finally { prepared.dispose!() }
  })
})

describe('background job of a team member after End', () => {
  const readRequest = { content: '{"toolName":"files.read","args":{"path":"readme.md"}}' }
  const ended = () => { throw new Error('Team has ended.') }
  const job = (id: string) => agentThreadJobs.list(scope, invocation('listAgentJobs')).find((entry) => entry.id === id)
  it('fails a member job before its next step after End while an ordinary job runs to completion', async () => {
    const assertTeamActive = vi.fn()
    const member = make(assertTeamActive), ordinary = make()
    member.sample.mockResolvedValueOnce(readRequest)
    ordinary.sample.mockResolvedValueOnce(readRequest)
    // End is recorded while the member job's read runs; the read itself completes.
    member.callReadTool.mockImplementationOnce(async () => { assertTeamActive.mockImplementation(ended); return { content: 'Evidence' } })
    const a = JSON.parse((await member.call('explore', { task: 'Member job', run_in_background: true })).content)
    const b = JSON.parse((await ordinary.call('explore', { task: 'Ordinary job', run_in_background: true })).content)
    member.prepared.dispose!(true); ordinary.prepared.dispose!(true)
    await vi.waitFor(() => expect(job(a.job.id)?.status).toBe('failed'))
    await vi.waitFor(() => expect(job(b.job.id)?.status).toBe('completed'))
    expect(member.callReadTool).toHaveBeenCalledOnce()
    expect(member.sample).toHaveBeenCalledOnce()
    expect(assertTeamActive.mock.results.at(-1)).toMatchObject({ type: 'throw', value: new Error('Team has ended.') })
    expect(ordinary.callReadTool).toHaveBeenCalledOnce()
    expect(ordinary.sample).toHaveBeenCalledTimes(2)
  })
  it('keeps the report of a member job that finished before End when the parent turn succeeded', async () => {
    const assertTeamActive = vi.fn()
    const member = make(assertTeamActive)
    const launched = JSON.parse((await member.call('critic', { task: 'Review', run_in_background: true })).content)
    member.prepared.dispose!(true)
    await vi.waitFor(() => expect(job(launched.job.id)?.status).toBe('completed'))
    assertTeamActive.mockImplementation(ended)
    const result = agentThreadJobs.read({ ...scope, jobId: launched.job.id }, invocation('readAgentJob'))
    expect(result.job.status).toBe('completed')
    expect(result.text).toContain('Report from child')
    expect(member.sample).toHaveBeenCalledOnce()
  })
  it.each([
    { outcome: 'ended' as const, label: 'a parent cut by End keeps both' },
    { outcome: false as const, label: 'any other failed parent revokes both, as before' }
  ])('parent disposed with $outcome: $label (completed report, running job)', async ({ outcome }) => {
    const assertTeamActive = vi.fn()
    const member = make(assertTeamActive)
    let resume!: (value: unknown) => void
    member.sample.mockResolvedValueOnce({ content: 'Report from child' }).mockImplementationOnce(() => new Promise((resolve) => { resume = resolve }))
    const done = JSON.parse((await member.call('critic', { task: 'Review', run_in_background: true }, 'done-job')).content)
    await vi.waitFor(() => expect(job(done.job.id)?.status).toBe('completed'))
    const running = JSON.parse((await member.call('explore', { task: 'Investigate', run_in_background: true }, 'running-job')).content)
    await vi.waitFor(() => expect(member.sample).toHaveBeenCalledTimes(2))
    assertTeamActive.mockImplementation(ended) // End is recorded while the parent turn still runs
    member.prepared.dispose!(outcome)
    if (outcome === 'ended') {
      expect(agentThreadJobs.read({ ...scope, jobId: done.job.id }, invocation('readAgentJob'))).toMatchObject({ job: { status: 'completed' }, text: expect.stringContaining('Report from child') })
      expect(job(running.job.id)?.status).toBe('running')
      // The running job stops by itself before its next read, as a failed job.
      resume({ content: '{"toolName":"files.read","args":{"path":"readme.md"}}' })
      await vi.waitFor(() => expect(job(running.job.id)?.status).toBe('failed'))
      expect(member.callReadTool).not.toHaveBeenCalled()
    } else {
      expect(agentThreadJobs.read({ ...scope, jobId: done.job.id }, invocation('readAgentJob'))).toMatchObject({ job: { status: 'cancelled' }, text: '' })
      expect(job(running.job.id)?.status).toBe('cancelled')
      resume({ content: 'late' })
    }
  })
})
