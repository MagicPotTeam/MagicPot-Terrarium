import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import type {
  SemanticMemoryChunk,
  SemanticMemoryRebuildJob,
  SemanticMemoryScope,
  SemanticMemoryVisibility
} from '@shared/magicAgentPlatform2/memory'

type MemoryRow = { payload: string }
type VectorRow = { provider_id: string; model: string; dimension: number; vector_json: string }

export class SqliteSemanticMemoryStore {
  private readonly db: DatabaseSync
  readonly ftsAvailable: boolean

  constructor(filePath: string) {
    const resolved = filePath === ':memory:' ? filePath : path.resolve(filePath)
    if (resolved !== ':memory:') fs.mkdirSync(path.dirname(resolved), { recursive: true })
    this.db = new DatabaseSync(resolved)
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;'
    )
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, content TEXT NOT NULL, visibility TEXT NOT NULL, disabled INTEGER NOT NULL, expires_at INTEGER, updated_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope_kind, scope_id);
      CREATE TABLE IF NOT EXISTS scopes (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS vectors (memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, provider_id TEXT NOT NULL, model TEXT NOT NULL, dimension INTEGER NOT NULL, vector_json TEXT NOT NULL, PRIMARY KEY(memory_id,provider_id));
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_session_memory_links (agent_id TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(agent_id,session_id));
    `)
    let fts = false
    try {
      this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, content, tokenize='unicode61')"
      )
      fts = true
    } catch {
      fts = false
    }
    this.ftsAvailable = fts
  }

  close(): void {
    this.db.close()
  }

  upsert(memory: SemanticMemoryChunk): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          'INSERT INTO scopes(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload'
        )
        .run(memory.scope.kind, memory.scope.id, JSON.stringify(memory.scope))
      this.db
        .prepare(
          `INSERT INTO memories(id,scope_kind,scope_id,content,visibility,disabled,expires_at,updated_at,payload) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope_kind=excluded.scope_kind,scope_id=excluded.scope_id,content=excluded.content,visibility=excluded.visibility,disabled=excluded.disabled,expires_at=excluded.expires_at,updated_at=excluded.updated_at,payload=excluded.payload`
        )
        .run(
          memory.id,
          memory.scope.kind,
          memory.scope.id,
          memory.content,
          memory.visibility,
          memory.disabled ? 1 : 0,
          memory.expiresAt ?? null,
          memory.updatedAt,
          JSON.stringify(memory)
        )
      if (this.ftsAvailable) {
        this.db.prepare('DELETE FROM memories_fts WHERE memory_id=?').run(memory.id)
        this.db
          .prepare('INSERT INTO memories_fts(memory_id,content) VALUES(?,?)')
          .run(memory.id, memory.content)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  get(id: string): SemanticMemoryChunk | undefined {
    const row = this.db.prepare('SELECT payload FROM memories WHERE id=?').get(id) as
      | MemoryRow
      | undefined
    return row ? JSON.parse(row.payload) : undefined
  }

  listCandidates(
    scopes: SemanticMemoryScope[],
    visibility: SemanticMemoryVisibility[] | undefined,
    now: number
  ): SemanticMemoryChunk[] {
    const rows = this.db
      .prepare(
        'SELECT payload FROM memories WHERE disabled=0 AND (expires_at IS NULL OR expires_at>?) ORDER BY id'
      )
      .all(now) as unknown as MemoryRow[]
    return rows
      .map((row) => JSON.parse(row.payload) as SemanticMemoryChunk)
      .filter((memory) => visibility?.includes(memory.visibility) ?? true)
      .filter((memory) =>
        scopes.some(
          (scope) =>
            (scope.kind === memory.scope.kind && scope.id === memory.scope.id) ||
            (scope.kind === 'session-set' &&
              memory.scope.kind === 'session' &&
              scope.sessionIds?.includes(memory.provenance.sessionId ?? ''))
        )
      )
  }

  lexicalIds(query: string, candidates: SemanticMemoryChunk[], limit: number): Map<string, number> {
    const tokens = tokenize(query)
    if (!tokens.length) return new Map()
    if (this.ftsAvailable) {
      try {
        const candidateIds = new Set(candidates.map((item) => item.id))
        const rows = this.db
          .prepare(
            'SELECT memory_id, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?'
          )
          .all(tokens.map(quoteFts).join(' OR '), Math.max(limit * 8, 64)) as unknown as Array<{
          memory_id: string
          rank: number
        }>
        return new Map(
          rows
            .filter((row) => candidateIds.has(row.memory_id))
            .map((row) => [row.memory_id, 1 / (1 + Math.max(0, row.rank))])
        )
      } catch {
        /* deterministic fallback below */
      }
    }
    return new Map(
      candidates
        .map(
          (memory) =>
            [
              memory.id,
              lexicalScore(tokens, tokenize(`${memory.summary ?? ''} ${memory.content}`))
            ] as const
        )
        .filter((entry) => entry[1] > 0)
    )
  }

  putVector(
    memoryId: string,
    providerId: string,
    model: string,
    dimension: number,
    vector: number[]
  ): void {
    this.db
      .prepare(
        'INSERT INTO vectors(memory_id,provider_id,model,dimension,vector_json) VALUES(?,?,?,?,?) ON CONFLICT(memory_id,provider_id) DO UPDATE SET model=excluded.model,dimension=excluded.dimension,vector_json=excluded.vector_json'
      )
      .run(memoryId, providerId, model, dimension, JSON.stringify(vector))
  }
  getVector(
    memoryId: string,
    providerId: string
  ): { providerId: string; model: string; dimension: number; vector: number[] } | undefined {
    const row = this.db
      .prepare(
        'SELECT provider_id,model,dimension,vector_json FROM vectors WHERE memory_id=? AND provider_id=?'
      )
      .get(memoryId, providerId) as VectorRow | undefined
    return row
      ? {
          providerId: row.provider_id,
          model: row.model,
          dimension: row.dimension,
          vector: JSON.parse(row.vector_json)
        }
      : undefined
  }
  delete(id: string): number {
    if (this.ftsAvailable) this.db.prepare('DELETE FROM memories_fts WHERE memory_id=?').run(id)
    return Number(this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes)
  }
  setDisabled(id: string, disabled: boolean): number {
    const memory = this.get(id)
    if (!memory) return 0
    memory.disabled = disabled
    memory.updatedAt = Date.now()
    this.upsert(memory)
    return 1
  }
  setVisibility(id: string, visibility: SemanticMemoryVisibility): number {
    const memory = this.get(id)
    if (!memory) return 0
    memory.visibility = visibility
    memory.updatedAt = Date.now()
    this.upsert(memory)
    return 1
  }
  clearScope(scope: SemanticMemoryScope): number {
    const memories = this.listAll().filter(
      (m) => m.scope.kind === scope.kind && m.scope.id === scope.id
    )
    for (const memory of memories) this.delete(memory.id)
    return memories.length
  }
  listAll(): SemanticMemoryChunk[] {
    return (
      this.db.prepare('SELECT payload FROM memories ORDER BY id').all() as unknown as MemoryRow[]
    ).map((row) => JSON.parse(row.payload))
  }
  linkAgentSession(agentId: string, sessionId: string, createdAt = Date.now()): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO agent_session_memory_links(agent_id,session_id,created_at) VALUES(?,?,?)'
      )
      .run(agentId, sessionId, createdAt)
  }
  unlinkAgentSession(agentId: string, sessionId: string): number {
    return Number(
      this.db
        .prepare('DELETE FROM agent_session_memory_links WHERE agent_id=? AND session_id=?')
        .run(agentId, sessionId).changes
    )
  }
  hasAgentSessionLink(agentId: string, sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM agent_session_memory_links WHERE agent_id=? AND session_id=?')
        .get(agentId, sessionId)
    )
  }
  listAgentSessionLinks(
    agentId: string
  ): Array<{ agentId: string; sessionId: string; createdAt: number }> {
    return (
      this.db
        .prepare(
          'SELECT agent_id,session_id,created_at FROM agent_session_memory_links WHERE agent_id=? ORDER BY session_id'
        )
        .all(agentId) as unknown as Array<{
        agent_id: string
        session_id: string
        created_at: number
      }>
    ).map((row) => ({
      agentId: row.agent_id,
      sessionId: row.session_id,
      createdAt: row.created_at
    }))
  }

  putJob(job: SemanticMemoryRebuildJob): void {
    this.db
      .prepare(
        'INSERT INTO jobs(id,payload,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at'
      )
      .run(job.id, JSON.stringify(job), job.updatedAt)
  }
  getJob(id: string): SemanticMemoryRebuildJob | undefined {
    const row = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id) as
      | MemoryRow
      | undefined
    return row ? JSON.parse(row.payload) : undefined
  }
}

const tokenize = (value: string): string[] =>
  value.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
const quoteFts = (token: string): string => `"${token.replaceAll('"', '""')}"`
const lexicalScore = (query: string[], document: string[]): number => {
  const counts = new Map<string, number>()
  for (const token of document) counts.set(token, (counts.get(token) ?? 0) + 1)
  return (
    query.reduce((sum, token) => sum + (counts.get(token) ?? 0), 0) / Math.max(1, document.length)
  )
}
