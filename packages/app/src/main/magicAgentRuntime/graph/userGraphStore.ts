import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import type {
  MagicAgentGraphCreateRequest,
  MagicAgentGraphDefinition,
  MagicAgentGraphListItem
} from '@shared/magicAgent'
import { validateMagicAgentGraphDefinition } from './graphDefinition'
import {
  assertSafeMagicAgentGraphId,
  createMagicAgentGraphStorageSegment,
  isSafeMagicAgentGraphId
} from './graphIds'
import {
  assertPathWithinRoot,
  pathExists,
  readDirSafe,
  readJsonFile,
  writeJsonFileAtomic
} from './jsonPersistence'

export type MagicAgentUserGraphRecord = {
  graph: MagicAgentGraphDefinition
  route: AgentRouteLike
  sessionKey: string
  createdAt: number
  updatedAt: number
}

export type MagicAgentUserGraphStoreListOptions = {
  route?: AgentRouteLike
  includeAllRoutes?: boolean
}

const USER_GRAPH_FILE = 'graph.json'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const now = (): number => Date.now()

const cleanString = (value: unknown): string => String(value || '').trim()

const normalizeRoute = (route: AgentRouteLike): AgentRouteLike => normalizeAgentRoute(route)

const toListItem = (record: MagicAgentUserGraphRecord): MagicAgentGraphListItem => ({
  graphId: record.graph.graphId,
  name: record.graph.name,
  description: record.graph.description,
  version: record.graph.version,
  tags: [...record.graph.tags],
  nodeCount: record.graph.nodes.length,
  channelCount: record.graph.channels.length,
  outputCount: record.graph.outputs.length,
  builtIn: false
})

export class MagicAgentUserGraphStore {
  private readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir)
  }

  async save(request: MagicAgentGraphCreateRequest): Promise<MagicAgentGraphDefinition> {
    const route = normalizeRoute(request.route)
    const sessionKey = getAgentSessionKey(route)
    if (!sessionKey) {
      throw new Error('MagicAgentGraph user store requires a route session key.')
    }

    const validation = validateMagicAgentGraphDefinition(request.graph)
    if (!validation.ok) {
      throw new Error(validation.errors.map((issue) => issue.message).join('; '))
    }
    const graph = validation.graph
    assertSafeMagicAgentGraphId(graph.graphId)

    const filePath = this.graphFilePath(sessionKey, graph.graphId)
    const exists = await pathExists(filePath)
    if (exists && !request.replace) {
      throw new Error(`MagicAgentGraph "${graph.graphId}" already exists for this route.`)
    }

    const existing = exists ? await this.readRecordFile(filePath).catch(() => undefined) : undefined
    const timestamp = now()
    const record: MagicAgentUserGraphRecord = {
      graph,
      route,
      sessionKey,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp
    }
    await writeJsonFileAtomic(filePath, record)
    return clone(graph)
  }

  async get(
    graphId: string,
    route?: AgentRouteLike
  ): Promise<MagicAgentGraphDefinition | undefined> {
    const normalizedGraphId = assertSafeMagicAgentGraphId(graphId)
    if (route) {
      const sessionKey = getAgentSessionKey(normalizeRoute(route))
      if (!sessionKey) return undefined
      const record = await this.readRecordFile(
        this.graphFilePath(sessionKey, normalizedGraphId)
      ).catch(() => undefined)
      return record ? clone(record.graph) : undefined
    }

    const record = await this.findFirstRecordByGraphId(normalizedGraphId)
    return record ? clone(record.graph) : undefined
  }

  async delete(graphId: string, route: AgentRouteLike): Promise<boolean> {
    const normalizedGraphId = assertSafeMagicAgentGraphId(graphId)
    const sessionKey = getAgentSessionKey(normalizeRoute(route))
    if (!sessionKey) return false
    const filePath = this.graphFilePath(sessionKey, normalizedGraphId)
    if (!(await pathExists(filePath))) {
      return false
    }
    await import('node:fs/promises')
      .then((fs) => fs.rm(path.dirname(filePath), { recursive: true, force: true }))
      .catch(() => undefined)
    return true
  }

  async list(
    options: MagicAgentUserGraphStoreListOptions = {}
  ): Promise<MagicAgentGraphListItem[]> {
    const records = await this.listRecords(options)
    return records.map(toListItem).sort((left, right) => left.graphId.localeCompare(right.graphId))
  }

  async listRecords(
    options: MagicAgentUserGraphStoreListOptions = {}
  ): Promise<MagicAgentUserGraphRecord[]> {
    if (options.route && !options.includeAllRoutes) {
      const sessionKey = getAgentSessionKey(normalizeRoute(options.route))
      if (!sessionKey) return []
      return this.readSessionRecords(sessionKey)
    }

    if (!(await pathExists(this.rootDir))) {
      return []
    }

    const sessionEntries = await this.safeReadDir(this.rootDir)
    const records: MagicAgentUserGraphRecord[] = []
    for (const entry of sessionEntries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
      records.push(...(await this.readSessionRecordsBySegment(entry.name)))
    }
    return records.sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.graph.graphId.localeCompare(right.graph.graphId)
    )
  }

  forkGraph(
    graph: MagicAgentGraphDefinition,
    route: AgentRouteLike,
    options: { graphId?: string; name?: string; replace?: boolean } = {}
  ): Promise<MagicAgentGraphDefinition> {
    const requestedGraphId = cleanString(options.graphId)
    const graphId = requestedGraphId || `user.${randomUUID()}`
    const forked: MagicAgentGraphDefinition = {
      ...clone(graph),
      graphId,
      name: cleanString(options.name) || `${graph.name} (Fork)`,
      tags: [...new Set([...(graph.tags || []), 'fork'])],
      metadata: {
        ...(graph.metadata || {}),
        forkedFromGraphId: graph.graphId,
        forkedAt: now()
      }
    }
    return this.save({ graph: forked, route, ...(options.replace ? { replace: true } : {}) })
  }

  getRootDir(): string {
    return this.rootDir
  }

  private async findFirstRecordByGraphId(
    graphId: string
  ): Promise<MagicAgentUserGraphRecord | undefined> {
    const records = await this.listRecords({ includeAllRoutes: true })
    return records.find((record) => record.graph.graphId === graphId)
  }

  private async readSessionRecords(sessionKey: string): Promise<MagicAgentUserGraphRecord[]> {
    return this.readSessionRecordsBySegment(
      createMagicAgentGraphStorageSegment('session', sessionKey)
    )
  }

  private async readSessionRecordsBySegment(
    sessionSegment: string
  ): Promise<MagicAgentUserGraphRecord[]> {
    const sessionDir = path.join(this.rootDir, sessionSegment)
    assertPathWithinRoot(this.rootDir, sessionDir)
    if (!(await pathExists(sessionDir))) {
      return []
    }

    const graphEntries = await this.safeReadDir(sessionDir)
    const records: MagicAgentUserGraphRecord[] = []
    for (const entry of graphEntries) {
      if (!entry.isDirectory() || !entry.name.startsWith('graph-')) continue
      const filePath = path.join(sessionDir, entry.name, USER_GRAPH_FILE)
      const record = await this.readRecordFile(filePath).catch(() => undefined)
      if (record) records.push(record)
    }
    return records
  }

  private async readRecordFile(filePath: string): Promise<MagicAgentUserGraphRecord> {
    assertPathWithinRoot(this.rootDir, filePath)
    const parsed = await readJsonFile<MagicAgentUserGraphRecord>(filePath)
    const validation = validateMagicAgentGraphDefinition(parsed.graph)
    if (!validation.ok) {
      throw new Error(validation.errors.map((issue) => issue.message).join('; '))
    }
    const route = normalizeRoute(parsed.route)
    const sessionKey = cleanString(parsed.sessionKey) || getAgentSessionKey(route)
    return {
      graph: validation.graph,
      route,
      sessionKey,
      createdAt: Number.isFinite(parsed.createdAt) ? Number(parsed.createdAt) : now(),
      updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : now()
    }
  }

  private graphFilePath(sessionKey: string, graphId: string): string {
    if (!isSafeMagicAgentGraphId(graphId)) {
      assertSafeMagicAgentGraphId(graphId)
    }
    const sessionSegment = createMagicAgentGraphStorageSegment('session', sessionKey)
    const graphSegment = createMagicAgentGraphStorageSegment('graph', graphId)
    const filePath = path.join(this.rootDir, sessionSegment, graphSegment, USER_GRAPH_FILE)
    assertPathWithinRoot(this.rootDir, filePath)
    return filePath
  }

  private async safeReadDir(dir: string): Promise<import('node:fs').Dirent[]> {
    assertPathWithinRoot(this.rootDir, dir)
    return readDirSafe(dir)
  }
}
