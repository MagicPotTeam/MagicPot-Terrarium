/* eslint-disable no-control-regex -- Strip ANSI escapes and control bytes from untrusted job output. */
import type { AgentRouteLike } from '@shared/agent'
import { AGENT_THREAD_INBOX_LIMITS } from '@shared/api/agentThreadInbox'
import type { AgentThreadJob } from '@shared/api/agentThreadJob'
import type { AgentProcessJob } from '@shared/api/agentThreadProcessJob'

/**
 * S3: when background work the agent started ends on its own, MAIN reports it into the session that
 * started it as one `job_done` thread event, the way KohakuTerrarium 2.2.3 turns a background
 * completion into a `tool_complete` trigger (core/agent/tools/runtime_tools.py `_on_bg_complete`)
 * and formats it for the model (core/controller/context.py `_tool_completion_prefix`).
 */
export type AgentThreadJobReport = {
  route: AgentRouteLike
  conversationId: string
  jobId: string
  /** The thread event's source: `background {kind}`. */
  source: string
  text: string
}
export type AgentThreadJobReportSink = {
  report(report: AgentThreadJobReport): void
  /** The agent already got the final result in this session: drop the report if it still waits. */
  withdraw(scope: { route: AgentRouteLike; conversationId: string }, jobId: string): void
}
/** Why a job ended. Only the agent's own stop and the user's stop go unreported. */
export type JobCancelCause = 'agent-stop' | 'user-stop' | 'host'

export const JOB_REPORT_IDEMPOTENCY_PREFIX = 'job_done:'
export const jobReportIdempotencyKey = (jobId: string): string =>
  `${JOB_REPORT_IDEMPOTENCY_PREFIX}${jobId}`
/** The whole report fits one inbox event (the model prefix is added separately). */
export const JOB_REPORT_CHARACTERS = AGENT_THREAD_INBOX_LIMITS.textCharacters
/** KohakuTerrarium `_ERROR_SUMMARY_LIMIT`. */
export const JOB_REPORT_ERROR_CHARACTERS = 512

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
// Control characters other than tab and newline never reach the report.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g
const clean = (text: string): string =>
  text.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '')

/** Cuts at a UTF-16 boundary: never leaves half of a surrogate pair. */
const cut = (text: string, end: number): string => {
  const sliced = text.slice(0, Math.max(0, end))
  return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced
}
const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${cut(text, limit - 1)}…`
/** Room a task line may take, so the result and its read note always fit. */
const TASK_CHARACTERS = 400

/** KohakuTerrarium `_summarize_tool_error`: no traceback frames, one line, at most 512 characters. */
export function summarizeJobError(error: string): string {
  let cleaned = error.replace(ANSI, '').trim()
  if (cleaned.includes('Traceback (most recent call last):')) {
    const lines = cleaned
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    cleaned = lines.at(-1) ?? ''
  } else cleaned = cleaned.split(/\s+/).filter(Boolean).join(' ')
  cleaned = cleaned.replace(CONTROL, '')
  return cleaned.length <= JOB_REPORT_ERROR_CHARACTERS
    ? cleaned
    : `${cut(cleaned, JOB_REPORT_ERROR_CHARACTERS - 1)}…`
}

/** KohakuTerrarium `_tool_completion_prefix`. */
function prefix(
  jobId: string,
  state: 'completed' | 'failed' | 'cancelled',
  options: { exitCode?: number | null; error?: string } = {}
): string {
  if (state === 'cancelled') return `[Tool ${jobId} cancelled]`
  if (state === 'completed') return `[Tool ${jobId} completed]`
  const exit =
    options.exitCode !== undefined && options.exitCode !== null && options.exitCode !== 0
      ? `, exit ${options.exitCode}`
      : ''
  const summary = options.error ? summarizeJobError(options.error) : ''
  return `[Tool ${jobId} failed${exit}]${summary ? `\nError: ${summary}` : ''}`
}

/** Keeps the head (like KT's UTF-8 prefix) and appends a KT-style truncation note. */
function head(
  text: string,
  budget: number,
  note: (kept: number, omitted: number) => string
): string {
  if (text.length <= budget) return text
  const probe = note(budget, text.length - budget)
  const kept = Math.max(0, budget - probe.length)
  return cut(text, kept) + note(kept, text.length - kept)
}

function fit(text: string): string {
  return text.length <= JOB_REPORT_CHARACTERS ? text : `${cut(text, JOB_REPORT_CHARACTERS - 1)}…`
}

/** The report of a background sub-agent, or undefined when it is not reported. */
export function formatSubagentJobReport(
  job: Pick<AgentThreadJob, 'id' | 'kind' | 'task' | 'status' | 'result' | 'error'>,
  cause?: JobCancelCause
): string | undefined {
  if (job.status === 'running') return undefined
  if (job.status === 'cancelled' && cause !== 'host') return undefined
  const state =
    job.status === 'cancelled'
      ? 'cancelled'
      : job.status === 'failed' || job.status === 'timeout'
        ? 'failed'
        : 'completed'
  const error =
    job.status === 'timeout'
      ? job.error || 'Sub-agent time limit exceeded.'
      : job.status === 'failed'
        ? job.error || 'Background sub-agent failed; no completed report is available.'
        : undefined
  const lines = [
    prefix(job.id, state, { error }),
    `Background ${job.kind} sub-agent. Task: ${clip(clean(job.task).replace(/\n/g, ' '), TASK_CHARACTERS)}`
  ]
  if (job.status === 'incomplete' || job.status === 'budget_exhausted')
    lines.push(`Status: ${job.status}`)
  if (state !== 'cancelled' && job.result) {
    let content = job.result
    try {
      const parsed = JSON.parse(job.result) as { content?: unknown }
      if (typeof parsed.content === 'string') content = parsed.content
    } catch {
      /* Not JSON: the stored text as it is. */
    }
    const used = lines.join('\n').length + 1
    lines.push(
      head(
        clean(content),
        JOB_REPORT_CHARACTERS - used,
        (kept, omitted) =>
          `\n... [result truncated to ${kept} characters; ${omitted} characters omitted. Read the full result with jobs.read (job_id ${job.id}) while the job is retained]`
      )
    )
  }
  return fit(lines.join('\n'))
}

export type ProcessLogHead = { data: string; nextCursor: number; eof: boolean }
/** Bytes the registry reads from the start of each log for the report (both fit one event). */
export const JOB_REPORT_LOG_BYTES = { stdout: 2000, stderr: 1200 } as const
const STREAM_NOTE_RESERVE = 300

/** The report of a background process, or undefined when it is not reported. */
export function formatProcessJobReport(
  job: Pick<AgentProcessJob, 'id' | 'kind' | 'status' | 'exitCode' | 'stdoutBytes' | 'stderrBytes'>,
  logs: { stdout?: ProcessLogHead; stderr?: ProcessLogHead },
  cause?: JobCancelCause
): string | undefined {
  if (['preparing', 'running', 'stopping'].includes(job.status)) return undefined
  if (job.status === 'stopped' && cause !== 'host') return undefined
  const exitCode = job.exitCode ?? undefined
  const state =
    job.status === 'stopped'
      ? 'cancelled'
      : job.status === 'completed' && (exitCode === undefined || exitCode === 0)
        ? 'completed'
        : 'failed'
  const error =
    job.status === 'timed-out'
      ? 'Process time limit exceeded.'
      : job.status === 'unknown'
        ? 'Process outcome is unknown; check it with process.status.'
        : state === 'failed' && (exitCode === undefined || exitCode === 0)
          ? 'Background process failed.'
          : undefined
  const lines = [prefix(job.id, state, { exitCode, error }), `Background ${job.kind} process.`]
  const streams = (['stdout', 'stderr'] as const).filter(
    (stream) => (stream === 'stdout' ? job.stdoutBytes : job.stderrBytes) > 0
  )
  for (const [index, stream] of streams.entries()) {
    const log = logs[stream]
    const total = stream === 'stdout' ? job.stdoutBytes : job.stderrBytes
    const used = lines.join('\n').length + 1
    // A later stream keeps room for its own head (at most its read size) and notes.
    const reserve = streams
      .slice(index + 1)
      .reduce((sum, later) => sum + JOB_REPORT_LOG_BYTES[later] + STREAM_NOTE_RESERVE, 0)
    const budget = JOB_REPORT_CHARACTERS - used - reserve
    const title = `${stream} (${total} bytes):`
    if (!log) {
      lines.push(
        `${title} [unavailable; read it with process.read (job_id ${job.id}, stream ${stream}) while the job is retained]`
      )
      continue
    }
    const note = (kept: number, omitted: number) =>
      `\n... [${stream} truncated to ${kept} characters; about ${omitted} characters omitted. Read it with process.read (job_id ${job.id}, stream ${stream}, cursor 0) while the job is retained]`
    const text = clean(log.data)
    let body = head(text, budget - title.length - 1, note)
    if (body === text && !log.eof)
      body += `\n... [${stream} continues after byte ${log.nextCursor}. Read the rest with process.read (job_id ${job.id}, stream ${stream}, cursor ${log.nextCursor}) while the job is retained]`
    lines.push(`${title}\n${body}`)
  }
  return fit(lines.join('\n'))
}
