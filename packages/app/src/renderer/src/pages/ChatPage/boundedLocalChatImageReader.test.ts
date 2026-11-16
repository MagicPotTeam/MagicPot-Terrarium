import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBoundedLocalChatImageBlob } from './boundedLocalChatImageReader'

const controllers: AbortController[] = []
const makeController = () => {
  const controller = new AbortController()
  controllers.push(controller)
  return controller
}

// High-water mark zero avoids mistaking consumer-side cancellation for a
// producer which eagerly read ahead. Tests deliberately use tiny byte limits.
const makeResponse = (values: Uint8Array[], type = 'image/png') => {
  let cursor = 0
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor === values.length) controller.close()
      else controller.enqueue(values[cursor++])
    },
    cancel
  }, { highWaterMark: 0 })
  return { response: new Response(stream, { headers: { 'content-type': type } }), cancel }
}

const readBytes = (blob: Blob): Promise<Uint8Array> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
  reader.onerror = () => reject(reader.error)
  reader.readAsArrayBuffer(blob)
})

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort()
  vi.restoreAllMocks()
})

describe('bounded local chat source reader', () => {
  it('allows exactly the actual source byte limit and preserves the response MIME', async () => {
    const { response, cancel } = makeResponse([new Uint8Array([1, 2]), new Uint8Array([3])], 'image/webp')
    const blob = await readBoundedLocalChatImageBlob(response, { maxBytes: 3 })
    expect(blob.size).toBe(3)
    expect(blob.type).toBe('image/webp')
    expect(await readBytes(blob)).toEqual(new Uint8Array([1, 2, 3]))
    expect(cancel).not.toHaveBeenCalled()
  })

  it.each([
    ['image/png; charset=binary', 'image/png'],
    ['Image/PNG', 'image/png'],
    [' image/jpeg ;q=1', 'image/jpeg'],
    ['text/html, image/webp', 'image/webp'],
    ['image/png, bogus', 'image/png'],
    ['not a mime', ''],
    ['*/*', '']
  ])('types the blob with the MIME essence of %j, as response.blob() does', async (header, expected) => {
    const { response } = makeResponse([new Uint8Array([1])], header)
    const blob = await readBoundedLocalChatImageBlob(response, { maxBytes: 3 })
    expect(blob.type).toBe(expected)
  })

  it('cancels before accepting a chunk that exceeds the remaining bytes', async () => {
    const { response, cancel } = makeResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])])
    await expect(readBoundedLocalChatImageBlob(response, { maxBytes: 3 })).rejects.toThrow('Image source exceeds')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('fails and cancels after excessive fragmented or empty chunks even under the byte limit', async () => {
    const { response, cancel } = makeResponse(Array.from({ length: 8193 }, () => new Uint8Array(0)))
    await expect(readBoundedLocalChatImageBlob(response, { maxBytes: 3 })).rejects.toThrow('chunk limit')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not start a pre-aborted stream read', async () => {
    const abort = makeController()
    abort.abort('fixture cancellation')
    const getReader = vi.fn()
    const response = { body: { getReader }, headers: new Headers() } as unknown as Response
    await expect(readBoundedLocalChatImageBlob(response, { maxBytes: 3, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(getReader).not.toHaveBeenCalled()
  })

  it('does not trust a smaller Content-Length and rejects when actual bytes exceed it', async () => {
    const { response, cancel } = makeResponse([new Uint8Array([1, 2, 3, 4])])
    response.headers.set('content-length', '1')
    await expect(readBoundedLocalChatImageBlob(response, { maxBytes: 3 })).rejects.toThrow('Image source exceeds')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('fails closed rather than invoking blob/arrayBuffer when the body is absent', async () => {
    const blob = vi.fn()
    const arrayBuffer = vi.fn()
    const response = { ok: true, body: null, headers: new Headers(), blob, arrayBuffer } as unknown as Response
    await expect(readBoundedLocalChatImageBlob(response, { maxBytes: 3 })).rejects.toThrow('readable body')
    expect(blob).not.toHaveBeenCalled()
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('aborts a stalled read, cancels once, and ignores a late producer result', async () => {
    const abort = makeController()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value },
      pull() { /* deliberately pending */ },
      cancel
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'image/png' } })
    const pending = readBoundedLocalChatImageBlob(response, { maxBytes: 3, signal: abort.signal })
    abort.abort('fixture cancellation')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(() => controller.enqueue(new Uint8Array([1]))).toThrow()
  })

  it('rejects promptly when a reader ignores cancel and later resolves', async () => {
    const abort = makeController()
    let finish!: (value: ReadableStreamReadResult<Uint8Array>) => void
    const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => { finish = resolve }))
    const cancel = vi.fn(() => Promise.resolve())
    const releaseLock = vi.fn()
    const response = {
      body: { getReader: () => ({ read, cancel, releaseLock }) },
      headers: new Headers({ 'content-type': 'image/png' })
    } as unknown as Response
    const pending = readBoundedLocalChatImageBlob(response, { maxBytes: 3, signal: abort.signal })
    expect(read).toHaveBeenCalledOnce()
    abort.abort('fixture cancellation')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(releaseLock).toHaveBeenCalledOnce()
    finish({ done: false, value: new Uint8Array([1, 2, 3]) })
    await Promise.resolve()
    expect(read).toHaveBeenCalledOnce()
  })

  it('accepts and copies the chunk of a platform Response even when it is not an instance of this realm', async () => {
    const bytes = new Uint8Array([7, 8, 9])
    const probe = await new Response(bytes).body!.getReader().read()
    // Under jsdom the platform fetch types come from the Node realm: instanceof fails.
    expect(probe.value instanceof Uint8Array).toBe(false)
    const response = new Response(bytes, { headers: { 'content-type': 'image/png' } })
    const blob = await readBoundedLocalChatImageBlob(response, { maxBytes: 3 })
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(3)
    expect(await readBytes(blob)).toEqual(new Uint8Array([7, 8, 9]))
  })

  it.each([
    ['a string', () => 'abc'],
    ['a DataView', () => new DataView(new ArrayBuffer(2))],
    ['a Uint16Array', () => new Uint16Array([1])],
    ['a DataView with a forged own Symbol.toStringTag', () => {
      const view = new DataView(new ArrayBuffer(2))
      Object.defineProperty(view, Symbol.toStringTag, { value: 'Uint8Array' })
      return view
    }],
    ['a plain object posing as a Uint8Array', () => ({ byteLength: 1, [Symbol.toStringTag]: 'Uint8Array' })]
  ])('refuses and cancels on %s chunk', async (_label, makeChunk) => {
    const { response, cancel } = makeResponse([makeChunk() as unknown as Uint8Array])
    await expect(readBoundedLocalChatImageBlob(response, { maxBytes: 3 })).rejects.toThrow('invalid chunk')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not retain mutable chunk views supplied by an adapter', async () => {
    const first = new Uint8Array([1, 2])
    let step = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step++ === 0) controller.enqueue(first)
        else if (step === 2) { first.fill(9); controller.enqueue(new Uint8Array([3])) }
        else controller.close()
      }
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'image/png' } })
    const blob = await readBoundedLocalChatImageBlob(response, { maxBytes: 3 })
    expect(await readBytes(blob)).toEqual(new Uint8Array([1, 2, 3]))
  })
})
