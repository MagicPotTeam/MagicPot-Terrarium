import { useEffect, useLayoutEffect, useRef } from 'react'
import { normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import type { ChatSession } from './chatStorage'
import { api } from '@renderer/utils/windowUtils'
import { searchAgentSessionArchive } from './agentArchiveSearch'

const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)
type Props = { route?: AgentRouteLike; session?: ChatSession; storageScope: string; active: boolean }

/** Current selected pane only, no second store/index/history IPC. MAIN owns query
 * identity, scope and deadline; this renderer returns bounded untrusted excerpts.
 * No query can name another session or trigger a model turn/history mutation. */
export function useAgentArchiveResponder({ route, session, storageScope, active }: Props): void {
  const scopeKey = active && route?.channel === 'canvas' && route.scopeType === 'thread' && safeId(route.scopeId) && safeId(route.threadId) && safeId(session?.id)
    ? JSON.stringify({ route: normalizeAgentRoute(route), conversationId: session.id }) : undefined
  const current = useRef({ scopeKey, storageScope, session })
  useLayoutEffect(() => { current.current = { scopeKey, storageScope, session } })
  useEffect(() => {
    if (!scopeKey) return
    const scope: AgentThreadInteractionScope = JSON.parse(scopeKey)
    let service: Pick<LLMProxySvc, 'listAgentArchiveQueries' | 'resolveAgentArchiveQuery'>
    try {
      service = api().svcLLMProxy
      if (typeof service?.listAgentArchiveQueries !== 'function' || typeof service.resolveAgentArchiveQuery !== 'function') return
    } catch { return } // An old/missing desktop API is unavailable, never an empty archive success.
    const controller = new AbortController()
    let disposed = false, busy = false, timer: ReturnType<typeof setTimeout> | undefined
    let handled = new Set<string>()
    const live = () => !disposed && !controller.signal.aborted && current.current.scopeKey === scopeKey && current.current.storageScope === storageScope && current.current.session?.id === scope.conversationId
    const tick = async () => {
      if (!live() || busy) return
      busy = true
      try {
        const { queries } = await service.listAgentArchiveQueries(scope)
        if (!live()) return
        // MAIN admits at most one query per sender/scope. Do not retain a growing
        // ID ledger or accept an unbounded renderer-bridge response as work.
        if (!Array.isArray(queries) || queries.length > 1) return
        handled = new Set([...handled].filter(id => queries.some(query => query.id === id)))
        for (const query of queries) {
          if (!live()) return
          if (handled.has(query.id)) continue
          handled.add(query.id)
          const original = current.current.session
          if (!original || original.id !== scope.conversationId || !Array.isArray(original.messages) || original.compactedMessages !== undefined && !Array.isArray(original.compactedMessages)) {
            if (live()) await service.resolveAgentArchiveQuery({ ...scope, queryId: query.id, unavailable: true })
            continue
          }
          try {
            const retained = original.compactedMessages ?? []
            const messages = [...retained, ...original.messages]
            const result = await searchAgentSessionArchive(messages, query.search, controller.signal, query.expiresAt)
            if (!live() || Date.now() >= query.expiresAt - 50) return
            // Session helpers replace arrays on edit/regen/compact. Do not publish
            // a snapshot of a discarded live suffix after an in-scope branch edit.
            if (current.current.session?.messages !== original.messages || current.current.session?.compactedMessages !== original.compactedMessages) {
              await service.resolveAgentArchiveQuery({ ...scope, queryId: query.id, unavailable: true })
              continue
            }
            // Absence of old originals is not disguised as a complete no-match.
            if ((original.contextCompression?.coveredMessageCount ?? 0) > retained.length) result.priorCompactionUnavailable = true
            await service.resolveAgentArchiveQuery({ ...scope, queryId: query.id, result })
          } catch {
            if (!live()) return
            // Stop/scope change never publishes even an unavailable reply into
            // another pane. Scan/expiry/format failure is not "zero matches".
            if (Date.now() < query.expiresAt) await service.resolveAgentArchiveQuery({ ...scope, queryId: query.id, unavailable: true })
          }
        }
      } catch { /* Renderer query IPC denial is not permission or an empty-history receipt. */ }
      finally {
        busy = false
        if (live()) timer = setTimeout(() => { void tick() }, 500)
      }
    }
    void tick()
    return () => { disposed = true; controller.abort(new Error('Archive pane retired.')); if (timer) clearTimeout(timer); handled.clear() }
  }, [scopeKey, storageScope])
}
