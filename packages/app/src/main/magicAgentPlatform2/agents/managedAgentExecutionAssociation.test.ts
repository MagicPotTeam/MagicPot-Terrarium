import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:fs', async importActual => importActual())
import { getAgentSessionKey } from '../../../shared/agent/sessionIdentity'
import { canonicalPolicyJson, sha256PolicyText } from '../../../shared/magicAgentPlatform2/policy'
import type { MagicAgentInstanceState } from '../../../shared/magicAgentPlatform2/agentInstance'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { _crashTesting } from '../persistence/crashHooks'
import { CooperativeExecutionController } from './cooperativeExecutionController'
import { PersistentAgentInstanceStore, prepareAgentInstanceTransition } from './persistentAgentInstanceStore'
import { PersistentManagedAgentExecutionStore } from './persistentManagedAgentExecutionStore'
import { PersistentManagedAgentInstanceStore } from './persistentManagedAgentInstanceStore'
import { ManagedExecutionAssociationIssuer, type ManagedAssociationOwner, type ManagedAssistantIngress, type ManagedExecutionAssociation } from './managedAgentExecutionAssociation'

const stores: MagicAgentEventStore[] = [], directories: string[] = []
const state = (id = 'root'): MagicAgentInstanceState => ({ id, name: id, definitionId: 'definition', configVersion: 'config', depth: 0, status: 'created', limits: { maxChildren: 2, maxDepth: 2, maxConcurrency: 1, maxRuntimeMs: 1000, allowedToolNames: ['fixture'], workspaceRoots: ['C:\\owned'] } })
const start = (id = 'root') => ({ instanceId: id, expectedRevision: 0, expectedCoverageRevision: 0, authorizedRequestDigest: 'a'.repeat(64), startedAt: 2, idempotencyKey: `first:${id}` })
const ingress = (): ManagedAssistantIngress => ({ route: { channel: 'generic', scopeType: 'dm', scopeId: 'root' }, text: 'local fixture', execution: { allowedToolNames: ['fixture'], maxToolCalls: 1 }, attachments: [{ type: 'file', url: 'owned', metadata: { ownUndefined: undefined } }] })
function fixture(database = ':memory:') {
  const events = new MagicAgentEventStore(database); stores.push(events)
  const managed = new PersistentManagedAgentInstanceStore(events), ledger = new PersistentManagedAgentExecutionStore(events), plain = new PersistentAgentInstanceStore(events)
  const owner: ManagedAssociationOwner = { controller: new AbortController(), cooperativeExecution: new CooperativeExecutionController(), phase: 'running', stopRequested: false }
  // Deliberately test-only MAIN map, not ProductionAgentInstanceLifecycleService.active.
  const ownership = { active: new Map([['root', owner]]), closing: false }
  const issuer = new ManagedExecutionAssociationIssuer(events, ownership)
  const context = () => ({ events, owner, controller: owner.controller, cooperativeExecution: owner.cooperativeExecution })
  const birth = (id = 'root') => managed.createRoot({ instance: state(id), createdAt: 1, idempotencyKey: `birth:${id}` })
  return { events, managed, ledger, plain, owner, ownership, issuer, context, birth }
}
const failure = /association|issuer|claim|owner|closed|replay|fresh|phase|identity|ingress|plain|data|proxy|getter|field|resume|continue|revision|conflict|bound|dirty|coverage|invalid/i
function containsReference(root: unknown, target: unknown, seen = new Set<object>()): boolean {
  if (root === target) return true
  if (!root || typeof root !== 'object' || seen.has(root)) return false
  seen.add(root)
  return Reflect.ownKeys(root).some(key => { const descriptor = Object.getOwnPropertyDescriptor(root, key); return descriptor && 'value' in descriptor && containsReference(descriptor.value, target, seen) })
}
afterEach(() => { _crashTesting.setHook(null); vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('isolated MAIN execution association prerequisite, not runtime or admission', () => {
  it('issues a property-free handle only from its fresh atomic start and claims once without durable binding', () => {
    const f = fixture(); f.birth(); const request = ingress(), handle = f.issuer.begin(start(), f.owner, request)
    expect(Object.isFrozen(handle)).toBe(true); expect(Object.getPrototypeOf(handle)).toBeNull(); expect(Reflect.ownKeys(handle)).toEqual([])
    const before = f.events.countEvents(), claimed = f.issuer.claim(handle, f.context(), request)
    expect(before).toBe(5); expect(f.events.countEvents()).toBe(before); expect(claimed.identity.authorizedRequestDigest).toBe('a'.repeat(64))
    expect(claimed.sessionKey).toBe('generic:dm:root'); expect(claimed.ingressDigest).toBe(sha256PolicyText(canonicalPolicyJson({ domain: 'assistant-ingress/v1', material: claimed.ingress } as never)))
    expect(claimed.ingressDigest).not.toBe(claimed.identity.authorizedRequestDigest); expect(f.ledger.getAttempt(claimed.identity)?.revision).toBe(0); expect(f.ledger.getAttempt(claimed.identity)?.state.binding).toBeUndefined()
    expect(f.managed.getCoverage('root')?.state.status).toBe('dirty'); expect(Object.isFrozen(claimed.ingress.attachments?.[0].metadata)).toBe(true)
    expect(() => f.issuer.claim(handle, f.context(), request)).toThrow(failure)
  })
  it('never mints from an exact start replay or copied/restored DTO and exposes no mint-from-result method', () => {
    const f = fixture(); f.birth(); const accepted = f.managed.startFirstAttempt({ ...start(), sessionKey: getAgentSessionKey(ingress().route) }), count = f.events.countEvents()
    expect(() => f.issuer.begin(start(), f.owner, ingress())).toThrow(failure); expect(f.events.countEvents()).toBe(count)
    expect('mintFromResult' in f.issuer || 'fromReceipt' in f.issuer || 'bindRuntime' in f.issuer || 'markClean' in f.issuer).toBe(false)
    expect(() => f.issuer.begin({ ...start(), attemptId: accepted.attempt.state.identity.attemptId } as ReturnType<typeof start>, { ...f.owner }, ingress())).toThrow(failure)
  })
  it('refuses legacy birth without silently creating coverage', () => {
    const f = fixture(); f.plain.create({ instance: state(), createdAt: 1, idempotencyKey: 'old' })
    expect(() => f.issuer.begin(start(), f.owner, ingress())).toThrow(failure); expect(f.managed.getCoverage('root')).toBeUndefined(); expect(f.events.countEvents()).toBe(1)
  })
  it.each(['resource.before-commit', 'resource.after-commit'] as const)('burns issuing reservation on %s failure, never recovers a handle', stage => {
    const f = fixture(); f.birth(); _crashTesting.setHook(current => { if (current === stage) throw Error('association transaction fixture') })
    expect(() => f.issuer.begin(start(), f.owner, ingress())).toThrow('association transaction fixture'); _crashTesting.setHook(null)
    expect(f.managed.getCoverage('root')?.state.status).toBe(stage === 'resource.before-commit' ? 'virgin' : 'dirty')
    expect(() => f.issuer.begin(start(), f.owner, ingress())).toThrow(failure)
    if (stage === 'resource.after-commit') expect(f.managed.startFirstAttempt({ ...start(), sessionKey: getAgentSessionKey(ingress().route) }).inserted).toBe(false)
  })
  it('reserves issuing before a reentrant store read and cannot issue two handles', () => {
    const f = fixture(); f.birth(); const get = f.events.getEvent.bind(f.events); let reentered = false
    vi.spyOn(f.events, 'getEvent').mockImplementation(id => { if (!reentered) { reentered = true; expect(() => f.issuer.begin(start(), f.owner, ingress())).toThrow(failure) } return get(id) })
    const handle = f.issuer.begin(start(), f.owner, ingress()); expect(reentered).toBe(true); expect(f.issuer.claim(handle, f.context(), ingress()).identity.attemptId).toMatch(/^[a-f0-9-]{36}$/); expect(f.events.countEvents()).toBe(5)
  })
  it('reserves claiming before a reentrant read; duplicate rejection does not disturb the original claim', () => {
    const f = fixture(); f.birth(); const handle = f.issuer.begin(start(), f.owner, ingress()), get = f.events.getResource.bind(f.events); let reentered = false
    vi.spyOn(f.events, 'getResource').mockImplementation((...args) => { if (!reentered) { reentered = true; expect(() => f.issuer.claim(handle, f.context(), ingress())).toThrow(failure) } return get(...args) })
    const result = f.issuer.claim(handle, f.context(), ingress()); expect(reentered).toBe(true); expect(result.sessionKey).toBe('generic:dm:root'); expect(() => f.issuer.claim(handle, f.context(), ingress())).toThrow(failure)
  })
  it.each(['clone', 'proxy', 'foreignIssuer'] as const)('rejects %s identity without burning the original exact handle', kind => {
    const f = fixture(); f.birth(); const handle = f.issuer.begin(start(), f.owner, ingress()); let trapCalls = 0
    if (kind === 'foreignIssuer') expect(() => new ManagedExecutionAssociationIssuer(f.events, f.ownership).claim(handle, f.context(), ingress())).toThrow(failure)
    else { const substitute = kind === 'clone' ? { ...handle } : new Proxy(handle, { get() { trapCalls++; throw Error('proxy trap executed') } }); expect(() => f.issuer.claim(substitute as ManagedExecutionAssociation, f.context(), ingress())).toThrow(failure) }
    expect(trapCalls).toBe(0); expect(f.issuer.claim(handle, f.context(), ingress()).identity.instanceId).toBe('root')
  })
  it.each(['events', 'owner', 'controller', 'cooperativeExecution'] as const)('burns recognized claim with wrong exact %s and cannot retry', key => {
    const f = fixture(); f.birth(); const handle = f.issuer.begin(start(), f.owner, ingress()), context = f.context(), other = fixture()
    const wrong = { ...context, [key]: key === 'events' ? other.events : key === 'owner' ? { ...f.owner } : key === 'controller' ? new AbortController() : new CooperativeExecutionController() }
    expect(() => f.issuer.claim(handle, wrong, ingress())).toThrow(failure); expect(() => f.issuer.claim(handle, context, ingress())).toThrow(failure)
  })
  it.each(['finishing', 'faulted', 'starting', 'stopRequested', 'aborted', 'removed', 'replaced', 'controller', 'cooperativeExecution', 'closing', 'issuerClose', 'storeClose'] as const)('rejects %s lifetime change before claim', mutation => {
    const f = fixture(); f.birth(); const handle = f.issuer.begin(start(), f.owner, ingress()), context = f.context()
    if (mutation === 'finishing' || mutation === 'faulted' || mutation === 'starting') f.owner.phase = mutation
    else if (mutation === 'stopRequested') f.owner.stopRequested = true
    else if (mutation === 'aborted') f.owner.controller.abort(Error('fixture stop'))
    else if (mutation === 'removed') f.ownership.active.delete('root')
    else if (mutation === 'replaced') f.ownership.active.set('root', { ...f.owner })
    else if (mutation === 'controller') f.owner.controller = new AbortController()
    else if (mutation === 'cooperativeExecution') f.owner.cooperativeExecution = new CooperativeExecutionController()
    else if (mutation === 'closing') f.ownership.closing = true
    else if (mutation === 'issuerClose') f.issuer.close()
    else f.events.close()
    expect(() => f.issuer.claim(handle, context, ingress())).toThrow()
  })
  it('rechecks owner liveness after supported read callouts and burns claim', () => {
    const f = fixture(); f.birth(); const handle = f.issuer.begin(start(), f.owner, ingress()), get = f.events.getResource.bind(f.events); let changed = false
    vi.spyOn(f.events, 'getResource').mockImplementation((...args) => { if (!changed) { changed = true; f.owner.stopRequested = true } return get(...args) })
    expect(() => f.issuer.claim(handle, f.context(), ingress())).toThrow(failure); f.owner.stopRequested = false
    expect(() => f.issuer.claim(handle, f.context(), ingress())).toThrow(failure)
  })
  it('rechecks issuer close during fresh start publication without returning a handle', () => {
    const f = fixture(); f.birth(); _crashTesting.setHook(stage => { if (stage === 'resource.after-commit') f.issuer.close() })
    expect(() => f.issuer.begin(start(), f.owner, ingress())).toThrow(failure); _crashTesting.setHook(null); expect(f.managed.getCoverage('root')?.state.status).toBe('dirty')
  })
  it('captures start and ingress before store callouts while caller objects remain mutable', () => {
    const f = fixture(); f.birth(); const command = start(), request = ingress(), get = f.events.getEvent.bind(f.events); let mutated = false
    vi.spyOn(f.events, 'getEvent').mockImplementation(id => { if (!mutated) { mutated = true; command.authorizedRequestDigest = 'f'.repeat(64); request.text = 'changed'; request.route.scopeId = 'foreign'; request.execution!.allowedToolNames!.push('foreign') } return get(id) })
    const handle = f.issuer.begin(command, f.owner, request), result = f.issuer.claim(handle, f.context(), ingress())
    expect(result.identity.authorizedRequestDigest).toBe('a'.repeat(64)); expect(result.ingress.text).toBe('local fixture'); expect(result.ingress.execution?.allowedToolNames).toEqual(['fixture']); expect(request.text).toBe('changed'); expect(Object.isFrozen(request.route)).toBe(false)
  })
  it('distinguishes own undefined from omission in material without changing authorization digest', () => {
    const a = fixture(); a.birth(); const request = ingress(), handle = a.issuer.begin(start(), a.owner, request), first = a.issuer.claim(handle, a.context(), request)
    const b = fixture(); b.birth(); const omitted = ingress(); delete omitted.attachments![0].metadata!.ownUndefined; const other = b.issuer.begin(start(), b.owner, omitted), second = b.issuer.claim(other, b.context(), omitted)
    expect(Object.hasOwn(first.ingress.attachments![0].metadata!, 'ownUndefined')).toBe(true); expect(first.ingressDigest).not.toBe(second.ingressDigest); expect(first.identity.authorizedRequestDigest).toBe(second.identity.authorizedRequestDigest)
  })
  it.each(['getter', 'proxy', 'cycle', 'sparse', 'function', 'nonfinite'] as const)('rejects %s material before store calls without executing accessors', kind => {
    const f = fixture(); f.birth(); let calls = 0; const request = ingress(), get = vi.spyOn(f.events, 'getResource')
    if (kind === 'getter') Object.defineProperty(request, 'text', { enumerable: true, get() { calls++; return 'bad' } })
    else if (kind === 'proxy') request.route = new Proxy(request.route, { ownKeys() { calls++; throw Error('trap') } })
    else if (kind === 'cycle') request.attachments![0].metadata!.cycle = request
    else if (kind === 'sparse') request.attachments = new Array(2)
    else if (kind === 'function') request.attachments![0].metadata!.call = () => { calls++ }
    else request.temperature = NaN
    expect(() => f.issuer.begin(start(), f.owner, request)).toThrow(); expect(calls).toBe(0); expect(get).not.toHaveBeenCalled(); expect(f.events.countEvents()).toBe(2)
  })
  it.each(['continueFromRunId', 'resumeFromRunId', 'signal', 'cooperativeExecution', 'toolProvider', 'onEvent', 'metadata'] as const)('rejects unsupported %s at material boundary', field => {
    const f = fixture(); f.birth(); const request = { ...ingress(), [field]: field.includes('RunId') ? 'prior' : undefined }
    expect(() => f.issuer.begin(start(), f.owner, request)).toThrow(failure); expect(f.events.countEvents()).toBe(2)
  })
  it('compares exact normalized route fields even when colon-joined session strings collide', () => {
    const f = fixture(); f.birth(); const a = ingress(), b = ingress(); a.route.scopeId = 'root:thread:x'; b.route.scopeId = 'root'; b.route.threadId = 'x'
    expect(getAgentSessionKey(a.route)).toBe(getAgentSessionKey(b.route)); const handle = f.issuer.begin(start(), f.owner, a)
    expect(() => f.issuer.claim(handle, f.context(), b)).toThrow(failure); expect(() => f.issuer.claim(handle, f.context(), a)).toThrow(failure)
  })
  it('accepts equivalent normalization but rejects sender or material substitutions', () => {
    const f = fixture(); f.birth(); const request = ingress(); request.route.channel = ' generic '; request.route.scopeId = ' root '
    const handle = f.issuer.begin(start(), f.owner, request); expect(f.issuer.claim(handle, f.context(), ingress()).sessionKey).toBe('generic:dm:root')
    const b = fixture(); b.birth(); const second = b.issuer.begin(start(), b.owner, ingress()), changed = ingress(); changed.route.senderId = 'other'
    expect(() => b.issuer.claim(second, b.context(), changed)).toThrow(failure)
  })
  it('refuses a lower-level bound or stopped attempt and never clears dirty state', () => {
    const f = fixture(); f.birth(); const handle = f.issuer.begin(start(), f.owner, ingress()), accepted = f.managed.startFirstAttempt({ ...start(), sessionKey: getAgentSessionKey(ingress().route) })
    f.ledger.bindRuntime({ identity: accepted.attempt.state.identity, expectedRevision: 0, binding: { runtimeRunId: 'fixture-not-runtime', effectiveRequestDigest: 'b'.repeat(64) }, recordedAt: 3 })
    expect(() => f.issuer.claim(handle, f.context(), ingress())).toThrow(failure); expect(f.managed.getCoverage('root')?.state.status).toBe('dirty')
    const b = fixture(); b.birth(); const stopped = b.issuer.begin(start(), b.owner, ingress())
    expect(() => b.plain.stop({ instanceId: 'root', expectedRevision: 1, transitionedAt: 3, idempotencyKey: 'stop' })).toThrow(/managed.*ordinary/i)
    // Unsupported historical stopped evidence is a raw fixture, never a plain
    // production mutator bypass or a positive bounded-completion proof.
    b.events.mutateResource(prepareAgentInstanceTransition(b.plain.get('root')!, 'stopped', 3, 'historical-stop'))
    expect(() => b.issuer.claim(stopped, b.context(), ingress())).toThrow(failure)
  })
  it('closed issuer cannot be reopened or used to begin again', () => {
    const f = fixture(); f.birth(); f.issuer.close(); f.ownership.closing = false
    expect(() => f.issuer.begin(start(), f.owner, ingress())).toThrow(failure); expect(f.events.countEvents()).toBe(2)
  })
  it('cannot turn a receipt on a reopened same-file store into a new handle', () => {
    const directory = mkdtempSync(join(tmpdir(), 'association-')); directories.push(directory); const database = join(directory, 'owned.sqlite'), f = fixture(database); f.birth(); const handle = f.issuer.begin(start(), f.owner, ingress()); f.events.close()
    const g = fixture(database); expect(() => g.issuer.claim(handle, g.context(), ingress())).toThrow(failure); expect(() => g.issuer.begin(start(), g.owner, ingress())).toThrow(failure); expect(g.events.countEvents()).toBe(5)
  })
  it('keeps every reference to handle/owner/store out of claim material and fixture contexts, not merely JSON', () => {
    const f = fixture(); f.birth(); const request = ingress(), handle = f.issuer.begin(start(), f.owner, request), claimed = f.issuer.claim(handle, f.context(), request)
    const providerContext = { route: claimed.ingress.route, sessionKey: claimed.sessionKey }, toolContext = { request: claimed.ingress, metadata: {} }
    for (const root of [request, claimed, providerContext, toolContext]) for (const privateValue of [handle, f.owner, f.events, f.owner.controller, f.owner.cooperativeExecution]) expect(containsReference(root, privateValue)).toBe(false)
    expect(Reflect.ownKeys(f.issuer)).toEqual([]); expect(f.ledger.getAttempt(claimed.identity)?.state.binding).toBeUndefined()
  })
  it('rejects owner accessors without executing them or enabling a reentrant begin', () => {
    const f = fixture(); f.birth(); let getterCalls = 0
    const controller = f.owner.controller
    Object.defineProperty(f.owner, 'controller', { enumerable: true, get() { getterCalls++; return controller } })
    expect(() => f.issuer.begin(start(), f.owner, ingress())).toThrow(failure)
    expect(getterCalls).toBe(0); expect(f.events.countEvents()).toBe(2)
  })
  it('rejects owner accessor replacement after issue without executing getter', () => {
    const f = fixture(); f.birth(); const handle = f.issuer.begin(start(), f.owner, ingress()), context = f.context(); let getterCalls = 0
    Object.defineProperty(f.owner, 'phase', { enumerable: true, get() { getterCalls++; return 'running' } })
    expect(() => f.issuer.claim(handle, context, ingress())).toThrow(failure); expect(getterCalls).toBe(0)
  })
  it.each(['depth', 'nodes', 'stringUnits'] as const)('enforces bounded ingress capture for %s before store callouts', kind => {
    const f = fixture(); f.birth(); const request = ingress(), metadata = request.attachments![0].metadata!, get = vi.spyOn(f.events, 'getResource')
    if (kind === 'depth') { let node = metadata; for (let index = 0; index < 30; index++) { node.next = {}; node = node.next as Record<string, unknown> } }
    else if (kind === 'nodes') metadata.nodes = Array.from({ length: 8192 }, () => null)
    else request.text = 'x'.repeat(4 * 1024 * 1024 + 1)
    expect(() => f.issuer.begin(start(), f.owner, request)).toThrow(/bound|fields/i); expect(get).not.toHaveBeenCalled(); expect(f.events.countEvents()).toBe(2)
  })
  it('route own undefined is distinct from omission and cannot be substituted during claim', () => {
    const a = fixture(); a.birth(); const withUndefined = ingress(); withUndefined.route.senderId = undefined
    const handle = a.issuer.begin(start(), a.owner, withUndefined)
    expect(() => a.issuer.claim(handle, a.context(), ingress())).toThrow(failure)
    expect(() => a.issuer.claim(handle, a.context(), withUndefined)).toThrow(failure)
    const b = fixture(); b.birth(); const explicit = ingress(); explicit.route.senderId = undefined
    const second = b.issuer.begin(start(), b.owner, explicit), explicitClaim = b.issuer.claim(second, b.context(), explicit)
    const c = fixture(); c.birth(); const third = c.issuer.begin(start(), c.owner, ingress()), omittedClaim = c.issuer.claim(third, c.context(), ingress())
    expect(Object.hasOwn(explicitClaim.ingress.route, 'senderId')).toBe(true)
    expect(explicitClaim.ingressDigest).not.toBe(omittedClaim.ingressDigest)
  })
  it('burns owner reservation after rejecting an owner accessor, without invoking it or allowing retry', () => {
    const f = fixture(); f.birth(); f.birth('second'); f.ownership.active.set('second', f.owner); const original = f.owner.controller; let calls = 0
    Object.defineProperty(f.owner, 'controller', { configurable: true, enumerable: true, get() { calls++; f.issuer.begin(start('second'), f.owner, ingress()); return original } })
    expect(() => f.issuer.begin(start(), f.owner, ingress())).toThrow(failure); expect(calls).toBe(0)
    Object.defineProperty(f.owner, 'controller', { configurable: true, enumerable: true, value: original })
    expect(() => f.issuer.begin(start(), f.owner, ingress())).toThrow(failure)
    expect(() => f.issuer.begin(start('second'), f.owner, ingress())).toThrow(failure); expect(f.events.countEvents()).toBe(4)
  })
  it('fixture entry consumes association before its fake preparation, never actual runtime or durable binding', () => {
    const f = fixture(); f.birth(); const handle = f.issuer.begin(start(), f.owner, ingress()), prepare = vi.fn()
    const fakeEntry = () => { const claim = f.issuer.claim(handle, f.context(), ingress()); prepare(claim.sessionKey); return claim }
    const claim = fakeEntry(); expect(prepare).toHaveBeenCalledExactlyOnceWith('generic:dm:root'); expect(() => fakeEntry()).toThrow(failure); expect(prepare).toHaveBeenCalledTimes(1)
    expect(f.ledger.getAttempt(claim.identity)?.state.binding).toBeUndefined(); expect(f.events.countEvents()).toBe(5)
  })
})
