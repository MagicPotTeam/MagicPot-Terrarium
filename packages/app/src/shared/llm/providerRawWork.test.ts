import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIRequestControl } from './openaiRequestControl'
import { ProviderRawWorkLifetime, type ProviderRawWorkRetainer } from './providerRawWork'
import type { FetchImpl } from './clients'

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }
const fixture = (fetcher: FetchImpl = vi.fn<typeof fetch>(), parent?: AbortSignal) => {
  let drain!: Promise<void>, drained = false, admitted = false
  const retain: ProviderRawWorkRetainer = (promise, enter) => {
    drain = promise; void promise.then(() => { drained = true }); enter(); admitted = true
  }
  const control = new OpenAIRequestControl(fetcher, parent, 1000, { retainRawWork: retain })
  return { control, drain: () => drain, drained: () => drained, admitted: () => admitted }
}
const noBody = (method: string, operation: () => Promise<unknown>) => ({ body: null, [method]: operation }) as unknown as Response
const readValue = { done: true as const, value: undefined }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('constructor-only provider raw promise ownership, not clean completion', () => {
  it('registers the passive lifetime before the first instruction of the delegate', async () => {
    const response = new Response('ok'), fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { expect(f.admitted()).toBe(true); expect(f.drained()).toBe(false); return response })
    const f = fixture(fetcher)
    try { expect(await f.control.fetch('https://fixture.invalid')).toBe(response); expect(f.drained()).toBe(false) }
    finally { f.control.dispose() }
    await f.drain(); expect(f.drained()).toBe(true)
  })
  it('retains fetch completion envelope through late response cleanup registration and deferred cancel rejection', async () => {
    const abort = new AbortController(), entered = deferred<void>(), raw = deferred<Response>(), cancel = deferred<void>(), cancelEntered = deferred<void>()
    const response = new Response(new ReadableStream({ cancel() { cancelEntered.resolve(); return cancel.promise } }))
    const f = fixture(vi.fn<typeof fetch>().mockImplementation(() => { entered.resolve(); return raw.promise }), abort.signal)
    const observed = f.control.fetch('https://fixture.invalid').catch(error => error)
    try {
      await entered.promise; const reason = Error('exact abort'); abort.abort(reason); expect(await observed).toBe(reason)
      f.control.dispose(); await flush(); expect(f.drained()).toBe(false)
      raw.resolve(response); await cancelEntered.promise; await flush(); expect(f.drained()).toBe(false)
      cancel.reject(Error('late cleanup failure')); await f.drain(); expect(f.drained()).toBe(true)
    } finally { abort.abort(); f.control.dispose(); raw.resolve(response); cancel.resolve(); await observed; await f.drain() }
  })
  it.each(['read-first', 'cancel-first', 'read-rejects', 'cancel-rejects'] as const)('retains independently pending read/cancel promises: %s', async order => {
    const abort = new AbortController(), read = deferred<ReadableStreamReadResult<Uint8Array>>(), cancel = deferred<void>(), readEntered = deferred<void>(), cancelEntered = deferred<void>()
    const reader = { read: vi.fn(() => { readEntered.resolve(); return read.promise }), cancel: vi.fn(() => { cancelEntered.resolve(); return cancel.promise }), releaseLock: vi.fn() }
    const response = { body: { getReader: () => reader } } as unknown as Response, f = fixture(undefined, abort.signal)
    const observed = f.control.text(response, 1024).catch(error => error)
    try {
      await readEntered.promise; const reason = Error('read caller abort'); abort.abort(reason); expect(await observed).toBe(reason); await cancelEntered.promise
      f.control.dispose(); await flush(); expect(f.drained()).toBe(false)
      if (order === 'read-first' || order === 'read-rejects') {
        if (order === 'read-rejects') read.reject(Error('raw read failure')); else read.resolve(readValue)
      } else {
        if (order === 'cancel-rejects') cancel.reject(Error('raw cancel failure')); else cancel.resolve()
      }
      await flush(); expect(f.drained()).toBe(false)
      read.resolve(readValue); cancel.resolve(); await f.drain(); expect(f.drained()).toBe(true)
      expect(reader.cancel).toHaveBeenCalledOnce(); expect(reader.releaseLock).toHaveBeenCalledOnce()
    } finally { abort.abort(); f.control.dispose(); read.resolve(readValue); cancel.resolve(); await observed; await f.drain() }
  })
  it('deadline cancels caller but cannot release never-settling registered work', async () => {
    vi.useFakeTimers()
    const entered = deferred<void>(), raw = deferred<Response>(), f = fixture(vi.fn<typeof fetch>().mockImplementation(() => { entered.resolve(); return raw.promise }))
    const observed = f.control.fetch('https://fixture.invalid').catch(error => error)
    try { await entered.promise; await vi.advanceTimersByTimeAsync(1000); expect((await observed).code).toBe('MODEL_REQUEST_TIMEOUT'); f.control.dispose(); await vi.advanceTimersByTimeAsync(1000000); expect(f.drained()).toBe(false) }
    finally { f.control.dispose(); raw.resolve(new Response(null)); await observed; await f.drain() }
  })
  it.each(['text', 'json', 'blob'] as const)('retains raw no-body %s even though caller abort has returned', async method => {
    const abort = new AbortController(), raw = deferred<never>(), called = vi.fn(() => raw.promise), response = noBody(method, called), f = fixture(undefined, abort.signal)
    const observed = (method === 'text' ? f.control.text(response, 1024) : method === 'json' ? f.control.json(response) : f.control.blob(response, 1024)).catch(error => error)
    try {
      expect(called).toHaveBeenCalledOnce(); const reason = Error('fallback caller stop'); abort.abort(reason); expect(await observed).toBe(reason); f.control.dispose(); await flush(); expect(f.drained()).toBe(false)
      raw.reject(Error('late fallback failure')); await f.drain(); expect(f.drained()).toBe(true)
    } finally { abort.abort(); f.control.dispose(); raw.reject(Error('fixture cleanup')); await observed; await f.drain() }
  })
  it.each(['text', 'json', 'blob'] as const)('does not invoke new fallback %s after disposal', async method => {
    const called = vi.fn(async () => undefined), f = fixture(), response = noBody(method, called); f.control.dispose()
    await expect(method === 'text' ? f.control.text(response, 1024) : method === 'json' ? f.control.json(response) : f.control.blob(response, 1024)).rejects.toThrow(/disposed|finished/i)
    expect(called).not.toHaveBeenCalled(); await f.drain()
  })
  it('rejects pre-aborted admission before retainer, listener, timer or delegate installation', () => {
    vi.useFakeTimers(); const abort = new AbortController(), reason = Error('preabort'); abort.abort(reason)
    const retainRawWork = vi.fn(), fetcher = vi.fn<typeof fetch>(), listener = vi.spyOn(abort.signal, 'addEventListener')
    expect(() => new OpenAIRequestControl(fetcher, abort.signal, 1000, { retainRawWork })).toThrow(reason)
    expect(retainRawWork).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['throw-before-entry', 'throw-after-entry', 'no-entry', 'async-entry'] as const)('invalid retainer %s has no raw dispatch/timers/listeners and seals unstarted lifetime', async mode => {
    vi.useFakeTimers(); let drain!: Promise<void>, drained = false
    const fetcher = vi.fn<typeof fetch>(), parent = new AbortController(), listener = vi.spyOn(parent.signal, 'addEventListener')
    const retainRawWork: ProviderRawWorkRetainer = (p, enter) => {
      drain = p; void p.then(() => { drained = true })
      if (mode === 'throw-before-entry') throw Error('retainer before')
      if (mode === 'no-entry') return
      if (mode === 'async-entry') return Promise.resolve().then(enter)
      enter(); throw Error('retainer after')
    }
    expect(() => new OpenAIRequestControl(fetcher, parent.signal, 1000, { retainRawWork })).toThrow()
    await drain; await flush(); expect(drained).toBe(true); expect(vi.getTimerCount()).toBe(0); expect(listener).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('a synchronous delegate throw settles without poisoning otherwise valid lifetime', async () => {
    const error = Error('synchronous fetch failure'), f = fixture(vi.fn<typeof fetch>().mockImplementation(() => { throw error }))
    try { await expect(f.control.fetch('https://fixture.invalid')).rejects.toBe(error) } finally { f.control.dispose() }
    await f.drain()
  })
  it('a genuine rejected raw delegate drains; no outcome row is manufactured', async () => {
    const error = Error('rejected fetch failure'), f = fixture(vi.fn<typeof fetch>().mockRejectedValue(error))
    try { await expect(f.control.fetch('https://fixture.invalid')).rejects.toBe(error) } finally { f.control.dispose() }
    await f.drain()
  })
  it.each(['thenable', 'spoofed-prototype', 'promise-subclass'] as const)('post-dispatch invalid raw %s poisons passive ownership rather than releasing it', async kind => {
    const then = vi.fn(), value = kind === 'thenable' ? { then } : kind === 'spoofed-prototype' ? Object.create(Promise.prototype) : new (class extends Promise<Response> {})(resolve => resolve(new Response(null)))
    const called = vi.fn(), fetcher: FetchImpl = () => { called(); return value as Promise<Response> }, f = fixture(fetcher)
    try { await expect(f.control.fetch('https://fixture.invalid')).rejects.toMatchObject({ code: 'PROVIDER_RAW_WORK_OWNERSHIP' }) }
    finally { f.control.dispose() }
    await flush(); expect(called).toHaveBeenCalledOnce(); expect(then).not.toHaveBeenCalled(); expect(f.drained()).toBe(false)
    // Deliberately poisoned tracker is never awaited/released by a timeout.
  })
  it('invalid cleanup return poisons ownership without replacing established caller abort', async () => {
    const abort = new AbortController(), entered = deferred<void>(), raw = deferred<Response>(), cancelEntered = deferred<void>(), then = vi.fn()
    const response = { body: { locked: false, cancel: () => { cancelEntered.resolve(); return { then } } } } as unknown as Response
    const f = fixture(vi.fn<typeof fetch>().mockImplementation(() => { entered.resolve(); return raw.promise }), abort.signal), observed = f.control.fetch('https://fixture.invalid').catch(error => error)
    await entered.promise; const reason = Error('original abort'); abort.abort(reason); expect(await observed).toBe(reason); f.control.dispose()
    raw.resolve(response); await cancelEntered.promise; await flush(); expect(then).not.toHaveBeenCalled(); expect(f.drained()).toBe(false)
  })
  it('sealing blocks new work while previously registered cleanup may extend a pending lifetime', async () => {
    let admitted = false
    const lifetime = new ProviderRawWorkLifetime((_p, enter) => { enter(); admitted = true }), raw = deferred<void>(), cleanup = deferred<void>(), invoked = vi.fn(() => Promise.resolve())
    lifetime.invoke(() => raw.promise); lifetime.seal(); expect(admitted).toBe(true); expect(() => lifetime.invoke(invoked)).toThrow(/sealed/i); expect(invoked).not.toHaveBeenCalled()
    lifetime.cleanup(() => cleanup.promise); raw.resolve(); await flush()
    let drained = false; void lifetime.drain.then(() => { drained = true }); await flush(); expect(drained).toBe(false)
    cleanup.resolve(); await lifetime.drain; expect(() => lifetime.cleanup(invoked)).toThrow(/continuation/i); expect(invoked).not.toHaveBeenCalled()
  })
  it('reentrant disposal during a newly admitted fallback cannot resolve drain before its raw return is registered', async () => {
    const raw = deferred<string>(), f = fixture(), response = noBody('text', () => { f.control.dispose(); return raw.promise })
    const observed = f.control.text(response, 1024).catch(error => error)
    try { expect((await observed).name).toBe('AbortError'); await flush(); expect(f.drained()).toBe(false) }
    finally { raw.resolve('late fallback'); f.control.dispose(); await observed; await f.drain() }
  })
  it('reentrant disposal while initiating body cancellation retains the actual cancel return', async () => {
    const raw = deferred<void>(), abort = new AbortController()
    const response = { body: { locked: false, cancel() { owned.control.dispose(); return raw.promise } } } as unknown as Response
    const owned = fixture(async () => response, abort.signal)
    await owned.control.fetch('https://fixture.invalid'); abort.abort(); await flush()
    try { expect(owned.drained()).toBe(false) }
    finally { raw.resolve(); owned.control.dispose(); await owned.drain() }
  })
  it.each(['subclass', 'own-then', 'own-constructor-data', 'configurable-constructor-getter', 'nonconfigurable-writable-constructor'] as const)('observes unsupported rejected native %s without invoking accessors or releasing ownership', async kind => {
    const error = Error('unsupported native rejection'), getter = vi.fn(() => { throw Error('must not read getter') })
    const raw = kind === 'subclass' ? new (class extends Promise<Response> {})((_yes, no) => no(error)) : Promise.reject<Response>(error)
    if (kind === 'own-then') Object.defineProperty(raw, 'then', { get: getter, configurable: true })
    if (kind === 'own-constructor-data') Object.defineProperty(raw, 'constructor', { value: { [Symbol.species]: getter }, configurable: true })
    if (kind === 'configurable-constructor-getter') Object.defineProperty(raw, 'constructor', { get: getter, configurable: true })
    if (kind === 'nonconfigurable-writable-constructor') Object.defineProperty(raw, 'constructor', { value: { [Symbol.species]: getter }, writable: true })
    const before = Object.getOwnPropertyDescriptor(raw, 'constructor'), f = fixture(() => raw)
    try { await expect(f.control.fetch('https://fixture.invalid')).rejects.toMatchObject({ code: 'PROVIDER_RAW_WORK_OWNERSHIP' }) }
    finally { f.control.dispose() }
    await flush(); expect(getter).not.toHaveBeenCalled(); expect(Object.getOwnPropertyDescriptor(raw, 'constructor')).toEqual(before); expect(f.drained()).toBe(false)
  })
  it('invalid rejected subclass retainer is observed, but never activates work or leaks a timer', async () => {
    vi.useFakeTimers(); let drain!: Promise<void>
    const retainRawWork: ProviderRawWorkRetainer = (p, enter) => { drain = p; enter(); return new (class extends Promise<void> {})((_yes, no) => no(Error('invalid retainer rejected native'))) }
    expect(() => new OpenAIRequestControl(vi.fn<typeof fetch>(), undefined, 1000, { retainRawWork })).toThrow(/synchronously/i)
    await drain; await flush(); expect(vi.getTimerCount()).toBe(0)
  })
  it('unmaskable constructor accessor is never read; trusted delegate owns its already-observed invalid rejection', async () => {
    const raw = Promise.reject<Response>(Error('unmaskable rejection')), getter = vi.fn(() => { throw Error('must not read') })
    // This is an explicit supplier obligation, not a claim that portable JS can
    // attach Promise reactions through an immutable hostile SpeciesConstructor.
    void raw.catch(() => undefined)
    Object.defineProperty(raw, 'constructor', { get: getter, configurable: false })
    const f = fixture(() => raw)
    try { await expect(f.control.fetch('https://fixture.invalid')).rejects.toMatchObject({ code: 'PROVIDER_RAW_WORK_OWNERSHIP' }) }
    finally { f.control.dispose() }
    await flush(); expect(getter).not.toHaveBeenCalled(); expect(f.drained()).toBe(false)
  })
  it('ordinary controls preserve their legacy no-body invocation ordering without opting in', async () => {
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>()), called = vi.fn(async () => 'ordinary'); control.dispose()
    await expect(control.text(noBody('text', called), 1024)).rejects.toThrow(/disposed/i); expect(called).toHaveBeenCalledOnce()
  })
})
