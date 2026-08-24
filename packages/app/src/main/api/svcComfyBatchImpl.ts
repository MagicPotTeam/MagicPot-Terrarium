import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'
import type {
  BatchIdReq,
  ComfyBatchItemSummary,
  ComfyBatchState,
  ComfyBatchStatus,
  ComfyBatchSvc,
  ComfyInstanceProfile,
  ProbeComfyInstanceReq,
  ProbeComfyInstanceResp,
  PutComfyInstanceReq,
  RemoveComfyInstanceReq,
  ResolveComfyBatchSubmissionReq,
  StartComfyBatchReq,
  UpdateComfyInstanceReq
} from '@shared/api/svcComfyBatch'
import type { BatchManifestItem } from '@shared/api/svcFs'
import type { ComfyHistory, FileItem } from '@shared/comfy/types'
import { isComfyPostError } from '../comfy/error'
import type { ComfyInstanceRegistry } from '../comfy/instanceRegistry'
import {
  getComfyInstanceRegistry,
  getComfyInstanceReservationCount,
  tryReserveComfyInstanceCapacity
} from '../comfy/instancePool'
import { ComfyHttpCli } from '../comfy/http'
import {
  comfyBatchStateDatabasePath,
  SqliteComfyBatchStateStore,
  type ComfyBatchStateStore
} from '../comfy/batchStateStore'
import { ComfyLeastUtilizationScheduler, getWorkflowRequiredNodeClasses } from '../comfy/scheduler'
import { FsSvcImpl } from './svcFsImpl'

const POLL_MS = 250
const CAPACITY_POLL_MS = 1_000
const CANCEL_CONFIRM_TIMEOUT_MS = 15_000
const TERMINAL_BATCH_STATUSES = new Set<ComfyBatchStatus>(['cancelled', 'succeeded', 'failed'])
const TRANSITIONS: Readonly<Record<ComfyBatchStatus, ReadonlySet<ComfyBatchStatus>>> = {
  queued: new Set(['running', 'paused', 'cancelling', 'failed']),
  running: new Set(['paused', 'cancelling', 'succeeded', 'failed']),
  paused: new Set(['queued', 'cancelling']),
  cancelling: new Set(['cancelled']),
  cancelled: new Set(),
  succeeded: new Set(),
  failed: new Set(['queued'])
}
const isTestRuntime = (): boolean => process.env.NODE_ENV === 'test'
const stateStorageRoot = (): string =>
  isTestRuntime()
    ? path.join(process.cwd(), '.magicpot-test', 'comfy-batch')
    : path.join(app.getPath('userData'), 'comfy-batch')
const stateDatabasePath = (): string =>
  isTestRuntime()
    ? path.join(stateStorageRoot(), 'state.sqlite')
    : comfyBatchStateDatabasePath(app.getPath('userData'))
const legacyStateRoot = (): string => path.join(stateStorageRoot(), 'batches')
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const message = (error: unknown): string => {
  if (error instanceof Error) return error.stack || error.message
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error)
    } catch {
      // Fall through to the string representation.
    }
  }
  return String(error)
}
const clone = <T>(value: T): T => structuredClone(value)
const sourceKey = (sourceRoot: string): string => {
  const resolved = path.resolve(sourceRoot)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

class BatchRunStopped extends Error {
  constructor() {
    super('Batch execution stopped by a lifecycle transition.')
    this.name = 'BatchRunStopped'
  }
}

class DefinitivePromptFailure extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'DefinitivePromptFailure'
  }
}

type RunnerRecord = {
  generation: number
  promise: Promise<void>
  relaunch: boolean
}

type ExecuteOutcome = 'completed' | 'failed' | 'stopped'

export class ComfyBatchSvcImpl implements ComfyBatchSvc {
  private readonly registry: ComfyInstanceRegistry
  private readonly fsSvc: FsSvcImpl
  private readonly stateStore: ComfyBatchStateStore
  private readonly scheduler = new ComfyLeastUtilizationScheduler()
  private readonly batches = new Map<string, ComfyBatchState>()
  private readonly runners = new Map<string, RunnerRecord>()
  private readonly runGenerations = new Map<string, number>()
  private readonly queueStats = new Map<string, { active: number; pending: number }>()
  private readonly mutationTails = new Map<string, Promise<void>>()
  private readonly activeSourceRoots = new Map<string, string>()
  private readonly cancellationRequests = new Set<string>()
  private readonly cancellationOperations = new Map<string, Promise<ComfyBatchState>>()
  private readonly commitsInFlight = new Map<string, Set<string>>()
  private lifecycleTail: Promise<void> = Promise.resolve()
  private readonly ready: Promise<void>

  constructor(
    fsSvc: FsSvcImpl = new FsSvcImpl(),
    stateStore: ComfyBatchStateStore = new SqliteComfyBatchStateStore(stateDatabasePath())
  ) {
    this.fsSvc = fsSvc
    this.stateStore = stateStore
    this.registry = getComfyInstanceRegistry()
    this.ready = this.recover()
  }

  listInstances = async (): Promise<readonly ComfyInstanceProfile[]> => {
    await this.ready
    return this.registry
      .list()
      .filter((entry) => !entry.deleted)
      .map((entry) => ({ revision: entry.revision, state: entry.state }))
  }

  putInstance = async (req: PutComfyInstanceReq): Promise<ComfyInstanceProfile> => {
    await this.ready
    const now = Date.now()
    const entry = this.registry.create({
      ...req,
      kind: 'remote',
      createdAt: now,
      idempotencyKey: crypto.randomUUID()
    })
    return { revision: entry.revision, state: entry.state }
  }

  updateInstance = async (req: UpdateComfyInstanceReq): Promise<ComfyInstanceProfile> => {
    await this.ready
    const current = this.registry.get(req.id)
    if (current?.state.kind === 'local' && req.patch.origin !== undefined) {
      throw new Error(
        'Managed local ComfyUI origins can only be updated by the local runtime bootstrap.'
      )
    }
    const entry = this.registry.update({
      ...req,
      updatedAt: Date.now(),
      idempotencyKey: crypto.randomUUID()
    })
    return { revision: entry.revision, state: entry.state }
  }

  removeInstance = async (req: RemoveComfyInstanceReq): Promise<Record<string, never>> => {
    await this.ready
    this.registry.remove({ ...req, removedAt: Date.now(), idempotencyKey: crypto.randomUUID() })
    return {}
  }

  probeInstance = async (req: ProbeComfyInstanceReq): Promise<ProbeComfyInstanceResp> => {
    await this.ready
    const current = this.registry.get(req.id)
    if (!current || current.deleted) throw new Error('ComfyUI instance not found.')
    const cli = this.client(current.state)
    try {
      const [objectInfo, queue] = await Promise.all([cli.objectInfo(), cli.getQueue()])
      const capabilities = {
        ...current.state.capabilities,
        customNodes: Object.keys(objectInfo).sort(),
        objectInfoDigest: crypto
          .createHash('sha256')
          .update(JSON.stringify(objectInfo))
          .digest('hex')
      }
      let updated = this.registry.update({
        id: req.id,
        expectedRevision: current.revision,
        updatedAt: Date.now(),
        idempotencyKey: crypto.randomUUID(),
        patch: { capabilities }
      })
      updated = this.registry.updateHealth({
        id: req.id,
        expectedRevision: updated.revision,
        status: 'online',
        checkedAt: Date.now(),
        idempotencyKey: crypto.randomUUID()
      })
      const stats = { active: queue.queue_running.length, pending: queue.queue_pending.length }
      this.queueStats.set(req.id, stats)
      return {
        profile: { revision: updated.revision, state: updated.state },
        capabilities,
        queueRunning: stats.active,
        queuePending: stats.pending
      }
    } catch (error) {
      this.registry.updateHealth({
        id: req.id,
        expectedRevision: current.revision,
        status: 'offline',
        checkedAt: Date.now(),
        error: message(error).slice(0, 4000),
        idempotencyKey: crypto.randomUUID()
      })
      throw error
    }
  }

  startBatch = async (req: StartComfyBatchReq): Promise<ComfyBatchState> => {
    await this.ready
    this.validateBinding(req)
    return this.serializeLifecycle(async () => {
      this.assertSourceAvailable(req.sourceRoot)
      const prepared = await this.fsSvc.prepareBatchWorkspace({
        sourceRoot: req.sourceRoot,
        userAuthorized: req.userAuthorized
      })
      this.assertSourceAvailable(prepared.paths.sourceRoot)
      const batchId = crypto.randomUUID()
      const now = new Date().toISOString()
      const state: ComfyBatchState = {
        batchId,
        status: 'queued',
        sourceRoot: path.resolve(prepared.paths.sourceRoot),
        workflow: clone(req.workflow),
        binding: clone(req.binding),
        target: req.target ?? { mode: 'auto' },
        workspace: prepared.paths,
        manifest: prepared.manifest,
        items: prepared.manifest.items.map((item) => ({
          relativeInputPath: item.relativeInputPath,
          status: item.status,
          attempts: item.attempts.length
        })),
        createdAt: now,
        updatedAt: now,
        errorLogPath: path.join(prepared.paths.metadataRoot, 'errors.log')
      }
      this.acquireSource(state)
      this.batches.set(batchId, state)
      try {
        await this.persist(state)
      } catch (error) {
        this.releaseSource(state)
        this.batches.delete(batchId)
        throw error
      }
      this.launch(batchId)
      return state
    })
  }

  getBatch = async (req: BatchIdReq): Promise<ComfyBatchState> => {
    await this.ready
    return this.requireBatch(req.batchId)
  }

  pauseBatch = async (req: BatchIdReq): Promise<ComfyBatchState> => {
    await this.ready
    const current = this.requireBatch(req.batchId)
    if (current.status === 'paused') return current
    if (current.status !== 'queued' && current.status !== 'running') {
      throw new Error(`Cannot pause a Comfy batch from ${current.status}.`)
    }
    return this.setStatus(req.batchId, 'paused')
  }

  resumeBatch = async (req: BatchIdReq): Promise<ComfyBatchState> => {
    await this.ready
    const updated = await this.serializeLifecycle(async () => {
      const state = this.requireBatch(req.batchId)
      if (state.status !== 'paused') {
        throw new Error(`Cannot resume a Comfy batch from ${state.status}.`)
      }
      const unsafeUnknown = state.items.find(
        (item) =>
          item.requiresManualIntervention && item.submissionState === 'unknown' && !item.promptId
      )
      if (unsafeUnknown) {
        throw new Error(
          `Cannot resume ${unsafeUnknown.relativeInputPath}: prompt submission outcome is unknown.`
        )
      }
      const alreadyOwned = this.isSourceOwnedBy(state)
      this.acquireSource(state)
      try {
        return await this.setStatus(req.batchId, 'queued')
      } catch (error) {
        if (!alreadyOwned) this.releaseSource(state)
        throw error
      }
    })
    this.launch(req.batchId)
    return updated
  }

  cancelBatch = (req: BatchIdReq): Promise<ComfyBatchState> => {
    const existing = this.cancellationOperations.get(req.batchId)
    if (existing) return existing
    const operation = this.performCancelBatch(req)
    this.cancellationOperations.set(req.batchId, operation)
    void operation.then(
      () => {
        if (this.cancellationOperations.get(req.batchId) === operation) {
          this.cancellationOperations.delete(req.batchId)
        }
      },
      () => {
        if (this.cancellationOperations.get(req.batchId) === operation) {
          this.cancellationOperations.delete(req.batchId)
        }
      }
    )
    return operation
  }

  private async performCancelBatch(req: BatchIdReq): Promise<ComfyBatchState> {
    await this.ready
    const initial = this.requireBatch(req.batchId)
    if (initial.status === 'cancelled') return initial
    if (initial.status === 'succeeded' || initial.status === 'failed') {
      throw new Error(`Cannot cancel a Comfy batch from ${initial.status}.`)
    }

    this.cancellationRequests.add(req.batchId)
    const commitsAtCancellation = new Set(this.commitsInFlight.get(req.batchId) ?? [])
    let cancelling: ComfyBatchState
    try {
      cancelling =
        initial.status === 'cancelling' ? initial : await this.setStatus(req.batchId, 'cancelling')
      await this.cancelKnownPrompts(cancelling, { allowAmbiguous: true })

      const runner = this.runners.get(req.batchId)
      if (runner) {
        runner.relaunch = false
        await runner.promise
      }
      await this.cancelKnownPrompts(this.requireBatch(req.batchId))
      for (const relativeInputPath of commitsAtCancellation) {
        await this.rollbackCancelledCommit(req.batchId, relativeInputPath)
      }

      return await this.serializeLifecycle(async () => {
        const latest = this.requireBatch(req.batchId)
        const cancelled =
          latest.status === 'cancelled' ? latest : await this.setStatus(req.batchId, 'cancelled')
        this.releaseSource(cancelled)
        return cancelled
      })
    } finally {
      if (this.batches.get(req.batchId)?.status === 'cancelled') {
        this.cancellationRequests.delete(req.batchId)
      }
    }
  }

  resolveSubmission = async (req: ResolveComfyBatchSubmissionReq): Promise<ComfyBatchState> => {
    await this.ready
    let cancelAfterResolution = false
    const resolved = await this.serializeLifecycle(() =>
      this.mutateBatch(req.batchId, async (state): Promise<ComfyBatchState> => {
        const item = state.items.find(
          (candidate) => candidate.relativeInputPath === req.relativeInputPath
        )
        if (!item) throw new Error('Comfy batch item not found.')
        if (
          item.submissionState !== 'unknown' ||
          item.promptId ||
          !item.requiresManualIntervention
        ) {
          throw new Error('This Comfy batch item does not require submission resolution.')
        }
        const now = new Date().toISOString()
        cancelAfterResolution = state.status === 'cancelling'
        let nextItem: ComfyBatchItemSummary
        if (req.outcome === 'submitted') {
          if (!item.instanceOrigin || !item.instanceKind) {
            throw new Error('Cannot resolve a submitted prompt without its immutable endpoint.')
          }
          nextItem = {
            ...item,
            status: 'running',
            promptId: req.promptId,
            submissionState: 'submitted',
            requiresManualIntervention: false,
            error: undefined
          }
        } else if (req.outcome === 'not-submitted') {
          nextItem = {
            relativeInputPath: item.relativeInputPath,
            status: 'pending',
            attempts: item.attempts
          }
        } else {
          nextItem = {
            relativeInputPath: item.relativeInputPath,
            status: 'failed',
            attempts: item.attempts,
            error: 'Submission was manually resolved as cancelled.'
          }
        }
        const items = state.items.map((candidate) =>
          candidate.relativeInputPath === req.relativeInputPath ? nextItem : candidate
        )
        const manifest = {
          ...state.manifest,
          updatedAt: now,
          items: state.manifest.items.map((candidate) => {
            if (candidate.relativeInputPath !== req.relativeInputPath) return candidate
            const status: BatchManifestItem['status'] =
              nextItem.status === 'pending' ? 'pending' : nextItem.status
            return { ...candidate, status, error: nextItem.error }
          })
        }
        await this.fsSvc.writeBatchManifest({ sourceRoot: state.sourceRoot, manifest })
        return { ...state, items, manifest, updatedAt: now }
      })
    )
    if (cancelAfterResolution) return this.cancelBatch({ batchId: req.batchId })
    return resolved
  }

  retryFailed = async (req: BatchIdReq): Promise<ComfyBatchState> => {
    await this.ready
    const updated = await this.serializeLifecycle(async () => {
      const state = this.requireBatch(req.batchId)
      if (state.status !== 'failed') {
        throw new Error(`Cannot retry a Comfy batch from ${state.status}.`)
      }
      const retryable = new Set(
        state.items
          .filter(
            (item) =>
              item.status === 'failed' &&
              !item.requiresManualIntervention &&
              item.submissionState !== 'unknown'
          )
          .map((item) => item.relativeInputPath)
      )
      if (!retryable.size) throw new Error('No safely retryable failed Comfy batch items remain.')

      const alreadyOwned = this.isSourceOwnedBy(state)
      this.acquireSource(state)
      try {
        return await this.mutateBatch(req.batchId, async (current) => {
          this.assertTransition(current.status, 'queued')
          const now = new Date().toISOString()
          const items = current.items.map((item): ComfyBatchItemSummary => {
            if (!retryable.has(item.relativeInputPath)) return item
            return {
              relativeInputPath: item.relativeInputPath,
              status: 'pending',
              attempts: item.attempts
            }
          })
          const manifest = {
            ...current.manifest,
            updatedAt: now,
            items: current.manifest.items.map((item) =>
              retryable.has(item.relativeInputPath) ? { ...item, status: 'pending' as const } : item
            )
          }
          await this.fsSvc.writeBatchManifest({ sourceRoot: current.sourceRoot, manifest })
          return { ...current, status: 'queued', items, manifest, updatedAt: now }
        })
      } catch (error) {
        if (!alreadyOwned) this.releaseSource(state)
        throw error
      }
    })
    this.launch(req.batchId)
    return updated
  }

  private client(state: ComfyInstanceProfile['state']): ComfyHttpCli {
    return this.clientForRoute(state.origin, state.kind)
  }

  private clientForRoute(
    origin: string,
    kind: ComfyInstanceProfile['state']['kind']
  ): ComfyHttpCli {
    return new ComfyHttpCli(undefined, undefined, {
      origin,
      remote: kind === 'remote',
      networkRetries: 3
    })
  }

  private clientForItem(item: ComfyBatchItemSummary): ComfyHttpCli {
    if (!item.instanceOrigin || !item.instanceKind) {
      throw new Error(
        `Cannot operate on ${item.relativeInputPath}: its immutable ComfyUI endpoint was not persisted.`
      )
    }
    return this.clientForRoute(item.instanceOrigin, item.instanceKind)
  }

  private validateBinding(req: StartComfyBatchReq): void {
    const input = req.workflow[req.binding.inputNodeId]
    const output = req.workflow[req.binding.outputNodeId]
    if (!input || !Object.hasOwn(input.inputs, req.binding.inputField))
      throw new Error('Strict input node binding is invalid.')
    if (!output) throw new Error('Strict output node binding is invalid.')
    if (!Number.isSafeInteger(req.binding.outputIndex ?? 0) || (req.binding.outputIndex ?? 0) < 0)
      throw new Error('Invalid output index.')
  }

  private launch(batchId: string): void {
    const existing = this.runners.get(batchId)
    if (existing) {
      existing.relaunch = true
      return
    }
    const generation = (this.runGenerations.get(batchId) ?? 0) + 1
    this.runGenerations.set(batchId, generation)
    const record: RunnerRecord = {
      generation,
      relaunch: false,
      promise: Promise.resolve()
    }
    record.promise = Promise.resolve()
      .then(() => this.run(batchId, generation))
      .catch((error) => this.handleRunnerError(batchId, error))
      .finally(() => this.finishRunner(batchId, record))
    this.runners.set(batchId, record)
  }

  private finishRunner(batchId: string, record: RunnerRecord): void {
    if (this.runners.get(batchId) !== record) return
    this.runners.delete(batchId)
    const state = this.batches.get(batchId)
    if (state?.status === 'queued' && record.relaunch && !this.cancellationRequests.has(batchId)) {
      this.launch(batchId)
    }
  }

  private async handleRunnerError(batchId: string, error: unknown): Promise<void> {
    const detail = message(error)
    const state = this.batches.get(batchId)
    if (
      !state ||
      TERMINAL_BATCH_STATUSES.has(state.status) ||
      state.status === 'paused' ||
      state.status === 'cancelling' ||
      this.cancellationRequests.has(batchId)
    )
      return
    await this.appendError(state, '(batch)', 'launch', error).catch(() => undefined)
    await this.serializeLifecycle(async () => {
      const latest = this.batches.get(batchId)
      if (
        !latest ||
        (latest.status !== 'queued' && latest.status !== 'running') ||
        this.cancellationRequests.has(batchId)
      )
        return
      const failed = await this.setStatus(batchId, 'failed')
      if (failed.status === 'failed') this.releaseSource(failed)
    }).catch(() => undefined)
    console.error(`[ComfyBatch] Batch ${batchId} launch failed: ${detail}`)
  }

  private async run(batchId: string, generation: number): Promise<void> {
    if (
      this.runners.get(batchId)?.generation !== generation ||
      this.cancellationRequests.has(batchId)
    )
      return
    let state = this.requireBatch(batchId)
    if (state.status !== 'queued') return
    state = await this.setStatus(batchId, 'running')
    if (state.status !== 'running') return
    const work = state.items.filter(
      (item) => item.status === 'pending' || (item.status === 'running' && Boolean(item.promptId))
    )
    const profiles = await this.listInstances()
    const workerCount = Math.max(
      1,
      Math.min(
        work.length,
        profiles.reduce((sum, profile) => sum + profile.state.maxConcurrency, 0)
      )
    )
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const current = this.requireBatch(batchId)
        if (current.status !== 'running' || this.cancellationRequests.has(batchId)) return
        const item = work[cursor]
        cursor += 1
        if (!item) return
        const latestItem = current.items.find(
          (candidate) => candidate.relativeInputPath === item.relativeInputPath
        )
        if (
          !latestItem ||
          (latestItem.status !== 'pending' &&
            !(latestItem.status === 'running' && latestItem.promptId))
        ) {
          continue
        }
        await this.executeItem(batchId, item.relativeInputPath)
      }
    }
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    state = this.requireBatch(batchId)
    if (state.status !== 'running') return
    const terminalStatus = state.items.every((item) => item.status === 'succeeded')
      ? 'succeeded'
      : 'failed'
    await this.serializeLifecycle(async () => {
      const latest = this.requireBatch(batchId)
      if (latest.status !== 'running' || this.cancellationRequests.has(batchId)) return
      const terminal = await this.setStatus(batchId, terminalStatus)
      if (terminal.status === terminalStatus) this.releaseSource(terminal)
    })
  }

  private async executeItem(batchId: string, relativePath: string): Promise<void> {
    const initial = this.requireItem(batchId, relativePath)
    if (initial.promptId) {
      await this.continueKnownPrompt(batchId, relativePath)
      return
    }
    if (initial.status !== 'pending') return

    const state = this.requireBatch(batchId)
    const required = { customNodes: getWorkflowRequiredNodeClasses(state.workflow) }
    const excluded = new Set<string>()
    let lastError: unknown
    for (let executionAttempt = 0; executionAttempt < 2; executionAttempt += 1) {
      let lease: { state: ComfyInstanceProfile['state']; release: () => void } | null
      try {
        lease = await this.waitForCapacity(state.batchId, state.target, required, excluded)
      } catch (error) {
        await this.failUnsubmittedItem(batchId, relativePath, 'scheduler', error)
        return
      }
      if (!lease) return
      excluded.add(lease.state.id)
      try {
        const outcome = await this.executeOnInstance(batchId, relativePath, lease.state.id)
        if (outcome !== 'completed') return
        return
      } catch (error) {
        if (error instanceof BatchRunStopped) return
        lastError = error
        const latest = this.requireItem(batchId, relativePath)
        if (latest.submissionToken) {
          if (latest.promptId) await this.pauseKnownPrompt(batchId, relativePath, error)
          else await this.markAmbiguousSubmission(batchId, relativePath, error)
          return
        }
        await this.appendError(this.requireBatch(batchId), relativePath, lease.state.id, error)
      } finally {
        lease.release()
      }
    }
    await this.failUnsubmittedItem(batchId, relativePath, 'dispatch', lastError)
  }

  private async waitForCapacity(
    batchId: string,
    target: ComfyBatchState['target'],
    required: { customNodes: string[] },
    excluded: ReadonlySet<string>
  ): Promise<{ state: ComfyInstanceProfile['state']; release: () => void } | null> {
    for (;;) {
      const batch = this.requireBatch(batchId)
      if (batch.status !== 'running' || this.cancellationRequests.has(batchId)) return null

      const profiles = (await this.listInstances()).filter(
        (profile) =>
          !excluded.has(profile.state.id) && this.matchesDispatchTarget(profile.state, target)
      )
      if (!profiles.length) {
        throw new Error('No enabled ComfyUI instance matches the batch target.')
      }

      const probed: (ComfyInstanceProfile | undefined)[] = await Promise.all(
        profiles.map(async (profile): Promise<ComfyInstanceProfile | undefined> => {
          try {
            const cli = this.client(profile.state)
            const [objectInfo, queue] = await Promise.all([cli.objectInfo(), cli.getQueue()])
            const customNodes = Object.keys(objectInfo).sort()
            if (!required.customNodes.every((node) => customNodes.includes(node))) return undefined
            this.queueStats.set(profile.state.id, {
              active: queue.queue_running.length,
              pending: queue.queue_pending.length
            })
            return {
              revision: profile.revision,
              state: {
                ...profile.state,
                health: { ...profile.state.health, status: 'online' },
                capabilities: { ...profile.state.capabilities, customNodes }
              }
            }
          } catch {
            return undefined
          }
        })
      )
      const reachable = probed.filter(
        (profile): profile is ComfyInstanceProfile => profile !== undefined
      )

      if (!reachable.length) {
        await delay(CAPACITY_POLL_MS)
        continue
      }

      const candidate = this.scheduler.select(
        reachable.map((profile) => {
          const stats = this.queueStats.get(profile.state.id) ?? { active: 0, pending: 0 }
          return {
            state: profile.state,
            active: stats.active + getComfyInstanceReservationCount(profile.state.id),
            pending: stats.pending
          }
        }),
        target,
        required,
        excluded
      )
      if (candidate) {
        const stats = this.queueStats.get(candidate.state.id) ?? { active: 0, pending: 0 }
        const release = tryReserveComfyInstanceCapacity(
          candidate.state,
          stats.active,
          stats.pending
        )
        if (release) return { state: candidate.state, release }
      }

      await delay(CAPACITY_POLL_MS)
    }
  }

  private matchesDispatchTarget(
    instance: ComfyInstanceProfile['state'],
    target: ComfyBatchState['target']
  ): boolean {
    if (!instance.enabled) return false
    if (target.mode === 'specific') return target.instanceId === instance.id
    if (target.mode === 'tag') return instance.tags.includes(target.tag)
    if (target.mode === 'local-only') return instance.kind === 'local'
    return true
  }

  private async executeOnInstance(
    batchId: string,
    relativePath: string,
    instanceId: string
  ): Promise<ExecuteOutcome> {
    const state = this.requireBatch(batchId)
    const profile = this.registry.get(instanceId)
    if (!profile || profile.deleted) throw new Error('Scheduled instance disappeared.')
    const manifestItem = state.manifest.items.find(
      (item) => item.relativeInputPath === relativePath
    )
    if (!manifestItem) throw new Error('Batch manifest item disappeared.')

    const source = await this.fsSvc.readBatchSourceImage({
      sourceRoot: state.sourceRoot,
      relativeInputPath: relativePath,
      sourceFingerprint: manifestItem.sourceFingerprint
    })
    const cli = this.client(profile.state)
    const uploaded = await cli.uploadImage(
      {
        filename: source.filename,
        type: 'input',
        subfolder: `magicpot-batch/${batchId}`
      },
      source.image
    )
    const workflow = clone(state.workflow)
    const uploadedFilename = uploaded.filename ?? source.filename
    workflow[state.binding.inputNodeId].inputs[state.binding.inputField] = uploaded.subfolder
      ? `${uploaded.subfolder.replace(/\\/g, '/')}/${uploadedFilename}`
      : uploadedFilename

    const prepared = await this.beginSubmission(batchId, relativePath, profile.state)
    if (!prepared?.submissionToken) return 'stopped'
    if (this.cancellationRequests.has(batchId) || this.requireBatch(batchId).status !== 'running') {
      await this.abortPreparedSubmission(batchId, relativePath)
      return 'stopped'
    }
    let promptId: string
    try {
      const prompt = await cli.prompt({
        prompt: workflow,
        client_id: `magicpot-batch-${batchId}`,
        extra_data: {
          batchId,
          relativeInputPath: relativePath,
          submissionToken: prepared.submissionToken!
        }
      })
      promptId = prompt.prompt_id
    } catch (error) {
      if (this.isDefinitiveValidationRejection(error)) {
        await this.failSubmittedItem(batchId, relativePath, instanceId, error)
        return 'failed'
      }
      await this.markAmbiguousSubmission(batchId, relativePath, error)
      return 'stopped'
    }

    await this.bindPrompt(batchId, relativePath, promptId)
    if (this.cancellationRequests.has(batchId)) {
      await cli.cancel(promptId).catch(() => undefined)
      return 'stopped'
    }
    return this.continueKnownPrompt(batchId, relativePath, cli)
  }

  private submissionToken(batchId: string, relativePath: string, attempt: number): string {
    const digest = crypto
      .createHash('sha256')
      .update(`${batchId}\0${relativePath}\0${attempt}`)
      .digest('hex')
    return `magicpot-batch-${digest}`
  }

  private async beginSubmission(
    batchId: string,
    relativePath: string,
    instance: ComfyInstanceProfile['state']
  ): Promise<ComfyBatchItemSummary | null> {
    let prepared: ComfyBatchItemSummary | null = null
    await this.mutateBatch(batchId, async (state) => {
      if (state.status !== 'running' || this.cancellationRequests.has(batchId)) return state
      const current = state.items.find((item) => item.relativeInputPath === relativePath)
      if (!current || current.status !== 'pending' || current.submissionToken) return state
      const now = new Date().toISOString()
      const attempt = current.attempts + 1
      const submissionToken = this.submissionToken(batchId, relativePath, attempt)
      prepared = {
        ...current,
        status: 'running',
        instanceId: instance.id,
        instanceOrigin: instance.origin,
        instanceKind: instance.kind,
        attempts: attempt,
        submissionToken,
        submissionState: 'prepared',
        requiresManualIntervention: false,
        error: undefined
      }
      const items = state.items.map((item) =>
        item.relativeInputPath === relativePath ? prepared! : item
      )
      const manifest = {
        ...state.manifest,
        updatedAt: now,
        items: state.manifest.items.map((item) =>
          item.relativeInputPath === relativePath
            ? {
                ...item,
                status: 'running' as const,
                attempts: [...item.attempts, { startedAt: now }]
              }
            : item
        )
      }
      await this.fsSvc.writeBatchManifest({ sourceRoot: state.sourceRoot, manifest })
      return { ...state, items, manifest, updatedAt: now }
    })
    return prepared
  }

  private async abortPreparedSubmission(batchId: string, relativePath: string): Promise<void> {
    await this.mutateBatch(batchId, async (state) => {
      const now = new Date().toISOString()
      const items = state.items.map((item): ComfyBatchItemSummary =>
        item.relativeInputPath === relativePath
          ? {
              relativeInputPath: item.relativeInputPath,
              status: 'pending',
              attempts: Math.max(0, item.attempts - 1)
            }
          : item
      )
      const manifest = {
        ...state.manifest,
        updatedAt: now,
        items: state.manifest.items.map((item) =>
          item.relativeInputPath === relativePath
            ? { ...item, status: 'pending' as const, attempts: item.attempts.slice(0, -1) }
            : item
        )
      }
      await this.fsSvc.writeBatchManifest({ sourceRoot: state.sourceRoot, manifest })
      return { ...state, items, manifest, updatedAt: now }
    })
  }

  private async bindPrompt(batchId: string, relativePath: string, promptId: string): Promise<void> {
    await this.patchItem(batchId, relativePath, {
      status: 'running',
      promptId,
      submissionState: 'submitted',
      requiresManualIntervention: false,
      error: undefined
    })
  }

  private async continueKnownPrompt(
    batchId: string,
    relativePath: string,
    existingCli?: ComfyHttpCli
  ): Promise<ExecuteOutcome> {
    const state = this.requireBatch(batchId)
    const item = this.requireItem(batchId, relativePath)
    if (!item.promptId || !item.instanceId) {
      await this.markAmbiguousSubmission(
        batchId,
        relativePath,
        new Error('Submitted item is missing its original prompt or instance identifier.')
      )
      return 'stopped'
    }
    let cli: ComfyHttpCli
    try {
      cli = existingCli ?? this.clientForItem(item)
    } catch (error) {
      await this.pauseKnownPrompt(batchId, relativePath, error)
      return 'stopped'
    }
    try {
      const history = await this.waitHistory(cli, item.promptId, batchId)
      let output: FileItem
      try {
        output = this.strictOutput(
          history,
          item.promptId,
          state.binding.outputNodeId,
          state.binding.outputIndex ?? 0
        )
      } catch (error) {
        throw new DefinitivePromptFailure(message(error))
      }
      const bytes = await cli.view(output)
      const committed = await this.commitSuccessfulItem(batchId, relativePath, bytes)
      return committed ? 'completed' : 'stopped'
    } catch (error) {
      if (error instanceof BatchRunStopped) return 'stopped'
      if (error instanceof DefinitivePromptFailure) {
        await this.failSubmittedItem(batchId, relativePath, item.instanceId, error)
        return 'failed'
      }
      await this.pauseKnownPrompt(batchId, relativePath, error)
      return 'stopped'
    }
  }

  private async waitHistory(
    cli: ComfyHttpCli,
    promptId: string,
    batchId: string
  ): Promise<ComfyHistory> {
    const deadline = Date.now() + 24 * 60 * 60 * 1000
    for (;;) {
      const batchStatus = this.requireBatch(batchId).status
      if (
        batchStatus === 'cancelling' ||
        batchStatus === 'cancelled' ||
        this.cancellationRequests.has(batchId)
      ) {
        throw new BatchRunStopped()
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for ComfyUI history.')
      const response = await cli.history(promptId)
      const history = response[promptId]
      if (history?.status.completed) {
        if (history.status.status_str !== 'success') {
          throw new DefinitivePromptFailure(
            `ComfyUI execution failed: ${JSON.stringify(history.status.messages)}`
          )
        }
        return history
      }
      await delay(POLL_MS)
    }
  }

  private strictOutput(
    history: ComfyHistory,
    promptId: string,
    nodeId: string,
    index: number
  ): FileItem {
    const outputs = history.outputs[nodeId]
    if (!outputs) throw new Error(`Bound output node ${nodeId} produced no output for ${promptId}.`)
    const files =
      outputs.images ?? outputs.video ?? outputs.videos ?? outputs.gifs ?? outputs.animated ?? []
    const file = files[index]
    if (!file?.filename)
      throw new Error(`Bound output node ${nodeId} output index ${index} is missing.`)
    return file
  }

  private async commitSuccessfulItem(
    batchId: string,
    relativePath: string,
    image: Uint8Array
  ): Promise<boolean> {
    const inFlight = this.commitsInFlight.get(batchId) ?? new Set<string>()
    inFlight.add(relativePath)
    this.commitsInFlight.set(batchId, inFlight)
    let promoted = false
    let completed = false
    try {
      await this.mutateBatch(batchId, async (state) => {
        if (
          state.status === 'cancelling' ||
          state.status === 'cancelled' ||
          this.cancellationRequests.has(batchId)
        ) {
          return state
        }
        const item = state.items.find((candidate) => candidate.relativeInputPath === relativePath)
        const manifestItem = state.manifest.items.find(
          (candidate) => candidate.relativeInputPath === relativePath
        )
        if (!item?.promptId || !manifestItem || item.status !== 'running') return state

        await this.fsSvc.commitBatchPng({
          sourceRoot: state.sourceRoot,
          relativeInputPath: relativePath,
          sourceFingerprint: manifestItem.sourceFingerprint,
          image
        })
        promoted = true
        if (this.cancellationRequests.has(batchId)) {
          await this.cleanupCancelledOutput(state, relativePath)
          promoted = false
          return state
        }

        const now = new Date().toISOString()
        const items = state.items.map((candidate): ComfyBatchItemSummary =>
          candidate.relativeInputPath === relativePath
            ? {
                ...candidate,
                status: 'succeeded',
                submissionState: 'submitted',
                requiresManualIntervention: false,
                error: undefined
              }
            : candidate
        )
        const manifest = {
          ...state.manifest,
          updatedAt: now,
          items: state.manifest.items.map((candidate) =>
            candidate.relativeInputPath === relativePath
              ? this.finishManifestItem(candidate, 'succeeded', now)
              : candidate
          )
        }
        await this.fsSvc.writeBatchManifest({ sourceRoot: state.sourceRoot, manifest })
        if (this.cancellationRequests.has(batchId)) {
          await this.cleanupCancelledOutput(state, relativePath)
          promoted = false
          await this.fsSvc.writeBatchManifest({
            sourceRoot: state.sourceRoot,
            manifest: state.manifest
          })
          return state
        }
        completed = true
        return { ...state, items, manifest, updatedAt: now }
      })

      if (promoted && this.cancellationRequests.has(batchId)) {
        await this.rollbackCancelledCommit(batchId, relativePath)
        promoted = false
        completed = false
      }
      return completed && promoted
    } finally {
      inFlight.delete(relativePath)
      if (!inFlight.size) this.commitsInFlight.delete(batchId)
    }
  }

  private async failUnsubmittedItem(
    batchId: string,
    relativePath: string,
    instanceId: string,
    error: unknown
  ): Promise<void> {
    const state = this.requireBatch(batchId)
    if (state.status !== 'running' || this.cancellationRequests.has(batchId)) return
    await this.appendError(state, relativePath, instanceId, error).catch(() => undefined)
    const detail = message(error)
    await this.fsSvc
      .failBatchItem({
        sourceRoot: state.sourceRoot,
        relativeInputPath: relativePath,
        errorLog: this.formatItemError(state, relativePath, detail)
      })
      .catch(() => undefined)
    const current = this.requireItem(batchId, relativePath)
    await this.finishItem(
      batchId,
      relativePath,
      { status: 'failed', attempts: current.attempts + 1, error: detail },
      'failed',
      detail
    )
  }

  private async failSubmittedItem(
    batchId: string,
    relativePath: string,
    instanceId: string,
    error: unknown
  ): Promise<void> {
    const state = this.requireBatch(batchId)
    const detail = message(error)
    await this.appendError(state, relativePath, instanceId, error).catch(() => undefined)
    await this.fsSvc
      .failBatchItem({
        sourceRoot: state.sourceRoot,
        relativeInputPath: relativePath,
        errorLog: this.formatItemError(state, relativePath, detail)
      })
      .catch(() => undefined)
    await this.finishItem(
      batchId,
      relativePath,
      { status: 'failed', requiresManualIntervention: false, error: detail },
      'failed',
      detail
    )
  }

  private async markAmbiguousSubmission(
    batchId: string,
    relativePath: string,
    error: unknown
  ): Promise<void> {
    const detail = `Prompt submission outcome is unknown; automatic retry is disabled. ${message(error)}`
    const before = this.requireBatch(batchId)
    await this.appendError(
      before,
      relativePath,
      this.requireItem(batchId, relativePath).instanceId ?? 'unknown',
      error
    ).catch(() => undefined)
    await this.mutateBatch(batchId, async (state) => {
      const now = new Date().toISOString()
      const items = state.items.map((item): ComfyBatchItemSummary =>
        item.relativeInputPath === relativePath
          ? {
              ...item,
              status: 'failed',
              submissionState: 'unknown',
              requiresManualIntervention: true,
              error: detail
            }
          : item
      )
      const manifest = {
        ...state.manifest,
        updatedAt: now,
        items: state.manifest.items.map((item) =>
          item.relativeInputPath === relativePath
            ? this.finishManifestItem(item, 'failed', now, detail)
            : item
        )
      }
      await this.fsSvc.writeBatchManifest({ sourceRoot: state.sourceRoot, manifest })
      const status =
        state.status === 'running' || state.status === 'queued' ? ('paused' as const) : state.status
      if (status !== state.status) this.assertTransition(state.status, status)
      return { ...state, status, items, manifest, updatedAt: now }
    })
  }

  private async pauseKnownPrompt(
    batchId: string,
    relativePath: string,
    error: unknown
  ): Promise<void> {
    const stateBefore = this.requireBatch(batchId)
    if (stateBefore.status === 'cancelling' || stateBefore.status === 'cancelled') return
    const itemBefore = this.requireItem(batchId, relativePath)
    await this.appendError(
      stateBefore,
      relativePath,
      itemBefore.instanceId ?? 'unknown',
      error
    ).catch(() => undefined)
    const detail = message(error)
    await this.mutateBatch(batchId, async (state) => {
      if (state.status === 'cancelling' || state.status === 'cancelled') return state
      const now = new Date().toISOString()
      const items = state.items.map((item): ComfyBatchItemSummary =>
        item.relativeInputPath === relativePath
          ? {
              ...item,
              status: 'running',
              submissionState: 'submitted',
              requiresManualIntervention: true,
              error: detail
            }
          : item
      )
      const status = state.status === 'paused' ? state.status : ('paused' as const)
      if (status !== state.status) this.assertTransition(state.status, status)
      return { ...state, status, items, updatedAt: now }
    })
  }

  private async patchItem(
    batchId: string,
    relativePath: string,
    patch: Partial<ComfyBatchItemSummary>
  ): Promise<void> {
    await this.mutateBatch(batchId, (state) => {
      const now = new Date().toISOString()
      const items = state.items.map((item) =>
        item.relativeInputPath === relativePath ? { ...item, ...patch } : item
      )
      return { ...state, items, updatedAt: now }
    })
  }

  private async finishItem(
    batchId: string,
    relativePath: string,
    patch: Partial<ComfyBatchItemSummary>,
    manifestStatus: BatchManifestItem['status'],
    error?: string
  ): Promise<void> {
    await this.mutateBatch(batchId, async (state) => {
      const now = new Date().toISOString()
      const items = state.items.map((item) =>
        item.relativeInputPath === relativePath ? { ...item, ...patch } : item
      )
      const manifest = {
        ...state.manifest,
        updatedAt: now,
        items: state.manifest.items.map((item) =>
          item.relativeInputPath === relativePath
            ? this.finishManifestItem(item, manifestStatus, now, error)
            : item
        )
      }
      await this.fsSvc.writeBatchManifest({ sourceRoot: state.sourceRoot, manifest })
      return { ...state, items, manifest, updatedAt: now }
    })
  }

  private finishManifestItem(
    item: BatchManifestItem,
    status: BatchManifestItem['status'],
    now: string,
    error?: string
  ): BatchManifestItem {
    const attempts = item.attempts.length
      ? item.attempts.map((attempt, index) =>
          index === item.attempts.length - 1
            ? { ...attempt, finishedAt: now, ...(error ? { error } : {}) }
            : attempt
        )
      : [{ startedAt: now, finishedAt: now, ...(error ? { error } : {}) }]
    return { ...item, status, attempts }
  }

  private async rollbackCancelledCommit(batchId: string, relativeInputPath: string): Promise<void> {
    await this.cleanupCancelledOutput(this.requireBatch(batchId), relativeInputPath)
    await this.mutateBatch(batchId, async (state) => {
      const current = state.items.find((item) => item.relativeInputPath === relativeInputPath)
      if (!current) throw new Error('Cancelled commit item disappeared from batch state.')
      const now = new Date().toISOString()
      const items = state.items.map((item): ComfyBatchItemSummary =>
        item.relativeInputPath === relativeInputPath
          ? { ...item, status: 'running', error: undefined }
          : item
      )
      const manifest = {
        ...state.manifest,
        updatedAt: now,
        items: state.manifest.items.map((item): BatchManifestItem => {
          if (item.relativeInputPath !== relativeInputPath) return item
          const attempts = item.attempts.map((attempt, index) =>
            index === item.attempts.length - 1 ? { startedAt: attempt.startedAt } : attempt
          )
          return { ...item, status: 'running', attempts }
        })
      }
      // Always rewrite the running checkpoint. The succeeded manifest may already be on disk
      // even when its following restoration failed before the in-memory state changed.
      await this.fsSvc.writeBatchManifest({ sourceRoot: state.sourceRoot, manifest })
      return { ...state, items, manifest, updatedAt: now }
    })
  }

  private async cleanupCancelledOutput(
    state: ComfyBatchState,
    relativeInputPath: string
  ): Promise<void> {
    await this.fsSvc.failBatchItem({
      sourceRoot: state.sourceRoot,
      relativeInputPath,
      errorLog: this.formatItemError(
        state,
        relativeInputPath,
        'Batch cancelled during output commit.'
      )
    })
  }

  private async cancelKnownPrompts(
    state: ComfyBatchState,
    options: { allowAmbiguous?: boolean } = {}
  ): Promise<void> {
    const ambiguous = state.items.find(
      (item) =>
        !item.promptId &&
        (item.submissionState === 'prepared' || item.submissionState === 'unknown')
    )
    if (ambiguous && !options.allowAmbiguous) {
      throw new Error(
        `Cannot confirm cancellation for ${ambiguous.relativeInputPath}: prompt submission outcome is unknown.`
      )
    }

    const promptIdsByRoute = new Map<
      string,
      {
        instanceId: string
        origin: string
        kind: ComfyInstanceProfile['state']['kind']
        promptIds: Set<string>
      }
    >()
    for (const item of state.items) {
      if (!item.instanceId || !item.promptId || item.status !== 'running') continue
      if (!item.instanceOrigin || !item.instanceKind) {
        throw new Error(
          `Cannot cancel ${item.relativeInputPath}: its immutable ComfyUI endpoint was not persisted.`
        )
      }
      const key = `${item.instanceKind}\0${item.instanceOrigin}`
      const route = promptIdsByRoute.get(key) ?? {
        instanceId: item.instanceId,
        origin: item.instanceOrigin,
        kind: item.instanceKind,
        promptIds: new Set<string>()
      }
      route.promptIds.add(item.promptId)
      promptIdsByRoute.set(key, route)
    }

    await Promise.all(
      [...promptIdsByRoute.values()].map(async ({ instanceId, origin, kind, promptIds }) => {
        const cli = this.clientForRoute(origin, kind)
        await Promise.all([...promptIds].map((promptId) => cli.cancel(promptId)))

        const interruptedPromptIds = new Set<string>()
        const deadline = Date.now() + CANCEL_CONFIRM_TIMEOUT_MS
        for (;;) {
          const queue = await cli.getQueue()
          const runningPromptId = queue.queue_running.find((entry) => promptIds.has(entry[1]))?.[1]
          if (runningPromptId && !interruptedPromptIds.has(runningPromptId)) {
            // /interrupt is global to the instance, so use it only while the batch's own
            // prompt is confirmed as the currently running work.
            await cli.interrupt()
            interruptedPromptIds.add(runningPromptId)
          }
          const remaining = [...queue.queue_running, ...queue.queue_pending].some((entry) =>
            promptIds.has(entry[1])
          )
          if (!remaining) return
          if (Date.now() >= deadline) {
            throw new Error(`Timed out confirming cancellation on ComfyUI instance ${instanceId}.`)
          }
          await delay(POLL_MS)
        }
      })
    )
  }

  private isDefinitiveValidationRejection(error: unknown): boolean {
    return isComfyPostError(error) && (error.status === 400 || error.status === 422)
  }

  private async setStatus(
    batchId: string,
    status: ComfyBatchState['status']
  ): Promise<ComfyBatchState> {
    return this.mutateBatch(batchId, (state) => {
      if (state.status === status) return state
      if (
        this.cancellationRequests.has(batchId) &&
        status !== 'cancelling' &&
        status !== 'cancelled'
      ) {
        return state
      }
      this.assertTransition(state.status, status)
      return { ...state, status, updatedAt: new Date().toISOString() }
    })
  }

  private assertTransition(from: ComfyBatchStatus, to: ComfyBatchStatus): void {
    if (!TRANSITIONS[from].has(to)) {
      throw new Error(`Invalid Comfy batch state transition: ${from} -> ${to}.`)
    }
  }

  private async mutateBatch(
    batchId: string,
    mutate: (state: ComfyBatchState) => Promise<ComfyBatchState> | ComfyBatchState
  ): Promise<ComfyBatchState> {
    const previous = this.mutationTails.get(batchId) ?? Promise.resolve()
    let resolveQueue!: () => void
    const current = new Promise<void>((resolve) => {
      resolveQueue = resolve
    })
    const tail = previous.then(() => current)
    this.mutationTails.set(batchId, tail)
    await previous
    try {
      const updated = await mutate(this.requireBatch(batchId))
      await this.persist(updated)
      return updated
    } finally {
      resolveQueue()
      if (this.mutationTails.get(batchId) === tail) this.mutationTails.delete(batchId)
    }
  }

  private async serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.lifecycleTail = previous.then(() => gate)
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private requireBatch(batchId: string): ComfyBatchState {
    const state = this.batches.get(batchId)
    if (!state) throw new Error('Comfy batch not found.')
    return state
  }

  private requireItem(batchId: string, relativePath: string): ComfyBatchItemSummary {
    const item = this.requireBatch(batchId).items.find(
      (candidate) => candidate.relativeInputPath === relativePath
    )
    if (!item) throw new Error('Comfy batch item not found.')
    return item
  }

  private assertSourceAvailable(sourceRoot: string, batchId?: string): void {
    const owner = this.activeSourceRoots.get(sourceKey(sourceRoot))
    if (!owner || owner === batchId) return
    throw new Error(`Source folder already has an active Comfy batch (${owner}).`)
  }

  private acquireSource(state: Pick<ComfyBatchState, 'batchId' | 'sourceRoot'>): void {
    this.assertSourceAvailable(state.sourceRoot, state.batchId)
    this.activeSourceRoots.set(sourceKey(state.sourceRoot), state.batchId)
  }

  private releaseSource(state: Pick<ComfyBatchState, 'batchId' | 'sourceRoot'>): void {
    const key = sourceKey(state.sourceRoot)
    if (this.activeSourceRoots.get(key) === state.batchId) this.activeSourceRoots.delete(key)
  }

  private isSourceOwnedBy(state: Pick<ComfyBatchState, 'batchId' | 'sourceRoot'>): boolean {
    return this.activeSourceRoots.get(sourceKey(state.sourceRoot)) === state.batchId
  }

  private async persist(state: ComfyBatchState): Promise<void> {
    // Keep the attempted state in memory before SQLite commit. If COMMIT reports an
    // indeterminate failure, callers must conservatively observe the prepared token and
    // stop rather than fail over and submit the same item elsewhere.
    this.batches.set(state.batchId, state)
    this.stateStore.save(state)
  }

  private async recover(): Promise<void> {
    const persistedById = new Map<string, ComfyBatchState>()
    for (const state of this.stateStore.loadAll()) {
      if (!state?.batchId || typeof state.batchId !== 'string') {
        throw new Error('Persisted Comfy batch state is missing a valid batchId.')
      }
      if (persistedById.has(state.batchId)) {
        throw new Error(`Duplicate persisted Comfy batch id: ${state.batchId}.`)
      }
      persistedById.set(state.batchId, state)
    }

    const legacyDirectory = legacyStateRoot()
    let legacyFiles: string[] = []
    try {
      legacyFiles = await fs.readdir(legacyDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Failed to enumerate legacy Comfy batch state at ${legacyDirectory}.`, {
          cause: error
        })
      }
    }
    for (const file of legacyFiles.filter((value) => value.endsWith('.json')).sort()) {
      const filePath = path.join(legacyDirectory, file)
      let state: ComfyBatchState
      try {
        state = JSON.parse(await fs.readFile(filePath, 'utf8')) as ComfyBatchState
      } catch (error) {
        throw new Error(`Failed to read legacy Comfy batch state from ${filePath}.`, {
          cause: error
        })
      }
      if (!state?.batchId || typeof state.batchId !== 'string') {
        throw new Error(`Legacy Comfy batch state has no valid batchId: ${filePath}.`)
      }
      if (!persistedById.has(state.batchId)) persistedById.set(state.batchId, state)
    }

    for (const state of [...persistedById.values()].sort((left, right) =>
      left.batchId.localeCompare(right.batchId)
    )) {
      try {
        await this.recoverState(state)
      } catch (error) {
        throw new Error(`Failed to recover persisted Comfy batch ${state.batchId}.`, {
          cause: error
        })
      }
    }

    for (const state of this.batches.values()) {
      if (state.status !== 'cancelling') continue
      setTimeout(() => {
        void this.cancelBatch({ batchId: state.batchId }).catch((error) => {
          console.error(`[ComfyBatch] Failed to resume cancellation for ${state.batchId}:`, error)
        })
      }, 0)
    }
  }

  private async recoverState(state: ComfyBatchState): Promise<void> {
    const normalizedSourceRoot = path.resolve(state.sourceRoot)
    const outputRoot = `${normalizedSourceRoot}.output`
    const metadataRoot = path.join(outputRoot, '.magicpot-batch')
    const interrupted = ['queued', 'running'].includes(state.status)
    const canRecoverItems = !TERMINAL_BATCH_STATUSES.has(state.status)
    const now = new Date().toISOString()
    const items = state.items.map((item): ComfyBatchItemSummary => {
      if (!canRecoverItems) return item
      if (item.promptId) {
        return {
          ...item,
          status: 'running',
          submissionState: 'submitted',
          requiresManualIntervention: true
        }
      }
      const hasSubmissionMarker = Boolean(
        item.instanceId || item.submissionToken || item.submissionState
      )
      if ((item.status === 'running' || hasSubmissionMarker) && hasSubmissionMarker) {
        return {
          ...item,
          status: 'failed',
          submissionState: 'unknown',
          requiresManualIntervention: true,
          error:
            item.error ??
            'Recovered without a prompt id after submission intent; automatic retry is disabled.'
        }
      }
      if (item.status === 'running') {
        return {
          relativeInputPath: item.relativeInputPath,
          status: 'pending',
          attempts: item.attempts
        }
      }
      return item
    })
    const itemByPath = new Map(items.map((item) => [item.relativeInputPath, item]))
    const manifest = {
      ...state.manifest,
      sourceRoot: normalizedSourceRoot,
      updatedAt: interrupted ? now : state.manifest.updatedAt,
      items: state.manifest.items.map((manifestItem) => {
        const recoveredItem = itemByPath.get(manifestItem.relativeInputPath)
        if (!recoveredItem || recoveredItem.status === manifestItem.status) return manifestItem
        if (recoveredItem.status === 'failed') {
          return this.finishManifestItem(manifestItem, 'failed', now, recoveredItem.error)
        }
        return { ...manifestItem, status: recoveredItem.status }
      })
    }
    const normalizedState: ComfyBatchState = {
      ...state,
      sourceRoot: normalizedSourceRoot,
      status: interrupted ? 'paused' : state.status,
      workspace: {
        sourceRoot: normalizedSourceRoot,
        workRoot: outputRoot,
        outputRoot,
        metadataRoot,
        stagingRoot: path.join(metadataRoot, 'staging'),
        manifestPath: path.join(metadataRoot, 'manifest.json')
      },
      manifest,
      items,
      errorLogPath: path.join(metadataRoot, 'errors.log'),
      updatedAt: interrupted ? now : state.updatedAt
    }
    const changed =
      interrupted ||
      state.sourceRoot !== normalizedSourceRoot ||
      state.workspace?.metadataRoot !== metadataRoot ||
      JSON.stringify(items) !== JSON.stringify(state.items)
    if (changed) {
      await this.fsSvc.writeBatchManifest({
        sourceRoot: normalizedState.sourceRoot,
        manifest
      })
    }
    await this.persist(normalizedState)

    if (!TERMINAL_BATCH_STATUSES.has(normalizedState.status)) {
      const key = sourceKey(normalizedState.sourceRoot)
      const owner = this.activeSourceRoots.get(key)
      if (owner && owner !== normalizedState.batchId) {
        throw new Error(
          `Multiple active Comfy batches claim the same source folder: ${owner}, ${normalizedState.batchId}.`
        )
      }
      this.activeSourceRoots.set(key, normalizedState.batchId)
    }
  }

  private formatItemError(state: ComfyBatchState, relativePath: string, error: string): string {
    return [
      `时间：${new Date().toISOString()}`,
      `文件：${relativePath}`,
      `批次：${state.batchId}`,
      '错误类型：ComfyUI 批处理失败',
      `错误：${error}`,
      '最终结果：失败，output 对应结果已清理，诊断信息保存在 .output/.magicpot-batch/errors',
      ''
    ].join('\n')
  }

  private async appendError(
    state: ComfyBatchState,
    relativePath: string,
    instanceId: string,
    error: unknown
  ): Promise<void> {
    await this.fsSvc.appendBatchAggregateError({
      sourceRoot: state.sourceRoot,
      entry: `[${new Date().toISOString()}] ${relativePath} @ ${instanceId}\n${message(error)}\n\n`
    })
  }
}
