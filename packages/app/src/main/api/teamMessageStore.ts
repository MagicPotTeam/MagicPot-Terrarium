import { randomUUID } from 'node:crypto'
import {
  ResourceRevisionConflictError,
  type MagicAgentEventStore,
  type ResourceCursor,
  type ResourceMutationInput,
  type StoredResource
} from '../magicAgentPlatform2/persistence/eventStore'
import { activeInstanceLeasePids } from '../magicAgentPlatform2/persistence/writeLock'

/** Written once and never updated: the message itself. */
export const TEAM_MESSAGE_KIND = 'llm-team-message-v1'
/** The small record that changes: status, claim and request starts. No text, token or webContents id. */
export const TEAM_MESSAGE_STATE_KIND = 'llm-team-message-state-v1'
export const TEAM_QUEUE_UNAVAILABLE = 'Team queue unavailable.'
export const MAX_TEAM_MESSAGE_STARTS = 256
const PAGE = 1000

export type TeamMessageTeam = Readonly<{ scope: string; thread: string; lead: string }>
export type TeamMessageRecord = Readonly<{
  v: 1
  id: string
  source: Readonly<{ scope: string; thread: string; lead: string; member: string }>
  routeKey: string
  kind: 'message' | 'channel'
  hop: 1 | 2
  recipient?: string
  text: string
  createdAt: number
}>
/**
 * queued -> claimed -> closed | unknown, queued -> ended. closed, unknown and ended are final.
 * closed: the claim is over and starts lists every recipient whose request MAIN admitted;
 * unknown: the claim is over and MAIN admitted no request; ended: the team ended while queued.
 */
export type TeamMessageStatus = 'queued' | 'claimed' | 'closed' | 'unknown' | 'ended'
export type TeamMessageStart = Readonly<{ recipient: string; at: number }>
export type TeamMessageState = Readonly<{
  v: 1
  id: string
  team: TeamMessageTeam
  status: TeamMessageStatus
  /** The process (boot id) that claimed it; kept after the claim is over. */
  claim?: Readonly<{ boot: string; at: number }>
  starts: readonly TeamMessageStart[]
}>
export type TeamMessageEntry = Readonly<{ intent: TeamMessageRecord; state: TeamMessageState }>
export type TeamMessageAppend = Readonly<{
  source: TeamMessageRecord['source']
  routeKey: string
  kind: 'message' | 'channel'
  hop: 1 | 2
  recipient?: string
  text: string
}>
type Indexed = { intent: TeamMessageRecord; state: TeamMessageState; revision: number; updatedAt: number }

const FINAL: ReadonlySet<TeamMessageStatus> = new Set(['closed', 'unknown', 'ended'])
const STATUSES: ReadonlySet<unknown> = new Set(['queued', 'claimed', 'closed', 'unknown', 'ended'])
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isTeam = (value: unknown): value is TeamMessageTeam => plain(value) && str(value.scope) && str(value.thread) && str(value.lead)
const sameTeam = (a: TeamMessageTeam, b: TeamMessageTeam): boolean => a.scope === b.scope && a.thread === b.thread && a.lead === b.lead
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value
}

/** Reads one state record; any other version or shape is skipped (never listed, never rewritten). */
function readState(row: StoredResource): TeamMessageState | undefined {
  const state = row.state
  if (row.deleted || !plain(state) || state.v !== 1 || state.id !== row.id || !isTeam(state.team) || !STATUSES.has(state.status)) return undefined
  const claim = state.claim
  if (claim !== undefined && (!plain(claim) || !str(claim.boot) || !time(claim.at))) return undefined
  if (state.status === 'claimed' ? claim === undefined : (state.status === 'queued' || state.status === 'ended') && claim !== undefined) return undefined
  if (!Array.isArray(state.starts) || state.starts.length > MAX_TEAM_MESSAGE_STARTS || !state.starts.every(start => plain(start) && str(start.recipient, 128) && time(start.at))) return undefined
  return state as TeamMessageState
}
function validRecord(record: unknown, id: string): record is TeamMessageRecord {
  if (!plain(record) || record.v !== 1 || record.id !== id) return false
  const source = record.source
  if (!plain(source) || !str(source.scope) || !str(source.thread) || !str(source.lead) || !str(source.member) || source.member === source.lead) return false
  if (!str(record.routeKey, 4096) || (record.hop !== 1 && record.hop !== 2) || typeof record.text !== 'string' || !record.text.trim() || record.text.length > 4000 || !time(record.createdAt)) return false
  return record.kind === 'message' ? str(record.recipient, 128) && record.recipient !== source.member : record.kind === 'channel' && record.recipient === undefined
}
function readRecord(row: StoredResource | undefined, id: string): TeamMessageRecord | undefined {
  return row && !row.deleted && validRecord(row.state, id) ? row.state : undefined
}

/**
 * Durable MAIN store of member messages (send_message / send_channel). Append-only: the message
 * text is written once; every later change writes only the small state record. A claim belongs to
 * the boot (process) that made it; on open, every claim of another boot is over and becomes
 * 'closed' (a request had started) or 'unknown' (none had), and is never delivered again. Recovery
 * never runs while another live process holds the same file: then the store serves nothing.
 */
export class TeamMessageStore {
  private readonly index = new Map<string, Indexed>()
  readonly unavailable: boolean

  constructor(private readonly store: MagicAgentEventStore, private readonly boot: string) {
    if (!str(boot)) throw new Error('Invalid team queue boot.')
    const path = store.getStorageInfo().path
    this.unavailable = path !== ':memory:' && activeInstanceLeasePids(path).some(pid => pid !== process.pid)
    if (!this.unavailable) this.recover()
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new Error(TEAM_QUEUE_UNAVAILABLE)
  }

  private mutation(operation: 'create' | 'update', kind: string, id: string, state: unknown, createdAt: number, expectedRevision?: number): ResourceMutationInput {
    const eventId = randomUUID(), revision = operation === 'create' ? 0 : expectedRevision! + 1
    return {
      operation, kind, id, idempotencyKey: `team-message:${eventId}`, state, createdAt,
      ...(operation === 'update' ? { expectedRevision } : {}),
      event: { protocolVersion: '2.0.0', id: eventId, type: kind === TEAM_MESSAGE_KIND ? 'team-message-queued' : 'team-message-state', createdAt, payload: {}, envelopeKind: 'event', streamId: `${kind}:${id}`, sequence: revision }
    }
  }

  /** CAS on the state record; the index changes only after the commit. */
  private update(entry: { state: TeamMessageState; revision: number; updatedAt: number }, next: TeamMessageState): { revision: number; updatedAt: number } {
    const [result] = this.store.mutateResourcesBatch([this.mutation('update', TEAM_MESSAGE_STATE_KIND, next.id, next, Math.max(Date.now(), entry.updatedAt), entry.revision)])
    return { revision: result.resource.revision, updatedAt: result.resource.updatedAt }
  }

  /** The rule for every claim that is over: 'closed' when a request started, else 'unknown'. */
  private settle(at: { revision: number; updatedAt: number }, state: TeamMessageState): TeamMessageStatus {
    const status = state.starts.length ? 'closed' : 'unknown'
    this.update({ state, revision: at.revision, updatedAt: at.updatedAt }, { ...state, status })
    return status
  }

  private recover(): void {
    const own: Array<[StoredResource, TeamMessageState]> = [], other: Array<[StoredResource, TeamMessageState]> = []
    let after: ResourceCursor | undefined
    for (;;) {
      const page = this.store.listResources({ kind: TEAM_MESSAGE_STATE_KIND, limit: PAGE, ...(after ? { after } : {}) })
      for (const row of page) {
        const state = readState(row)
        if (!state || FINAL.has(state.status)) continue
        if (state.status === 'claimed' && state.claim!.boot !== this.boot) other.push([row, state])
        else own.push([row, state])
      }
      if (page.length < PAGE) break
      const last = page[page.length - 1]
      after = { updatedAt: last.updatedAt, resourceKind: last.kind, resourceId: last.id }
    }
    // Every claim of another boot is over before anything is served.
    for (const [row, state] of other) this.settle(row, state)
    for (const [row, state] of own) {
      const intent = readRecord(this.store.getResource(TEAM_MESSAGE_KIND, row.id), row.id)
      if (intent && sameTeam(intent.source, state.team)) this.index.set(row.id, freeze({ intent, state, revision: row.revision, updatedAt: row.updatedAt }) as Indexed)
    }
  }

  /** Both records in one transaction: never a text record without its state record. */
  append(input: TeamMessageAppend): TeamMessageEntry {
    this.assertAvailable()
    const source = input?.source
    if (!plain(source)) throw new Error('Invalid team message.')
    const id = randomUUID(), createdAt = Date.now()
    const intent = {
      v: 1 as const, id, source: { scope: source.scope, thread: source.thread, lead: source.lead, member: source.member }, routeKey: input.routeKey,
      kind: input.kind, hop: input.hop, ...(input.recipient === undefined ? {} : { recipient: input.recipient }), text: input.text, createdAt
    }
    if (!validRecord(intent, id)) throw new Error('Invalid team message.')
    const state: TeamMessageState = { v: 1, id, team: { scope: source.scope, thread: source.thread, lead: source.lead }, status: 'queued', starts: [] }
    const [, result] = this.store.mutateResourcesBatch([
      this.mutation('create', TEAM_MESSAGE_KIND, id, intent, createdAt),
      this.mutation('create', TEAM_MESSAGE_STATE_KIND, id, state, createdAt)
    ])
    const entry = freeze({ intent, state, revision: result.resource.revision, updatedAt: result.resource.updatedAt })
    this.index.set(id, entry)
    return { intent: entry.intent, state: entry.state }
  }

  /** queued -> claimed{boot, at}. Undefined when it is not queued here or another claim won. */
  claim(id: string): TeamMessageEntry | undefined {
    this.assertAvailable()
    const entry = this.index.get(id)
    if (!entry || entry.state.status !== 'queued') return undefined
    const state: TeamMessageState = { ...entry.state, status: 'claimed', claim: { boot: this.boot, at: Date.now() } }
    let written: { revision: number; updatedAt: number }
    try { written = this.update(entry, state) } catch (error) {
      if (!(error instanceof ResourceRevisionConflictError)) throw error
      this.refresh(id)
      return undefined
    }
    const next = freeze({ intent: entry.intent, state, ...written })
    this.index.set(id, next)
    return { intent: next.intent, state: next.state }
  }

  /**
   * Records that MAIN admitted a request of this recipient. Only for a claim of this boot. A
   * message closes with its one start; a channel stays claimed and adds the recipient. A repeat
   * of a recipient already started returns 'already' without a write.
   */
  start(id: string, recipient: string): 'started' | 'already' {
    this.assertAvailable()
    if (!str(recipient, 128)) throw new Error('Invalid team message recipient.')
    const entry = this.index.get(id)
    if (!entry) {
      const stored = this.get(id)
      if (stored?.state.status === 'closed' && stored.state.claim?.boot === this.boot && stored.state.starts.some(start => start.recipient === recipient)) return 'already'
      throw new Error('Team message is not claimed.')
    }
    const { intent, state } = entry
    if (state.status !== 'claimed' || state.claim?.boot !== this.boot) throw new Error('Team message is not claimed.')
    if (state.starts.some(start => start.recipient === recipient)) return 'already'
    if (intent.kind === 'message' ? recipient !== intent.recipient : recipient === intent.source.member) throw new Error('Invalid team message recipient.')
    if (state.starts.length >= MAX_TEAM_MESSAGE_STARTS) throw new Error('Team message start limit reached.')
    const starts = [...state.starts, { recipient, at: Date.now() }]
    const next: TeamMessageState = intent.kind === 'message' ? { ...state, status: 'closed', starts } : { ...state, starts }
    const written = this.update(entry, next)
    if (next.status === 'claimed') this.index.set(id, freeze({ intent, state: next, ...written }))
    else this.index.delete(id)
    return 'started'
  }

  /** The claim is over: 'closed' when a request started, else 'unknown'. Final records stay as they are. */
  closeClaim(id: string): TeamMessageStatus | undefined {
    this.assertAvailable()
    const entry = this.index.get(id)
    if (!entry) return this.get(id)?.state.status
    if (entry.state.status !== 'claimed') return entry.state.status
    const status = this.settle(entry, entry.state)
    this.index.delete(id)
    return status
  }

  /** One queued record -> 'ended' (its team ended before it was claimed). */
  endQueued(id: string): TeamMessageStatus | undefined {
    this.assertAvailable()
    const entry = this.index.get(id)
    if (!entry) return this.get(id)?.state.status
    if (entry.state.status !== 'queued') return entry.state.status
    this.update(entry, { ...entry.state, status: 'ended' })
    this.index.delete(id)
    return 'ended'
  }

  /** Every queued record of this team -> 'ended'; claimed and final records stay as they are. */
  endTeam(team: TeamMessageTeam): number {
    this.assertAvailable()
    if (!isTeam(team)) throw new Error('Invalid team identity.')
    const queued = [...this.index.values()].filter(entry => entry.state.status === 'queued' && sameTeam(entry.state.team, team))
    for (let i = 0; i < queued.length; i += PAGE) {
      const chunk = queued.slice(i, i + PAGE)
      this.store.mutateResourcesBatch(chunk.map(entry => this.mutation('update', TEAM_MESSAGE_STATE_KIND, entry.state.id, { ...entry.state, status: 'ended' }, Math.max(Date.now(), entry.updatedAt), entry.revision)))
      for (const entry of chunk) this.index.delete(entry.state.id)
    }
    return queued.length
  }

  /** The stored receipt (reads SQLite): state plus message, or undefined for a missing or unknown record. */
  get(id: string): TeamMessageEntry | undefined {
    this.assertAvailable()
    if (!str(id, 128)) return undefined
    const row = this.store.getResource(TEAM_MESSAGE_STATE_KIND, id)
    const state = row && readState(row)
    const intent = state && readRecord(this.store.getResource(TEAM_MESSAGE_KIND, id), id)
    return state && intent && sameTeam(intent.source, state.team) ? freeze({ intent, state }) : undefined
  }

  /** In memory only (no SQLite): the record while it is queued or claimed. */
  peek(id: string): TeamMessageEntry | undefined {
    const entry = this.unavailable ? undefined : this.index.get(id)
    return entry && { intent: entry.intent, state: entry.state }
  }

  /** In memory only (no SQLite): every queued record. Empty while the store is unavailable. */
  queued(): TeamMessageEntry[] {
    if (this.unavailable) return []
    return [...this.index.values()].filter(entry => entry.state.status === 'queued').map(entry => ({ intent: entry.intent, state: entry.state }))
  }

  queuedCount(team?: TeamMessageTeam): number {
    let count = 0
    for (const entry of this.index.values()) if (entry.state.status === 'queued' && (!team || sameTeam(entry.state.team, team))) count++
    return count
  }

  close(): void {
    this.index.clear()
    this.store.close()
  }

  /** After a lost CAS: the stored state wins; the index keeps only queued and claimed records. */
  private refresh(id: string): void {
    const row = this.store.getResource(TEAM_MESSAGE_STATE_KIND, id)
    const state = row && readState(row)
    const entry = this.index.get(id)
    if (!row || !state || !entry || FINAL.has(state.status) || (state.status === 'claimed' && state.claim?.boot !== this.boot)) this.index.delete(id)
    else this.index.set(id, freeze({ intent: entry.intent, state, revision: row.revision, updatedAt: row.updatedAt }))
  }
}
