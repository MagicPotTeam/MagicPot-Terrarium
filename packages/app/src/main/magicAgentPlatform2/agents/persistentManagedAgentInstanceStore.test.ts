import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importActual) => importActual())
import type { MagicAgentInstanceState } from '../../../shared/magicAgentPlatform2/agentInstance'
import { canonicalPolicyJson, sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import { NodeSQLiteAdapter } from '../persistence/sqliteAdapter'
import { MagicAgentEventStore, type StoredResource } from '../persistence/eventStore'
import { _crashTesting } from '../persistence/crashHooks'
import { PersistentAgentInstanceStore, prepareAgentInstanceTransition } from './persistentAgentInstanceStore'
import { PersistentManagedAgentExecutionStore } from './persistentManagedAgentExecutionStore'
import { MANAGED_AGENT_COVERAGE_KIND, PersistentManagedAgentInstanceStore, type ManagedAgentFirstStartInput } from './persistentManagedAgentInstanceStore'

const stores: MagicAgentEventStore[] = [], directories: string[] = []
const instance = (id = 'root'): MagicAgentInstanceState => ({ id, name: id, definitionId: 'definition-1', configVersion: 'config-1', depth: 0, status: 'created', limits: { maxChildren: 3, maxDepth: 2, maxConcurrency: 1, maxRuntimeMs: 10000, allowedToolNames: ['local.fixture'], workspaceRoots: ['C:\\owned'] } })
const birth = (id = 'root') => ({ instance: instance(id), createdAt: 1, idempotencyKey: `birth:${id}` })
const start = (id = 'root'): ManagedAgentFirstStartInput => ({ instanceId: id, expectedRevision: 0, expectedCoverageRevision: 0, authorizedRequestDigest: 'a'.repeat(64), sessionKey: `generic:dm:${id}`, startedAt: 2, idempotencyKey: `first:${id}` })
const open = (file = ':memory:') => { const events = new MagicAgentEventStore(file); stores.push(events); return { events, managed: new PersistentManagedAgentInstanceStore(events), plain: new PersistentAgentInstanceStore(events), ledger: new PersistentManagedAgentExecutionStore(events) } }
const child = (id = 'child', revision = 0) => ({ ...birth(id), createdAt: 2, parentInstanceId: 'root', parentExpectedRevision: revision, instance: { ...instance(id), parentInstanceId: 'root', depth: 1 } })
const failure = /conflict|coverage|birth|receipt|virgin|revision|evidence|already|created|missing|not found|deleted|identity/i
const historicalTransition = (events: MagicAgentEventStore, row: StoredResource<MagicAgentInstanceState>, status: MagicAgentInstanceState['status'], at: number, key: string) =>
  events.mutateResource<MagicAgentInstanceState>(prepareAgentInstanceTransition(row, status, at, key)).resource
// Historical unsupported states must be inserted through an explicit raw fixture,
// not an ordinary-store escape hatch. These writes are not production authority.
const historicalUpdate = (events: MagicAgentEventStore, row: StoredResource<MagicAgentInstanceState>, patch: Partial<MagicAgentInstanceState>, at: number) =>
  events.mutateResource<MagicAgentInstanceState>({ operation: 'update', kind: row.kind, id: row.id, expectedRevision: row.revision,
    state: { ...row.state, ...patch }, createdAt: at, idempotencyKey: `fixture-history:${row.id}:${row.revision}`, event: {
      protocolVersion: '2.0.0', id: `fixture-history:${row.id}:${row.revision}:event`, type: 'fixture.historical-unsupported-instance',
      envelopeKind: 'event', streamId: `${row.kind}:${row.id}:stream`, sequence: row.revision + 1, createdAt: at, payload: {} } }).resource
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
afterEach(() => { _crashTesting.setHook(null); vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('atomic managed instance persistence (not production admission or dispatch authority)', () => {
  it('atomically creates root plus explicit virgin generation with no clean authority', () => {
    const { managed, events } = open(), result = managed.createRoot(birth())
    expect(result.inserted).toBe(true); expect(result.instance.state).toEqual(instance())
    expect(result.coverage.kind).toBe(MANAGED_AGENT_COVERAGE_KIND); expect(result.coverage.state).toMatchObject({ protocolVersion: 1, instanceId: 'root', status: 'virgin', definitionId: 'definition-1', configVersion: 'config-1' })
    expect(result.coverage.state.generation).toMatch(uuid); expect(result.coverage.revision).toBe(0); expect(result.coverage.state.accepted).toBeUndefined()
    expect(events.countEvents()).toBe(2); expect(managed.getCoverage('root')).toEqual(result.coverage)
    expect('markClean' in managed || 'authorizeRestart' in managed || 'clearUnknown' in managed || 'reconcile' in managed).toBe(false)
  })
  it('replays exact root birth from exact receipts without another generation or write', () => {
    const { managed, events } = open(), first = managed.createRoot(birth()), count = events.countEvents()
    expect(managed.createRoot(birth())).toEqual({ ...first, inserted: false }); expect(events.countEvents()).toBe(count)
    expect(() => managed.createRoot({ ...birth(), instance: { ...instance(), name: 'different' } })).toThrow(failure)
  })
  it('rolls back both root and coverage on before-commit failure then retries fresh', () => {
    const { managed, plain, events } = open()
    _crashTesting.setHook(stage => { if (stage === 'resource.before-commit') throw Error('root precommit fixture') })
    expect(() => managed.createRoot(birth())).toThrow('root precommit fixture'); _crashTesting.setHook(null)
    expect(plain.get('root')).toBeUndefined(); expect(managed.getCoverage('root')).toBeUndefined(); expect(events.countEvents()).toBe(0)
    expect(managed.createRoot(birth()).inserted).toBe(true)
  })
  it('preserves both committed root records after a postcommit observer throws', () => {
    const { managed, plain, events } = open()
    _crashTesting.setHook(stage => { if (stage === 'resource.after-commit') throw Error('root postcommit fixture') })
    expect(() => managed.createRoot(birth())).toThrow('root postcommit fixture'); _crashTesting.setHook(null)
    expect(plain.get('root')?.state.status).toBe('created'); expect(managed.getCoverage('root')?.state.status).toBe('virgin')
    expect(managed.createRoot(birth()).inserted).toBe(false); expect(events.countEvents()).toBe(2)
  })
  it('never installs a virgin baseline on a preexisting legacy created or stopped instance', () => {
    const { managed, plain, events } = open(); plain.create(birth()); const count = events.countEvents()
    expect(() => managed.createRoot(birth())).toThrow(failure); expect(() => managed.startFirstAttempt(start())).toThrow(failure)
    plain.stop({ instanceId: 'root', expectedRevision: 0, transitionedAt: 2, idempotencyKey: 'legacy-stop' })
    expect(() => managed.startFirstAttempt({ ...start(), expectedRevision: 1 })).toThrow(failure)
    expect(managed.getCoverage('root')).toBeUndefined(); expect(events.countEvents()).toBe(count + 1)
  })
  it('atomically writes running plus dirty coverage plus a ledger-compatible exact attempt', () => {
    const { managed, ledger, events } = open(); managed.createRoot(birth()); const result = managed.startFirstAttempt(start())
    expect(result.inserted).toBe(true); expect(result.instance.state.status).toBe('running'); expect(result.instance.revision).toBe(1)
    expect(result.coverage.state.status).toBe('dirty'); expect(result.coverage.revision).toBe(1)
    const identity = result.attempt.state.identity
    expect(identity).toMatchObject({ instanceId: 'root', acceptedInstanceRevision: 1, generation: result.coverage.state.generation, definitionId: 'definition-1', configVersion: 'config-1', authorizedRequestDigest: 'a'.repeat(64), sessionKey: 'generic:dm:root' })
    expect(identity.attemptId).toMatch(uuid); expect(result.coverage.state.accepted?.identity).toEqual(identity)
    expect(ledger.getAttempt(identity)).toEqual(result.attempt); expect(result.attempt.state.status).toBe('open'); expect(result.attempt.revision).toBe(0); expect(events.countEvents()).toBe(5)
  })
  it('rolls back all three start records and retries without a half accepted start', () => {
    const { managed, plain, events } = open(), born = managed.createRoot(birth())
    _crashTesting.setHook(stage => { if (stage === 'resource.before-commit') throw Error('start precommit fixture') })
    expect(() => managed.startFirstAttempt(start())).toThrow('start precommit fixture'); _crashTesting.setHook(null)
    expect(plain.get('root')).toEqual(born.instance); expect(managed.getCoverage('root')).toEqual(born.coverage)
    expect(events.listResources({ kind: 'managed-agent-execution-attempt' })).toEqual([]); expect(events.countEvents()).toBe(2)
    expect(managed.startFirstAttempt(start()).inserted).toBe(true)
  })
  it('keeps all three committed records dirty when postcommit publication throws', () => {
    const { managed, events, plain, ledger } = open(); managed.createRoot(birth())
    _crashTesting.setHook(stage => { if (stage === 'resource.after-commit') throw Error('start postcommit fixture') })
    expect(() => managed.startFirstAttempt(start())).toThrow('start postcommit fixture'); _crashTesting.setHook(null)
    const replay = managed.startFirstAttempt(start())
    expect(replay.inserted).toBe(false); expect(replay.coverage.state.status).toBe('dirty'); expect(plain.get('root')?.state.status).toBe('running'); expect(ledger.getAttempt(replay.attempt.state.identity)).toEqual(replay.attempt); expect(events.countEvents()).toBe(5)
  })
  it('exact start replay returns current dirty pending evidence and no insertion after stop', () => {
    const { managed, ledger, plain, events } = open(); managed.createRoot(birth()); const accepted = managed.startFirstAttempt(start()), identity = accepted.attempt.state.identity
    ledger.bindRuntime({ identity, expectedRevision: 0, binding: { runtimeRunId: 'runtime-1', effectiveRequestDigest: 'b'.repeat(64) }, recordedAt: 3 })
    ledger.recordIntent({ identity, expectedRevision: 1, intent: { runtimeRunId: 'runtime-1', invocationId: 'invoke-1', toolName: 'local.fixture', argsDigest: 'c'.repeat(64) }, recordedAt: 4 })
    expect(() => plain.stop({ instanceId: 'root', expectedRevision: 1, transitionedAt: 5, idempotencyKey: 'stop' })).toThrow(/managed.*ordinary/i)
    historicalTransition(events, plain.get('root')!, 'stopped', 5, 'historical-stop'); const count = events.countEvents()
    const replay = managed.startFirstAttempt(start())
    expect(replay.inserted).toBe(false); expect(replay.instance.state.status).toBe('stopped'); expect(replay.attempt.state.pendingIntents).toBe(1); expect(replay.attempt.revision).toBe(2); expect(replay.coverage.state.status).toBe('dirty'); expect(events.countEvents()).toBe(count)
    expect(() => managed.startFirstAttempt({ ...start(), expectedRevision: 2, expectedCoverageRevision: 1, idempotencyKey: 'another-attempt' })).toThrow(failure)
    const bornReplay = managed.createRoot(birth()); expect(bornReplay.inserted).toBe(false); expect(bornReplay.coverage.state.status).toBe('dirty'); expect(bornReplay.instance.state.status).toBe('stopped')
  })
  it('rejects same start key changed digest session time or expected revisions without writing', () => {
    const { managed, events } = open(); managed.createRoot(birth()); managed.startFirstAttempt(start()); const count = events.countEvents()
    for (const patch of [{ authorizedRequestDigest: 'e'.repeat(64) }, { sessionKey: 'foreign-session' }, { startedAt: 3 }, { expectedRevision: 1 }, { expectedCoverageRevision: 1 }]) expect(() => managed.startFirstAttempt({ ...start(), ...patch })).toThrow(failure)
    expect(events.countEvents()).toBe(count)
  })
  it('refuses old untracked start-stop despite still-virgin coverage', () => {
    const { managed, plain, events } = open(); const born = managed.createRoot(birth())
    expect(() => plain.start({ instanceId: 'root', expectedRevision: 0, transitionedAt: 2, idempotencyKey: 'old-start' })).toThrow(/managed.*ordinary/i)
    const running = historicalTransition(events, born.instance, 'running', 2, 'old-start')
    historicalTransition(events, running, 'stopped', 3, 'old-stop')
    expect(managed.getCoverage('root')?.state.status).toBe('virgin')
    expect(() => managed.startFirstAttempt({ ...start(), expectedRevision: 2, startedAt: 4 })).toThrow(failure)
  })
  it('refuses config changes before first managed attempt even when coverage is virgin', () => {
    const { managed, plain, events } = open(); const born = managed.createRoot(birth())
    expect(() => plain.stageConfig({ id: 'root', expectedRevision: 0, configVersion: 'v2', stagedAt: 2, idempotencyKey: 'stage' })).toThrow(/managed.*ordinary/i)
    historicalUpdate(events, born.instance, { pendingConfigVersion: 'v2' }, 2)
    expect(() => managed.startFirstAttempt({ ...start(), expectedRevision: 1, startedAt: 3 })).toThrow(failure)
  })
  it('atomically reserves exact parent CAS with child and fresh child coverage', () => {
    const { managed, plain, events } = open(); managed.createRoot(birth()); const result = managed.reserveChild(child())
    expect(result.inserted).toBe(true); expect(result.parent.revision).toBe(1)
    expect(result.instance.state.parentInstanceId).toBe('root'); expect(result.coverage.state.status).toBe('virgin'); expect(result.coverage.state.generation).toMatch(uuid); expect(plain.get('root')?.revision).toBe(1); expect(events.countEvents()).toBe(5)
    expect(managed.reserveChild(child())).toEqual({ ...result, inserted: false })
    expect(() => managed.startFirstAttempt({ ...start(), expectedRevision: 1 })).toThrow(failure)
    expect(managed.startFirstAttempt({ ...start('child'), startedAt: 3 }).inserted).toBe(true)
  })
  it('rolls back parent child and child coverage on reservation failure', () => {
    const { managed, plain, events } = open(), born = managed.createRoot(birth())
    _crashTesting.setHook(stage => { if (stage === 'resource.before-commit') throw Error('child precommit fixture') })
    expect(() => managed.reserveChild(child())).toThrow('child precommit fixture'); _crashTesting.setHook(null)
    expect(plain.get('root')).toEqual(born.instance); expect(plain.get('child')).toBeUndefined(); expect(managed.getCoverage('child')).toBeUndefined(); expect(events.countEvents()).toBe(2)
    expect(managed.reserveChild(child()).inserted).toBe(true)
  })
  it('rejects stale parent contender without partial child birth and same-key altered child conflicts', () => {
    const { managed, events, plain } = open(); managed.createRoot(birth()); managed.reserveChild(child()); const count = events.countEvents()
    expect(() => managed.reserveChild(child('second', 0))).toThrow(failure); expect(plain.get('second')).toBeUndefined(); expect(managed.getCoverage('second')).toBeUndefined()
    expect(() => managed.reserveChild({ ...child(), instance: { ...child().instance, name: 'changed' } })).toThrow(failure); expect(events.countEvents()).toBe(count)
  })
  it('rejects missing paired birth receipt rather than granting first-start coverage', () => {
    const { managed, events } = open(), born = managed.createRoot(birth()), get = events.getEvent.bind(events)
    vi.spyOn(events, 'getEvent').mockImplementation(id => id === `${born.coverage.state.birth.commandKey}:coverage:event` ? undefined : get(id))
    expect(() => managed.startFirstAttempt(start())).toThrow(failure)
  })
  it('rejects deleted coverage rather than recreating a virgin generation', () => {
    const { managed, events } = open(), born = managed.createRoot(birth())
    events.mutateResource({ operation: 'delete', kind: MANAGED_AGENT_COVERAGE_KIND, id: born.coverage.id, expectedRevision: 0, idempotencyKey: 'delete-coverage', createdAt: 2, event: { protocolVersion: '2.0.0', id: 'delete-coverage-event', type: 'fixture.deleted', envelopeKind: 'event', streamId: `${MANAGED_AGENT_COVERAGE_KIND}:${born.coverage.id}:stream`, sequence: 1, createdAt: 2, payload: {} } })
    expect(() => managed.createRoot(birth())).toThrow(failure); expect(() => managed.startFirstAttempt(start())).toThrow(failure)
  })
  it('rejects missing exact attempt begin receipt on replay with no reset', () => {
    const { managed, events } = open(); managed.createRoot(birth()); const accepted = managed.startFirstAttempt(start())
    const beginId = events.listResourceMutations('managed-agent-execution-attempt', accepted.attempt.id)[0].eventId, get = events.getEvent.bind(events), count = events.countEvents()
    vi.spyOn(events, 'getEvent').mockImplementation(id => id === beginId ? undefined : get(id))
    expect(() => managed.startFirstAttempt(start())).toThrow(failure); expect(events.countEvents()).toBe(count)
  })
  it('uses exact receipt lookups even when bounded list APIs are unavailable', () => {
    const { managed, events } = open(); managed.createRoot(birth()); managed.startFirstAttempt(start())
    vi.spyOn(events, 'listResourceMutations').mockImplementation(() => { throw Error('bounded mutation list forbidden') }); vi.spyOn(events, 'listResources').mockImplementation(() => { throw Error('bounded resources forbidden') })
    expect(managed.createRoot(birth()).inserted).toBe(false); expect(managed.startFirstAttempt(start()).inserted).toBe(false)
  })
  it('captures caller birth data before store read callouts and leaves caller mutable', () => {
    const { managed, events } = open(), input = birth(), get = events.getEvent.bind(events); let mutated = false
    vi.spyOn(events, 'getEvent').mockImplementation(id => { if (!mutated) { mutated = true; (input.instance as { name: string }).name = 'changed'; (input.instance.limits.allowedToolNames as string[]).push('foreign') } return get(id) })
    const born = managed.createRoot(input)
    expect(born.instance.state.name).toBe('root'); expect(born.instance.state.limits.allowedToolNames).toEqual(['local.fixture']); expect(input.instance.name).toBe('changed'); expect(Object.isFrozen(input.instance)).toBe(false)
  })
  it('captures first-start digest and session before store callouts', () => {
    const { managed, events } = open(); managed.createRoot(birth()); const input = { ...start() }, get = events.getEvent.bind(events); let changed = false
    vi.spyOn(events, 'getEvent').mockImplementation(id => { if (!changed) { changed = true; input.sessionKey = 'foreign'; input.authorizedRequestDigest = 'e'.repeat(64) } return get(id) })
    const result = managed.startFirstAttempt(input)
    expect(result.attempt.state.identity.sessionKey).toBe('generic:dm:root'); expect(result.attempt.state.identity.authorizedRequestDigest).toBe('a'.repeat(64)); expect(input.sessionKey).toBe('foreign')
  })
  it('rejects nested getters and proxies without invoking caller code or persistence', () => {
    const { managed, events } = open(), input = birth(); let calls = 0
    Object.defineProperty(input.instance, 'name', { enumerable: true, get() { calls++; return 'bad' } })
    expect(() => managed.createRoot(input)).toThrow(/plain|data|getter|accessor|JSON/i); expect(calls).toBe(0)
    const proxy = new Proxy(birth(), { ownKeys() { calls++; throw Error('caller proxy executed') } })
    expect(() => managed.createRoot(proxy)).toThrow(/plain|data|proxy|JSON/i); expect(calls).toBe(0); expect(events.countEvents()).toBe(0)
  })
  it('does not change a dirty parent generation when reserving a new child', () => {
    const { managed, events } = open(); managed.createRoot(birth()); const accepted = managed.startFirstAttempt(start()), before = managed.getCoverage('root'), count = events.countEvents()
    const result = managed.reserveChild({ ...child(), parentExpectedRevision: 1, createdAt: 3 })
    expect(result.parent.revision).toBe(2); expect(managed.getCoverage('root')).toEqual(before); expect(result.coverage.state.generation).not.toBe(accepted.coverage.state.generation); expect(events.countEvents()).toBe(count + 3)
  })
  it('keeps complete child birth after a postcommit exception and exact replay', () => {
    const { managed, events, plain } = open(); managed.createRoot(birth())
    _crashTesting.setHook(stage => { if (stage === 'resource.after-commit') throw Error('child postcommit fixture') })
    expect(() => managed.reserveChild(child())).toThrow('child postcommit fixture'); _crashTesting.setHook(null)
    expect(plain.get('root')?.revision).toBe(1); expect(plain.get('child')?.state.status).toBe('created'); expect(managed.getCoverage('child')?.state.status).toBe('virgin')
    expect(managed.reserveChild(child()).inserted).toBe(false); expect(events.countEvents()).toBe(5)
  })
  it('refuses paused resume as a new first attempt without altering default resume', () => {
    const { managed, plain, events } = open(); const born = managed.createRoot(birth())
    const running = historicalTransition(events, born.instance, 'running', 2, 'legacy-start')
    historicalTransition(events, running, 'paused', 3, 'legacy-pause')
    const count = events.countEvents(); expect(() => managed.startFirstAttempt({ ...start(), expectedRevision: 2, startedAt: 4 })).toThrow(failure); expect(events.countEvents()).toBe(count)
    expect(() => plain.resume({ instanceId: 'root', expectedRevision: 2, transitionedAt: 4, idempotencyKey: 'legacy-resume' })).toThrow(/managed.*ordinary/i)
    plain.create(birth('legacy')); plain.start({ instanceId: 'legacy', expectedRevision: 0, transitionedAt: 2, idempotencyKey: 'legacy-start' })
    plain.pause({ instanceId: 'legacy', expectedRevision: 1, transitionedAt: 3, idempotencyKey: 'legacy-pause' })
    expect(plain.resume({ instanceId: 'legacy', expectedRevision: 2, transitionedAt: 4, idempotencyKey: 'legacy-resume' }).state.status).toBe('running')
  })
  it('refuses replacement before first attempt even when the original coverage remains virgin', () => {
    const { managed, plain, events } = open(); const born = managed.createRoot(birth())
    const stopped = historicalTransition(events, born.instance, 'stopped', 2, 'stop')
    expect(() => plain.replace({ instanceId: 'root', expectedRevision: 1, definitionId: 'replacement', name: 'replacement', configVersion: 'v2', replacedAt: 3, idempotencyKey: 'replace' })).toThrow(/managed.*ordinary/i)
    historicalUpdate(events, stopped, { definitionId: 'replacement', name: 'replacement', configVersion: 'v2' }, 3)
    expect(() => managed.startFirstAttempt({ ...start(), expectedRevision: 2, startedAt: 4 })).toThrow(failure)
    expect(managed.getCoverage('root')?.state.status).toBe('virgin')
  })
  it('does not clear unknown when re-reading historical birth or first-start receipts', () => {
    const { managed, ledger, events } = open(); managed.createRoot(birth()); const identity = managed.startFirstAttempt(start()).attempt.state.identity
    ledger.bindRuntime({ identity, expectedRevision: 0, binding: { runtimeRunId: 'r', effectiveRequestDigest: 'b'.repeat(64) }, recordedAt: 3 })
    ledger.recordIntent({ identity, expectedRevision: 1, intent: { runtimeRunId: 'r', invocationId: 'i', toolName: 'local.fixture', argsDigest: 'c'.repeat(64) }, recordedAt: 4 })
    ledger.recordOutcome({ identity, expectedRevision: 2, invocationId: 'i', outcome: { kind: 'unknown', resultDigest: 'd'.repeat(64) }, recordedAt: 5 })
    const count = events.countEvents(), replay = managed.startFirstAttempt(start())
    expect(replay.inserted).toBe(false); expect(replay.attempt.state.reviewRequired).toBe(true); expect(replay.attempt.state.unknownIntents).toBe(1); expect(managed.createRoot(birth()).coverage.state.status).toBe('dirty'); expect(events.countEvents()).toBe(count)
    expect(() => managed.startFirstAttempt({ ...start(), idempotencyKey: 'new', expectedRevision: 1, expectedCoverageRevision: 1, startedAt: 6 })).toThrow(failure)
  })
  it('does not infer clean from zero pending intents or all reported results', () => {
    const { managed, ledger } = open(); managed.createRoot(birth()); const identity = managed.startFirstAttempt(start()).attempt.state.identity
    ledger.bindRuntime({ identity, expectedRevision: 0, binding: { runtimeRunId: 'r', effectiveRequestDigest: 'b'.repeat(64) }, recordedAt: 3 })
    ledger.recordIntent({ identity, expectedRevision: 1, intent: { runtimeRunId: 'r', invocationId: 'i', toolName: 'local.fixture', argsDigest: 'c'.repeat(64) }, recordedAt: 4 })
    ledger.recordOutcome({ identity, expectedRevision: 2, invocationId: 'i', outcome: { kind: 'reported-result', resultDigest: 'd'.repeat(64) }, recordedAt: 5 })
    expect(managed.startFirstAttempt(start()).attempt.state.pendingIntents).toBe(0); expect(managed.getCoverage('root')?.state.status).toBe('dirty'); expect(() => managed.startFirstAttempt({ ...start(), idempotencyKey: 'new' })).toThrow(failure)
  })
  it('validates a typed exact mutation receipt past the old 1000 mutation prefix', () => {
    const { events, plain } = open(); plain.create(birth())
    const commands = Array.from({ length: 1002 }, (_, index) => ({ operation: 'update' as const, kind: 'agent-instance', id: 'root', state: instance(), expectedRevision: index, idempotencyKey: `bulk:${index}`, createdAt: index + 2, event: { protocolVersion: '2.0.0', id: `bulk:${index}:event`, type: 'fixture.same-state', envelopeKind: 'event' as const, streamId: 'agent-instance:root:stream', sequence: index + 1, createdAt: index + 2, payload: {} } }))
    for (let offset = 0; offset < commands.length; offset += 100) events.mutateResourcesBatch(commands.slice(offset, offset + 100))
    expect(events.listResourceMutations('agent-instance', 'root', 1000).find(row => row.idempotencyKey === 'bulk:1001')).toBeUndefined()
    const receipt = events.getResourceMutation('bulk:1001'); expect(receipt?.resource.revision).toBe(1002); expect(receipt?.eventId).toBe('bulk:1001:event'); expect(Object.isFrozen(receipt)).toBe(true); expect(events.getResourceMutation('not-committed')).toBeUndefined()
    expect(() => events.getResourceMutation('')).toThrow(); expect(events.getResourceMutation(' bulk:1001')).toBeUndefined()
  })
  it('captures nested child data before exact receipt/read callouts', () => {
    const { managed, events } = open(); managed.createRoot(birth()); const input = child(), get = events.getResourceMutation.bind(events); let changed = false
    vi.spyOn(events, 'getResourceMutation').mockImplementation(key => { if (!changed) { changed = true; input.parentExpectedRevision = 99; input.instance.parentInstanceId = 'foreign'; (input.instance.limits as { allowedToolNames: readonly string[] }).allowedToolNames = ['foreign'] } return get(key) })
    const result = managed.reserveChild(input); expect(result.instance.state.parentInstanceId).toBe('root'); expect(result.instance.state.limits.allowedToolNames).toEqual(['local.fixture']); expect(result.parent.revision).toBe(1); expect(input.parentExpectedRevision).toBe(99)
  })
  it('refuses caller-supplied generation attempt or coverage fields without writes', () => {
    const { managed, events } = open()
    expect(() => managed.createRoot({ ...birth(), generation: 'caller' } as ReturnType<typeof birth>)).toThrow(/field/i)
    expect(() => managed.createRoot({ ...birth(), baseline: 'clean' } as ReturnType<typeof birth>)).toThrow(/field/i)
    managed.createRoot(birth()); const count = events.countEvents()
    expect(() => managed.startFirstAttempt({ ...start(), attemptId: 'caller' } as ManagedAgentFirstStartInput)).toThrow(/field/i); expect(events.countEvents()).toBe(count)
  })
  it('rejects toJSON named-array accessors and cycles without invoking executable data', () => {
    const { managed, events } = open(); let calls = 0
    const malicious = { ...birth(), toJSON() { calls++; return birth() } }
    expect(() => managed.createRoot(malicious)).toThrow(/JSON|field|data/i)
    const input = birth(), tools = input.instance.limits.allowedToolNames as string[]; Object.defineProperty(tools, '0', { enumerable: true, get() { calls++; return 'local.fixture' } })
    expect(() => managed.createRoot(input)).toThrow(/JSON|field|data/i)
    const cyclic = birth() as ReturnType<typeof birth> & { self?: unknown }; cyclic.self = cyclic
    expect(() => managed.createRoot(cyclic)).toThrow(/cyclic/i); expect(calls).toBe(0); expect(events.countEvents()).toBe(0)
  })
  it.each(['root', 'child', 'start'] as const)('rolls back every %s batch part on resource/event/receipt insertion failure', operation => {
    // Every stage of every part, not only the outer before-commit hook.
    for (const table of ['resources', 'events', 'resource_mutations']) {
      for (let part = 1; part <= (operation === 'root' ? 2 : 3); part++) {
        const { managed, events, plain } = open(); if (operation !== 'root') managed.createRoot(birth())
        const before = { count: events.countEvents(), resources: events.listResources({ includeDeleted: true }) }, original = NodeSQLiteAdapter.prototype.prepare; let writes = 0
        const spy = vi.spyOn(NodeSQLiteAdapter.prototype, 'prepare').mockImplementation(function (this: NodeSQLiteAdapter, sql: string) {
          if (new RegExp(`(?:INSERT INTO|UPDATE) ${table}\\s`).test(sql) && ++writes === part) throw Error(`injected ${operation} ${table} part${part}`)
          return original.call(this, sql)
        })
        const invoke = () => operation === 'root' ? managed.createRoot(birth()) : operation === 'child' ? managed.reserveChild(child()) : managed.startFirstAttempt(start())
        try { expect(invoke).toThrow(`injected ${operation} ${table} part${part}`) } finally { spy.mockRestore() }
        expect(events.countEvents()).toBe(before.count); expect(events.listResources({ includeDeleted: true })).toEqual(before.resources)
        expect(plain.get(operation === 'child' ? 'child' : 'root')?.state.status).toBe(operation === 'root' || operation === 'child' ? undefined : 'created')
        expect(invoke().inserted).toBe(true)
      }
    }
  })
  it('rejects tombstoned instance and attempt as well as corrupted coverage counters', () => {
    for (const target of ['instance', 'attempt', 'coverage']) {
      const { managed, events } = open(); managed.createRoot(birth()); const accepted = managed.startFirstAttempt(start())
      const row = target === 'instance' ? accepted.instance : target === 'attempt' ? accepted.attempt : accepted.coverage
      events.mutateResource({ operation: target === 'coverage' ? 'update' : 'delete', kind: row.kind, id: row.id, expectedRevision: row.revision,
        ...(target === 'coverage' ? { state: { ...accepted.coverage.state, status: 'virgin' } } : {}), idempotencyKey: `corrupt:${target}`, createdAt: 3,
        event: { protocolVersion: '2.0.0', id: `corrupt:${target}:event`, envelopeKind: 'event', type: 'fixture.corrupt', streamId: `${row.kind}:${row.id}:stream`, sequence: row.revision + 1, createdAt: 3, payload: {} } })
      expect(() => managed.startFirstAttempt(start())).toThrow(failure); expect(() => managed.createRoot(birth())).toThrow(failure)
    }
  })
  it('preserves default create pre-read command key when a store callout mutates the caller', () => {
    const { plain, events } = open(), input = birth(), get = events.getResource.bind(events)
    const spy = vi.spyOn(events, 'getResource').mockImplementation((kind, id, options) => { input.idempotencyKey = 'changed'; return get(kind, id, options) })
    const created = plain.create(input); spy.mockRestore()
    expect(events.getResourceMutation('agent-instance:root:create:birth:root')?.resource).toEqual(created)
    expect(events.getResourceMutation('agent-instance:root:create:changed')).toBeUndefined()
    expect(plain.create(birth())).toEqual(created)
  })
  it('preserves default create pre-read state digest instead of recomputing after a read', () => {
    const { plain, events } = open(), input = birth(), digest = sha256PolicyText(canonicalPolicyJson(input.instance as never)), get = events.getResource.bind(events)
    const spy = vi.spyOn(events, 'getResource').mockImplementation((kind, id, options) => { (input.instance as { name: string }).name = 'changed-after-digest'; return get(kind, id, options) })
    plain.create(input); spy.mockRestore()
    const mutation = events.getResourceMutation('agent-instance:root:create:birth:root')!
    expect(events.getEvent(mutation.eventId)?.payload).toMatchObject({ stateDigest: digest })
  })
  it('preserves default direct transition pre-read command key across a read callback', () => {
    const { plain, events } = open(); plain.create(birth())
    const input = { instanceId: 'root', expectedRevision: 0, status: 'running' as const, transitionedAt: 2, idempotencyKey: 'original' }, initial = { ...input }, get = events.getResource.bind(events)
    const spy = vi.spyOn(events, 'getResource').mockImplementation((kind, id, options) => { input.idempotencyKey = 'changed'; return get(kind, id, options) })
    const running = plain.transition(input); spy.mockRestore()
    expect(events.getResourceMutation('agent-instance:root:transition:original')?.resource).toEqual(running)
    expect(events.getResourceMutation('agent-instance:root:transition:changed')).toBeUndefined()
    expect(plain.transition(initial)).toEqual(running)
  })
  it('preserves default child-created payload parent from the actual reserved parent', () => {
    const { plain, events } = open(); plain.create(birth()); const input = { parentInstanceId: 'root', parentExpectedRevision: 0, child: child().instance, createdAt: 2, idempotencyKey: 'child' }, get = events.getResource.bind(events)
    const spy = vi.spyOn(events, 'getResource').mockImplementation((kind, id, options) => { input.child.parentInstanceId = 'other'; return get(kind, id, options) })
    plain.reserveChild(input); spy.mockRestore()
    const created = events.getResourceMutation('agent-instance:child:create:child')!
    expect(events.getEvent(created.eventId)?.payload).toMatchObject({ parentInstanceId: 'root' })
    expect(created.resource.state).toMatchObject({ parentInstanceId: 'other' }) // Existing default mutability, not new snapshot semantics.
  })
  it('loses an instance CAS race to another live same-file connection without partial attempt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'managed-atomic-cas-')); directories.push(directory); const file = join(directory, 'owned.sqlite')
    const first = open(file); first.managed.createRoot(birth()); const second = open(file), commit = first.events.mutateResourcesBatch.bind(first.events)
    let other: ReturnType<PersistentManagedAgentInstanceStore['startFirstAttempt']> | undefined
    vi.spyOn(first.events, 'mutateResourcesBatch').mockImplementation((plans, fence) => {
      other = second.managed.startFirstAttempt({ ...start(), idempotencyKey: 'winner' }); return commit(plans, fence)
    })
    expect(() => first.managed.startFirstAttempt(start())).toThrow(/revision|conflict/i)
    expect(other?.inserted).toBe(true); expect(first.events.countEvents()).toBe(5)
    expect(first.events.countResources({ kind: 'managed-agent-execution-attempt' })).toBe(1)
    expect(first.managed.getCoverage('root')?.state.accepted?.identity).toEqual(other?.attempt.state.identity)
  })
  it('rolls back staged instance when coverage CAS alone changes in another connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'managed-atomic-coverage-cas-')); directories.push(directory); const file = join(directory, 'owned.sqlite')
    const first = open(file), born = first.managed.createRoot(birth()), second = open(file), commit = first.events.mutateResourcesBatch.bind(first.events)
    vi.spyOn(first.events, 'mutateResourcesBatch').mockImplementation((plans, fence) => {
      second.events.mutateResource({ operation: 'update', kind: MANAGED_AGENT_COVERAGE_KIND, id: born.coverage.id, expectedRevision: 0, state: born.coverage.state,
        createdAt: 2, idempotencyKey: 'external-coverage-change', event: { protocolVersion: '2.0.0', id: 'external-coverage-event', type: 'fixture.unsupported-coverage-change',
          envelopeKind: 'event', streamId: `${MANAGED_AGENT_COVERAGE_KIND}:${born.coverage.id}:stream`, sequence: 1, createdAt: 2, payload: {} } })
      return commit(plans, fence)
    })
    expect(() => first.managed.startFirstAttempt(start())).toThrow(/revision|conflict/i)
    expect(first.plain.get('root')).toEqual(born.instance); expect(first.events.countEvents()).toBe(3)
    expect(first.events.countResources({ kind: 'managed-agent-execution-attempt' })).toBe(0); expect(() => first.managed.getCoverage('root')).toThrow(failure)
  })
  it('refuses a concurrent before-commit attempt on a second real SQLite connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'managed-atomic-lock-')); directories.push(directory); const file = join(directory, 'owned.sqlite')
    const first = open(file); first.managed.createRoot(birth()); const second = open(file); let blocked = false
    _crashTesting.setHook(stage => {
      if (stage !== 'resource.before-commit') return
      expect(() => second.managed.startFirstAttempt({ ...start(), idempotencyKey: 'contender' })).toThrow(/lock|busy|conflict/i); blocked = true
    })
    const accepted = first.managed.startFirstAttempt(start()); _crashTesting.setHook(null)
    expect(blocked).toBe(true); expect(second.managed.getCoverage('root')?.state.accepted?.identity).toEqual(accepted.attempt.state.identity)
    expect(second.events.countEvents()).toBe(5); expect(second.events.countResources({ kind: 'managed-agent-execution-attempt' })).toBe(1)
  })
  it('reopens exact paired state in a separate SQLite connection without fabricating dispatch authority', () => {
    const directory = mkdtempSync(join(tmpdir(), 'managed-atomic-instance-')); directories.push(directory); const file = join(directory, 'owned.sqlite')
    const first = open(file); first.managed.createRoot(birth()); const accepted = first.managed.startFirstAttempt(start()); first.events.close(); stores.splice(stores.indexOf(first.events), 1)
    const reopened = open(file), count = reopened.events.countEvents(), replay = reopened.managed.startFirstAttempt(start())
    expect(replay).toEqual({ ...accepted, inserted: false }); expect(reopened.events.countEvents()).toBe(count)
    expect(() => reopened.managed.startFirstAttempt({ ...start(), idempotencyKey: 'new' })).toThrow(failure)
  })
})
