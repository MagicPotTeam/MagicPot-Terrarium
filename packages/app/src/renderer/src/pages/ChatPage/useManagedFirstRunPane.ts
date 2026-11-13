import { useLayoutEffect, useRef, useState } from 'react'
import type { AgentRouteLike } from '@shared/agent'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { ManagedFirstRunPaneScope } from '@shared/api/agentThreadManagedFirstRun'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import { api } from '@renderer/utils/windowUtils'

let lifecycleRevision = 0
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)
type Props = { route?: AgentRouteLike; conversationId?: string; active: boolean; boundaryKey?: string }
type Attempt = { live: boolean; revision?: number }
type Bound = { key: string; boundaryKey?: string; attempt: Attempt; pane: ManagedFirstRunPaneScope }

/** Original-pane identity DATA only. No model call, approval, history or runtime owner.
 * Local retirement is immediate; MAIN retirement is synchronous when its IPC arrives.
 * A token from this hook is not itself permission to execute anything. */
export function useManagedFirstRunPane({ route, conversationId, active, boundaryKey }: Props): ManagedFirstRunPaneScope | undefined {
  const key = active && route?.channel === 'canvas' && route.scopeType === 'thread' && safeId(route.scopeId) && safeId(route.threadId) && safeId(conversationId)
    ? JSON.stringify({ route: { channel: 'canvas', scopeType: 'thread', scopeId: route.scopeId, threadId: route.threadId }, conversationId })
    : undefined
  const current = useRef<Attempt | undefined>(undefined), [bound, setBound] = useState<Bound>()
  useLayoutEffect(() => {
    setBound(undefined)
    if (!key) return
    const scope = JSON.parse(key) as AgentThreadInteractionScope
    let service: Pick<LLMProxySvc, 'managedFirstRunPaneRevision' | 'setManagedFirstRunPaneScope'> | undefined
    try { service = api().svcLLMProxy } catch { /* Missing desktop IPC is not permission. */ }
    let disposed = false, visible = document.visibilityState === 'visible', suspended = false
    const retire = (attempt: Attempt | undefined) => {
      if (!attempt) return
      attempt.live = false
      if (current.current === attempt) setBound(undefined)
      if (attempt.revision === undefined) return
      try { void service?.setManagedFirstRunPaneScope({ ...scope, active: false, lifecycleRevision: attempt.revision }).catch(() => undefined) }
      catch { /* Exact retirement is best-effort if IPC is already gone; no execution fallback. */ }
    }
    const begin = () => {
      if (disposed || !visible || suspended || current.current?.live) return
      const attempt: Attempt = { live: true }; current.current = attempt
      void (async () => {
        if (typeof service?.managedFirstRunPaneRevision !== 'function' || typeof service.setManagedFirstRunPaneScope !== 'function') throw Error('Pane identity IPC unavailable.')
        const status = await service.managedFirstRunPaneRevision(scope)
        if (!attempt.live || disposed) return
        if (!Number.isSafeInteger(status.revision) || status.revision < 0) throw Error('Invalid pane high water.')
        const revision = Math.max(lifecycleRevision, status.revision) + 1
        if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) throw Error('Pane high water exhausted.')
        attempt.revision = lifecycleRevision = revision
        const result = await service.setManagedFirstRunPaneScope({ ...scope, active: true, lifecycleRevision: revision })
        // Cleanup may have reached MAIN before this acknowledgement. Retire again
        // at the SAME revision; never query or choose a higher cleanup revision.
        if (!attempt.live || disposed) { retire(attempt); return }
        if (typeof result.documentToken !== 'string' || !result.documentToken || result.documentToken.length > 200 || result.documentToken.trim() !== result.documentToken) throw Error('Pane identity token unavailable.')
        const pane = Object.freeze({ route: Object.freeze({ ...scope.route }), conversationId: scope.conversationId, documentToken: result.documentToken })
        setBound({ key, boundaryKey, attempt, pane })
      })().catch(() => { retire(attempt) })
    }
    const visibilityChange = () => {
      const next = document.visibilityState === 'visible'
      if (next === visible) return
      visible = next
      if (!visible) retire(current.current)
      else begin()
    }
    const pageHide = () => { suspended = true; retire(current.current) }
    const pageShow = () => { if (suspended) { suspended = false; begin() } }
    document.addEventListener('visibilitychange', visibilityChange)
    window.addEventListener('pagehide', pageHide)
    window.addEventListener('pageshow', pageShow)
    begin()
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', visibilityChange)
      window.removeEventListener('pagehide', pageHide)
      window.removeEventListener('pageshow', pageShow)
      retire(current.current)
    }
  }, [key, boundaryKey])
  return bound && bound.key === key && bound.boundaryKey === boundaryKey && bound.attempt.live && current.current === bound.attempt ? bound.pane : undefined
}
