import { describe, expect, it, vi } from 'vitest'
import { ProviderRequestControl } from './openaiRequestControl'
import { convertBoundedChatImageToBase64 } from './boundedChatImageReader'

const imageResponse = (body: ReadableStream<Uint8Array>, contentType = 'image/png'): Response =>
  new Response(body, { headers: { 'content-type': contentType } })

const bodyFrom = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })

const setup = (fetchImpl: typeof fetch, signal?: AbortSignal): ProviderRequestControl =>
  new ProviderRequestControl(fetchImpl, signal, 5_000, {}, 'Test')

describe('bounded provider chat image reader', () => {
  it('retains the first inline data segment without fetching and allows an exact limit', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const control = setup(fetchImpl)
    try {
      await expect(convertBoundedChatImageToBase64('data:image/png;base64,QQ==,ignored', control, 4)).resolves.toBe('QQ==')
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { control.dispose() }
  })

  it('rejects an inline segment over the limit before requesting anything', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const control = setup(fetchImpl)
    try {
      await expect(convertBoundedChatImageToBase64('data:image/png;base64,QUJDRA==', control, 4)).rejects.toThrow('per-image')
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { control.dispose() }
  })

  it('caps hostile oversized payload before a second separator without fetching', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const control = setup(fetchImpl)
    try {
      await expect(convertBoundedChatImageToBase64('data:image/png;base64,' + 'Q'.repeat(9) + ',x', control, 8)).rejects.toThrow('per-image')
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { control.dispose() }
  })

  it('rejects an overlong inline header without fetching', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const control = setup(fetchImpl)
    try {
      await expect(convertBoundedChatImageToBase64('data:' + 'x'.repeat(4097) + ',QQ==', control, 8)).rejects.toThrow('per-image')
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { control.dispose() }
  })

  it('reads chunks in order, returns exact base64 and accepts the exact encoded limit', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => imageResponse(bodyFrom(new Uint8Array([0, 1]), new Uint8Array([2, 3]))))
    const control = setup(fetchImpl)
    try {
      await expect(convertBoundedChatImageToBase64('https://fixture.invalid/image', control, 8)).resolves.toBe('AAECAw==')
      expect(fetchImpl).toHaveBeenCalledOnce()
    } finally { control.dispose() }
  })

  it('rejects before retaining a chunk that exceeds the input allowance and cancels the body', async () => {
    const cancelled = vi.fn()
    let n = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n++ === 0) controller.enqueue(new Uint8Array([1, 2, 3, 4]))
        else if (n === 2) controller.enqueue(new Uint8Array([5, 6, 7]))
      },
      cancel: cancelled
    })
    const control = setup(vi.fn<typeof fetch>(async () => imageResponse(body)))
    try {
      await expect(convertBoundedChatImageToBase64('https://fixture.invalid/image', control, 8)).rejects.toThrow()
      expect(cancelled).toHaveBeenCalledOnce()
    } finally { control.dispose() }
  })

  it.each([
    ['non-image content type', () => new Response(bodyFrom(new Uint8Array([1])), { headers: { 'content-type': 'text/plain' } })],
    ['missing content type', () => new Response(bodyFrom(new Uint8Array([1])))],
    ['empty image', () => imageResponse(bodyFrom())],
    ['non-success status', () => new Response(bodyFrom(new Uint8Array([1])), { status: 500 })]
  ])('rejects %s', async (_label, response) => {
    const control = setup(vi.fn<typeof fetch>(async () => response()))
    try { await expect(convertBoundedChatImageToBase64('https://fixture.invalid/image', control, 8)).rejects.toThrow() }
    finally { control.dispose() }
  })

  it('does not consume a non-success body and cancels it on disposal', async () => {
    const cancel = vi.fn()
    const pull = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    const control = setup(vi.fn<typeof fetch>(async () => new Response(body, { status: 503 })))
    try { await expect(convertBoundedChatImageToBase64('https://fixture.invalid/error', control, 8)).rejects.toThrow('Image download failed.') }
    finally { control.dispose() }
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('preserves the read failure and still cancels the stream', async () => {
    const readFailure = new Error('fixture stream broke')
    const reader = { read: vi.fn().mockRejectedValue(readFailure), cancel: vi.fn().mockResolvedValue(undefined), releaseLock: vi.fn() }
    const response = {
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      body: { getReader: () => reader }
    } as unknown as Response
    const control = setup(vi.fn<typeof fetch>(async () => response))
    try {
      await expect(convertBoundedChatImageToBase64('https://fixture.invalid/image', control, 8)).rejects.toBe(readFailure)
      expect(reader.cancel).toHaveBeenCalledOnce()
      expect(reader.releaseLock).toHaveBeenCalledOnce()
    } finally { control.dispose() }
  })

  it('rejects a pre-aborted request without fetching', async () => {
    const abort = new AbortController()
    const reason = new Error('already cancelled')
    abort.abort(reason)
    const fetchImpl = vi.fn<typeof fetch>()
    const control = setup(fetchImpl, abort.signal)
    try {
      await expect(convertBoundedChatImageToBase64('https://fixture.invalid/image', control, 8)).rejects.toBe(reason)
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { control.dispose() }
  })

  it('does not trust an incorrect Content-Length over the actual stream length', async () => {
    const response = new Response(bodyFrom(new Uint8Array([1, 2, 3, 4])), { headers: { 'content-type': 'image/png', 'content-length': '99999' } })
    const fetchImpl = vi.fn<typeof fetch>(async () => response)
    const control = setup(fetchImpl)
    try { await expect(convertBoundedChatImageToBase64('https://fixture.invalid/image', control, 8)).resolves.toBe('AQIDBA==') }
    finally { control.dispose() }
  })

  it('settles a pending read on abort with the original reason even when cancel does not settle', async () => {
    let startRead!: () => void
    const reading = new Promise<void>(resolve => { startRead = resolve })
    const cancelled = vi.fn(() => new Promise<void>(() => {}))
    const body = new ReadableStream<Uint8Array>({ pull() { startRead(); return new Promise<void>(() => {}) }, cancel: cancelled })
    const abort = new AbortController()
    const control = setup(vi.fn<typeof fetch>(async () => imageResponse(body)), abort.signal)
    const reason = new Error('user cancelled')
    try {
      const pending = convertBoundedChatImageToBase64('https://fixture.invalid/image', control, 8)
      await reading
      abort.abort(reason)
      await expect(pending).rejects.toBe(reason)
      expect(cancelled).toHaveBeenCalledOnce()
    } finally { control.dispose() }
  })
})
