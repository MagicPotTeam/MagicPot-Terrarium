import {
  spawn as realSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  GitAddInput,
  GitAddOutput,
  GitBranchInput,
  GitBranchOutput,
  GitCheckoutInput,
  GitCheckoutOutput,
  GitCommit,
  GitCommitInput,
  GitCommitOutput,
  GitDiffInput,
  GitDiffOutput,
  GitLogInput,
  GitLogOutput,
  GitShowInput,
  GitShowOutput,
  GitStatusInput,
  GitStatusOutput,
  PolicyRequest
} from '../../../shared/magicAgentPlatform2'
import type { MagicAgentPolicyAuthorizationService } from '../policy'
import { redactSecretCredentialText } from '../policy/redaction'

const LIMITS = {
  timeoutMs: 10_000,
  outputBytes: 512 * 1024,
  commits: 100,
  pathspecs: 64,
  pathLength: 1024,
  messageBytes: 16 * 1024
}
type ReadTool = 'git.status' | 'git.diff' | 'git.log' | 'git.show'
type WriteTool = 'git.branch' | 'git.checkout' | 'git.add' | 'git.commit'
type Tool = ReadTool | WriteTool
type ReadInput = GitStatusInput | GitDiffInput | GitLogInput | GitShowInput
type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams
export type GitToolAuditEvidence = Readonly<{
  tool: Tool
  authorizationId: string
  repository: string
  pathspecs: readonly string[]
  branch?: string
  count?: number
  beforeHead?: string
  afterHead?: string
  indexSnapshot?: string
  rollback?: 'not-needed' | 'restored' | 'uncertain'
  outcome: 'completed' | 'rejected' | 'cancelled' | 'timed-out' | 'uncertain'
  durationMs: number
}>
type Call<T> = Readonly<{
  authorizationId: string
  idempotencyKey: string
  request: PolicyRequest
  input: T
  grantId?: string
  expectedGrantUseCount?: number
  signal?: AbortSignal
}>
type Repo = { root: string; relative: string; gitDir: string; workspace: string }

export class GitToolValidationError extends Error {
  readonly code = 'MAGIC_AGENT_GIT_VALIDATION'
  constructor(message: string) {
    super(message)
    this.name = 'GitToolValidationError'
  }
}
export class GitToolAuthorizationError extends Error {
  readonly code = 'MAGIC_AGENT_GIT_AUTHORIZATION'
  constructor(
    readonly status: 'denied' | 'awaiting-approval' | 'already-consumed',
    message: string
  ) {
    super(message)
    this.name = 'GitToolAuthorizationError'
  }
}
export class GitToolProcessError extends Error {
  readonly code = 'MAGIC_AGENT_GIT_PROCESS'
  constructor(
    message: string,
    readonly outcome: 'failed' | 'cancelled' | 'timed-out',
    readonly mutationMayHaveOccurred = false
  ) {
    super(message)
    this.name = 'GitToolProcessError'
  }
}

export class GitToolHost {
  private constructor(
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    private readonly roots: readonly string[],
    private readonly spawn: Spawn,
    private readonly onAudit?: (e: GitToolAuditEvidence) => void | Promise<void>
  ) {}
  static async create(
    authorization: MagicAgentPolicyAuthorizationService,
    options: Readonly<{
      allowedRoots: readonly string[]
      spawn?: Spawn
      onAudit?: (e: GitToolAuditEvidence) => void | Promise<void>
    }>
  ): Promise<GitToolHost> {
    if (!options.allowedRoots.length)
      throw new GitToolValidationError('At least one workspace root is required.')
    const roots = await Promise.all(
      options.allowedRoots.map(async (root) => {
        const value = await fs.realpath(root)
        if (!(await fs.stat(value)).isDirectory())
          throw new GitToolValidationError('Workspace root must be a directory.')
        return value
      })
    )
    return new GitToolHost(
      authorization,
      [...new Set(roots)].sort(),
      options.spawn ?? realSpawn,
      options.onAudit
    )
  }
  status(call: Call<GitStatusInput>): Promise<GitStatusOutput> {
    return this.executeRead('git.status', call) as Promise<GitStatusOutput>
  }
  diff(call: Call<GitDiffInput>): Promise<GitDiffOutput> {
    return this.executeRead('git.diff', call) as Promise<GitDiffOutput>
  }
  log(call: Call<GitLogInput>): Promise<GitLogOutput> {
    return this.executeRead('git.log', call) as Promise<GitLogOutput>
  }
  show(call: Call<GitShowInput>): Promise<GitShowOutput> {
    return this.executeRead('git.show', call) as Promise<GitShowOutput>
  }
  branch(call: Call<GitBranchInput>): Promise<GitBranchOutput> {
    return this.executeBranch(call)
  }
  checkout(call: Call<GitCheckoutInput>): Promise<GitCheckoutOutput> {
    return this.executeCheckout(call)
  }
  add(call: Call<GitAddInput>): Promise<GitAddOutput> {
    return this.executeAdd(call)
  }
  commit(call: Call<GitCommitInput>): Promise<GitCommitOutput> {
    return this.executeCommit(call)
  }

  private async executeRead(
    tool: ReadTool,
    call: Call<ReadInput>
  ): Promise<GitStatusOutput | GitDiffOutput | GitLogOutput | GitShowOutput> {
    const started = Date.now()
    let repository = '.',
      pathspecs: string[] = [],
      revision: string | undefined
    try {
      validateRequest(call.request, tool)
      const permit = this.authorize(call, tool)
      const repo = await discoverRepository(
        this.roots,
        call.input.repository ?? '.',
        permit.constraints?.allowedRoots
      )
      repository = repo.relative
      pathspecs = validatePathspecs('pathspecs' in call.input ? call.input.pathspecs : undefined)
      revision = validateRevision(
        'revision' in call.input ? call.input.revision : undefined,
        tool === 'git.show'
      )
      const timeout = bounded(
          call.input.timeoutMs,
          permit.constraints?.maxTimeoutMs,
          LIMITS.timeoutMs
        ),
        max = bounded(
          call.input.maxOutputBytes,
          permit.constraints?.maxOutputChars,
          LIMITS.outputBytes
        )
      const maxCommits =
        tool === 'git.log'
          ? bounded((call.input as GitLogInput).maxCommits, LIMITS.commits, LIMITS.commits)
          : undefined
      if (call.signal?.aborted) throw abortError()
      this.consume(call, permit)
      const text = (
        await run(
          this.spawn,
          buildReadArgs(tool, revision, pathspecs, maxCommits),
          repo.root,
          timeout,
          max,
          call.signal
        )
      ).stdout
      if (tool === 'git.diff' || tool === 'git.show') rejectBinaryDiff(text)
      const duration = Date.now() - started
      const output =
        tool === 'git.status'
          ? await parseStatus(repo, text, duration, this.spawn, timeout, max, call.signal)
          : tool === 'git.diff'
            ? parseDiff(repository, revision, pathspecs, text, duration)
            : tool === 'git.log'
              ? parseLog(repository, revision, pathspecs, text, duration)
              : parseShow(repository, revision!, pathspecs, text, duration)
      await this.audit({
        tool,
        authorizationId: call.authorizationId,
        repository,
        pathspecs,
        count: auditCount(output),
        outcome: 'completed',
        durationMs: duration
      })
      return output
    } catch (error) {
      await this.auditFailure(tool, call, started, repository, pathspecs, error)
      throw error
    }
  }

  private async executeBranch(call: Call<GitBranchInput>): Promise<GitBranchOutput> {
    const tool = 'git.branch',
      started = Date.now()
    let repository = '.',
      branch: string | undefined,
      beforeHead: string | undefined
    try {
      validateRequest(call.request, tool)
      branch = validateBranch(call.input.branch)
      validateHash(call.input.expectedHead)
      const repo = await discoverRepository(this.roots, call.input.repository ?? '.')
      repository = repo.relative
      const limits = inputLimits(call.input)
      beforeHead = await head(this.spawn, repo, limits, call.signal)
      requireExpected(beforeHead, call.input.expectedHead)
      await requireLocalBranch(this.spawn, repo, branch, false, limits, call.signal)
      const permit = this.authorize(call, tool)
      await enforcePermitRepo(permit, tool, repo)
      checkCancelled(call.signal)
      this.consume(call, permit)
      await mutate(this.spawn, ['branch', '--', branch, beforeHead], repo, limits, call.signal)
      const afterHead = await localBranchHead(this.spawn, repo, branch, limits, call.signal)
      if (afterHead !== beforeHead)
        throw new GitToolProcessError(
          'Created branch did not point at expected HEAD.',
          'failed',
          true
        )
      const out = { repository, branch, beforeHead, afterHead, durationMs: Date.now() - started }
      await this.audit({
        tool,
        authorizationId: call.authorizationId,
        repository,
        pathspecs: [],
        branch,
        beforeHead,
        afterHead,
        outcome: 'completed',
        durationMs: out.durationMs
      })
      return out
    } catch (error) {
      await this.auditFailure(tool, call, started, repository, [], error, { branch, beforeHead })
      throw error
    }
  }

  private async executeCheckout(call: Call<GitCheckoutInput>): Promise<GitCheckoutOutput> {
    const tool = 'git.checkout',
      started = Date.now()
    let repository = '.',
      branch: string | undefined,
      beforeHead: string | undefined
    try {
      validateRequest(call.request, tool)
      branch = validateBranch(call.input.branch)
      validateHash(call.input.expectedHead)
      validateDigest(call.input.expectedStatusDigest)
      const repo = await discoverRepository(this.roots, call.input.repository ?? '.')
      repository = repo.relative
      const limits = inputLimits(call.input)
      beforeHead = await head(this.spawn, repo, limits, call.signal)
      requireExpected(beforeHead, call.input.expectedHead)
      await requireLocalBranch(this.spawn, repo, branch, true, limits, call.signal)
      const status = await statusState(this.spawn, repo, limits, call.signal)
      if (status.digest !== call.input.expectedStatusDigest)
        throw new GitToolValidationError('Stale expected status digest.')
      if (status.raw.length)
        throw new GitToolValidationError(
          'Checkout requires a clean index, worktree, and no untracked files.'
        )
      const permit = this.authorize(call, tool)
      await enforcePermitRepo(permit, tool, repo)
      checkCancelled(call.signal)
      this.consume(call, permit)
      await mutate(this.spawn, ['checkout', '--', branch], repo, limits, call.signal)
      const afterHead = await head(this.spawn, repo, limits, call.signal),
        afterStatus = await statusState(this.spawn, repo, limits, call.signal)
      const out = {
        repository,
        branch,
        beforeHead,
        afterHead,
        statusDigest: afterStatus.digest,
        durationMs: Date.now() - started
      }
      await this.audit({
        tool,
        authorizationId: call.authorizationId,
        repository,
        pathspecs: [],
        branch,
        beforeHead,
        afterHead,
        outcome: 'completed',
        durationMs: out.durationMs
      })
      return out
    } catch (error) {
      await this.auditFailure(tool, call, started, repository, [], error, { branch, beforeHead })
      throw error
    }
  }

  private async executeAdd(call: Call<GitAddInput>): Promise<GitAddOutput> {
    const tool = 'git.add',
      started = Date.now()
    let repository = '.',
      paths: string[] = [],
      beforeHead: string | undefined,
      snapshot: string | undefined,
      rollback: 'not-needed' | 'restored' | 'uncertain' = 'not-needed'
    try {
      validateRequest(call.request, tool)
      paths = validatePathspecs(call.input.pathspecs, true)
      validateHash(call.input.expectedHead)
      validateDigest(call.input.expectedStatusDigest)
      const repo = await discoverRepository(this.roots, call.input.repository ?? '.')
      repository = repo.relative
      const limits = inputLimits(call.input)
      beforeHead = await head(this.spawn, repo, limits, call.signal)
      requireExpected(beforeHead, call.input.expectedHead)
      const before = await statusState(this.spawn, repo, limits, call.signal)
      if (before.digest !== call.input.expectedStatusDigest)
        throw new GitToolValidationError('Stale expected status digest.')
      const preview = parseNumstat(
        (
          await probe(
            this.spawn,
            ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '--', ...paths],
            repo,
            limits,
            call.signal
          )
        ).stdout
      )
      const indexContent = await readIndex(repo)
      const permit = this.authorize(call, tool)
      await enforcePermitRepo(permit, tool, repo)
      checkCancelled(call.signal)
      this.consume(call, permit)
      snapshot = await persistIndexSnapshot(repo, indexContent)
      try {
        await mutate(this.spawn, ['add', '--', ...paths], repo, limits, call.signal)
      } catch (error) {
        rollback = await restoreIndex(repo, snapshot)
        throw new GitToolProcessError(
          `${message(error)} Index rollback ${rollback}.`,
          error instanceof GitToolProcessError ? error.outcome : 'failed',
          rollback !== 'restored'
        )
      }
      const afterHead = await head(this.spawn, repo, limits, call.signal)
      if (afterHead !== beforeHead)
        throw new GitToolProcessError('HEAD changed unexpectedly during git add.', 'failed', true)
      const after = await statusState(this.spawn, repo, limits, call.signal),
        staged = await stagedState(this.spawn, repo, limits, call.signal)
      const out = {
        repository,
        pathspecs: paths,
        beforeHead,
        afterHead,
        beforeStatusDigest: before.digest,
        afterStatusDigest: after.digest,
        stagedDiffDigest: staged.digest,
        previewFiles: preview,
        indexSnapshot: snapshot,
        rollback,
        durationMs: Date.now() - started
      }
      await this.audit({
        tool,
        authorizationId: call.authorizationId,
        repository,
        pathspecs: paths,
        count: preview.length,
        beforeHead,
        afterHead,
        indexSnapshot: snapshot,
        rollback,
        outcome: 'completed',
        durationMs: out.durationMs
      })
      return out
    } catch (error) {
      await this.auditFailure(tool, call, started, repository, paths, error, {
        beforeHead,
        indexSnapshot: snapshot,
        rollback
      })
      throw error
    }
  }

  private async executeCommit(call: Call<GitCommitInput>): Promise<GitCommitOutput> {
    const tool = 'git.commit',
      started = Date.now()
    let repository = '.',
      beforeHead: string | undefined
    try {
      validateRequest(call.request, tool)
      const messageText = validateMessage(call.input.message)
      validateHash(call.input.expectedHead)
      validateDigest(call.input.expectedStagedDiffDigest)
      const repo = await discoverRepository(this.roots, call.input.repository ?? '.')
      repository = repo.relative
      const limits = inputLimits(call.input)
      beforeHead = await head(this.spawn, repo, limits, call.signal)
      requireExpected(beforeHead, call.input.expectedHead)
      const staged = await stagedState(this.spawn, repo, limits, call.signal)
      if (staged.digest !== call.input.expectedStagedDiffDigest)
        throw new GitToolValidationError('Stale expected staged diff digest.')
      if (!staged.raw.length) throw new GitToolValidationError('Cannot commit an empty index.')
      const permit = this.authorize(call, tool)
      await enforcePermitRepo(permit, tool, repo)
      checkCancelled(call.signal)
      this.consume(call, permit)
      await mutate(this.spawn, ['commit', '-m', messageText], repo, limits, call.signal)
      const afterHead = await head(this.spawn, repo, limits, call.signal),
        parentHead = (
          await probe(
            this.spawn,
            ['rev-parse', '--verify', `${afterHead}^`],
            repo,
            limits,
            call.signal
          )
        ).stdout.trim()
      if (parentHead !== beforeHead)
        throw new GitToolProcessError(
          'New commit parent does not equal expected HEAD.',
          'failed',
          true
        )
      const out = {
        repository,
        beforeHead,
        afterHead,
        parentHead,
        stagedDiffDigest: staged.digest,
        files: staged.files,
        durationMs: Date.now() - started
      }
      await this.audit({
        tool,
        authorizationId: call.authorizationId,
        repository,
        pathspecs: staged.files.map((f) => f.path),
        count: staged.files.length,
        beforeHead,
        afterHead,
        outcome: 'completed',
        durationMs: out.durationMs
      })
      return out
    } catch (error) {
      await this.auditFailure(tool, call, started, repository, [], error, { beforeHead })
      throw error
    }
  }

  private authorize<T>(call: Call<T>, tool: Tool) {
    const result = this.authorization.authorize({
      authorizationId: call.authorizationId,
      request: call.request,
      evaluatedAt: Date.now(),
      idempotencyKey: `${call.idempotencyKey}:authorize`,
      ...(call.grantId ? { grantId: call.grantId } : {}),
      ...(call.expectedGrantUseCount === undefined
        ? {}
        : { expectedGrantUseCount: call.expectedGrantUseCount })
    })
    if (result.status !== 'authorized')
      throw new GitToolAuthorizationError(result.status, result.reason)
    if (!this.authorization.isTrustedPermit(result.permit))
      throw new GitToolAuthorizationError('denied', 'Untrusted execution permit.')
    const c = result.permit.constraints
    if (c?.allowedToolNames && !c.allowedToolNames.includes(tool))
      throw new GitToolValidationError(`Policy does not allow ${tool}.`)
    if (c?.requireNoShell === false)
      throw new GitToolValidationError('Git tools require shell:false.')
    return result.permit
  }
  private consume<T>(call: Call<T>, permit: ReturnType<GitToolHost['authorize']>) {
    this.authorization.consumeExecutionPermit({
      permit,
      request: call.request,
      consumedAt: Date.now(),
      idempotencyKey: `${call.idempotencyKey}:consume`
    })
  }
  private async audit(e: GitToolAuditEvidence) {
    await this.onAudit?.(e)
  }
  private async auditFailure<T>(
    tool: Tool,
    call: Call<T>,
    started: number,
    repository: string,
    pathspecs: string[],
    error: unknown,
    extra: Partial<GitToolAuditEvidence> = {}
  ) {
    const outcome =
      error instanceof GitToolProcessError
        ? error.mutationMayHaveOccurred
          ? 'uncertain'
          : error.outcome === 'cancelled'
            ? 'cancelled'
            : error.outcome === 'timed-out'
              ? 'timed-out'
              : 'rejected'
        : 'rejected'
    await this.audit({
      tool,
      authorizationId: call.authorizationId,
      repository,
      pathspecs,
      ...extra,
      outcome,
      durationMs: Date.now() - started
    })
  }
}

const BASE = ['--no-pager', '-c', 'color.ui=false', '-c', 'core.quotepath=false']
function buildReadArgs(
  tool: ReadTool,
  revision: string | undefined,
  paths: readonly string[],
  maxCommits?: number
): string[] {
  if (tool === 'git.status')
    return [...BASE, 'status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all']
  if (tool === 'git.diff')
    return [
      ...BASE,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '--patch',
      '--find-renames=0',
      ...(revision ? [revision] : []),
      '--',
      ...paths
    ]
  const format = '%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e'
  if (tool === 'git.log')
    return [
      ...BASE,
      'log',
      `--max-count=${maxCommits}`,
      `--format=${format}`,
      ...(revision ? [revision] : []),
      '--',
      ...paths
    ]
  return [
    ...BASE,
    'show',
    '--no-ext-diff',
    '--no-textconv',
    `--format=${format}`,
    '--numstat',
    '--patch',
    '--find-renames=0',
    revision!,
    '--',
    ...paths
  ]
}
async function discoverRepository(
  roots: readonly string[],
  requested: string,
  policyRoots?: readonly string[]
): Promise<Repo> {
  if (!requested || requested.includes('\0') || isRemote(requested))
    throw new GitToolValidationError('Invalid repository path.')
  for (const workspace of roots) {
    const candidate = path.resolve(workspace, requested)
    if (!inside(workspace, candidate)) continue
    let current: string
    try {
      current = await fs.realpath(candidate)
    } catch {
      continue
    }
    if (!inside(workspace, current)) continue
    while (inside(workspace, current)) {
      const marker = path.join(current, '.git')
      try {
        const stat = await fs.lstat(marker)
        let gitDir = marker
        if (stat.isFile()) {
          const match = /^gitdir:\s*(.+)\s*$/i.exec(await fs.readFile(marker, 'utf8'))
          if (!match) throw new GitToolValidationError('Invalid .git indirection file.')
          gitDir = await fs.realpath(path.resolve(current, match[1]))
        } else if (!stat.isDirectory()) throw new GitToolValidationError('Invalid .git marker.')
        else gitDir = await fs.realpath(marker)
        if (!inside(workspace, current) || !inside(workspace, gitDir))
          throw new GitToolValidationError('Repository git directory escapes the workspace.')
        const repo = { root: current, relative: rel(workspace, current), gitDir, workspace }
        if (policyRoots) await enforcePolicyRoots(repo, policyRoots)
        return repo
      } catch (error) {
        if (error instanceof GitToolValidationError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (current === workspace) break
      current = path.dirname(current)
    }
  }
  throw new GitToolValidationError('No workspace-contained Git repository found.')
}
async function enforcePermitRepo(
  permit: ReturnType<GitToolHost['authorize']>,
  tool: Tool,
  repo: Repo
) {
  const c = permit.constraints
  if (c?.allowedToolNames && !c.allowedToolNames.includes(tool))
    throw new GitToolValidationError(`Policy does not allow ${tool}.`)
  if (c?.requireNoShell === false)
    throw new GitToolValidationError('Git tools require shell:false.')
  if (c?.allowedRoots) await enforcePolicyRoots(repo, c.allowedRoots)
}
async function enforcePolicyRoots(repo: Repo, roots: readonly string[]) {
  const canonical = await Promise.all(roots.map((v) => fs.realpath(v)))
  if (!canonical.some((v) => inside(v, repo.root) && inside(v, repo.gitDir)))
    throw new GitToolValidationError('Repository is outside policy roots.')
}
function run(
  spawn: Spawn,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
      env: {
        PATH: process.env.PATH,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        LC_ALL: 'C'
      }
    })
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      error
        ? reject(error)
        : resolve({ stdout: redactSecretCredentialText(stdout.toString('utf8')) })
    }
    const cancel = () => {
      child.kill('SIGKILL')
      finish(new GitToolProcessError('Git process cancelled.', 'cancelled'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new GitToolProcessError('Git process timed out.', 'timed-out'))
    }, timeoutMs)
    signal?.addEventListener('abort', cancel, { once: true })
    const collect = (target: 'out' | 'err', chunk: Buffer | string) => {
      const data = Buffer.from(chunk),
        used = stdout.length + stderr.length
      if (used + data.length > maxBytes) {
        child.kill('SIGKILL')
        finish(new GitToolProcessError('Git output exceeded the configured bound.', 'failed'))
        return
      }
      target === 'out'
        ? (stdout = Buffer.concat([stdout, data]))
        : (stderr = Buffer.concat([stderr, data]))
    }
    child.stdout.on('data', (c) => collect('out', c))
    child.stderr.on('data', (c) => collect('err', c))
    child.once('error', (e) =>
      finish(new GitToolProcessError(redactSecretCredentialText(e.message), 'failed'))
    )
    child.once('close', (code) =>
      code === 0
        ? finish()
        : finish(
            new GitToolProcessError(
              redactSecretCredentialText(stderr.toString('utf8') || `git exited with ${code}`),
              'failed'
            )
          )
    )
  })
}
function probe(
  spawn: Spawn,
  args: readonly string[],
  repo: Repo,
  limits: { timeout: number; max: number },
  signal?: AbortSignal
) {
  return run(spawn, [...BASE, ...args], repo.root, limits.timeout, limits.max, signal)
}
async function mutate(
  spawn: Spawn,
  args: readonly string[],
  repo: Repo,
  limits: { timeout: number; max: number },
  signal?: AbortSignal
) {
  try {
    return await probe(spawn, args, repo, limits, signal)
  } catch (e) {
    if (e instanceof GitToolProcessError) throw new GitToolProcessError(e.message, e.outcome, true)
    throw e
  }
}
async function head(
  spawn: Spawn,
  repo: Repo,
  limits: { timeout: number; max: number },
  signal?: AbortSignal
) {
  const value = (
    await probe(spawn, ['rev-parse', '--verify', 'HEAD'], repo, limits, signal)
  ).stdout.trim()
  validateHash(value)
  return value
}
async function statusState(
  spawn: Spawn,
  repo: Repo,
  limits: { timeout: number; max: number },
  signal?: AbortSignal
) {
  const raw = (
    await probe(
      spawn,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      repo,
      limits,
      signal
    )
  ).stdout
  return { raw, digest: digest(raw) }
}
async function stagedState(
  spawn: Spawn,
  repo: Repo,
  limits: { timeout: number; max: number },
  signal?: AbortSignal
) {
  const raw = (
    await probe(
      spawn,
      ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--numstat', '--'],
      repo,
      limits,
      signal
    )
  ).stdout
  return { raw, digest: digest(raw), files: parseNumstat(raw) }
}
async function localBranchHead(
  spawn: Spawn,
  repo: Repo,
  branch: string,
  limits: { timeout: number; max: number },
  signal?: AbortSignal
) {
  return (
    await probe(spawn, ['rev-parse', '--verify', `refs/heads/${branch}`], repo, limits, signal)
  ).stdout.trim()
}
async function requireLocalBranch(
  spawn: Spawn,
  repo: Repo,
  branch: string,
  exists: boolean,
  limits: { timeout: number; max: number },
  signal?: AbortSignal
) {
  try {
    await localBranchHead(spawn, repo, branch, limits, signal)
    if (!exists) throw new GitToolValidationError('Local branch already exists.')
  } catch (e) {
    if (e instanceof GitToolValidationError) throw e
    if (e instanceof GitToolProcessError && e.outcome === 'failed') {
      if (exists) throw new GitToolValidationError('Local branch does not exist.')
      return
    }
    throw e
  }
}
async function readIndex(repo: Repo) {
  try {
    return await fs.readFile(path.join(repo.gitDir, 'index'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    return Buffer.alloc(0)
  }
}
async function persistIndexSnapshot(repo: Repo, content: Buffer) {
  const hash = digestBuffer(content),
    dir = path.join(repo.workspace, '.magicpot', 'tool-host', 'git-index')
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, hash)
  try {
    await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  return rel(repo.workspace, target)
}
async function restoreIndex(repo: Repo, snapshot: string): Promise<'restored' | 'uncertain'> {
  try {
    const source = path.resolve(repo.workspace, snapshot)
    if (!inside(repo.workspace, source)) return 'uncertain'
    const content = await fs.readFile(source),
      index = path.join(repo.gitDir, 'index')
    if (content.length === 0) {
      await fs.rm(index, { force: true })
      return 'restored'
    }
    const temp = `${index}.magic-agent-rollback-${process.pid}`
    await fs.writeFile(temp, content, { mode: 0o600 })
    await fs.rename(temp, index)
    return 'restored'
  } catch {
    return 'uncertain'
  }
}
async function parseStatus(
  repo: Repo,
  text: string,
  durationMs: number,
  spawn: Spawn,
  timeout: number,
  max: number,
  signal?: AbortSignal
): Promise<GitStatusOutput> {
  let branch: string | undefined
  const entries: Array<{ path: string; index: string; worktree: string }> = []
  for (const record of text.split('\0').filter(Boolean)) {
    if (record.startsWith('## ')) {
      branch = record.slice(3).split('...')[0]
      continue
    }
    const m = /^(.)(.) (.*)$/.exec(record)
    if (m) entries.push({ path: safePath(m[3]), index: m[1], worktree: m[2] })
  }
  const limits = { timeout, max },
    currentHead = await head(spawn, repo, limits, signal),
    staged = await stagedState(spawn, repo, limits, signal)
  return {
    repository: repo.relative,
    ...(branch ? { branch } : {}),
    head: currentHead,
    entries,
    statusDigest: digest(text),
    stagedDiffDigest: staged.digest,
    raw: text.replace(/\0/g, '\n'),
    truncated: false,
    durationMs
  }
}
function parseDiff(
  repository: string,
  revision: string | undefined,
  pathspecs: readonly string[],
  text: string,
  durationMs: number
): GitDiffOutput {
  const files = parseNumstat(text),
    at = text.search(/^diff --git /m)
  return {
    repository,
    ...(revision ? { revision } : {}),
    pathspecs,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    diff: at >= 0 ? text.slice(at) : text,
    truncated: false,
    durationMs
  }
}
function parseLog(
  repository: string,
  revision: string | undefined,
  pathspecs: readonly string[],
  text: string,
  durationMs: number
): GitLogOutput {
  const commits = parseCommits(text)
  return {
    repository,
    ...(revision ? { revision } : {}),
    pathspecs,
    commits,
    count: commits.length,
    truncated: false,
    durationMs
  }
}
function parseShow(
  repository: string,
  revision: string,
  pathspecs: readonly string[],
  text: string,
  durationMs: number
): GitShowOutput {
  const commits = parseCommits(text)
  if (!commits[0]) throw new GitToolValidationError('git.show returned no commit.')
  const files = parseNumstat(text),
    at = text.search(/^diff --git /m)
  return {
    repository,
    revision,
    pathspecs,
    commit: commits[0],
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    diff: at >= 0 ? text.slice(at) : '',
    truncated: false,
    durationMs
  }
}
function parseCommits(text: string): GitCommit[] {
  return text
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const f = r.split('\x1f')
      return {
        hash: f[0],
        authorName: redactSecretCredentialText(f[1] ?? ''),
        authorEmail: redactSecretCredentialText(f[2] ?? ''),
        authoredAt: f[3] ?? '',
        subject: redactSecretCredentialText((f[4] ?? '').split('\n')[0])
      }
    })
    .filter((c) => /^[0-9a-f]{40}$/i.test(c.hash))
}
function parseNumstat(text: string) {
  const files: { path: string; additions: number; deletions: number }[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (m)
      files.push({
        path: safePath(m[3]),
        additions: m[1] === '-' ? 0 : Number(m[1]),
        deletions: m[2] === '-' ? 0 : Number(m[2])
      })
  }
  return files
}
function validateRequest(request: PolicyRequest, tool: Tool) {
  if (request.action !== tool || request.target.id !== tool)
    throw new GitToolValidationError(`Policy request must target ${tool}.`)
}
function validateRevision(value: string | undefined, required: boolean) {
  if (!value) {
    if (required) throw new GitToolValidationError('revision is required.')
    return undefined
  }
  if (value.startsWith('-') || value.length > 256 || /[\0\s]/.test(value) || isRemote(value))
    throw new GitToolValidationError('Invalid revision.')
  return value
}
function validatePathspecs(values?: readonly string[], required = false): string[] {
  if (!values) {
    if (required) throw new GitToolValidationError('At least one bounded pathspec is required.')
    return []
  }
  if (
    (required && values.length === 0) ||
    !Array.isArray(values) ||
    values.length > LIMITS.pathspecs
  )
    throw new GitToolValidationError(
      required ? 'At least one bounded pathspec is required.' : 'Too many pathspecs.'
    )
  return values.map(safePath)
}
function safePath(value: string) {
  const v = value.replace(/\\/g, '/')
  if (
    !v ||
    v.length > LIMITS.pathLength ||
    v.startsWith('-') ||
    path.posix.isAbsolute(v) ||
    v.split('/').includes('..') ||
    isRemote(v) ||
    v.includes('\0')
  )
    throw new GitToolValidationError('Invalid repository-relative path.')
  return v
}
function validateBranch(value: string) {
  if (
    !value ||
    value === '@' ||
    value.length > 255 ||
    value.startsWith('-') ||
    value.endsWith('.') ||
    value.endsWith('/') ||
    value.includes('..') ||
    /[\s\0~^:?*\\[]/.test(value) ||
    value.includes('@{') ||
    value.split('/').some((p) => !p || p.startsWith('.') || p.endsWith('.lock'))
  )
    throw new GitToolValidationError('Invalid local branch name.')
  return value
}
function validateHash(value: string) {
  if (!/^[0-9a-f]{40}$/i.test(value))
    throw new GitToolValidationError('Expected a full 40-character commit hash.')
}
function validateDigest(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new GitToolValidationError('Expected a SHA-256 digest.')
}
function validateMessage(value: string) {
  if (!value || Buffer.byteLength(value) > LIMITS.messageBytes || value.includes('\0'))
    throw new GitToolValidationError('Commit message must be non-empty and bounded.')
  return value
}
function requireExpected(actual: string, expected: string) {
  if (actual !== expected) throw new GitToolValidationError('Stale expected HEAD.')
}
function rejectBinaryDiff(text: string) {
  if (/^Binary files .* differ$|^GIT binary patch$/m.test(text))
    throw new GitToolValidationError('Binary diff content is not allowed.')
}
function bounded(value: number | undefined, policy: number | undefined, cap: number) {
  const selected = value ?? cap
  if (
    !Number.isInteger(selected) ||
    selected <= 0 ||
    selected > cap ||
    (policy !== undefined && selected > policy)
  )
    throw new GitToolValidationError('Requested bound exceeds the allowed limit.')
  return selected
}
function inputLimits(input: { timeoutMs?: number; maxOutputBytes?: number }) {
  return {
    timeout: bounded(input.timeoutMs, undefined, LIMITS.timeoutMs),
    max: bounded(input.maxOutputBytes, undefined, LIMITS.outputBytes)
  }
}
function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
function digestBuffer(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}
function isRemote(value: string) {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/\\]+@[^:]+:)/i.test(value)
}
function inside(root: string, candidate: string) {
  const r = path.relative(root, candidate)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}
function rel(root: string, candidate: string) {
  return path.relative(root, candidate).replace(/\\/g, '/') || '.'
}
function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}
function abortError() {
  return new GitToolProcessError('Git process cancelled.', 'cancelled')
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
function auditCount(output: GitStatusOutput | GitDiffOutput | GitLogOutput | GitShowOutput) {
  if ('commits' in output) return output.count
  if ('commit' in output) return 1
  if ('entries' in output) return output.entries.length
  return output.files.length
}
