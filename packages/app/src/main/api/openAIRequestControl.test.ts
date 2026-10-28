import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIRequestControl, OPENAI_MAX_DEADLINE_MS } from '../../shared/llm/openaiRequestControl'

const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('per-call OpenAI bounded request control', () => {
  it.each(['fetch', 'bodyless'] as const)(
    'settles an already-started pending %s when disposed',
    async (kind) => {
      vi.useFakeTimers()
      const started = gate()
      const never = () => {
        started.resolve()
        return new Promise<Response>(() => undefined)
      }
      const control = new OpenAIRequestControl(vi.fn<typeof fetch>().mockImplementation(never))
      const add = vi.spyOn(control.signal, 'addEventListener')
      const remove = vi.spyOn(control.signal, 'removeEventListener')
      const pending = (
        kind === 'fetch'
          ? control.fetch('https://owned.example')
          : control.json({ json: never } as unknown as Response)
      ).catch((error) => error)
      await started.promise
      control.dispose()
      expect(control.signal.aborted).toBe(true)
      expect(await pending).toMatchObject({ name: 'AbortError' })
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['owned-string', { code: 'owned-object' }, null, false, 0])(
    'preserves non-Error caller reason %j exactly',
    async (reason) => {
      const parent = new AbortController()
      const control = new OpenAIRequestControl(vi.fn<typeof fetch>(), parent.signal)
      const pending = control.wait(new Promise<void>(() => undefined)).catch((error) => error)
      try {
        parent.abort(reason)
        expect(control.signal.reason).toBe(reason)
        expect(await pending).toBe(reason)
      } finally {
        control.dispose()
      }
    }
  )

  it('times out an ignored-abort transport and disposes its late body', async () => {
    vi.useFakeTimers()
    const started = gate()
    let resolve!: (response: Response) => void
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      started.resolve()
      return new Promise<Response>((done) => {
        resolve = done
      })
    })
    const control = new OpenAIRequestControl(fetchImpl, undefined, 1_000)
    const pending = control.fetch('https://owned.example').catch((error) => error)
    try {
      await started.promise
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await pending).toMatchObject({ name: 'TimeoutError' })
      const cancel = vi.fn(() => new Promise<void>(() => undefined))
      resolve(new Response(new ReadableStream({ cancel })))
      await vi.advanceTimersByTimeAsync(0)
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      control.dispose()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the exact caller reason while cancelling a hanging body without waiting for cancel', async () => {
    vi.useFakeTimers()
    const started = gate()
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            started.resolve()
          },
          cancel
        },
        { highWaterMark: 0 }
      )
    )
    const parent = new AbortController()
    const add = vi.spyOn(parent.signal, 'addEventListener')
    const remove = vi.spyOn(parent.signal, 'removeEventListener')
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>(), parent.signal)
    const failure = new Error('owned-caller-cancel')
    const pending = control.json(response).catch((error) => error)
    try {
      await started.promise
      parent.abort(failure)
      expect(await pending).toBe(failure)
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      control.dispose()
    }
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects stream JSON overflow and cancels a never-settling cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(17))
        },
        cancel
      })
    )
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
    try {
      await expect(control.json(response, 16)).rejects.toThrow('16-byte')
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      control.dispose()
    }
  })

  it('retains a bounded error prefix and promptly cancels the rest', async () => {
    const cancel = vi.fn(async () => undefined)
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('owned-long-error'))
        },
        cancel
      })
    )
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
    try {
      await expect(control.text(response, 5, true)).resolves.toBe('owned')
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      control.dispose()
    }
  })

  it('bounds injected bodyless JSON time and allocation result', async () => {
    vi.useFakeTimers()
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>(), undefined, 1_000)
    try {
      await expect(
        control.json({ json: async () => ({ text: 'oversized' }) } as Response, 3)
      ).rejects.toThrow('3-byte')
      const pending = control
        .json({ json: () => new Promise(() => undefined) } as Response)
        .catch((error) => error)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await pending).toMatchObject({ name: 'TimeoutError' })
    } finally {
      control.dispose()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks monotonic elapsed time even when resolved promises starve the timer', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>(), undefined, 1_000)
    clock.mockReturnValue(1_001)
    try {
      expect(() => control.check()).toThrow('deadline exceeded')
    } finally {
      control.dispose()
    }
  })

  it('clamps arbitrarily long requested deadlines and isolates overlapping calls', async () => {
    vi.useFakeTimers()
    const firstParent = new AbortController()
    const first = new OpenAIRequestControl(vi.fn<typeof fetch>(), firstParent.signal)
    const second = new OpenAIRequestControl(
      vi.fn<typeof fetch>(),
      undefined,
      Number.MAX_SAFE_INTEGER
    )
    try {
      firstParent.abort()
      expect(first.signal.aborted).toBe(true)
      expect(second.signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(OPENAI_MAX_DEADLINE_MS)
      expect(second.signal.reason).toMatchObject({ name: 'TimeoutError' })
    } finally {
      first.dispose()
      second.dispose()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, -1, Infinity, NaN])('rejects invalid deadline %s before provider I/O', (deadline) => {
    const fetchImpl = vi.fn<typeof fetch>()
    expect(() => new OpenAIRequestControl(fetchImpl, undefined, deadline)).toThrow(
      'positive finite'
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
