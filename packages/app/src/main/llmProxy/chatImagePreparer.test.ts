import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { runChatImageWorker } from './chatImageWorker'
import { ChatImagePreparer, type ChatImageEncoder } from './chatImagePreparer'

// A structurally recognized PNG is returned unchanged by the fake; the modified
// IHDR-only fixture below is not a pixel-valid PNG. No real codec runs in these tests.
const png = () => Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'))
const fake = () => {
  const encode = vi.fn(async (_bytes: Uint8Array, _options: Parameters<ChatImageEncoder['encode']>[1]) => png())
  return { encode, encoder: { encode } as ChatImageEncoder }
}

describe('ChatImagePreparer (fake encoder)', () => {
  it('checks bytes and metadata, caches copies and does not mutate source', async () => {
    const f = fake(), source = png(), original = Uint8Array.from(source), p = new ChatImagePreparer(f.encoder)
    const result = await p.prepare(source)
    expect(result).toMatchObject({ mimeType: 'image/png', width: 1, height: 1 })
    expect(f.encode.mock.calls[0][1]).toMatchObject({targetBytes:512000,maxEdge:2000,maxPixels:40000000})
    result.bytes[0] = 0
    expect((await p.prepare(source)).bytes).toEqual(original)
    expect(source).toEqual(original)
    expect(f.encode).toHaveBeenCalledOnce()
  })
  it('snapshots the same validated bytes even if the source overrides its iterator', async () => {
    const f = fake(), source = png(), original = png()
    const iterator = vi.fn(function* () { yield* [1, 2, 3] })
    Object.defineProperty(source, Symbol.iterator, { value: iterator })
    const access = vi.fn(() => { throw new Error('shadow getter called') })
    Object.defineProperties(source, { buffer: { get: access }, byteLength: { get: access }, byteOffset: { get: access } })
    const result = await new ChatImagePreparer(f.encoder).prepare(source)
    expect(iterator).not.toHaveBeenCalled()
    expect(access).not.toHaveBeenCalled()
    expect(f.encode.mock.calls[0][0]).toEqual(original)
    expect(result.bytes).toEqual(original)
  })
  it('rejects shared source buffers and typed-array proxies without invoking their properties', async () => {
    const f = fake(), p = new ChatImagePreparer(f.encoder)
    const shared = new Uint8Array(new SharedArrayBuffer(png().length))
    shared.set(png())
    const trap = vi.fn(() => { throw new Error('proxy trap called') })
    Object.setPrototypeOf(shared.buffer, null)
    Object.defineProperty(shared, 'buffer', { get: trap })
    const proxy = new Proxy(png(), { get: trap, getPrototypeOf: trap })
    await expect(p.prepare(shared)).rejects.toThrow('Invalid source bytes')
    await expect(p.prepare(proxy)).rejects.toThrow('Invalid source bytes')
    expect(trap).not.toHaveBeenCalled()
    expect(f.encode).not.toHaveBeenCalled()
  })
  it('preserves the exact subarray bounds and snapshots before a later mutation', async () => {
    const f = fake(), original = png(), buffer = new Uint8Array(original.length + 12)
    buffer.set(original, 5)
    const source = buffer.subarray(5, 5 + original.length)
    let release!: () => void
    f.encode.mockImplementationOnce(async bytes => {
      await new Promise<void>(resolve => { release = resolve })
      expect(bytes).toEqual(original)
      return png()
    })
    const pending = new ChatImagePreparer(f.encoder).prepare(source)
    source.fill(0)
    await vi.waitFor(() => expect(release).toBeDefined())
    release()
    await expect(pending).resolves.toMatchObject({ bytes: original })
  })
  it('checks the real output length and bytes instead of output getters or iterators', async () => {
    const f = fake(), output = png(), iterator = vi.fn(function* () { yield* [1, 2, 3] })
    const access = vi.fn(() => { throw new Error('shadow getter called') })
    Object.defineProperty(output, Symbol.iterator, { value: iterator })
    Object.defineProperties(output, { buffer: { get: access }, byteLength: { get: access }, byteOffset: { get: access }, length: { get: access } })
    f.encode.mockResolvedValueOnce(output)
    await expect(new ChatImagePreparer(f.encoder).prepare(png())).resolves.toMatchObject({ bytes: png() })
    expect(iterator).not.toHaveBeenCalled()
    expect(access).not.toHaveBeenCalled()
  })
  it('rejects malformed, over-budget and non-image encoder outputs', async () => {
    const f = fake(), p = new ChatImagePreparer(f.encoder)
    f.encode.mockResolvedValueOnce(new Uint8Array([1,2,3]))
    await expect(p.prepare(png())).rejects.toThrow()
    await expect(p.prepare(png(), {targetBytes:1})).rejects.toThrow()
    expect(f.encode).toHaveBeenCalledTimes(2)
  })
  it('rejects excessive input pixels before encoder', async () => {
    const f = fake(), input = png(), view = new DataView(input.buffer)
    view.setUint32(16, 7000); view.setUint32(20, 7000)
    let crc = 0xffffffff
    for (const byte of input.subarray(12, 29)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    view.setUint32(29, (crc ^ 0xffffffff) >>> 0)
    await expect(new ChatImagePreparer(f.encoder).prepare(input)).rejects.toThrow()
    expect(f.encode).not.toHaveBeenCalled()
  })
  it('evicts by LRU byte limit', async () => {
    const f = fake(), p = new ChatImagePreparer(f.encoder, {entries:2,bytes:png().length})
    await p.prepare(png(), {targetBytes:100}); await p.prepare(png(), {targetBytes:101}); await p.prepare(png(), {targetBytes:100})
    expect(f.encode).toHaveBeenCalledTimes(3)
  })
  it('coalesces concurrent requests and isolates one caller abort', async () => {
    const f = fake(); let release!: () => void
    f.encode.mockImplementationOnce(async () => { await new Promise<void>(resolve => {release=resolve}); return png() })
    const p = new ChatImagePreparer(f.encoder), controller = new AbortController()
    const a = p.prepare(png(), {}, controller.signal), b = p.prepare(png())
    await vi.waitFor(() => expect(release).toBeDefined())
    controller.abort(); await expect(a).rejects.toMatchObject({name:'AbortError'})
    release(); await expect(b).resolves.toMatchObject({mimeType:'image/png'})
    expect(f.encode).toHaveBeenCalledOnce()
  })
  it('blocks retry while an aborted backend is still running, then cleans up', async () => {
    const f = fake(); let release!: () => void
    f.encode.mockImplementationOnce(async () => { await new Promise<void>(resolve => {release=resolve}); return png() })
    const p = new ChatImagePreparer(f.encoder), controller = new AbortController()
    const first = p.prepare(png(), {}, controller.signal)
    await vi.waitFor(() => expect(release).toBeDefined())
    controller.abort(); await expect(first).rejects.toMatchObject({name:'AbortError'})
    await expect(p.prepare(png())).rejects.toMatchObject({name:'AbortError'})
    release(); await vi.waitFor(() => expect(f.encode).toHaveBeenCalledTimes(1))
    await vi.waitFor(async () => { await expect(p.prepare(png())).resolves.toMatchObject({width:1}) })
    expect(f.encode).toHaveBeenCalledTimes(2)
  })
  it('does not start another worker after caller abort until the first child actually closes', async () => {
    class Child extends EventEmitter {
      stdin = new PassThrough()
      stdout = new PassThrough()
      stderr = new PassThrough()
      kill = vi.fn(() => true)
    }
    const children: Child[] = []
    const spawn = vi.fn(() => {
      const child = new Child()
      children.push(child)
      return child as unknown as ChildProcessWithoutNullStreams
    })
    const binaryPath = process.platform === 'win32' ? 'C:\\safe\\image-worker.exe' : '/safe/image-worker'
    const encoder: ChatImageEncoder = {
      encode: async (source, options) => (await runChatImageWorker({ binaryPath, source, targetBytes: options.targetBytes, maxEdge: options.maxEdge, signal: options.signal }, spawn)).bytes
    }
    const preparer = new ChatImagePreparer(encoder)
    const abort = new AbortController()
    const first = preparer.prepare(png(), {}, abort.signal)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    abort.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(children[0].kill).toHaveBeenCalledOnce()
    const next = preparer.prepare(png(), { targetBytes: 100 })
    await new Promise(resolve => setImmediate(resolve))
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0].stdout.write(png())
    children[0].emit('close', 0)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    children[1].stdout.write(png())
    children[1].emit('close', 0)
    await expect(next).resolves.toMatchObject({ width: 1, height: 1 })
  })
  it('reserves a fair share for later images and carries forward unused bytes', async () => {
    const f = fake(), p = new ChatImagePreparer(f.encoder), n = png().length
    await expect(p.prepareBatch([png(), png()], n * 3)).resolves.toHaveLength(2)
    expect(f.encode.mock.calls.map(call => call[1].targetBytes)).toEqual([Math.floor(n * 3 / 2), n * 2])
  })
  it('rejects inputs above the 20 MiB parser boundary before calling the worker', async () => {
    const f = fake(), p = new ChatImagePreparer(f.encoder)
    await expect(p.prepare(new Uint8Array(20 * 1024 * 1024 + 1))).rejects.toThrow('Invalid source bytes')
    expect(f.encode).not.toHaveBeenCalled()
  })
  it('serializes different keys across preparer instances and cancels queued work', async () => {
    const f = fake(); let release!: () => void
    f.encode.mockImplementationOnce(async () => { await new Promise<void>(resolve => {release = resolve}); return png() })
    const a = new ChatImagePreparer(f.encoder), b = new ChatImagePreparer(f.encoder), controller = new AbortController()
    const first = a.prepare(png()); const queued = b.prepare(png(), {targetBytes:100}, controller.signal)
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(f.encode).toHaveBeenCalledTimes(1)
    controller.abort(); await expect(queued).rejects.toMatchObject({name:'AbortError'})
    release(); await first
    await expect(b.prepare(png(), {targetBytes:101})).resolves.toMatchObject({width:1})
    expect(f.encode).toHaveBeenCalledTimes(2)
  })
  it('clear aborts queued and running work without opening a second active encoder', async () => {
    const f = fake(); let release!: () => void
    f.encode.mockImplementationOnce(async () => { await new Promise<void>(resolve => {release = resolve}); return png() })
    const a = new ChatImagePreparer(f.encoder), b = new ChatImagePreparer(f.encoder)
    const first = a.prepare(png()); const observedFirst = first.catch(e => e)
    const queued = b.prepare(png(), {targetBytes:100}); const observedQueued = queued.catch(e => e)
    await vi.waitFor(() => expect(release).toBeDefined())
    b.clear(); expect((await observedQueued).name).toBe('AbortError')
    a.clear()
    const next = b.prepare(png(), {targetBytes:101})
    await Promise.resolve(); expect(f.encode).toHaveBeenCalledTimes(1)
    release(); expect((await observedFirst).name).toBe('AbortError')
    await expect(next).resolves.toMatchObject({width:1})
    expect(f.encode).toHaveBeenCalledTimes(2)
  })
  it('bounds admission count and frees cancelled queued slots', async () => {
    const f = fake(); let release!: () => void
    f.encode.mockImplementationOnce(async () => { await new Promise<void>(resolve => {release = resolve}); return png() })
    const p = new ChatImagePreparer(f.encoder), controller = new AbortController()
    const first = p.prepare(png()); const pending = Array.from({length:49}, (_, i) => p.prepare(png(), {targetBytes:100+i}, controller.signal).catch(e => e))
    await expect(p.prepare(png(), {targetBytes:300})).rejects.toThrow('queue full')
    await vi.waitFor(() => expect(release).toBeDefined())
    controller.abort(); await Promise.all(pending)
    release(); await first
    await expect(p.prepare(png(), {targetBytes:300})).resolves.toMatchObject({width:1})
  })
  it('freezes all batch images and options before waiting for the first encoder', async () => {
    const f = fake(); let release!: () => void
    f.encode.mockImplementationOnce(async () => { await new Promise<void>(resolve => {release = resolve}); return png() })
    const first = png(), second = png(), sources = [first, second], options = {targetBytes: 200, maxSide: 1000}
    // Recompute IHDR CRC after changing the width; the fake never decodes this fixture.
    const view = new DataView(second.buffer)
    view.setUint32(16, 2)
    let crc = 0xffffffff
    for (const byte of second.subarray(12, 29)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    view.setUint32(29, (crc ^ 0xffffffff) >>> 0)
    const expectedSecond = Uint8Array.from(second)
    const p = new ChatImagePreparer(f.encoder), pending = p.prepareBatch(sources, 1000, options)
    await vi.waitFor(() => expect(release).toBeDefined())
    second.fill(0); sources.length = 1; options.maxSide = 1; options.targetBytes = 1
    release()
    await expect(pending).resolves.toHaveLength(2)
    expect(f.encode).toHaveBeenCalledTimes(2)
    expect(f.encode.mock.calls[1][0]).toEqual(expectedSecond)
    expect(f.encode.mock.calls[1][1]).toMatchObject({ targetBytes: 200, maxEdge: 1000 })
  })
  it('rejects batch accessor and proxy inputs without invoking traps', async () => {
    const f = fake(), p = new ChatImagePreparer(f.encoder), trap = vi.fn(() => { throw new Error('trap') })
    const arr = [png()]; Object.defineProperty(arr, '0', {get:trap})
    await expect(p.prepareBatch(arr, 1000)).rejects.toThrow()
    const proxy = new Proxy([png()], {get:trap, getOwnPropertyDescriptor:trap})
    await expect(p.prepareBatch(proxy, 1000)).rejects.toThrow()
    expect(trap).not.toHaveBeenCalled()
    expect(f.encode).not.toHaveBeenCalled()
  })
  it('rejects shared, proxied and accessor batch inputs without executing traps', async () => {
    const f = fake(), p = new ChatImagePreparer(f.encoder), trap = vi.fn(() => { throw Error('trap') })
    const shared = new Uint8Array(new SharedArrayBuffer(png().length))
    const opts = Object.defineProperty({}, 'targetBytes', {get: trap})
    await expect(p.prepareBatch([shared], 1000)).rejects.toThrow()
    await expect(p.prepareBatch([new Proxy(png(), {get:trap})], 1000)).rejects.toThrow()
    await expect(p.prepareBatch([png()], 1000, opts)).rejects.toThrow()
    await expect(p.prepareBatch([png()], 1000, new Proxy({}, {getOwnPropertyDescriptor:trap}))).rejects.toThrow()
    expect(trap).not.toHaveBeenCalled(); expect(f.encode).not.toHaveBeenCalled()
  })
  it('bounds batch source bytes and releases reservation after abort', async () => {
    const f = fake(); let release!: () => void
    f.encode.mockImplementationOnce(async () => { await new Promise<void>(resolve => {release=resolve}); return png() })
    const p = new ChatImagePreparer(f.encoder), controller = new AbortController()
    await expect(p.prepareBatch([new Uint8Array(17*1024*1024),new Uint8Array(16*1024*1024)], 1000)).rejects.toThrow('Batch source budget')
    const pending = p.prepareBatch([png(),png()], 1000, {}, controller.signal)
    await vi.waitFor(() => expect(release).toBeDefined())
    controller.abort(); await expect(pending).rejects.toMatchObject({name:'AbortError'})
    release()
    await vi.waitFor(async () => { await expect(p.prepareBatch([png()],1000)).resolves.toHaveLength(1) })
  })
  it('enforces aggregate budget without returning a partial batch', async () => {
    const f = fake(), p = new ChatImagePreparer(f.encoder), n = png().length
    await expect(p.prepareBatch([png(),png()], n * 2)).resolves.toHaveLength(2)
    await expect(p.prepareBatch([png(),png()], n)).rejects.toThrow('budget')
  })
})
