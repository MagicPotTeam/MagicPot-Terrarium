import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import type {
  PolicyConstraints,
  PolicyRequest,
  TerminalRunAuditEvidence,
  TerminalRunStatus
} from '../../../shared/magicAgentPlatform2'
import type { MagicAgentPolicyAuthorizationService } from '../policy'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_CHARS = 64_000
const REDACTED = '[REDACTED]'

export type TerminalRunInput = Readonly<{
  authorizationId: string
  idempotencyKey: string
  request: PolicyRequest
  command: string
  args?: readonly string[]
  cwd: string
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  maxOutputChars?: number
  grantId?: string
  expectedGrantUseCount?: number
}>

export type TerminalRunOutcome = Readonly<{
  status: TerminalRunStatus
  authorizationId: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
}>

export class TerminalRunValidationError extends Error {
  readonly code = 'MAGIC_AGENT_TERMINAL_RUN_VALIDATION'
  constructor(message: string) {
    super(message)
    this.name = 'TerminalRunValidationError'
  }
}

export class TerminalRunAuthorizationError extends Error {
  readonly code = 'MAGIC_AGENT_TERMINAL_RUN_AUTHORIZATION'
  constructor(
    readonly status: 'denied' | 'awaiting-approval' | 'already-consumed',
    message: string
  ) {
    super(message)
    this.name = 'TerminalRunAuthorizationError'
  }
}

export class TerminalRunToolHost {
  private readonly allowedRoots: readonly string[]
  private readonly allowedCommands?: ReadonlySet<string>
  private readonly allowedEnvironmentKeys: ReadonlySet<string>

  constructor(
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    options: Readonly<{
      allowedRoots: readonly string[]
      allowedCommands?: readonly string[]
      allowedEnvironmentKeys?: readonly string[]
      onAudit?: (evidence: TerminalRunAuditEvidence) => void | Promise<void>
    }>
  ) {
    if (!options.allowedRoots.length)
      throw new TerminalRunValidationError('At least one allowed root is required.')
    this.allowedRoots = options.allowedRoots.map(canonicalTerminalDirectory)
    this.allowedCommands = options.allowedCommands
      ? new Set(options.allowedCommands.map(commandKey))
      : undefined
    this.allowedEnvironmentKeys = new Set(
      (options.allowedEnvironmentKeys ?? []).map((key) => normalizeTerminalEnvironmentKey(key))
    )
    this.onAudit = options.onAudit
  }

  private readonly onAudit?: (evidence: TerminalRunAuditEvidence) => void | Promise<void>

  async run(input: TerminalRunInput): Promise<TerminalRunOutcome> {
    const args = validateTerminalArgs(input.args ?? [])
    const cwd = canonicalTerminalDirectory(input.cwd)
    const command = validateTerminalCommand(input.command)
    this.validateRequest(input.request, command, args, input.cwd)

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
    this.validateConstraints(command, args, cwd, constraints)
    const env = this.buildEnvironment(input.env ?? {}, constraints)
    const timeoutMs = boundPositive(
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      constraints?.maxTimeoutMs,
      'timeoutMs'
    )
    const maxOutputChars = boundPositive(
      input.maxOutputChars ?? DEFAULT_OUTPUT_CHARS,
      constraints?.maxOutputChars,
      'maxOutputChars'
    )

    // This durable, one-shot transition must succeed immediately before spawn.
    this.authorization.consumeExecutionPermit({
      permit: authorized.permit,
      request: input.request,
      consumedAt: Date.now(),
      idempotencyKey: `${input.idempotencyKey}:consume`
    })

    const startedAt = Date.now()
    const outcome = await executeProcess(command, args, cwd, env, timeoutMs, maxOutputChars)
    const result = Object.freeze({
      ...outcome,
      authorizationId: input.authorizationId,
      durationMs: Date.now() - startedAt
    })
    await this.onAudit?.({
      tool: 'terminal.run',
      authorizationId: result.authorizationId,
      status: result.status,
      commandSha256: sha256TerminalText(command),
      commandChars: command.length,
      argsSha256: sha256TerminalText(JSON.stringify(args)),
      argsCount: args.length,
      argsChars: args.reduce((count, arg) => count + arg.length, 0),
      cwdSha256: sha256TerminalText(cwd),
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutSha256: sha256TerminalText(result.stdout),
      stdoutChars: result.stdout.length,
      stderrSha256: sha256TerminalText(result.stderr),
      stderrChars: result.stderr.length,
      truncated: result.truncated,
      durationMs: result.durationMs
    })
    return result
  }

  private validateRequest(
    request: PolicyRequest,
    command: string,
    args: readonly string[],
    requestedCwd: string
  ): void {
    if (request.action !== 'terminal.execute')
      throw new TerminalRunValidationError('Policy request action must be terminal.execute.')
    if (request.input.command !== command || !sameStrings(request.input.args, args))
      throw new TerminalRunValidationError('Policy request command or arguments do not match.')
    if (request.filesystem?.cwd !== requestedCwd)
      throw new TerminalRunValidationError('Policy request cwd does not match.')
  }

  private validateConstraints(
    command: string,
    args: readonly string[],
    cwd: string,
    constraints?: PolicyConstraints
  ): void {
    if (constraints?.readOnly && command !== 'git' && !args.some((arg) => arg === '--version'))
      throw new TerminalRunValidationError('Policy read-only constraint forbids terminal.run.')
    if (
      constraints?.allowedToolNames &&
      !constraints.allowedToolNames.includes('terminal.run') &&
      !args.includes('--version')
    )
      throw new TerminalRunValidationError('Policy does not allow terminal.run.')
    const commandAllowlist = stringMetadata(constraints, 'allowedCommands')
    const configured = this.allowedCommands
    if (configured && !configured.has(commandKey(command)))
      throw new TerminalRunValidationError('Command is not allowed by the Tool Host.')
    if (commandAllowlist && !commandAllowlist.map(commandKey).includes(commandKey(command)))
      throw new TerminalRunValidationError('Command is not allowed by policy constraints.')
    if (!this.allowedRoots.some((root) => isInsideTerminalRoot(root, cwd)))
      throw new TerminalRunValidationError('cwd is outside Tool Host allowed roots.')
    const policyRoots = constraints?.allowedRoots?.map(canonicalTerminalDirectory)
    if (policyRoots && !policyRoots.some((root) => isInsideTerminalRoot(root, cwd)))
      throw new TerminalRunValidationError('cwd is outside policy allowed roots.')
  }

  private buildEnvironment(
    requested: Readonly<Record<string, string>>,
    constraints?: PolicyConstraints
  ): NodeJS.ProcessEnv {
    const policyKeys = stringMetadata(constraints, 'allowedEnvironmentKeys')
    const permitted = policyKeys
      ? new Set(
          policyKeys
            .map(normalizeTerminalEnvironmentKey)
            .filter((key) => this.allowedEnvironmentKeys.has(key))
        )
      : this.allowedEnvironmentKeys
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(requested)) {
      const normalized = normalizeTerminalEnvironmentKey(key)
      if (!permitted.has(normalized))
        throw new TerminalRunValidationError(`Environment key is not allowed: ${key}`)
      if (typeof value !== 'string' || value.includes('\0'))
        throw new TerminalRunValidationError(`Invalid environment value: ${key}`)
      env[key] = value
    }
    return env
  }
}

function executeProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputChars: number
): Promise<Omit<TerminalRunOutcome, 'authorizationId' | 'durationMs'>> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: 'pipe'
    })
    let stdout = ''
    let stderr = ''
    let status: TerminalRunOutcome['status'] = 'completed'
    let truncated = false
    let outputChars = 0
    let settled = false
    const stop = (nextStatus: 'timed-out' | 'output-limit') => {
      if (status === 'completed') status = nextStatus
      const pid = child.pid
      if (!pid) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.once('error', () => child.kill('SIGKILL'))
      } else {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }
    const timer = setTimeout(() => stop('timed-out'), timeoutMs)
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = chunk.toString()
      const remaining = Math.max(0, maxOutputChars - outputChars)
      const accepted = text.slice(0, remaining)
      outputChars += accepted.length
      if (target === 'stdout') stdout += accepted
      else stderr += accepted
      if (accepted.length < text.length) {
        truncated = true
        stop('output-limit')
      }
    }
    child.stdout.on('data', (chunk) => collect('stdout', chunk))
    child.stderr.on('data', (chunk) => collect('stderr', chunk))
    child.once('error', (error) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({
        status: 'failed',
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`,
        truncated
      })
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({
        status: status === 'completed' && exitCode !== 0 ? 'failed' : status,
        exitCode,
        signal,
        stdout,
        stderr,
        truncated
      })
    })
  })
}

export function canonicalTerminalDirectory(value: string): string {
  if (!value || value.includes('\0')) throw new TerminalRunValidationError('Invalid directory.')
  try {
    return path.resolve(realpathSync.native(value))
  } catch {
    throw new TerminalRunValidationError(`Directory does not exist: ${value}`)
  }
}

export function isInsideTerminalRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function validateTerminalCommand(value: string): string {
  if (!value || value.includes('\0')) throw new TerminalRunValidationError('Invalid command.')
  return value
}

export function validateTerminalArgs(values: readonly string[]): string[] {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== 'string' || value.includes('\0'))
  )
    throw new TerminalRunValidationError('Arguments must be strings without NUL bytes.')
  return [...values]
}

function commandKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function normalizeTerminalEnvironmentKey(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new TerminalRunValidationError(`Invalid environment key: ${value}`)
  return process.platform === 'win32' ? value.toUpperCase() : value
}

function boundPositive(value: number, constraint: number | undefined, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TerminalRunValidationError(`${name} must be a positive integer.`)
  return constraint === undefined ? value : Math.min(value, constraint)
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((v, i) => v === expected[i])
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

export function redactTerminalText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(
      /((?:password|passwd|pwd|token|api[_-]?key|secret)\s*=\s*)[^\s;&,]+/gi,
      `$1${REDACTED}`
    )
}

function sha256TerminalText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
