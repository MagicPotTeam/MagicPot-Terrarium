import path from 'node:path'
import type {
  MagicAgentGraphRunEvent,
  MagicAgentGraphRunEventType,
  MagicAgentGraphRunPublicEvent
} from '@shared/magicAgent'
import { NodeSQLiteAdapter } from '../../magicAgentPlatform2/persistence/sqliteAdapter'

const MAX_PAYLOAD_BYTES = 8192
const MAX_STRING_CHARS = 2048
const subscribers = new Map<string, Set<(event: MagicAgentGraphRunPublicEvent) => void>>()

const cleanString = (value: unknown): string => String(value || '').trim()

const PUBLIC_METADATA_KEYS = new Set([
  'cancelled',
  'channelCount',
  'channelKind',
  'contentTruncated',
  'from',
  'kind',
  'maxContentChars',
  'maxOutputChars',
  'messageCount',
  'nodeId',
  'outputId',
  'outputTruncated',
  'reason',
  'status',
  'timedOut',
  'timeoutScope',
  'to',
  'toolName'
])

const boundedString = (value: unknown): string | undefined => {
  const normalized = cleanString(value)
  if (!normalized) return undefined
  return normalized.length > MAX_STRING_CHARS
    ? `${normalized.slice(0, MAX_STRING_CHARS)}…`
    : normalized
}

function allowlistedMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (!PUBLIC_METADATA_KEYS.has(key)) continue
    if (typeof value === 'string') {
      const normalized = boundedString(value)
      if (normalized !== undefined) result[key] = normalized
    } else if (typeof value === 'number' || typeof value === 'boolean') result[key] = value
  }
  return result
}

function publicPayload(event: MagicAgentGraphRunEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    graphId: boundedString(event.graphId),
    ...(boundedString(event.nodeId) ? { nodeId: boundedString(event.nodeId) } : {}),
    ...(boundedString(event.channelId) ? { channelId: boundedString(event.channelId) } : {}),
    ...(boundedString(event.outputId) ? { outputId: boundedString(event.outputId) } : {}),
    ...allowlistedMetadata(event.metadata)
  }
  const encoded = JSON.stringify(payload)
  return Buffer.byteLength(encoded, 'utf8') <= MAX_PAYLOAD_BYTES
    ? payload
    : { truncated: true, message: '[TRUNCATED]' }
}

export class MagicAgentGraphRunEventStore {
  private readonly adapter: NodeSQLiteAdapter

  constructor(databasePath: string) {
    this.adapter = new NodeSQLiteAdapter(databasePath)
    this.adapter.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS graph_run_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS graph_run_events_order
        ON graph_run_events(run_id, sequence, event_id);
    `)
  }

  static adjacentTo(graphRunRoot: string): MagicAgentGraphRunEventStore {
    return new MagicAgentGraphRunEventStore(path.join(graphRunRoot, 'graph-run-events.sqlite3'))
  }

  append(event: MagicAgentGraphRunEvent): MagicAgentGraphRunPublicEvent {
    const stored: MagicAgentGraphRunPublicEvent = {
      eventId: cleanString(event.eventId),
      runId: cleanString(event.runId),
      sequence: Number(event.sequence),
      kind: event.type,
      timestamp: Number(event.createdAt),
      payload: publicPayload(event)
    }
    if (
      !stored.eventId ||
      !stored.runId ||
      !Number.isSafeInteger(stored.sequence) ||
      stored.sequence < 1
    ) {
      throw new Error('Graph run event requires stable eventId, runId, and positive sequence.')
    }
    const result = this.adapter
      .prepare(
        `INSERT OR IGNORE INTO graph_run_events
        (event_id, run_id, sequence, kind, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        stored.eventId,
        stored.runId,
        stored.sequence,
        stored.kind,
        stored.timestamp,
        JSON.stringify(stored.payload)
      )
    if (Number(result.changes) > 0) {
      for (const subscriber of subscribers.get(stored.runId) || []) subscriber(stored)
    }
    return stored
  }

  appendMany(events: readonly MagicAgentGraphRunEvent[]): void {
    for (const event of events) this.append(event)
  }

  listAfter(runId: string, afterEventId?: string): MagicAgentGraphRunPublicEvent[] {
    const normalizedRunId = cleanString(runId)
    let afterSequence = 0
    if (afterEventId) {
      const cursor = this.adapter.get(
        'SELECT sequence FROM graph_run_events WHERE run_id = ? AND event_id = ?',
        normalizedRunId,
        cleanString(afterEventId)
      )
      if (!cursor) throw new Error(`Graph run event cursor ${afterEventId} was not found.`)
      afterSequence = Number(cursor.sequence)
    }
    return this.adapter
      .all(
        `SELECT event_id, run_id, sequence, kind, timestamp, payload_json
         FROM graph_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence, event_id`,
        normalizedRunId,
        afterSequence
      )
      .map((row) => ({
        eventId: String(row.event_id),
        runId: String(row.run_id),
        sequence: Number(row.sequence),
        kind: row.kind as MagicAgentGraphRunEventType,
        timestamp: Number(row.timestamp),
        payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>
      }))
  }

  subscribe(runId: string, listener: (event: MagicAgentGraphRunPublicEvent) => void): () => void {
    const normalizedRunId = cleanString(runId)
    const set = subscribers.get(normalizedRunId) || new Set()
    set.add(listener)
    subscribers.set(normalizedRunId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) subscribers.delete(normalizedRunId)
    }
  }

  close(): void {
    this.adapter.close()
  }
}
