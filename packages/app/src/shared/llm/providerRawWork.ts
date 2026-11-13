/** Trusted constructor policy only. Never part of model parameters or wire data. */
export type ProviderRawWorkRetainer = (drain: Promise<void>, admitted: () => void) => void

export class ProviderRawWorkOwnershipError extends Error {
  readonly code = 'PROVIDER_RAW_WORK_OWNERSHIP'
  constructor(message: string) {
    super(`Provider raw-work ownership: ${message}`)
    this.name = 'ProviderRawWorkOwnershipError'
  }
}

const nativePromisePrototype = Promise.prototype
const nativePromiseThen = Promise.prototype.then
const noResult = (): void => undefined
/**
 * Rejection hygiene only, NEVER shape acceptance or permission. Trusted native
 * delegates return non-Proxy objects. Temporarily mask constructor so intrinsic
 * then cannot invoke an unsupported subclass species or own constructor getter.
 * Restore its exact descriptor synchronously. Unmaskable nonconfigurable accessors
 * /nonextensible foreign objects cannot safely be observed by portable JS; their
 * trusted supplier must already observe them. Ownership still remains poisoned.
 */
export const sinkUnsupportedProviderRejection = (value: unknown): void => {
  if (typeof value !== 'object' || value === null) return
  let original: PropertyDescriptor | undefined
  let masked = false
  try {
    original = Object.getOwnPropertyDescriptor(value, 'constructor')
    if (original && !original.configurable) {
      if (!('value' in original)) return
      if (original.value !== undefined && !original.writable) return
      if (original.value !== undefined) {
        Object.defineProperty(value, 'constructor', { value: undefined })
        masked = true
      }
    } else {
      Object.defineProperty(value, 'constructor', { value: undefined, configurable: true })
      masked = true
    }
    // This intrinsic checks the Promise internal brand without reading .then.
    Reflect.apply(nativePromiseThen, value, [noResult, noResult])
  } catch {
    /* Unsupported thenables/proxies are not assimilated; caller still fails closed. */
  } finally {
    if (masked) {
      if (original) Object.defineProperty(value, 'constructor', original)
      else Reflect.deleteProperty(value, 'constructor')
    }
  }
}
const observe = (promise: Promise<unknown>, settled: () => void): void => {
  // Both observers return void; do not make an ignored rejecting finally promise.
  Reflect.apply(nativePromiseThen, promise, [settled, settled])
}
const ordinaryPromise = (value: unknown): value is Promise<unknown> =>
  typeof value === 'object' && value !== null &&
  Object.getPrototypeOf(value) === nativePromisePrototype &&
  !Object.getOwnPropertyDescriptor(value, 'constructor') &&
  !Object.getOwnPropertyDescriptor(value, 'then')

/**
 * Passive ownership, not request success or a clean witness. One local drain per
 * control, admitted synchronously before that control can invoke provider work.
 * Only already-owned cleanup may extend a sealed lifetime. Invalid post-dispatch
 * protocol poisons ownership permanently rather than inventing a tool outcome.
 * Shared/browser code deliberately imports no MAIN controller or Node builtins.
 */
export class ProviderRawWorkLifetime {
  readonly drain: Promise<void>
  private resolveDrain!: () => void
  private pending = 0
  private sealed = false
  private error?: ProviderRawWorkOwnershipError

  constructor(retain: ProviderRawWorkRetainer) {
    this.drain = new Promise<void>(resolve => { this.resolveDrain = resolve })
    let admitted = false
    let admitting = true
    try {
      const result: unknown = retain(this.drain, () => {
        if (!admitting || admitted) throw new ProviderRawWorkOwnershipError('invalid synchronous admission.')
        admitted = true
      })
      if (result !== undefined) {
        // An async function is assignable to () => void. Observe its rejection,
        // but never accept it as synchronous admission or await it here.
        sinkUnsupportedProviderRejection(result)
        throw new ProviderRawWorkOwnershipError('retainer must return synchronously without a result.')
      }
      if (!admitted) throw new ProviderRawWorkOwnershipError('retainer did not synchronously enter its exact scope.')
    } catch (error) {
      this.seal() // No raw work exists; release any already-entered passive child.
      throw error
    } finally {
      admitting = false
    }
  }

  check(): void {
    if (this.error) throw this.error
    if (this.sealed) throw new ProviderRawWorkOwnershipError('control is sealed for new work.')
  }

  invoke<T>(operation: () => Promise<T>): Promise<T> {
    this.check() // Must precede invoking fetch/read/text/json/blob, not follow it.
    return this.invokeRetained(operation)
  }

  cleanup(operation: () => Promise<unknown>): void {
    if (this.sealed && this.pending === 0) {
      throw new ProviderRawWorkOwnershipError('cleanup is not a continuation of retained work.')
    }
    this.invokeRetained(operation)
  }

  private invokeRetained<T>(operation: () => Promise<T>): Promise<T> {
    // The delegate can synchronously abort/dispose its own control. Reserve first
    // so sealing cannot resolve drain before the actual return is registered.
    this.pending += 1
    try {
      return this.track(operation())
    } finally {
      this.pending -= 1
      this.maybeDrain()
    }
  }

  /** Also retains the fetch completion envelope BEFORE its first microtask runs. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending += 1
    try {
      if (!ordinaryPromise(promise)) throw new Error('unsupported raw promise shape')
      // Intrinsic then also checks the native Promise brand; a spoofed prototype
      // cannot pass just by looking like a promise. Never read arbitrary .then.
      observe(promise, () => { this.pending -= 1; this.maybeDrain() })
    } catch {
      sinkUnsupportedProviderRejection(promise)
      this.pending -= 1
      this.error ??= new ProviderRawWorkOwnershipError('raw delegate returned an unsupported promise; ownership remains blocked.')
      throw this.error
    }
    return promise
  }

  seal(): void {
    this.sealed = true
    this.maybeDrain()
  }

  private maybeDrain(): void {
    if (this.sealed && this.pending === 0 && !this.error) this.resolveDrain()
  }
}
