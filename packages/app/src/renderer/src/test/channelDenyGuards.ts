/**
 * Deny-by-default guards for the channel real-page test bed
 * (config/vitest/vitest.web.channel.config.mjs lists this file as its first setup file, so it runs
 * before any module of the test file, and therefore before any business module, is loaded).
 *
 * Nothing in a guarded run may leave the process or reach a real desktop bridge:
 *
 *  - page level: fetch, XMLHttpRequest, WebSocket, EventSource, Worker, SharedWorker,
 *    navigator.sendBeacon and indexedDB are replaced on BOTH globals of the vitest jsdom
 *    environment (the Node global that the tests see as `window`, and the underlying jsdom window);
 *  - transport level: net.Socket.prototype.connect and net.Server.prototype.listen are replaced, so
 *    Node's own fetch (undici), node:http(s), a jsdom iframe's XMLHttpRequest, the `ws` package or
 *    any module imported later (static or dynamic) cannot open or accept a TCP connection either;
 *    UDP (dgram.Socket bind / connect / send) and DNS (node:dns and node:dns/promises lookups and
 *    resolvers) are refused the same way;
 *  - bridge level: every preload bridge (`window.api`, `window.win`, ...) is a proxy that refuses
 *    each call that the running test did not list with `allowChannelBridge`.
 *
 * Every refusal is counted. The setup registers an `afterEach` that fails a test that left a
 * refusal behind (and an `afterAll` for late ones), restores a replaced guard and clears what the
 * test allowed; a test that refuses something on purpose consumes it with
 * `takeChannelDeniedAttempts()`.
 *
 * Only two things can be allowed, both per test: an in-memory IndexedDB fake
 * (`allowChannelInMemoryIndexedDb`) and listed bridge functions (`allowChannelBridge`).
 * There is no way to allow the network.
 *
 * The IndexedDB allowance ends with the test (or when the test allows again) at the level of the
 * handles, not only of the `indexedDB` global: the factory, every database it opened and every
 * transaction of those databases refuse and count each call from then on. Business code that
 * cached a connection (chatStorage does) therefore cannot keep reading or writing the storage of
 * an earlier test. (Object stores, cursors and requests are not wrapped: they belong to a
 * transaction, which does not outlive the task that uses it.)
 *
 * Known limits: child processes and node:worker_threads are not guarded; renderer code has no
 * access to them. A module that captured a node:dns function before this file ran keeps it (this
 * file is the first setup file, so no business module can).
 */
import dgram from 'node:dgram'
import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'
import { Server, Socket } from 'node:net'
import { afterAll, afterEach, expect } from 'vitest'

export type ChannelDeniedKind =
  | 'fetch'
  | 'xhr'
  | 'websocket'
  | 'eventsource'
  | 'worker'
  | 'beacon'
  | 'indexeddb'
  | 'socket'
  | 'udp'
  | 'dns'
  | 'bridge'
  | 'guard-replaced'

export interface ChannelDeniedAttempt {
  kind: ChannelDeniedKind
  /** What was attempted, e.g. the URL or `api.svcFs.readFileFromPath`. */
  detail: string
  /** The test that was running when the attempt was made (empty outside a test). */
  test: string
  /** The first frames of the caller, to find the business code that tried. */
  stack: string
}

/** Preload bridges (packages/app/src/preload/index.ts) that are refused unless listed. */
export const CHANNEL_BRIDGE_ROOTS = [
  'api',
  'win',
  'path',
  'appEvents',
  'canvasScreenshot',
  'electronFile',
  'magicpotProjectCanvasBenchmarkRuntime',
  'electron'
] as const
export type ChannelBridgeRoot = (typeof CHANNEL_BRIDGE_ROOTS)[number]

/** A tree of functions (or plain values) that a test lets the page call on one bridge. */
export interface ChannelBridgeAllowance {
  [key: string]:
    ChannelBridgeAllowance | ((...args: never[]) => unknown) | string | number | boolean | null
}

export const CHANNEL_GUARD_DENIED_ERROR = 'ChannelGuardDeniedError'
export const isChannelGuardDenied = (error: unknown): boolean =>
  error instanceof Error && error.name === CHANNEL_GUARD_DENIED_ERROR

interface ChannelDenyGuards {
  deniedAttempts(): readonly ChannelDeniedAttempt[]
  takeDeniedAttempts(): ChannelDeniedAttempt[]
  /** Refusals since the last test boundary or take, including those whose stack was not kept. */
  deniedAttemptCount(): number
  totalDeniedAttempts(): number
  allowInMemoryIndexedDb(fake: unknown): void
  allowBridge(root: ChannelBridgeRoot, allowance: ChannelBridgeAllowance): void
  resetAllowances(): void
  /** Names of guards that are no longer in place; each one is put back. */
  repairReplacedGuards(): string[]
  guardedGlobals(): readonly object[]
}

/** Refusals kept with their call stack between two test boundaries; the rest is only counted. */
const MAX_KEPT_ATTEMPTS = 200
const REGISTRY_KEY = Symbol.for('magicpot.channelDenyGuards.v1')
type GuardedGlobal = typeof globalThis & {
  [REGISTRY_KEY]?: ChannelDenyGuards
  jsdom?: { window?: object }
}

const describe = (value: unknown): string => {
  let text: string
  try {
    text =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object' && 'url' in value
          ? String((value as { url: unknown }).url)
          : value === undefined
            ? ''
            : String(value)
  } catch {
    text = '<unprintable>'
  }
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

function installChannelDenyGuards(): ChannelDenyGuards {
  const root = globalThis as GuardedGlobal
  let denied: ChannelDeniedAttempt[] = []
  let dropped = 0
  let total = 0
  let indexedDbAllowance: { ended: boolean; factory: object } | null = null
  const bridgeAllowances = new Map<string, ChannelBridgeAllowance>()

  const deny = (kind: ChannelDeniedKind, detail: string): Error => {
    const error = new Error(`Channel test bed refused ${kind}: ${detail}`)
    error.name = CHANNEL_GUARD_DENIED_ERROR
    let test = ''
    try {
      test = expect.getState().currentTestName ?? ''
    } catch {
      test = ''
    }
    const stack = (error.stack ?? '').split('\n').slice(1, 9).join('\n')
    // A page that retries in a loop must not fill the memory with call stacks.
    if (denied.length < MAX_KEPT_ATTEMPTS) denied.push({ kind, detail, test, stack })
    else dropped += 1
    total += 1
    return error
  }
  /** The caller still sees the rejection; the counter, not an unhandled rejection, reports it. */
  const rejected = (error: Error): Promise<never> => {
    const promise = Promise.reject(error)
    promise.catch(() => undefined)
    return promise
  }

  // ---- page level -------------------------------------------------------------------------
  const deniedFetch = function fetch(input?: unknown): Promise<never> {
    return rejected(deny('fetch', describe(input)))
  }
  const deniedConstructor = (
    kind: ChannelDeniedKind,
    name: string,
    constants: Record<string, number> = {}
  ): unknown => {
    const Denied = function (this: unknown, ...args: unknown[]): never {
      throw deny(kind, `new ${name}(${describe(args[0])})`)
    }
    Object.defineProperty(Denied, 'name', { value: name })
    for (const [key, value] of Object.entries(constants)) {
      Object.defineProperty(Denied, key, { value, enumerable: true })
      Object.defineProperty(Denied.prototype, key, { value, enumerable: true })
    }
    return Denied
  }
  const deniedIndexedDb = Object.freeze({
    open: (name?: unknown): never => {
      throw deny('indexeddb', `indexedDB.open(${describe(name)})`)
    },
    deleteDatabase: (name?: unknown): never => {
      throw deny('indexeddb', `indexedDB.deleteDatabase(${describe(name)})`)
    },
    databases: (): Promise<never> => rejected(deny('indexeddb', 'indexedDB.databases()')),
    cmp: (): never => {
      throw deny('indexeddb', 'indexedDB.cmp()')
    }
  })
  const deniedXhr = deniedConstructor('xhr', 'XMLHttpRequest', {
    UNSENT: 0,
    OPENED: 1,
    HEADERS_RECEIVED: 2,
    LOADING: 3,
    DONE: 4
  })
  const deniedWebSocket = deniedConstructor('websocket', 'WebSocket', {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3
  })
  const deniedEventSource = deniedConstructor('eventsource', 'EventSource', {
    CONNECTING: 0,
    OPEN: 1,
    CLOSED: 2
  })
  const deniedWorker = deniedConstructor('worker', 'Worker')
  const deniedSharedWorker = deniedConstructor('worker', 'SharedWorker')
  const pageGuards: Array<[string, () => unknown]> = [
    ['fetch', () => deniedFetch],
    ['XMLHttpRequest', () => deniedXhr],
    ['WebSocket', () => deniedWebSocket],
    ['EventSource', () => deniedEventSource],
    ['Worker', () => deniedWorker],
    ['SharedWorker', () => deniedSharedWorker],
    ['indexedDB', () => indexedDbAllowance?.factory ?? deniedIndexedDb]
  ]

  // ---- in-memory IndexedDB allowance ------------------------------------------------------
  /** Guarded stand-ins of the fake's factory, databases and transactions, by raw object. */
  const guardedIndexedDbHandles = new WeakMap<object, { allowance: object; guarded: object }>()
  /**
   * A stand-in that forwards to the fake while the allowance lasts and refuses (and counts)
   * every method call once it has ended. Properties and event handlers pass through.
   */
  const guardIndexedDbHandle = <T extends object>(
    raw: T,
    allowance: { ended: boolean },
    label: string,
    wrapResult: (method: string, result: unknown) => unknown = (_method, result) => result
  ): T => {
    // A fake may hand out the same object again under a later allowance: that one is live.
    const known = guardedIndexedDbHandles.get(raw)
    if (known && known.allowance === allowance) return known.guarded as T
    const methods = new Map<string, unknown>()
    const guarded = new Proxy(raw, {
      get: (target, key) => {
        const member: unknown = Reflect.get(target, key, target)
        if (typeof key === 'symbol' || typeof member !== 'function' || key.startsWith('on')) {
          return member
        }
        let method = methods.get(key)
        if (!method) {
          method = (...args: unknown[]): unknown => {
            if (allowance.ended) {
              throw deny(
                'indexeddb',
                `${label}.${key}(${describe(args[0])}) after its in-memory allowance ended (handle kept from an earlier test or an earlier allowance)`
              )
            }
            // Looked up again: the fake may have replaced the member since the first call.
            const current = Reflect.get(target, key, target) as (...rest: unknown[]) => unknown
            return wrapResult(key, current.apply(target, args))
          }
          methods.set(key, method)
        }
        return method
      },
      set: (target, key, value) => Reflect.set(target, key, value, target)
    })
    guardedIndexedDbHandles.set(raw, { allowance, guarded })
    return guarded
  }
  const guardIndexedDbDatabase = (value: unknown, allowance: { ended: boolean }): unknown =>
    value && typeof value === 'object' && typeof (value as IDBDatabase).transaction === 'function'
      ? guardIndexedDbHandle(value, allowance, 'IDBDatabase', (method, result) =>
          method === 'transaction' && result && typeof result === 'object'
            ? guardIndexedDbHandle(result, allowance, 'IDBTransaction')
            : result
        )
      : value
  /**
   * The open request stays the fake's own object (the fake passes it as `event.target`); only
   * its `result` is read through the guard, so the page never holds an unguarded database.
   */
  const guardIndexedDbOpenRequest = (request: unknown, allowance: { ended: boolean }): unknown => {
    if (!request || typeof request !== 'object') return request
    const own = Object.getOwnPropertyDescriptor(request, 'result')
    let assigned = !!own && 'value' in own
    let value: unknown = own && 'value' in own ? own.value : undefined
    const inherited = Object.getPrototypeOf(request) as object | null
    Object.defineProperty(request, 'result', {
      configurable: true,
      enumerable: true,
      get: () =>
        guardIndexedDbDatabase(
          assigned ? value : inherited ? Reflect.get(inherited, 'result', request) : undefined,
          allowance
        ),
      set: (next: unknown) => {
        assigned = true
        value = next
      }
    })
    return request
  }
  const endIndexedDbAllowance = (): void => {
    if (indexedDbAllowance) indexedDbAllowance.ended = true
    indexedDbAllowance = null
  }

  // ---- bridge level -----------------------------------------------------------------------
  /** Reads that probe an object (promise resolution, serialisers, matchers) are not calls. */
  const PASSIVE_KEYS = new Set([
    'then',
    'toJSON',
    'asymmetricMatch',
    '$$typeof',
    'nodeType',
    'tagName',
    'inspect'
  ])
  const FUNCTION_KEYS = new Set([
    'call',
    'apply',
    'bind',
    'name',
    'length',
    'toString',
    'constructor',
    'prototype'
  ])
  const listedNodes = new Map<string, object>()
  const deniedNodes = new Map<string, object>()
  const lookup = (path: readonly string[]): unknown => {
    let node: unknown = bridgeAllowances.get(path[0])
    for (const key of path.slice(1)) {
      if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key))
        return undefined
      node = (node as Record<string, unknown>)[key]
    }
    return node
  }
  const resolve = (path: readonly string[]): unknown => {
    const listed = lookup(path)
    if (typeof listed === 'function') return listed
    if (listed && typeof listed === 'object') return listedNode(path)
    if (listed !== undefined) return listed
    return deniedNode(path)
  }
  const refuseWrite = (path: readonly string[], key: string | symbol): boolean => {
    deny('guard-replaced', `write to ${[...path, String(key)].join('.')}`)
    return false
  }
  /** An unlisted bridge member: it reads as a function, and calling it is refused and counted. */
  const deniedNode = (path: readonly string[]): object => {
    const id = path.join('.')
    const cached = deniedNodes.get(id)
    if (cached) return cached
    const target = function deniedBridgeCall(): undefined {
      return undefined
    }
    const node = new Proxy(target, {
      apply: () => rejected(deny('bridge', id)),
      construct: () => {
        throw deny('bridge', `new ${id}`)
      },
      get: (fn, key) => {
        if (typeof key === 'symbol' || FUNCTION_KEYS.has(key)) return Reflect.get(fn, key)
        if (PASSIVE_KEYS.has(key)) return undefined
        return resolve([...path, key])
      },
      set: (_fn, key) => refuseWrite(path, key),
      defineProperty: (_fn, key) => refuseWrite(path, key),
      deleteProperty: (_fn, key) => refuseWrite(path, key)
    })
    deniedNodes.set(id, node)
    return node
  }
  /** A bridge, or a listed group on it: listed members are returned, everything else is refused. */
  const listedNode = (path: readonly string[]): object => {
    const id = path.join('.')
    const cached = listedNodes.get(id)
    if (cached) return cached
    const node = new Proxy(Object.create(null) as object, {
      get: (_target, key) => {
        if (typeof key === 'symbol' || PASSIVE_KEYS.has(key)) return undefined
        return resolve([...path, key])
      },
      has: (_target, key) => typeof key === 'string' && !PASSIVE_KEYS.has(key),
      set: (_target, key) => refuseWrite(path, key),
      defineProperty: (_target, key) => refuseWrite(path, key),
      deleteProperty: (_target, key) => refuseWrite(path, key)
    })
    listedNodes.set(id, node)
    return node
  }
  const bridgeGuards: Array<[string, () => unknown]> = CHANNEL_BRIDGE_ROOTS.map((name) => {
    const node = listedNode([name])
    return [name, () => node]
  })

  // ---- installation on both globals -------------------------------------------------------
  const jsdomWindow =
    root.jsdom?.window && root.jsdom.window !== root ? root.jsdom.window : undefined
  const targets: object[] = jsdomWindow ? [root, jsdomWindow] : [root]
  type Installed = { target: object; label: string; name: string; descriptor: PropertyDescriptor }
  const installed: Installed[] = []
  const place = (entry: Installed): void => {
    Object.defineProperty(entry.target, entry.name, entry.descriptor)
  }
  const inPlace = (entry: Installed): boolean => {
    const current = Object.getOwnPropertyDescriptor(entry.target, entry.name)
    return !!current && current.get === entry.descriptor.get && current.set === entry.descriptor.set
  }
  for (const target of targets) {
    const label = target === root ? 'globalThis' : 'jsdom window'
    for (const [name, get] of [...pageGuards, ...bridgeGuards]) {
      const entry: Installed = {
        target,
        label,
        name,
        descriptor: {
          // The vitest jsdom environment deletes the keys it copied from the jsdom window when the
          // file ends, so those stay configurable (and are checked after each test); every other
          // guard cannot be redefined at all, so vi.stubGlobal / Object.defineProperty fail loudly.
          configurable: target === root && !!jsdomWindow && name in jsdomWindow,
          enumerable: true,
          get,
          set: () => {
            deny('guard-replaced', `assignment to ${label}.${name}`)
          }
        }
      }
      place(entry)
      installed.push(entry)
    }
  }
  const deniedBeacon = function sendBeacon(url?: unknown): boolean {
    deny('beacon', describe(url))
    return false
  }
  const navigators = new Set<object>()
  for (const target of targets) {
    const candidate = (target as { navigator?: object }).navigator
    if (candidate && typeof candidate === 'object') navigators.add(candidate)
  }
  for (const target of navigators) {
    const entry: Installed = {
      target,
      label: 'navigator',
      name: 'sendBeacon',
      descriptor: {
        configurable: false,
        enumerable: true,
        get: () => deniedBeacon,
        set: () => {
          deny('guard-replaced', 'assignment to navigator.sendBeacon')
        }
      }
    }
    place(entry)
    installed.push(entry)
  }

  // ---- transport level --------------------------------------------------------------------
  const deniedConnect = function connect(this: Socket, ...args: unknown[]): Socket {
    // net.connect() and http hand over one normalised array: [options, callback].
    const [first, second] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args
    const options =
      first && typeof first === 'object'
        ? (first as { host?: unknown; path?: unknown; port?: unknown })
        : undefined
    const where = options
      ? typeof options.path === 'string'
        ? describe(options.path)
        : `${describe(options.host ?? 'localhost')}:${describe(options.port)}`
      : `${typeof second === 'string' ? second : 'localhost'}:${describe(first)}`
    const error = deny('socket', `net.Socket.connect(${where})`)
    process.nextTick(() => this.destroy(error))
    return this
  }
  const deniedListen = function listen(): never {
    throw deny('socket', 'net.Server.listen()')
  }
  // UDP and DNS never start a TCP connection, so they are refused by name.
  const deniedUdp = (method: string) =>
    function (this: unknown, ...args: unknown[]): never {
      const where = args
        .filter((arg) => typeof arg === 'string' || typeof arg === 'number')
        .map((arg) => describe(arg))
        .join(', ')
      throw deny('udp', `dgram.Socket.${method}(${where})`)
    }
  const deniedDns = (name: string, promised: boolean) =>
    function (this: unknown, first?: unknown): Promise<never> {
      const error = deny('dns', `${name}(${describe(first)})`)
      if (promised) return rejected(error)
      throw error
    }
  type Patch = { target: object; key: string; label: string; value: unknown }
  const transportPatches: Patch[] = [
    {
      target: Socket.prototype,
      key: 'connect',
      label: 'net.Socket.prototype.connect',
      value: deniedConnect
    },
    {
      target: Server.prototype,
      key: 'listen',
      label: 'net.Server.prototype.listen',
      value: deniedListen
    },
    ...['bind', 'connect', 'send', 'sendto']
      .filter(
        (key) =>
          typeof (dgram.Socket.prototype as unknown as Record<string, unknown>)[key] === 'function'
      )
      .map((key) => ({
        target: dgram.Socket.prototype,
        key,
        label: `dgram.Socket.prototype.${key}`,
        value: deniedUdp(key)
      }))
  ]
  const DNS_CALL = /^(lookup|lookupService|reverse|resolve\w*)$/
  const dnsTargets: Array<[object | undefined, string, boolean]> = [
    [dns, 'dns', false],
    [dns.Resolver?.prototype, 'dns.Resolver.prototype', false],
    [dns.promises, 'dns.promises', true],
    [dns.promises?.Resolver?.prototype, 'dns.promises.Resolver.prototype', true]
  ]
  for (const [target, label, promised] of dnsTargets) {
    if (!target) continue
    for (const key of Object.getOwnPropertyNames(target)) {
      if (!DNS_CALL.test(key) || typeof (target as Record<string, unknown>)[key] !== 'function')
        continue
      transportPatches.push({
        target,
        key,
        label: `${label}.${key}`,
        value: deniedDns(`${label}.${key}`.replace('.prototype', ''), promised)
      })
    }
  }
  const placeTransport = (): void => {
    let placed = false
    for (const patch of transportPatches) {
      const holder = patch.target as Record<string, unknown>
      if (holder[patch.key] === patch.value) continue
      holder[patch.key] = patch.value
      placed = true
    }
    // `import { lookup } from 'node:dns'` binds the export, not the property: refresh the exports.
    if (placed) syncBuiltinESMExports()
  }
  placeTransport()

  const mergeAllowance = (
    into: ChannelBridgeAllowance,
    from: ChannelBridgeAllowance
  ): ChannelBridgeAllowance => {
    for (const [key, value] of Object.entries(from)) {
      const existing = into[key]
      into[key] =
        value && typeof value === 'object' && existing && typeof existing === 'object'
          ? mergeAllowance({ ...existing }, value)
          : value && typeof value === 'object'
            ? mergeAllowance({}, value)
            : value
    }
    return into
  }

  return {
    deniedAttempts: () => denied.slice(),
    takeDeniedAttempts: () => {
      const taken = denied
      if (dropped) {
        taken.push({
          kind: taken[taken.length - 1].kind,
          detail: `... and ${dropped} more refusal(s) that were counted but not kept`,
          test: '',
          stack: ''
        })
      }
      denied = []
      dropped = 0
      return taken
    },
    deniedAttemptCount: () => denied.length + dropped,
    totalDeniedAttempts: () => total,
    allowInMemoryIndexedDb: (fake) => {
      if (!fake || typeof (fake as { open?: unknown }).open !== 'function') {
        throw new Error('allowChannelInMemoryIndexedDb needs an in-memory IDBFactory fake.')
      }
      // One allowance at a time: what an earlier one opened is refused from here on.
      endIndexedDbAllowance()
      const allowance = { ended: false, factory: {} as object }
      allowance.factory = guardIndexedDbHandle(fake, allowance, 'indexedDB', (method, result) =>
        method === 'open' ? guardIndexedDbOpenRequest(result, allowance) : result
      )
      indexedDbAllowance = allowance
    },
    allowBridge: (name, allowance) => {
      if (!CHANNEL_BRIDGE_ROOTS.includes(name)) throw new Error(`Unknown bridge: ${String(name)}`)
      bridgeAllowances.set(
        name,
        mergeAllowance({ ...(bridgeAllowances.get(name) ?? {}) }, allowance)
      )
    },
    resetAllowances: () => {
      endIndexedDbAllowance()
      bridgeAllowances.clear()
    },
    repairReplacedGuards: () => {
      const replaced: string[] = []
      for (const entry of installed) {
        if (inPlace(entry)) continue
        replaced.push(`${entry.label}.${entry.name}`)
        try {
          place(entry)
        } catch {
          // A guard that cannot be put back keeps being reported after every test.
        }
      }
      for (const patch of transportPatches) {
        if ((patch.target as Record<string, unknown>)[patch.key] !== patch.value)
          replaced.push(patch.label)
      }
      placeTransport()
      return replaced
    },
    guardedGlobals: () => targets.slice()
  }
}

// One installation per global object: a second evaluation of this module (vi.resetModules(), a
// dynamic import, a second module graph) shares the guards and the counter of the first.
const registry = globalThis as GuardedGlobal
const guards: ChannelDenyGuards = registry[REGISTRY_KEY] ?? installChannelDenyGuards()
if (!registry[REGISTRY_KEY]) {
  Object.defineProperty(registry, REGISTRY_KEY, {
    value: guards,
    configurable: false,
    writable: false
  })
}

/** True when the guards are installed on this global (used by tests that must not run without them). */
export const channelDenyGuardsInstalled = (): boolean =>
  (globalThis as GuardedGlobal)[REGISTRY_KEY] === guards

/** Refusals since the last test boundary (or since the last take). */
export const channelDeniedAttempts = (): readonly ChannelDeniedAttempt[] => guards.deniedAttempts()
/** Returns the refusals and clears them: for a test that refuses something on purpose. */
export const takeChannelDeniedAttempts = (): ChannelDeniedAttempt[] => guards.takeDeniedAttempts()
/** Number of refusals since the last test boundary (or take), also those kept without a stack. */
export const channelDeniedAttemptCount = (): number => guards.deniedAttemptCount()
/** Refusals since the guards were installed; never reset. */
export const totalChannelDeniedAttempts = (): number => guards.totalDeniedAttempts()
/**
 * Lets the page use an in-memory IndexedDB fake until the end of the running test, or until the
 * test calls this again (a restart: the databases and transactions opened so far are refused
 * from then on, also when the same fake is allowed again).
 */
export const allowChannelInMemoryIndexedDb = (fake: unknown): void =>
  guards.allowInMemoryIndexedDb(fake)
/** Lists bridge members the page may call until the end of the running test; calls merge. */
export const allowChannelBridge = (
  root: ChannelBridgeRoot,
  allowance: ChannelBridgeAllowance
): void => guards.allowBridge(root, allowance)
/** The global objects that carry the page-level and bridge-level guards. */
export const channelGuardedGlobals = (): readonly object[] => guards.guardedGlobals()
/** Names of guards that were replaced since the last check; each one is put back. */
export const repairReplacedChannelGuards = (): string[] => guards.repairReplacedGuards()

const formatAttempts = (attempts: readonly ChannelDeniedAttempt[]): string =>
  attempts
    .map(
      (attempt, index) =>
        `${index + 1}. ${attempt.kind}: ${attempt.detail}${attempt.test ? ` (during "${attempt.test}")` : ''}\n${attempt.stack}`
    )
    .join('\n')

/**
 * The end-of-test check: fails when something was refused or a guard was replaced. It always
 * clears the counter and puts replaced guards back, so one failure does not spill into the next
 * test.
 */
export function assertNoChannelDeniedAttempts(when = 'during the test'): void {
  const count = guards.deniedAttemptCount()
  const attempts = guards.takeDeniedAttempts()
  const replaced = guards.repairReplacedGuards()
  const problems: string[] = []
  if (replaced.length)
    problems.push(`Channel deny guards were replaced ${when}: ${replaced.join(', ')}`)
  if (attempts.length) {
    problems.push(`${count} denied attempt(s) ${when}:\n${formatAttempts(attempts)}`)
  }
  if (problems.length) throw new Error(problems.join('\n'))
}

const insideRunningTest = (): boolean => {
  try {
    return Boolean(expect.getState().currentTestName)
  } catch {
    return false
  }
}

// Registered on every evaluation as a setup file (vitest runs afterEach hooks in reverse order of
// registration, so this one runs after the hooks of the test file and after Testing Library's
// unmount). A re-import from inside a test only shares the guards.
if (!insideRunningTest()) {
  afterEach(() => {
    try {
      assertNoChannelDeniedAttempts()
    } finally {
      guards.resetAllowances()
    }
  })
  afterAll(() => {
    try {
      assertNoChannelDeniedAttempts('after the last test of the file')
    } finally {
      guards.resetAllowances()
    }
  })
}
