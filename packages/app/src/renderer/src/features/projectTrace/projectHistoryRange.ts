export type ProjectHistoryRange = Readonly<{ startId: string | null; endId: string | null }>

export const ALL_PROJECT_HISTORY: ProjectHistoryRange = Object.freeze({
  startId: null,
  endId: null
})

/** Select within the caller's already-sanitized chronological history, without changing it.
 * Explicit endpoints are stable IDs, not array offsets that drift after retention cleanup.
 * Missing/reversed/ambiguous endpoints fail closed; they never silently widen the selection.
 */
export function selectProjectHistoryRange<T extends { id: string }>(
  events: readonly T[],
  range: ProjectHistoryRange = ALL_PROJECT_HISTORY
): { valid: boolean; events: T[] } {
  const locate = (id: string | null, fallback: number): number => {
    if (id === null) return fallback
    if (typeof id !== 'string' || !id) return -1
    const index = events.findIndex((event) => event.id === id)
    if (index < 0 || events.some((event, i) => i !== index && event.id === id)) return -1
    return index
  }
  if (!events.length) {
    return { valid: range.startId === null && range.endId === null, events: [] }
  }
  const start = locate(range.startId, 0)
  const end = locate(range.endId, events.length - 1)
  if (start < 0 || end < start) return { valid: false, events: [] }
  return { valid: true, events: events.slice(start, end + 1) }
}
