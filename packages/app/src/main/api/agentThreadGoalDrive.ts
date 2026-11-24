import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  canvasThreadStorageScopeOfRoute,
  getAgentSessionKey,
  normalizeAgentRoute,
  type AgentRouteLike
} from '@shared/agent'
import {
  AGENT_GOAL_DRIVE_MAX_FAILURES,
  formatAgentGoalEventSource,
  type AgentGoal,
  type AgentGoalCollection,
  type AgentGoalDriveUsage,
  type AgentModelGoalMutation
} from '@shared/api/agentThreadGoal'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import {
  MagicAgentEventStore,
  ResourceRevisionConflictError,
  type ResourceCursor,
  type ResourceMutationInput
} from '../magicAgentPlatform2/persistence/eventStore'
import { activeInstanceLeasePids } from '../magicAgentPlatform2/persistence/writeLock'
import type { AgentSystemGoalMutation } from './agentThreadGoalPolicy'

/**
 * S5: goals that advance by themselves, after KohakuTerrarium 2.2.3 goal drives
 * (terrarium/drive/goal.py, manager/readiness.py). A goal whose autonomy is continue_when_ready
 * gets one step at a time: MAIN queues a drive_ready thread event into the goal's session, the
 * session runs it as an event-origin turn (no user authority, approvals unchanged), and the next
 * step is queued only after that turn settled. Unlike KT (which enforces only max_turns), all three
 * budgets are hard limits here, measured and enforced in MAIN:
 * - turns: a step is charged when its turn is admitted, before any provider call; no step starts
 *   once max_turns turns were used;
 * - tool calls: every model tool call of a step turn is charged before it runs; the call past the
 *   budget is refused and the turn is stopped;
 * - walltime: a step turn is stopped when the goal's remaining walltime runs out.
 * Counts last for the goal's life (KT counts every acknowledged delivery of a drive); the user
 * raises a budget to let it go on. Steps run only while the app and the session's project are
 * open (user choice B), never while the session is held (stopped) or a completion proposal waits
 * for the user. Manual goals never get an automatic step.
 */

export const GOAL_DRIVE_KIND = 'agent-thread-goal-drive-v1'
export const GOAL_DRIVE_UNAVAILABLE = 'Goal steps unavailable.'
export const GOAL_DRIVE_TICK_MS = 30_000
/** KT drive retry policy (terrarium/drive/config.py: 2 s doubling to 300 s, jitter 0.1, 5 attempts). */
export const GOAL_DRIVE_BACKOFF = { initialMs: 2_000, maxMs: 300_000, jitter: 0.1 }
/** Walltime is charged at least this often while a step runs (a crash loses at most this much). */
export const GOAL_DRIVE_HEARTBEAT_MS = 15_000
export const GOAL_STEP_UNAVAILABLE = 'This goal step no longer applies; nothing was run.'
export const GOAL_STEP_KEY = /^goal:[a-f0-9-]{36}:\d{1,9}$/
const USER_CANCELLATION = 'Conversation cancelled by the user.'
const PAGE = 200
const RETRY_MS = 30_000
const BOOT = randomBytes(8).toString('hex')

export type GoalDriveSession = Readonly<{
  storageScope: string
  routeKey: string
  conversationId: string
}>

export type GoalDriveRecord = Readonly<
  GoalDriveSession & {
    v: 1
    route: AgentRouteLike
    goalId: string
    turnsUsed: number
    toolCallsUsed: number
    walltimeUsedMs: number
    /** The last step number queued (monotonic: the idempotency key's step). */
    step: number
    /** A queued drive_ready event that no turn has admitted yet. */
    pending?: Readonly<{ key: string; step: number; generation: number }>
    /** The admitted step turn (this boot only; a record from another boot is stale). */
    running?: Readonly<{ key: string; step: number; generation: number; boot: string }>
    failures: number
    nextAttemptAt: number
    /** The goal generation the failures were counted at: a later (user) change starts over. */
    failedGeneration?: number
  }
>

/** Budget stop of a running step (never a failure, never success). */
export class GoalBudgetExhausted extends Error {
  constructor(
    readonly budget: NonNullable<AgentGoalDriveUsage['exhausted']>,
    detail: string
  ) {
    super(
      `Goal ${detail}; the step was stopped. The goal stays active until the user raises the budget.`
    )
    this.name = 'GoalBudgetExhausted'
  }
}

const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const goalIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const plain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function goalDriveSessionOf(
  route: AgentRouteLike | undefined,
  conversationId: string | undefined
): (GoalDriveSession & { route: AgentRouteLike }) | undefined {
  if (!route || !safeId(conversationId)) return undefined
  let normalized: AgentRouteLike
  try {
    normalized = normalizeAgentRoute(route)
  } catch {
    return undefined
  }
  const storageScope = canvasThreadStorageScopeOfRoute(normalized)
  if (
    !storageScope ||
    normalized.channel !== 'canvas' ||
    normalized.scopeType !== 'thread' ||
    !safeId(normalized.scopeId) ||
    !safeId(normalized.threadId)
  )
    return undefined
  return {
    storageScope,
    routeKey: getAgentSessionKey(normalized),
    conversationId: conversationId!,
    route: normalized
  }
}

const sameSession = (a: GoalDriveSession, b: GoalDriveSession): boolean =>
  a.storageScope === b.storageScope &&
  a.routeKey === b.routeKey &&
  a.conversationId === b.conversationId
const logicalKey = (session: GoalDriveSession, goalId: string): string =>
  JSON.stringify([session.storageScope, session.routeKey, session.conversationId, goalId])
const resourceId = (session: GoalDriveSession, goalId: string): string =>
  createHash('sha256').update(logicalKey(session, goalId)).digest('hex')

function readRecord(state: unknown, id: string): GoalDriveRecord | undefined {
  if (!plain(state) || state.v !== 1 || typeof state.goalId !== 'string') return undefined
  const record = state as unknown as GoalDriveRecord
  const session = goalDriveSessionOf(record.route, record.conversationId)
  if (
    !goalIdPattern.test(record.goalId) ||
    !session ||
    !sameSession(session, record) ||
    resourceId(record, record.goalId) !== id ||
    ![
      record.turnsUsed,
      record.toolCallsUsed,
      record.walltimeUsedMs,
      record.step,
      record.failures,
      record.nextAttemptAt
    ].every(count) ||
    (record.failedGeneration !== undefined && !count(record.failedGeneration)) ||
    (record.pending !== undefined &&
      (!plain(record.pending) ||
        typeof record.pending.key !== 'string' ||
        !GOAL_STEP_KEY.test(record.pending.key) ||
        !count(record.pending.step) ||
        !count(record.pending.generation))) ||
    (record.running !== undefined &&
      (!plain(record.running) ||
        typeof record.running.key !== 'string' ||
        typeof record.running.boot !== 'string' ||
        !count(record.running.step) ||
        !count(record.running.generation)))
  )
    return undefined
  return record
}

type Indexed = { record: GoalDriveRecord; revision: number; id: string; updatedAt: number }

/** Durable goal step ledger over one MagicAgentEventStore file (MAIN only). */
export class GoalDriveLedger {
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
        kind: GOAL_DRIVE_KIND,
        limit: PAGE,
        ...(after ? { after } : {})
      })
      for (const row of page) {
        // An unreadable record never steps (fail closed); it stays on disk untouched.
        const record = readRecord(row.state, row.id)
        const key = record && logicalKey(record, record.goalId)
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
      kind: GOAL_DRIVE_KIND,
      id,
      idempotencyKey: `thread-goal-drive:${eventId}`,
      ...(operation === 'delete' ? {} : { state }),
      createdAt: at,
      ...(operation === 'create' ? {} : { expectedRevision }),
      event: {
        protocolVersion: '2.0.0',
        id: eventId,
        type: `thread-goal-drive-${operation}`,
        createdAt: at,
        payload: {},
        envelopeKind: 'event',
        streamId: `${GOAL_DRIVE_KIND}:${id}`,
        sequence: operation === 'create' ? 0 : expectedRevision! + 1
      }
    }
  }
  all(): GoalDriveRecord[] {
    return [...this.index.values()].map((entry) => entry.record)
  }
  get(session: GoalDriveSession, goalId: string): GoalDriveRecord | undefined {
    return this.index.get(logicalKey(session, goalId))?.record
  }
  /** Writes the record (durable before it returns). */
  put(record: GoalDriveRecord, at: number): void {
    if (this.unavailable) throw new Error(GOAL_DRIVE_UNAVAILABLE)
    const key = logicalKey(record, record.goalId)
    const entry = this.index.get(key)
    if (!entry) {
      const id = resourceId(record, record.goalId)
      const [result] = this.store.mutateResourcesBatch([this.mutation('create', id, record, at)])
      this.index.set(key, {
        record,
        revision: result.resource.revision,
        id,
        updatedAt: result.resource.updatedAt
      })
      return
    }
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
      // Another writer won: drop the stale copy so nothing steps from it, then report it.
      if (error instanceof ResourceRevisionConflictError) this.index.delete(key)
      throw error
    }
  }
  delete(session: GoalDriveSession, goalId: string, at: number): boolean {
    if (this.unavailable) throw new Error(GOAL_DRIVE_UNAVAILABLE)
    const key = logicalKey(session, goalId)
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

export type GoalDriveLedgerOpener = {
  open(create: boolean): GoalDriveLedger | undefined
  close(): void
}

/** Resolves the file only on first use (production passes the data-directory path lazily). */
export function lazyGoalDriveLedgerOpener(file: () => string): GoalDriveLedgerOpener {
  let opener: GoalDriveLedgerOpener | undefined
  return {
    open: (create) => (opener ??= goalDriveLedgerOpener(file())).open(create),
    close: () => opener?.close()
  }
}

/** Opens the ledger file on first use; a failure is remembered for RETRY_MS and logged once. */
export function goalDriveLedgerOpener(file: string): GoalDriveLedgerOpener {
  let ledger: GoalDriveLedger | undefined,
    failure: unknown,
    retryAt = 0,
    logged: string | undefined
  return {
    open(create) {
      if (ledger) return ledger
      if (performance.now() < retryAt) throw failure
      if (file !== ':memory:' && !create && !existsSync(file)) return undefined
      try {
        if (file !== ':memory:') {
          if (activeInstanceLeasePids(file).some((pid) => pid !== process.pid))
            throw new Error(GOAL_DRIVE_UNAVAILABLE)
          mkdirSync(dirname(file), { recursive: true })
        }
        const db = new MagicAgentEventStore(file)
        let opened: GoalDriveLedger
        try {
          opened = new GoalDriveLedger(db)
        } catch (error) {
          db.close()
          throw error
        }
        if (opened.unavailable) {
          opened.close()
          throw new Error(GOAL_DRIVE_UNAVAILABLE)
        }
        ledger = opened
        logged = undefined
        return ledger
      } catch (error) {
        failure = error
        const detail = String(error instanceof Error ? error.message : error).slice(0, 300)
        if (detail !== logged) {
          logged = detail
          console.warn('[GoalDrive] The goal step file is not served for now.', detail)
        }
        retryAt = performance.now() + RETRY_MS
        throw error
      }
    },
    close() {
      const opened = ledger
      ledger = undefined
      opened?.close()
    }
  }
}

/** The goal store operations the driver uses (MAIN's encrypted goal records). */
export type GoalStorePort = {
  read(scope: AgentThreadInteractionScope): AgentGoalCollection
  mutateModel(
    scope: AgentThreadInteractionScope,
    request: AgentModelGoalMutation,
    binding: { goalId: string; generation: number },
    now?: number
  ): AgentGoalCollection
  mutateSystem(
    scope: AgentThreadInteractionScope,
    request: AgentSystemGoalMutation,
    now?: number
  ): AgentGoalCollection
}

/** What the driver needs from the thread inbox (MAIN only). */
export type GoalInboxPort = {
  enqueue(input: {
    route: AgentRouteLike
    storageScope: string
    conversationId: string
    type: 'drive_ready'
    source: string
    text: string
    idempotencyKey: string
  }): { id: string; duplicate: boolean }
  isPending(input: GoalDriveSession & { route: AgentRouteLike }, idempotencyKey: string): boolean
  isOpen(storageScope: string, routeKey: string): boolean
  isSessionHeld(input: GoalDriveSession & { route: AgentRouteLike }): boolean
  withdraw(
    input: GoalDriveSession & { route: AgentRouteLike },
    idempotencyKey: string,
    reason?: string
  ): boolean
}

/** The first exhausted budget (KT budget_block_reason order: turns, tool calls, walltime). */
export function exhaustedBudget(
  record: Pick<GoalDriveRecord, 'turnsUsed' | 'toolCallsUsed' | 'walltimeUsedMs'>,
  goal: Pick<AgentGoal, 'spec'>
): { budget: NonNullable<AgentGoalDriveUsage['exhausted']>; detail: string } | undefined {
  const { maxTurns, maxToolCalls, maxWalltimeSeconds } = goal.spec.budgets
  if (record.turnsUsed >= maxTurns)
    return { budget: 'turns', detail: `turn budget exhausted (${record.turnsUsed}/${maxTurns})` }
  if (record.toolCallsUsed >= maxToolCalls)
    return {
      budget: 'toolCalls',
      detail: `tool-call budget exhausted (${record.toolCallsUsed}/${maxToolCalls})`
    }
  if (record.walltimeUsedMs >= maxWalltimeSeconds * 1000)
    return {
      budget: 'walltime',
      detail: `walltime budget exhausted (${Math.floor(record.walltimeUsedMs / 1000)}s/${maxWalltimeSeconds}s)`
    }
  return undefined
}

/** KT drive retry backoff for the n-th consecutive failure (1-based), with jitter. */
export function goalStepBackoffMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(
    GOAL_DRIVE_BACKOFF.maxMs,
    GOAL_DRIVE_BACKOFF.initialMs * 2 ** Math.max(0, failures - 1)
  )
  return Math.round(base * (1 + GOAL_DRIVE_BACKOFF.jitter * (2 * random() - 1)))
}

const selfAdvancing = (goal: AgentGoal | undefined): goal is AgentGoal =>
  Boolean(goal && goal.status === 'active' && goal.spec.autonomy === 'continue_when_ready')

/**
 * The step's event text: KT's goal projection (goal.py project_event and the goal plugin prompt),
 * plus this step's budget standing.
 */
export function goalStepText(goal: AgentGoal, record: GoalDriveRecord, step: number): string {
  const { maxTurns, maxToolCalls, maxWalltimeSeconds } = goal.spec.budgets
  const lines = [`Goal ID: ${goal.id}`, `Goal objective: ${goal.spec.objective.slice(0, 240)}`]
  if (goal.spec.successCriteria.length) {
    lines.push('Success criteria:')
    for (const criterion of goal.spec.successCriteria.slice(0, 6))
      lines.push(`- ${criterion.slice(0, 200)}`)
  }
  if (goal.spec.constraints.length) {
    lines.push('Constraints:')
    for (const constraint of goal.spec.constraints.slice(0, 6))
      lines.push(`- ${constraint.slice(0, 200)}`)
  }
  lines.push(
    'Act on this objective directly with your normal tools. The current objective and Goal ID are already provided here; do not call drive_status merely to rediscover them. Use Drive tools only when reporting progress, proposing completion, or when missing details actually block the work. Propose completion with evidence; do not assert it.',
    "Pursue the stated objective as a continuing commitment; never invent a new objective. Inspect the current world before repeating any side effect. Obey the goal's budgets: exhausting a budget stops continuation without completing the goal, and only the user can raise it.",
    `Step ${step} of ${maxTurns} (max turns). Tool calls used ${record.toolCallsUsed} of ${maxToolCalls}; time used ${Math.floor(record.walltimeUsedMs / 1000)} s of ${maxWalltimeSeconds} s.`
  )
  return lines.join('\n').slice(0, 4000)
}

export type GoalStepEnd =
  | { kind: 'success' }
  | { kind: 'error'; error: unknown }
  /** The turn's signal was aborted; its reason tells a user stop from a budget stop. */
  | { kind: 'aborted'; reason: unknown }

/** One admitted goal step turn (MAIN only). */
export type GoalStep = {
  readonly goalId: string
  readonly generation: number
  readonly step: number
  /** drive_status / drive_report / drive_transition bound to this goal (no other goal, no lifecycle). */
  readonly provider: AssistantRunToolProvider
  /** Before each model tool call of the turn: charges it, or refuses it past the budget. */
  chargeToolCall(tool: string): void
  /** Arms the walltime stop: abort is the turn's abort (its signal stops every path). */
  start(abort: (reason: Error) => void): void
  /** Exactly once, when the turn ends (success, error or abort). */
  settle(end: GoalStepEnd): Promise<void>
}

export function isUserCancellationReason(reason: unknown): boolean {
  return reason instanceof Error && reason.message === USER_CANCELLATION
}

/** How a step turn ended, from its abort signal, its success and its failure (MAIN wiring). */
export function goalStepEnd(
  signal: AbortSignal | undefined,
  successful: boolean,
  failure: unknown
): GoalStepEnd {
  if (signal?.aborted) return { kind: 'aborted', reason: signal.reason }
  return successful ? { kind: 'success' } : { kind: 'error', error: failure }
}

const toolSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required
})
const toolText = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength })
const evidenceSchema = { type: 'array', maxItems: 6, items: toolText(512) }
/** KT self-service drive tools, narrowed to one bound goal: no create, edit, wake or lifecycle. */
export const GOAL_STEP_TOOLS: ReturnType<AssistantRunToolProvider['listTools']> = [
  {
    name: 'drive_status',
    description:
      "Read this goal step's goal: objective, success criteria, status, the latest progress report, and how much of each budget is used. The objective and Goal ID are already in the goal event; call this only when you need the current state.",
    inputSchema: toolSchema({}, [])
  },
  {
    name: 'drive_report',
    description:
      "Record material progress (or what blocks the work) on this step's goal, with evidence references. Text is not verified proof and grants no permission. Does not change the goal's status, autonomy or budgets.",
    inputSchema: toolSchema({ summary: toolText(2000), evidence: evidenceSchema }, ['summary'])
  },
  {
    name: 'drive_transition',
    description:
      "Propose completed or failed for this step's goal, with evidence; do not assert completion. What happens follows the goal's completion policy, which only the user sets: user_confirm waits for the user's confirmation, self_propose accepts the proposal, verifier accepts it when it carries evidence. Cannot pause, resume, wake, create or edit a goal, or change its autonomy or budgets.",
    inputSchema: toolSchema(
      {
        status: { enum: ['completed', 'failed'] },
        summary: toolText(2000),
        evidence: { ...evidenceSchema, minItems: 1 }
      },
      ['status', 'summary', 'evidence']
    )
  }
]

function validToolArgs(name: string, args: Record<string, unknown>): boolean {
  if (!plain(args)) return false
  const allowed =
    name === 'drive_status'
      ? []
      : name === 'drive_report'
        ? ['summary', 'evidence']
        : ['status', 'summary', 'evidence']
  if (Object.keys(args).some((key) => !allowed.includes(key))) return false
  if (name === 'drive_status') return true
  const text = (value: unknown, max: number) =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !value.includes('\0')
  const evidence = args.evidence ?? []
  if (!Array.isArray(evidence) || evidence.length > 6 || !evidence.every((item) => text(item, 512)))
    return false
  if (!text(args.summary, 2000)) return false
  if (name === 'drive_transition')
    return (args.status === 'completed' || args.status === 'failed') && evidence.length >= 1
  return true
}

/**
 * MAIN goal driver: queues one step at a time for each self-advancing goal of an open project's
 * session, binds the admitted step turn, and enforces its budgets.
 */
export class AgentThreadGoalDriver {
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private ticking: Promise<string[]> | undefined
  /** Running step keys of this process. */
  private readonly live = new Set<string>()
  constructor(
    private readonly options: {
      /** Production: data/thread-goal-drive/drive.sqlite, opened on first use. */
      ledger: GoalDriveLedgerOpener
      goals: () => Promise<GoalStorePort>
      inbox: GoalInboxPort
      now?: () => number
      random?: () => number
      /** Tests drive tick() themselves. */
      schedule?: boolean
    }
  ) {}
  private now(): number {
    return (this.options.now ?? Date.now)()
  }
  private ledger(create: boolean): GoalDriveLedger | undefined {
    try {
      return this.options.ledger.open(create)
    } catch {
      return undefined
    }
  }

  /**
   * After the user's own list or change of a session's goals: a self-advancing goal gets a ledger
   * row (the driver's index of sessions); a deleted goal loses its row and any queued step.
   */
  sync(
    route: AgentRouteLike | undefined,
    conversationId: string | undefined,
    goals: AgentGoal[]
  ): void {
    const session = goalDriveSessionOf(route, conversationId)
    if (!session) return
    const wanted = goals.some((goal) => selfAdvancing(goal))
    const ledger = this.ledger(wanted)
    if (!ledger) return
    const now = this.now()
    for (const record of ledger.all().filter((entry) => sameSession(entry, session)))
      if (!goals.some((goal) => goal.id === record.goalId)) {
        if (record.pending) this.options.inbox.withdraw(record, record.pending.key, 'goal-removed')
        ledger.delete(record, record.goalId, now)
      }
    for (const goal of goals)
      if (selfAdvancing(goal) && !ledger.get(session, goal.id))
        ledger.put(
          {
            v: 1,
            ...session,
            goalId: goal.id,
            turnsUsed: 0,
            toolCallsUsed: 0,
            walltimeUsedMs: 0,
            step: 0,
            failures: 0,
            nextAttemptAt: 0
          },
          now
        )
    if (wanted) this.nudge()
  }

  /** Budget use of a session's measured goals, for the /goal panel (read-only). */
  usage(
    route: AgentRouteLike | undefined,
    conversationId: string | undefined,
    goals: AgentGoal[]
  ): Record<string, AgentGoalDriveUsage> | undefined {
    const session = goalDriveSessionOf(route, conversationId)
    const ledger = session && this.ledger(false)
    if (!session || !ledger) return undefined
    const result: Record<string, AgentGoalDriveUsage> = {}
    for (const record of ledger.all().filter((entry) => sameSession(entry, session))) {
      const goal = goals.find((item) => item.id === record.goalId)
      if (!goal) continue
      const exhausted = exhaustedBudget(record, goal)
      result[goal.id] = {
        turnsUsed: record.turnsUsed,
        toolCallsUsed: record.toolCallsUsed,
        walltimeUsedSeconds: Math.floor(record.walltimeUsedMs / 1000),
        ...(exhausted ? { exhausted: exhausted.budget } : {}),
        stepPending: Boolean(
          record.pending || (record.running && this.live.has(record.running.key))
        ),
        failures: record.failures
      }
    }
    return Object.keys(result).length ? result : undefined
  }

  /** The session was removed for good: its goal steps are forgotten. Returns how many. */
  removeSession(route: AgentRouteLike, conversationId: string): number {
    const session = goalDriveSessionOf(route, conversationId)
    const ledger = session && this.ledger(false)
    if (!session || !ledger) return 0
    let removed = 0
    for (const record of ledger.all())
      if (record.routeKey === session.routeKey && record.conversationId === session.conversationId)
        if (ledger.delete(record, record.goalId, this.now())) removed++
    return removed
  }

  /** Queues the next step of every ready goal of an open project. Returns the queued event ids. */
  tick(): Promise<string[]> {
    // One pass at a time: a pass awaits the goal store, and two passes must not both queue.
    this.ticking ??= this.pass().finally(() => {
      this.ticking = undefined
    })
    return this.ticking
  }

  private async pass(): Promise<string[]> {
    const ledger = this.ledger(false)
    if (!ledger) return []
    const sessions = new Map<string, GoalDriveRecord[]>()
    for (const record of ledger.all()) {
      const key = logicalKey(record, '')
      sessions.set(key, [...(sessions.get(key) ?? []), record])
    }
    const queued: string[] = []
    let store: GoalStorePort | undefined
    for (const records of sessions.values()) {
      const first = records[0]
      if (!this.options.inbox.isOpen(first.storageScope, first.routeKey)) continue
      try {
        if (this.options.inbox.isSessionHeld(first)) continue
        store ??= await this.options.goals()
      } catch {
        continue
      }
      let collection: AgentGoalCollection
      try {
        collection = store.read({ route: first.route, conversationId: first.conversationId })
      } catch {
        continue
      }
      for (const stale of records) {
        // Re-read: an admitted step may have changed the row while the goal store loaded.
        const record = ledger.get(stale, stale.goalId)
        if (!record) continue
        try {
          const id = this.consider(ledger, record, collection)
          if (id) queued.push(id)
        } catch (error) {
          console.warn(
            '[GoalDrive] A goal step was not queued.',
            String(error instanceof Error ? error.message : error).slice(0, 200)
          )
        }
      }
    }
    return queued
  }

  private consider(
    ledger: GoalDriveLedger,
    record: GoalDriveRecord,
    collection: AgentGoalCollection
  ): string | undefined {
    const now = this.now()
    const goal = collection.goals.find((item) => item.id === record.goalId)
    if (!goal) {
      if (record.pending) this.options.inbox.withdraw(record, record.pending.key, 'goal-removed')
      ledger.delete(record, record.goalId, now)
      return undefined
    }
    if (record.running) {
      if (record.running.boot === BOOT && this.live.has(record.running.key)) return undefined
      // A step of an earlier run of the app (or one whose settle never ran) is over.
      const { running: _running, ...rest } = record
      void _running
      record = rest
      ledger.put(record, now)
    }
    const ready = selfAdvancing(goal) && !goal.proposal && !exhaustedBudget(record, goal)
    if (ready && record.failures && record.failedGeneration !== goal.generation) {
      // The goal changed since its failures (the user resumed or edited it): retries start over.
      const { failedGeneration: _failed, ...rest } = record
      void _failed
      record = { ...rest, failures: 0, nextAttemptAt: 0 }
      ledger.put(record, now)
    }
    if (record.pending) {
      const waiting = this.options.inbox.isPending(record, record.pending.key)
      if (waiting && ready && goal.generation === record.pending.generation) return undefined
      // The goal changed (paused, edited, proposal, budget) or the event is gone: no stale step.
      if (waiting) this.options.inbox.withdraw(record, record.pending.key, 'goal-changed')
      const { pending: _pending, ...rest } = record
      void _pending
      record = rest
      ledger.put(record, now)
    }
    if (!ready || now < record.nextAttemptAt) return undefined
    const step = record.step + 1
    const key = `goal:${goal.id}:${step}`
    const result = this.options.inbox.enqueue({
      route: record.route,
      storageScope: record.storageScope,
      conversationId: record.conversationId,
      type: 'drive_ready',
      source: formatAgentGoalEventSource(
        record.turnsUsed + 1,
        goal.spec.budgets.maxTurns,
        goal.title
      ),
      text: goalStepText(goal, record, record.turnsUsed + 1),
      idempotencyKey: key
    })
    ledger.put({ ...record, step, pending: { key, step, generation: goal.generation } }, now)
    return result.id
  }

  /**
   * The admitted drive_ready turn becomes this step: the goal is read again (still active,
   * continue_when_ready, the same generation, no proposal, budget left) and the turn is charged
   * (durable) before anything else runs. Anything else is refused: no ordinary fallback.
   */
  async bindStep(
    req: { route?: AgentRouteLike; conversationId?: string },
    admitted: { type: string; idempotencyKey?: string; storageScope: string }
  ): Promise<GoalStep> {
    const session = goalDriveSessionOf(req.route, req.conversationId)
    const key = admitted.idempotencyKey
    if (
      admitted.type !== 'drive_ready' ||
      !session ||
      session.storageScope !== admitted.storageScope ||
      typeof key !== 'string' ||
      !GOAL_STEP_KEY.test(key)
    )
      throw new Error(GOAL_STEP_UNAVAILABLE)
    const goalId = key.split(':')[1]
    const store = await this.options.goals()
    const ledger = this.ledger(false)
    const record = ledger?.get(session, goalId)
    if (!ledger || !record?.pending || record.pending.key !== key || record.running)
      throw new Error(GOAL_STEP_UNAVAILABLE)
    const scope = { route: session.route, conversationId: session.conversationId }
    const goal = store.read(scope).goals.find((item) => item.id === goalId)
    if (
      !selfAdvancing(goal) ||
      goal.proposal ||
      goal.generation !== record.pending.generation ||
      exhaustedBudget(record, goal)
    ) {
      const { pending: _pending, ...rest } = record
      void _pending
      ledger.put(rest, this.now())
      throw new Error(GOAL_STEP_UNAVAILABLE)
    }
    const { pending, ...rest } = record
    const charged: GoalDriveRecord = {
      ...rest,
      turnsUsed: record.turnsUsed + 1,
      running: { key, step: pending.step, generation: goal.generation, boot: BOOT }
    }
    ledger.put(charged, this.now())
    this.live.add(key)
    return this.createStep(ledger, store, session, goal, charged)
  }

  private createStep(
    ledger: GoalDriveLedger,
    store: GoalStorePort,
    session: GoalDriveSession & { route: AgentRouteLike },
    goal: AgentGoal,
    bound: GoalDriveRecord
  ): GoalStep {
    const key = bound.running!.key
    const scope = { route: session.route, conversationId: session.conversationId }
    let chargedAt = this.now()
    let walltimeTimer: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let abort: ((reason: Error) => void) | undefined
    let budgetStop: GoalBudgetExhausted | undefined
    let settled = false
    const current = (): GoalDriveRecord => {
      const record = ledger.get(session, goal.id)
      if (!record || record.running?.key !== key) throw new Error(GOAL_STEP_UNAVAILABLE)
      return record
    }
    /** Charges the walltime since the last charge (durable). */
    const chargeElapsed = (): GoalDriveRecord => {
      const record = current()
      const now = this.now()
      const elapsed = Math.max(0, now - chargedAt)
      chargedAt = now
      if (!elapsed) return record
      const next = { ...record, walltimeUsedMs: record.walltimeUsedMs + elapsed }
      ledger.put(next, now)
      return next
    }
    const stop = (exhausted: { budget: GoalBudgetExhausted['budget']; detail: string }): never => {
      budgetStop ??= new GoalBudgetExhausted(exhausted.budget, exhausted.detail)
      abort?.(budgetStop)
      throw budgetStop
    }
    const provider: AssistantRunToolProvider = {
      listTools: () => structuredClone(GOAL_STEP_TOOLS),
      callTool: async (name, args, context) => {
        context.signal?.throwIfAborted()
        if (!GOAL_STEP_TOOLS.some((tool) => tool.name === name) || !validToolArgs(name, args))
          throw new Error(`Invalid ${name} arguments.`)
        if (getAgentSessionKey(context.route) !== session.routeKey)
          throw new Error('Goal tools belong to their own session.')
        const collection = store.read(scope)
        const live = collection.goals.find((item) => item.id === goal.id)
        if (!live) throw new Error('The goal no longer exists.')
        if (name === 'drive_status') {
          const record = ledger.get(session, goal.id) ?? bound
          const { maxTurns, maxToolCalls, maxWalltimeSeconds } = live.spec.budgets
          return {
            content: JSON.stringify({
              goalId: live.id,
              title: live.title,
              status: live.status,
              objective: live.spec.objective,
              successCriteria: live.spec.successCriteria,
              constraints: live.spec.constraints,
              completionPolicy: live.spec.completionPolicy,
              ...(live.progress ? { progress: live.progress } : {}),
              ...(live.proposal ? { proposal: live.proposal } : {}),
              budgets: {
                turns: { used: record.turnsUsed, max: maxTurns },
                toolCalls: { used: record.toolCallsUsed, max: maxToolCalls },
                walltimeSeconds: {
                  used: Math.floor(record.walltimeUsedMs / 1000),
                  max: maxWalltimeSeconds
                }
              },
              untrustedData: true
            }),
            metadata: { source: 'goal-step' }
          }
        }
        const summary = (args.summary as string).trim()
        const evidence = ((args.evidence as string[] | undefined) ?? []).map((item) => item.trim())
        const next = store.mutateModel(
          scope,
          name === 'drive_report'
            ? {
                action: 'report',
                goalId: goal.id,
                expectedGeneration: goal.generation,
                expectedRevision: collection.revision,
                operationId: randomUUID(),
                summary,
                evidence
              }
            : {
                action: 'propose',
                goalId: goal.id,
                expectedGeneration: goal.generation,
                expectedRevision: collection.revision,
                operationId: randomUUID(),
                outcome: args.status as 'completed' | 'failed',
                summary,
                evidence
              },
          { goalId: goal.id, generation: goal.generation },
          this.now()
        )
        const after = next.goals.find((item) => item.id === goal.id)
        const content =
          name === 'drive_report'
            ? 'Progress recorded.'
            : after && (after.status === 'completed' || after.status === 'failed')
              ? `The goal is now ${after.status} (${after.spec.completionPolicy} policy accepted the proposal).`
              : 'Proposal recorded; it waits for the user to confirm or reject it. Self-advancing steps pause until then.'
        return { content, metadata: { source: 'goal-step' } }
      }
    }
    return {
      goalId: goal.id,
      generation: goal.generation,
      step: bound.running!.step,
      provider,
      chargeToolCall: (tool: string) => {
        void tool
        if (settled) throw new Error(GOAL_STEP_UNAVAILABLE)
        if (budgetStop) throw budgetStop
        const record = chargeElapsed()
        const exhausted = exhaustedBudget({ ...record, turnsUsed: 0 }, goal)
        if (exhausted) stop(exhausted)
        ledger.put({ ...record, toolCallsUsed: record.toolCallsUsed + 1 }, this.now())
      },
      start: (stopTurn) => {
        abort = stopTurn
        const record = current()
        const remaining = goal.spec.budgets.maxWalltimeSeconds * 1000 - record.walltimeUsedMs
        const onTimeout = () => {
          try {
            const charged = chargeElapsed()
            stop(
              exhaustedBudget({ ...charged, turnsUsed: 0, toolCallsUsed: 0 }, goal) ?? {
                budget: 'walltime',
                detail: `walltime budget exhausted (${goal.spec.budgets.maxWalltimeSeconds}s)`
              }
            )
          } catch {
            /* stop() throws after aborting the turn. */
          }
        }
        walltimeTimer = setTimeout(onTimeout, Math.max(0, remaining))
        heartbeat = setInterval(() => {
          try {
            chargeElapsed()
          } catch {
            /* The settle charges the rest. */
          }
        }, GOAL_DRIVE_HEARTBEAT_MS)
        walltimeTimer.unref?.()
        heartbeat.unref?.()
      },
      settle: async (end) => {
        if (settled) return
        settled = true
        if (walltimeTimer) clearTimeout(walltimeTimer)
        if (heartbeat) clearInterval(heartbeat)
        this.live.delete(key)
        let record: GoalDriveRecord
        try {
          record = chargeElapsed()
        } catch {
          return
        }
        const now = this.now()
        const { running: _running, ...rest } = record
        void _running
        const reason = end.kind === 'aborted' ? end.reason : undefined
        const budget = budgetStop ?? (reason instanceof GoalBudgetExhausted ? reason : undefined)
        let next: GoalDriveRecord = rest
        let system: AgentSystemGoalMutation | undefined
        if (end.kind === 'success' || budget) {
          const { failedGeneration: _failed, ...clean } = rest
          void _failed
          next = { ...clean, failures: 0, nextAttemptAt: 0 }
        } else if (end.kind === 'aborted' && isUserCancellationReason(reason))
          // KT: stop means stop. The goal is paused; only the user resumes it.
          system = {
            action: 'control',
            goalId: goal.id,
            expectedGeneration: goal.generation,
            expectedRevision: 0,
            operationId: randomUUID(),
            status: 'paused',
            reason: 'The user stopped a goal step.'
          }
        else if (end.kind === 'error') {
          const failures = rest.failures + 1
          next = {
            ...rest,
            failures,
            failedGeneration: goal.generation,
            nextAttemptAt: now + goalStepBackoffMs(failures, this.options.random)
          }
          if (failures >= AGENT_GOAL_DRIVE_MAX_FAILURES)
            system = {
              action: 'control',
              goalId: goal.id,
              expectedGeneration: goal.generation,
              expectedRevision: 0,
              operationId: randomUUID(),
              status: 'blocked',
              reason: `Goal steps failed ${failures} times in a row.`
            }
        }
        // Any other abort (the window closed, the document ended) is neither a failure nor a stop.
        ledger.put(next, now)
        if (system) {
          try {
            const collection = store.read(scope)
            const live = collection.goals.find((item) => item.id === goal.id)
            if (live?.status === 'active' && live.generation === goal.generation)
              store.mutateSystem(scope, { ...system, expectedRevision: collection.revision }, now)
          } catch (error) {
            console.warn(
              '[GoalDrive] The goal was not paused or blocked.',
              String(error instanceof Error ? error.message : error).slice(0, 200)
            )
          }
        }
        this.nudge()
      }
    }
  }

  /** Starts the scheduler, or looks now if it runs (a pane opened). */
  start(): void {
    this.options.schedule = true
    this.arm(0)
  }
  /** Something changed: look soon instead of at the next tick. */
  nudge(): void {
    this.arm(0)
  }
  private arm(delay: number): void {
    if (this.disposed || !this.options.schedule) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
        .catch(() => undefined)
        .finally(() => this.arm(this.untilNext()))
    }, delay)
    this.timer.unref?.()
  }
  private untilNext(): number {
    const ledger = this.ledger(false)
    const now = this.now()
    const soonest = Math.min(
      ...(ledger
        ?.all()
        .map((record) =>
          record.nextAttemptAt > now ? record.nextAttemptAt : now + GOAL_DRIVE_TICK_MS
        ) ?? []),
      now + GOAL_DRIVE_TICK_MS
    )
    return Math.min(GOAL_DRIVE_TICK_MS, Math.max(1000, soonest - now))
  }
  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.options.ledger.close()
  }
}
