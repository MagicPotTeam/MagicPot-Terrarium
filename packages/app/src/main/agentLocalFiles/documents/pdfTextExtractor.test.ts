import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractPdfText, type PdfTextRuntime } from './pdfTextExtractor'
import { checkDocumentTextResult, DOCUMENT_TEXT_LIMITS } from './documentSchema'
import { pdfFixtures } from './__fixtures__/pdfFixtures'

const JOB_ID = '0123456789abcdef0123456789abcdef'
const BYTES = pdfFixtures().compressedEscaped
type Task = ReturnType<PdfTextRuntime['getDocument']>
type Document = Awaited<Task['promise']>
type Page = Awaited<ReturnType<Document['getPage']>>
type Reader = ReturnType<ReturnType<Page['streamTextContent']>['getReader']>
type Item = { str: string } | { type: string }
const never = <T>(): Promise<T> => new Promise(() => {})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

// Lifecycle/contract adapters only. They deliberately do not parse the owned PDFs.
function adapter(pages: Item[][][] = [[[{ str: 'text' }]]]) {
  const readers = pages.map((chunks) => {
    let index = 0
    return {
      read: vi.fn(async (): Promise<Awaited<ReturnType<Reader['read']>>> =>
        index < chunks.length ? { done: false, value: { items: chunks[index++] } } : { done: true }
      ),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn()
    }
  })
  const pageObjects = readers.map((reader) => ({
    streamTextContent: vi.fn(() => ({ getReader: () => reader }))
  }))
  const document = {
    numPages: pages.length,
    isPureXfa: false,
    getPermissions: vi.fn(async (): Promise<ReadonlySet<number> | null> => null),
    getMetadata: vi.fn(async (): Promise<{ info: unknown }> => ({
      info: { EncryptFilterName: null }
    })),
    getPage: vi.fn(async (page: number) => pageObjects[page - 1])
  }
  const task: Task & { destroy: ReturnType<typeof vi.fn<() => Promise<void>>> } = {
    promise: Promise.resolve(document),
    onPassword: null,
    destroy: vi.fn(async () => {})
  }
  const getDocument = vi.fn((_parameters: Parameters<PdfTextRuntime['getDocument']>[0]) => task)
  return { runtime: { version: '6.3.289', getDocument }, task, document, readers, pageObjects }
}

function expectBounded(result: Awaited<ReturnType<typeof extractPdfText>>): void {
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
    DOCUMENT_TEXT_LIMITS.envelopeBytes
  )
  if ('jobId' in result) expect(checkDocumentTextResult(result, JOB_ID, 'pdf').ok).toBe(true)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PDF adversarial regression: no regex fallback', () => {
  it.each(['compressedEscaped', 'hexAndTJ', 'multiPage', 'noText', 'invalid'] as const)(
    'never claims parsing without a runtime: %s',
    async (name) => {
      expect(await extractPdfText(pdfFixtures()[name], JOB_ID)).toMatchObject({
        ok: false,
        code: 'EXECUTION_FAILED'
      })
    }
  )

  it('does not echo or coerce an unsafe job id', async () => {
    const hook = vi.fn(() => {
      throw new Error('must not run')
    })
    const id = new Proxy({}, { get: hook })
    expect(await extractPdfText(BYTES, id)).toEqual({ ok: false, code: 'INVALID' })
    expect(hook).not.toHaveBeenCalled()
  })

  it('rejects options accessors without invoking them', async () => {
    const getter = vi.fn(() => {
      throw new Error('attacker')
    })
    const options = Object.defineProperty({}, 'signal', { enumerable: true, get: getter })
    expect(await extractPdfText(BYTES, JOB_ID, options)).toMatchObject({
      ok: false,
      code: 'INVALID'
    })
    expect(getter).not.toHaveBeenCalled()
  })

  it.each(['missing', 'throwing'] as const)(
    'imports without probing a %s AbortSignal.any',
    async (kind) => {
      const original = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!
      const hook = vi.fn(() => {
        throw new Error('AbortSignal.any unavailable')
      })
      vi.resetModules()
      Object.defineProperty(AbortSignal, 'any', {
        ...original,
        value: kind === 'missing' ? undefined : hook
      })
      try {
        const fresh = await import('./pdfTextExtractor')
        expect((await fresh.extractPdfText(BYTES, JOB_ID, {}, adapter().runtime)).ok).toBe(true)
        expect(hook).not.toHaveBeenCalled()
      } finally {
        Object.defineProperty(AbortSignal, 'any', original)
        vi.resetModules()
      }
    }
  )
})

describe('PDF ingress boundaries (not parser integration)', () => {
  it('rejects input/options proxies before traps and forged signals before hooks', async () => {
    const hook = vi.fn(() => {
      throw new Error('attacker')
    })
    const proxy = new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook })
    const mock = adapter()
    expect(await extractPdfText(proxy, JOB_ID, {}, mock.runtime)).toEqual({
      ok: false,
      code: 'INVALID'
    })
    expect(await extractPdfText(BYTES, JOB_ID, proxy, mock.runtime)).toMatchObject({
      code: 'INVALID'
    })
    expect(
      await extractPdfText(BYTES, JOB_ID, { signal: proxy as AbortSignal }, mock.runtime)
    ).toMatchObject({ code: 'INVALID' })
    const fake = Object.create(AbortSignal.prototype)
    expect(await extractPdfText(BYTES, JOB_ID, { signal: fake }, mock.runtime)).toMatchObject({
      code: 'INVALID'
    })
    expect(hook).not.toHaveBeenCalled()
    expect(mock.runtime.getDocument).not.toHaveBeenCalled()
  })

  it.each([
    { runtime: {} },
    { url: 'file:///fixture-data.pdf' },
    { password: 'secret' },
    { deadlineAt: NaN },
    { deadlineAt: Infinity },
    { deadlineAt: '1' },
    { signal: {} },
    { signal: null },
    Object.create({ deadlineAt: 0 }),
    Object.defineProperty({}, 'deadlineAt', { value: 0 }),
    { [Symbol('option')]: true }
  ])('rejects unknown or invalid option descriptors %#', async (options) => {
    const mock = adapter()
    expect(await extractPdfText(BYTES, JOB_ID, options as never, mock.runtime)).toMatchObject({
      code: 'INVALID'
    })
    expect(mock.runtime.getDocument).not.toHaveBeenCalled()
  })

  it('snapshots options and bytes, bypassing typed-array getters/iterator', async () => {
    const input = new Uint8Array(BYTES)
    const hook = vi.fn(() => {
      throw new Error('attacker')
    })
    for (const key of ['byteLength', 'byteOffset', 'buffer', Symbol.iterator])
      Object.defineProperty(input, key, { get: hook })
    const mock = adapter()
    const options = { deadlineAt: Date.now() + 1000 }
    const pending = extractPdfText(input, JOB_ID, options, mock.runtime)
    options.deadlineAt = 0
    Uint8Array.prototype.fill.call(input, 0)
    const result = await pending
    expect(result.ok).toBe(true)
    const snapshot = mock.runtime.getDocument.mock.calls[0][0].data
    expect(snapshot === input).toBe(false)
    expect(snapshot).toEqual(BYTES)
    expect(hook).not.toHaveBeenCalled()
    expectBounded(result)
  })

  it('validates signature, input cap, shared/detached buffers before runtime', async () => {
    const mock = adapter()
    const oversized = new Uint8Array(DOCUMENT_TEXT_LIMITS.inputBytes + 1)
    oversized.set(BYTES.subarray(0, 5))
    expect(await extractPdfText(oversized, JOB_ID, {}, mock.runtime)).toEqual({
      ok: false,
      code: 'LIMIT'
    })
    const shared = new Uint8Array(new SharedArrayBuffer(10))
    shared.set(BYTES.subarray(0, 5))
    const detached = new Uint8Array(BYTES)
    structuredClone(detached, { transfer: [detached.buffer] })
    for (const input of [
      new Uint8Array(),
      shared,
      detached,
      Buffer.from('not a PDF'),
      'file:///doc.pdf'
    ])
      expect(await extractPdfText(input, JOB_ID, {}, mock.runtime)).toEqual({
        ok: false,
        code: 'INVALID'
      })
    expect(mock.runtime.getDocument).not.toHaveBeenCalled()
  })

  it('requires the exact trusted runtime version', async () => {
    const mock = adapter()
    const result = await extractPdfText(BYTES, JOB_ID, {}, { ...mock.runtime, version: '6.3.290' })
    expect(result).toMatchObject({ code: 'EXECUTION_FAILED' })
    expect(mock.runtime.getDocument).not.toHaveBeenCalled()
  })

  it('passes only supported, restrictive bytes-only flags and factories', async () => {
    const mock = adapter()
    await extractPdfText(BYTES, JOB_ID, {}, mock.runtime)
    expect(mock.runtime.getDocument.mock.calls[0][0]).toEqual({
      data: expect.any(Uint8Array),
      enableXfa: false,
      useWorkerFetch: false,
      useWasm: false,
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: true,
      verbosity: 0,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      maxImageSize: 0,
      enableHWA: false,
      enableWebGPU: false,
      BinaryDataFactory: expect.any(Function),
      CanvasFactory: expect.any(Function),
      FilterFactory: expect.any(Function)
    })
  })

  it('rejects signal own getters and symbol hooks without invoking them', async () => {
    for (const key of [
      'aborted',
      'addEventListener',
      'removeEventListener',
      ...Object.getOwnPropertySymbols(AbortSignal.prototype),
      ...Object.getOwnPropertySymbols(EventTarget.prototype),
      ...Reflect.ownKeys(new AbortController().signal)
    ]) {
      const signal = new AbortController().signal
      const hook = vi.fn(() => {
        throw new Error('attacker')
      })
      Object.defineProperty(signal, key, { configurable: true, get: hook })
      const result = await extractPdfText(BYTES, JOB_ID, { signal }, adapter().runtime)
      expect(result).toMatchObject({ code: 'INVALID' })
      expect(hook).not.toHaveBeenCalled()
    }
  })

  it('rejects own string data, symbol method shadows and non-reason functions', async () => {
    const hook = vi.fn(() => {
      throw new Error('attacker')
    })
    for (const key of [
      'aborted',
      'addEventListener',
      'removeEventListener',
      ...Object.getOwnPropertySymbols(AbortSignal.prototype),
      ...Object.getOwnPropertySymbols(EventTarget.prototype),
      Symbol('extra')
    ]) {
      const signal = new AbortController().signal
      Object.defineProperty(signal, key, { value: typeof key === 'string' ? false : hook })
      const mock = adapter()
      expect(await extractPdfText(BYTES, JOB_ID, { signal }, mock.runtime)).toMatchObject({
        code: 'INVALID'
      })
      expect(mock.runtime.getDocument).not.toHaveBeenCalled()
    }
    expect(hook).not.toHaveBeenCalled()
  })

  it('bounds signal descriptor checks to at most 32 own fields', async () => {
    const signal = new AbortController().signal
    for (let index = 0; index < 33; index++)
      Object.defineProperty(signal, Symbol('extra'), { value: true })
    const mock = adapter()
    expect(await extractPdfText(BYTES, JOB_ID, { signal }, mock.runtime)).toMatchObject({
      code: 'INVALID'
    })
    expect(mock.runtime.getDocument).not.toHaveBeenCalled()
  })

  it('leaves arbitrary opaque abort reasons untouched, including functions and proxies', async () => {
    const hook = vi.fn(() => {
      throw new Error('opaque reason hook')
    })
    for (const reason of [
      hook,
      new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook }),
      Object.defineProperty({}, 'secret', { get: hook })
    ]) {
      const controller = new AbortController()
      controller.abort(reason)
      expect(
        await extractPdfText(BYTES, JOB_ID, { signal: controller.signal }, adapter().runtime)
      ).toMatchObject({ code: 'CANCELLED' })
    }
    expect(hook).not.toHaveBeenCalled()
  })
})

describe('PDF streaming budgets and output contract (mock lifecycle only)', () => {
  it('uses stream order, real page numbers and per-page indexes including empty items', async () => {
    const mock = adapter([
      [
        [{ str: '' }, { str: 'first' }],
        [{ type: 'endMarkedContent' }, { str: 'second' }]
      ],
      [[{ str: 'third' }]]
    ])
    const result = await extractPdfText(BYTES, JOB_ID, {}, mock.runtime)
    expect(result).toMatchObject({
      ok: true,
      truncated: false,
      warnings: ['reading-order-unverified'],
      segments: [
        { text: 'first', locator: { kind: 'pdf-item', page: 1, item: 1 } },
        { text: 'second', locator: { kind: 'pdf-item', page: 1, item: 3 } },
        { text: 'third', locator: { kind: 'pdf-item', page: 2, item: 0 } }
      ]
    })
    expect(mock.document.getPage.mock.calls).toEqual([[1], [2]])
    for (const page of mock.pageObjects)
      expect(page.streamTextContent).toHaveBeenCalledWith({
        includeMarkedContent: false,
        disableNormalization: false
      })
    for (const reader of mock.readers) {
      expect(reader.cancel).not.toHaveBeenCalled()
      expect(reader.releaseLock).toHaveBeenCalledTimes(1)
    }
    expect(mock.task.destroy).toHaveBeenCalledTimes(1)
    expectBounded(result)
  })

  it('returns NO_TEXT after complete empty streams', async () => {
    const mock = adapter([[[]], [[{ str: '' }]]])
    expect(await extractPdfText(BYTES, JOB_ID, {}, mock.runtime)).toMatchObject({ code: 'NO_TEXT' })
    expect(mock.task.destroy).toHaveBeenCalledTimes(1)
  })

  it('accepts exactly 200 pages but refuses 201 before any page access', async () => {
    const mock = adapter(Array.from({ length: 200 }, () => [[{ str: '' }]]))
    expect(await extractPdfText(BYTES, JOB_ID, {}, mock.runtime)).toMatchObject({ code: 'NO_TEXT' })
    expect(mock.document.getPage).toHaveBeenCalledTimes(200)
    const excess = adapter()
    excess.document.numPages = 201
    expect(await extractPdfText(BYTES, JOB_ID, {}, excess.runtime)).toMatchObject({ code: 'LIMIT' })
    expect(excess.document.getPage).not.toHaveBeenCalled()
    expect(excess.task.destroy).toHaveBeenCalledTimes(1)
  })

  it('counts all streamed items across pages and rejects work-limit partial output', async () => {
    const chunk = Array.from({ length: 50_000 }, () => ({ str: '' }))
    const mock = adapter([[chunk], [chunk], [[{ str: 'late text' }]]])
    expect(await extractPdfText(BYTES, JOB_ID, {}, mock.runtime)).toMatchObject({ code: 'LIMIT' })
    expect(mock.readers[2].cancel).toHaveBeenCalledTimes(1)
    expect(mock.task.destroy).toHaveBeenCalledTimes(1)
    const exact = adapter([[chunk], [[...chunk.slice(1), { str: 'last item' }]]])
    const result = await extractPdfText(BYTES, JOB_ID, {}, exact.runtime)
    expect(result.ok).toBe(true)
    expectBounded(result)
  })

  it.each([512, 513])('makes segment truncation explicit for %i items', async (count) => {
    const mock = adapter([[Array.from({ length: count }, () => ({ str: 'x' }))]])
    const result = await extractPdfText(BYTES, JOB_ID, {}, mock.runtime)
    expect(result).toMatchObject({ ok: true, truncated: count > 512 })
    if (result.ok) expect(result.segments).toHaveLength(512)
    expect(mock.readers[0].cancel).toHaveBeenCalledTimes(count > 512 ? 1 : 0)
    expect(mock.readers[0].releaseLock).toHaveBeenCalledTimes(1)
    expectBounded(result)
  })

  it.each(['\u0000', '"\\\n', '😀'])('budgets escaped JSON plus all locators: %j', async (text) => {
    const mock = adapter([[Array.from({ length: 512 }, () => ({ str: text.repeat(100) }))]])
    const result = await extractPdfText(BYTES, JOB_ID, {}, mock.runtime)
    expect(result).toMatchObject({
      ok: true,
      truncated: true,
      warnings: ['reading-order-unverified', 'output-truncated']
    })
    expect(mock.readers[0].cancel).toHaveBeenCalledTimes(1)
    expect(mock.readers[0].releaseLock).toHaveBeenCalledTimes(1)
    expectBounded(result)
  })

  it('returns LIMIT when even one segment cannot fit; invalid Unicode is not emitted', async () => {
    const huge = adapter([[[{ str: '\0'.repeat(65536) }]]])
    expect(await extractPdfText(BYTES, JOB_ID, {}, huge.runtime)).toMatchObject({ code: 'LIMIT' })
    const malformed = adapter([[[{ str: '\ud800' }]]])
    expect(await extractPdfText(BYTES, JOB_ID, {}, malformed.runtime)).toMatchObject({
      code: 'INVALID'
    })
    expect(huge.task.destroy).toHaveBeenCalledTimes(1)
    expect(malformed.task.destroy).toHaveBeenCalledTimes(1)
  })

  it.each(['BinaryDataFactory', 'CanvasFactory', 'FilterFactory'])(
    'latches swallowed %s resource failures',
    async (factoryName) => {
      const mock = adapter()
      const original = mock.runtime.getDocument.getMockImplementation()!
      mock.runtime.getDocument.mockImplementation((parameters) => {
        const Factory = parameters[factoryName] as new () => {
          fetch(): never
          create(): never
          addFilter(): never
        }
        const factory = new Factory()
        try {
          if (factoryName === 'BinaryDataFactory') factory.fetch()
          else if (factoryName === 'CanvasFactory') factory.create()
          else factory.addFilter()
        } catch {
          /* Simulate pdf.js swallowing a resource failure. */
        }
        return original(parameters)
      })
      expect(await extractPdfText(BYTES, JOB_ID, {}, mock.runtime)).toMatchObject({
        code: 'UNSUPPORTED'
      })
      expect(mock.task.destroy).toHaveBeenCalledTimes(1)
    }
  )
})

describe('PDF lifecycle, deadline and cancellation', () => {
  it('fails before loading on pre-abort and expired deadlines', async () => {
    const mock = adapter()
    const controller = new AbortController()
    controller.abort({ secret: 'must not echo' })
    expect(
      await extractPdfText(BYTES, JOB_ID, { signal: controller.signal }, mock.runtime)
    ).toMatchObject({ code: 'CANCELLED' })
    expect(
      await extractPdfText(BYTES, JOB_ID, { deadlineAt: Date.now() - 1 }, mock.runtime)
    ).toMatchObject({ code: 'TIMEOUT' })
    expect(mock.runtime.getDocument).not.toHaveBeenCalled()
  })

  it('adds no abort listeners and still cancels without disturbing existing listeners', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const existing = vi.fn()
    controller.signal.addEventListener('abort', existing)
    const mock = adapter()
    Object.defineProperty(mock.task, 'promise', { value: never<Document>() })
    const pending = extractPdfText(BYTES, JOB_ID, { signal: controller.signal }, mock.runtime)
    const listenersWhilePending = getEventListeners(controller.signal, 'abort')
    controller.abort()
    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toMatchObject({ code: 'CANCELLED' })
    expect(listenersWhilePending).toEqual([existing])
    expect(getEventListeners(controller.signal, 'abort')).toEqual([existing])
    expect(existing).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the signal poll and deadline timer after success', async () => {
    vi.useFakeTimers()
    const signal = new AbortController().signal
    expect((await extractPdfText(BYTES, JOB_ID, { signal }, adapter().runtime)).ok).toBe(true)
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['symbol hook', 'own getter'] as const)(
    'rejects a %s mutation during pending load within one poll without calling hooks',
    async (kind) => {
      vi.useFakeTimers()
      const signal = new AbortController().signal
      const hook = vi.fn(() => {
        throw new Error('mutated hook')
      })
      const key =
        kind === 'symbol hook'
          ? Object.getOwnPropertySymbols(EventTarget.prototype).find(
              (symbol) =>
                typeof Object.getOwnPropertyDescriptor(EventTarget.prototype, symbol)?.value ===
                'function'
            )!
          : Reflect.ownKeys(signal)[0]
      const original = Object.getOwnPropertyDescriptor(signal, key)
      const mock = adapter()
      Object.defineProperty(mock.task, 'promise', { value: never<Document>() })
      let result: Awaited<ReturnType<typeof extractPdfText>> | undefined
      const pending = extractPdfText(BYTES, JOB_ID, { signal }, mock.runtime).then((value) => {
        result = value
        return value
      })
      Object.defineProperty(signal, key, {
        configurable: true,
        ...(kind === 'symbol hook' ? { value: hook } : { get: hook })
      })
      try {
        await vi.advanceTimersByTimeAsync(10)
        expect(result).toMatchObject({ code: 'INVALID' })
        expect(hook).not.toHaveBeenCalled()
        expect(mock.task.destroy).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        if (original) Object.defineProperty(signal, key, original)
        else Reflect.deleteProperty(signal, key)
        // Also drain the old implementation on RED without leaking its pending deadline.
        await vi.advanceTimersByTimeAsync(5001)
        await pending
      }
      expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    }
  )

  it('leaves no listeners after a mutated signal is rejected at an await boundary', async () => {
    vi.useFakeTimers()
    const signal = new AbortController().signal
    const hook = vi.fn(() => {
      throw new Error('mutated getter')
    })
    const mock = adapter()
    const loading = deferred<Document>()
    Object.defineProperty(mock.task, 'promise', { value: loading.promise })
    const pending = extractPdfText(BYTES, JOB_ID, { signal }, mock.runtime)
    Object.defineProperty(signal, 'aborted', { configurable: true, get: hook })
    loading.resolve(mock.document)
    expect(await pending).toMatchObject({ code: 'INVALID' })
    expect(hook).not.toHaveBeenCalled()
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stopImmediatePropagation cannot block cooperative cancellation', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const existing = vi.fn((event: Event) => event.stopImmediatePropagation())
    controller.signal.addEventListener('abort', existing)
    const mock = adapter()
    Object.defineProperty(mock.task, 'promise', { value: never<Document>() })
    let result: Awaited<ReturnType<typeof extractPdfText>> | undefined
    const pending = extractPdfText(BYTES, JOB_ID, { signal: controller.signal }, mock.runtime).then(
      (value) => {
        result = value
        return value
      }
    )
    controller.abort()
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(result).toMatchObject({ code: 'CANCELLED' })
      expect(existing).toHaveBeenCalledTimes(1)
      expect(getEventListeners(controller.signal, 'abort')).toEqual([existing])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await vi.advanceTimersByTimeAsync(5001)
      await pending
    }
  })

  it('accepts native timeout and composite AbortSignals', async () => {
    for (const signal of [
      AbortSignal.timeout(1000),
      AbortSignal.any([new AbortController().signal])
    ]) {
      expect((await extractPdfText(BYTES, JOB_ID, { signal }, adapter().runtime)).ok).toBe(true)
      expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    }
  })

  it.each(['timeout', 'composite'] as const)('cancels with a native %s signal', async (kind) => {
    const controller = new AbortController()
    const signal =
      kind === 'timeout' ? AbortSignal.timeout(10) : AbortSignal.any([controller.signal])
    const mock = adapter()
    Object.defineProperty(mock.task, 'promise', { value: never<Document>() })
    const pending = extractPdfText(BYTES, JOB_ID, { signal }, mock.runtime)
    if (kind === 'composite') controller.abort()
    expect(await pending).toMatchObject({ code: 'CANCELLED' })
    expect(mock.task.destroy).toHaveBeenCalledTimes(1)
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  it.each(['load', 'permissions', 'metadata', 'page', 'read', 'cancel', 'destroy'] as const)(
    'bounds an unending %s operation by the default 5s ceiling',
    async (phase) => {
      vi.useFakeTimers()
      const mock = adapter(
        phase === 'cancel' ? [[Array.from({ length: 513 }, () => ({ str: 'x' }))]] : undefined
      )
      if (phase === 'load')
        Object.defineProperty(mock.task, 'promise', { value: never<Document>() })
      if (phase === 'permissions') mock.document.getPermissions.mockReturnValue(never())
      if (phase === 'metadata') mock.document.getMetadata.mockReturnValue(never())
      if (phase === 'page') mock.document.getPage.mockReturnValue(never())
      if (phase === 'read') mock.readers[0].read.mockReturnValue(never())
      if (phase === 'cancel') mock.readers[0].cancel.mockReturnValue(never())
      if (phase === 'destroy') mock.task.destroy.mockReturnValue(never())
      const pending = extractPdfText(
        BYTES,
        JOB_ID,
        { deadlineAt: Date.now() + 60000 },
        mock.runtime
      )
      await vi.advanceTimersByTimeAsync(5001)
      expect(await pending).toMatchObject({ code: 'TIMEOUT' })
      expect(mock.task.destroy).toHaveBeenCalledTimes(1)
      if (phase === 'read' || phase === 'cancel') {
        expect(mock.readers[0].cancel).toHaveBeenCalledTimes(1)
        expect(mock.readers[0].releaseLock).toHaveBeenCalledTimes(1)
      }
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('honors a caller-shortened deadline', async () => {
    vi.useFakeTimers()
    const mock = adapter()
    Object.defineProperty(mock.task, 'promise', { value: never<Document>() })
    const pending = extractPdfText(BYTES, JOB_ID, { deadlineAt: Date.now() + 15 }, mock.runtime)
    await vi.advanceTimersByTimeAsync(16)
    expect(await pending).toMatchObject({ code: 'TIMEOUT' })
    expect(mock.task.destroy).toHaveBeenCalledTimes(1)
  })

  it.each(['load', 'read', 'destroy'] as const)(
    'cancels a pending %s and observes all late rejections',
    async (phase) => {
      const mock = adapter()
      const controller = new AbortController()
      const entered = deferred<void>()
      const late = deferred<never>()
      if (phase === 'load') Object.defineProperty(mock.task, 'promise', { value: late.promise })
      if (phase === 'read')
        mock.readers[0].read.mockImplementation(() => {
          entered.resolve()
          return late.promise
        })
      if (phase === 'destroy')
        mock.task.destroy.mockImplementation(() => {
          entered.resolve()
          return late.promise
        })
      const pending = extractPdfText(BYTES, JOB_ID, { signal: controller.signal }, mock.runtime)
      if (phase !== 'load') await entered.promise
      controller.abort(new Error('secret reason'))
      expect(await pending).toMatchObject({ code: 'CANCELLED' })
      late.reject(new Error('late private error'))
      await Promise.resolve()
      expect(mock.task.destroy).toHaveBeenCalledTimes(1)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      if (phase === 'read') {
        expect(mock.readers[0].cancel).toHaveBeenCalledTimes(1)
        expect(mock.readers[0].releaseLock).toHaveBeenCalledTimes(1)
      }
    }
  )

  it.each(['InvalidPDFException', 'PasswordException', 'Error'])(
    'maps %s without exposing diagnostic properties',
    async (name) => {
      const mock = adapter()
      const getter = vi.fn(() => {
        throw new Error('diagnostic hook')
      })
      const error = Object.defineProperties(
        { name },
        { message: { get: getter }, stack: { get: getter } }
      )
      Object.defineProperty(mock.task, 'promise', { value: Promise.reject(error) })
      const result = await extractPdfText(BYTES, JOB_ID, {}, mock.runtime)
      expect(result).toMatchObject({
        code:
          name === 'InvalidPDFException'
            ? 'INVALID'
            : name === 'PasswordException'
              ? 'UNSUPPORTED'
              : 'EXECUTION_FAILED'
      })
      expect(mock.task.destroy).toHaveBeenCalledTimes(1)
      expect(getter).not.toHaveBeenCalled()
      expectBounded(result)
    }
  )

  it('rejects password callbacks, encryption (even empty passwords) and pure XFA', async () => {
    const password = adapter()
    Object.defineProperty(password.task, 'promise', { value: never<Document>() })
    const pending = extractPdfText(BYTES, JOB_ID, {}, password.runtime)
    const updatePassword = vi.fn()
    password.task.onPassword!(updatePassword, 1)
    expect(await pending).toMatchObject({ code: 'UNSUPPORTED' })
    expect(updatePassword).not.toHaveBeenCalled()
    expect(password.task.destroy).toHaveBeenCalledTimes(1)
    const encrypted = adapter()
    encrypted.document.getPermissions.mockResolvedValue(new Set())
    expect(await extractPdfText(BYTES, JOB_ID, {}, encrypted.runtime)).toMatchObject({
      code: 'UNSUPPORTED'
    })
    const missingPermissions = adapter()
    missingPermissions.document.getMetadata.mockResolvedValue({
      info: { EncryptFilterName: 'Standard' }
    })
    expect(await extractPdfText(BYTES, JOB_ID, {}, missingPermissions.runtime)).toMatchObject({
      code: 'UNSUPPORTED'
    })
    expect(missingPermissions.document.getPage).not.toHaveBeenCalled()
    const xfa = adapter()
    xfa.document.isPureXfa = true
    expect(await extractPdfText(BYTES, JOB_ID, {}, xfa.runtime)).toMatchObject({
      code: 'UNSUPPORTED'
    })
  })

  it.each(['read', 'cancel', 'release', 'destroy'] as const)(
    'does not turn a %s failure into partial success and destroys exactly once',
    async (phase) => {
      const mock = adapter(
        phase === 'cancel' ? [[Array.from({ length: 513 }, () => ({ str: 'x' }))]] : undefined
      )
      const error = new Error('private path/password/stack')
      if (phase === 'read') mock.readers[0].read.mockRejectedValueOnce(error)
      if (phase === 'cancel') mock.readers[0].cancel.mockRejectedValueOnce(error)
      if (phase === 'release')
        mock.readers[0].releaseLock.mockImplementationOnce(() => {
          throw error
        })
      if (phase === 'destroy') mock.task.destroy.mockRejectedValueOnce(error)
      const result = await extractPdfText(BYTES, JOB_ID, {}, mock.runtime)
      expect(result).toMatchObject({ code: 'EXECUTION_FAILED' })
      expect(JSON.stringify(result)).not.toContain('private')
      expect(mock.task.destroy).toHaveBeenCalledTimes(1)
      expect(mock.readers[0].releaseLock).toHaveBeenCalledTimes(phase === 'release' ? 2 : 1)
      expect(mock.readers[0].cancel).toHaveBeenCalledTimes(phase === 'destroy' ? 0 : 1)
    }
  )

  it.each(['repeated', 'cancel', 'release', 'destroy'] as const)(
    'classifies an errored text stream without masking a separate %s teardown failure',
    async (phase) => {
      const mock = adapter()
      const cancel = vi.fn<() => Promise<void>>()
      const release = vi.fn<() => void>()
      const underlyingCancel = vi.fn()
      let stream!: ReadableStream<{ items: Item[] }>
      if (phase === 'destroy')
        mock.task.destroy.mockRejectedValue(new Error('private destroy failure'))
      const runtime: PdfTextRuntime = {
        version: '6.3.289',
        getDocument(parameters) {
          const Factory = parameters.BinaryDataFactory as new () => { fetch(): never }
          stream = new ReadableStream<{ items: Item[] }>(
            {
              pull(controller) {
                try {
                  new Factory().fetch()
                } catch (error) {
                  controller.error(error)
                }
              },
              cancel: underlyingCancel
            },
            { highWaterMark: 0 }
          )
          const reader = stream.getReader()
          cancel.mockImplementation(async () => {
            if (phase === 'cancel') throw new Error('private independent cancel failure')
            await reader.cancel()
          })
          release.mockImplementation(() => {
            reader.releaseLock()
            if (phase === 'release') throw new Error('private release failure')
          })
          Object.defineProperty(mock.task, 'promise', {
            value: Promise.resolve({
              ...mock.document,
              getPage: async () => ({
                streamTextContent: () => ({
                  getReader: () => ({
                    read: reader.read.bind(reader),
                    cancel,
                    releaseLock: release
                  })
                })
              })
            })
          })
          return mock.task
        }
      }
      const result = await extractPdfText(BYTES, JOB_ID, {}, runtime)
      expect(result).toMatchObject({
        code: phase === 'repeated' ? 'UNSUPPORTED' : 'EXECUTION_FAILED'
      })
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(release).toHaveBeenCalledTimes(1)
      expect(underlyingCancel).not.toHaveBeenCalled()
      expect(stream.locked).toBe(false)
      expect(mock.task.destroy).toHaveBeenCalledTimes(1)
      expect(mock.task.onPassword).toBe(null)
      expect(JSON.stringify(result)).not.toContain('private')
      expectBounded(result)
    }
  )

  it('waits for all cleanup despite an early cancellation failure', async () => {
    const mock = adapter([[Array.from({ length: 513 }, () => ({ str: 'x' }))]])
    mock.readers[0].cancel.mockRejectedValue(new Error('cancel failed'))
    const destroyed = deferred<void>()
    const entered = deferred<void>()
    mock.task.destroy.mockImplementation(() => {
      entered.resolve()
      return destroyed.promise
    })
    let returned = false
    const pending = extractPdfText(BYTES, JOB_ID, {}, mock.runtime).then((value) => {
      returned = true
      return value
    })
    await entered.promise
    await Promise.resolve()
    expect(returned).toBe(false)
    destroyed.resolve()
    expect(await pending).toMatchObject({ code: 'EXECUTION_FAILED' })
    expect(mock.task.destroy).toHaveBeenCalledTimes(1)
  })

  it('detaches the password callback and waits for cancelled destruction within its grace', async () => {
    vi.useFakeTimers()
    const mock = adapter()
    const controller = new AbortController()
    const destroyed = deferred<void>()
    Object.defineProperty(mock.task, 'promise', { value: never<Document>() })
    mock.task.destroy.mockReturnValue(destroyed.promise)
    let returned = false
    const pending = extractPdfText(BYTES, JOB_ID, { signal: controller.signal }, mock.runtime).then(
      (result) => {
        returned = true
        return result
      }
    )
    controller.abort()
    await vi.advanceTimersByTimeAsync(10)
    expect(mock.task.destroy).toHaveBeenCalledTimes(1)
    expect(mock.task.onPassword).toBe(null)
    expect(returned).toBe(false)
    destroyed.resolve()
    expect(await pending).toMatchObject({ code: 'CANCELLED' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([5000, 15])(
    'bounds interrupted cleanup by 100ms grace and the original %ims deadline',
    async (deadlineMs) => {
      vi.useFakeTimers()
      const mock = adapter()
      const controller = new AbortController()
      Object.defineProperty(mock.task, 'promise', { value: never<Document>() })
      mock.task.destroy.mockReturnValue(never())
      let returned = false
      const pending = extractPdfText(
        BYTES,
        JOB_ID,
        { signal: controller.signal, deadlineAt: Date.now() + deadlineMs },
        mock.runtime
      ).then((result) => {
        returned = true
        return result
      })
      controller.abort()
      await vi.advanceTimersByTimeAsync(10)
      expect(returned).toBe(false)
      await vi.advanceTimersByTimeAsync(Math.min(100, deadlineMs - 10) + 1)
      expect(await pending).toMatchObject({ code: 'CANCELLED' })
      expect(mock.task.destroy).toHaveBeenCalledTimes(1)
      expect(mock.task.onPassword).toBe(null)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['NO_TEXT', 'INVALID', 'LIMIT', 'UNSUPPORTED'] as const)(
    'does not mask a teardown failure behind %s',
    async (code) => {
      const mock = adapter(code === 'NO_TEXT' ? [[]] : undefined)
      if (code === 'INVALID')
        Object.defineProperty(mock.task, 'promise', {
          value: Promise.reject({ name: 'InvalidPDFException' })
        })
      if (code === 'LIMIT') mock.document.numPages = 201
      if (code === 'UNSUPPORTED') mock.document.isPureXfa = true
      mock.task.destroy.mockRejectedValue(new Error('private teardown error'))
      const result = await extractPdfText(BYTES, JOB_ID, {}, mock.runtime)
      expect(result).toMatchObject({ code: 'EXECUTION_FAILED' })
      expect(mock.task.onPassword).toBe(null)
      expect(mock.task.destroy).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(result)).not.toContain('private')
    }
  )

  it('still bounds destruction after a policy failure', async () => {
    vi.useFakeTimers()
    const mock = adapter()
    mock.document.numPages = 201
    mock.task.destroy.mockReturnValue(never())
    const pending = extractPdfText(BYTES, JOB_ID, {}, mock.runtime)
    await vi.advanceTimersByTimeAsync(5001)
    expect(await pending).toMatchObject({ code: 'TIMEOUT' })
    expect(mock.task.destroy).toHaveBeenCalledTimes(1)
  })

  it('cancels and releases a real ReadableStream reader with a pending read', async () => {
    const controller = new AbortController()
    const entered = deferred<void>()
    const cancel = vi.fn()
    const stream = new ReadableStream<{ items: Item[] }>(
      {
        pull() {
          entered.resolve()
        },
        cancel
      },
      { highWaterMark: 0 }
    )
    const mock = adapter()
    const runtime: PdfTextRuntime = {
      version: '6.3.289',
      getDocument: () => ({
        onPassword: null,
        destroy: mock.task.destroy,
        promise: Promise.resolve({
          ...mock.document,
          getPage: async () => ({ streamTextContent: () => stream })
        })
      })
    }
    const pending = extractPdfText(BYTES, JOB_ID, { signal: controller.signal }, runtime)
    await entered.promise
    controller.abort()
    expect(await pending).toMatchObject({ code: 'CANCELLED' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(stream.locked).toBe(false)
    expect(mock.task.destroy).toHaveBeenCalledTimes(1)
  })
})
