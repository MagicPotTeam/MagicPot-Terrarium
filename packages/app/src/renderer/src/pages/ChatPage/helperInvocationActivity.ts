// Observation only: a helper call can also produce a separate background job. Do not infer equivalence.
export type HelperName = 'explore' | 'critic' | 'fork' | 'response' | 'summarize'
export type HelperStatus = 'running' | 'returned' | 'failed' | 'cancelled' | 'unknown'
export type HelperEvent = { scope: string; sessionId: string; parentRunId: number; runId: string; toolCallId: string; name: HelperName; status: HelperStatus }
export type HelperObservation = HelperEvent & { updatedAt: number }
export type HelperActivityOptions = { now: () => number; ttlMs: number; maxTotal: number; maxPerSession: number }

const names = new Set(['explore', 'critic', 'fork', 'response', 'summarize'])
const statuses = new Set(['running', 'returned', 'failed', 'cancelled', 'unknown'])
const validId = (value: unknown, limit = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
const validRun = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const key = (...parts: (string | number)[]) => JSON.stringify(parts)

/** Explicit lifecycle admission is required; events alone can never activate a parent run. */
export function createHelperInvocationActivity(options: HelperActivityOptions) {
  const { now, ttlMs, maxTotal, maxPerSession } = options
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxTotal) || maxTotal <= 0 || !Number.isSafeInteger(maxPerSession) || maxPerSession <= 0) throw new Error('Invalid activity limits')
  const entries = new Map<string, HelperObservation>()
  // Bounded high-water marks are retained for the lifetime of the store; capacity fails closed.
  const parents = new Map<string, { run: number; active: boolean; time: number }>()
  const timestamp = () => { const value = now(); if (!Number.isFinite(value)) throw new Error('Invalid clock'); return value }
  // TTL is local observation expiry, not evidence the underlying run timed out.
  const prune = (time: number) => {
    for (const [id, parent] of parents) if (parent.active && time - parent.time >= ttlMs) {
      parent.active = false
      for (const item of entries.values()) if (key(item.scope, item.sessionId) === id && item.parentRunId === parent.run && item.status === 'running') { item.status = 'unknown'; item.updatedAt = time }
    }
    for (const [id, item] of entries) if (time - item.updatedAt >= ttlMs) {
      const parent = parents.get(key(item.scope, item.sessionId))
      if (parent?.run === item.parentRunId && parent.active) {
        // Keep bounded, hidden terminal tombstones until parent expiry so late events cannot revive them.
        if (item.status === 'running') { item.status = 'unknown'; item.updatedAt = time }
      } else entries.delete(id)
    }
  }
  const end = (scope: string, sessionId: string, parentRunId: number) => {
    if (!validId(scope, 256) || !validId(sessionId, 256) || !validRun(parentRunId)) return
    const time = timestamp(); prune(time)
    const parent = parents.get(key(scope, sessionId))
    if (!parent || parent.run !== parentRunId || !parent.active) return
    parent.active = false; parent.time = time
    for (const item of entries.values()) if (item.scope === scope && item.sessionId === sessionId && item.parentRunId === parentRunId && item.status === 'running') { item.status = 'unknown'; item.updatedAt = time }
  }
  const begin = (scope: string, sessionId: string, parentRunId: number): boolean => {
    if (!validId(scope, 256) || !validId(sessionId, 256) || !validRun(parentRunId)) return false
    const time = timestamp(); prune(time)
    const id = key(scope, sessionId), previous = parents.get(id)
    if (previous && parentRunId <= previous.run) return false
    if (previous?.active) end(scope, sessionId, previous.run)
    if (!previous && parents.size >= maxTotal) return false
    parents.delete(id); parents.set(id, { run: parentRunId, active: true, time })
    return true
  }
  const observe = (event: HelperEvent): boolean => {
    if (!event || !validId(event.scope, 256) || !validId(event.sessionId, 256) || !validRun(event.parentRunId) || !validId(event.runId) || !validId(event.toolCallId) || !names.has(event.name) || !statuses.has(event.status)) return false
    const time = timestamp(); prune(time)
    const parent = parents.get(key(event.scope, event.sessionId))
    if (!parent?.active || parent.run !== event.parentRunId) return false
    const id = key(event.scope, event.sessionId, event.parentRunId, event.runId, event.toolCallId), previous = entries.get(id)
    if (previous && (previous.name !== event.name || previous.status !== 'running')) return false
    if (!previous && (entries.size >= maxTotal || [...entries.values()].filter(value => value.scope === event.scope && value.sessionId === event.sessionId).length >= maxPerSession)) return false
    const item: HelperObservation = { scope: event.scope, sessionId: event.sessionId, parentRunId: event.parentRunId, runId: event.runId, toolCallId: event.toolCallId, name: event.name, status: event.status, updatedAt: time }
    entries.delete(id); entries.set(id, item); parent.time = time
    return true
  }
  const list = (scope: string, sessionId: string): HelperObservation[] => {
    if (!validId(scope, 256) || !validId(sessionId, 256)) return []
    const time = timestamp(); prune(time)
    return [...entries.values()].filter(item => item.scope === scope && item.sessionId === sessionId && time - item.updatedAt < ttlMs).map(item => ({ ...item }))
  }
  return { begin, end, observe, list }
}
