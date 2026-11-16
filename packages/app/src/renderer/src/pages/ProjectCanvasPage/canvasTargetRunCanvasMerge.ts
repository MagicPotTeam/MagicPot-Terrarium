// A Canvas Target run computes each semantic canvas action against its own
// view of the board, but the user can keep working on the canvas while the
// run is in progress (for example while the confirmation prompt is open).
// These helpers keep the run's commits from overwriting that work:
//
// - withLiveOnlyCanvasEntries adds what appeared on the live canvas and the
//   run does not know about to the run's view, so the write authority sees
//   it (an item the user added is neither selected nor run-created, so
//   clear_canvas and all_canvas edits are refused while it is there).
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
 * The run's view plus every entry of the live canvas the view does not hold,
 * except entries the run itself removed (a live list that has not caught up
 * with the run's own delete must not bring the item back).
 */
export function withLiveOnlyCanvasEntries<T extends Identified>(
  view: T[],
  live: readonly T[] | undefined,
  removedByRun: ReadonlySet<string>
): T[] {
  if (!live || live === view || live.length === 0) return view
  const viewIds = new Set(view.map((entry) => entry.id))
  const liveOnly = live.filter((entry) => !viewIds.has(entry.id) && !removedByRun.has(entry.id))
  return liveOnly.length > 0 ? [...view, ...liveOnly] : view
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
