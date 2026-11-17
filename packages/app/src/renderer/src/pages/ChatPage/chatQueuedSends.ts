// The in-memory send queue of a chat session: which items carry user-authored content, how a
// Stop settles the queue, which item a drain may send next, and the per-lease token that keeps
// a late callback of an earlier lease from acting. Pure functions; ChatPage owns the state.

/** The fields of a queued send that these rules read. */
export type QueuedSendState = {
  id: number
  queueKey?: string
  /** This item originated from this session's ordinary composer, including a lead summary. */
  fromComposer?: boolean
  /** Requires explicit user action (Stop, failed preparation, the owning scope was left). */
  paused?: boolean
  /** A local item is being prepared and cannot be edited or removed. */
  inFlight?: boolean
  /** The next queued item may resume when this failed item is explicitly removed. */
  blocksFollowing?: boolean
  /** Token of the current lease; a late callback of an earlier lease never matches it. */
  leaseId?: number
  /** Kept back by a manual Stop until the user's own send to this session is accepted. */
  heldByStop?: number
  overrides?: {
    composerSubmission?: boolean
    onTeamRequestStarted?: unknown
    onTaskCompleted?: unknown
    resolveAttachments?: unknown
  }
}

/**
 * A queued item that carries user-authored content (the composer, an edit, a send-to-agent
 * without lazily resolved attachments). Team-internal work (channel messages, task dispatches,
 * auto-sends that resolve attachments) has its own delivery state and is never paused or held.
 */
export const isUserQueuedSend = (item: QueuedSendState): boolean =>
  Boolean(item.overrides) &&
  Boolean(
    item.fromComposer ||
    item.overrides?.composerSubmission ||
    (!item.queueKey &&
      !item.overrides?.onTeamRequestStarted &&
      !item.overrides?.onTaskCompleted &&
      !item.overrides?.resolveAttachments)
  )

/** Paused: not in flight, no lease, sent only after an explicit user action. */
export const pauseQueuedSend = <T extends QueuedSendState>(item: T): T => {
  const { leaseId: _lease, heldByStop: _held, ...rest } = item
  return { ...rest, paused: true, inFlight: false, blocksFollowing: false } as T
}

/** The item without its lease: a late callback of that lease no longer matches it. */
export const withoutLease = <T extends QueuedSendState>(item: T): T => {
  const { leaseId: _lease, ...rest } = item
  return { ...rest, inFlight: false } as T
}

/**
 * How a stop settles a session's queue. Team-internal items are dropped by every kind of stop.
 * - 'terminate' (explicit session or scope termination, deletion): everything is dropped.
 * - 'member' (a member stop, from the lead or the member list): every unaccepted user item is
 *   kept, paused.
 * - 'manual' (Stop): the first user item is paused and the other user items are held with
 *   stopEpoch; Stop never sends the next item by itself.
 * Every kept item loses its lease token.
 */
export const settleQueueOnStop = <T extends QueuedSendState>(
  queue: readonly T[],
  mode: 'terminate' | 'member' | 'manual',
  stopEpoch: number
): { kept: T[]; dropped: T[] } => {
  const kept: T[] = []
  const dropped: T[] = []
  for (const item of queue) {
    if (mode === 'terminate' || !isUserQueuedSend(item)) {
      dropped.push(item)
      continue
    }
    if (mode === 'member' || kept.length === 0 || item.paused) kept.push(pauseQueuedSend(item))
    else kept.push({ ...withoutLease(item), heldByStop: stopEpoch })
  }
  return { kept, dropped }
}

/**
 * The item a drain may start next, or undefined. Held items keep their place but are never
 * sent by a drain; a paused or in-flight item blocks everything behind it.
 */
export const nextDrainableSend = <T extends QueuedSendState>(
  queue: readonly T[] | undefined
): T | undefined => {
  const next = queue?.find((item) => !item.heldByStop)
  return next && !next.paused && !next.inFlight ? next : undefined
}

/** The queue with the given item leased under a fresh token. */
export const leaseQueuedSend = <T extends QueuedSendState>(
  queue: readonly T[],
  id: number,
  leaseId: number
): T[] => queue.map((item) => (item.id === id ? { ...item, inFlight: true, leaseId } : item))

/** True only while this exact lease (item and token) is still the one in flight. */
export const isQueuedSendLeaseCurrent = (
  queue: readonly QueuedSendState[] | undefined,
  id: number,
  leaseId: number
): boolean =>
  Boolean(queue?.some((item) => item.id === id && item.inFlight && item.leaseId === leaseId))

/** The queue without stop holds, or the same array when nothing is held. */
export const releaseStopHolds = <T extends QueuedSendState>(queue: readonly T[]): readonly T[] =>
  queue.some((item) => item.heldByStop)
    ? queue.map((item) => {
        if (!item.heldByStop) return item
        const { heldByStop: _held, ...rest } = item
        return rest as T
      })
    : queue

/** The first item a drain looks at (the first one not held back), or undefined. */
export const queuedSendDrainHead = <T extends QueuedSendState>(
  queue: readonly T[] | undefined
): T | undefined => queue?.find((item) => !item.heldByStop)

/**
 * The item the newer ones wait behind, or undefined: the first item a drain looks at, paused,
 * with nothing held before it, followed directly by an item a drain could send (neither held,
 * paused nor being prepared). Removing it lets that item go (the removal drains), and saving an
 * edit of it sends it first (nothing before it waits for the person), so both actions resume
 * the ones after it.
 */
export const queuedSendBlockingNewer = <T extends QueuedSendState>(
  queue: readonly T[] | undefined
): T | undefined => {
  const items = queue ?? []
  const head = items[0]
  if (!head || head.heldByStop || !head.paused || head.inFlight) return undefined
  const next = items.slice(1).find((item) => !item.heldByStop)
  return next && !next.paused && !next.inFlight ? head : undefined
}

/**
 * True when an item a drain could send (neither held, paused nor being prepared) waits behind a
 * paused item that is not held. A direct send of the composer on the idle conversation would
 * overtake it, so the composer asks the person to deal with the paused item first.
 */
export const queuedSendWaitsBehindPause = (
  queue: readonly QueuedSendState[] | undefined
): boolean => {
  let pausedAhead = false
  for (const item of queue ?? []) {
    if (item.heldByStop) continue
    if (item.paused) pausedAhead = true
    else if (pausedAhead && !item.inFlight) return true
  }
  return false
}

/**
 * Saving an edit of a queued item resumes it (its Stop hold and pause are lifted) only when
 * nothing before it still waits for the person's action (held by a Stop or a reload, or paused).
 * Otherwise only its text changes: lifting its flags would send it ahead of those items.
 */
export const queuedEditResumes = (
  queue: readonly QueuedSendState[] | undefined,
  id: number
): boolean => {
  const items = queue ?? []
  const index = items.findIndex((item) => item.id === id)
  return index >= 0 && !items.slice(0, index).some((item) => item.heldByStop || item.paused)
}

/**
 * The rows a collapsed queue view shows: the last three, and the item the newer ones wait
 * behind when it is not among them.
 */
export const collapsedQueuedSendIds = <T extends QueuedSendState>(
  queue: readonly T[] | undefined,
  size = 3
): Set<number> => {
  const items = queue ?? []
  const ids = new Set(items.slice(-size).map((item) => item.id))
  const blocking = queuedSendBlockingNewer(items)
  if (blocking) ids.add(blocking.id)
  return ids
}
