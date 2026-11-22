import { EventEmitter } from 'node:events'
import { net } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { withCooperativeOperation } from '../assistantRuntime/cooperativeOperation'
import { createProviderRawWorkRetainer } from '../assistantRuntime/providerRawWorkRetention'
import { createMainProcessManagedElectronFetch, createManagedElectronRequestFetch, type ElectronRequestFactory } from './electronRequestFetch'
vi.mock('electron', () => ({ net: {} }))
const endpoint = 'http://127.0.0.1:1/v1/chat/completions'
const fixture = () => {
  let sent!: () => void
  const dispatched = new Promise<void>(resolve => { sent = resolve })
  const incoming = Object.assign(new EventEmitter(), { headers: { 'content-type': 'application/json' }, statusCode: 200, statusMessage: 'OK', pause: vi.fn(), resume: vi.fn() })
  const client = Object.assign(new EventEmitter(), { abort: vi.fn(() => { client.emit('abort') }), end: vi.fn(sent), setHeader: vi.fn() })
  const factory = vi.fn<ElectronRequestFactory>(() => client)
  return { client, incoming, factory, dispatched }
}
const options = (signal?: AbortSignal): RequestInit => ({ method: 'POST', body: '{"only":"prepared-text"}', redirect: 'error', credentials: 'omit', signal })
async function start(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
  const owner = new CooperativeExecutionController()
  let fetchPromise!: Promise<Response>
  let stop!: () => void
  const registered = new Promise<void>(resolve => { stop = resolve })
  // The exact chat parent remains until fetch caller settles. Transport passive
  // child must survive that settlement but may not admit new provider work.
  const caller = withCooperativeOperation(owner, 'llm-inference', signal, async child => {
    try {
      const fetcher = createManagedElectronRequestFetch(f.factory, createProviderRawWorkRetainer(child, signal, () => undefined), () => undefined)
      fetchPromise = fetcher(endpoint, options(signal))
      return fetchPromise
    } finally { stop() }
  })
  void caller.catch(() => undefined)
  await registered
  return { owner, caller, fetchPromise }
}
afterEach(() => { Reflect.deleteProperty(net, 'request'); Reflect.deleteProperty(net, 'fetch'); vi.restoreAllMocks() })

describe('managed Electron transaction last-close ownership; no production clean claim', () => {
  it.each(['end', 'cancel', 'abort', 'error'] as const)('retains %s transaction until actual last close while fetch caller remains responsive', async kind => {
    const f = fixture(), abort = new AbortController(), { owner, caller } = await start(f, abort.signal)
    await f.dispatched
    if (kind === 'abort') { abort.abort(Error('caller stop')); await expect(caller).rejects.toThrow('caller stop') }
    else if (kind === 'error') { f.client.emit('error', Error('transport error')); await expect(caller).rejects.toThrow('transport error') }
    else {
      f.client.emit('response', f.incoming)
      const response = await caller
      if (kind === 'cancel') await response.body!.cancel()
      else { const text = response.text(); f.incoming.emit('data', Buffer.from('ok')); f.incoming.emit('end'); await expect(text).resolves.toBe('ok') }
    }
    expect(owner.isQuiescent()).toBe(false)
    let joined = false
    const join = owner.whenQuiescent().then(() => { joined = true })
    await Promise.resolve(); expect(joined).toBe(false)
    expect(f.client.abort).toHaveBeenCalledTimes(kind === 'end' ? 0 : 1)
    expect(() => f.client.emit('close')).not.toThrow()
    await join; expect(owner.isQuiescent()).toBe(true)
    // Response may arrive after an abort/error; it must be safely rejected too.
    if (kind === 'abort' || kind === 'error') f.client.emit('response', f.incoming)
    expect(() => { f.client.emit('error', Error('late request')); f.incoming.emit('error', Error('late response')) }).not.toThrow()
  })
  it.each(['before-response', 'during-response', 'synchronous-end'] as const)('quarantines an unqualified close %s instead of releasing native ownership', async when => {
    const f = fixture()
    if (when === 'synchronous-end') f.client.end.mockImplementationOnce(() => { f.client.emit('close') })
    const { owner, caller } = await start(f)
    if (when !== 'synchronous-end') await f.dispatched
    let text: Promise<string> | undefined
    if (when === 'during-response') {
      f.client.emit('response', f.incoming)
      const response = await caller
      text = response.text(); void text.catch(() => undefined)
      f.incoming.emit('data', Buffer.from('partial'))
    }
    if (when !== 'synchronous-end') expect(() => f.client.emit('close')).not.toThrow()
    if (text) await expect(text).rejects.toThrow(/close|transaction/i)
    else await expect(caller).rejects.toThrow(/close|transaction/i)
    let joined = false
    void owner.whenQuiescent().then(() => { joined = true })
    await Promise.resolve(); await Promise.resolve()
    expect(owner.isQuiescent()).toBe(false); expect(joined).toBe(false)
    expect(f.client.abort).toHaveBeenCalledOnce()
    // A late response, error, end, or second close cannot rehabilitate the first
    // impossible close into positive last-event proof or free admission capacity.
    expect(() => { f.client.emit('response', f.incoming); f.client.emit('error', Error('late native error')); f.incoming.emit('end'); f.client.emit('close') }).not.toThrow()
    await Promise.resolve(); await Promise.resolve()
    expect(owner.isQuiescent()).toBe(false); expect(joined).toBe(false)
  })
  it('keeps unexpected-close ownership quarantined even when its best-effort abort throws', async () => {
    const f = fixture(), { owner, caller } = await start(f)
    f.client.abort.mockImplementationOnce(() => { throw Error('native abort failed') })
    expect(() => f.client.emit('close')).not.toThrow()
    await expect(caller).rejects.toThrow(/close|transaction/i)
    expect(f.client.abort).toHaveBeenCalledOnce(); expect(owner.isQuiescent()).toBe(false)
    f.client.emit('abort'); f.client.emit('error', Error('late error')); f.client.emit('close')
    await Promise.resolve(); expect(owner.isQuiescent()).toBe(false)
  })
  it.each(['before-close', 'close-then-throw', 'abort-close-then-throw'] as const)('never qualifies first close from a failed abort %s', async when => {
    const f = fixture(), { owner, caller } = await start(f)
    f.client.abort.mockImplementationOnce(() => {
      if (when === 'abort-close-then-throw') f.client.emit('abort')
      if (when !== 'before-close') f.client.emit('close')
      throw Error('native abort failed before positive closure')
    })
    // Preserve the original caller failure while treating abort as best-effort.
    expect(() => f.client.emit('error', Error('original transport failure'))).not.toThrow()
    await expect(caller).rejects.toThrow('original transport failure')
    if (when === 'before-close') f.client.emit('close')
    await Promise.resolve(); await Promise.resolve()
    expect(f.client.abort).toHaveBeenCalledOnce(); expect(owner.isQuiescent()).toBe(false)
    f.client.emit('abort'); f.client.emit('close'); f.client.emit('error', Error('late native failure'))
    await Promise.resolve(); expect(owner.isQuiescent()).toBe(false)
  })
  it.each(['abort-and-close', 'close-only'] as const)('defers a reentrant close until successful native abort returns: %s', async when => {
    const f = fixture(), { owner, caller } = await start(f)
    f.client.abort.mockImplementationOnce(() => {
      if (when === 'abort-and-close') f.client.emit('abort')
      f.client.emit('close')
      expect(owner.isQuiescent()).toBe(false)
    })
    expect(() => f.client.emit('error', Error('original transport failure'))).not.toThrow()
    await expect(caller).rejects.toThrow('original transport failure')
    await owner.whenQuiescent()
    expect(f.client.abort).toHaveBeenCalledOnce(); expect(owner.isQuiescent()).toBe(true)
  })
  it('rejects the observed incompatible Electron runtime before reading or invoking a native request factory', () => {
    const versions = process.versions as unknown as { electron?: string }, original = Object.getOwnPropertyDescriptor(versions, 'electron')
    Object.defineProperty(versions, 'electron', { value: '42.11.16', configurable: true })
    const request = vi.fn(), fallback = vi.fn(), retain = vi.fn(), guard = vi.fn()
    Object.defineProperty(net, 'request', { get: request, configurable: true })
    Object.defineProperty(net, 'fetch', { get: fallback, configurable: true })
    try {
      expect(() => createMainProcessManagedElectronFetch(retain, guard)).toThrow(/42\.11\.16|last.close|incompatible/i)
      expect(request).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled(); expect(retain).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled()
    } finally { if (original) Object.defineProperty(versions, 'electron', original); else Reflect.deleteProperty(versions, 'electron') }
  })
  it('registers close before synchronous end reenters abort; does not mistake abort for close', async () => {
    const f = fixture(), abort = new AbortController()
    f.client.end.mockImplementationOnce(() => { abort.abort(Error('end reentry')) })
    const { owner, caller } = await start(f, abort.signal)
    await expect(caller).rejects.toThrow('end reentry'); expect(owner.isQuiescent()).toBe(false)
    f.client.emit('close'); await owner.whenQuiescent(); expect(f.client.abort).toHaveBeenCalledOnce()
  })
  it('releases undispatched reservation if the trusted request factory throws', async () => {
    const f = fixture(); f.factory.mockImplementationOnce(() => { throw Error('factory failed without request') })
    const { owner, caller } = await start(f)
    await expect(caller).rejects.toThrow('factory failed without request'); await owner.whenQuiescent()
    expect(f.client.end).not.toHaveBeenCalled()
  })
  it('refuses a streaming upload before factory invocation or producer read/cancel', async () => {
    const f = fixture(), owner = new CooperativeExecutionController(), pull = vi.fn(), cancel = vi.fn()
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 })
    await expect(withCooperativeOperation(owner, 'llm-inference', undefined, async child => {
      const fetcher = createManagedElectronRequestFetch(f.factory, createProviderRawWorkRetainer(child, undefined, () => undefined), () => undefined)
      return fetcher(endpoint, { ...options(), body })
    })).rejects.toThrow(/text|body|prepared|upload/i)
    await owner.whenQuiescent(); expect(f.factory).not.toHaveBeenCalled(); expect(pull).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
  })
  it('does not dispatch if exact passive admission or final authority check refuses', async () => {
    const f = fixture(), check = vi.fn(() => { throw Error('revoked') })
    const fetcher = createManagedElectronRequestFetch(f.factory, () => { throw Error('no exact child') }, check)
    await expect(fetcher(endpoint, options())).rejects.toThrow(); expect(f.factory).not.toHaveBeenCalled()
  })
})
