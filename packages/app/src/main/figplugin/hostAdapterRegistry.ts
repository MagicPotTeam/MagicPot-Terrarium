import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import type { FigPluginPlan } from '@shared/figplugin/plan'
import type { FigPluginManagedTarget } from '@shared/figplugin/management'
import type { FigPluginPlanScope } from './planPreview'
import {
  inspectFigPluginAdapterCapabilityState,
  readFigPluginAdapterDescriptor,
  type FigPluginAdapterCapabilityError,
  type FigPluginHostAdapter,
  type FigPluginNativeAdapterDescriptor
} from './hostAdapter'

/**
 * Main-process registry for real host adapters. This is deliberately separate from the bridge
 * transport: a bearer session can never register, replace, or discover an adapter through HTTP.
 */
export type FigPluginProductionAdapterRegistrationError =
  'INVALID_ADAPTER' | 'ADAPTER_UNAVAILABLE' | 'NOT_PRODUCTION_ADAPTER' | 'DUPLICATE_INSTANCE'

export type FigPluginProductionAdapterResolveError =
  | 'ADAPTER_UNAVAILABLE'
  | 'HOST_MISMATCH'
  | Extract<FigPluginAdapterCapabilityError, 'UNSUPPORTED_COMMAND'>

export type FigPluginProductionHostAdapter = FigPluginHostAdapter & {
  readonly descriptor: FigPluginNativeAdapterDescriptor
}

export type FigPluginProductionAdapterRegistration = Readonly<{
  key: string
  descriptor: FigPluginNativeAdapterDescriptor
}>

export type FigPluginProductionAdapterResolution =
  | {
      ok: true
      adapter: FigPluginProductionHostAdapter
      descriptor: FigPluginNativeAdapterDescriptor
    }
  | { ok: false; code: FigPluginProductionAdapterResolveError }

/**
 * Main-owned source data used to bind one native host session to a plan run.  The
 * instance epoch is deliberately added by the coordinator rather than accepted
 * from a host callback, so a callback cannot select a different registered host.
 */
export type FigPluginProductionPlanSource = Readonly<{
  target: FigPluginManagedTarget
  projectId: string
  context: FigPluginPlanScope['context']
  callId: string
}>

export type FigPluginProductionPlanScopeResolver = (
  signal: AbortSignal
) => Promise<FigPluginProductionPlanSource | undefined>

type Entry = {
  adapter: FigPluginProductionHostAdapter
  descriptor: FigPluginNativeAdapterDescriptor
}

const keyPattern = /^[a-f0-9]{32}$(?![\s\S])/u

const readNativeDescriptor = (adapter: unknown): FigPluginNativeAdapterDescriptor | undefined => {
  try {
    if (!adapter || typeof adapter !== 'object') return undefined
    const candidate = adapter as Partial<FigPluginHostAdapter>
    if (typeof candidate.capture !== 'function' || typeof candidate.beginRename !== 'function')
      return undefined
    const descriptor = readFigPluginAdapterDescriptor(candidate.descriptor)
    return descriptor?.kind === 'native' ? descriptor : undefined
  } catch {
    return undefined
  }
}

const readDescriptorKind = (adapter: unknown): 'unavailable' | 'synthetic' | 'other' => {
  try {
    if (!adapter || typeof adapter !== 'object') return 'other'
    const parsed = readFigPluginAdapterDescriptor((adapter as { descriptor?: unknown }).descriptor)
    if (parsed?.kind === 'unavailable' || parsed?.kind === 'synthetic') return parsed.kind
  } catch {
    // Accessors and proxies are untrusted at this boundary.
  }
  return 'other'
}

const sameDescriptor = (
  left: FigPluginNativeAdapterDescriptor,
  right: FigPluginNativeAdapterDescriptor
): boolean => {
  try {
    return canonicalFigPluginJson(left) === canonicalFigPluginJson(right)
  } catch {
    return false
  }
}

const boundedKey = (value: unknown): value is string =>
  typeof value === 'string' && keyPattern.test(value)

/**
 * Register and resolve native Figma/Photoshop adapters by their main-owned instance epoch.
 * Registration is intentionally strict: synthetic fixtures and unavailable placeholders cannot
 * cross this boundary, and a changed descriptor invalidates the entry before use.
 */
export class FigPluginHostAdapterRegistry {
  readonly #entries = new Map<string, Entry>()
  #disposed = false

  register(
    adapter: unknown
  ):
    | { ok: true; registration: FigPluginProductionAdapterRegistration }
    | { ok: false; code: FigPluginProductionAdapterRegistrationError } {
    if (this.#disposed) return { ok: false, code: 'ADAPTER_UNAVAILABLE' }
    const native = readNativeDescriptor(adapter)
    if (!native) {
      const kind = readDescriptorKind(adapter)
      return {
        ok: false,
        code:
          kind === 'unavailable'
            ? 'ADAPTER_UNAVAILABLE'
            : kind === 'synthetic'
              ? 'NOT_PRODUCTION_ADAPTER'
              : 'INVALID_ADAPTER'
      }
    }
    const key = native.instanceEpoch
    if (this.#entries.has(key)) return { ok: false, code: 'DUPLICATE_INSTANCE' }
    const entry: Entry = {
      adapter: adapter as FigPluginProductionHostAdapter,
      descriptor: native
    }
    this.#entries.set(key, entry)
    return {
      ok: true,
      registration: Object.freeze({ key, descriptor: native })
    }
  }

  /**
   * Resolve an adapter only while its descriptor remains byte-for-byte equivalent to the
   * registered native contract. A host changing epoch, host, capabilities, or guarantees is
   * treated as a revoked registration and removed from the registry.
   */
  get(instanceEpoch: unknown): FigPluginProductionHostAdapter | undefined {
    if (this.#disposed || !boundedKey(instanceEpoch)) return undefined
    const entry = this.#entries.get(instanceEpoch)
    if (!entry) return undefined
    const current = readNativeDescriptor(entry.adapter)
    if (!current || !sameDescriptor(current, entry.descriptor)) {
      this.#entries.delete(instanceEpoch)
      return undefined
    }
    return entry.adapter
  }

  /** Resolve an adapter only when the already-bound Bridge host agrees with it. */
  getForHost(
    instanceEpoch: unknown,
    expectedHost: FigPluginNativeAdapterDescriptor['host']
  ): FigPluginProductionHostAdapter | undefined {
    const adapter = this.get(instanceEpoch)
    return adapter?.descriptor.host === expectedHost ? adapter : undefined
  }

  /** Resolve and capability-check a native adapter before handing it to an execution service. */
  resolveForPlan(
    instanceEpoch: unknown,
    plan: FigPluginPlan,
    expectedHost?: FigPluginNativeAdapterDescriptor['host']
  ): FigPluginProductionAdapterResolution {
    const adapter = this.get(instanceEpoch)
    if (!adapter) return { ok: false, code: 'ADAPTER_UNAVAILABLE' }
    const descriptor = readNativeDescriptor(adapter)
    if (!descriptor) return { ok: false, code: 'ADAPTER_UNAVAILABLE' }
    // The plan itself has no host field. When the controller has already bound the
    // request to a host, require that binding here instead of allowing a valid
    // adapter from the other native host to service it.
    if (expectedHost !== undefined && descriptor.host !== expectedHost) {
      return { ok: false, code: 'HOST_MISMATCH' }
    }
    const capability = inspectFigPluginAdapterCapabilityState(descriptor, plan)
    if (capability.state !== 'ready') {
      return {
        ok: false,
        code:
          capability.code === 'UNSUPPORTED_COMMAND' ? 'UNSUPPORTED_COMMAND' : 'ADAPTER_UNAVAILABLE'
      }
    }
    return { ok: true, adapter, descriptor }
  }

  /**
   * Remove a registration. Supplying the adapter instance makes stale teardown callbacks harmless
   * when a host has already been replaced by a new epoch.
   */
  unregister(instanceEpoch: unknown, expected?: FigPluginHostAdapter): boolean {
    if (this.#disposed || !boundedKey(instanceEpoch)) return false
    const entry = this.#entries.get(instanceEpoch)
    if (!entry || (expected !== undefined && entry.adapter !== expected)) return false
    this.#entries.delete(instanceEpoch)
    return true
  }

  /** Return descriptors only; adapter methods are never exposed by enumeration. */
  list(): readonly FigPluginProductionAdapterRegistration[] {
    if (this.#disposed) return Object.freeze([])
    const registrations: FigPluginProductionAdapterRegistration[] = []
    for (const key of [...this.#entries.keys()]) {
      const adapter = this.get(key)
      if (!adapter) continue
      const descriptor = readNativeDescriptor(adapter)
      if (descriptor) registrations.push(Object.freeze({ key, descriptor }))
    }
    return Object.freeze(registrations)
  }

  /** Stop accepting lookups and best-effort dispose every registered host adapter. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const adapters = [...this.#entries.values()].map(({ adapter }) => adapter)
    this.#entries.clear()
    await Promise.all(
      adapters.map(async (adapter) => {
        try {
          await adapter.dispose?.()
        } catch {
          // Registry teardown must not be held by a broken host. Execution readback remains
          // authoritative for any transaction that was already in progress.
        }
      })
    )
  }
}

export const createFigPluginHostAdapterRegistry = (): FigPluginHostAdapterRegistry =>
  new FigPluginHostAdapterRegistry()

type ProductionSession = {
  readonly adapter: FigPluginProductionHostAdapter
  readonly captureScope: FigPluginProductionPlanScopeResolver
}

/**
 * Couples adapter registrations with their trusted live-session scope resolver.
 * The resolver is main-owned and never reachable from Bridge HTTP.  A plan run
 * is allowed to use a scope only when exactly one session is registered; an
 * ambiguous desktop state therefore fails closed instead of guessing a host.
 */
export class FigPluginProductionHostAdapterSessions {
  readonly #registry = createFigPluginHostAdapterRegistry()
  readonly #sessions = new Map<string, ProductionSession>()
  #disposed = false

  get registry(): FigPluginHostAdapterRegistry {
    return this.#registry
  }

  register(
    adapter: unknown,
    captureScope: FigPluginProductionPlanScopeResolver
  ):
    | { ok: true; registration: FigPluginProductionAdapterRegistration }
    | { ok: false; code: FigPluginProductionAdapterRegistrationError } {
    if (this.#disposed || typeof captureScope !== 'function')
      return { ok: false, code: 'INVALID_ADAPTER' }
    const registered = this.#registry.register(adapter)
    if (!registered.ok) return registered
    const current = this.#registry.get(registered.registration.key)
    if (!current) {
      // This is defensive against a hostile adapter accessor changing during
      // registration. The registry remains the authority for cleanup.
      this.#registry.unregister(registered.registration.key)
      return { ok: false, code: 'ADAPTER_UNAVAILABLE' }
    }
    this.#sessions.set(registered.registration.key, { adapter: current, captureScope })
    return registered
  }

  unregister(instanceEpoch: unknown, expected?: FigPluginHostAdapter): boolean {
    if (this.#disposed) return false
    const removed = this.#registry.unregister(instanceEpoch, expected)
    if (removed && typeof instanceEpoch === 'string') this.#sessions.delete(instanceEpoch)
    return removed
  }

  /** Resolve the only active host scope; multiple live hosts are intentionally ambiguous. */
  async captureScope(
    signal: AbortSignal
  ): Promise<(FigPluginProductionPlanSource & { adapterInstanceEpoch: string }) | undefined> {
    if (this.#disposed || this.#sessions.size !== 1 || signal.aborted) return undefined
    const [instanceEpoch, session] = [...this.#sessions.entries()][0]
    if (!this.#registry.get(instanceEpoch)) {
      this.#sessions.delete(instanceEpoch)
      return undefined
    }
    try {
      const source = await session.captureScope(signal)
      if (
        !source ||
        signal.aborted ||
        !this.#registry.getForHost(instanceEpoch, session.adapter.descriptor.host)
      )
        return undefined
      return Object.freeze({ ...source, adapterInstanceEpoch: instanceEpoch })
    } catch {
      return undefined
    }
  }

  list(): readonly FigPluginProductionAdapterRegistration[] {
    if (this.#disposed) return Object.freeze([])
    return this.#registry.list()
  }

  /** Drop all host sessions while retaining the coordinator for a later rebind. */
  async clear(): Promise<void> {
    if (this.#disposed) return
    const sessions = [...this.#sessions.entries()]
    this.#sessions.clear()
    for (const [instanceEpoch, session] of sessions) {
      this.#registry.unregister(instanceEpoch, session.adapter)
      try {
        await session.adapter.dispose?.()
      } catch {
        // A stale host must not prevent Bridge teardown or a subsequent rebind.
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#sessions.clear()
    await this.#registry.dispose()
  }
}

export const createFigPluginProductionHostAdapterSessions =
  (): FigPluginProductionHostAdapterSessions => new FigPluginProductionHostAdapterSessions()
