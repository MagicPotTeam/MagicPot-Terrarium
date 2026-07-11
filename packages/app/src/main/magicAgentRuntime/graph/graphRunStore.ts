import path from 'node:path'
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
  }

  async get(runId: string, route: AgentRouteLike): Promise<MagicAgentGraphRunRecord | undefined> {
    const normalizedRunId = assertSafeMagicAgentGraphRunId(runId)
    const sessionKey = getAgentSessionKey(normalizeAgentRoute(route))
    if (!sessionKey) return undefined
    const run = await this.readRunFile(this.runFilePath(sessionKey, normalizedRunId)).catch(
      () => undefined
    )
    if (!run || run.sessionKey !== sessionKey) return undefined
    return clone(run)
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
    const runs = records
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
