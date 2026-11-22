import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import type { FetchImpl } from '@shared/llm/clients'
import { OpenAIAPICli } from '@shared/llm/clients'
import { sideScope as scope, sideTestCodec } from '../api/agentThreadSideTestUtils'
import { NodeSQLiteAdapter } from '../magicAgentPlatform2/persistence/sqliteAdapter'
import { ProviderInvocationLedgerDataStore } from './providerDispatchLedgerStore'
import { createProviderInvocationAdmission, type CompletedModel, type ProviderInvocationAdmission, type ProviderInvocationAdmissionOptions } from './providerInvocationAdmission'
import type { InvocationLedgerDocument } from './providerInvocationLedgerPolicy'

const endpoint = 'https://model.test/v1/chat/completions'
const post = () => ({ method: 'POST', body: '{"messages":[]}', headers: { 'Content-Type': 'application/json' } })
const stores: ProviderInvocationLedgerDataStore[] = [], requests: ProviderInvocationAdmission[] = [], roots: string[] = []
afterEach(async () => {
  for (const value of requests.splice(0)) { value.dispose(); await value.drain() }
  vi.restoreAllMocks(); vi.useRealTimers()
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup(extra: Partial<ProviderInvocationAdmissionOptions> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'invocation-admission-')); roots.push(root)
  const file = path.join(root, 'ledger-v1.sqlite'), codec = sideTestCodec(), store = new ProviderInvocationLedgerDataStore(codec, file); stores.push(store)
  const parent = new AbortController(), fetch = vi.fn<FetchImpl>(async () => new Response('ok')), assertLive = vi.fn()
  store.upgradeV2(scope, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 }, Date.now())
  const options: ProviderInvocationAdmissionOptions = { store, scope, binding: { goalId: randomUUID(), generation: 1, profileHash: 'a'.repeat(64) }, limits: { maxModelSteps: 3, maxToolInvocations: 2, maxProviderDispatches: 4 }, deadlineAt: Date.now() + 10000, expectedRevision: 1, signal: parent.signal, endpoint, fetch, assertLive, ...extra }
  const request = createProviderInvocationAdmission(options); requests.push(request)
  const document = () => store.readCurrent(scope).document as InvocationLedgerDocument
  return { root, file, codec, store, parent, fetch, assertLive, options, request, document, run: () => document().runs[0] }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
const model = (t: ReturnType<typeof setup>) => t.request.runModel(async ({ fetch }) => ({ text: await (await fetch(endpoint, post())).text() }))

describe('ISOLATED v2 model/tool/dispatch admission, not production consent or goal runtime', () => {
  it('durably charges all three distinct entries before callbacks, retains the original deadline and closes only accounting', async () => {
    const t = setup()
    t.fetch.mockImplementation(async () => {
      expect(t.run()).toMatchObject({ charged: { modelStep: 1, toolInvocation: 0, providerDispatch: 1 }, units: [{ unit: 'modelStep' }, { unit: 'providerDispatch' }] })
      expect(t.run().units.every(unit => !unit.outcome)).toBe(true); return new Response('ok')
    })
    const completed = await model(t)
    expect(completed.value).toEqual({ text: 'ok' }); expect(Object.isFrozen(completed.parent)).toBe(true)
    expect(t.request).not.toHaveProperty('fetch'); expect(t.request).not.toHaveProperty('reserve'); expect(t.request).not.toHaveProperty('settle')
    expect(await t.request.runTool(completed.parent, async context => {
      expect(context).not.toHaveProperty('fetch'); expect(t.run().charged.toolInvocation).toBe(1); expect(t.run().units.at(-1)).toMatchObject({ unit: 'toolInvocation', parentId: t.run().units[0].id }); return { status: 'record-only', grantsPermission: false }
    })).toEqual({ status: 'record-only', grantsPermission: false })
    t.request.finish(); expect(t.request.state).toBe('finished')
    expect(t.run()).toMatchObject({ status: 'finished', deadlineAt: t.options.deadlineAt, charged: { modelStep: 1, toolInvocation: 1, providerDispatch: 1 } })
    expect(t.run().units.map(unit => unit.outcome?.state)).toEqual(['completed', 'response-complete', 'completed'])
  })
  it('holds one model reservation across two real API client retry children, then admits a read/status tool under its exact parent', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const t = setup(); t.fetch.mockResolvedValueOnce(Response.json({ error: { message: 'server overloaded' } }, { status: 503 })).mockImplementation(async () => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    const pending = t.request.runModel(async ({ fetch, signal }) => {
      const cli = new OpenAIAPICli('not-real-key', endpoint, 'model', { apiMode: 'chat-completions', fetchImpl: fetch, enableHostedTools: false })
      const value = await cli.chat({ messages: [{ role: 'user', content: 'Test' }], retryCapacity: true, disableProviderTools: true, signal }); return { content: value.content }
    })
    await vi.advanceTimersByTimeAsync(2000)
    const value = await pending; expect(value.value).toEqual({ content: 'ok' }); expect(t.fetch).toHaveBeenCalledTimes(2)
    expect(t.run()).toMatchObject({ status: 'active', charged: { modelStep: 1, providerDispatch: 2, toolInvocation: 0 } })
    expect(t.run().units.slice(1).map(unit => unit.parentId)).toEqual([t.run().units[0].id, t.run().units[0].id])
    expect(await t.request.runTool(value.parent, async () => ({ drive_status: 'data' }))).toEqual({ drive_status: 'data' })
    expect(t.run().charged.toolInvocation).toBe(1)
  })
  it('a response-complete child followed by a thrown model entry closes parent unknown, not transport failed or refunded', async () => {
    const t = setup()
    await expect(t.request.runModel(async ({ fetch }) => { await (await fetch(endpoint, post())).text(); throw new Error('Protocol parsing after EOF') })).rejects.toThrow('Protocol parsing')
    await t.request.drain()
    expect(t.run()).toMatchObject({ status: 'unknown', charged: { modelStep: 1, providerDispatch: 1 }, units: [{ outcome: { state: 'unknown' } }, { outcome: { state: 'response-complete' } }] })
    expect(t.request.state).toBe('blocked')
  })
  it('fresh child unknown closes both units once, and a callback that catches it and returns cannot recover a parent witness', async () => {
    const t = setup(), apply = vi.spyOn(t.store, 'applyV2')
    t.fetch.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_CLOSED'))
    const returned = vi.fn()
    await expect(t.request.runModel(async ({ fetch }) => { try { await fetch(endpoint, post()) } catch { returned() }; return { fakeSuccess: true } })).rejects.toThrow()
    await t.request.drain(); expect(returned).toHaveBeenCalledOnce()
    expect(t.document().revision).toBe(5); expect(t.run().status).toBe('unknown')
    expect(t.run().units.map(unit => unit.outcome?.state)).toEqual(['unknown', 'unknown'])
    const settles = apply.mock.calls.map(call => call[1]).filter(command => command.action === 'settle-unit')
    expect(settles).toHaveLength(1); expect(settles[0]).toMatchObject({ unitId: t.run().units[1].id, outcome: { state: 'unknown' } })
    expect(apply.mock.calls.map(call => call[1].action)).not.toContain('orphan-v2')
    await expect(t.request.runTool(Object.freeze({}) as CompletedModel, async () => ({ effect: 'no' }))).rejects.toThrow('association')
  })
  it('revokes an escaped fetch before parent settlement and in tools or the next model, without reserving another dispatch', async () => {
    const t = setup(); let escaped!: FetchImpl
    const first = await t.request.runModel(async context => { escaped = context.fetch; return { complete: true } })
    const before = t.document().revision
    await expect(escaped(endpoint, post())).rejects.toThrow('revoked')
    expect(await t.request.runTool(first.parent, async () => { await expect(escaped(endpoint, post())).rejects.toThrow('revoked'); return 'read-status' })).toBe('read-status')
    const next = await t.request.runModel(async context => { await expect(escaped(endpoint, post())).rejects.toThrow('another model'); return await (await context.fetch(endpoint, post())).text() })
    expect(next.value).toBe('ok'); expect(t.fetch).toHaveBeenCalledOnce(); expect(t.run().charged.providerDispatch).toBe(1)
    expect(t.document().revision).toBe(before + 6)
    await expect(t.request.runTool(first.parent, async () => 'no')).rejects.toThrow('latest')
  })
  it('requires association witness identity, rejects copies and witnesses from another adapter, without consuming current authority', async () => {
    const a = setup(), b = setup(), first = await a.request.runModel(async () => 'a'), second = await b.request.runModel(async () => 'b')
    const invoke = vi.fn(async () => ({ result: 'one' }))
    for (const witness of [structuredClone(first.parent), second.parent, { id: a.run().units[0].id }]) await expect(a.request.runTool(witness as CompletedModel, invoke)).rejects.toThrow('association')
    expect(invoke).not.toHaveBeenCalled(); expect(a.run().charged.toolInvocation).toBe(0)
    await a.request.runTool(first.parent, invoke); expect(invoke).toHaveBeenCalledOnce()
  })
  it.each(['model', 'tool'] as const)('Stop in %s reservation records charged not-started with no invocation or following effect', async unit => {
    const t = setup(), prior = unit === 'tool' ? await t.request.runModel(async () => 'parent') : undefined
    const apply = t.store.applyV2.bind(t.store)
    vi.spyOn(t.store, 'applyV2').mockImplementation((scope, command, now) => { const result = apply(scope, command, now); if (command.action === 'reserve-unit' && command.unit === (unit === 'model' ? 'modelStep' : 'toolInvocation')) t.parent.abort(new Error('Stop in entry reserve')); return result })
    const entry = vi.fn(async () => ({ must: 'not enter' }))
    await expect(prior ? t.request.runTool(prior.parent, entry) : t.request.runModel(entry)).rejects.toThrow('Stop in entry reserve')
    await t.request.drain(); expect(entry).not.toHaveBeenCalled(); expect(t.fetch).not.toHaveBeenCalled()
    expect(t.run()).toMatchObject({ status: 'unknown' }); expect(t.run().units.at(-1)?.outcome).toMatchObject({ state: 'not-started', charged: true })
  })
  it('Stop in child dispatch reservation records not-dispatched and unknown parent, never enters delegate', async () => {
    const t = setup(), apply = t.store.applyV2.bind(t.store)
    vi.spyOn(t.store, 'applyV2').mockImplementation((scope, command, now) => { const result = apply(scope, command, now); if (command.action === 'reserve-unit' && command.unit === 'providerDispatch') t.parent.abort(new Error('Stop in child reserve')); return result })
    await expect(model(t)).rejects.toThrow(); await t.request.drain()
    expect(t.fetch).not.toHaveBeenCalled(); expect(t.run()).toMatchObject({ charged: { modelStep: 1, providerDispatch: 1 }, status: 'unknown' })
    expect(t.run().units.map(unit => unit.outcome?.state)).toEqual(['unknown', 'not-dispatched'])
  })
  it.each(['model', 'tool', 'dispatch'] as const)('Stop during a known %s settlement rejects return but never corrects its durable outcome', async unit => {
    const t = setup(), prior = unit === 'tool' ? await t.request.runModel(async () => 'parent') : undefined, apply = t.store.applyV2.bind(t.store)
    vi.spyOn(t.store, 'applyV2').mockImplementation((scope, command, now) => {
      const result = apply(scope, command, now)
      if (command.action === 'settle-unit' && result.document.runs[0].units.find(item => item.id === command.unitId)?.unit === (unit === 'model' ? 'modelStep' : unit === 'tool' ? 'toolInvocation' : 'providerDispatch')) t.parent.abort(new Error('Stop during known settle'))
      return result
    })
    await expect(prior ? t.request.runTool(prior.parent, async () => 'effect kept') : unit === 'model' ? t.request.runModel(async () => 'result') : model(t)).rejects.toThrow()
    await t.request.drain()
    const wanted = t.run().units.findLast(item => item.unit === (unit === 'model' ? 'modelStep' : unit === 'tool' ? 'toolInvocation' : 'providerDispatch'))!
    expect(wanted.outcome?.state).toBe(unit === 'dispatch' ? 'response-complete' : 'completed'); expect(t.run().status).toBe('unknown')
    expect(t.document().receipts.filter(receipt => receipt.action === 'settle-unit' && receipt.unitId === wanted.id)).toHaveLength(1)
  })
  it.each(['model', 'tool'] as const)('unconfirmed %s reservation never enters, retries, replays, settles or reowns after reopen', async unit => {
    const t = setup(), prior = unit === 'tool' ? await t.request.runModel(async () => 'parent') : undefined, apply = t.store.applyV2.bind(t.store)
    const mutation = vi.spyOn(t.store, 'applyV2').mockImplementation((scope, command, now) => { const result = apply(scope, command, now); if (command.action === 'reserve-unit') throw new Error('Lost reserve acknowledgement'); return result })
    const entry = vi.fn(async () => 'must not run')
    await expect(prior ? t.request.runTool(prior.parent, entry) : t.request.runModel(entry)).rejects.toThrow('Lost reserve')
    await t.request.drain(); expect(entry).not.toHaveBeenCalled(); expect(t.run().units.at(-1)).not.toHaveProperty('outcome')
    const count = mutation.mock.calls.length
    await expect(t.request.runModel(entry)).rejects.toThrow(); expect(mutation).toHaveBeenCalledTimes(count)
    const next = new ProviderInvocationLedgerDataStore(t.codec, t.file); stores.push(next)
    expect(next.readCurrent(scope).orphaned).toBe(true)
    expect(() => createProviderInvocationAdmission({ ...t.options, store: next, expectedRevision: t.document().revision })).toThrow('already-v2')
  })
  it('a lost definitive settlement acknowledgement leaves data only, not a second parent settlement or completed witness', async () => {
    const t = setup(), apply = t.store.applyV2.bind(t.store)
    const mutation = vi.spyOn(t.store, 'applyV2').mockImplementation((scope, command, now) => { const value = apply(scope, command, now); if (command.action === 'settle-unit') throw new Error('Lost settle acknowledgement'); return value })
    await expect(t.request.runModel(async () => 'effect may be committed')).rejects.toThrow('Lost settle'); await t.request.drain()
    expect(t.run().units[0].outcome?.state).toBe('completed')
    expect(mutation.mock.calls.filter(call => call[1].action === 'settle-unit')).toHaveLength(1)
    expect(mutation.mock.calls.filter(call => call[1].action === 'orphan-v2')).toHaveLength(0)
    expect(t.request.state).toBe('blocked')
  })
  it.each(['unread', 'Response', 'stream', 'accessor', 'function', 'cycle', 'oversized'] as const)('rejects %s callback output as unknown rather than treating lazy work as completed', async kind => {
    const t = setup()
    await expect(t.request.runModel(async ({ fetch }) => {
      if (kind === 'unread') { await fetch(endpoint, post()); return { fake: 'complete' } }
      if (kind === 'Response') return new Response('lazy')
      if (kind === 'stream') return new ReadableStream()
      if (kind === 'accessor') return { get deceptive() { throw new Error('Accessor must not run') } }
      if (kind === 'function') return { fn: () => undefined }
      if (kind === 'oversized') return { text: 'a'.repeat(1024 * 1024 + 1) }
      const value: Record<string, unknown> = {}; value.self = value; return value
    })).rejects.toThrow()
    await t.request.drain(); expect(t.run().status).toBe('unknown'); expect(t.run().units[0].outcome?.state).toBe('unknown')
    if (kind === 'unread') expect(t.run().units[1].outcome?.state).toBe('unknown')
  })
  it('returns deep copied bounded data and rejects input option mutation as a way to renew scope/binding/deadline', async () => {
    const t = setup(), original = structuredClone(t.options.binding), data = { mutable: { text: 'kept' } }
    t.options.binding.generation = 99; t.options.scope = { ...scope, conversationId: 'forged' }; t.options.deadlineAt += 100000
    const result = await t.request.runModel(async () => data); data.mutable.text = 'later'
    expect(result.value).toEqual({ mutable: { text: 'kept' } }); expect(t.run().binding).toEqual(original); expect(t.run().deadlineAt).not.toBe(t.options.deadlineAt)
  })
  it('keeps an abort-ignoring callback occupied until late unwind while rejecting the caller on the original deadline', async () => {
    vi.useFakeTimers(); const gate = deferred<string>(), t = setup({ deadlineAt: Date.now() + 100 })
    const pending = t.request.runModel(async () => gate.promise).catch(error => error)
    await vi.advanceTimersByTimeAsync(100); expect(await pending).toBeInstanceOf(Error)
    let drained = false; const closing = t.request.drain().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false); expect(t.run().status).toBe('active'); expect(t.run().units[0].outcome).toBeUndefined()
    await expect(t.request.runModel(async () => 'no')).rejects.toThrow('occupied'); expect(() => t.request.finish()).toThrow('occupied')
    gate.resolve('late'); await closing
    expect(drained).toBe(true); expect(t.run()).toMatchObject({ status: 'unknown', units: [{ outcome: { state: 'unknown' } }] })
  })
  it.each(['idle', 'waiting-headers', 'waiting-body'] as const)('original deadline independently fences %s without a refund or resumed callback', async kind => {
    vi.useFakeTimers()
    const upstream = vi.fn<FetchImpl>(async () => kind === 'waiting-headers' ? new Promise<Response>(() => undefined) : new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 })))
    const t = setup({ deadlineAt: Date.now() + 100, timeoutMs: 10000, fetch: upstream })
    const pending = kind === 'idle' ? undefined : t.request.runModel(async ({ fetch }) => await (await fetch(endpoint, post())).text()).catch(error => error)
    if (kind === 'waiting-body') await Promise.resolve()
    await vi.advanceTimersByTimeAsync(100)
    if (pending) expect(await pending).toBeInstanceOf(Error)
    await t.request.drain(); expect(t.run().status).toBe('unknown'); expect(t.run().charged.providerDispatch).toBe(kind === 'idle' ? 0 : 1)
  })
  it.each(['modelStep', 'toolInvocation', 'providerDispatch'] as const)('exhausts %s separately and prevents the next entry without uncounted work', async unit => {
    const t = setup({ limits: { maxModelSteps: 1, maxToolInvocations: 0, maxProviderDispatches: 1 } })
    if (unit === 'providerDispatch') {
      await expect(t.request.runModel(async ({ fetch }) => { await (await fetch(endpoint, post())).text(); await fetch(endpoint, post()); return 'no' })).rejects.toThrow()
      expect(t.fetch).toHaveBeenCalledOnce()
    } else {
      const parent = await t.request.runModel(async () => 'ok'), entry = vi.fn(async () => 'no')
      await expect(unit === 'modelStep' ? t.request.runModel(entry) : t.request.runTool(parent.parent, entry)).rejects.toThrow('budget')
      expect(entry).not.toHaveBeenCalled()
    }
    expect(t.run().charged).toMatchObject({ modelStep: 1, toolInvocation: 0, providerDispatch: unit === 'providerDispatch' ? 1 : 0 })
  })
  it('rejects v1 or missing owner without automatic upgrade and validates bad endpoint/deadline before a persistent begin', () => {
    const t = setup(); t.request.finish()
    const other = { ...scope, conversationId: 'no-optin' }
    expect(() => createProviderInvocationAdmission({ ...t.options, scope: other, expectedRevision: 0 })).toThrow('already-v2')
    expect(t.store.readCurrent(other).document).toMatchObject({ version: 1, revision: 0 })
    const before = t.document().revision
    expect(() => createProviderInvocationAdmission({ ...t.options, expectedRevision: before, endpoint: 'https://model.test/path?secret=key' })).toThrow('endpoint')
    expect(() => createProviderInvocationAdmission({ ...t.options, expectedRevision: before, deadlineAt: Date.now() - 1 })).toThrow('deadline')
    expect(t.document().revision).toBe(before)
  })
  it('rechecks scope/configuration and original deadline after SQLite verification before invoking any entry', async () => {
    const t = setup(), read = t.store.readCurrent.bind(t.store), entry = vi.fn(async () => 'no')
    vi.spyOn(t.store, 'readCurrent').mockImplementation(scope => { const value = read(scope); vi.spyOn(Date, 'now').mockReturnValue(t.options.deadlineAt + 1); return value })
    await expect(t.request.runModel(entry)).rejects.toThrow('deadline'); expect(entry).not.toHaveBeenCalled(); expect(t.run().charged.modelStep).toBe(0)
  })
  it.each(['modelStep', 'toolInvocation', 'providerDispatch'] as const)('configuration invalidation during the final post-reservation %s read prevents the next effect', async unit => {
    const t = setup(), parent = unit === 'toolInvocation' ? await t.request.runModel(async () => 'choice') : undefined
    const read = t.store.readCurrent.bind(t.store); let allowed = true, invalidated = false
    t.assertLive.mockImplementation(() => { if (!allowed) throw new Error('Configuration changed during verification') })
    vi.spyOn(t.store, 'readCurrent').mockImplementation(scope => {
      const value = read(scope), doc = value.document
      if (!invalidated && doc.version === 2 && doc.runs[0]?.units.some(item => item.unit === unit && !item.outcome)) { allowed = false; invalidated = true }
      return value
    })
    const entry = vi.fn(async () => 'no-effect')
    await expect(parent ? t.request.runTool(parent.parent, entry) : unit === 'providerDispatch' ? model(t) : t.request.runModel(entry)).rejects.toThrow('Configuration changed')
    await t.request.drain(); expect(entry).not.toHaveBeenCalled(); expect(t.fetch).not.toHaveBeenCalled(); expect(invalidated).toBe(true)
    expect(t.run().units.findLast(item => item.unit === unit)?.outcome?.state).toBe(unit === 'providerDispatch' ? 'not-dispatched' : 'not-started')
  })
  it.each(['4294967295', '01', '-1', '1e0'] as const)('rejects sparse array disguised by numeric-looking %s property without silently changing its JSON shape', async key => {
    const t = setup(), data = new Array(1)
    Object.defineProperty(data, key, { value: 'payload', enumerable: true })
    await expect(t.request.runModel(async () => data)).rejects.toThrow('non-contiguous')
    await t.request.drain(); expect(t.run().units[0].outcome?.state).toBe('unknown')
  })
  it('accepts real dense JSON arrays without dropping indexes or custom data', async () => {
    const t = setup(), input = [{ a: 1 }, ['two', true], null], result = await t.request.runModel(async () => input)
    expect(result.value).toEqual(input); expect(JSON.stringify(result.value)).toBe(JSON.stringify(input)); expect(result.value).not.toBe(input)
  })
  it.each(['modelStep', 'toolInvocation', 'providerDispatch'] as const)('lost %s settlement acknowledgement never triggers a substitute operation, refund or recovered permit', async unit => {
    const t = setup(), first = unit === 'toolInvocation' ? await t.request.runModel(async () => 'parent') : undefined, apply = t.store.applyV2.bind(t.store)
    const mutations = vi.spyOn(t.store, 'applyV2').mockImplementation((scope, command, now) => {
      const result = apply(scope, command, now)
      if (command.action === 'settle-unit' && result.document.runs[0].units.find(item => item.id === command.unitId)?.unit === unit) throw new Error('Lost exact settlement acknowledgement')
      return result
    })
    await expect(first ? t.request.runTool(first.parent, async () => ({ recorded: true })) : unit === 'modelStep' ? t.request.runModel(async () => 'completed-data') : model(t)).rejects.toThrow()
    await t.request.drain()
    const settled = t.run().units.findLast(item => item.unit === unit)!
    expect(settled.outcome?.state).toBe(unit === 'providerDispatch' ? 'response-complete' : 'completed')
    expect(mutations.mock.calls.filter(call => call[1].action === 'settle-unit' && call[1].unitId === settled.id)).toHaveLength(1)
    expect(mutations.mock.calls.map(call => call[1].action)).not.toContain('orphan-v2')
    const count = mutations.mock.calls.length
    t.request.dispose(); await expect(t.request.runModel(async () => 'no')).rejects.toThrow(); expect(mutations).toHaveBeenCalledTimes(count)
  })
  it('rejects a DATA replay result as new permission even when its operation IDs, document and revision otherwise match', async () => {
    const t = setup(), apply = t.store.applyV2.bind(t.store), entry = vi.fn(async () => 'never')
    const mutations = vi.spyOn(t.store, 'applyV2').mockImplementation((scope, command, now) => ({ ...apply(scope, command, now), replay: true }))
    await expect(t.request.runModel(entry)).rejects.toThrow('fresh exact self-commit'); expect(entry).not.toHaveBeenCalled()
    expect(t.run().charged.modelStep).toBe(1); expect(t.run().units[0].outcome).toBeUndefined()
    expect(mutations).toHaveBeenCalledOnce()
  })
  it('does not accept a valid but different operation command receipt as confirmation of its own reservation', async () => {
    const t = setup(), apply = t.store.applyV2.bind(t.store), entry = vi.fn(async () => 'never')
    vi.spyOn(t.store, 'applyV2').mockImplementation((scope, command, now) => apply(scope, { ...command, operationId: randomUUID() }, now))
    await expect(t.request.runModel(entry)).rejects.toThrow('fresh exact self-commit'); expect(entry).not.toHaveBeenCalled()
    expect(t.run().units[0].outcome).toBeUndefined()
  })
  it('never rebases after an external writer fences the active model while the callback is suspended', async () => {
    const t = setup(), gate = deferred<string>(), other = new ProviderInvocationLedgerDataStore(t.codec, t.file); stores.push(other)
    const pending = t.request.runModel(async () => gate.promise), doc = t.document()
    other.applyV2(scope, { action: 'orphan-v2', runId: doc.runs[0].id, expectedRevision: doc.revision, operationId: randomUUID() }, Date.now())
    gate.resolve('late'); await expect(pending).rejects.toThrow('orphaned'); await t.request.drain()
    expect(t.document().revision).toBe(doc.revision + 1); expect(t.run().status).toBe('unknown')
  })
  it('settles an entered tool unknown after its committed goal-like effect throws, without rolling back or invoking it twice', async () => {
    const t = setup(), first = await t.request.runModel(async () => 'tool choice'), effects: string[] = []
    const entry = vi.fn(async () => { effects.push('committed report'); throw new Error('Outcome acknowledgement missing') })
    await expect(t.request.runTool(first.parent, entry)).rejects.toThrow('acknowledgement'); await t.request.drain()
    await expect(t.request.runTool(first.parent, entry)).rejects.toThrow()
    expect(effects).toEqual(['committed report']); expect(entry).toHaveBeenCalledOnce()
    expect(t.run()).toMatchObject({ status: 'unknown', charged: { toolInvocation: 1 }, units: [{ outcome: { state: 'completed' } }, { unit: 'toolInvocation', outcome: { state: 'unknown' } }] })
  })
  it('blocks a stale fetch called synchronously by a parent-settlement callback before the callback can reserve a new child', async () => {
    const t = setup(); let old!: FetchImpl, attempted: Promise<Response> | undefined
    const apply = t.store.applyV2.bind(t.store)
    vi.spyOn(t.store, 'applyV2').mockImplementation((scope, command, now) => {
      if (command.action === 'settle-unit') { attempted = old(endpoint, post()); void attempted.catch(() => undefined) }
      return apply(scope, command, now)
    })
    await t.request.runModel(async ({ fetch }) => { old = fetch; return 'materialized' })
    await expect(attempted).rejects.toThrow('revoked'); expect(t.fetch).not.toHaveBeenCalled(); expect(t.run().charged.providerDispatch).toBe(0)
  })
  it('blocks recursive entries/finish from a synchronous live guard before additional durable reservations', async () => {
    const t = setup(); let nested: Promise<unknown> | undefined
    t.assertLive.mockImplementation(() => {
      nested = t.request.runModel(async () => 'no'); void nested.catch(() => undefined)
      expect(() => t.request.finish()).toThrow('occupied')
    })
    expect((await t.request.runModel(async () => 'one')).value).toBe('one')
    await expect(nested).rejects.toThrow('occupied'); expect(t.run().charged.modelStep).toBe(1)
  })
  it('Stop before entry in the live guard cannot issue a model association or run a callback', async () => {
    const t = setup(), entry = vi.fn(async () => 'no')
    t.assertLive.mockImplementation(() => t.parent.abort(new Error('Scope was revoked')))
    await expect(t.request.runModel(entry)).rejects.toThrow(); await t.request.drain()
    expect(entry).not.toHaveBeenCalled(); expect(t.run()).toMatchObject({ status: 'unknown', charged: { modelStep: 0 } })
  })
  it('does not confirm success when Stop arrives inside finish commit and never rewrites finished accounting', async () => {
    const t = setup(), apply = t.store.applyV2.bind(t.store)
    const mutation = vi.spyOn(t.store, 'applyV2').mockImplementation((scope, command, now) => { const result = apply(scope, command, now); if (command.action === 'finish-v2') t.parent.abort(new Error('Stop in finish')); return result })
    expect(() => t.request.finish()).toThrow(); expect(t.run().status).toBe('finished')
    expect(mutation.mock.calls.map(call => call[1].action)).toEqual(['finish-v2'])
  })
  it('keeps known entry settlements and accounting finish durable at the maximum declared three-unit run without expanding receipt capacity', async () => {
    const t = setup({ limits: { maxModelSteps: 32, maxToolInvocations: 32, maxProviderDispatches: 32 }, deadlineAt: Date.now() + 60000 })
    for (let i = 0; i < 32; i++) {
      const value = await model(t)
      expect(await t.request.runTool(value.parent, async () => ({ status: i }))).toEqual({ status: i })
    }
    t.request.finish()
    expect(t.run()).toMatchObject({ status: 'finished', charged: { modelStep: 32, toolInvocation: 32, providerDispatch: 32 } })
    expect(t.run().units).toHaveLength(96); expect(t.document().revision).toBe(195)
    expect(Buffer.byteLength(JSON.stringify(t.document()), 'utf8')).toBeLessThan(128 * 1024)
    const before = t.document()
    expect(() => createProviderInvocationAdmission({ ...t.options, expectedRevision: before.revision })).toThrow('receipt capacity')
    expect(t.document()).toEqual(before)
  }, 30000)
  it('Stop inside begin commit cannot return a live adapter or leave confirmed idle accounting resumable', () => {
    const t = setup(); t.request.finish(); const other = { ...scope, conversationId: 'stop-begin' }, parent = new AbortController()
    t.store.upgradeV2(other, { action: 'upgrade-v2', operationId: randomUUID(), expectedRevision: 0 }, Date.now())
    const apply = t.store.applyV2.bind(t.store)
    vi.spyOn(t.store, 'applyV2').mockImplementation((scope, command, now) => { const result = apply(scope, command, now); if (command.action === 'begin-v2') parent.abort(new Error('Stop in begin')); return result })
    expect(() => createProviderInvocationAdmission({ ...t.options, scope: other, signal: parent.signal })).toThrow()
    expect(t.store.readCurrent(other)).toMatchObject({ orphaned: false, document: { revision: 3, runs: [{ status: 'unknown', units: [] }] } })
  })
  it('a lost native BEGIN acknowledgement poisons the adapter/store without an entry or synthetic parent cleanup', async () => {
    const t = setup(), db = (t.store as unknown as { db: NodeSQLiteAdapter }).db, exec = db.exec.bind(db), entry = vi.fn(async () => 'no')
    vi.spyOn(db, 'exec').mockImplementation(sql => { const result = exec(sql); if (sql === 'BEGIN IMMEDIATE') throw new Error('Lost native BEGIN receipt'); return result })
    await expect(t.request.runModel(entry)).rejects.toThrow('Lost native BEGIN'); await t.request.drain()
    expect(entry).not.toHaveBeenCalled(); expect(db.database.isTransaction).toBe(false)
    expect(t.store.readCurrent(scope)).toMatchObject({ orphaned: true, mutationBlocked: true, document: { revision: 2, runs: [{ units: [] }] } })
  })
  it('serializes sibling callbacks but allows sequential models, and binds actual loopback POST to pending model plus child before server receives it', async () => {
    let calls = 0
    const server = createServer(async (req, res) => { for await (const _chunk of req) { /* Drain bounded fixture. */ }; calls++; expect(t.run().charged).toMatchObject({ modelStep: 1, providerDispatch: calls }); expect(t.run().units.filter(unit => !unit.outcome).map(unit => unit.unit)).toEqual(['modelStep', 'providerDispatch']); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"answer":"ok"}') })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback port')
    const local = `http://127.0.0.1:${address.port}/model`, t = setup({ endpoint: local, fetch: globalThis.fetch }), gate = deferred<void>()
    try {
      const first = t.request.runModel(async ({ fetch }) => { await gate.promise; for (let i = 0; i < 2; i++) expect(await (await fetch(local, post())).json()).toEqual({ answer: 'ok' }); return 'done' })
      await expect(t.request.runModel(async () => 'no')).rejects.toThrow('occupied')
      gate.resolve(); const value = await first; expect(value.value).toBe('done'); expect(calls).toBe(2)
      expect((await t.request.runModel(async () => 'follow-up')).value).toBe('follow-up'); t.request.finish()
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})
