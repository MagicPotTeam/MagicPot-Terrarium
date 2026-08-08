import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { PolicyJsonRecord, PolicyRequest } from '../../../shared/magicAgentPlatform2'
import { createTerminalPolicyRequest } from '../../../shared/magicAgentPlatform2'
import type { CommandJobRecord, CommandsBackgroundInput } from './commandJobs'
import { CommandJobsToolHost } from './commandJobs'
import { TerminalRunValidationError, isInsideTerminalRoot } from './terminalRun'

const FLAGS = ['-I', '-S', '-B', '-u'] as const
const MAX_CODE_BYTES = 256 * 1024
const MAX_ARTIFACTS = 32
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
const TERMINAL = new Set(['completed', 'failed', 'timed-out', 'stopped', 'stopped-interrupted'])
const SAFE_ENV = {
  PIP_NO_INDEX: '1',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
  PYTHONNOUSERSITE: '1'
} as const

export type PythonProvenance = Readonly<{
  executable: string
  sha256: string
  implementation: string
  version: string
  platform: string
}>
export type PythonProbe = (executable: string) => PythonProvenance
export type PythonJobManager = Pick<CommandJobsToolHost, 'background' | 'status' | 'read' | 'stop'>
export type PythonExecuteInput = Readonly<{
  authorizationId: string
  idempotencyKey: string
  request: PolicyRequest
  routeKey: string
  sessionId: string
  code?: string
  file?: string
  cwd?: string
  artifacts?: readonly string[]
  timeoutMs?: number
  maxOutputBytes?: number
  grantId?: string
  expectedGrantUseCount?: number
}>

export class PythonToolHost {
  private readonly root: string
  private readonly executable: string
  private readonly provenance: PythonProvenance
  private readonly manager: PythonJobManager
  private readonly probe: PythonProbe

  constructor(
    options: Readonly<{
      workspaceRoot: string
      interpreter: string
      authorization?: ConstructorParameters<typeof CommandJobsToolHost>[0]
      manager?: PythonJobManager
      probe?: PythonProbe
    }>
  ) {
    this.root = canonicalExistingDirectory(options.workspaceRoot, 'workspaceRoot')
    if (!options.interpreter?.trim())
      throw new TerminalRunValidationError('A trusted Python interpreter must be configured.')
    this.probe = options.probe ?? probePythonInterpreter
    this.provenance = this.probe(options.interpreter)
    this.executable = this.provenance.executable
    this.manager =
      options.manager ??
      new CommandJobsToolHost(required(options.authorization, 'authorization'), {
        workspaceRoot: this.root,
        allowedCommands: [this.executable],
        allowedEnvironmentKeys: Object.keys(SAFE_ENV)
      })
  }

  createPolicyRequest(
    input: Omit<PythonExecuteInput, 'authorizationId' | 'idempotencyKey' | 'request'> & {
      origin?: 'assistant' | 'agent' | 'graph'
      target: 'python.run' | 'python.background'
      actor?: { kind: string; id: string }
      route?: PolicyJsonRecord
    }
  ): PolicyRequest {
    const prepared = this.prepare(input)
    const terminal = createTerminalPolicyRequest({
      requestId: randomUUID(),
      origin: input.origin ?? 'assistant',
      actor: input.actor ?? { kind: 'system', id: 'python-tool-host' },
      target: { kind: 'tool', id: input.target },
      route: input.route,
      sessionId: input.sessionId,
      command: this.executable,
      args: prepared.args,
      cwd: prepared.cwd,
      filesystem: { cwd: prepared.cwd, paths: prepared.artifactPaths, allowedRoots: [this.root] }
    })
    return Object.freeze({
      ...terminal,
      action: 'python.execute',
      input: {
        command: this.executable,
        args: prepared.args,
        interpreterSha256: this.provenance.sha256,
        codeSha256: prepared.codeSha256,
        cwd: prepared.cwd,
        artifacts: prepared.artifactPaths,
        timeoutMs: input.timeoutMs ?? 30_000,
        maxOutputBytes: input.maxOutputBytes ?? 256 * 1024
      },
      effects: [
        {
          kind: 'process.execute',
          target: this.executable,
          risk: 'high',
          metadata: {
            implementation: this.provenance.implementation,
            version: this.provenance.version
          }
        },
        { kind: 'filesystem.read', target: prepared.cwd, risk: 'high' },
        ...(prepared.artifactPaths.length
          ? [{ kind: 'filesystem.write', target: prepared.cwd, risk: 'high' as const }]
          : [])
      ],
      metadata: {
        limitation: 'No OS sandbox, network confinement, or native-extension confinement.'
      }
    })
  }

  async background(
    input: PythonExecuteInput
  ): Promise<Readonly<{ job: CommandJobRecord; provenance: PythonProvenance }>> {
    const prepared = this.prepare(input)
    this.validateRequest(input.request, 'python.background', prepared)
    const job = await this.manager.background(this.managerInput(input, prepared))
    return Object.freeze({ job, provenance: this.provenance })
  }

  async run(input: PythonExecuteInput): Promise<
    Readonly<{
      job: CommandJobRecord
      stdout: string
      stderr: string
      provenance: PythonProvenance
      artifacts: readonly Readonly<{ path: string; size: number; sha256: string }>[]
    }>
  > {
    const prepared = this.prepare(input)
    this.validateRequest(input.request, 'python.run', prepared)
    const started = await this.manager.background(this.managerInput(input, prepared))
    let job: CommandJobRecord = started
    for (;;) {
      job = this.manager.status({
        jobId: started.jobId,
        routeKey: input.routeKey,
        sessionId: input.sessionId
      })
      if (TERMINAL.has(job.state)) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const stdout = this.manager.read({
      jobId: job.jobId,
      routeKey: input.routeKey,
      sessionId: input.sessionId,
      stream: 'stdout',
      maxBytes: input.maxOutputBytes
    }).data
    const stderr = this.manager.read({
      jobId: job.jobId,
      routeKey: input.routeKey,
      sessionId: input.sessionId,
      stream: 'stderr',
      maxBytes: input.maxOutputBytes
    }).data
    return Object.freeze({
      job,
      stdout,
      stderr,
      provenance: this.provenance,
      artifacts: this.captureArtifacts(prepared.artifactPaths)
    })
  }

  private managerInput(input: PythonExecuteInput, prepared: Prepared): CommandsBackgroundInput {
    return {
      authorizationId: input.authorizationId,
      idempotencyKey: input.idempotencyKey,
      request: input.request,
      routeKey: input.routeKey,
      sessionId: input.sessionId,
      command: this.executable,
      args: prepared.args,
      cwd: prepared.cwd,
      env: SAFE_ENV,
      shell: false,
      timeoutMs: input.timeoutMs,
      maxLogBytes: input.maxOutputBytes,
      grantId: input.grantId,
      expectedGrantUseCount: input.expectedGrantUseCount,
      beforeConsume: () => this.revalidateInterpreter()
    }
  }

  private prepare(
    input: Pick<PythonExecuteInput, 'code' | 'file' | 'cwd' | 'artifacts'>
  ): Prepared {
    const hasCode = typeof input.code === 'string'
    const hasFile = typeof input.file === 'string'
    if (hasCode === hasFile)
      throw new TerminalRunValidationError('Exactly one of code or file is required.')
    const cwd = input.cwd ? this.contained(input.cwd, true) : this.root
    let script: string
    let codeSha256: string
    if (hasCode) {
      const bytes = Buffer.byteLength(input.code!, 'utf8')
      if (!bytes || bytes > MAX_CODE_BYTES)
        throw new TerminalRunValidationError('Inline Python code is empty or exceeds 256 KiB.')
      codeSha256 = sha256(Buffer.from(input.code!, 'utf8'))
      const dir = path.join(this.root, '.magicpot', 'python', 'inline')
      mkdirSync(dir, { recursive: true })
      script = path.join(dir, `${codeSha256}.py`)
      if (!existsSync(script))
        writeFileSync(script, input.code!, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } else {
      script = this.contained(input.file!, false)
      if (path.extname(script).toLowerCase() !== '.py')
        throw new TerminalRunValidationError('Python file must have a .py extension.')
      const info = lstatSync(script)
      if (!info.isFile() || info.isSymbolicLink())
        throw new TerminalRunValidationError('Python file must be a regular non-symlink file.')
      if (info.size > MAX_CODE_BYTES)
        throw new TerminalRunValidationError('Python file exceeds 256 KiB.')
      codeSha256 = sha256(readFileSync(script))
    }
    const artifactPaths = (input.artifacts ?? []).map((item) => this.contained(item, false, true))
    if (
      artifactPaths.length > MAX_ARTIFACTS ||
      new Set(artifactPaths).size !== artifactPaths.length
    )
      throw new TerminalRunValidationError(
        'Artifact declaration exceeds count bound or contains duplicates.'
      )
    return { cwd, args: [...FLAGS, script], codeSha256, artifactPaths }
  }

  private contained(value: string, directory: boolean, allowMissing = false): string {
    if (!value?.trim() || path.isAbsolute(value))
      throw new TerminalRunValidationError('Paths must be workspace-relative.')
    const resolved = path.resolve(this.root, value)
    if (!isInsideTerminalRoot(this.root, resolved))
      throw new TerminalRunValidationError('Path escapes the workspace.')
    if (allowMissing && !existsSync(resolved)) return resolved
    const canonical = path.resolve(realpathSync.native(resolved))
    if (!isInsideTerminalRoot(this.root, canonical))
      throw new TerminalRunValidationError('Path resolves outside the workspace.')
    if (directory && !statSync(canonical).isDirectory())
      throw new TerminalRunValidationError('cwd must be a directory.')
    return canonical
  }

  private validateRequest(request: PolicyRequest, target: string, prepared: Prepared): void {
    if (request.action !== 'python.execute' || request.target.id !== target)
      throw new TerminalRunValidationError(`Policy request must authorize ${target}.`)
    if (
      request.input.interpreterSha256 !== this.provenance.sha256 ||
      request.input.codeSha256 !== prepared.codeSha256 ||
      request.input.cwd !== prepared.cwd ||
      JSON.stringify(request.input.artifacts) !== JSON.stringify(prepared.artifactPaths)
    )
      throw new TerminalRunValidationError(
        'Python policy request does not match interpreter, code, cwd, or artifacts.'
      )
  }

  private revalidateInterpreter(): void {
    const current = this.probe(this.executable)
    if (
      current.executable !== this.provenance.executable ||
      current.sha256 !== this.provenance.sha256
    )
      throw new TerminalRunValidationError(
        'Trusted Python interpreter identity changed before execution.'
      )
  }

  private captureArtifacts(paths: readonly string[]) {
    return paths.map((file) => {
      if (!existsSync(file))
        throw new TerminalRunValidationError(
          `Declared artifact was not created: ${path.relative(this.root, file)}`
        )
      const info = lstatSync(file)
      if (info.isSymbolicLink() || !info.isFile())
        throw new TerminalRunValidationError(
          'Declared artifacts must be regular non-symlink files.'
        )
      if (info.size > MAX_ARTIFACT_BYTES)
        throw new TerminalRunValidationError('Declared artifact exceeds 8 MiB.')
      return Object.freeze({
        path: path.relative(this.root, file),
        size: info.size,
        sha256: sha256(readFileSync(file))
      })
    })
  }
}

type Prepared = { cwd: string; args: string[]; codeSha256: string; artifactPaths: string[] }

export const probePythonInterpreter: PythonProbe = (configured) => {
  const executable = path.resolve(realpathSync.native(configured))
  const info = lstatSync(executable)
  if (!info.isFile() || info.isSymbolicLink())
    throw new TerminalRunValidationError('Trusted Python interpreter must be a regular file.')
  const probe = spawnSync(
    executable,
    [
      ...FLAGS,
      '-c',
      'import json,platform,sys;print(json.dumps({"implementation":platform.python_implementation(),"version":platform.python_version(),"platform":sys.platform}))'
    ],
    { encoding: 'utf8', shell: false, timeout: 5000, env: SAFE_ENV }
  )
  if (probe.status !== 0 || probe.error)
    throw new TerminalRunValidationError('Trusted Python interpreter could not be probed.')
  try {
    const data = JSON.parse(probe.stdout.trim()) as {
      implementation: string
      version: string
      platform: string
    }
    return Object.freeze({ executable, sha256: sha256(readFileSync(executable)), ...data })
  } catch {
    throw new TerminalRunValidationError('Trusted Python interpreter returned invalid provenance.')
  }
}

function canonicalExistingDirectory(value: string, name: string): string {
  if (!value) throw new TerminalRunValidationError(`${name} is required.`)
  const result = path.resolve(realpathSync.native(value))
  if (!statSync(result).isDirectory())
    throw new TerminalRunValidationError(`${name} must be a directory.`)
  return result
}
function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new TerminalRunValidationError(`${name} is required.`)
  return value
}
