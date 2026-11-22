import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createHelperInvocationActivity, type HelperName, type HelperObservation, type HelperStatus } from './helperInvocationActivity'

const names = new Set<string>(['explore', 'critic', 'fork', 'response', 'summarize'])
const statuses: Record<string, HelperStatus> = { running: 'running', completed: 'returned', failed: 'failed', cancelled: 'cancelled' }
const TTL = 15 * 60 * 1000

type Store = ReturnType<typeof createHelperInvocationActivity>
type Generation = { scope: string; store: Store; live: boolean; sessions: Set<string>; timer?: ReturnType<typeof setInterval> }
type Snapshot = { generation: Generation; rows: Map<string, HelperObservation[]> }
export type HelperInvocationHandle = { observe(event: unknown): boolean; end(): void }

/** Temporary observation only, never a background job controller or a stop capability. */
export function useHelperInvocationObserver(scope: string) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const generation = useRef<Generation | null>(null)
  const publish = useCallback((current: Generation) => {
    if (!current.live || generation.current !== current) return
    const rows = new Map<string, HelperObservation[]>()
    for (const session of current.sessions) rows.set(session, current.store.list(current.scope, session))
    setSnapshot({ generation: current, rows })
  }, [])

  useLayoutEffect(() => {
    const current: Generation = { scope, store: createHelperInvocationActivity({ now: () => performance.now(), ttlMs: TTL, maxTotal: 128, maxPerSession: 32 }), live: true, sessions: new Set() }
    generation.current = current
    publish(current)
    return () => { current.live = false; if (current.timer) clearInterval(current.timer); if (generation.current === current) generation.current = null }
  }, [scope, publish])

  const begin = useCallback((sessionId: string, parentRunId: number): HelperInvocationHandle | undefined => {
    const current = generation.current
    if (!current?.live || current.scope !== scope || !current.store.begin(current.scope, sessionId, parentRunId)) return undefined
    current.sessions.add(sessionId)
    if (!current.timer) current.timer = setInterval(() => publish(current), 30_000)
    publish(current)
    let ended = false
    const live = () => !ended && current.live && generation.current === current
    return {
      observe(event: unknown) {
        if (!live() || !event || typeof event !== 'object' || Array.isArray(event)) return false
        const raw = event as Record<string, unknown>
        if (raw.type !== 'tool-status' || !raw.toolStatus || typeof raw.toolStatus !== 'object' || Array.isArray(raw.toolStatus)) return false
        const tool = raw.toolStatus as Record<string, unknown>
        if (typeof tool.toolName !== 'string' || !names.has(tool.toolName) || typeof tool.status !== 'string' || !Object.hasOwn(statuses, tool.status) || typeof tool.runId !== 'string' || typeof tool.toolCallId !== 'string') return false
        const accepted = current.store.observe({ scope: current.scope, sessionId, parentRunId, runId: tool.runId, toolCallId: tool.toolCallId, name: tool.toolName as HelperName, status: statuses[tool.status] })
        if (accepted) publish(current)
        return accepted
      },
      end() {
        if (!live()) { ended = true; return }
        ended = true
        current.store.end(current.scope, sessionId, parentRunId)
        publish(current)
      }
    }
  }, [scope, publish])

  const list = useCallback((sessionId: string): HelperObservation[] => {
    if (!snapshot || snapshot.generation.scope !== scope || snapshot.generation !== generation.current || !snapshot.generation.live) return []
    return (snapshot.rows.get(sessionId) ?? []).map(row => ({ ...row }))
  }, [scope, snapshot])
  return { begin, list }
}
