import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { inspectStillRaster } from '../utils/stillRaster'

const MAX_PIXELS = 40_000_000
const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 256
const abortError = () => Object.assign(new Error('Image preparation aborted'), { name: 'AbortError' })
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw abortError() }

/** Trusted backend must inspect the same bytes before allocation and enforce maxPixels during
 * decoding, apply orientation, preserve transparency, honor limits and cancellation. MAIN validates
 * input and output structure, but cannot enforce codec-internal pixel or transparency guarantees.
 * Critical admission contract: encode MUST NOT settle until the native process has exited, including
 * on abort, timeout, pipe failure or kill failure. If exit cannot be confirmed it MUST remain pending;
 * the queue intentionally remains quarantined and refuses to start another encoder. A rejected
 * promise immediately after kill() is unsafe. Process supervision and eventual recovery are adapter
 * responsibilities; this module cannot verify that an arbitrary encoder fulfills this contract. */
export interface ChatImageEncoder {
  encode(bytes: Uint8Array, options: { targetBytes: number; maxEdge: number; maxPixels: number; signal: AbortSignal }): Promise<Uint8Array>
}
export type PreparedChatImage = { bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg'; width: number; height: number }
type Options = { targetBytes?: number; maxSide?: number }
type Flight = { promise: Promise<PreparedChatImage>; controller: AbortController; users: number; settled: boolean }

// Read typed-array internal slots, not user-shadowable source properties.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!
function sourceShape(source: Uint8Array): { size: number; buffer: ArrayBuffer; offset: number } {
  try {
    const size = typedArrayByteLength.call(source) as number
    const buffer = typedArrayBuffer.call(source) as ArrayBufferLike
    const offset = typedArrayByteOffset.call(source) as number
    if (!utilTypes.isArrayBuffer(buffer)) throw new Error()
    if (size > MAX_INPUT_BYTES) throw new Error()
    return { size, buffer: buffer as ArrayBuffer, offset }
  } catch {
    throw new Error('Invalid source bytes')
  }
}

// Process-wide admission includes running work; source copies exist only after admission.
const MAX_JOBS = 50
const MAX_INFLIGHT_SOURCE_BYTES = 64 * 1024 * 1024
type QueueEntry = { size: number; start: () => void; cancel: () => void }
const queue: QueueEntry[] = []
let active = false
let admittedBytes = 0
let admittedJobs = 0
let batchBytes = 0
const MAX_BATCH_BYTES = 32 * 1024 * 1024
const MAX_BATCHES = 50
let activeBatches = 0
function admit<T>(size: number, signal: AbortSignal, makeTask: () => () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  if (admittedJobs >= MAX_JOBS || admittedBytes + batchBytes + size > MAX_INFLIGHT_SOURCE_BYTES) return Promise.reject(new Error('Image preparation queue full'))
  admittedJobs++; admittedBytes += size
  let task: () => Promise<T>
  try { task = makeTask() } catch (error) { admittedJobs--; admittedBytes -= size; return Promise.reject(error) }
  return new Promise<T>((resolve, reject) => {
    let released = false
    const release = () => { if (released) return; released = true; admittedJobs--; admittedBytes -= size }
    const onAbort = () => entry.cancel()
    const entry: QueueEntry = {
      size,
      cancel: () => { const index = queue.indexOf(entry); if (index < 0) return; queue.splice(index, 1); signal.removeEventListener('abort', onAbort); release(); reject(abortError()) },
      start: () => {
        signal.removeEventListener('abort', onAbort)
        active = true
        Promise.resolve().then(task).then(resolve, reject).finally(() => { release(); active = false; pump() })
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    queue.push(entry)
    if (signal.aborted) entry.cancel()
    pump()
  })
}
function pump(): void { if (!active) queue.shift()?.start() }

/** Per-instance cache: caller must scope and clear it at the end of a short-lived operation. */
export class ChatImagePreparer {
  private cache = new Map<string, PreparedChatImage>()
  private cacheBytes = 0
  private flights = new Map<string, Flight>()
  // clear() retires whole batches as well as the flights already admitted.
  private generation = 0
  constructor(private readonly encoder: ChatImageEncoder, private readonly cacheLimits: { entries: number; bytes: number } = { entries: MAX_ENTRIES, bytes: MAX_CACHE_BYTES }) {
    if (!Number.isSafeInteger(cacheLimits.entries) || cacheLimits.entries < 0 || cacheLimits.entries > MAX_ENTRIES || !Number.isSafeInteger(cacheLimits.bytes) || cacheLimits.bytes < 0 || cacheLimits.bytes > MAX_CACHE_BYTES) throw new Error('Invalid image cache limits')
  }
  clear(): void { this.generation++; this.cache.clear(); this.cacheBytes = 0; for (const flight of this.flights.values()) flight.controller.abort() }
  async prepare(source: Uint8Array, options: Options = {}, signal?: AbortSignal): Promise<PreparedChatImage> {
    if (signal?.aborted) throw abortError()
    const { targetBytes = 512000, maxSide = 2000 } = options
    if (![targetBytes, maxSide].every(Number.isSafeInteger) || targetBytes < 1 || targetBytes > 4 * 1024 * 1024 || maxSide < 1 || maxSide > 2000) throw new Error('Invalid image preparation options')
    if (!utilTypes.isUint8Array(source)) throw new Error('Invalid source bytes')
    const { size, buffer, offset } = sourceShape(source)
    // Use typed-array internal bytes, not a caller-overridden iterator. With a
    // non-shared backing buffer and no callouts, this synchronous scan/hash and
    // the later admitted copy all see the same bytes.
    const view = new Uint8Array(buffer, offset, size)
    inspectStillRaster(view, { maxBytes: MAX_INPUT_BYTES, maxEdge: 16384, maxPixels: MAX_PIXELS })
    const key = createHash('sha256').update(view).update(`:${targetBytes}:${maxSide}`).digest('hex')
    const cached = this.cache.get(key)
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return this.copy(cached) }
    let flight = this.flights.get(key)
    if (!flight) {
      const controller = new AbortController()
      const item: Flight = { controller, users: 0, settled: false, promise: undefined as unknown as Promise<PreparedChatImage> }
      // Admission happens before copying. Constructing from a typed array uses
      // its internal bytes and does not call the input object's iterator.
      const work = admit(size, controller.signal, () => {
        const snapshot = new Uint8Array(view)
        return () => this.process(snapshot, { targetBytes, maxSide }, controller.signal)
      })
      item.promise = work.then(result => {
        checkAbort(controller.signal)
        if (this.cacheLimits.entries && result.bytes.byteLength <= this.cacheLimits.bytes) {
          this.cache.set(key, this.copy(result)); this.cacheBytes += result.bytes.byteLength
          while (this.cache.size > this.cacheLimits.entries || this.cacheBytes > this.cacheLimits.bytes) {
            const first = this.cache.keys().next().value as string
            this.cacheBytes -= this.cache.get(first)!.bytes.byteLength; this.cache.delete(first)
          }
        }
        return result
      }).finally(() => { item.settled = true; if (this.flights.get(key) === item) this.flights.delete(key) })
      flight = item; this.flights.set(key, item)
    }
    if (flight?.controller.signal.aborted) throw abortError()
    const item = flight
    item.users++
    return new Promise((resolve, reject) => {
      let done = false
      const finish = () => { if (done) return false; done = true; signal?.removeEventListener('abort', onAbort); item.users--; if (!item.users && !item.settled) item.controller.abort(); return true }
      const onAbort = () => { if (finish()) reject(abortError()) }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      item.promise.then(result => { if (finish()) resolve(this.copy(result)) }, error => { if (finish()) reject(error) })
    })
  }
  /** Sequential batch: reject rather than return an incomplete over-budget result. */
  async prepareBatch(sources: readonly Uint8Array[], totalBytes: number, options: Options = {}, signal?: AbortSignal): Promise<PreparedChatImage[]> {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) throw new Error('Invalid batch byte budget')
    if (signal?.aborted) throw abortError()
    if (utilTypes.isProxy(sources) || !Array.isArray(sources) || utilTypes.isProxy(options) || !options || typeof options !== 'object') throw new Error('Invalid batch inputs')
    const length = Object.getOwnPropertyDescriptor(sources, 'length')?.value
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JOBS) throw new Error('Invalid batch size')
    const getOption = (key: 'targetBytes' | 'maxSide') => {
      const descriptor = Object.getOwnPropertyDescriptor(options, key)
      if (descriptor && !('value' in descriptor)) throw new Error('Invalid batch options')
      return descriptor?.value
    }
    const fixedOptions: Options = { targetBytes: getOption('targetBytes'), maxSide: getOption('maxSide') }
    if ((fixedOptions.targetBytes !== undefined && (!Number.isSafeInteger(fixedOptions.targetBytes) || fixedOptions.targetBytes < 1 || fixedOptions.targetBytes > 4 * 1024 * 1024)) ||
        (fixedOptions.maxSide !== undefined && (!Number.isSafeInteger(fixedOptions.maxSide) || fixedOptions.maxSide < 1 || fixedOptions.maxSide > 2000))) throw new Error('Invalid batch options')
    const shapes: Array<{size:number; buffer:ArrayBuffer; offset:number}> = []
    let total = 0
    for (let i = 0; i < length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(sources, String(i))
      if (!descriptor || !('value' in descriptor) || !utilTypes.isUint8Array(descriptor.value)) throw new Error('Invalid batch source')
      const shape = sourceShape(descriptor.value)
      total += shape.size
      if (total > MAX_BATCH_BYTES) throw new Error('Batch source budget exceeded')
      shapes.push(shape)
    }
    if (activeBatches >= MAX_BATCHES || admittedBytes + batchBytes + total > MAX_INFLIGHT_SOURCE_BYTES) throw new Error('Image preparation queue full')
    const generation = this.generation
    const checkGeneration = (): void => { if (generation !== this.generation) throw abortError() }
    activeBatches++; batchBytes += total
    try {
      const snapshots = shapes.map(({buffer, offset, size}) => new Uint8Array(new Uint8Array(buffer, offset, size)))
      const results: PreparedChatImage[] = []
      let remaining = totalBytes
      for (let index = 0; index < length; index++) {
        checkGeneration()
        const count = length - index
        const share = Math.floor(remaining / count)
        if (share < 1) throw new Error('Image batch exceeds byte budget')
        const result = await this.prepare(snapshots[index], { ...fixedOptions, targetBytes: Math.min(fixedOptions.targetBytes ?? 512000, share) }, signal)
        checkGeneration()
        remaining -= result.bytes.byteLength
        results.push(result)
      }
      return results
    } finally { batchBytes -= total; activeBatches-- }
  }
  private copy(result: PreparedChatImage): PreparedChatImage { return { ...result, bytes: Uint8Array.from(result.bytes) } }
  private async process(bytes: Uint8Array, opts: Required<Options>, signal: AbortSignal): Promise<PreparedChatImage> {
    checkAbort(signal)
    const result = await this.encoder.encode(bytes, { targetBytes: opts.targetBytes, maxEdge: opts.maxSide, maxPixels: MAX_PIXELS, signal })
    checkAbort(signal)
    if (!utilTypes.isUint8Array(result)) throw new Error('Invalid encoded image')
    const { size, buffer, offset } = sourceShape(result)
    if (!size) throw new Error('Invalid encoded image')
    if (size > opts.targetBytes) throw new Error('Encoded image exceeds byte budget')
    const output = new Uint8Array(new Uint8Array(buffer, offset, size))
    const info = inspectStillRaster(output, { maxBytes: Math.min(opts.targetBytes, MAX_INPUT_BYTES), maxEdge: opts.maxSide, maxPixels: MAX_PIXELS })
    if (info.orientation !== 1 || (info.mimeType !== 'image/png' && info.mimeType !== 'image/jpeg')) throw new Error('Invalid encoded image format or orientation')
    return { bytes: output, mimeType: info.mimeType, width: info.width, height: info.height }
  }
}
