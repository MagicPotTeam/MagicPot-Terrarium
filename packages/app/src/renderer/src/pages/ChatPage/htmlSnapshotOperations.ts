type Attempt = { id: string; acknowledged: boolean }
const attempts = new Map<string, Attempt>()
const MAX_ATTEMPTS = 512
let issued = 0
function identity(scope: string, kind: 'save' | 'restore', tuple: readonly (string | number)[]): string {
  const parsed = JSON.parse(scope)
  return JSON.stringify([parsed.route.channel, parsed.route.scopeType, parsed.route.scopeId, parsed.route.threadId, parsed.conversationId, kind, tuple])
}
function fresh(): Attempt {
  // Never evict uncertainty; explicitly confirmed new restores also consume budget.
  if (issued >= MAX_ATTEMPTS) throw new Error('HTML snapshot retry identity capacity reached; restart the renderer before more operations.')
  issued++; return { id: crypto.randomUUID(), acknowledged: false }
}
/** Body-free retry identities survive tab switches/remounts in this renderer. */
export function htmlSnapshotOperation(scope: string, kind: 'save' | 'restore', tuple: readonly (string | number)[]): string {
  const key = identity(scope, kind, tuple), prior = attempts.get(key)
  if (prior) return prior.id
  const attempt = fresh(); attempts.set(key, attempt); return attempt.id
}
export function acknowledgeHtmlRestore(scope: string, tuple: readonly (string | number)[], id: string): void {
  const attempt = attempts.get(identity(scope, 'restore', tuple))
  if (attempt?.id === id) attempt.acknowledged = true
}
export function canStartAnotherHtmlRestore(scope: string, tuple: readonly (string | number)[]): boolean {
  return attempts.get(identity(scope, 'restore', tuple))?.acknowledged === true
}
/** Only an explicit separately confirmed user action may supersede a known success. */
export function startAnotherHtmlRestore(scope: string, tuple: readonly (string | number)[]): void {
  const key = identity(scope, 'restore', tuple)
  if (!attempts.get(key)?.acknowledged) throw new Error('Resolve the existing restoration before starting another.')
  attempts.set(key, fresh())
}
