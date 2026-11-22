import type { AgentSkillPreferenceReq } from '@shared/api/agentThreadSkillSession'
type Attempt = Pick<AgentSkillPreferenceReq, 'id' | 'enabled' | 'expectedRevision' | 'operationId'>
const pending = new Map<string, Attempt>()
const key = (scope: string) => { const { route, conversationId } = JSON.parse(scope); return JSON.stringify([route.channel, route.scopeType, route.scopeId, route.threadId, conversationId]) }
export const pendingSkillPreference = (scope: string): Attempt | undefined => { const attempt = pending.get(key(scope)); return attempt ? { ...attempt } : undefined }
/** No bodies/tokens; unknown retries retain original identity across panel remounts. */
export function beginSkillPreference(scope: string, id: string, enabled: boolean, expectedRevision: number): Attempt {
  const owned = key(scope), old = pending.get(owned)
  if (old) {
    if (old.id !== id || old.enabled !== enabled || old.expectedRevision !== expectedRevision) throw new Error('Resolve the pending skill preference before another change.')
    return { ...old }
  }
  if (pending.size >= 512) throw new Error('Skill preference outstanding retry capacity reached.')
  const attempt = { id, enabled, expectedRevision, operationId: crypto.randomUUID() }; pending.set(owned, attempt); return { ...attempt }
}
export function acknowledgeSkillPreference(scope: string, operationId: string): void {
  if (pending.get(key(scope))?.operationId === operationId) pending.delete(key(scope))
}
