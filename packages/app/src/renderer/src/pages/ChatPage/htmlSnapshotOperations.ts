type Attempt = { id: string; acknowledged: boolean }
const attempts = new Map<string, Attempt>()
const MAX_ATTEMPTS = 512
let issued = 0
function identity(scope: string, kind: 'save' | 'restore', tuple: readonly (string | number)[]): string {
  const parsed = JSON.parse(scope)
  return JSON.stringify([parsed.route.channel, parsed.route.scopeType, parsed.route.scopeId, parsed.route.threadId, parsed.conversationId, kind, tuple])
}
function fresh(): Attempt {
  // Never evict uncertainty; each new restore after an acknowledged one also consumes budget.
  if (issued >= MAX_ATTEMPTS) throw new Error('HTML snapshot retry identity capacity reached; restart the renderer before more operations.')
  issued++; return { id: crypto.randomUUID(), acknowledged: false }
}
/**
 * Body-free retry identities survive tab switches/remounts in this renderer. An operation whose
 * answer never arrived keeps its identity, so retrying it cannot make a second card or copy. Once
 * main acknowledged a restore, the next restore of that snapshot is a new operation: main answers
 * a replayed one with the card it made then, and refuses it once that card is gone.
 */
export function htmlSnapshotOperation(scope: string, kind: 'save' | 'restore', tuple: readonly (string | number)[]): string {
  const key = identity(scope, kind, tuple), prior = attempts.get(key)
  if (prior && !prior.acknowledged) return prior.id
  const attempt = fresh(); attempts.set(key, attempt); return attempt.id
}
export function acknowledgeHtmlRestore(scope: string, tuple: readonly (string | number)[], id: string): void {
  const attempt = attempts.get(identity(scope, 'restore', tuple))
  if (attempt?.id === id) attempt.acknowledged = true
}
