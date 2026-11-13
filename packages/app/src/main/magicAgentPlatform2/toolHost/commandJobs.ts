import { spawn, type ChildProcess } from 'node:child_process'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  opendirSync,
  realpathSync,
  renameSync,
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
  termination?: Readonly<{ controllerExitCode: number | null; controllerTimedOut: boolean; controllerFailed: boolean; childClosed: boolean; childExited: boolean; stdoutEnded: boolean; stderrEnded: boolean }>
  stdoutBytes: number
  stderrBytes: number
  logsTruncated: boolean
}>

type MutableRecord = {
  -readonly [K in keyof CommandJobRecord]: K extends 'args' ? string[] : CommandJobRecord[K]
}
type LiveJob = { child: ChildProcess; timer: NodeJS.Timeout; stopping: boolean; closed: Promise<void>; confirmClosed(): void }

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
  /** Synchronous last check after asynchronous preparation; must not start effects. */
  beforeDispatch?: () => void
  /** Main-owned callback after child registration, including uncertain setup failures. */
  onOwned?: (record: CommandJobRecord) => void
  /** OS spawn event, not merely submission or interpreter initialization. */
  onStarted?: (record: CommandJobRecord) => void
  signal?: AbortSignal
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
  /** Launched-job state/ownership must never be reloaded from executable-writable JSON. */
  private readonly records = new Map<string, MutableRecord>()
  private readonly logIdentities = new Map<string, { dev: number; ino: number }>()
  private readonly storeIdentity: { dev: number; ino: number }
  private readonly terminations = new Map<string, Promise<void>>()
  private readonly maxConcurrentJobs: number
  private readonly spawnProcess: CommandJobsSpawnProcess
  private readonly auditSink?: CommandJobsAuditSink
  private readonly confinementAdapter?: CommandJobsConfinementAdapter
  private readonly mandatoryResourceLimits?: Readonly<{ maxMemoryBytes: number; maxCpuTimeMs: number }>

  constructor(
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    options: Readonly<{
      workspaceRoot: string
      allowedCommands?: readonly string[]
      allowedEnvironmentKeys?: readonly string[]
      namespace?: string
      maxConcurrentJobs?: number
      spawnProcess?: CommandJobsSpawnProcess
      auditSink?: CommandJobsAuditSink
      confinementAdapter?: CommandJobsConfinementAdapter
      /** Fail closed if the actual execution permit omits or weakens these caps. */
      mandatoryResourceLimits?: Readonly<{ maxMemoryBytes: number; maxCpuTimeMs: number }>
    }>
  ) {
    this.root = canonicalTerminalDirectory(options.workspaceRoot)
    if (options.namespace && !/^[a-z0-9-]{1,64}$/.test(options.namespace)) throw new TerminalRunValidationError('Invalid command storage namespace.')
    this.storeDir = path.join(this.root, STORE_DIR, ...(options.namespace ? [options.namespace] : []))
    mkdirSync(this.storeDir, { recursive: true })
    const canonicalStore = path.resolve(realpathSync.native(this.storeDir))
    if (!isInsideTerminalRoot(this.root, canonicalStore))
      throw new TerminalRunValidationError('Command job metadata directory escapes the workspace.')
    this.storeIdentity = lstatSync(this.storeDir)
    this.assertStoreIdentity()
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
    if (options.mandatoryResourceLimits) {
      this.mandatoryResourceLimits = Object.freeze({
        maxMemoryBytes: bound(options.mandatoryResourceLimits.maxMemoryBytes, 1, Number.MAX_SAFE_INTEGER, 'maxMemoryBytes'),
        maxCpuTimeMs: bound(options.mandatoryResourceLimits.maxCpuTimeMs, 1, Number.MAX_SAFE_INTEGER, 'maxCpuTimeMs')
      })
    }
    this.interruptOrphanedRecords()
  }

  async background(input: CommandsBackgroundInput): Promise<CommandJobRecord> {
    input.signal?.throwIfAborted()
    this.assertStoreIdentity()
    if (this.records.size >= 256) throw new TerminalRunValidationError('Command job session capacity reached; start no more processes before reviewing retained jobs.')
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
    if (this.mandatoryResourceLimits) {
      for (const key of ['maxMemoryBytes', 'maxCpuTimeMs'] as const) {
        const value = numberMetadata(constraints, key)
        if (value === undefined || value > this.mandatoryResourceLimits[key]) throw new TerminalRunValidationError(`Execution permit is missing mandatory resource cap ${key} or exceeds its maximum.`)
      }
    }
    this.validateConstraints(command, cwd, input.request.target.id, constraints)
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
    input.signal?.throwIfAborted()
    this.assertNoUncertainStop()
    // Atomic post-await check: no permit/spawn can interleave before live.set below.
    if (this.live.size >= this.maxConcurrentJobs) {
      record.state = 'failed'; record.outcome = 'known'; record.finishedAt = Date.now(); record.stopOutcome = 'concurrent-job-limit-before-spawn'
      this.persist(record)
      throw new TerminalRunValidationError('Concurrent background job limit reached before spawn.')
    }
    // Durable one-shot consumption is the final operation before spawn.
    input.beforeDispatch?.()
    input.signal?.throwIfAborted()
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
    // Establish ownership BEFORE persistence, auditing or writer setup can fail.
    const timer = setTimeout(() => { void this.terminate(record.jobId, 'timed-out').catch(() => undefined) }, timeoutMs)
    let confirmClosed!: () => void
    const closed = new Promise<void>((resolve) => { confirmClosed = resolve })
    this.live.set(record.jobId, { child, timer, stopping: false, closed, confirmClosed })
    const abort = () => { void this.stop({ jobId: record.jobId, routeKey: record.routeKey, sessionId: record.sessionId }).catch(() => undefined) }
    input.signal?.addEventListener('abort', abort, { once: true })
    const detachAbort = () => input.signal?.removeEventListener('abort', abort)
    child.once('close', detachAbort)
    let stdout: { write(chunk: Buffer | string): void; end(): void } = { write: () => undefined, end: () => undefined }
    let stderr = stdout
    let finalized = false, outputFailed = false
    const saveOutcome = () => {
      try { this.persist(record); this.audit(record, record.state) }
      catch { record.stopOutcome = 'metadata-or-audit-write-failed'; this.records.set(record.jobId, record) }
    }
    const outputError = () => {
      outputFailed = true; record.logsTruncated = true
      void this.terminate(record.jobId, 'output-limit').catch(() => undefined)
    }
    child.once('spawn', () => {
      if (finalized || this.live.get(record.jobId)?.stopping || input.signal?.aborted) return
      try { input.onStarted?.(Object.freeze({ ...record, args: [...record.args] })) }
      catch { outputError() }
    })
    child.once('error', (error) => {
      if (finalized) return
      if (child.pid) { outputError(); return } // An existing child error is not exit confirmation.
      finalized = true; detachAbort(); clearTimeout(timer)
      try { stderr.write(Buffer.from(error.message)); stdout.end(); stderr.end() } catch { outputFailed = true }
      record.state = 'failed'; record.outcome = 'known'; record.stopOutcome = 'spawn-failed'; record.finishedAt = Date.now()
      this.live.get(record.jobId)?.confirmClosed(); this.live.delete(record.jobId)
      saveOutcome()
    })
    child.once('close', (exitCode, signal) => {
      if (finalized) return
      finalized = true; clearTimeout(timer)
      try { stdout.end(); stderr.end() } catch { outputFailed = true }
      const live = this.live.get(record.jobId)
      live?.confirmClosed()
      if (live?.stopping) return
      this.live.delete(record.jobId)
      record.state = exitCode === 0 && !outputFailed ? 'completed' : 'failed'
      record.outcome = 'known'; record.exitCode = exitCode; record.signal = signal; record.finishedAt = Date.now()
      if (outputFailed) record.stopOutcome = 'output-storage-failed'
      saveOutcome()
    })
    try {
      input.onOwned?.(Object.freeze({ ...record, args: [...record.args] }))
      this.persist(record); this.audit(record, 'started')
      const stopForOutputLimit = () => { void this.terminate(record.jobId, 'output-limit').catch(() => undefined) }
      const outputBudget = createOutputBudget(maxLogBytes, stopForOutputLimit)
      const makeWriter = (stream: 'stdout' | 'stderr') => {
        this.assertStoreIdentity()
        const file = this.logPath(record.jobId, stream)
        return createRedactedWriter(file, outputBudget, (count, truncated) => {
          if (stream === 'stdout') record.stdoutBytes = count; else record.stderrBytes = count
          record.logsTruncated ||= truncated
        }, (identity) => this.logIdentities.set(file, identity), () => this.assertStoreIdentity(), outputError)
      }
      stdout = makeWriter('stdout'); stderr = makeWriter('stderr')
      child.stdout?.on('data', stdout.write); child.stderr?.on('data', stderr.write)
      if (input.signal?.aborted) abort()
      child.unref()
      return Object.freeze({ ...record, args: [...record.args] })
    } catch {
      await this.terminate(record.jobId, 'stopped')
      throw new TerminalRunValidationError('Process setup failed after spawn; termination was requested and unconfirmed state remains quarantined.')
    }
  }

  status(scope: { jobId: string; routeKey: string; sessionId: string }): CommandJobRecord {
    const record = this.scoped(scope)
    return Object.freeze({ ...record, args: [...record.args] })
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
    if (scope.stream !== 'stdout' && scope.stream !== 'stderr') throw new TerminalRunValidationError('Invalid command log stream.')
    this.assertStoreIdentity()
    const file = this.logPath(record.jobId, scope.stream)
    const content = this.readBoundedFile(file, maxBytes, cursor, MAX_LOG_BYTES, this.logIdentities.get(file), true)
    return Object.freeze({
      data: content.data.toString('utf8'), cursor, nextCursor: content.end,
      eof: content.end >= content.size && !this.live.has(record.jobId), truncated: record.logsTruncated
    })
  }

  async stop(scope: {
    jobId: string
    routeKey: string
    sessionId: string
  }): Promise<CommandJobRecord> {
    const record = this.scoped(scope)
    const stopping = this.terminations.get(record.jobId)
    if (stopping) await stopping
    else if (this.live.has(record.jobId)) await this.terminate(record.jobId, 'stopped')
    const latest = this.load(record.jobId)
    return Object.freeze({ ...latest, args: [...latest.args] })
  }

  assertNoUncertainStop(): void {
    if ([...this.live.values()].some((job) => job.stopping)) throw new TerminalRunValidationError('Prior process termination is pending or unconfirmed; no new mutation is allowed.')
  }

  private terminate(jobId: string, state: 'timed-out' | 'stopped' | 'output-limit'): Promise<void> {
    const existing = this.terminations.get(jobId)
    if (existing) return existing
    const live = this.live.get(jobId)
    if (!live) return Promise.resolve()
    if (live.stopping) return Promise.resolve() // quarantined, previously unconfirmed
    live.stopping = true
    clearTimeout(live.timer)
    const operation = this.finishTermination(jobId, live, state)
    this.terminations.set(jobId, operation)
    void operation.finally(() => this.terminations.delete(jobId)).catch(() => undefined)
    return operation
  }

  private async finishTermination(jobId: string, live: LiveJob, state: 'timed-out' | 'stopped' | 'output-limit'): Promise<void> {
    let killerConfirmed = process.platform !== 'win32'
    let controllerExitCode: number | null = null, controllerTimedOut = false, controllerFailed = false
    const pid = live.child.pid
    if (pid) {
      if (process.platform === 'win32') {
        killerConfirmed = await new Promise<boolean>((resolve) => {
          let killer: ChildProcess | undefined
          const timer = setTimeout(() => { controllerTimedOut = true; killer?.kill(); resolve(false) }, 3000)
          try {
            const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
            killer = this.spawnProcess(taskkill, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
            killer.once('close', (code) => { controllerExitCode = code; clearTimeout(timer); resolve(code === 0) })
            killer.once('error', () => { controllerFailed = true; clearTimeout(timer); resolve(false) })
          } catch { controllerFailed = true; clearTimeout(timer); resolve(false) }
        })
      } else {
        try { process.kill(-pid, 'SIGTERM') } catch { /* process group may already have exited */ }
        await new Promise((resolve) => setTimeout(resolve, 250))
        try { process.kill(-pid, 'SIGKILL') } catch { /* no remaining group */ }
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const closed = await Promise.race([
      live.closed.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3000) })
    ])
    clearTimeout(timer)
    const record = this.load(jobId)
    record.state = state === 'output-limit' ? 'failed' : state
    record.termination = Object.freeze({ controllerExitCode, controllerTimedOut, controllerFailed, childClosed: closed, childExited: live.child.exitCode !== null || live.child.signalCode !== null, stdoutEnded: live.child.stdout?.readableEnded ?? true, stderrEnded: live.child.stderr?.readableEnded ?? true })
    record.outcome = closed && killerConfirmed ? 'known' : 'unknown'
    if (state === 'output-limit') record.logsTruncated = true
    record.stopOutcome = record.outcome === 'unknown' ? 'termination-unconfirmed' : state === 'timed-out' ? 'runtime-limit' : state === 'output-limit' ? 'output-limit' : 'stop-requested'
    record.finishedAt = Date.now()
    try { this.persist(record); this.audit(record, record.state) }
    catch { record.stopOutcome += ';metadata-or-audit-write-failed'; this.records.set(record.jobId, record) }
    // Keep an uncertain owner/slot quarantined until application restart.
    if (record.outcome === 'known') this.live.delete(jobId)
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
    const shellRequest = request.action === 'shell.execute' && request.target.id === 'shell.execute'
    if (
      !shellRequest &&
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
    if (shellRequest && (typeof request.input.executableSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(request.input.executableSha256) || typeof request.input.code !== 'string' || typeof request.input.codeSha256 !== 'string' || createHash('sha256').update(request.input.code).digest('hex') !== request.input.codeSha256 || request.input.explicitShell !== true)) throw new TerminalRunValidationError('Shell policy request lacks exact script and executable identity.')
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

  private validateConstraints(command: string, cwd: string, toolName: string, constraints?: PolicyConstraints): void {
    if (constraints?.readOnly)
      throw new TerminalRunValidationError(
        'Policy read-only constraint forbids background execution.'
      )
    if (constraints?.requireNoShell === false)
      throw new TerminalRunValidationError(
        'Background execution requires no-shell policy constraints.'
      )
    if (constraints?.allowedToolNames && !constraints.allowedToolNames.includes(toolName))
      throw new TerminalRunValidationError('Policy does not allow the exact requested process tool.')
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

  assertConfinement(constraints: PolicyConstraints): void { this.resolveSpawnProcess(constraints) }

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

  private assertStoreIdentity(): void {
    let current = this.root
    for (const part of path.relative(this.root, this.storeDir).split(path.sep)) {
      current = path.join(current, part)
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink() || commandKey(path.resolve(realpathSync.native(current))) !== commandKey(path.resolve(current))) throw new TerminalRunValidationError('Command metadata directory identity changed or is linked.')
    }
    const stat = lstatSync(this.storeDir)
    if (stat.dev !== this.storeIdentity.dev || stat.ino !== this.storeIdentity.ino) throw new TerminalRunValidationError('Command metadata directory was replaced.')
  }

  private readBoundedFile(file: string, maximum: number, cursor: number, sizeLimit: number, identity?: { dev: number; ino: number }, missingOk = false) {
    this.assertStoreIdentity()
    let stat: ReturnType<typeof lstatSync>
    try { stat = lstatSync(file) } catch (error) {
      if (missingOk && !identity && (error as NodeJS.ErrnoException).code === 'ENOENT') return { data: Buffer.alloc(0), end: 0, size: 0 }
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > sizeLimit || (identity && (identity.dev !== stat.dev || identity.ino !== stat.ino))) throw new TerminalRunValidationError('Command metadata/log is replaced, linked or exceeds its bound.')
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > sizeLimit) throw new TerminalRunValidationError('Command metadata/log changed while opening.')
      const from = Math.min(cursor, opened.size), buffer = Buffer.alloc(Math.min(maximum, opened.size - from))
      let count = 0
      while (count < buffer.length) { const read = readSync(fd, buffer, count, buffer.length - count, from + count); if (!read) break; count += read }
      this.assertStoreIdentity()
      const after = fstatSync(fd), current = lstatSync(file)
      if (after.nlink !== 1 || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino || after.size > sizeLimit) throw new TerminalRunValidationError('Command metadata/log changed while reading.')
      return { data: buffer.subarray(0, count), end: from + count, size: after.size }
    } finally { closeSync(fd) }
  }

  private load(jobId: string): MutableRecord {
    const owned = this.records.get(jobId)
    if (owned) return owned
    const file = this.recordPath(jobId)
    const raw = JSON.parse(this.readBoundedFile(file, 65536, 0, 65536).data.toString('utf8')) as MutableRecord
    if (!raw || raw.jobId !== jobId || typeof raw.routeKey !== 'string' || typeof raw.sessionId !== 'string' || !Array.isArray(raw.args) || raw.args.length > MAX_ARGS || raw.args.some((arg) => typeof arg !== 'string') || !['starting', 'running', 'completed', 'failed', 'timed-out', 'stopped', 'stopped-interrupted'].includes(raw.state)) throw new TerminalRunValidationError('Invalid persisted command record.')
    // Persisted records are historical data only; never adopt a PID or live authority.
    return raw
  }

  private persist(record: MutableRecord): void {
    if (!this.records.has(record.jobId) && this.records.size >= 256) throw new TerminalRunValidationError('Command job session capacity reached.')
    this.records.set(record.jobId, record)
    this.assertStoreIdentity()
    const file = this.recordPath(record.jobId), temp = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      this.assertStoreIdentity()
      if (existsSync(file)) { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new TerminalRunValidationError('Linked command record rejected.') }
      renameSync(temp, file)
    } finally { try { unlinkSync(temp) } catch { /* rename succeeded or cleanup unavailable */ } }
  }

  private interruptOrphanedRecords(): void {
    const directory = opendirSync(this.storeDir)
    try {
    for (let index = 0; index < 512; index++) {
      const entry = directory.readSync()
      if (!entry) break
      const name = entry.name
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/i.test(name)) continue
      try {
        const record = this.load(name.slice(0, -5))
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
    } finally { directory.closeSync() }
  }

  private audit(record: CommandJobRecord, phase: string): void {
    if (!this.auditSink) return
    const streamId = `command-job:${record.jobId}`
    const id = createHash('sha256').update(`${streamId}\0${phase}`).digest('hex')
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
          termination: record.termination ?? null,
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
  update: (bytes: number, truncated: boolean) => void,
  register: (identity: { dev: number; ino: number }) => void,
  assertDirectory: () => void,
  onFailure: () => void
) {
  assertDirectory()
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  const identity = fstatSync(fd)
  register({ dev: identity.dev, ino: identity.ino })
  let carry = '', bytes = 0, closed = false
  let truncated = false
  const append = (text: string) => {
    if (!text || truncated || closed) return
    assertDirectory()
    const current = lstatSync(file), opened = fstatSync(fd)
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== identity.dev || current.ino !== identity.ino || opened.size !== bytes) throw new TerminalRunValidationError('Command output log was replaced or modified.')
    const redacted = Buffer.from(redactTerminalText(text), 'utf8')
    const accepted = redacted.subarray(0, budget.take(redacted.length))
    let written = 0
    while (written < accepted.length) { const count = writeSync(fd, accepted, written, accepted.length - written, bytes + written); if (!count) throw new Error('Command output write incomplete.'); written += count }
    bytes += accepted.length
    truncated ||= accepted.length < redacted.length || budget.exceeded()
    update(bytes, truncated)
  }
  const fail = () => { truncated = true; update(bytes, true); onFailure() }
  return {
    write: (chunk: Buffer | string) => {
      if (closed || truncated) return
      try {
      const incoming = Buffer.from(chunk)
      budget.receive(incoming.length)
      carry += incoming.subarray(0, MAX_LOG_BYTES).toString('utf8')
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
      } catch { fail() }
    },
    end: () => {
      if (closed) return
      try { append(carry); carry = ''; update(bytes, truncated) } catch { fail() }
      finally { closed = true; try { closeSync(fd) } catch { /* already closed */ } }
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
