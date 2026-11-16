// A Canvas Target run computes each semantic canvas action against its own
// view of the board, but the user can keep working on the canvas while the
// run is in progress (for example while the confirmation prompt is open).
// These helpers keep the run's commits from overwriting that work:
//
// - rebaseCanvasTargetRunView makes the run's view the live board before
//   each action: every entry takes its live value (the user's moves, edits
//   and group changes included), entries that are gone from the live board
//   are dropped, and what the user added is taken in. So the write
//   authority, the executor and the merge base all see the current board.
//   Only the run's own writes the live list has not rendered yet keep the
//   run's value, and entries the run removed stay removed.
// - mergeCanvasTargetRunChange applies only what one action changed (its
//   view before -> its result) to the live state, as a functional update.
//   Whatever the run did not change keeps its live value.

type Identified = { id: string }

function isSameFieldValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/**
 * The run's view rebased on the live list: live order and live values, minus
 * the entries the run removed itself (a live list that has not caught up
 * with the run's own delete must not bring them back). An entry in
 * `keepFromView` is a write of the run the live list has not rendered yet:
 * it keeps the run's value, and stays in the view while the live list does
 * not hold it yet. Every other view entry that is no longer live is dropped.
 * Returns `view` itself when the result holds the same entries.
 */
export function rebaseCanvasTargetRunView<T extends Identified>(
  view: T[],
  live: readonly T[] | undefined,
  options: { removedByRun: ReadonlySet<string>; keepFromView: ReadonlySet<string> }
): T[] {
  if (!live || live === view) return view
  const { removedByRun, keepFromView } = options
  const viewById = new Map(view.map((entry) => [entry.id, entry] as const))
  const next: T[] = []
  const nextIds = new Set<string>()
  for (const entry of live) {
    if (removedByRun.has(entry.id) || nextIds.has(entry.id)) continue
    const viewEntry = viewById.get(entry.id)
    next.push(viewEntry && keepFromView.has(entry.id) ? viewEntry : entry)
    nextIds.add(entry.id)
  }
  for (const entry of view) {
    if (nextIds.has(entry.id) || removedByRun.has(entry.id) || !keepFromView.has(entry.id)) continue
    next.push(entry)
    nextIds.add(entry.id)
  }
  const unchanged = next.length === view.length && next.every((entry, index) => entry === view[index])
  return unchanged ? view : next
}

function mergeChangedFields<T extends Identified>(live: T, before: T, after: T): T {
  if (live === before) return after
  const merged: Record<string, unknown> = { ...(live as Record<string, unknown>) }
  const beforeFields = before as Record<string, unknown>
  const afterFields = after as Record<string, unknown>
  const keys = new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])
  for (const key of keys) {
    if (isSameFieldValue(beforeFields[key], afterFields[key])) continue
    if (key in afterFields) merged[key] = afterFields[key]
    else delete merged[key]
  }
  return merged as T
}

function hasChangedFields<T extends Identified>(before: T, after: T): boolean {
  if (before === after) return false
  const beforeFields = before as Record<string, unknown>
  const afterFields = after as Record<string, unknown>
  const keys = new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])
  for (const key of keys) {
    if (!isSameFieldValue(beforeFields[key], afterFields[key])) return true
  }
  return false
}

/**
 * Applies one run action's change (before -> after, both in the run's view)
 * to the live list. Entries the action removed are removed, entries it added
 * are appended, and for entries it changed only the changed fields are
 * written, onto the live entry. Live entries the action did not touch stay as
 * they are; an entry the action changed that is no longer live is not brought
 * back. Returns `live` itself when nothing changes.
 */
export function mergeCanvasTargetRunChange<T extends Identified>(
  live: T[],
  before: readonly T[],
  after: readonly T[]
): T[] {
  if (before === after) return live
  const beforeById = new Map(before.map((entry) => [entry.id, entry] as const))
  const afterById = new Map(after.map((entry) => [entry.id, entry] as const))
  let changed = false
  const next: T[] = []
  for (const entry of live) {
    const beforeEntry = beforeById.get(entry.id)
    const afterEntry = afterById.get(entry.id)
    if (beforeEntry && !afterEntry) {
      changed = true
      continue
    }
    if (beforeEntry && afterEntry && hasChangedFields(beforeEntry, afterEntry)) {
      next.push(mergeChangedFields(entry, beforeEntry, afterEntry))
      changed = true
      continue
    }
    next.push(entry)
  }
  const liveIds = new Set(live.map((entry) => entry.id))
  for (const entry of after) {
    if (beforeById.has(entry.id) || liveIds.has(entry.id)) continue
    next.push(entry)
    changed = true
  }
  return changed ? next : live
}

type CanvasTargetRunPendingRecord = { processedAtRender: number | null }

/**
 * The run's own writes (entries it created or changed) the live list may not
 * show yet. A write is stamped with the canvas render count at which React
 * processed it: the commit's functional update stamps it when it runs, and an
 * item the canvas placed for the run is stamped when the run registers it
 * (the canvas dispatched it before reporting it). A write counts as rendered
 * once a later render has happened; until then the run keeps its own value
 * (rebaseCanvasTargetRunView's keepFromView).
 */
export function createCanvasTargetRunPendingWrites(readRenderCount: () => number) {
  const pending = new Map<string, CanvasTargetRunPendingRecord>()
  return {
    /** Writes a commit is about to apply; stamp the record from its updater. */
    addCommitted(ids: Iterable<string>): CanvasTargetRunPendingRecord {
      const record: CanvasTargetRunPendingRecord = { processedAtRender: null }
      for (const id of ids) pending.set(id, record)
      return record
    },
    /** Items the canvas already placed; a write still pending keeps its record. */
    addPlaced(ids: Iterable<string>): void {
      const record: CanvasTargetRunPendingRecord = { processedAtRender: readRenderCount() }
      for (const id of ids) if (!pending.has(id)) pending.set(id, record)
    },
    stamp(record: CanvasTargetRunPendingRecord): void {
      record.processedAtRender = readRenderCount()
    },
    /** Ids whose write the live list has not rendered yet. */
    unrendered(): Set<string> {
      const now = readRenderCount()
      const ids = new Set<string>()
      for (const [id, record] of pending) {
        if (record.processedAtRender !== null && now > record.processedAtRender) pending.delete(id)
        else ids.add(id)
      }
      return ids
    }
  }
}

/** Ids of the entries one action created or changed (before -> after). */
export function collectCanvasTargetRunWrittenIds<T extends Identified>(
  before: readonly T[],
  after: readonly T[]
): string[] {
  const beforeById = new Map(before.map((entry) => [entry.id, entry] as const))
  return after
    .filter((entry) => {
      const beforeEntry = beforeById.get(entry.id)
      return !beforeEntry || hasChangedFields(beforeEntry, entry)
    })
    .map((entry) => entry.id)
}
