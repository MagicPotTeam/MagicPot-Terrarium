import path from 'node:path'
import { publishWorkflowCompletion } from '../../magicAgentPlatform2/triggers/workflowCompletionEvents'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import type { MagicAgentGraphRunRecord } from '@shared/magicAgent'
import {
  assertSafeMagicAgentGraphId,
  assertSafeMagicAgentGraphRunId,
  createMagicAgentGraphStorageSegment
} from './graphIds'
import {
  assertPathWithinRoot,
  pathExists,
  readDirSafe,
  readJsonFile,
  writeJsonFileAtomic
} from './jsonPersistence'

export type MagicAgentGraphRunStoreListOptions = {
  route: AgentRouteLike
  graphId?: string
  limit?: number
}

const GRAPH_RUN_FILE = 'run.json'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const cleanString = (value: unknown): string => String(value || '').trim()

export class MagicAgentGraphRunStore {
  private readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir)
  }

  async save(run: MagicAgentGraphRunRecord): Promise<void> {
    const runId = assertSafeMagicAgentGraphRunId(run.runId)
    const graphId = assertSafeMagicAgentGraphId(run.graphId)
    const route = normalizeAgentRoute(run.route)
    const sessionKey = cleanString(run.sessionKey) || getAgentSessionKey(route)
    if (!sessionKey) {
      throw new Error('MagicAgentGraph run store requires a route session key.')
    }
    const record = { ...clone(run), runId, graphId, route, sessionKey }
    await writeJsonFileAtomic(this.runFilePath(sessionKey, runId), record)
    if (
      record.status === 'completed' ||
      record.status === 'failed' ||
      record.status === 'cancelled'
    ) {
      publishWorkflowCompletion({
        runId: record.runId,
        graphId: record.graphId,
        status: record.status,
        completedAt: record.updatedAt
      })
    }
  }

  async get(runId: string, route: AgentRouteLike): Promise<MagicAgentGraphRunRecord | undefined> {
    const normalizedRunId = assertSafeMagicAgentGraphRunId(runId)
    const sessionKey = getAgentSessionKey(normalizeAgentRoute(route))
    if (!sessionKey) return undefined
    const run = await this.readRunFile(this.runFilePath(sessionKey, normalizedRunId)).catch(
      () => undefined
    )
    if (!run || run.sessionKey !== sessionKey) return undefined
    const reconciled = await this.reconcileInterruptedRun(run)
    return clone(reconciled)
  }

  async list(options: MagicAgentGraphRunStoreListOptions): Promise<MagicAgentGraphRunRecord[]> {
    const route = normalizeAgentRoute(options.route)
    const sessionKey = getAgentSessionKey(route)
    if (!sessionKey) return []
    const graphId = cleanString(options.graphId)
    if (graphId) assertSafeMagicAgentGraphId(graphId)
    const limit =
      Number.isInteger(options.limit) && Number(options.limit) > 0
        ? Number(options.limit)
        : undefined
    const records = await this.readSessionRuns(sessionKey)
    const reconciledRecords = await Promise.all(
      records.map((run) => this.reconcileInterruptedRun(run))
    )
    const runs = reconciledRecords
      .filter((run) => run.sessionKey === sessionKey)
      .filter((run) => !graphId || run.graphId === graphId)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    return (limit === undefined ? runs : runs.slice(0, limit)).map(clone)
  }

  async pruneSession(
    sessionKey: string,
    maxRuns: number,
    activeRunIds: Set<string> = new Set()
  ): Promise<void> {
    const normalizedSessionKey = cleanString(sessionKey)
    if (!normalizedSessionKey || !Number.isFinite(maxRuns) || maxRuns < 1) return
    const runs = await this.readSessionRuns(normalizedSessionKey)
    const staleRuns = runs
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      .slice(maxRuns)
      .filter((run) => !activeRunIds.has(run.runId))
    for (const run of staleRuns) {
      const filePath = this.runFilePath(normalizedSessionKey, run.runId)
      await import('node:fs/promises')
        .then((fs) => fs.rm(path.dirname(filePath), { recursive: true, force: true }))
        .catch(() => undefined)
    }
  }

  getRootDir(): string {
    return this.rootDir
  }

  private async reconcileInterruptedRun(
    run: MagicAgentGraphRunRecord
  ): Promise<MagicAgentGraphRunRecord> {
    if (!['pending', 'running', 'pausing', 'paused'].includes(run.status)) return run
    const interruptedAt = Date.now()
    const message = 'MagicAgentGraph run was interrupted by process restart and cannot be resumed.'
    const pendingInput = run.pendingInput
    const cancelledPendingInput =
      pendingInput && (pendingInput.status === 'awaiting' || pendingInput.status === 'submitted')
        ? {
            ...pendingInput,
            status: 'cancelled' as const,
            revision: pendingInput.revision + 1,
            updatedAt: interruptedAt
          }
        : pendingInput
    const pendingApproval = run.pendingApproval
    const deniedPendingApproval =
      pendingApproval && pendingApproval.status === 'awaiting'
        ? {
            ...pendingApproval,
            status: 'denied' as const,
            revision: pendingApproval.revision + 1,
            updatedAt: interruptedAt
          }
        : pendingApproval
    const nextSequence =
      Math.max(0, ...(run.events || []).map((candidate) => candidate.sequence || 0)) + 1
    const cancellationEvent =
      cancelledPendingInput !== pendingInput
        ? {
            eventId: `graph-event-${interruptedAt}-input-cancelled`,
            runId: run.runId,
            graphId: run.graphId,
            type: 'input.cancelled' as const,
            message: 'Managed input was cancelled during startup reconciliation.',
            createdAt: interruptedAt,
            sequence: nextSequence,
            nodeId: cancelledPendingInput?.nodeId,
            metadata: {
              nodeId: cancelledPendingInput?.nodeId,
              pendingInputId: cancelledPendingInput?.pendingInputId,
              revision: cancelledPendingInput?.revision,
              status: 'cancelled',
              reason: 'startup-interrupted'
            }
          }
        : undefined
    const approvalEvent =
      deniedPendingApproval !== pendingApproval
        ? {
            eventId: `graph-event-${interruptedAt}-approval-denied`,
            runId: run.runId,
            graphId: run.graphId,
            type: 'approval.denied' as const,
            message: 'Tool approval was denied during startup reconciliation.',
            createdAt: interruptedAt,
            sequence: nextSequence + (cancellationEvent ? 1 : 0),
            nodeId: deniedPendingApproval?.nodeId,
            metadata: {
              nodeId: deniedPendingApproval?.nodeId,
              approvalId: deniedPendingApproval?.approvalId,
              revision: deniedPendingApproval?.revision,
              status: 'denied',
              reason: 'startup-interrupted'
            }
          }
        : undefined
    const event = {
      eventId: `graph-event-${interruptedAt}-${Math.random().toString(36).slice(2)}`,
      runId: run.runId,
      graphId: run.graphId,
      type: 'graph.interrupted' as const,
      message,
      createdAt: interruptedAt,
      sequence: nextSequence + (cancellationEvent ? 1 : 0) + (approvalEvent ? 1 : 0),
      metadata: { previousStatus: run.status, interrupted: true }
    }
    const reconciled: MagicAgentGraphRunRecord = {
      ...run,
      status: 'failed',
      updatedAt: interruptedAt,
      endedAt: interruptedAt,
      error: message,
      ...(cancelledPendingInput ? { pendingInput: cancelledPendingInput } : {}),
      ...(deniedPendingApproval ? { pendingApproval: deniedPendingApproval } : {}),
      events: [
        ...(run.events || []),
        ...(cancellationEvent ? [cancellationEvent] : []),
        ...(approvalEvent ? [approvalEvent] : []),
        event
      ]
    }
    await this.save(reconciled)
    return reconciled
  }

  private async readSessionRuns(sessionKey: string): Promise<MagicAgentGraphRunRecord[]> {
    const sessionDir = this.sessionDir(sessionKey)
    if (!(await pathExists(sessionDir))) {
      return []
    }
    const entries = await readDirSafe(sessionDir)
    const runs: MagicAgentGraphRunRecord[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue
      const run = await this.readRunFile(path.join(sessionDir, entry.name, GRAPH_RUN_FILE)).catch(
        () => undefined
      )
      if (run) runs.push(run)
    }
    return runs
  }

  private async readRunFile(filePath: string): Promise<MagicAgentGraphRunRecord> {
    assertPathWithinRoot(this.rootDir, filePath)
    const run = await readJsonFile<MagicAgentGraphRunRecord>(filePath)
    assertSafeMagicAgentGraphRunId(run.runId)
    assertSafeMagicAgentGraphId(run.graphId)
    return run
  }

  private sessionDir(sessionKey: string): string {
    const dir = path.join(this.rootDir, createMagicAgentGraphStorageSegment('session', sessionKey))
    assertPathWithinRoot(this.rootDir, dir)
    return dir
  }

  private runFilePath(sessionKey: string, runId: string): string {
    const filePath = path.join(
      this.sessionDir(sessionKey),
      createMagicAgentGraphStorageSegment('run', runId),
      GRAPH_RUN_FILE
    )
    assertPathWithinRoot(this.rootDir, filePath)
    return filePath
  }
}
