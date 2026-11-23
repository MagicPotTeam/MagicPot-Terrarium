import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_THREAD_INBOX_LIMITS } from '@shared/api/agentThreadInbox'
import type { CommandJobRecord } from '../magicAgentPlatform2/toolHost'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { createJobReportSink } from './agentThreadJobReportSink'
import {
  formatProcessJobReport,
  formatSubagentJobReport,
  summarizeJobError,
  type AgentThreadJobReport
} from './agentThreadJobReports'
import { AgentThreadJobs } from './agentThreadJobs'
import type { ThreadProcessControl } from './agentThreadProcessHost'
import { AgentThreadProcesses } from './agentThreadProcesses'

const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({
  webContents: { fromId: electron.fromId },
  BrowserWindow: { fromWebContents: electron.parent }
}))
const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project',
  threadId: 'pane'
} as const
const scope = { route, conversationId: 'conversation' }
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invocation = (method = 'chat') => ({
  methodName: `svcLLMProxy.${method}`,
  senderId: 71,
  isMainFrame: true,
  senderUrl: url,
  frameUrl: url
})
const job = (over: Partial<Parameters<typeof formatSubagentJobReport>[0]> = {}) => ({
  id: 'job-1',
  kind: 'explore' as const,
  task: 'Inspect the synthetic fixture',
  status: 'completed' as const,
  result: JSON.stringify({ status: 'completed', content: 'Synthetic finding.' }),
  ...over
})
const processJob = (over: Partial<Parameters<typeof formatProcessJobReport>[0]> = {}) => ({
  id: 'proc-1',
  kind: 'python' as const,
  status: 'completed' as const,
  exitCode: 0,
  stdoutBytes: 11,
  stderrBytes: 0,
  ...over
})
const log = (data: string, eof = true) => ({ data, nextCursor: data.length, eof })

describe('job report text (KohakuTerrarium completion format)', () => {
  it('reports a completed sub-agent with its task and result', () => {
    expect(formatSubagentJobReport(job())).toBe(
      '[Tool job-1 completed]\nBackground explore sub-agent. Task: Inspect the synthetic fixture\nSynthetic finding.'
    )
  })

  it('summarizes failures like KT: last traceback line, no ANSI, at most 512 characters', () => {
    const traceback =
      'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: \u001b[31mbad\u001b[0m'
    expect(summarizeJobError(traceback)).toBe('ValueError: bad')
    expect(summarizeJobError(`a\n  ${'b'.repeat(600)}`)).toHaveLength(512)
    expect(summarizeJobError(`a ${'b'.repeat(600)}`).endsWith('…')).toBe(true)
    expect(
      formatSubagentJobReport(job({ status: 'failed', result: undefined, error: traceback }))
    ).toBe(
      '[Tool job-1 failed]\nError: ValueError: bad\nBackground explore sub-agent. Task: Inspect the synthetic fixture'
    )
    expect(formatSubagentJobReport(job({ status: 'timeout', result: undefined }))).toContain(
      '[Tool job-1 failed]\nError: Sub-agent time limit exceeded.'
    )
  })

  it('reports a host cancellation only; the agent’s own stop and the user’s stop stay silent', () => {
    const cancelled = job({ status: 'cancelled', result: undefined })
    expect(formatSubagentJobReport(cancelled, 'host')).toBe(
      '[Tool job-1 cancelled]\nBackground explore sub-agent. Task: Inspect the synthetic fixture'
    )
    expect(formatSubagentJobReport(cancelled, 'agent-stop')).toBeUndefined()
    expect(formatSubagentJobReport(cancelled, 'user-stop')).toBeUndefined()
    expect(
      formatProcessJobReport(processJob({ status: 'stopped', exitCode: undefined }), {}, 'host')
    ).toBe(
      '[Tool proc-1 cancelled]\nBackground python process.\nstdout (11 bytes): [unavailable; read it with process.read (job_id proc-1, stream stdout) while the job is retained]'
    )
    expect(
      formatProcessJobReport(processJob({ status: 'stopped' }), {}, 'agent-stop')
    ).toBeUndefined()
  })

  it('keeps a long result inside one inbox event with a note that points at jobs.read', () => {
    const text = formatSubagentJobReport(
      job({ result: JSON.stringify({ status: 'completed', content: 'x'.repeat(9000) }) })
    )!
    expect(text.length).toBeLessThanOrEqual(AGENT_THREAD_INBOX_LIMITS.textCharacters)
    expect(text).toMatch(
      /\.\.\. \[result truncated to \d+ characters; \d+ characters omitted\. Read the full result with jobs\.read \(job_id job-1\)/
    )
    expect(text.endsWith('while the job is retained]')).toBe(true)
  })

  it('caps a long task so the result note survives, and never splits a surrogate pair', () => {
    const text = formatSubagentJobReport(
      job({
        task: 't'.repeat(5000),
        result: JSON.stringify({ content: `${'x'.repeat(3797)}😀${'y'.repeat(500)}` })
      })
    )!
    expect(text.length).toBeLessThanOrEqual(AGENT_THREAD_INBOX_LIMITS.textCharacters)
    expect(text).toContain('Read the full result with jobs.read (job_id job-1)')
    expect(text.split('\n')[1].length).toBeLessThan(500)
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
    ).toBe(false)
    expect(summarizeJobError(`${'a'.repeat(510)}😀tail`)).toBe(`${'a'.repeat(510)}…`)
  })

  it('reports a process with its exit code and both log heads, cleaned and bounded', () => {
    expect(
      formatProcessJobReport(processJob({ status: 'failed', exitCode: 2, stderrBytes: 5 }), {
        stdout: log('out\r\n\u001b[1mok\u001b[0m\u0007'),
        stderr: log('boom!')
      })
    ).toBe(
      '[Tool proc-1 failed, exit 2]\nBackground python process.\nstdout (11 bytes):\nout\nok\nstderr (5 bytes):\nboom!'
    )
    const long = formatProcessJobReport(processJob({ stdoutBytes: 9000, stderrBytes: 9000 }), {
      stdout: log('o'.repeat(2000), false),
      stderr: log('e'.repeat(1200), false)
    })!
    expect(long.length).toBeLessThanOrEqual(AGENT_THREAD_INBOX_LIMITS.textCharacters)
    expect(long).toContain(
      'Read the rest with process.read (job_id proc-1, stream stdout, cursor 2000)'
    )
    expect(long).toContain('process.read (job_id proc-1, stream stderr')
    expect(
      formatProcessJobReport(processJob({ status: 'timed-out', exitCode: undefined }), {
        stdout: log('result text')
      })
    ).toContain('[Tool proc-1 failed]\nError: Process time limit exceeded.')
  })
})

describe('job report sink', () => {
  it('queues one job_done event per job for a canvas thread session and ignores other routes', () => {
    const inbox = {
      enqueue: vi.fn(() => ({ id: 'event', duplicate: false })),
      withdraw: vi.fn(() => true)
    }
    const sink = createJobReportSink(inbox)
    sink.report({
      ...scope,
      jobId: 'job-1',
      source: 'background explore',
      text: '[Tool job-1 completed]'
    })
    expect(inbox.enqueue).toHaveBeenCalledWith({
      route,
      storageScope: 'project.pane',
      conversationId: 'conversation',
      type: 'job_done',
      source: 'background explore',
      text: '[Tool job-1 completed]',
      idempotencyKey: 'job_done:job-1'
    })
    sink.withdraw(scope, 'job-1')
    expect(inbox.withdraw).toHaveBeenCalledWith(
      { route, storageScope: 'project.pane', conversationId: 'conversation' },
      'job_done:job-1'
    )
    const workspace = { channel: 'workspace', scopeType: 'project', scopeId: 'project' } as const
    sink.report({ route: workspace, conversationId: 'c', jobId: 'job-2', source: 's', text: 't' })
    sink.withdraw({ route: workspace, conversationId: 'c' }, 'job-2')
    expect(inbox.enqueue).toHaveBeenCalledOnce()
    expect(inbox.withdraw).toHaveBeenCalledOnce()
  })
})

let sender: EventEmitter & { id: number; isDestroyed: () => boolean; getURL: () => string }
let reports: AgentThreadJobReport[]
let withdrawn: string[]
const sink = () => ({
  report: (report: AgentThreadJobReport) => void reports.push(report),
  withdraw: (_scope: unknown, jobId: string) => void withdrawn.push(jobId)
})
beforeEach(() => {
  reports = []
  withdrawn = []
  sender = Object.assign(new EventEmitter(), {
    id: 71,
    isDestroyed: () => false,
    getURL: () => url
  })
  sender.setMaxListeners(0)
  electron.fromId.mockReturnValue(sender)
  electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender })
})
afterEach(() => {
  clearMagicAgentTrustedRouteBindingsForTest()
  vi.clearAllMocks()
})

describe('background sub-agents report their end once', () => {
  let jobs: AgentThreadJobs
  beforeEach(() => {
    jobs = new AgentThreadJobs()
    jobs.reportTo(sink())
  })
  afterEach(() => jobs.dispose())
  const launch = (request: Record<string, unknown> = {}) => {
    let finish!: (value: { content: string }) => void
    let fail!: (error: Error) => void
    const view = jobs.start({
      request: { ...scope, messages: [], ...request },
      invocation: invocation(),
      kind: 'explore',
      task: 'Inspect files',
      execute: () =>
        new Promise((resolve, reject) => {
          finish = resolve
          fail = reject
        })
    })
    const done = async () =>
      vi.waitFor(() =>
        expect(jobs.list(scope, invocation('listAgentJobs'))[0]?.status).not.toBe('running')
      )
    return {
      view,
      finish: (content = 'Report') =>
        finish({ content: JSON.stringify({ status: 'completed', content }) }),
      fail,
      done
    }
  }

  it('reports a completed job once, and withdraws it when the agent reads the result itself', async () => {
    const t = launch()
    t.finish('Synthetic report')
    await t.done()
    expect(reports).toEqual([
      expect.objectContaining({
        ...scope,
        jobId: t.view.job.id,
        source: 'background explore',
        text: expect.stringContaining(`[Tool ${t.view.job.id} completed]`)
      })
    ])
    // The user's read (IPC) consumes nothing; the agent's own jobs.read does.
    jobs.read({ ...scope, jobId: t.view.job.id }, invocation('readAgentJob'))
    expect(withdrawn).toEqual([])
    jobs.read({ ...scope, jobId: t.view.job.id }, invocation('chatStream'), 'chatStream')
    jobs.read({ ...scope, jobId: t.view.job.id }, invocation('chatStream'), 'chatStream')
    expect(withdrawn).toEqual([t.view.job.id])
    expect(reports).toHaveLength(1)
  })

  it('reports a failure, but neither the agent’s own stop, the user’s stop, nor a team member’s job', async () => {
    const failed = launch()
    failed.fail(new Error('synthetic failure'))
    await failed.done()
    expect(reports.map((report) => report.text)).toEqual([
      `[Tool ${failed.view.job.id} failed]\nError: Background sub-agent failed; no completed report is available.\nBackground explore sub-agent. Task: Inspect files`
    ])
    const own = launch()
    jobs.stop({ ...scope, jobId: own.view.job.id }, invocation('chat'), 'chat')
    const user = launch()
    jobs.stop({ ...scope, jobId: user.view.job.id }, invocation('stopAgentJob'))
    const member = launch({ teamMember: { teamId: 't', member: 'm' } })
    member.finish()
    await member.done()
    expect(reports).toHaveLength(1)
  })

  it('reports a job the host cancels (the document ended) as cancelled', async () => {
    const t = launch()
    sender.emit('destroyed')
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0].text, reports[0].text).toSatisfy((text: string) =>
      text.startsWith(`[Tool ${t.view.job.id} cancelled]`)
    )
  })
})

describe('background processes report their end once', () => {
  let processes: AgentThreadProcesses
  beforeEach(() => {
    processes = new AgentThreadProcesses()
    processes.reportTo(sink())
  })
  afterEach(async () => processes.dispose())
  const launch = async (request: Record<string, unknown> = {}, conversationId = 'conversation') => {
    let finish!: () => void
    const execution = new Promise<void>((resolve) => {
      finish = resolve
    })
    let record: CommandJobRecord = {
      jobId: 'host-id',
      routeKey: JSON.stringify(route),
      sessionId: 'conversation',
      state: 'running',
      outcome: 'unknown',
      command: 'synthetic',
      args: [],
      cwd: 'C:/workspace',
      createdAt: 1,
      stdoutBytes: 11,
      stderrBytes: 0,
      logsTruncated: false
    }
    const control: ThreadProcessControl = {
      jobId: 'host-id',
      status: () => ({ ...record }),
      read: vi.fn((_stream, cursor: number, maxBytes: number) => ({
        data: 'result text'.slice(cursor, cursor + maxBytes),
        nextCursor: Math.min(11, cursor + maxBytes),
        eof: record.state !== 'running',
        truncated: false
      })),
      stop: vi.fn(async () => {
        record = { ...record, state: 'stopped', outcome: 'known' }
        finish()
        return record
      })
    }
    const result = await processes.start({
      request: { ...scope, conversationId, messages: [], ...request },
      invocation: invocation(),
      kind: 'python',
      registerRelease: () => undefined,
      execute: async (signal, _assertLive, started) => {
        signal.addEventListener(
          'abort',
          () => {
            record = { ...record, state: 'stopped', outcome: 'known' }
            finish()
          },
          { once: true }
        )
        started(control)
        await execution
      }
    })
    return {
      id: result.id,
      end: (exitCode = 0) => {
        record = { ...record, state: exitCode ? 'failed' : 'completed', outcome: 'known', exitCode }
        finish()
      }
    }
  }
  const settled = async () =>
    vi.waitFor(() =>
      expect(
        processes.list(scope, invocation('listAgentProcesses')).every((job) => job.operationSettled)
      ).toBe(true)
    )

  it('reports a finished process with its output, and withdraws it when the agent waits for it', async () => {
    const t = await launch()
    t.end()
    await settled()
    expect(reports).toEqual([
      expect.objectContaining({
        jobId: t.id,
        source: 'background python',
        text: `[Tool ${t.id} completed]\nBackground python process.\nstdout (11 bytes):\nresult text`
      })
    ])
    await processes.wait({ ...scope, jobId: t.id }, invocation('chat'), 1)
    expect(withdrawn).toEqual([t.id])
  })

  it('reports a non-zero exit as failed; the agent’s own stop and a team member’s process stay silent', async () => {
    const failed = await launch({}, 'c1')
    failed.end(3)
    const own = await launch({}, 'c2')
    await processes.stop(
      { ...scope, conversationId: 'c2', jobId: own.id },
      invocation('chat'),
      'chat'
    )
    const member = await launch({ teamMember: { teamId: 't', member: 'm' } }, 'c3')
    member.end()
    await vi.waitFor(() =>
      expect(
        ['c1', 'c3']
          .flatMap((conversationId) =>
            processes.list({ route, conversationId }, invocation('listAgentProcesses'))
          )
          .every((job) => job.operationSettled)
      ).toBe(true)
    )
    expect(reports.map((report) => report.text.split('\n')[0])).toEqual([
      `[Tool ${failed.id} failed, exit 3]`
    ])
  })
})
