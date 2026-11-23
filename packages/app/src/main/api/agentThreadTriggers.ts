import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  canvasThreadStorageScopeOfRoute,
  getAgentSessionKey,
  normalizeAgentRoute,
  type AgentRouteLike
} from '@shared/agent'
import type { AgentThreadTriggerView } from '@shared/api/agentThreadTrigger'
import {
  MagicAgentEventStore,
  ResourceRevisionConflictError,
  type ResourceCursor,
  type ResourceMutationInput
} from '../magicAgentPlatform2/persistence/eventStore'
import { activeInstanceLeasePids } from '../magicAgentPlatform2/persistence/writeLock'

/**
 * S4: model-installed triggers, after KohakuTerrarium 2.2.3 TimerTrigger (add_timer) and
 * SchedulerTrigger (add_schedule). A trigger belongs to one canvas thread session and fires a
 * trigger_fire thread event (the prompt) into that session. Unlike KT, a definition is durable per
 * session and fires only while the app and the session's project are open (user choice B); a slot
 * missed while it was closed fires once when it opens (KT has no catch-up: one per trigger).
 */
export const TRIGGER_KIND = 'agent-thread-trigger-v1'
export const TRIGGER_UNAVAILABLE = 'Thread triggers unavailable.'
export const TRIGGER_LIMITS = {
  perSession: 16,
  total: 256,
  promptCharacters: 2000,
  /** Every fire costs a model turn: add_timer refuses a shorter interval (KT only needs > 0). */
  minimumIntervalSeconds: 60,
  maximumIntervalSeconds: 366 * 24 * 60 * 60
} as const
/** The scheduler looks at least this often (and right away when a project opens). */
export const TRIGGER_TICK_MS = 30_000
const PAGE = 1000
const RETRY_MS = 30_000

export type TriggerSpec =
  | Readonly<{ kind: 'timer'; interval: number; immediate: boolean }>
  | Readonly<{ kind: 'schedule'; every_minutes?: number; daily_at?: string; hourly_at?: number }>
export type TriggerSession = Readonly<{
  storageScope: string
  routeKey: string
  conversationId: string
}>
export type TriggerRecord = Readonly<
  TriggerSession & {
    v: 1
    triggerId: string
    route: AgentRouteLike
    spec: TriggerSpec
    prompt: string
    createdAt: number
    nextFireAt: number
    /** Idempotency key of the last fire this trigger queued (one waiting fire per trigger). */
    lastKey?: string
    /** Per definition: a deleted name can be installed again under a new resource id. */
    nonce: string
  }
>

const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
export const TRIGGER_NAME = /^[A-Za-z0-9_-]{1,64}$/
const DAILY_AT = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** A canvas thread route's trigger session, or undefined for any other route. */
export function triggerSessionOf(
  route: AgentRouteLike,
  conversationId: string
): TriggerSession | undefined {
  const normalized = normalizeAgentRoute(route)
  const storageScope = canvasThreadStorageScopeOfRoute(normalized)
  if (
    !storageScope ||
    !safeId(normalized.scopeId) ||
    !safeId(normalized.threadId) ||
    !safeId(conversationId)
  )
    return undefined
  return { storageScope, routeKey: getAgentSessionKey(normalized), conversationId }
}
const resourceId = (record: TriggerSession & { triggerId: string; nonce: string }): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        record.storageScope,
        record.routeKey,
        record.conversationId,
        record.triggerId,
        record.nonce
      ])
    )
    .digest('hex')
const logicalKey = (session: TriggerSession, triggerId: string): string =>
  JSON.stringify([session.storageScope, session.routeKey, session.conversationId, triggerId])
const sameSession = (a: TriggerSession, b: TriggerSession) =>
  a.storageScope === b.storageScope &&
  a.routeKey === b.routeKey &&
  a.conversationId === b.conversationId

/** Validates add_schedule arguments: exactly one of every_minutes, daily_at, hourly_at. */
export function scheduleSpec(args: {
  every_minutes?: unknown
  daily_at?: unknown
  hourly_at?: unknown
}): TriggerSpec {
  const given = (['every_minutes', 'daily_at', 'hourly_at'] as const).filter(
    (key) => args[key] !== undefined && args[key] !== null
  )
  if (given.length !== 1)
    throw new Error(
      'Provide exactly one of every_minutes, daily_at or hourly_at; they cannot be combined.'
    )
  const { every_minutes, daily_at, hourly_at } = args
  if (given[0] === 'every_minutes') {
    if (
      !Number.isInteger(every_minutes) ||
      (every_minutes as number) < 1 ||
      (every_minutes as number) > 1440
    )
      throw new Error('every_minutes must be an integer from 1 to 1440.')
    return { kind: 'schedule', every_minutes: every_minutes as number }
  }
  if (given[0] === 'daily_at') {
    const match = typeof daily_at === 'string' ? DAILY_AT.exec(daily_at.trim()) : null
    if (!match) throw new Error('daily_at must be HH:MM on a 24-hour clock (for example 09:30).')
    return { kind: 'schedule', daily_at: `${match[1].padStart(2, '0')}:${match[2]}` }
  }
  if (!Number.isInteger(hourly_at) || (hourly_at as number) < 0 || (hourly_at as number) > 59)
    throw new Error('hourly_at must be an integer minute from 0 to 59.')
  return { kind: 'schedule', hourly_at: hourly_at as number }
}

/** Validates add_timer arguments; the floor is a clear refusal, never a silent clamp. */
export function timerSpec(args: { interval?: unknown; immediate?: unknown }): TriggerSpec {
  const interval = args.interval
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0)
    throw new Error('interval must be a number of seconds greater than 0.')
  if (interval < TRIGGER_LIMITS.minimumIntervalSeconds)
    throw new Error(
      `interval must be at least ${TRIGGER_LIMITS.minimumIntervalSeconds} seconds (got ${interval}); every fire starts a model turn.`
    )
  if (interval > TRIGGER_LIMITS.maximumIntervalSeconds)
    throw new Error(`interval must be at most ${TRIGGER_LIMITS.maximumIntervalSeconds} seconds.`)
  if (args.immediate !== undefined && typeof args.immediate !== 'boolean')
    throw new Error('immediate must be a boolean.')
  return { kind: 'timer', interval, immediate: args.immediate === true }
}

/**
 * The first slot strictly after `after`. A timer counts whole intervals from its install time; a
 * schedule follows the local clock like KT (`every_minutes` aligned to local midnight, a slot past
 * 23:59 moves to the next midnight). Local Date arithmetic keeps it right across DST changes.
 */
export function nextTriggerSlot(spec: TriggerSpec, anchor: number, after: number): number {
  if (spec.kind === 'timer') {
    const step = spec.interval * 1000
    const k = Math.max(1, Math.floor((after - anchor) / step) + 1)
    return anchor + k * step
  }
  const at = new Date(after)
  const day = (offset: number, hour: number, minute: number) =>
    new Date(at.getFullYear(), at.getMonth(), at.getDate() + offset, hour, minute, 0, 0).getTime()
  if (spec.every_minutes) {
    const n = spec.every_minutes
    for (let offset = 0; offset < 3; offset++) {
      for (let slot = 0; slot < 1440; slot += n) {
        const candidate = day(offset, Math.floor(slot / 60), slot % 60)
        if (candidate > after) return candidate
      }
    }
  } else if (spec.daily_at) {
    const [hour, minute] = spec.daily_at.split(':').map(Number)
    for (let offset = 0; offset < 3; offset++) {
      const candidate = day(offset, hour, minute)
      if (candidate > after) return candidate
    }
  } else if (spec.hourly_at !== undefined) {
    for (let hour = at.getHours(); hour < at.getHours() + 50; hour++) {
      const candidate = day(0, hour, spec.hourly_at)
      if (candidate > after) return candidate
    }
  }
  return after + 60_000
}

/** The model-visible type name, as KT's /triggers shows it. */
const typeName = (spec: TriggerSpec) =>
  spec.kind === 'timer' ? 'TimerTrigger' : 'SchedulerTrigger'

function readRecord(state: unknown, id: string): TriggerRecord | undefined {
  if (
    !plain(state) ||
    state.v !== 1 ||
    !safeId(state.triggerId) ||
    typeof state.nonce !== 'string' ||
    !/^[0-9a-f]{32}$/.test(state.nonce) ||
    resourceId(state as never) !== id
  )
    return undefined
  const record = state as unknown as TriggerRecord
  if (
    typeof record.prompt !== 'string' ||
    !record.prompt.trim() ||
    record.prompt.length > TRIGGER_LIMITS.promptCharacters ||
    !time(record.createdAt) ||
    !time(record.nextFireAt) ||
    !plain(record.spec) ||
    !plain(record.route) ||
    !triggerSessionOf(record.route, record.conversationId) ||
    !sameSession(triggerSessionOf(record.route, record.conversationId)!, record)
  )
    return undefined
  try {
    if (record.spec.kind === 'timer') timerSpec(record.spec)
    else if (record.spec.kind === 'schedule') scheduleSpec(record.spec)
    else return undefined
  } catch {
    return undefined
  }
  return record
}

type Indexed = { record: TriggerRecord; revision: number; id: string; updatedAt: number }

/** Durable trigger definitions over one MagicAgentEventStore file (MAIN only). */
export class ThreadTriggerStore {
  private readonly index = new Map<string, Indexed>()
  readonly unavailable: boolean
  constructor(private readonly store: MagicAgentEventStore) {
    const path = store.getStorageInfo().path
    this.unavailable =
      path !== ':memory:' && activeInstanceLeasePids(path).some((pid) => pid !== process.pid)
    if (!this.unavailable) this.recover()
  }
  private recover(): void {
    let after: ResourceCursor | undefined
    for (;;) {
      const page = this.store.listResources({
        kind: TRIGGER_KIND,
        limit: PAGE,
        ...(after ? { after } : {})
      })
      for (const row of page) {
        const record = readRecord(row.state, row.id)
        // An unreadable definition never fires (fail closed); it stays on disk untouched.
        const key = record && logicalKey(record, record.triggerId)
        if (record && key && !this.index.has(key))
          this.index.set(key, {
            record,
            revision: row.revision,
            id: row.id,
            updatedAt: row.updatedAt
          })
      }
      if (page.length < PAGE) break
      const last = page[page.length - 1]
      after = { updatedAt: last.updatedAt, resourceKind: last.kind, resourceId: last.id }
    }
  }
  private mutation(
    operation: 'create' | 'update' | 'delete',
    id: string,
    state: unknown,
    at: number,
    expectedRevision?: number
  ): ResourceMutationInput {
    const eventId = randomUUID()
    return {
      operation,
      kind: TRIGGER_KIND,
      id,
      idempotencyKey: `thread-trigger:${eventId}`,
      ...(operation === 'delete' ? {} : { state }),
      createdAt: at,
      ...(operation === 'create' ? {} : { expectedRevision }),
      event: {
        protocolVersion: '2.0.0',
        id: eventId,
        type: `thread-trigger-${operation}`,
        createdAt: at,
        payload: {},
        envelopeKind: 'event',
        streamId: `${TRIGGER_KIND}:${id}`,
        sequence: operation === 'create' ? 0 : expectedRevision! + 1
      }
    }
  }
  private assertAvailable(): void {
    if (this.unavailable) throw new Error(TRIGGER_UNAVAILABLE)
  }
  all(): TriggerRecord[] {
    return [...this.index.values()].map((entry) => entry.record)
  }
  get(session: TriggerSession, triggerId: string): TriggerRecord | undefined {
    return this.index.get(logicalKey(session, triggerId))?.record
  }
  create(record: TriggerRecord): void {
    this.assertAvailable()
    const key = logicalKey(record, record.triggerId)
    if (this.index.has(key)) throw new Error(`Trigger already exists: ${record.triggerId}`)
    const id = resourceId(record)
    const [result] = this.store.mutateResourcesBatch([
      this.mutation('create', id, record, record.createdAt)
    ])
    this.index.set(key, {
      record,
      revision: result.resource.revision,
      id,
      updatedAt: result.resource.updatedAt
    })
  }
  update(record: TriggerRecord, at: number): void {
    this.assertAvailable()
    const key = logicalKey(record, record.triggerId)
    const entry = this.index.get(key)
    if (!entry || entry.record.nonce !== record.nonce) return
    try {
      const [result] = this.store.mutateResourcesBatch([
        this.mutation('update', entry.id, record, Math.max(at, entry.updatedAt), entry.revision)
      ])
      this.index.set(key, {
        record,
        revision: result.resource.revision,
        id: entry.id,
        updatedAt: result.resource.updatedAt
      })
    } catch (error) {
      if (!(error instanceof ResourceRevisionConflictError)) throw error
      this.index.delete(key)
    }
  }
  delete(session: TriggerSession, triggerId: string, at: number): boolean {
    this.assertAvailable()
    const key = logicalKey(session, triggerId)
    const entry = this.index.get(key)
    if (!entry) return false
    this.store.mutateResourcesBatch([
      this.mutation('delete', entry.id, undefined, Math.max(at, entry.updatedAt), entry.revision)
    ])
    this.index.delete(key)
    return true
  }
  close(): void {
    this.index.clear()
    this.store.close()
  }
}

export type ThreadTriggerStoreOpener = {
  open(create: boolean): ThreadTriggerStore | undefined
  close(): void
}

/** Resolves the file only on first use (production passes the data-directory path lazily). */
export function lazyThreadTriggerStoreOpener(file: () => string): ThreadTriggerStoreOpener {
  let opener: ThreadTriggerStoreOpener | undefined
  return {
    open: (create) => (opener ??= threadTriggerStoreOpener(file())).open(create),
    close: () => opener?.close()
  }
}

/** Opens the trigger file on first use; a failure is remembered for RETRY_MS and logged once. */
export function threadTriggerStoreOpener(file: string): ThreadTriggerStoreOpener {
  let store: ThreadTriggerStore | undefined,
    failure: unknown,
    retryAt = 0,
    logged: string | undefined
  return {
    open(create) {
      if (store) return store
      if (performance.now() < retryAt) throw failure
      if (!create && !existsSync(file)) return undefined
      try {
        if (activeInstanceLeasePids(file).some((pid) => pid !== process.pid))
          throw new Error(TRIGGER_UNAVAILABLE)
        mkdirSync(dirname(file), { recursive: true })
        const db = new MagicAgentEventStore(file)
        let opened: ThreadTriggerStore
        try {
          opened = new ThreadTriggerStore(db)
        } catch (error) {
          db.close()
          throw error
        }
        if (opened.unavailable) {
          opened.close()
          throw new Error(TRIGGER_UNAVAILABLE)
        }
        store = opened
        logged = undefined
        return store
      } catch (error) {
        failure = error
        const detail = String(error instanceof Error ? error.message : error).slice(0, 300)
        if (detail !== logged) {
          logged = detail
          console.warn('[ThreadTriggers] The trigger file is not served for now.', detail)
        }
        retryAt = performance.now() + RETRY_MS
        throw error
      }
    },
    close() {
      const opened = store
      store = undefined
      opened?.close()
    }
  }
}

/** What the scheduler needs from the thread inbox (MAIN only). */
export type TriggerInboxPort = {
  enqueue(input: {
    route: AgentRouteLike
    storageScope: string
    conversationId: string
    type: 'trigger_fire'
    source: string
    text: string
    idempotencyKey: string
  }): { id: string; duplicate: boolean }
  /** An event with this key still waits (queued or claimed) in the session. */
  isPending(session: TriggerSession & { route: AgentRouteLike }, idempotencyKey: string): boolean
  /** The pane's thread pump listed events within the open window (its project is open). */
  isOpen(storageScope: string, routeKey: string): boolean
}

export type TriggerInstall = {
  tool: 'add_timer' | 'add_schedule'
  route: AgentRouteLike
  conversationId: string
  name?: string
  spec: TriggerSpec
  prompt: string
}

/**
 * MAIN trigger registry and scheduler. Fires only into an open project's session; while closed a
 * due trigger waits, then fires once (a catch-up) and moves to its first slot after now. A trigger
 * whose last fire still waits in the inbox (busy or stopped session) queues no second fire: like
 * KT, fires of one trigger never stack.
 */
export class AgentThreadTriggers {
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  constructor(
    private readonly options: {
      /** The trigger file (production: data/thread-triggers/triggers.sqlite); opened on first use. */
      store: ThreadTriggerStoreOpener
      inbox: TriggerInboxPort
      now?: () => number
      /** Tests drive tick() themselves. */
      schedule?: boolean
    }
  ) {}
  private get store(): ThreadTriggerStoreOpener {
    return this.options.store
  }
  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  install(input: TriggerInstall): { triggerId: string; record: TriggerRecord } {
    const session = triggerSessionOf(input.route, input.conversationId)
    if (!session) throw new Error('Triggers are available only in a canvas Agent thread.')
    if (typeof input.prompt !== 'string' || !input.prompt.trim())
      throw new Error(`Missing required arg(s) for ${input.tool}: prompt`)
    if (input.prompt.length > TRIGGER_LIMITS.promptCharacters)
      throw new Error(`prompt must be at most ${TRIGGER_LIMITS.promptCharacters} characters.`)
    const name = input.name?.trim() || undefined
    if (name !== undefined && !TRIGGER_NAME.test(name))
      throw new Error('name must be 1-64 letters, digits, "_" or "-".')
    const store = this.store.open(true)!
    const all = store.all()
    if (all.length >= TRIGGER_LIMITS.total)
      throw new Error('Too many triggers are installed in this app.')
    if (all.filter((record) => sameSession(record, session)).length >= TRIGGER_LIMITS.perSession)
      throw new Error(
        `This conversation already has ${TRIGGER_LIMITS.perSession} triggers; delete one first.`
      )
    const triggerId = name ?? `trigger_${randomBytes(4).toString('hex')}`
    if (store.get(session, triggerId)) throw new Error(`Trigger already exists: ${triggerId}`)
    const createdAt = this.now()
    const nextFireAt =
      input.spec.kind === 'timer' && input.spec.immediate
        ? createdAt
        : nextTriggerSlot(input.spec, createdAt, createdAt)
    const record: TriggerRecord = {
      v: 1,
      ...session,
      triggerId,
      route: normalizeAgentRoute(input.route),
      spec: input.spec,
      prompt: input.prompt,
      createdAt,
      nextFireAt,
      nonce: randomBytes(16).toString('hex')
    }
    store.create(record)
    this.arm(0)
    return { triggerId, record }
  }

  remove(route: AgentRouteLike, conversationId: string, triggerId: string): boolean {
    const session = triggerSessionOf(route, conversationId)
    if (!session || typeof triggerId !== 'string' || !triggerId.trim()) return false
    const store = this.store.open(false)
    return store?.delete(session, triggerId.trim(), this.now()) ?? false
  }

  list(route: AgentRouteLike, conversationId: string): AgentThreadTriggerView[] {
    const session = triggerSessionOf(route, conversationId)
    if (!session) return []
    let store: ThreadTriggerStore | undefined
    try {
      store = this.store.open(false)
    } catch {
      return []
    }
    return (store?.all() ?? [])
      .filter((record) => sameSession(record, session))
      .sort((a, b) => a.createdAt - b.createdAt || a.triggerId.localeCompare(b.triggerId))
      .map((record) => ({
        id: record.triggerId,
        type: typeName(record.spec),
        running: true,
        createdAt: record.createdAt,
        nextFireAt: record.nextFireAt,
        prompt: record.prompt
      }))
  }

  /** The session was removed for good: its triggers are deleted. Returns how many. */
  removeSession(route: AgentRouteLike, conversationId: string): number {
    const session = triggerSessionOf(route, conversationId)
    if (!session) return 0
    let store: ThreadTriggerStore | undefined
    try {
      store = this.store.open(false)
    } catch {
      return 0
    }
    if (!store) return 0
    let removed = 0
    for (const record of store.all())
      if (record.routeKey === session.routeKey && record.conversationId === session.conversationId)
        if (store.delete(record, record.triggerId, this.now())) removed++
    return removed
  }

  /** Fires every due trigger of an open project. Returns the ids of the fires it queued. */
  tick(): string[] {
    let store: ThreadTriggerStore | undefined
    try {
      store = this.store.open(false)
    } catch {
      return []
    }
    if (!store) return []
    const now = this.now()
    const queued: string[] = []
    for (const record of store.all()) {
      if (record.nextFireAt > now) continue
      if (!this.options.inbox.isOpen(record.storageScope, record.routeKey)) continue
      const next = nextTriggerSlot(record.spec, record.createdAt, now)
      let missed = 0
      for (
        let slot = record.nextFireAt;
        slot <= now && missed < 1000;
        slot = nextTriggerSlot(record.spec, record.createdAt, slot)
      )
        missed++
      const key = `trigger_fire:${record.triggerId}:${new Date(record.nextFireAt).toISOString()}`
      let lastKey = record.lastKey
      try {
        const waiting = lastKey !== undefined && this.options.inbox.isPending(record, lastKey)
        if (!waiting) {
          const text =
            missed > 1
              ? `${record.prompt}\n\n(Catch-up: ${missed} scheduled fires of this trigger were missed while the project was closed or the conversation was busy; this is the one catch-up.)`
              : record.prompt
          const result = this.options.inbox.enqueue({
            route: record.route,
            storageScope: record.storageScope,
            conversationId: record.conversationId,
            type: 'trigger_fire',
            source: record.triggerId,
            text,
            idempotencyKey: key
          })
          lastKey = key
          queued.push(result.id)
        }
      } catch (error) {
        // The inbox is full or unavailable: the slot stays due and is tried again later.
        console.warn(
          '[ThreadTriggers] A trigger fire was not queued.',
          String(error instanceof Error ? error.message : error).slice(0, 200)
        )
        continue
      }
      try {
        store.update(
          { ...record, nextFireAt: next, ...(lastKey === undefined ? {} : { lastKey }) },
          now
        )
      } catch {
        /* The slot stays due; its idempotency key collapses a repeat while the fire waits. */
      }
    }
    return queued
  }

  /** Starts the scheduler, or looks now if it runs (a pane opened). */
  start(): void {
    this.options.schedule = true
    this.arm(0)
  }
  /** A project opened: look now instead of at the next tick. */
  nudge(): void {
    this.arm(0)
  }
  private arm(delay: number): void {
    if (this.disposed || !this.options.schedule) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      try {
        this.tick()
      } catch {
        /* Logged by the opener; the next tick tries again. */
      }
      this.arm(this.untilNext())
    }, delay)
    this.timer.unref?.()
  }
  private untilNext(): number {
    let store: ThreadTriggerStore | undefined
    try {
      store = this.store.open(false)
    } catch {
      return TRIGGER_TICK_MS
    }
    const now = this.now()
    const soonest = Math.min(
      ...(store?.all().map((record) => record.nextFireAt) ?? []),
      now + TRIGGER_TICK_MS
    )
    return Math.min(TRIGGER_TICK_MS, Math.max(1000, soonest - now))
  }
  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.options.store.close()
  }
}
