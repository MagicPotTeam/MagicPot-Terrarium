import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import type {
  MagicAgentEvent,
  PolicyJsonRecord,
  PolicyRequest
} from '../../../shared/magicAgentPlatform2'
import {
  NOTEBOOK_EXECUTION_MODE,
  type NotebookExecutionArtifact,
  type NotebookExecutionManifest,
  type NotebookExecutionMime,
  type NotebookExecutionStatus
} from '../../../shared/magicAgentPlatform2'
import type { MagicAgentPolicyAuthorizationService } from '../policy'
import type { CommandJobRecord } from './commandJobs'
import type { PythonJobManager, PythonProvenance } from './python'
import { NotebookToolAuthorizationError, NotebookToolValidationError } from './notebook'
import { redactSecretCredentialText } from '../policy/redaction'

const STORE = '.magicpot/notebook-executions'
const MAX_PROTOCOL_BYTES = 4 * 1024 * 1024
const MAX_STREAM_BYTES = 1024 * 1024
const MAX_DISPLAY_BYTES = 2 * 1024 * 1024
const MAX_JSON_DEPTH = 64
const MAX_ARTIFACTS = 32
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024
const TERMINAL = new Set(['completed', 'failed', 'timed-out', 'stopped', 'stopped-interrupted'])
const MIME = new Set<NotebookExecutionMime>([
  'text/plain',
  'text/markdown',
  'application/json',
  'image/png',
  'image/jpeg'
])

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type NotebookCell = {
  id: string
  cell_type: string
  source: string[]
  execution_count?: number | null
  outputs?: Json[]
  metadata: Record<string, Json>
}
type Notebook = {
  nbformat: 4
  nbformat_minor: number
  metadata: Record<string, Json>
  cells: NotebookCell[]
}
type ResultCell = {
  cellId: string
  executionCount: number
  stdout: string
  stderr: string
  displays: Array<{ mime: NotebookExecutionMime; data: Json }>
  result?: string
}
type ResultDocument = {
  protocol: 'magicpot-notebook-result.v1'
  status: 'completed' | 'error' | 'interrupted'
  cells: ResultCell[]
  error?: string
}

export type NotebookExecutionAuditSink = Readonly<{
  appendBatch(events: readonly MagicAgentEvent<unknown>[]): unknown
  getEvent(eventId: string): MagicAgentEvent<unknown> | undefined
  getLastSequence(streamId: string): number | undefined
  getResource(kind: 'artifact', id: string): { revision: number } | undefined
  mutateResourcesBatch(
    inputs: readonly Readonly<{
      operation: 'create'
      kind: 'artifact'
      id: string
      idempotencyKey: string
      state: unknown
      createdAt: number
      event: MagicAgentEvent<unknown>
    }>[]
  ): unknown
}>

export type NotebookExecutionJobBoundary = Readonly<{
  start(
    input: Readonly<{
      authorizationId: string
      idempotencyKey: string
      request: PolicyRequest
      routeKey: string
      sessionId: string
      wrapperPath: string
      wrapperSha256: string
      cwd: string
      timeoutMs?: number
      maxOutputBytes?: number
      grantId?: string
      expectedGrantUseCount?: number
      beforeSpawn?: () => void | Promise<void>
    }>
  ): Promise<CommandJobRecord>
  status(input: Readonly<{ jobId: string; routeKey: string; sessionId: string }>): CommandJobRecord
  read(
    input: Readonly<{
      jobId: string
      routeKey: string
      sessionId: string
      stream: 'stdout' | 'stderr'
      maxBytes?: number
    }>
  ): { data: string }
  stop(
    input: Readonly<{ jobId: string; routeKey: string; sessionId: string }>
  ): Promise<CommandJobRecord> | CommandJobRecord
}>

export type NotebookExecutionInput = Readonly<{
  authorizationId: string
  idempotencyKey: string
  request: PolicyRequest
  routeKey: string
  sessionId: string
  path: string
  expectedSha256: string
  expectedGeneration: number
  cellIds?: readonly string[]
  artifacts?: readonly string[]
  timeoutMs?: number
  maxOutputBytes?: number
  grantId?: string
  expectedGrantUseCount?: number
}>
export type NotebookControlInput = Readonly<{
  authorizationId: string
  idempotencyKey: string
  request: PolicyRequest
  routeKey: string
  sessionId: string
  path: string
  executionId?: string
  grantId?: string
  expectedGrantUseCount?: number
}>

export class NotebookExecutionCoordinator {
  private readonly root: string
  private readonly storeDir: string
  constructor(
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    private readonly jobs: NotebookExecutionJobBoundary,
    options: Readonly<{
      workspaceRoot: string
      provenance: PythonProvenance
      auditSink?: NotebookExecutionAuditSink
    }>
  ) {
    this.root = path.resolve(realpathSync.native(options.workspaceRoot))
    this.storeDir = path.join(this.root, STORE)
    this.provenance = options.provenance
    this.auditSink = options.auditSink
    mkdirSync(this.storeDir, { recursive: true })
    this.reconcile()
  }
  private readonly provenance: PythonProvenance
  private readonly auditSink?: NotebookExecutionAuditSink

  createPolicyRequest(
    input: Readonly<{
      origin?: 'assistant' | 'agent' | 'graph'
      actor?: { kind: string; id: string }
      route?: PolicyJsonRecord
      routeKey: string
      sessionId: string
      path: string
      target:
        | 'notebook.execute-cell'
        | 'notebook.execute-all'
        | 'notebook.interrupt'
        | 'notebook.restart'
      expectedSha256?: string
      expectedGeneration?: number
      cellIds?: readonly string[]
      artifacts?: readonly string[]
    }>
  ): PolicyRequest {
    const execute = input.target.startsWith('notebook.execute')
    const notebookPath = this.relative(input.path)
    const artifactPaths = execute ? this.artifactPaths(input.artifacts ?? []) : []
    return {
      discriminator: 'magic-agent.policy-request.v1',
      version: 1,
      requestId: randomUUID(),
      actor: input.actor ?? { kind: 'system', id: 'notebook-execution-coordinator' },
      origin: input.origin ?? 'assistant',
      action: execute ? 'notebook.execute' : 'notebook.control',
      target: { kind: 'tool', id: input.target },
      input: {
        path: notebookPath,
        routeKey: input.routeKey,
        expectedSha256: input.expectedSha256 ?? '',
        expectedGeneration: input.expectedGeneration ?? 0,
        cellIds: [...(input.cellIds ?? [])],
        artifacts: artifactPaths,
        command: this.provenance.executable,
        interpreterSha256: this.provenance.sha256
      },
      effects: execute
        ? [
            { kind: 'process.execute', target: this.provenance.executable, risk: 'high' },
            { kind: 'filesystem.read', target: notebookPath, risk: 'high' },
            { kind: 'filesystem.write', target: notebookPath, risk: 'high' },
            ...artifactPaths.map((target) => ({
              kind: 'filesystem.write' as const,
              target,
              risk: 'high' as const
            }))
          ]
        : [{ kind: 'tool.invoke', target: input.target, risk: 'high' }],
      ...(input.route === undefined ? {} : { route: input.route }),
      sessionId: input.sessionId,
      filesystem: {
        cwd: this.root,
        paths: [notebookPath, ...artifactPaths],
        allowedRoots: [this.root]
      }
    }
  }

  async executeCell(input: NotebookExecutionInput): Promise<NotebookExecutionStatus> {
    if (!input.cellIds?.length)
      throw new NotebookToolValidationError('execute-cell requires cellIds.')
    return this.execute(input, input.cellIds)
  }
  async executeAll(input: NotebookExecutionInput): Promise<NotebookExecutionStatus> {
    return this.execute(input)
  }

  status(
    input: Readonly<{ routeKey: string; sessionId: string; path: string; executionId?: string }>
  ): NotebookExecutionStatus {
    const requested = this.relative(input.path)
    const manifest = input.executionId ? this.load(input.executionId) : this.latest(requested)
    this.own(manifest, input.routeKey, input.sessionId, requested)
    if (manifest.jobId && ['starting', 'running'].includes(manifest.state)) this.refresh(manifest)
    return Object.freeze({ ...this.load(manifest.executionId), ...NOTEBOOK_EXECUTION_MODE })
  }

  async interrupt(input: NotebookControlInput): Promise<NotebookExecutionStatus> {
    const requested = this.relative(input.path)
    const prior = this.byIdempotency(input.routeKey, input.sessionId, input.idempotencyKey)
    if (prior) {
      this.own(prior, input.routeKey, input.sessionId, requested)
      return Object.freeze({ ...prior, ...NOTEBOOK_EXECUTION_MODE })
    }
    this.authorizeControl(input, 'notebook.interrupt')
    const manifest = input.executionId ? this.load(input.executionId) : this.findActive(requested)
    if (manifest) this.own(manifest, input.routeKey, input.sessionId, requested)
    const active = Boolean(manifest?.jobId && ['starting', 'running'].includes(manifest.state))
    if (manifest?.jobId && active) {
      await this.jobs.stop({
        jobId: manifest.jobId,
        routeKey: input.routeKey,
        sessionId: input.sessionId
      })
      this.finish({ ...manifest, state: 'interrupted', error: 'Interrupted by request.' })
    }
    const now = Date.now()
    const receipt: NotebookExecutionManifest = {
      version: 1,
      executionId: `interrupt-${hash(`${input.routeKey}\0${input.sessionId}\0${requested}\0${input.idempotencyKey}`)}`,
      idempotencyKey: input.idempotencyKey,
      routeKey: input.routeKey,
      sessionId: input.sessionId,
      notebookPath: requested,
      notebookSha256: hash(readFileSync(this.resolve(requested))),
      generation: this.generation(requested),
      selectedCellIds: [],
      state: active ? 'interrupted' : 'completed-not-applied',
      ...(active ? { error: 'Interrupted by request.' } : {}),
      createdAt: now,
      updatedAt: now
    }
    this.persist(receipt)
    return Object.freeze({ ...receipt, ...NOTEBOOK_EXECUTION_MODE })
  }

  async restart(input: NotebookControlInput): Promise<NotebookExecutionStatus> {
    const requested = this.relative(input.path)
    const prior = this.byIdempotency(input.routeKey, input.sessionId, input.idempotencyKey)
    if (prior) {
      this.own(prior, input.routeKey, input.sessionId, requested)
      return Object.freeze({ ...prior, ...NOTEBOOK_EXECUTION_MODE })
    }
    this.authorizeControl(input, 'notebook.restart')
    const active = this.findActive(requested)
    if (active) this.own(active, input.routeKey, input.sessionId, requested)
    if (active?.jobId)
      await this.jobs.stop({
        jobId: active.jobId,
        routeKey: active.routeKey,
        sessionId: active.sessionId
      })
    if (active) this.finish({ ...active, state: 'interrupted', error: 'Invalidated by restart.' })
    const generation = this.generation(requested) + 1
    this.writeGeneration(requested, generation)
    const now = Date.now()
    const manifest: NotebookExecutionManifest = {
      version: 1,
      executionId: `restart-${hash(`${requested}:${generation}`)}`,
      idempotencyKey: input.idempotencyKey,
      routeKey: input.routeKey,
      sessionId: input.sessionId,
      notebookPath: requested,
      notebookSha256: hash(readFileSync(this.resolve(requested))),
      generation,
      selectedCellIds: [],
      state: 'completed-not-applied',
      createdAt: now,
      updatedAt: now
    }
    this.persist(manifest)
    return Object.freeze({ ...manifest, ...NOTEBOOK_EXECUTION_MODE })
  }

  private async execute(
    input: NotebookExecutionInput,
    selected?: readonly string[]
  ): Promise<NotebookExecutionStatus> {
    const requested = this.relative(input.path)
    const prior = this.byIdempotency(input.routeKey, input.sessionId, input.idempotencyKey)
    if (prior) {
      if (prior.notebookPath !== requested)
        throw new NotebookToolValidationError('Idempotency key belongs to another notebook.')
      return this.status({ ...input, executionId: prior.executionId })
    }
    if (this.findActive(requested))
      throw new NotebookToolValidationError('Concurrent notebook execution is not allowed.')
    const file = this.resolve(requested)
    const before = readFileSync(file)
    const beforeSha = hash(before)
    if (beforeSha !== input.expectedSha256)
      throw new NotebookToolValidationError('expectedSha256 is stale.')
    const generation = this.generation(requested)
    if (input.expectedGeneration !== generation)
      throw new NotebookToolValidationError('expectedGeneration is stale.')
    const notebook = parseNotebook(before)
    const selectedCells = notebook.cells.filter(
      (cell) => cell.cell_type === 'code' && (!selected || selected.includes(cell.id))
    )
    if (
      !selectedCells.length ||
      (selected &&
        (selectedCells.length !== selected.length ||
          selectedCells.length !== new Set(selected).size))
    )
      throw new NotebookToolValidationError('Selected cell ids must identify unique code cells.')
    const artifactPaths = this.artifactPaths(input.artifacts ?? [])
    this.validateRequest(
      input.request,
      selected ? 'notebook.execute-cell' : 'notebook.execute-all',
      requested,
      beforeSha,
      generation,
      selected ? selectedCells.map((cell) => cell.id) : [],
      artifactPaths
    )
    const auth = this.authorization.authorize({
      authorizationId: input.authorizationId,
      request: input.request,
      evaluatedAt: Date.now(),
      grantId: input.grantId,
      expectedGrantUseCount: input.expectedGrantUseCount,
      idempotencyKey: `${input.idempotencyKey}:authorize`
    })
    if (auth.status !== 'authorized')
      throw new NotebookToolAuthorizationError(auth.status, auth.reason)
    if (!this.authorization.isTrustedPermit(auth.permit))
      throw new NotebookToolAuthorizationError('denied', 'Untrusted execution permit.')
    const executionId = hash(
      `${input.routeKey}\0${input.sessionId}\0${input.idempotencyKey}\0${beforeSha}\0${generation}`
    )
    const dir = path.join(this.storeDir, executionId)
    mkdirSync(dir, { recursive: true })
    const payload = {
      protocol: 'magicpot-notebook-input.v1',
      executionId,
      cells: selectedCells.map((cell) => ({ id: cell.id, source: cell.source.join('') }))
    }
    const payloadText = `${stable(payload)}\n`
    const payloadSha = hash(payloadText)
    const inputPath = path.join(dir, `${payloadSha}.input.json`)
    if (!existsSync(inputPath)) writeFileSync(inputPath, payloadText, { flag: 'wx', mode: 0o600 })
    const wrapper = buildWrapper(inputPath)
    const wrapperSha = hash(wrapper)
    const wrapperPath = path.join(dir, `${wrapperSha}.wrapper.py`)
    if (!existsSync(wrapperPath)) writeFileSync(wrapperPath, wrapper, { flag: 'wx', mode: 0o600 })
    const now = Date.now()
    const manifest: NotebookExecutionManifest = {
      version: 1,
      executionId,
      idempotencyKey: input.idempotencyKey,
      routeKey: input.routeKey,
      sessionId: input.sessionId,
      notebookPath: requested,
      notebookSha256: beforeSha,
      generation,
      selectedCellIds: selectedCells.map((cell) => cell.id),
      declaredArtifactPaths: artifactPaths,
      state: 'starting',
      createdAt: now,
      updatedAt: now
    }
    this.persist(manifest)
    this.audit(manifest, 'started')
    const job = await this.jobs.start({
      authorizationId: input.authorizationId,
      idempotencyKey: input.idempotencyKey,
      request: input.request,
      routeKey: input.routeKey,
      sessionId: input.sessionId,
      wrapperPath,
      wrapperSha256: wrapperSha,
      cwd: this.root,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: Math.min(input.maxOutputBytes ?? MAX_PROTOCOL_BYTES, MAX_PROTOCOL_BYTES),
      grantId: input.grantId,
      expectedGrantUseCount: input.expectedGrantUseCount,
      beforeSpawn: () => {
        const current = readFileSync(file)
        if (hash(current) !== beforeSha || this.generation(requested) !== generation)
          throw new NotebookToolValidationError('Notebook changed before spawn.')
        this.authorization.consumeExecutionPermit({
          permit: auth.permit,
          request: input.request,
          consumedAt: Date.now(),
          idempotencyKey: `${input.idempotencyKey}:consume`
        })
        this.audit(manifest, 'permit-consumed-spawn-dispatched')
      }
    })
    return Object.freeze({
      ...this.finish({
        ...manifest,
        jobId: job.jobId,
        state: job.state === 'running' ? 'running' : 'starting'
      }),
      ...NOTEBOOK_EXECUTION_MODE
    })
  }

  private refresh(manifest: NotebookExecutionManifest): void {
    const job = this.jobs.status({
      jobId: manifest.jobId!,
      routeKey: manifest.routeKey,
      sessionId: manifest.sessionId
    })
    if (!TERMINAL.has(job.state)) {
      this.finish({ ...manifest, state: 'running' })
      return
    }
    if (job.state === 'stopped' || job.state === 'stopped-interrupted') {
      this.finish({ ...manifest, state: 'interrupted', error: 'Execution interrupted.' })
      return
    }
    if (job.state !== 'completed') {
      this.finish({
        ...manifest,
        state: job.outcome === 'unknown' ? 'crashed' : 'failed',
        error: job.stopOutcome ?? `Job ended ${job.state}.`
      })
      return
    }
    try {
      const raw = this.jobs.read({
        jobId: job.jobId,
        routeKey: manifest.routeKey,
        sessionId: manifest.sessionId,
        stream: 'stdout',
        maxBytes: MAX_PROTOCOL_BYTES
      }).data
      const result = parseProtocol(raw)
      if (result.status !== 'completed') {
        this.finish({
          ...manifest,
          state: result.status === 'interrupted' ? 'interrupted' : 'failed',
          error: redactSecretCredentialText(result.error ?? 'Notebook execution failed.')
        })
        return
      }
      const artifacts = this.captureArtifacts(manifest.declaredArtifactPaths ?? [])
      this.registerArtifacts(manifest, artifacts)
      this.apply({ ...manifest, artifacts }, result)
    } catch (error) {
      this.finish({
        ...manifest,
        state: 'failed',
        error: redactSecretCredentialText(error instanceof Error ? error.message : String(error))
      })
    }
  }

  private apply(manifest: NotebookExecutionManifest, result: ResultDocument): void {
    const target = this.resolve(manifest.notebookPath)
    const current = readFileSync(target)
    if (
      hash(current) !== manifest.notebookSha256 ||
      this.generation(manifest.notebookPath) !== manifest.generation
    ) {
      this.finish({
        ...manifest,
        state: 'completed-not-applied',
        resultSha256: hash(stable(result))
      })
      return
    }
    const notebook = parseNotebook(current)
    const results = new Map(result.cells.map((cell) => [cell.cellId, cell]))
    if (
      results.size !== manifest.selectedCellIds.length ||
      manifest.selectedCellIds.some((id) => !results.has(id))
    )
      throw new NotebookToolValidationError('Result protocol cell set does not match selection.')
    for (const cell of notebook.cells) {
      const resultCell = results.get(cell.id)
      if (!resultCell) continue
      cell.execution_count = resultCell.executionCount
      const outputs: Json[] = []
      if (resultCell.stdout)
        outputs.push({
          output_type: 'stream',
          name: 'stdout',
          text: [redactSecretCredentialText(boundText(resultCell.stdout, MAX_STREAM_BYTES))]
        })
      if (resultCell.stderr)
        outputs.push({
          output_type: 'stream',
          name: 'stderr',
          text: [redactSecretCredentialText(boundText(resultCell.stderr, MAX_STREAM_BYTES))]
        })
      for (const display of resultCell.displays)
        outputs.push({
          output_type: 'display_data',
          data: {
            [display.mime]:
              display.mime === 'text/plain' || display.mime === 'text/markdown'
                ? redactSecretCredentialText(display.data as string)
                : display.data
          },
          metadata: {}
        })
      if (resultCell.result !== undefined)
        outputs.push({
          output_type: 'execute_result',
          execution_count: resultCell.executionCount,
          data: {
            'text/plain': redactSecretCredentialText(
              boundText(resultCell.result, MAX_DISPLAY_BYTES)
            )
          },
          metadata: {}
        })
      cell.outputs = outputs
    }
    const content = Buffer.from(`${stable(notebook)}\n`)
    const snapshotId = manifest.notebookSha256
    const snap = path.join(this.root, '.magicpot', 'notebook-snapshots')
    mkdirSync(snap, { recursive: true })
    const snapFile = path.join(snap, `${snapshotId}.ipynb`)
    if (!existsSync(snapFile)) writeFileSync(snapFile, current, { flag: 'wx' })
    atomic(target, content)
    this.writeGeneration(manifest.notebookPath, manifest.generation + 1)
    this.finish({
      ...manifest,
      state: 'completed-applied',
      resultSha256: hash(stable(result)),
      snapshotId
    })
  }

  private authorizeControl(
    input: NotebookControlInput,
    target: 'notebook.interrupt' | 'notebook.restart'
  ): void {
    this.validateControlRequest(
      input.request,
      target,
      this.relative(input.path),
      input.routeKey,
      input.sessionId
    )
    const auth = this.authorization.authorize({
      authorizationId: input.authorizationId,
      request: input.request,
      evaluatedAt: Date.now(),
      grantId: input.grantId,
      expectedGrantUseCount: input.expectedGrantUseCount,
      idempotencyKey: `${input.idempotencyKey}:authorize`
    })
    if (auth.status !== 'authorized')
      throw new NotebookToolAuthorizationError(auth.status, auth.reason)
    if (!this.authorization.isTrustedPermit(auth.permit))
      throw new NotebookToolAuthorizationError('denied', 'Untrusted control permit.')
    this.authorization.consumeExecutionPermit({
      permit: auth.permit,
      request: input.request,
      consumedAt: Date.now(),
      idempotencyKey: `${input.idempotencyKey}:consume`
    })
  }
  private validateRequest(
    request: PolicyRequest,
    target: string,
    requested: string,
    sha: string,
    generation: number,
    cellIds: readonly string[],
    artifacts: readonly string[]
  ): void {
    if (
      request.action !== 'notebook.execute' ||
      request.target.kind !== 'tool' ||
      request.target.id !== target ||
      request.input.path !== requested ||
      request.input.routeKey === undefined ||
      request.input.expectedSha256 !== sha ||
      request.input.expectedGeneration !== generation ||
      JSON.stringify(request.input.cellIds) !== JSON.stringify(cellIds) ||
      JSON.stringify(request.input.artifacts) !== JSON.stringify(artifacts) ||
      request.input.command !== this.provenance.executable ||
      request.input.interpreterSha256 !== this.provenance.sha256 ||
      request.filesystem?.cwd !== this.root ||
      JSON.stringify(request.filesystem.paths) !== JSON.stringify([requested, ...artifacts])
    )
      throw new NotebookToolValidationError('Policy request does not match notebook execution.')
  }
  private validateControlRequest(
    request: PolicyRequest,
    target: string,
    requested: string,
    routeKey: string,
    sessionId: string
  ): void {
    if (
      request.action !== 'notebook.control' ||
      request.target.kind !== 'tool' ||
      request.target.id !== target ||
      request.input.path !== requested ||
      request.input.routeKey !== routeKey ||
      request.sessionId !== sessionId
    )
      throw new NotebookToolValidationError('Policy request does not match notebook control.')
  }
  private artifactPaths(values: readonly string[]): string[] {
    if (values.length > MAX_ARTIFACTS)
      throw new NotebookToolValidationError('Artifact declarations are invalid.')
    const paths = values.map((value) => this.relative(value))
    if (new Set(paths).size !== paths.length)
      throw new NotebookToolValidationError('Artifact declarations are invalid.')
    for (const relative of paths) this.resolveOutput(relative)
    return paths
  }
  private captureArtifacts(values: readonly string[]): NotebookExecutionArtifact[] {
    let total = 0
    return values.map((relative) => {
      const file = this.resolveOutput(relative)
      if (!existsSync(file)) throw new NotebookToolValidationError('Declared artifact is missing.')
      const stats = lstatSync(file)
      if (stats.isSymbolicLink() || !stats.isFile())
        throw new NotebookToolValidationError('Artifact size or type is not allowed.')
      const real = path.resolve(realpathSync.native(file))
      if (!inside(this.root, real))
        throw new NotebookToolValidationError('Symlinks are not allowed.')
      if (stats.size > MAX_ARTIFACT_BYTES || (total += stats.size) > MAX_ARTIFACT_TOTAL_BYTES)
        throw new NotebookToolValidationError('Artifact size or type is not allowed.')
      return {
        path: relative,
        size: stats.size,
        sha256: hash(readFileSync(file)),
        modifiedAt: stats.mtimeMs
      }
    })
  }
  private registerArtifacts(
    manifest: NotebookExecutionManifest,
    artifacts: readonly NotebookExecutionArtifact[]
  ): void {
    if (!this.auditSink || artifacts.length === 0) return
    const inputs = artifacts.flatMap((artifact) => {
      const id = hash(`${manifest.executionId} ${artifact.path}`)
      if (this.auditSink!.getResource('artifact', id)) return []
      const streamId = `artifact:${id}`
      const mimeType = artifactMimeType(artifact.path)
      return [
        {
          operation: 'create' as const,
          kind: 'artifact' as const,
          id,
          idempotencyKey: `notebook-artifact:${id}`,
          state: {
            sha256: artifact.sha256,
            mimeType,
            size: artifact.size,
            relativePath: artifact.path,
            metadata: { source: 'notebook-execution', executionId: manifest.executionId }
          },
          createdAt: manifest.updatedAt,
          event: {
            protocolVersion: '2.0.0',
            envelopeKind: 'event' as const,
            id: hash(`${streamId} created`),
            type: 'notebook.artifact.registered',
            createdAt: manifest.updatedAt,
            streamId,
            sequence: 0,
            actor: { kind: 'system', id: 'notebook-execution-coordinator' },
            payload: {
              artifactId: id,
              executionId: manifest.executionId,
              sha256: artifact.sha256,
              mimeType,
              size: artifact.size
            }
          }
        }
      ]
    })
    if (inputs.length) this.auditSink.mutateResourcesBatch(inputs)
  }
  private own(
    m: NotebookExecutionManifest,
    route: string,
    session: string,
    requested: string
  ): void {
    if (m.routeKey !== route || m.sessionId !== session || m.notebookPath !== requested)
      throw new NotebookToolValidationError('Notebook execution ownership mismatch.')
  }
  private resolveOutput(value: string): string {
    const target = path.resolve(this.root, value)
    if (!inside(this.root, target)) throw new NotebookToolValidationError('Path escapes workspace.')
    let current = path.dirname(target)
    while (inside(this.root, current) && current !== this.root) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink())
        throw new NotebookToolValidationError('Symlinks are not allowed.')
      current = path.dirname(current)
    }
    if (existsSync(target) && lstatSync(target).isSymbolicLink())
      throw new NotebookToolValidationError('Symlinks are not allowed.')
    return target
  }
  private resolve(value: string): string {
    const target = path.resolve(this.root, value)
    if (!inside(this.root, target)) throw new NotebookToolValidationError('Path escapes workspace.')
    if (lstatSync(target).isSymbolicLink())
      throw new NotebookToolValidationError('Symlinks are not allowed.')
    const real = path.resolve(realpathSync.native(target))
    if (!inside(this.root, real)) throw new NotebookToolValidationError('Symlinks are not allowed.')
    return real
  }
  private relative(value: string): string {
    if (!value || path.isAbsolute(value))
      throw new NotebookToolValidationError('Path must be workspace-relative.')
    const normalized = path.posix.normalize(value.replace(/\\/g, '/'))
    if (
      normalized === '.' ||
      normalized !== value.replace(/\\/g, '/') ||
      normalized.split('/').includes('..') ||
      normalized === '.magicpot' ||
      normalized.startsWith('.magicpot/')
    )
      throw new NotebookToolValidationError('Reserved or traversal path.')
    return normalized
  }
  private manifestPath(id: string): string {
    return path.join(this.storeDir, id, 'manifest.json')
  }
  private persist(m: NotebookExecutionManifest): void {
    mkdirSync(path.dirname(this.manifestPath(m.executionId)), { recursive: true })
    atomic(this.manifestPath(m.executionId), Buffer.from(`${stable(m)}\n`))
  }
  private finish(m: NotebookExecutionManifest): NotebookExecutionManifest {
    const next = { ...m, updatedAt: Date.now() }
    this.persist(next)
    if (!['starting', 'running'].includes(next.state)) this.audit(next, next.state)
    return next
  }
  private audit(m: NotebookExecutionManifest, phase: string): void {
    if (!this.auditSink) return
    const streamId = `notebook-execution:${m.executionId}`
    const id = hash(`${streamId}\0${phase}`)
    if (this.auditSink.getEvent(id)) return
    const artifacts = m.artifacts ?? []
    this.auditSink.appendBatch([
      {
        protocolVersion: '2.0.0',
        envelopeKind: 'event',
        id,
        type: `notebook.execution.${phase}`,
        createdAt: m.updatedAt,
        streamId,
        sequence: (this.auditSink.getLastSequence(streamId) ?? -1) + 1,
        actor: { kind: 'system', id: 'notebook-execution-coordinator' },
        payload: {
          executionId: m.executionId,
          notebookSha256: m.notebookSha256,
          generation: m.generation,
          state: m.state,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          artifactCount: artifacts.length,
          artifactBytes: artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
          artifactIds: artifacts.map((artifact) => hash(`${m.executionId} ${artifact.path}`))
        }
      }
    ])
  }
  private load(id: string): NotebookExecutionManifest {
    return JSON.parse(readFileSync(this.manifestPath(id), 'utf8')) as NotebookExecutionManifest
  }
  private all(): NotebookExecutionManifest[] {
    if (!existsSync(this.storeDir)) return []
    return readdirSync(this.storeDir).flatMap((id) => {
      try {
        return [this.load(id)]
      } catch {
        return []
      }
    })
  }
  private latest(requested: string): NotebookExecutionManifest {
    const found = this.all()
      .filter((m) => m.notebookPath === requested)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!found) throw new NotebookToolValidationError('Notebook execution not found.')
    return found
  }
  private byIdempotency(
    route: string,
    session: string,
    key: string
  ): NotebookExecutionManifest | undefined {
    return this.all().find(
      (m) => m.routeKey === route && m.sessionId === session && m.idempotencyKey === key
    )
  }
  private findActive(requested: string): NotebookExecutionManifest | undefined {
    return this.all().find(
      (m) => m.notebookPath === requested && ['starting', 'running'].includes(m.state)
    )
  }
  private generation(requested: string): number {
    const file = path.join(this.storeDir, `generation-${hash(requested)}.json`)
    if (!existsSync(file)) return 0
    const value = JSON.parse(readFileSync(file, 'utf8')) as { generation: number }
    return value.generation
  }
  private writeGeneration(requested: string, generation: number): void {
    atomic(
      path.join(this.storeDir, `generation-${hash(requested)}.json`),
      Buffer.from(`${JSON.stringify({ path: requested, generation })}\n`)
    )
  }
  private reconcile(): void {
    for (const manifest of this.all())
      if (['starting', 'running'].includes(manifest.state))
        this.finish({
          ...manifest,
          state: 'crashed',
          error: 'Coordinator restarted; execution was not rerun.'
        })
  }
}

export class PythonNotebookExecutionBoundary implements NotebookExecutionJobBoundary {
  constructor(
    private readonly manager: PythonJobManager,
    private readonly executable: string
  ) {}
  start(input: Parameters<NotebookExecutionJobBoundary['start']>[0]): Promise<CommandJobRecord> {
    if (hash(readFileSync(input.wrapperPath)) !== input.wrapperSha256)
      throw new NotebookToolValidationError('Notebook wrapper identity changed before execution.')
    return this.manager.background({
      authorizationId: input.authorizationId,
      idempotencyKey: input.idempotencyKey,
      request: input.request,
      routeKey: input.routeKey,
      sessionId: input.sessionId,
      command: this.executable,
      args: ['-I', '-S', '-B', '-u', input.wrapperPath],
      cwd: input.cwd,
      env: { PYTHONNOUSERSITE: '1', PIP_NO_INDEX: '1' },
      shell: false,
      timeoutMs: input.timeoutMs,
      maxLogBytes: input.maxOutputBytes,
      grantId: input.grantId,
      expectedGrantUseCount: input.expectedGrantUseCount,
      beforeConsume: input.beforeSpawn
    })
  }
  status(input: Parameters<NotebookExecutionJobBoundary['status']>[0]) {
    return this.manager.status(input)
  }
  read(input: Parameters<NotebookExecutionJobBoundary['read']>[0]) {
    return this.manager.read(input)
  }
  stop(input: Parameters<NotebookExecutionJobBoundary['stop']>[0]) {
    return this.manager.stop(input)
  }
}

function parseNotebook(value: Buffer): Notebook {
  const doc = JSON.parse(value.toString('utf8')) as Notebook
  if (doc.nbformat !== 4 || !Array.isArray(doc.cells))
    throw new NotebookToolValidationError('Invalid v4 notebook.')
  return doc
}
function parseProtocol(raw: string): ResultDocument {
  if (Buffer.byteLength(raw) > MAX_PROTOCOL_BYTES)
    throw new NotebookToolValidationError('Result protocol exceeds bound.')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  if (lines.length !== 1)
    throw new NotebookToolValidationError('Result protocol must contain exactly one JSONL record.')
  const result = JSON.parse(lines[0]) as ResultDocument
  if (
    result.protocol !== 'magicpot-notebook-result.v1' ||
    !['completed', 'error', 'interrupted'].includes(result.status) ||
    !Array.isArray(result.cells)
  )
    throw new NotebookToolValidationError('Invalid result protocol.')
  for (const cell of result.cells) {
    if (
      typeof cell.cellId !== 'string' ||
      !Number.isInteger(cell.executionCount) ||
      typeof cell.stdout !== 'string' ||
      typeof cell.stderr !== 'string' ||
      !Array.isArray(cell.displays)
    )
      throw new NotebookToolValidationError('Invalid cell result.')
    boundText(cell.stdout, MAX_STREAM_BYTES)
    boundText(cell.stderr, MAX_STREAM_BYTES)
    if (cell.result !== undefined) boundText(cell.result, MAX_DISPLAY_BYTES)
    for (const display of cell.displays) validateDisplay(display)
  }
  if (result.error !== undefined) {
    if (typeof result.error !== 'string')
      throw new NotebookToolValidationError('Invalid result error.')
    boundText(result.error, MAX_STREAM_BYTES)
  }
  return result
}
function validateDisplay(display: ResultCell['displays'][number]): void {
  if (!display || typeof display !== 'object' || !MIME.has(display.mime))
    throw new NotebookToolValidationError('Display MIME or size is not allowed.')
  if (display.mime === 'text/plain' || display.mime === 'text/markdown') {
    if (typeof display.data !== 'string')
      throw new NotebookToolValidationError('Text display data must be a string.')
    boundText(display.data, MAX_DISPLAY_BYTES)
    return
  }
  if (display.mime === 'image/png' || display.mime === 'image/jpeg') {
    if (typeof display.data !== 'string' || !isBoundedBase64(display.data, MAX_DISPLAY_BYTES))
      throw new NotebookToolValidationError('Image display data must be bounded base64.')
    return
  }
  if (!isSafeJson(display.data))
    throw new NotebookToolValidationError('JSON display data is not safe.')
  if (Buffer.byteLength(JSON.stringify(display.data)) > MAX_DISPLAY_BYTES)
    throw new NotebookToolValidationError('Display MIME or size is not allowed.')
}
function isBoundedBase64(value: string, maxBytes: number): boolean {
  if (value.length === 0) return true
  if (value.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    return false
  if (value.length % 4 !== 0) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.byteLength <= maxBytes && decoded.toString('base64') === value
}
function isSafeJson(value: unknown, depth = 0, seen = new Set<object>()): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || depth >= MAX_JSON_DEPTH || seen.has(value)) return false
  seen.add(value)
  const safe = Array.isArray(value)
    ? value.every((entry) => isSafeJson(entry, depth + 1, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.entries(value).every(
        ([key, entry]) =>
          !['__proto__', 'prototype', 'constructor'].includes(key) &&
          isSafeJson(entry, depth + 1, seen)
      )
  seen.delete(value)
  return safe
}
function buildWrapper(inputPath: string): string {
  return `import ast,contextlib,io,json,traceback\np=json.load(open(${JSON.stringify(inputPath)},encoding='utf-8'))\ng={'__name__':'__main__'}; out=[]\ndef magicpot_display(data,mime='text/plain'):\n if mime not in {'text/plain','text/markdown','application/json','image/png','image/jpeg'}: raise ValueError('unsupported MIME')\n current['displays'].append({'mime':mime,'data':data})\ng['magicpot_display']=magicpot_display\ntry:\n for n,c in enumerate(p['cells'],1):\n  current={'cellId':c['id'],'executionCount':n,'stdout':'','stderr':'','displays':[]}\n  so,se=io.StringIO(),io.StringIO(); tree=ast.parse(c['source'],filename='<cell '+c['id']+'>',mode='exec'); last=None\n  if tree.body and isinstance(tree.body[-1],ast.Expr): last=ast.Expression(tree.body.pop().value)\n  with contextlib.redirect_stdout(so),contextlib.redirect_stderr(se):\n   exec(compile(tree,'<cell '+c['id']+'>','exec'),g,g)\n   if last is not None:\n    v=eval(compile(last,'<cell '+c['id']+'>','eval'),g,g)\n    if v is not None: current['result']=repr(v)\n  current['stdout']=so.getvalue(); current['stderr']=se.getvalue(); out.append(current)\n print(json.dumps({'protocol':'magicpot-notebook-result.v1','status':'completed','cells':out},separators=(',',':')))\nexcept KeyboardInterrupt:\n print(json.dumps({'protocol':'magicpot-notebook-result.v1','status':'interrupted','cells':[],'error':'interrupted'},separators=(',',':')))\nexcept BaseException:\n print(json.dumps({'protocol':'magicpot-notebook-result.v1','status':'error','cells':[],'error':traceback.format_exc(limit=20)},separators=(',',':')))\n`
}
function boundText(value: string, max: number): string {
  if (Buffer.byteLength(value) > max)
    throw new NotebookToolValidationError('Stream or display exceeds bound.')
  return value
}
function atomic(target: string, content: Buffer): void {
  mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.${randomUUID()}.tmp`
  writeFileSync(temp, content, { flag: 'wx', mode: 0o600 })
  renameSync(temp, target)
}
function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}
function artifactMimeType(relativePath: string): string {
  switch (path.posix.extname(relativePath).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.json':
      return 'application/json'
    case '.txt':
    case '.log':
      return 'text/plain'
    case '.md':
      return 'text/markdown'
    case '.csv':
      return 'text/csv'
    case '.pdf':
      return 'application/pdf'
    default:
      return 'application/octet-stream'
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
