import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIRequestControl } from '@shared/llm/openaiRequestControl'
import type { ProviderRawWorkRetainer } from '@shared/llm/providerRawWork'
import type { CooperativeOperationGate } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { withCooperativeOperation } from './cooperativeOperation'
import { createProviderRawWorkRetainer } from './providerRawWorkRetention'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('MAIN exact chat child provider-tail handoff', () => {
  it('passive descendant outlives chat, without preserving old chat tool admission', async () => {
    const owner = new CooperativeExecutionController(), abort = new AbortController(), tail = deferred(), staleEffect = vi.fn()
    let retained!: ProviderRawWorkRetainer, oldChat!: CooperativeOperationGate
    await withCooperativeOperation(owner, 'llm-inference', abort.signal, async children => {
      oldChat = children!
      retained = createProviderRawWorkRetainer(children, abort.signal, () => undefined)
      retained(tail.promise, () => undefined)
    })
    expect(owner.isQuiescent()).toBe(false)
    try {
      await expect(oldChat.run('tool-invocation', undefined, staleEffect)).rejects.toMatchObject({ code: 'COOPERATIVE_SCOPE_RELEASED' })
      expect(staleEffect).not.toHaveBeenCalled()
      expect(() => retained(Promise.resolve(), () => undefined)).toThrow(/synchronous/i)
    } finally { tail.resolve(); await owner.whenQuiescent() }
  })
  it('stale exact scope fails construction before raw work, timers and listeners', async () => {
    const owner = new CooperativeExecutionController(), abort = new AbortController(), raw = vi.fn<typeof fetch>(); let retain!: ProviderRawWorkRetainer
    await withCooperativeOperation(owner, 'llm-inference', abort.signal, async child => { retain = createProviderRawWorkRetainer(child, abort.signal, () => undefined) })
    vi.useFakeTimers(); const listener = vi.spyOn(abort.signal, 'addEventListener')
    expect(() => new OpenAIRequestControl(raw, abort.signal, 1000, { retainRawWork: retain })).toThrow(/synchronous/i)
    expect(raw).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); await owner.whenQuiescent()
  })
  it('owner revocation inside synchronous passive admission dispatches nothing', async () => {
    const owner = new CooperativeExecutionController(), abort = new AbortController(), raw = vi.fn<typeof fetch>(), reason = Error('exact owner revoked')
    let checks = 0
    await withCooperativeOperation(owner, 'llm-inference', abort.signal, async child => {
      const retainRawWork = createProviderRawWorkRetainer(child, abort.signal, () => { checks += 1; if (checks === 2) throw reason })
      expect(() => new OpenAIRequestControl(raw, abort.signal, 1000, { retainRawWork })).toThrow(/synchronous/i)
      expect(raw).not.toHaveBeenCalled()
    })
    await owner.whenQuiescent(); expect(checks).toBe(2)
  })
  it('constructor throw after concrete passive entry releases only its unstarted drain', async () => {
    vi.useFakeTimers(); const owner = new CooperativeExecutionController(), abort = new AbortController(), raw = vi.fn<typeof fetch>(), reason = Error('trusted constructor failure')
    await withCooperativeOperation(owner, 'llm-inference', abort.signal, async child => {
      const retain = createProviderRawWorkRetainer(child, abort.signal, () => undefined)
      const retainRawWork: ProviderRawWorkRetainer = (drain, enter) => { retain(drain, enter); throw reason }
      const listener = vi.spyOn(abort.signal, 'addEventListener')
      expect(() => new OpenAIRequestControl(raw, abort.signal, 1000, { retainRawWork })).toThrow(reason)
      expect(raw).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
    })
    await owner.whenQuiescent()
  })
  it.each(['subclass', 'own-then', 'own-constructor'] as const)('unsupported rejected native gate return %s is observed but never dispatches work', async kind => {
    vi.useFakeTimers()
    const error = Error('invalid gate returned rejection'), getter = vi.fn(() => { throw Error('invalid gate accessor must not execute') })
    const held = kind === 'subclass' ? new (class extends Promise<void> {})((_yes, no) => no(error)) : Promise.reject<void>(error)
    if (kind === 'own-then') Object.defineProperty(held, 'then', { get: getter, configurable: true })
    if (kind === 'own-constructor') Object.defineProperty(held, 'constructor', { get: getter, configurable: true })
    const gate: CooperativeOperationGate = { run: () => held }, raw = vi.fn<typeof fetch>(), parent = new AbortController(), listener = vi.spyOn(parent.signal, 'addEventListener')
    const retainRawWork = createProviderRawWorkRetainer(gate, parent.signal, () => undefined)
    expect(() => new OpenAIRequestControl(raw, parent.signal, 1000, { retainRawWork })).toThrow(/ordinary native promise/i)
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
    expect(getter).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it('non-synchronously-entering gate cannot turn later admission into provider work', async () => {
    let complete!: Promise<void>
    const gate: CooperativeOperationGate = { run: vi.fn((_kind, _signal, operation) => { complete = Promise.resolve().then(() => operation(gate)); return complete }) }
    const raw = vi.fn<typeof fetch>(), retainRawWork = createProviderRawWorkRetainer(gate, undefined, () => undefined)
    expect(() => new OpenAIRequestControl(raw, undefined, 1000, { retainRawWork })).toThrow(/synchronous/i)
    await expect(complete).rejects.toMatchObject({ code: 'PROVIDER_RAW_WORK_OWNERSHIP' }); expect(raw).not.toHaveBeenCalled()
  })
})
