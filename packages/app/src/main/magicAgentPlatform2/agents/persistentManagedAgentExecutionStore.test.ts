import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
import { MagicAgentEventStore } from '../persistence/eventStore'
import { _crashTesting } from '../persistence/crashHooks'
import {
  MANAGED_EXECUTION_ATTEMPT_KIND,
  MANAGED_EXECUTION_INTENT_KIND,
  PersistentManagedAgentExecutionStore,
  type ManagedExecutionIdentity
} from './persistentManagedAgentExecutionStore'

const identity: ManagedExecutionIdentity = {
  instanceId: 'worker-1', generation: '9a7183cb-4cc0-4be9-9ff5-624677090ba2',
  attemptId: '150ed53c-294f-40c4-ab4f-e46d5ba51714', acceptedInstanceRevision: 3,
  definitionId: 'definition-1', configVersion: 'config-1', authorizedRequestDigest: 'a'.repeat(64),
  sessionKey: 'generic:dm:owned-session'
}
const binding = { runtimeRunId: 'runtime-1', effectiveRequestDigest: 'b'.repeat(64) }
const intent = { invocationId: 'invoke-1', runtimeRunId: binding.runtimeRunId, toolName: 'local.fixture', argsDigest: 'c'.repeat(64) }
const outcome = { kind: 'reported-result' as const, resultDigest: 'd'.repeat(64) }
const openStores: MagicAgentEventStore[] = [], directories: string[] = []
const open = (file = ':memory:') => {
  const events = new MagicAgentEventStore(file)
  openStores.push(events)
  return { events, store: new PersistentManagedAgentExecutionStore(events) }
}
const begin = (store: PersistentManagedAgentExecutionStore, value = identity) => store.beginAttempt({ identity: value, recordedAt: 1 })
const bound = (store: PersistentManagedAgentExecutionStore) => {
  const created = begin(store)
  return store.bindRuntime({ identity, expectedRevision: created.revision, binding, recordedAt: 2 })
}
const pending = (store: PersistentManagedAgentExecutionStore) => {
  const attempt = bound(store)
  return store.recordIntent({ identity, expectedRevision: attempt.revision, intent, recordedAt: 3 })
}
afterEach(() => {
  _crashTesting.setHook(null)
  for (const store of openStores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('managed execution ledger substrate (not production admission)', () => {
  it('persists an open attempt with no clean/restart authority', () => {
    const { store } = open()
    const created = begin(store)
    expect(created.state).toEqual({ protocolVersion: 1, identity, status: 'open', totalIntents: 0, pendingIntents: 0, unknownIntents: 0, reviewRequired: false })
    expect(store.getAttempt(identity)).toEqual(created)
    expect(created.state.status).not.toBe('clean')
    expect('clearUnknown' in store || 'authorizeRestart' in store || 'markClean' in store).toBe(false)
  })
  it('replays exact begin without clearing later pending state', () => {
    const { events, store } = open()
    pending(store)
    const count = events.countEvents(), current = store.getAttempt(identity)
    expect(begin(store)).toEqual(current)
    expect(store.getAttempt(identity)?.state.pendingIntents).toBe(1)
    expect(events.countEvents()).toBe(count)
  })
  it('rejects same attempt identity with changed authorized request digest', () => {
    const { store } = open()
    begin(store)
    expect(() => begin(store, { ...identity, authorizedRequestDigest: 'e'.repeat(64) })).toThrow(/identity|conflict/i)
    expect(() => store.beginAttempt({ identity, recordedAt: 2 })).toThrow(/conflict/i)
  })
  it('binds one actual runtime and distinguishes authorized versus effective digests', () => {
    const { store } = open()
    const attempt = bound(store)
    expect(attempt.state.binding).toEqual(binding)
    expect(attempt.state.identity.authorizedRequestDigest).not.toBe(binding.effectiveRequestDigest)
    expect(() => store.bindRuntime({ identity, expectedRevision: attempt.revision, binding: { ...binding, runtimeRunId: 'other-runtime' }, recordedAt: 3 })).toThrow(/binding|conflict/i)
  })
  it('replays binding without overwriting aggregate or adding events', () => {
    const { events, store } = open()
    pending(store)
    const count = events.countEvents()
    expect(store.bindRuntime({ identity, expectedRevision: 0, binding, recordedAt: 2 })).toEqual(store.getAttempt(identity))
    expect(events.countEvents()).toBe(count)
  })
  it('requires binding before an intent and rejects a foreign run id', () => {
    const { store } = open()
    const attempt = begin(store)
    expect(() => store.recordIntent({ identity, expectedRevision: attempt.revision, intent, recordedAt: 2 })).toThrow(/binding/i)
    const ready = store.bindRuntime({ identity, expectedRevision: attempt.revision, binding, recordedAt: 2 })
    expect(() => store.recordIntent({ identity, expectedRevision: ready.revision, intent: { ...intent, runtimeRunId: 'foreign-run' }, recordedAt: 3 })).toThrow(/binding|run/i)
  })
  it('atomically persists intent and aggregate count and does not duplicate replay', () => {
    const { store, events } = open()
    const saved = pending(store)
    expect(saved.state).toMatchObject({ identity, intent, status: 'pending' })
    expect(store.getAttempt(identity)?.state).toMatchObject({ totalIntents: 1, pendingIntents: 1, unknownIntents: 0 })
    const count = events.countEvents()
    expect(store.recordIntent({ identity, expectedRevision: 1, intent, recordedAt: 3 })).toEqual(saved)
    expect(events.countEvents()).toBe(count)
    expect(events.countResources({ kind: MANAGED_EXECUTION_INTENT_KIND })).toBe(1)
  })
  it('rejects invocation identity reuse with changed args or tool', () => {
    const { store } = open()
    pending(store)
    const revision = store.getAttempt(identity)!.revision
    for (const changed of [{ ...intent, argsDigest: 'f'.repeat(64) }, { ...intent, toolName: 'other' }]) {
      expect(() => store.recordIntent({ identity, expectedRevision: revision, intent: changed, recordedAt: 4 })).toThrow(/identity|conflict/i)
    }
    expect(store.getAttempt(identity)?.state.pendingIntents).toBe(1)
  })
  it('records a reported result without certifying effect knowledge or attempt cleanliness', () => {
    const { store } = open()
    pending(store)
    const saved = store.recordOutcome({ identity, expectedRevision: store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome, recordedAt: 4 })
    expect(saved.state).toMatchObject({ status: 'reported-result', outcome })
    expect(store.getAttempt(identity)?.state).toMatchObject({ status: 'open', totalIntents: 1, pendingIntents: 0, unknownIntents: 0, reviewRequired: false })
  })
  it('keeps unknown sticky against a later reported result', () => {
    const { store, events } = open()
    pending(store)
    const unknown = { kind: 'unknown' as const, resultDigest: 'e'.repeat(64), errorCode: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' }
    const saved = store.recordOutcome({ identity, expectedRevision: store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome: unknown, recordedAt: 4 })
    expect(saved.state.status).toBe('unknown')
    const count = events.countEvents()
    expect(() => store.recordOutcome({ identity, expectedRevision: store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome, recordedAt: 5 })).toThrow(/unknown|review|conflict/i)
    expect(store.getAttempt(identity)?.state).toMatchObject({ pendingIntents: 0, unknownIntents: 1, reviewRequired: true, status: 'open' })
    expect(events.countEvents()).toBe(count)
  })
  it('treats explicit unknown marker as unknown even if caller labels reported-result', () => {
    const { store } = open()
    pending(store)
    store.recordOutcome({ identity, expectedRevision: store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome: { ...outcome, errorCode: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' }, recordedAt: 4 })
    expect(store.getIntent(identity, intent.invocationId)?.state.status).toBe('unknown')
    expect(store.getAttempt(identity)?.state.reviewRequired).toBe(true)
  })
  it('rejects missing intents and stale aggregate revisions without dispatching anything', () => {
    const { store } = open()
    const attempt = bound(store)
    expect(() => store.recordOutcome({ identity, expectedRevision: attempt.revision, invocationId: 'absent', outcome, recordedAt: 3 })).toThrow(/intent|missing/i)
    expect(() => store.recordIntent({ identity, expectedRevision: 0, intent, recordedAt: 3 })).toThrow(/revision/i)
    expect(store.getAttempt(identity)?.state.totalIntents).toBe(0)
  })
  it('rolls back intent plus aggregate and receipts when before-commit fails', () => {
    const { events, store } = open()
    const attempt = bound(store), count = events.countEvents()
    _crashTesting.setHook(stage => { if (stage === 'resource.before-commit') throw new Error('injected ledger precommit') })
    expect(() => store.recordIntent({ identity, expectedRevision: attempt.revision, intent, recordedAt: 3 })).toThrow('injected ledger precommit')
    _crashTesting.setHook(null)
    expect(store.getAttempt(identity)).toEqual(attempt)
    expect(store.getIntent(identity, intent.invocationId)).toBeUndefined()
    expect(events.countResources({ kind: MANAGED_EXECUTION_INTENT_KIND })).toBe(0)
    expect(events.countEvents()).toBe(count)
    expect(store.recordIntent({ identity, expectedRevision: attempt.revision, intent, recordedAt: 3 }).state.status).toBe('pending')
  })
  it('keeps pending evidence when unknown-outcome publication fails', () => {
    const { events, store } = open()
    pending(store)
    const attempt = store.getAttempt(identity)!, count = events.countEvents()
    _crashTesting.setHook(stage => { if (stage === 'resource.before-commit') throw new Error('injected unknown write failure') })
    expect(() => store.recordOutcome({ identity, expectedRevision: attempt.revision, invocationId: intent.invocationId, outcome: { ...outcome, kind: 'unknown' }, recordedAt: 4 })).toThrow('injected unknown write failure')
    _crashTesting.setHook(null)
    expect(store.getAttempt(identity)).toEqual(attempt)
    expect(store.getIntent(identity, intent.invocationId)?.state.status).toBe('pending')
    expect(events.countEvents()).toBe(count)
  })
  it('does not accept a late reported result after an observed unknown write rolled back', () => {
    const { events, store } = open()
    pending(store)
    const attempt = store.getAttempt(identity)!
    _crashTesting.setHook(stage => { if (stage === 'resource.before-commit') throw new Error('unknown record could not commit') })
    expect(() => store.recordOutcome({ identity, expectedRevision: attempt.revision, invocationId: intent.invocationId, outcome: { ...outcome, kind: 'unknown' }, recordedAt: 4 })).toThrow('unknown record could not commit')
    _crashTesting.setHook(null)
    const laterWrapper = new PersistentManagedAgentExecutionStore(events)
    expect(() => laterWrapper.recordOutcome({ identity, expectedRevision: attempt.revision, invocationId: intent.invocationId, outcome, recordedAt: 5 })).toThrow(/unknown|review/i)
    expect(store.getAttempt(identity)?.state.pendingIntents).toBe(1)
    expect(laterWrapper.recordOutcome({ identity, expectedRevision: attempt.revision, invocationId: intent.invocationId, outcome: { ...outcome, kind: 'unknown' }, recordedAt: 6 }).state.status).toBe('unknown')
  })
  it('retains a valid pending unknown observation before rejecting stale aggregate revision', () => {
    const { events, store } = open()
    pending(store)
    const retainedRevision = store.getAttempt(identity)!.revision
    store.recordIntent({ identity, expectedRevision: retainedRevision, intent: { ...intent, invocationId: 'concurrent-intent' }, recordedAt: 4 })
    const currentRevision = store.getAttempt(identity)!.revision
    expect(() => store.recordOutcome({ identity, expectedRevision: retainedRevision, invocationId: intent.invocationId, outcome: { ...outcome, kind: 'unknown' }, recordedAt: 5 })).toThrow(/revision/i)
    const sameStoreWrapper = new PersistentManagedAgentExecutionStore(events)
    expect(() => sameStoreWrapper.recordOutcome({ identity, expectedRevision: currentRevision, invocationId: intent.invocationId, outcome, recordedAt: 6 })).toThrow(/unknown|review/i)
    expect(() => sameStoreWrapper.recordIntent({ identity, expectedRevision: currentRevision, intent: { ...intent, invocationId: 'later-intent' }, recordedAt: 7 })).toThrow(/unknown|review/i)
    expect(store.getAttempt(identity)?.state).toMatchObject({ pendingIntents: 2, unknownIntents: 0 })
    expect(sameStoreWrapper.recordOutcome({ identity, expectedRevision: currentRevision, invocationId: intent.invocationId, outcome: { ...outcome, kind: 'unknown' }, recordedAt: 8 }).state.status).toBe('unknown')
  })
  it('leaves committed intent conservative after an after-commit observer throws', () => {
    const { store } = open()
    const attempt = bound(store)
    _crashTesting.setHook(stage => { if (stage === 'resource.after-commit') throw new Error('injected postcommit observation') })
    expect(() => store.recordIntent({ identity, expectedRevision: attempt.revision, intent, recordedAt: 3 })).toThrow('injected postcommit observation')
    _crashTesting.setHook(null)
    expect(store.getAttempt(identity)?.state.pendingIntents).toBe(1)
    expect(store.getIntent(identity, intent.invocationId)?.state.status).toBe('pending')
    expect(store.recordIntent({ identity, expectedRevision: attempt.revision, intent, recordedAt: 3 }).state.status).toBe('pending')
  })
  it('survives real SQLite close/reopen independently of absent chat journal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'magic-managed-ledger-'))
    directories.push(directory)
    const file = join(directory, 'events.sqlite'), first = open(file)
    pending(first.store)
    first.store.recordOutcome({ identity, expectedRevision: first.store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome: { ...outcome, kind: 'unknown' }, recordedAt: 4 })
    const saved = first.store.getAttempt(identity)
    first.events.close(); openStores.splice(openStores.indexOf(first.events), 1)
    const second = open(file)
    expect(second.store.getAttempt(identity)).toEqual(saved)
    expect(second.store.getIntent(identity, intent.invocationId)?.state.status).toBe('unknown')
  })
  it('uses exact keys, never a bounded list scan to retrieve evidence', () => {
    const { events, store } = open()
    pending(store)
    vi.spyOn(events, 'listResources').mockImplementation(() => { throw new Error('bounded list forbidden') })
    vi.spyOn(events, 'listResourceMutations').mockImplementation(() => { throw new Error('bounded history forbidden') })
    expect(store.getAttempt(identity)?.state.pendingIntents).toBe(1)
    expect(store.getIntent(identity, intent.invocationId)?.state.status).toBe('pending')
  })
  it('keeps generation and foreign-store evidence separate', () => {
    const first = open(), foreign = open()
    pending(first.store)
    expect(first.store.getAttempt({ ...identity, generation: '365dece5-4d3f-450d-8f7c-026943c60920' })).toBeUndefined()
    expect(foreign.store.getAttempt(identity)).toBeUndefined()
    expect(() => foreign.store.recordIntent({ identity, expectedRevision: 1, intent, recordedAt: 3 })).toThrow(/attempt|missing/i)
  })
  it('fails closed on a structurally corrupted typed attempt', () => {
    const { events, store } = open()
    const attempt = begin(store)
    events.mutateResource({ operation: 'update', kind: MANAGED_EXECUTION_ATTEMPT_KIND, id: attempt.id, expectedRevision: attempt.revision, idempotencyKey: 'test:malformed', createdAt: 2, state: { ...attempt.state, protocolVersion: 99, pendingIntents: -1 }, event: { protocolVersion: '2.0.0', id: 'test:malformed:event', type: 'test.malformed-ledger', createdAt: 2, envelopeKind: 'event', streamId: 'test:malformed:stream', sequence: 0, payload: {} } })
    expect(() => store.getAttempt(identity)).toThrow(/evidence|invalid|version/i)
  })
  it('replays a recorded outcome without changing counters or erasing review', () => {
    const { events, store } = open()
    pending(store)
    const input = { identity, expectedRevision: store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome: { ...outcome, kind: 'unknown' as const }, recordedAt: 4 }
    const saved = store.recordOutcome(input), attempt = store.getAttempt(identity), count = events.countEvents()
    expect(store.recordOutcome(input)).toEqual(saved)
    expect(store.getAttempt(identity)).toEqual(attempt)
    expect(events.countEvents()).toBe(count)
  })
  it('counts multiple intents independently and preserves unknown while another settles', () => {
    const { store } = open()
    pending(store)
    store.recordIntent({ identity, expectedRevision: store.getAttempt(identity)!.revision, intent: { ...intent, invocationId: 'invoke-2' }, recordedAt: 4 })
    expect(store.getAttempt(identity)?.state).toMatchObject({ totalIntents: 2, pendingIntents: 2 })
    store.recordOutcome({ identity, expectedRevision: store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome: { ...outcome, kind: 'unknown' }, recordedAt: 5 })
    expect(store.getAttempt(identity)?.state).toMatchObject({ totalIntents: 2, pendingIntents: 1, unknownIntents: 1, reviewRequired: true })
    store.recordOutcome({ identity, expectedRevision: store.getAttempt(identity)!.revision, invocationId: 'invoke-2', outcome, recordedAt: 6 })
    expect(store.getAttempt(identity)?.state).toMatchObject({ totalIntents: 2, pendingIntents: 0, unknownIntents: 1, reviewRequired: true })
    expect(() => store.recordIntent({ identity, expectedRevision: store.getAttempt(identity)!.revision, intent: { ...intent, invocationId: 'invoke-3' }, recordedAt: 7 })).toThrow(/review|unknown/i)
  })
  it('does not mutate another attempt sharing the same instance or invocation id', () => {
    const { store } = open()
    pending(store)
    const otherIdentity = { ...identity, attemptId: 'a548e70b-0d79-414e-a606-1104f9d0a710' }
    const other = begin(store, otherIdentity)
    store.bindRuntime({ identity: otherIdentity, expectedRevision: other.revision, binding: { ...binding, runtimeRunId: 'other-run' }, recordedAt: 2 })
    store.recordIntent({ identity: otherIdentity, expectedRevision: 1, intent: { ...intent, runtimeRunId: 'other-run' }, recordedAt: 3 })
    store.recordOutcome({ identity, expectedRevision: store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome: { ...outcome, kind: 'unknown' }, recordedAt: 4 })
    expect(store.getAttempt(otherIdentity)?.state).toMatchObject({ pendingIntents: 1, unknownIntents: 0, reviewRequired: false })
    expect(store.getIntent(otherIdentity, intent.invocationId)?.state.status).toBe('pending')
  })
  it('captures command data before persistence callouts can mutate caller objects', () => {
    const { events, store } = open()
    const callerIdentity = { ...identity }, callerInput = { identity: callerIdentity, recordedAt: 1 }
    const original = events.mutateResourcesBatch.bind(events)
    vi.spyOn(events, 'mutateResourcesBatch').mockImplementation((...args) => {
      callerIdentity.definitionId = 'changed-after-capture'
      callerInput.recordedAt = 99
      return original(...args)
    })
    expect(store.beginAttempt(callerInput).state.identity).toEqual(identity)
    expect(store.getAttempt(identity)?.createdAt).toBe(1)
  })
  it('rejects symbolic fields, proxies and toJSON without invoking their behavior', () => {
    const { store } = open()
    let effects = 0
    const proxy = new Proxy(identity, { get() { effects++; throw new Error('must not execute') } })
    expect(() => begin(store, proxy)).toThrow(/data|plain/i)
    expect(() => begin(store, { ...identity, [Symbol('authority')]: 'forbidden' })).toThrow(/data|field/i)
    const callable = { ...identity, toJSON() { effects++; return identity } }
    expect(() => begin(store, callable)).toThrow(/data|plain/i)
    expect(effects).toBe(0)
  })
  it('does not turn a tombstoned attempt or intent into absent evidence', () => {
    const { events, store } = open()
    const saved = pending(store)
    events.mutateResource({ operation: 'delete', kind: MANAGED_EXECUTION_INTENT_KIND, id: saved.id, expectedRevision: saved.revision, idempotencyKey: 'test:delete-intent', createdAt: 4, event: { protocolVersion: '2.0.0', id: 'test:delete-intent:event', type: 'test.delete-ledger-intent', createdAt: 4, envelopeKind: 'event', streamId: 'test:delete-intent:stream', sequence: 0, payload: {} } })
    expect(() => store.getIntent(identity, intent.invocationId)).toThrow(/deleted/i)
    const attempt = store.getAttempt(identity)!
    events.mutateResource({ operation: 'delete', kind: MANAGED_EXECUTION_ATTEMPT_KIND, id: attempt.id, expectedRevision: attempt.revision, idempotencyKey: 'test:delete-attempt', createdAt: 5, event: { protocolVersion: '2.0.0', id: 'test:delete-attempt:event', type: 'test.delete-ledger-attempt', createdAt: 5, envelopeKind: 'event', streamId: 'test:delete-attempt:stream', sequence: 0, payload: {} } })
    expect(() => store.getAttempt(identity)).toThrow(/deleted/i)
    expect(() => begin(store)).toThrow(/deleted/i)
  })
  it('rejects a reported intent when malformed aggregate claims zero reported intents', () => {
    const { events, store } = open()
    pending(store)
    const input = { identity, expectedRevision: store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome, recordedAt: 4 }
    store.recordOutcome(input)
    const attempt = store.getAttempt(identity)!
    events.mutateResource({ operation: 'update', kind: MANAGED_EXECUTION_ATTEMPT_KIND, id: attempt.id, expectedRevision: attempt.revision, idempotencyKey: 'test:zero-reported', createdAt: 5, state: { ...attempt.state, totalIntents: 0 }, event: { protocolVersion: '2.0.0', id: 'test:zero-reported:event', type: 'test.zero-reported', createdAt: 5, envelopeKind: 'event', streamId: 'test:zero-reported:stream', sequence: 0, payload: {} } })
    expect(() => store.getIntent(identity, intent.invocationId)).toThrow(/evidence|counter|reported/i)
    expect(() => store.recordOutcome(input)).toThrow(/evidence|counter|reported/i)
  })
  it('refuses reads and replay when one paired intent receipt is unavailable', () => {
    const { events, store } = open()
    pending(store)
    const original = events.getEvent.bind(events)
    vi.spyOn(events, 'getEvent').mockImplementation(id => id.endsWith(':intent:event') ? undefined : original(id))
    expect(() => store.getIntent(identity, intent.invocationId)).toThrow(/receipt|evidence/i)
    expect(() => store.recordIntent({ identity, expectedRevision: 1, intent, recordedAt: 3 })).toThrow(/receipt|evidence/i)
  })
  it('refuses an existing attempt when its exact begin receipt is unavailable', () => {
    const { events, store } = open()
    begin(store)
    vi.spyOn(events, 'getEvent').mockReturnValue(undefined)
    expect(() => store.getAttempt(identity)).toThrow(/receipt|evidence/i)
  })
  it('uses SQLite revisions and committed unknown state across competing file connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'magic-managed-competing-'))
    directories.push(directory)
    const file = join(directory, 'events.sqlite'), first = open(file)
    const attempt = bound(first.store), second = open(file)
    first.store.recordIntent({ identity, expectedRevision: attempt.revision, intent, recordedAt: 3 })
    expect(() => second.store.recordIntent({ identity, expectedRevision: attempt.revision, intent: { ...intent, invocationId: 'second-connection' }, recordedAt: 4 })).toThrow(/revision/i)
    expect(second.store.getAttempt(identity)?.state.pendingIntents).toBe(1)
    first.store.recordOutcome({ identity, expectedRevision: first.store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome: { ...outcome, kind: 'unknown' }, recordedAt: 5 })
    expect(second.store.getIntent(identity, intent.invocationId)?.state.status).toBe('unknown')
    expect(() => second.store.recordOutcome({ identity, expectedRevision: second.store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome, recordedAt: 6 })).toThrow(/unknown|review|conflict/i)
  })
  it('reopens a failed unknown publication as pending evidence, never automatically clear', () => {
    const directory = mkdtempSync(join(tmpdir(), 'magic-managed-pending-reopen-'))
    directories.push(directory)
    const file = join(directory, 'events.sqlite'), first = open(file)
    pending(first.store)
    _crashTesting.setHook(stage => { if (stage === 'resource.before-commit') throw new Error('unknown did not persist') })
    expect(() => first.store.recordOutcome({ identity, expectedRevision: first.store.getAttempt(identity)!.revision, invocationId: intent.invocationId, outcome: { ...outcome, kind: 'unknown' }, recordedAt: 4 })).toThrow('unknown did not persist')
    _crashTesting.setHook(null)
    first.events.close(); openStores.splice(openStores.indexOf(first.events), 1)
    const second = open(file)
    expect(second.store.getAttempt(identity)?.state).toMatchObject({ status: 'open', pendingIntents: 1, unknownIntents: 0 })
    expect(second.store.getIntent(identity, intent.invocationId)?.state.status).toBe('pending')
  })
  it('validates primitive fields without coercion or executable accessor reads', () => {
    const { store } = open()
    let reads = 0
    const hostile = { ...identity }
    Object.defineProperty(hostile, 'instanceId', { enumerable: true, get() { reads++; return identity.instanceId } })
    expect(() => begin(store, hostile)).toThrow(/data|plain|identity/i)
    expect(reads).toBe(0)
    expect(() => begin(store, { ...identity, authorizedRequestDigest: 'not-a-digest' })).toThrow(/digest|identity/i)
    expect(() => store.beginAttempt({ identity, recordedAt: Number.NaN })).toThrow(/time|recordedAt|invalid/i)
  })
})
