// Fixture-only disabled HTML scope model. No token, authorization, execution or I/O.
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
const validScope = scope => exactKeys(scope, ['route', 'conversationId']) && safeId(scope.conversationId) &&
  exactKeys(scope.route, ['channel', 'scopeType', 'scopeId', 'threadId']) && scope.route.channel === 'canvas' &&
  scope.route.scopeType === 'thread' && safeId(scope.route.scopeId) && safeId(scope.route.threadId)
const scopeKey = scope => JSON.stringify([scope.route.channel, scope.route.scopeType, scope.route.scopeId, scope.route.threadId, scope.conversationId])

export function createDisabledHtmlScope({ scopes, deny }) {
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 32 || typeof deny !== 'function' || scopes.some(scope => !validScope(scope))) throw Error('Invalid disabled HTML fixture configuration')
  const allowed = new Map()
  for (const scope of scopes) {
    const key = scopeKey(scope)
    if (allowed.has(key)) throw Error('Duplicate disabled HTML fixture scope')
    allowed.set(key, allowed.size)
  }
  const active = new Map(), highWater = new Map(), counts = new Map()
  const reject = reason => { deny('disabledHtmlScope:' + reason); throw Error('Disabled HTML fixture denied: ' + reason) }
  const setAgentHtmlScope = async request => {
    if (!exactKeys(request, ['route', 'conversationId', 'active', 'lifecycleRevision']) ||
      !validScope({ route: request.route, conversationId: request.conversationId }) ||
      typeof request.active !== 'boolean' || !Number.isSafeInteger(request.lifecycleRevision) || request.lifecycleRevision < 1) return reject('invalid-request')
    const key = scopeKey(request), index = allowed.get(key), revision = request.lifecycleRevision
    if (index === undefined) return reject('unknown-scope')
    const current = active.get(key)
    if (request.active) {
      if (current !== undefined || revision <= (highWater.get(key) ?? 0)) return reject('invalid-activation')
      highWater.set(key, revision)
      active.set(key, revision)
    } else {
      if (current !== revision) return reject('invalid-retirement')
      active.delete(key)
    }
    const summaryKey = `${index}:${revision}`
    const summary = counts.get(summaryKey) ?? { scope: index, revision, activations: 0, retirements: 0 }
    if (request.active) summary.activations++; else summary.retirements++
    counts.set(summaryKey, summary)
    return {}
  }
  const audit = () => Object.freeze({ entries: Object.freeze([...counts.values()].map(row => Object.freeze({ ...row }))), active: Object.freeze([...active.entries()].map(([key, revision]) => Object.freeze({ scope: allowed.get(key), revision }))) })
  const assertRetired = () => { if (active.size) reject('active-at-teardown') }
  return Object.freeze({ setAgentHtmlScope, audit, assertRetired })
}
