import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createElectronRequestFetch, type ElectronRequestFactory, type ElectronTransportAdmission } from './electronRequestFetch'
vi.mock('electron', () => ({ net: {} }))

function fixture() {
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  const incoming = Object.assign(new EventEmitter(), { headers: {}, statusCode: 200, statusMessage: 'OK' })
  const client = Object.assign(new EventEmitter(), { abort: vi.fn(() => { client.emit('abort') }), end: vi.fn(() => signalStarted()), setHeader: vi.fn() })
  const factory = vi.fn<ElectronRequestFactory>(() => client)
  return { started, incoming, client, factory }
}
function gate() {
  let ended = false, inStartup = false
  const admission: ElectronTransportAdmission = start => {
    if (ended) throw Error('ended')
    inStartup = true
    try { start() } finally { inStartup = false }
  }
  return { admission, end() { if (inStartup) throw Error('busy'); ended = true } }
}
const url = 'https://example.test/chat'
const options: RequestInit = { method: 'POST', body: 'hello', headers: { 'x-test': 'yes' }, redirect: 'error' }

describe('MAIN-only synchronous transport admission (not production team authorization)', () => {
  it.each(['follow', 'manual'] as const)('denies admitted %s redirects before invoking the factory', async redirect => {
    const f = fixture(), g = gate()
    await expect(createElectronRequestFetch(f.factory, g.admission)(url, { ...options, redirect })).rejects.toThrow('redirect refusal')
    expect(f.factory).not.toHaveBeenCalled()
  })
  it('leaves ordinary redirect behavior unchanged', async () => {
    const f = fixture()
    const pending = createElectronRequestFetch(f.factory)(url, { ...options, redirect: 'follow' })
    await f.started
    expect(f.factory).toHaveBeenCalledWith(expect.objectContaining({ redirect: 'follow' }))
    f.client.emit('response', f.incoming)
    const response = await pending
    const text = response.text(); f.incoming.emit('end')
    await expect(text).resolves.toBe('')
  })
  it('denies End before request creation', async () => {
    const f = fixture(), g = gate(); g.end()
    await expect(createElectronRequestFetch(f.factory, g.admission)(url, options)).rejects.toThrow('ended')
    expect(f.factory).not.toHaveBeenCalled()
  })
  it('checks after asynchronous body production and refuses if ended while waiting', async () => {
    const f = fixture(), g = gate(); let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    const req = new Request(url, { method: 'POST', body, redirect: 'error', duplex: 'half' } as RequestInit)
    const pending = createElectronRequestFetch(f.factory, g.admission)(req)
    g.end(); controller.enqueue(new TextEncoder().encode('x')); controller.close()
    await expect(pending).rejects.toThrow('ended'); expect(f.factory).not.toHaveBeenCalled()
  })
  it('holds admission over factory, headers, and end; End afterwards does not abort response', async () => {
    const f = fixture(), g = gate()
    f.factory.mockImplementation(() => { expect(() => g.end()).toThrow('busy'); return f.client })
    f.client.setHeader.mockImplementation(() => { expect(() => g.end()).toThrow('busy') })
    f.client.end.mockImplementation(() => { expect(() => g.end()).toThrow('busy') })
    const pending = createElectronRequestFetch(f.factory, g.admission)(url, options)
    await vi.waitFor(() => expect(f.client.end).toHaveBeenCalledOnce())
    g.end(); expect(f.client.abort).not.toHaveBeenCalled()
    f.client.emit('response', f.incoming); const response = await pending
    const text = response.text(); f.incoming.emit('data', Buffer.from('ok')); f.incoming.emit('end')
    await expect(text).resolves.toBe('ok'); expect(f.client.abort).not.toHaveBeenCalled()
  })
  it.each(['header', 'end'] as const)('cleans up a synchronous %s failure', async part => {
    const f = fixture()
    if (part === 'header') f.client.setHeader.mockImplementation(() => { throw Error('startup failed') })
    else f.client.end.mockImplementation(() => { throw Error('startup failed') })
    await expect(createElectronRequestFetch(f.factory, start => start())(url, options)).rejects.toThrow('startup failed')
    expect(f.client.abort).toHaveBeenCalledOnce()
  })
  it('keeps ordinary startup and explicit abort behavior', async () => {
    const f = fixture(), abort = new AbortController()
    const pending = createElectronRequestFetch(f.factory)(url, { ...options, signal: abort.signal })
    await f.started; abort.abort(Error('stop'))
    await expect(pending).rejects.toThrow('stop'); expect(f.client.abort).toHaveBeenCalledOnce()
  })
  it('observes an asynchronous rejected admission and never calls its deferred start', async () => {
    const f = fixture()
    const pending = createElectronRequestFetch(f.factory, async start => {
      await Promise.resolve()
      start()
    })(url, options)
    await expect(pending).rejects.toThrow('did not synchronously')
    await Promise.resolve(); await Promise.resolve()
    expect(f.factory).not.toHaveBeenCalled()
  })
  it('settles a factory error even if admission swallows it', async () => {
    const f = fixture()
    f.factory.mockImplementation(() => { throw Error('factory failure') })
    const admission: ElectronTransportAdmission = start => { try { start() } catch { /* untrusted failure handling */ } }
    await expect(createElectronRequestFetch(f.factory, admission)(url, options)).rejects.toThrow('factory failure')
  })
  it.each(['throw', 'async-reject'] as const)('preserves the response when admission fails after start: %s', async mode => {
    const f = fixture()
    const admission: ElectronTransportAdmission = mode === 'throw'
      ? start => { start(); throw Error('post-start failure') }
      : async start => { start(); throw Error('post-start failure') }
    const pending = createElectronRequestFetch(f.factory, admission)(url, options)
    await f.started
    expect(f.client.abort).not.toHaveBeenCalled()
    f.client.emit('response', f.incoming)
    const response = await pending, text = response.text()
    f.incoming.emit('data', Buffer.from('ok')); f.incoming.emit('end')
    await expect(text).resolves.toBe('ok'); expect(f.client.abort).not.toHaveBeenCalled()
  })
  it('does not submit end when explicit cancellation fires during setHeader', async () => {
    const f = fixture(), abort = new AbortController()
    f.client.setHeader.mockImplementationOnce(() => abort.abort(Error('header stop')))
    const pending = createElectronRequestFetch(f.factory, start => start())(url, { ...options, signal: abort.signal })
    await expect(pending).rejects.toThrow('header stop')
    expect(f.client.abort).toHaveBeenCalledOnce(); expect(f.client.end).not.toHaveBeenCalled()
  })
  it('rejects a deferred admission callback and never starts it later', async () => {
    const f = fixture(); let deferred!: () => void
    const pending = createElectronRequestFetch(f.factory, start => { deferred = start })(url, options)
    await expect(pending).rejects.toThrow('did not synchronously')
    expect(() => deferred()).toThrow('synchronously'); expect(f.factory).not.toHaveBeenCalled()
  })
})
