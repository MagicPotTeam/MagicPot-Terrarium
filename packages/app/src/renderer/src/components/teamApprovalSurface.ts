import { useSyncExternalStore } from 'react'
import { getAgentSessionKey } from '@shared/agent'
export type TeamApprovalSurface = {
  element: HTMLElement
  route: { channel: string; scopeType: string; scopeId: string; threadId?: string }
  members: ReadonlyMap<string, string>
  onWaiting(ids: ReadonlySet<string>): void
}
let surfaces: readonly TeamApprovalSurface[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
export function registerTeamApprovalSurface(surface: TeamApprovalSurface) {
  surfaces = [...surfaces, surface]
  emit()
  return () => {
    surfaces = surfaces.filter((item) => item !== surface)
    emit()
  }
}
export function useTeamApprovalSurfaces() {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    () => surfaces
  )
}
export function matchTeamApproval(
  request: unknown,
  surface: TeamApprovalSurface
): string | undefined {
  if (!request || typeof request !== 'object') return
  const policy = (request as { request?: unknown }).request
  if (!policy || typeof policy !== 'object') return
  const p = policy as {
    sessionId?: unknown
    route?: Record<string, unknown>
    action?: unknown
    target?: { id?: unknown }
    input?: { conversationId?: unknown }
  }
  if (typeof p.sessionId !== 'string' || !p.route) return
  if (
    !(['channel', 'scopeType', 'scopeId', 'threadId'] as const).every(
      (key) => p.route?.[key] === surface.route[key]
    )
  )
    return
  // Creative image approvals use a route session key; the conversation ID is
  // written by MAIN after tool argument validation (never take it from prompt text).
  if (
    p.action === 'creative.invoke' &&
    p.target?.id === 'image_gen' &&
    p.sessionId === getAgentSessionKey(surface.route)
  ) {
    const conversation = p.input?.conversationId
    return typeof conversation === 'string' && surface.members.has(conversation)
      ? conversation
      : undefined
  }
  return surface.members.has(p.sessionId) ? p.sessionId : undefined
}
