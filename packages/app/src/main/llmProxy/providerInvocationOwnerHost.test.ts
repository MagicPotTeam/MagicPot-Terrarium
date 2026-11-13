import { getEventListeners } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { sideScope as scope, sideTestCodec } from '../api/agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
import { createIsolatedProviderInvocationOwnerHost, ProviderDispatchOwner, type ProviderInvocationOwnerHost } from './providerDispatchOwner'
import { ProviderDispatchLedgerStore, ProviderInvocationLedgerDataStore } from './providerDispatchLedgerStore'
import * as invocationModule from './providerInvocationAdmission'
import type { ProviderInvocationAdmissionOptions } from './providerInvocationAdmission'
import type { InvocationLedgerDocument } from './providerInvocationLedgerPolicy'

const roots: string[] = [], hosts: ProviderInvocationOwnerHost[] = [], owners: ProviderDispatchOwner[] = [], native: NodeSQLiteAdapter[] = [], releases: Array<() => void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  vi.restoreAllMocks(); vi.useRealTimers()
  for (const value of hosts.splice(0)) await value.shutdown().catch(() => undefined)
  for (const value of owners.splice(0)) await value.shutdown().catch(() => undefined)
  for (const db of native.splice(0)) if (db.database.isOpen) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const root = () => { const value = mkdtempSync(path.join(tmpdir(), 'invocation-host-')); roots.push(value); return value }
const endpoint = 'https://model.test/v1/chat/completions'
const post = { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res }); releases.push(() => resolve(undefined as T)); return { promise, resolve } }
async function setup(upgrade = true) {
  const dir = root(), codec = sideTestCodec(), host = await createIsolatedProviderInvocationOwnerHost(dir, codec); hosts.push(host)
  const signal = new AbortController(), fetch = vi.fn<ProviderInvocationAdmissionOptions['fetch']>(async () => new Response('ok'))
  const options: Omit<ProviderInvocationAdmissionOptions, 'store'> = { scope, binding: { goalId: randomUUID(), generation: 1, profileHash: 'a'.repeat(64) }, limits: { maxModelSteps: 2, maxToolInvocations: 2, maxProviderDispatches: 2 }, deadlineAt: Date.now() + 60000, expectedRevision: 1, endpoint, fetch, signal: signal.signal, assertLive() { /* Inert isolated scope; no production user consent. */ } }
  if (upgrade) host.trustedUpgrade(scope, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 })
  return { dir, codec, host, signal, fetch, options, document: () => host.readCurrentData(scope).document as InvocationLedgerDocument }
}

describe('ISOLATED owner-host v2 capability, no production consent/factory/runner', () => {
  it('keeps ordinary construction v1-only, uses an identity-only internal mode and exposes no base-store upgrade or raw store', async () => {
    const dir = root(), codec = sideTestCodec(), owner = new ProviderDispatchOwner(dir, codec); owners.push(owner)
    expect(owner).not.toHaveProperty('trustedUpgrade'); expect(owner).not.toHaveProperty('createInvocationAdmission')
    expect(owner.readCurrentData(scope).document).toMatchObject({ version: 1, revision: 0 })
    expect(() => new ProviderDispatchOwner(root(), codec, Symbol('forged') as never)).toThrow('identity')
    await owner.shutdown()
    const host = await createIsolatedProviderInvocationOwnerHost(dir, codec); hosts.push(host)
    expect(Object.isFrozen(host)).toBe(true); expect(host).not.toHaveProperty('store'); expect(host).not.toHaveProperty('createAdmission'); expect(host).not.toHaveProperty('applyV2')
    expect(host.readCurrentData(scope).document).toMatchObject({ version: 1, revision: 0 })
    const base = Object.create(ProviderDispatchLedgerStore.prototype)
    expect(() => ProviderInvocationLedgerDataStore.prototype.upgradeV2.call(base, scope, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 })).toThrow('isolated')
  })
  it('has one exact DATA ledger connection under the same cooperative ownership lock and refuses a second owner/host without another namespace', async () => {
    const t = await setup(), nativeGets = vi.spyOn(NodeSQLiteAdapter.prototype, 'get')
    expect(() => new ProviderDispatchOwner(t.dir, t.codec)).toThrow()
    await expect(createIsolatedProviderInvocationOwnerHost(t.dir, t.codec)).rejects.toThrow()
    expect(t.document().revision).toBe(1)
    const paths = new Set(nativeGets.mock.instances.map(value => (value as NodeSQLiteAdapter).path))
    expect([...paths].every(file => ['owner-v1.sqlite', 'ledger-v1.sqlite'].includes(path.basename(file)))).toBe(true)
    await t.host.shutdown(); const next = new ProviderDispatchOwner(t.dir, t.codec); owners.push(next)
    expect(next.readCurrentData(scope).document).toMatchObject({ version: 2, revision: 1 })
    expect(() => next.readData(scope)).toThrow('version 2')
  })
  it('opening/reading/rejecting admission never upgrades a missing owner, and explicit upgrade/replay is DATA only', async () => {
    const t = await setup(false)
    expect(() => t.host.createInvocationAdmission({ ...t.options, expectedRevision: 0 })).toThrow('already-v2')
    await Promise.resolve()
    expect(t.host.readCurrentData(scope).document).toMatchObject({ version: 1, revision: 0 })
    const command = { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 } as const
    const result = t.host.trustedUpgrade(scope, command)
    expect(result).toMatchObject({ grantsPermission: false, replay: false, document: { revision: 1 } })
    expect(t.host.trustedUpgrade(scope, command)).toMatchObject({ grantsPermission: false, replay: true })
    expect(t.host.readCurrentData({ ...scope, conversationId: 'other' }).document).toMatchObject({ version: 1, revision: 0 })
    const request = t.host.createInvocationAdmission(t.options)
    expect(() => t.host.trustedUpgrade(scope, command)).toThrow('occupied')
    const value = await request.runModel(async ({ fetch }) => await (await fetch(endpoint, post)).text())
    expect(value.value).toBe('ok'); expect(await request.runTool(value.parent, async () => ({ read_status: true }))).toEqual({ read_status: true })
    request.finish(); await request.drain()
    expect(t.document().runs[0]).toMatchObject({ status: 'finished', charged: { modelStep: 1, toolInvocation: 1, providerDispatch: 1 } })
  })
  it.each(['model', 'tool'] as const)('shutdown waits for a real abort-ignoring %s callback despite caller cancellation, retaining ledger and cooperative lock', async unit => {
    const t = await setup(), request = t.host.createInvocationAdmission(t.options), gate = deferred<string>(), prior = unit === 'tool' ? await request.runModel(async () => 'parent') : undefined
    const close = vi.spyOn(ProviderDispatchLedgerStore.prototype, 'close')
    const pending = (prior ? request.runTool(prior.parent, async () => gate.promise) : request.runModel(async () => gate.promise)).catch(error => error)
    let closed = false
    const closing = t.host.shutdown().then(() => { closed = true })
    expect(t.host.shutdown()).toBe(t.host.shutdown())
    expect(await pending).toBeInstanceOf(Error); await Promise.resolve()
    expect(closed).toBe(false); expect(close).not.toHaveBeenCalled()
    expect(() => t.host.readCurrentData(scope)).toThrow('retired')
    expect(() => new ProviderDispatchOwner(t.dir, t.codec)).toThrow(); expect(close).not.toHaveBeenCalled()
    gate.resolve('late ignored success'); await closing
    expect(closed).toBe(true); expect(close).toHaveBeenCalledOnce()
    const next = new ProviderDispatchOwner(t.dir, t.codec); owners.push(next)
    const data = next.readCurrentData(scope).document as InvocationLedgerDocument
    expect(data.runs[0].status).toBe('unknown'); expect(data.runs[0].units.at(-1)?.outcome?.state).toBe('unknown')
  })
  it('dispose does not free the host slot or authorize migration while the model still ignores abort', async () => {
    const t = await setup(), request = t.host.createInvocationAdmission(t.options), gate = deferred<string>()
    const pending = request.runModel(async () => gate.promise).catch(error => error)
    request.dispose(); expect(await pending).toBeInstanceOf(Error)
    expect(() => t.host.trustedUpgrade({ ...scope, conversationId: 'other' }, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 })).toThrow('occupied')
    let drained = false; const drain = request.drain().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    gate.resolve('late'); await drain
    expect(t.host.trustedUpgrade({ ...scope, conversationId: 'other' }, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 }).grantsPermission).toBe(false)
  })
  it('waits every callback instead of short-circuiting when one settles before another', async () => {
    const t = await setup(), second = { ...scope, conversationId: 'second' }
    t.host.trustedUpgrade(second, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 })
    const one = t.host.createInvocationAdmission(t.options), two = t.host.createInvocationAdmission({ ...t.options, scope: second }), firstGate = deferred<string>(), secondGate = deferred<string>()
    const a = one.runModel(async () => firstGate.promise).catch(error => error), b = two.runModel(async () => secondGate.promise).catch(error => error)
    let closed = false; const close = vi.spyOn(ProviderDispatchLedgerStore.prototype, 'close'), shutdown = t.host.shutdown().then(() => { closed = true })
    await Promise.all([a, b]); firstGate.resolve('first'); await one.drain()
    expect(closed).toBe(false); expect(close).not.toHaveBeenCalled()
    secondGate.resolve('second'); await shutdown; expect(closed).toBe(true); expect(close).toHaveBeenCalledOnce()
  })
  it.each(['throw-getter', 'invalid-endpoint', 'expired', 'already-aborted'] as const)('cleans %s construction without leaking slots/listeners or synthesizing an upgrade/begin', async kind => {
    const t = await setup(), input = { ...t.options }
    if (kind === 'throw-getter') Object.defineProperty(input, 'scope', { enumerable: true, get() { throw new Error('Rejected option getter') } })
    if (kind === 'invalid-endpoint') input.endpoint = 'https://model.test/target?private=key'
    if (kind === 'expired') input.deadlineAt = Date.now() - 1
    if (kind === 'already-aborted') t.signal.abort()
    const listeners = getEventListeners(t.signal.signal, 'abort').length
    for (let i = 0; i < 34; i++) { expect(() => t.host.createInvocationAdmission(input)).toThrow(); await Promise.resolve() }
    expect(getEventListeners(t.signal.signal, 'abort')).toHaveLength(listeners)
    expect(t.document()).toMatchObject({ revision: 1, runs: [] })
    const request = t.host.createInvocationAdmission({ ...t.options, signal: new AbortController().signal }); request.finish(); await request.drain()
    expect(t.document().runs[0].status).toBe('finished')
  })
  it('guards option-accessor reentry before evaluating options and registers construction before a synchronous shutdown', async () => {
    const t = await setup(), input = { ...t.options }; let closing: Promise<void> | undefined, nested = false
    Object.defineProperty(input, 'scope', { enumerable: true, get() {
      expect(() => t.host.createInvocationAdmission(t.options)).toThrow('busy'); nested = true
      closing = t.host.shutdown(); return scope
    } })
    expect(() => t.host.createInvocationAdmission(input)).toThrow('retired'); expect(nested).toBe(true); await closing
    const next = new ProviderDispatchOwner(t.dir, t.codec); owners.push(next)
    expect(next.readCurrentData(scope).document).toMatchObject({ revision: 1, runs: [] })
  })
  it('assigns an acknowledged admission before post-construction checks can reenter shutdown, retaining its idle begin as unknown', async () => {
    const realBuilder = invocationModule.createProviderInvocationAdmission
    let builderReturned = false, closing: Promise<void> | undefined
    vi.spyOn(invocationModule, 'createProviderInvocationAdmission').mockImplementation(options => { const request = realBuilder(options); builderReturned = true; return request })
    const t = await setup(), realGet = NodeSQLiteAdapter.prototype.get
    vi.spyOn(NodeSQLiteAdapter.prototype, 'get').mockImplementation(function (this: NodeSQLiteAdapter, sql, ...params) {
      const result = realGet.call(this, sql, ...params)
      if (builderReturned && path.basename(this.path) === 'owner-v1.sqlite' && !closing) { builderReturned = false; closing = t.host.shutdown() }
      return result
    })
    expect(() => t.host.createInvocationAdmission(t.options)).toThrow('retired'); await closing
    const next = new ProviderDispatchOwner(t.dir, t.codec); owners.push(next)
    expect((next.readCurrentData(scope).document as InvocationLedgerDocument).runs[0]).toMatchObject({ status: 'unknown', units: [] })
  })
  it('lost child settlement acknowledgement cannot create a cleanup retry or survive as a fresh execution capability on reopen', async () => {
    const t = await setup(), request = t.host.createInvocationAdmission(t.options), apply = ProviderInvocationLedgerDataStore.prototype.applyV2
    const write = vi.spyOn(ProviderInvocationLedgerDataStore.prototype, 'applyV2').mockImplementation(function (this: ProviderInvocationLedgerDataStore, scope, command, at) { const result = apply.call(this, scope, command, at); if (command.action === 'settle-unit') throw new Error('Lost child acknowledgement'); return result })
    await expect(request.runModel(async ({ fetch }) => await (await fetch(endpoint, post)).text())).rejects.toThrow()
    await request.drain(); expect(write.mock.calls.filter(call => call[1].action === 'settle-unit')).toHaveLength(1)
    expect(write.mock.calls.map(call => call[1].action)).not.toContain('orphan-v2')
    await t.host.shutdown(); const next = new ProviderDispatchOwner(t.dir, t.codec); owners.push(next)
    expect(next.readCurrentData(scope)).toMatchObject({ orphaned: true, document: { runs: [{ status: 'active', units: [{ unit: 'modelStep' }, { outcome: { state: 'response-complete' } }] }] } })
  })
  it.each(['throw', 'silently-open'] as const)('shutdown quarantines a %s ledger close and cannot unlock or retry closure', async mode => {
    const exec = vi.spyOn(NodeSQLiteAdapter.prototype, 'exec'), get = vi.spyOn(NodeSQLiteAdapter.prototype, 'get'), t = await setup(), close = vi.spyOn(ProviderDispatchLedgerStore.prototype, 'close').mockImplementation(() => { if (mode === 'throw') throw new Error('Uncertain ledger close') })
    const nativeClose = vi.spyOn(NodeSQLiteAdapter.prototype, 'close')
    const shutdown = t.host.shutdown(); await expect(shutdown).rejects.toThrow()
    expect(t.host.shutdown()).toBe(shutdown); expect(close).toHaveBeenCalledOnce()
    const objects = new Set([...exec.mock.instances, ...get.mock.instances].filter(Boolean) as NodeSQLiteAdapter[])
    for (const db of objects) if (db.database.isOpen) native.push(db)
    const ledger = [...objects].find(db => path.basename(db.path) === 'ledger-v1.sqlite')!
    // An idle-close mock does not touch the native ledger; capture it via close's receiver.
    const stored = close.mock.instances[0] as unknown as { db: NodeSQLiteAdapter }
    if (!ledger) native.push(stored.db)
    expect(stored.db.database.isOpen).toBe(true)
    expect(nativeClose.mock.instances.filter(value => value && path.basename((value as NodeSQLiteAdapter).path) === 'owner-v1.sqlite')).toHaveLength(0)
    expect(() => new ProviderDispatchOwner(t.dir, t.codec)).toThrow()
    expect(close).toHaveBeenCalledOnce()
  })
  it.each(['post-open-store', 'post-owner-validation'] as const)('nonthrowing but open close after %s failure retains the lifetime ownership lock', async stage => {
    const dir = root(), codec = sideTestCodec(), get = NodeSQLiteAdapter.prototype.get, close = NodeSQLiteAdapter.prototype.close
    const captured = new Set<NodeSQLiteAdapter>(); let failed = false
    vi.spyOn(NodeSQLiteAdapter.prototype, 'get').mockImplementation(function (this: NodeSQLiteAdapter, sql, ...params) {
      captured.add(this)
      if (stage === 'post-owner-validation' && !failed && path.basename(this.path) === 'owner-v1.sqlite' && [...captured].some(db => path.basename(db.path) === 'ledger-v1.sqlite')) { failed = true; throw new Error('Injected post-open owner validation failure') }
      if (path.basename(this.path) === 'ledger-v1.sqlite' && !failed) {
        if (stage === 'post-open-store') { failed = true; throw new Error('Injected ledger constructor schema read failure') }
        const value = get.call(this, sql, ...params); return value
      }
      return get.call(this, sql, ...params)
    })
    const closing = vi.spyOn(NodeSQLiteAdapter.prototype, 'close').mockImplementation(function (this: NodeSQLiteAdapter) {
      if (path.basename(this.path) !== 'ledger-v1.sqlite') close.call(this)
    })
    const error = await createIsolatedProviderInvocationOwnerHost(dir, codec).catch(error => error)
    expect(error).toBeInstanceOf(Error); expect(error.message).toMatch(/cleanup|closure/)
    expect(Reflect.ownKeys(error)).not.toContain('native'); expect(error).not.toHaveProperty('native'); expect(error).not.toHaveProperty('database')
    expect(failed).toBe(true)
    for (const db of captured) if (db.database.isOpen) native.push(db)
    expect([...captured].find(db => path.basename(db.path) === 'ledger-v1.sqlite')!.database.isOpen).toBe(true)
    expect(closing.mock.instances.some(value => path.basename((value as NodeSQLiteAdapter).path) === 'owner-v1.sqlite')).toBe(false)
    closing.mockRestore()
    expect(() => new ProviderDispatchOwner(dir, codec)).toThrow()
  })
  it('represents constructor failure before native-handle assignment as uninspectable uncertainty and retains the ownership lock', async () => {
    const dir = root(), codec = sideTestCodec(), exec = vi.spyOn(NodeSQLiteAdapter.prototype, 'exec')
    // Throw during adapter construction before any DatabaseSync return; this
    // represents the no-returned-adapter boundary, NOT proof of a native leak.
    const proto = NodeSQLiteAdapter.prototype, descriptor = Object.getOwnPropertyDescriptor(proto, 'timeout')
    Object.defineProperty(proto, 'timeout', { configurable: true, set(this: NodeSQLiteAdapter, value: number) {
      if (path.basename(this.path) === 'ledger-v1.sqlite') throw new Error('No adapter returned for ledger open')
      Object.defineProperty(this, 'timeout', { value, configurable: true, writable: true })
    } })
    try {
      await expect(createIsolatedProviderInvocationOwnerHost(dir, codec)).rejects.toMatchObject({ isNativeClosed: false, cause: { message: 'No adapter returned for ledger open' } })
      expect(() => new ProviderDispatchOwner(dir, codec)).toThrow()
      for (const db of exec.mock.instances as NodeSQLiteAdapter[]) if (db.database.isOpen && !native.includes(db)) native.push(db)
    } finally { if (descriptor) Object.defineProperty(proto, 'timeout', descriptor); else delete (proto as unknown as { timeout?: number }).timeout }
  })
  it.each(['idle', 'running'] as const)('listener removal failure during %s dispose does not bypass abort/drain or allow successful unlock', async kind => {
    const exec = vi.spyOn(NodeSQLiteAdapter.prototype, 'exec'), get = vi.spyOn(NodeSQLiteAdapter.prototype, 'get'), t = await setup(), request = t.host.createInvocationAdmission(t.options)
    let observedAbort = false
    const pending = kind === 'running' ? request.runModel(async ({ signal }) => new Promise<string>(resolve => { signal.addEventListener('abort', () => { observedAbort = true; resolve('abort-cooperative unwind') }, { once: true }) })).catch(error => error) : undefined
    vi.spyOn(t.signal.signal, 'removeEventListener').mockImplementation(() => { throw new Error('Unconfirmed listener removal') })
    expect(() => request.dispose()).not.toThrow()
    if (pending) { expect(await pending).toBeInstanceOf(Error); expect(observedAbort).toBe(true) }
    await expect(request.drain()).rejects.toThrow('disposal was not confirmed')
    const close = vi.spyOn(ProviderDispatchLedgerStore.prototype, 'close')
    await expect(t.host.shutdown()).rejects.toThrow('drainage was not confirmed'); expect(close).not.toHaveBeenCalled()
    expect(() => new ProviderDispatchOwner(t.dir, t.codec)).toThrow()
    for (const db of new Set([...exec.mock.instances, ...get.mock.instances] as NodeSQLiteAdapter[])) if (db.database.isOpen) native.push(db)
  })
  it('acquires construction occupancy before codec callbacks and rejects nested creation or upgrade from that callback', async () => {
    const t = await setup(), available = t.codec.available.bind(t.codec); let calls = 0
    vi.spyOn(t.codec, 'available').mockImplementation(() => {
      calls++
      expect(() => t.host.createInvocationAdmission(t.options)).toThrow('busy')
      expect(() => t.host.trustedUpgrade({ ...scope, conversationId: 'nested' }, { action: 'upgrade-v2', expectedRevision: 0, operationId: randomUUID() })).toThrow('occupied')
      return available()
    })
    const request = t.host.createInvocationAdmission(t.options); expect(calls).toBeGreaterThan(0)
    vi.restoreAllMocks(); request.finish(); await request.drain()
    expect(t.document().runs).toHaveLength(1)
  })
  it('keeps the owner’s 32-slot ceiling across scopes and frees a finished invocation only after its real drain', async () => {
    const t = await setup(false), scopes = Array.from({ length: 33 }, (_, i) => ({ ...scope, conversationId: `slot-${i}` }))
    for (const scope of scopes) t.host.trustedUpgrade(scope, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 })
    const requests = scopes.slice(0, 32).map(scope => t.host.createInvocationAdmission({ ...t.options, scope }))
    const extra = { ...t.options, scope: scopes[32] }
    expect(() => t.host.createInvocationAdmission(extra)).toThrow('capacity')
    requests[0].finish()
    expect(() => t.host.createInvocationAdmission(extra)).toThrow('capacity')
    await requests[0].drain()
    const next = t.host.createInvocationAdmission(extra); next.finish(); await next.drain()
    for (const request of requests.slice(1)) { request.finish(); await request.drain() }
    expect(t.host.readCurrentData(scopes[0]).document.runs[0].status).toBe('finished')
  })
  it('a failed disposal cannot short-circuit another hanging callback or close its native ledger', async () => {
    const exec = vi.spyOn(NodeSQLiteAdapter.prototype, 'exec'), get = vi.spyOn(NodeSQLiteAdapter.prototype, 'get'), t = await setup(), secondScope = { ...scope, conversationId: 'hanging' }
    t.host.trustedUpgrade(secondScope, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 })
    const one = t.host.createInvocationAdmission(t.options), two = t.host.createInvocationAdmission({ ...t.options, signal: new AbortController().signal, scope: secondScope }), gate = deferred<string>()
    const pending = two.runModel(async () => gate.promise).catch(error => error)
    vi.spyOn(t.signal.signal, 'removeEventListener').mockImplementation(() => { throw new Error('Listener could not be removed') })
    one.dispose()
    const close = vi.spyOn(ProviderDispatchLedgerStore.prototype, 'close'); let shutdownSettled = false
    const closing = t.host.shutdown().catch(error => error).finally(() => { shutdownSettled = true })
    await pending; await Promise.resolve(); expect(shutdownSettled).toBe(false); expect(close).not.toHaveBeenCalled()
    gate.resolve('late'); expect(await closing).toBeInstanceOf(AggregateError)
    expect(shutdownSettled).toBe(true); expect(close).not.toHaveBeenCalled(); expect(() => new ProviderDispatchOwner(t.dir, t.codec)).toThrow()
    for (const db of new Set([...exec.mock.instances, ...get.mock.instances] as NodeSQLiteAdapter[])) if (db.database.isOpen) native.push(db)
  })
  it.each(['model', 'tool'] as const)('rejects an otherwise completed %s return if shutdown is queued after its settlement, without rewriting that outcome', async unit => {
    const t = await setup(), request = t.host.createInvocationAdmission(t.options), prior = unit === 'tool' ? await request.runModel(async () => 'choice') : undefined
    const apply = ProviderInvocationLedgerDataStore.prototype.applyV2; let closing: Promise<void> | undefined
    const write = vi.spyOn(ProviderInvocationLedgerDataStore.prototype, 'applyV2').mockImplementation(function (this: ProviderInvocationLedgerDataStore, scope, command, at) {
      const result = apply.call(this, scope, command, at)
      if (command.action === 'settle-unit') queueMicrotask(() => { closing ??= t.host.shutdown() })
      return result
    })
    await expect(prior ? request.runTool(prior.parent, async () => 'effect retained') : request.runModel(async () => 'result')).rejects.toThrow()
    await closing
    expect(write.mock.calls.filter(call => call[1].action === 'settle-unit')).toHaveLength(1)
    const next = new ProviderDispatchOwner(t.dir, t.codec); owners.push(next)
    expect((next.readCurrentData(scope).document as InvocationLedgerDocument).runs[0].units.at(-1)?.outcome?.state).toBe('completed')
  })
  it.each(['dispose', 'parent-abort'] as const)('rejects a completed model value when %s is queued after durable settlement but before the host resumes', async kind => {
    const t = await setup(), request = t.host.createInvocationAdmission(t.options), apply = ProviderInvocationLedgerDataStore.prototype.applyV2
    const write = vi.spyOn(ProviderInvocationLedgerDataStore.prototype, 'applyV2').mockImplementation(function (this: ProviderInvocationLedgerDataStore, scope, command, at) {
      const result = apply.call(this, scope, command, at)
      if (command.action === 'settle-unit') queueMicrotask(() => { if (kind === 'dispose') request.dispose(); else t.signal.abort() })
      return result
    })
    await expect(request.runModel(async () => ({ retained: true }))).rejects.toThrow()
    await request.drain()
    expect(t.document().runs[0].units[0].outcome?.state).toBe('completed')
    expect(write.mock.calls.filter(call => call[1].action === 'settle-unit')).toHaveLength(1)
  })
  it('shutdown reentered during upgrade preflight native read prevents the DATA mutation before it starts', async () => {
    const t = await setup(false), get = NodeSQLiteAdapter.prototype.get, upgrade = vi.spyOn(ProviderInvocationLedgerDataStore.prototype, 'upgradeV2'); let closing: Promise<void> | undefined
    vi.spyOn(NodeSQLiteAdapter.prototype, 'get').mockImplementation(function (this: NodeSQLiteAdapter, sql, ...params) {
      const value = get.call(this, sql, ...params)
      if (path.basename(this.path) === 'owner-v1.sqlite' && !closing) closing = t.host.shutdown()
      return value
    })
    expect(() => t.host.trustedUpgrade(scope, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 })).toThrow('retired during ownership verification')
    expect(upgrade).not.toHaveBeenCalled(); await closing
    const next = new ProviderDispatchOwner(t.dir, t.codec); owners.push(next)
    expect(next.readCurrentData(scope).document).toMatchObject({ version: 1, revision: 0 })
  })
  it('shutdown during an explicit upgrade preserves only committed DATA, returns no fresh result and releases no new entry capability', async () => {
    const t = await setup(false), apply = ProviderInvocationLedgerDataStore.prototype.upgradeV2; let closing: Promise<void> | undefined
    vi.spyOn(ProviderInvocationLedgerDataStore.prototype, 'upgradeV2').mockImplementation(function (this: ProviderInvocationLedgerDataStore, scope, command, at) {
      const value = apply.call(this, scope, command, at); closing = t.host.shutdown(); return value
    })
    expect(() => t.host.trustedUpgrade(scope, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 })).toThrow('retired')
    await closing; expect(t.fetch).not.toHaveBeenCalled()
    const next = new ProviderDispatchOwner(t.dir, t.codec); owners.push(next)
    expect(next.readCurrentData(scope).document).toMatchObject({ version: 2, revision: 1, runs: [] })
  })
  it('preserves finished v1 history and rejects active/unknown history at explicit same-file upgrade', async () => {
    const dir = root(), codec = sideTestCodec(), old = new ProviderDispatchOwner(dir, codec); owners.push(old)
    const scope2 = { ...scope, conversationId: 'unfinished' }, controller = new AbortController(), base = { binding: { goalId: randomUUID(), generation: 2, profileHash: 'b'.repeat(64) }, maxProviderDispatches: 1, maxWalltimeMs: 30000, expectedRevision: 0, endpoint, fetch: async () => new Response('ok'), signal: controller.signal, assertLive() { /* Inert isolated scope; no production user consent. */ } }
    old.createAdmission({ ...base, scope }).finish(); old.createAdmission({ ...base, scope: scope2 }).dispose()
    const history = old.readData(scope).document; await old.shutdown()
    const host = await createIsolatedProviderInvocationOwnerHost(dir, codec); hosts.push(host)
    const result = host.trustedUpgrade(scope, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: history.revision })
    expect(result.document.legacy).toEqual(history); expect(result.document.runs).toEqual([])
    const unknown = host.readCurrentData(scope2).document
    expect(() => host.trustedUpgrade(scope2, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: unknown.revision })).toThrow()
    expect(host.readCurrentData(scope2).document.version).toBe(1)
  })
})
