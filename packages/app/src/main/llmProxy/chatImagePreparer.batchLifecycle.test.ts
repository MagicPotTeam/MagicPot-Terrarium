import { describe, expect, it, vi } from 'vitest'
import { ChatImagePreparer, type ChatImageEncoder } from './chatImagePreparer'

const png = (): Uint8Array =>
  Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
      'base64'
    )
  )

describe('unwired chat image preparer batch lifecycle', () => {
  it('observes a possible microtask clear after the first flight leaves the map', async () => {
    const encode = vi.fn(async () => png())
    const preparer = new ChatImagePreparer({ encode })
    const state = preparer as unknown as {
      flights: Map<string, unknown>
      cache: Map<string, unknown>
    }
    const batch = preparer.prepareBatch([png(), png()], 500_000)
    const observed = batch.catch((error: unknown) => error)
    let cleared = false
    const poll = (remaining: number): void => {
      if (state.cache.size && state.flights.size === 0) {
        cleared = true
        preparer.clear()
        return
      }
      if (remaining > 0) queueMicrotask(() => poll(remaining - 1))
    }
    queueMicrotask(() => poll(500))
    const result = await observed
    expect(cleared).toBe(true)
    expect(result).toMatchObject({ name: 'AbortError' })
    expect(encode).toHaveBeenCalledTimes(1)
  })

  it('clear after the last item settles but before the batch returns prevents a complete stale result', async () => {
    const encode = vi.fn(async () => png())
    const preparer = new ChatImagePreparer({ encode })
    const state = preparer as unknown as {
      flights: Map<string, unknown>
      cache: Map<string, unknown>
    }
    const batch = preparer.prepareBatch([png()], 500_000)
    const observed = batch.catch((error: unknown) => error)
    let cleared = false
    const poll = (remaining: number): void => {
      if (state.cache.size && state.flights.size === 0) {
        cleared = true
        preparer.clear()
        return
      }
      if (remaining > 0) queueMicrotask(() => poll(remaining - 1))
    }
    queueMicrotask(() => poll(500))
    const result = await observed
    expect(cleared).toBe(true)
    expect(result).toMatchObject({ name: 'AbortError' })
    expect(encode).toHaveBeenCalledOnce()
    expect(state.cache.size).toBe(0)
    await expect(preparer.prepare(png())).resolves.toMatchObject({ width: 1 })
    expect(encode).toHaveBeenCalledTimes(2)
  })

  it('clear after a batch item finishes but before its continuation stops the next image', async () => {
    let preparer!: ChatImagePreparer
    let release!: () => void
    const original = ChatImagePreparer.prototype.prepare
    let first = true
    const prepare = vi.spyOn(ChatImagePreparer.prototype, 'prepare').mockImplementation(function (
      this: ChatImagePreparer,
      source,
      options,
      signal
    ) {
      if (!first) return original.call(this, source, options, signal)
      first = false
      return original.call(this, source, options, signal).then(async (value) => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return value
      })
    })
    const encode = vi.fn(async () => png())
    try {
      preparer = new ChatImagePreparer({ encode })
      const batch = preparer.prepareBatch([png(), png()], 500_000)
      const observed = batch.catch((error: unknown) => error)
      await vi.waitFor(() => expect(release).toBeDefined())
      preparer.clear()
      release()
      expect(await observed).toMatchObject({ name: 'AbortError' })
      expect(encode).toHaveBeenCalledTimes(1)
    } finally {
      prepare.mockRestore()
    }
  })

  it('clear stops a running batch before it starts its second image, without caching a late result', async () => {
    let release!: () => void
    const encode = vi.fn(
      async (_bytes: Uint8Array, _options: Parameters<ChatImageEncoder['encode']>[1]) => {
        if (encode.mock.calls.length === 1)
          await new Promise<void>((resolve) => {
            release = resolve
          })
        return png()
      }
    )
    const preparer = new ChatImagePreparer({ encode })
    const pending = preparer.prepareBatch([png(), png()], 500_000)
    const observed = pending.catch((error: unknown) => error)
    await vi.waitFor(() => expect(release).toBeDefined())
    preparer.clear()
    release()
    expect(await observed).toMatchObject({ name: 'AbortError' })
    expect(encode).toHaveBeenCalledTimes(1)
    await expect(preparer.prepare(png())).resolves.toMatchObject({ width: 1, height: 1 })
    expect(encode).toHaveBeenCalledTimes(2)
  })
})
