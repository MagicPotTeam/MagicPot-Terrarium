import { spawn, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
  MagicAgentEvent,
  PolicyConstraints,
  PolicyRequest
} from '../../../shared/magicAgentPlatform2'
import type { MagicAgentPolicyAuthorizationService } from '../policy'
import {
  TerminalRunAuthorizationError,
  TerminalRunValidationError,
  canonicalTerminalDirectory,
  isInsideTerminalRoot,
  normalizeTerminalEnvironmentKey,
  redactTerminalText,
  validateTerminalArgs,
  validateTerminalCommand
} from './terminalRun'

const STORE_DIR = '.magicpot/command-jobs'
const MAX_ARGS = 128
const MAX_ARG_CHARS = 16_384
const DEFAULT_RUNTIME_MS = 30_000
const MAX_RUNTIME_MS = 10 * 60_000
const DEFAULT_LOG_BYTES = 256 * 1024
const MAX_LOG_BYTES = 4 * 1024 * 1024
const DEFAULT_READ_BYTES = 32 * 1024
const MAX_READ_BYTES = MAX_LOG_BYTES
const REDACTION_CARRY = 256

export type CommandJobState =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed-out'
  | 'stopped'
  | 'stopped-interrupted'

export type CommandJobRecord = Readonly<{
  jobId: string
  routeKey: string
  sessionId: string
  state: CommandJobState
  outcome: 'known' | 'unknown'
  command: string
  args: readonly string[]
  cwd: string
  pid?: number
  createdAt: number
  startedAt?: number
  finishedAt?: number
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  stopOutcome?: string
  stdoutBytes: number
  stderrBytes: number
  logsTruncated: boolean
}>

type MutableRecord = {
  -readonly [K in keyof CommandJobRecord]: K extends 'args' ? string[] : CommandJobRecord[K]
}
type LiveJob = { child: ChildProcess; timer: NodeJS.Timeout; stopping: boolean }

export type CommandsBackgroundInput = Readonly<{
  authorizationId: string
  idempotencyKey: string
  request: PolicyRequest
  routeKey: string
  sessionId: string
  command: string
  args?: readonly string[]
  cwd: string
  env?: Readonly<Record<string, string>>
  shell?: false
  timeoutMs?: number
  maxLogBytes?: number
  grantId?: string
  expectedGrantUseCount?: number
  /** Revalidate trusted executable provenance after authorization and immediately before permit consumption. */
  beforeConsume?: () => void | Promise<void>
}>

export type CommandJobsSpawnProcess = typeof spawn
export type CommandJobsConfinementCapabilities = Readonly<{
  memory: boolean
  cpu: boolean
  processCount: boolean
  networkDeny: boolean
  networkHosts: boolean
}>
export type CommandJobsConfinementAdapter = Readonly<{
  platform: string
  capabilities: CommandJobsConfinementCapabilities
  prepare(constraints: PolicyConstraints): CommandJobsSpawnProcess
}>
export type CommandJobsAuditSink = Readonly<{
  appendBatch(events: readonly MagicAgentEvent<unknown>[]): unknown
  getEvent(eventId: string): MagicAgentEvent<unknown> | undefined
  getLastSequence(streamId: string): number | undefined
}>

export class CommandJobsToolHost {
  private readonly root: string
  private readonly storeDir: string
  private readonly allowedCommands?: ReadonlySet<string>
  private readonly environmentKeys: ReadonlySet<string>
  private readonly live = new Map<string, LiveJob>()
  private readonly maxConcurrentJobs: number
  private readonly spawnProcess: CommandJobsSpawnProcess
  private readonly auditSink?: CommandJobsAuditSink
  private readonly confinementAdapter?: CommandJobsConfinementAdapter

  constructor(
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    options: Readonly<{
      workspaceRoot: string
      allowedCommands?: readonly string[]
      allowedEnvironmentKeys?: readonly string[]
      maxConcurrentJobs?: number
      spawnProcess?: CommandJobsSpawnProcess
      auditSink?: CommandJobsAuditSink
      confinementAdapter?: CommandJobsConfinementAdapter
    }>
  ) {
    this.root = canonicalTerminalDirectory(options.workspaceRoot)
    this.storeDir = path.join(this.root, STORE_DIR)
    mkdirSync(this.storeDir, { recursive: true })
    const canonicalStore = path.resolve(realpathSync.native(this.storeDir))
    if (!isInsideTerminalRoot(this.root, canonicalStore))
      throw new TerminalRunValidationError('Command job metadata directory escapes the workspace.')
    this.allowedCommands = options.allowedCommands
      ? new Set(options.allowedCommands.map(commandKey))
      : undefined
    this.environmentKeys = new Set(
      (options.allowedEnvironmentKeys ?? []).map(normalizeTerminalEnvironmentKey)
    )
    this.maxConcurrentJobs = bound(options.maxConcurrentJobs ?? 4, 1, 16, 'maxConcurrentJobs')
    this.spawnProcess = options.spawnProcess ?? spawn
    this.auditSink = options.auditSink
    this.confinementAdapter = options.confinementAdapter
    this.interruptOrphanedRecords()
  }

  async background(input: CommandsBackgroundInput): Promise<CommandJobRecord> {
    if (input.shell !== undefined && input.shell !== false)
      throw new TerminalRunValidationError('commands.background requires shell:false.')
    if (this.live.size >= this.maxConcurrentJobs)
      throw new TerminalRunValidationError('Concurrent background job limit reached.')
    const command = validateTerminalCommand(input.command)
    const args = validateTerminalArgs(input.args ?? [])
    if (args.length > MAX_ARGS || args.reduce((n, value) => n + value.length, 0) > MAX_ARG_CHARS)
      throw new TerminalRunValidationError(
        'Background command arguments exceed the enforced bound.'
      )
    const cwd = canonicalTerminalDirectory(input.cwd)
    if (!isInsideTerminalRoot(this.root, cwd))
      throw new TerminalRunValidationError('cwd is outside the route workspace.')
    this.validateRequest(input.request, input, command, args)

    const authorized = this.authorization.authorize({
      authorizationId: input.authorizationId,
      request: input.request,
      evaluatedAt: Date.now(),
      idempotencyKey: `${input.idempotencyKey}:authorize`,
      ...(input.grantId === undefined ? {} : { grantId: input.grantId }),
      ...(input.expectedGrantUseCount === undefined
        ? {}
        : { expectedGrantUseCount: input.expectedGrantUseCount })
    })
    if (authorized.status !== 'authorized')
      throw new TerminalRunAuthorizationError(authorized.status, authorized.reason)
    const constraints = authorized.permit.constraints
    this.validateConstraints(command, cwd, constraints)
    const spawnProcess = this.resolveSpawnProcess(constraints)
    const env = this.buildEnvironment(input.env ?? {}, constraints)
    const timeoutMs = Math.min(
      bound(input.timeoutMs ?? DEFAULT_RUNTIME_MS, 1, MAX_RUNTIME_MS, 'timeoutMs'),
      constraints?.maxTimeoutMs ?? MAX_RUNTIME_MS
    )
    const maxLogBytes = Math.min(
      bound(input.maxLogBytes ?? DEFAULT_LOG_BYTES, 1, MAX_LOG_BYTES, 'maxLogBytes'),
      constraints?.maxOutputChars ?? MAX_LOG_BYTES
    )

    const now = Date.now()
    const record: MutableRecord = {
      jobId: randomUUID(),
      routeKey: required(input.routeKey, 'routeKey'),
      sessionId: required(input.sessionId, 'sessionId'),
      state: 'starting',
      outcome: 'unknown',
      command: redactTerminalText(command),
      args: args.map(redactTerminalText),
      cwd,
      createdAt: now,
      stdoutBytes: 0,
      stderrBytes: 0,
      logsTruncated: false
    }
    this.persist(record)

    await input.beforeConsume?.()
    // Durable one-shot consumption is the final operation before spawn.
    this.authorization.consumeExecutionPermit({
      permit: authorized.permit,
      request: input.request,
      consumedAt: Date.now(),
      idempotencyKey: `${input.idempotencyKey}:consume`
    })

    let child: ChildProcess
    try {
      child = spawnProcess(command, args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      record.state = 'failed'
      record.outcome = 'known'
      record.finishedAt = Date.now()
      record.stopOutcome = error instanceof Error ? error.message : String(error)
      this.persist(record)
      this.audit(record, 'failed')
      return Object.freeze({ ...record })
    }

    record.pid = child.pid
    record.startedAt = Date.now()
    record.state = 'running'
    this.persist(record)
    this.audit(record, 'started')
    const timer = setTimeout(() => void this.terminate(record.jobId, 'timed-out'), timeoutMs)
    this.live.set(record.jobId, { child, timer, stopping: false })
    const stopForOutputLimit = () => void this.terminate(record.jobId, 'output-limit')
    const outputBudget = createOutputBudget(maxLogBytes, stopForOutputLimit)
    const stdout = createRedactedWriter(
      this.logPath(record.jobId, 'stdout'),
      outputBudget,
      (count, truncated) => {
        record.stdoutBytes = count
        record.logsTruncated ||= truncated
      }
    )
    const stderr = createRedactedWriter(
      this.logPath(record.jobId, 'stderr'),
      outputBudget,
      (count, truncated) => {
        record.stderrBytes = count
        record.logsTruncated ||= truncated
      }
    )
    child.stdout?.on('data', stdout.write)
    child.stderr?.on('data', stderr.write)
    let finalized = false
    child.once('error', (error) => {
      if (finalized) return
      finalized = true
      stderr.write(Buffer.from(error.message))
      stdout.end()
      stderr.end()
      clearTimeout(timer)
      record.state = 'failed'
      record.outcome = 'known'
      record.stopOutcome = `spawn failed: ${error.message}`
      record.finishedAt = Date.now()
      this.persist(record)
      this.audit(record, 'failed')
      this.live.delete(record.jobId)
    })
    child.once('close', (exitCode, signal) => {
      if (finalized) return
      finalized = true
      stdout.end()
      stderr.end()
      clearTimeout(timer)
      const live = this.live.get(record.jobId)
      this.live.delete(record.jobId)
      try {
        const latest = this.load(record.jobId)
        if (
          latest.state === 'timed-out' ||
          latest.state === 'stopped' ||
          latest.stopOutcome === 'output-limit'
        )
          return
        latest.state = exitCode === 0 ? 'completed' : 'failed'
        latest.outcome = 'known'
        latest.exitCode = exitCode
        latest.signal = signal
        latest.finishedAt = Date.now()
        if (live?.stopping) latest.stopOutcome = latest.stopOutcome ?? 'process-exited-during-stop'
        this.persist(latest)
        this.audit(latest, latest.state)
      } catch {
        // A prior spawn-error handler may have finalized the record concurrently.
      }
    })
    child.unref()
    return Object.freeze({ ...record })
  }

  status(scope: { jobId: string; routeKey: string; sessionId: string }): CommandJobRecord {
    return Object.freeze({ ...this.scoped(scope) })
  }

  read(scope: {
    jobId: string
    routeKey: string
    sessionId: string
    stream: 'stdout' | 'stderr'
    cursor?: number
    maxBytes?: number
  }): Readonly<{
    data: string
    cursor: number
    nextCursor: number
    eof: boolean
    truncated: boolean
  }> {
    const record = this.scoped(scope)
    const cursor = bound(scope.cursor ?? 0, 0, Number.MAX_SAFE_INTEGER, 'cursor')
    const maxBytes = bound(scope.maxBytes ?? DEFAULT_READ_BYTES, 1, MAX_READ_BYTES, 'maxBytes')
    const file = this.logPath(record.jobId, scope.stream)
    const content = existsSync(file) ? readFileSync(file) : Buffer.alloc(0)
    const end = Math.min(content.length, cursor + maxBytes)
    return Object.freeze({
      data: content.subarray(Math.min(cursor, content.length), end).toString('utf8'),
      cursor,
      nextCursor: end,
      eof: end >= content.length && !this.live.has(record.jobId),
      truncated: record.logsTruncated
    })
  }

  async stop(scope: {
    jobId: string
    routeKey: string
    sessionId: string
  }): Promise<CommandJobRecord> {
    const record = this.scoped(scope)
    if (!this.live.has(record.jobId)) return Object.freeze({ ...record })
    await this.terminate(record.jobId, 'stopped')
    return Object.freeze({ ...this.load(record.jobId) })
  }

  private async terminate(
    jobId: string,
    state: 'timed-out' | 'stopped' | 'output-limit'
  ): Promise<void> {
    const live = this.live.get(jobId)
    if (!live || live.stopping) return
    live.stopping = true
    clearTimeout(live.timer)
    const record = this.load(jobId)
    record.state = state === 'output-limit' ? 'failed' : state
    record.outcome = 'known'
    if (state === 'output-limit') record.logsTruncated = true
    record.stopOutcome =
      state === 'timed-out'
        ? 'runtime-limit'
        : state === 'output-limit'
          ? 'output-limit'
          : 'stop-requested'
    record.finishedAt = Date.now()
    this.persist(record)
    this.audit(record, record.state)
    const pid = live.child.pid
    if (pid) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          const killer = this.spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore'
          })
          killer.once('close', () => resolve())
          killer.once('error', () => resolve())
        })
      } else {
        try {
          process.kill(-pid, 'SIGTERM')
        } catch {
          // The process may already have exited between the live check and signal delivery.
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (this.live.has(jobId))
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            // The process group may already have exited after the graceful termination window.
          }
      }
    }
  }

  private validateRequest(
    request: PolicyRequest,
    input: CommandsBackgroundInput,
    command: string,
    args: string[]
  ): void {
    const notebookRequest =
      request.action === 'notebook.execute' &&
      (request.target.id === 'notebook.execute-cell' ||
        request.target.id === 'notebook.execute-all')
    const pythonRequest =
      request.action === 'python.execute' &&
      (request.target.id === 'python.run' || request.target.id === 'python.background')
    if (
      !notebookRequest &&
      !pythonRequest &&
      (request.action !== 'terminal.execute' || request.target.id !== 'commands.background')
    )
      throw new TerminalRunValidationError('Policy request must authorize this process execution.')
    if (
      request.input.command !== command ||
      (!notebookRequest && !sameStrings(request.input.args, args))
    )
      throw new TerminalRunValidationError('Policy request command or arguments do not match.')
    if (request.filesystem?.cwd !== input.cwd)
      throw new TerminalRunValidationError('Policy request cwd does not match.')
    if (pythonRequest) {
      const interpreterSha256 = request.input.interpreterSha256
      const codeSha256 = request.input.codeSha256
      if (
        typeof interpreterSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(interpreterSha256) ||
        typeof codeSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(codeSha256)
      )
        throw new TerminalRunValidationError(
          'Python policy request lacks bound provenance digests.'
        )
    }
    if (notebookRequest) {
      const expectedSha256 = request.input.expectedSha256
      const expectedGeneration = request.input.expectedGeneration
      const interpreterSha256 = request.input.interpreterSha256
      if (
        typeof expectedSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(expectedSha256) ||
        typeof interpreterSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(interpreterSha256) ||
        !Number.isInteger(expectedGeneration) ||
        (expectedGeneration as number) < 0
      )
        throw new TerminalRunValidationError('Notebook policy request lacks bound notebook state.')
    }
  }

  private validateConstraints(command: string, cwd: string, constraints?: PolicyConstraints): void {
    if (constraints?.readOnly)
      throw new TerminalRunValidationError(
        'Policy read-only constraint forbids background execution.'
      )
    if (constraints?.requireNoShell === false)
      throw new TerminalRunValidationError(
        'Background execution requires no-shell policy constraints.'
      )
    if (
      constraints?.allowedToolNames &&
      !constraints.allowedToolNames.includes('commands.background') &&
      !constraints.allowedToolNames.includes('python.run') &&
      !constraints.allowedToolNames.includes('python.background') &&
      !constraints.allowedToolNames.includes('notebook.execute-cell') &&
      !constraints.allowedToolNames.includes('notebook.execute-all')
    )
      throw new TerminalRunValidationError('Policy does not allow commands.background.')
    if (this.allowedCommands && !this.allowedCommands.has(commandKey(command)))
      throw new TerminalRunValidationError('Command is not allowed by the Tool Host.')
    const policyCommands = stringMetadata(constraints, 'allowedCommands')
    if (policyCommands && !policyCommands.map(commandKey).includes(commandKey(command)))
      throw new TerminalRunValidationError('Command is not allowed by policy constraints.')
    if (
      constraints?.allowedRoots?.length &&
      !constraints.allowedRoots
        .map(canonicalTerminalDirectory)
        .some((root) => isInsideTerminalRoot(root, cwd))
    )
      throw new TerminalRunValidationError('cwd is outside policy allowed roots.')
  }

  private resolveSpawnProcess(constraints?: PolicyConstraints): CommandJobsSpawnProcess {
    const requested =
      numberMetadata(constraints, 'maxMemoryBytes') !== undefined ||
      numberMetadata(constraints, 'maxCpuTimeMs') !== undefined ||
      numberMetadata(constraints, 'maxProcessCount') !== undefined ||
      booleanMetadata(constraints, 'denyNetwork') === true ||
      Boolean(constraints?.networkHosts?.length)
    if (!requested) return this.spawnProcess
    if (!constraints || !this.confinementAdapter)
      throw new TerminalRunValidationError(
        'Requested OS resource or network confinement is unavailable on this Tool Host.'
      )
    const capabilities = this.confinementAdapter.capabilities
    const unsupported = [
      numberMetadata(constraints, 'maxMemoryBytes') !== undefined && !capabilities.memory
        ? 'memory'
        : undefined,
      numberMetadata(constraints, 'maxCpuTimeMs') !== undefined && !capabilities.cpu
        ? 'cpu'
        : undefined,
      numberMetadata(constraints, 'maxProcessCount') !== undefined && !capabilities.processCount
        ? 'process-count'
        : undefined,
      booleanMetadata(constraints, 'denyNetwork') === true && !capabilities.networkDeny
        ? 'network-deny'
        : undefined,
      constraints.networkHosts?.length && !capabilities.networkHosts ? 'network-hosts' : undefined
    ].filter(Boolean)
    if (unsupported.length)
      throw new TerminalRunValidationError(
        `Requested confinement is unsupported by ${this.confinementAdapter.platform}: ${unsupported.join(', ')}.`
      )
    const confinedSpawn = this.confinementAdapter.prepare(constraints)
    if (typeof confinedSpawn !== 'function')
      throw new TerminalRunValidationError(
        `Confinement adapter ${this.confinementAdapter.platform} did not provide a spawn implementation.`
      )
    return confinedSpawn
  }

  private buildEnvironment(
    requested: Readonly<Record<string, string>>,
    constraints?: PolicyConstraints
  ): NodeJS.ProcessEnv {
    if (Object.keys(requested).length > 64)
      throw new TerminalRunValidationError('Environment exceeds the enforced key bound.')
    const policyKeys = stringMetadata(constraints, 'allowedEnvironmentKeys')
    const allowed = policyKeys
      ? new Set(
          policyKeys
            .map(normalizeTerminalEnvironmentKey)
            .filter((key) => this.environmentKeys.has(key))
        )
      : this.environmentKeys
    const env: NodeJS.ProcessEnv = {}
    for (const key of [
      'PATH',
      'Path',
      'PATHEXT',
      'SystemRoot',
      'SYSTEMROOT',
      'WINDIR',
      'ComSpec'
    ]) {
      if (process.env[key]) env[key] = process.env[key]
    }
    let chars = 0
    for (const [key, value] of Object.entries(requested)) {
      if (!allowed.has(normalizeTerminalEnvironmentKey(key)))
        throw new TerminalRunValidationError(`Environment key is not allowed: ${key}`)
      if (typeof value !== 'string' || value.includes('\0'))
        throw new TerminalRunValidationError(`Invalid environment value: ${key}`)
      chars += key.length + value.length
      if (chars > 16_384)
        throw new TerminalRunValidationError('Environment exceeds the enforced size bound.')
      env[key] = value
    }
    return env
  }

  private scoped(scope: { jobId: string; routeKey: string; sessionId: string }): MutableRecord {
    const record = this.load(required(scope.jobId, 'jobId'))
    if (record.routeKey !== scope.routeKey || record.sessionId !== scope.sessionId)
      throw new TerminalRunValidationError('Command job is outside the caller route/session scope.')
    return record
  }

  private load(jobId: string): MutableRecord {
    const file = this.recordPath(jobId)
    if (!existsSync(file)) throw new TerminalRunValidationError('Command job was not found.')
    return JSON.parse(readFileSync(file, 'utf8')) as MutableRecord
  }

  private persist(record: MutableRecord): void {
    const file = this.recordPath(record.jobId)
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  }

  private interruptOrphanedRecords(): void {
    for (const name of readdirSync(this.storeDir)) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(
          readFileSync(path.join(this.storeDir, name), 'utf8')
        ) as MutableRecord
        if (record.state === 'starting' || record.state === 'running') {
          record.state = 'stopped-interrupted'
          record.outcome = 'unknown'
          record.stopOutcome = 'manager-reopened-without-live-ownership'
          record.finishedAt = Date.now()
          this.persist(record)
          this.audit(record, 'stopped-interrupted')
        }
      } catch {
        // Malformed records are never adopted or respawned.
      }
    }
  }

  private audit(record: CommandJobRecord, phase: string): void {
    if (!this.auditSink) return
    const streamId = `command-job:${record.jobId}`
    const id = createHash('sha256').update(`${streamId} ${phase}`).digest('hex')
    if (this.auditSink.getEvent(id)) return
    this.auditSink.appendBatch([
      {
        protocolVersion: '2.0.0',
        envelopeKind: 'event',
        id,
        streamId,
        sequence: (this.auditSink.getLastSequence(streamId) ?? -1) + 1,
        type: `command-job.${phase}`,
        createdAt: record.finishedAt ?? record.startedAt ?? record.createdAt,
        actor: { kind: 'system', id: 'command-jobs-tool-host' },
        payload: {
          jobId: record.jobId,
          state: record.state,
          outcome: record.outcome,
          createdAt: record.createdAt,
          startedAt: record.startedAt ?? null,
          finishedAt: record.finishedAt ?? null,
          exitCode: record.exitCode ?? null,
          signal: record.signal ?? null,
          stopOutcome: record.stopOutcome ?? null,
          stdoutBytes: record.stdoutBytes,
          stderrBytes: record.stderrBytes,
          logsTruncated: record.logsTruncated
        }
      }
    ])
  }

  private recordPath(jobId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(jobId))
      throw new TerminalRunValidationError('Invalid command job id.')
    return path.join(this.storeDir, `${jobId}.json`)
  }

  private logPath(jobId: string, stream: 'stdout' | 'stderr'): string {
    return path.join(this.storeDir, `${jobId}.${stream}.log`)
  }
}

type OutputBudget = Readonly<{
  receive(bytes: number): void
  take(bytes: number): number
  exceeded(): boolean
}>

function createOutputBudget(maxBytes: number, onLimit: () => void): OutputBudget {
  let received = 0
  let written = 0
  let limited = false
  const limit = () => {
    if (limited) return
    limited = true
    onLimit()
  }
  return {
    receive: (bytes) => {
      received += bytes
      if (received > maxBytes) limit()
    },
    take: (bytes) => {
      const accepted = Math.min(bytes, Math.max(0, maxBytes - written))
      written += accepted
      if (accepted < bytes) limit()
      return accepted
    },
    exceeded: () => limited
  }
}

function createRedactedWriter(
  file: string,
  budget: OutputBudget,
  update: (bytes: number, truncated: boolean) => void
) {
  let carry = ''
  let bytes = existsSync(file) ? statSync(file).size : 0
  let truncated = false
  const append = (text: string) => {
    if (!text || truncated) return
    const redacted = Buffer.from(redactTerminalText(text), 'utf8')
    const accepted = redacted.subarray(0, budget.take(redacted.length))
    if (accepted.length) appendFileSync(file, accepted, { mode: 0o600 })
    bytes += accepted.length
    truncated ||= accepted.length < redacted.length || budget.exceeded()
    update(bytes, truncated)
  }
  return {
    write: (chunk: Buffer | string) => {
      const incoming = Buffer.from(chunk)
      budget.receive(incoming.length)
      carry += incoming.toString('utf8')
      if (budget.exceeded()) {
        append(carry)
        carry = ''
        truncated = true
        update(bytes, truncated)
        return
      }
      if (carry.length > REDACTION_CARRY) {
        const split = carry.length - REDACTION_CARRY
        append(carry.slice(0, split))
        carry = carry.slice(split)
      }
    },
    end: () => {
      append(carry)
      carry = ''
      update(bytes, truncated)
    }
  }
}

function commandKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}
function required(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new TerminalRunValidationError(`${name} must be non-empty.`)
  return value
}
function bound(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TerminalRunValidationError(
      `${name} must be an integer from ${minimum} to ${maximum}.`
    )
  return value
}
function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  )
}
function stringMetadata(
  constraints: PolicyConstraints | undefined,
  key: string
): string[] | undefined {
  const value = constraints?.metadata?.[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new TerminalRunValidationError(`Policy metadata ${key} must be a string array.`)
  return value as string[]
}

function numberMetadata(
  constraints: PolicyConstraints | undefined,
  key: string
): number | undefined {
  const value = constraints?.metadata?.[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new TerminalRunValidationError(`Policy metadata ${key} must be a positive safe integer.`)
  return value as number
}
function booleanMetadata(
  constraints: PolicyConstraints | undefined,
  key: string
): boolean | undefined {
  const value = constraints?.metadata?.[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean')
    throw new TerminalRunValidationError(`Policy metadata ${key} must be a boolean.`)
  return value
}
