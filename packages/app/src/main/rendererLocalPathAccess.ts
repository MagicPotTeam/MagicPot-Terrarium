import * as path from 'path'
import {
  createImportSourceGate,
  DEFAULT_IMPORT_SOURCE_GUARD,
  importSourceRootKey,
  runImportSourceOperation,
  type ImportSourceGate
} from './llmProxy/managedMediaStore'
import {
  authorizeLocalMediaPathAsync,
  type LocalMediaPathAuthorization,
  type LocalMediaPathAuthorizationOptions,
  type LocalMediaRoot
} from './localMediaAccess'

/**
 * The gate of the svcFs reads of paths the renderer names. It is apart from the import gate,
 * so a canvas save never waits behind a chat import's copy, and a share that stopped answering
 * holds at most this gate's slots: a path there that is already overdue is refused at once.
 */
export const rendererLocalPathGate: ImportSourceGate = createImportSourceGate({
  onSaturated: () =>
    console.warn(
      '[LocalMedia] Every renderer path slot is held by a call past its deadline; renderer reads are refused until one returns'
    )
})

/**
 * A breaker for the path checks the renderer asks once per image (the local-media protocol, the
 * scoped-path IPC, the thumbnail service). A filesystem call that never returns holds one of
 * libuv's four threadpool threads whatever main does, and libuv runs queued calls in order
 * without cancelling any, so a place that stops answering must not get more of them:
 * - at most `maxInFlight` calls run at once (default 3, below the threadpool size, slow ones
 *   included): a call only shows it is slow once it has held its thread for `slowMs`, so a burst
 *   (a board of a thousand images on a share that went offline) never takes every thread, and a
 *   call the breaker starts never waits in libuv behind another of its calls;
 * - at most `maxInFlightPerRoot` calls run at once on one root (see importSourceRootKey) that
 *   are not slow; the others wait in that root's FIFO (bounded in length and in waiting time,
 *   then refused). A call waiting there has no clock running: a healthy image queued behind a
 *   dead mount is never counted as slow;
 * - a call still pending `slowMs` after it started (or at its deadline, if sooner) marks where it
 *   stalled as not answering, and no new call is made there until it returns: its folder, or
 *   the closest folder that holds every stalled call of its root. That folder never reaches the
 *   root of a local drive or a first directory (/Users, /home), nor a folder directly in one
 *   (a home folder): a stall there closes only the stalled file, so one link to a dead mount in
 *   a home folder never closes the home folder, the app's data or the pictures in it. The root
 *   of a mount (a share, /Volumes/<name>, /media/<user>/<name>) can close as a whole.
 * Each call costs O(path length) to admit; queued calls are started or refused in O(1).
 */
export type LocalPathBreaker = {
  /**
   * The operation's value, or null when it was refused, waited too long, rejected or passed
   * `timeoutMs` after it started (it then keeps counting until it really returns).
   */
  run<T>(
    filePath: string,
    operation: () => Promise<T>,
    timeoutMs: number
  ): Promise<{ value: T } | null>
}

export type LocalPathBreakerOptions = {
  /** Calls running at once in all, slow ones included (below libuv's threadpool size). */
  maxInFlight?: number
  /** Calls running at once on one root that are not slow. */
  maxInFlightPerRoot?: number
  /** Calls waiting on one root; more are refused at once. */
  maxQueuedPerRoot?: number
  /** Calls waiting in all; more are refused at once. */
  maxQueued?: number
  /** How long a call may wait for its turn before it is refused. */
  maxWaitMs?: number
  /** How long a running call may take before its place counts as not answering. */
  slowMs?: number
}

/** libuv's default threadpool size; UV_THREADPOOL_SIZE is not set for main. */
export const LIBUV_THREADPOOL_SIZE = 4
export const LOCAL_PATH_BREAKER_MAX_IN_FLIGHT = LIBUV_THREADPOOL_SIZE - 1
export const LOCAL_PATH_BREAKER_MAX_IN_FLIGHT_PER_ROOT = 2
export const LOCAL_PATH_BREAKER_MAX_QUEUED_PER_ROOT = 2048
export const LOCAL_PATH_BREAKER_MAX_QUEUED = 8192
export const LOCAL_PATH_BREAKER_MAX_WAIT_MS = 10_000
export const LOCAL_PATH_BREAKER_SLOW_MS = 2_000

const comparablePath = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value

function isSameOrInsideFolder(folder: string, candidate: string): boolean {
  const relative = path.relative(comparablePath(folder), comparablePath(candidate))
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

/** The closest folder that holds both. */
function commonFolder(left: string, right: string): string {
  let folder = left
  while (!isSameOrInsideFolder(folder, right)) {
    const parent = path.dirname(folder)
    if (parent === folder) return folder
    folder = parent
  }
  return folder
}

const segmentCount = (value: string): number => value.split(/[\\/]+/u).filter(Boolean).length

/** Segments of a resolved path, its root's included (a drive: 1, a UNC share: 2). */
const pathDepth = (value: string): number => segmentCount(value)

/**
 * The fewest segments a closed folder of the root `key` may have: the mount itself for a share
 * or a mount under a mount parent; for a drive letter or a first directory (/Users), a folder
 * two levels below it (C:\Users\x, /Users/x/Pictures), so that a home folder never closes.
 */
function minClosedDepth(key: string): number {
  const depth = segmentCount(key)
  const isMount = key.startsWith('//') || (key.startsWith('/') && depth >= 2)
  return isMount ? depth : depth + 2
}

type BreakerWaiter = {
  root: BreakerRoot
  resolved: string
  start: () => void
  refuse: () => void
  timer: ReturnType<typeof setTimeout> | undefined
  previous: BreakerWaiter | null
  next: BreakerWaiter | null
}

type BreakerRoot = {
  key: string
  minDepth: number
  /** Running calls that are not slow. */
  running: number
  /** The resolved paths of the calls still pending past slowMs. */
  slow: string[]
  /** What no new call may enter: folders, or single files (see minClosedDepth). */
  closed: string[]
  head: BreakerWaiter | null
  tail: BreakerWaiter | null
  waiting: number
  /** In the breaker's ready list: it has waiting calls and a free slot of its own. */
  ready: boolean
}

export function createLocalPathBreaker({
  maxInFlight = LOCAL_PATH_BREAKER_MAX_IN_FLIGHT,
  maxInFlightPerRoot = LOCAL_PATH_BREAKER_MAX_IN_FLIGHT_PER_ROOT,
  maxQueuedPerRoot = LOCAL_PATH_BREAKER_MAX_QUEUED_PER_ROOT,
  maxQueued = LOCAL_PATH_BREAKER_MAX_QUEUED,
  maxWaitMs = LOCAL_PATH_BREAKER_MAX_WAIT_MS,
  slowMs = LOCAL_PATH_BREAKER_SLOW_MS
}: LocalPathBreakerOptions = {}): LocalPathBreaker {
  const totalLimit = Math.max(1, Math.floor(maxInFlight))
  const rootLimit = Math.max(1, Math.floor(maxInFlightPerRoot))
  const roots = new Map<string, BreakerRoot>()
  /** Roots with a waiting call and a free slot of their own, served in turn (insertion order). */
  const ready = new Set<BreakerRoot>()
  let inFlight = 0
  let queued = 0

  const isClosed = (root: BreakerRoot, resolved: string): boolean =>
    root.closed.some((place) => isSameOrInsideFolder(place, resolved))

  // Where the slow calls of a root stalled: each one's folder (or the file itself when its folder
  // is too shallow), merged into their closest common folder when that is deep enough. At most
  // maxInFlight calls are slow, so this costs O(path length).
  const close = (root: BreakerRoot): void => {
    const places = root.slow.map((resolved) => {
      const folder = path.dirname(resolved)
      return pathDepth(folder) >= root.minDepth ? folder : resolved
    })
    for (let merged = true; merged;) {
      merged = false
      for (let left = 0; left < places.length && !merged; left += 1) {
        for (let right = left + 1; right < places.length && !merged; right += 1) {
          const common = commonFolder(places[left], places[right])
          if (pathDepth(common) >= root.minDepth) {
            places.splice(right, 1)
            places[left] = common
            merged = true
          }
        }
      }
    }
    root.closed = places
  }

  const forget = (root: BreakerRoot): void => {
    if (root.running === 0 && root.slow.length === 0 && root.waiting === 0) {
      ready.delete(root)
      if (roots.get(root.key) === root) roots.delete(root.key)
    }
  }

  const markReady = (root: BreakerRoot): void => {
    if (root.waiting > 0 && root.running < rootLimit && !root.ready) {
      root.ready = true
      ready.add(root)
    }
  }

  const unlink = (waiter: BreakerWaiter): void => {
    const { root } = waiter
    if (waiter.previous) waiter.previous.next = waiter.next
    else root.head = waiter.next
    if (waiter.next) waiter.next.previous = waiter.previous
    else root.tail = waiter.previous
    waiter.previous = null
    waiter.next = null
    clearTimeout(waiter.timer)
    root.waiting -= 1
    queued -= 1
  }

  // Starts waiting calls while there is a slot: each root with a free slot of its own in turn,
  // its calls in order. A waiting call inside a place that closed since it came is refused.
  const pump = (): void => {
    while (inFlight < totalLimit && ready.size > 0) {
      const root = ready.values().next().value as BreakerRoot
      ready.delete(root)
      root.ready = false
      let waiter = root.head
      while (waiter && isClosed(root, waiter.resolved)) {
        unlink(waiter)
        waiter.refuse()
        waiter = root.head
      }
      if (waiter && root.running < rootLimit) {
        unlink(waiter)
        waiter.start()
      }
      markReady(root)
      forget(root)
    }
  }

  const begin = <T>(
    root: BreakerRoot,
    resolved: string,
    operation: () => Promise<T>,
    timeoutMs: number,
    resolve: (result: { value: T } | null) => void
  ): void => {
    inFlight += 1
    root.running += 1
    const deadline = Math.max(0, timeoutMs)
    let slow = false
    let late = false
    // Both clocks start now, when the call gets its thread, never while it waited.
    const slowTimer = setTimeout(
      () => {
        slow = true
        root.running -= 1
        root.slow.push(resolved)
        close(root)
        // Its root's slot is free for calls elsewhere on it; the thread it holds still counts.
        markReady(root)
        pump()
      },
      Math.min(Math.max(0, slowMs), deadline)
    )
    slowTimer.unref?.()
    const deadlineTimer = setTimeout(() => {
      late = true
      resolve(null)
    }, deadline)
    deadlineTimer.unref?.()
    // The call returned: where it stalled answers again. A late value is dropped (null was
    // answered).
    const finish = (result: { value: T } | null): void => {
      clearTimeout(slowTimer)
      clearTimeout(deadlineTimer)
      inFlight -= 1
      if (slow) {
        root.slow.splice(root.slow.indexOf(resolved), 1)
        close(root)
      } else {
        root.running -= 1
      }
      markReady(root)
      forget(root)
      pump()
      if (!late) resolve(result)
    }
    let pending: Promise<T>
    try {
      pending = Promise.resolve(operation())
    } catch (error) {
      pending = Promise.reject(error)
    }
    pending.then(
      (value) => finish({ value }),
      () => finish(null)
    )
  }

  const run = <T>(
    filePath: string,
    operation: () => Promise<T>,
    timeoutMs: number
  ): Promise<{ value: T } | null> => {
    const key = importSourceRootKey(filePath)
    const resolved = path.resolve(String(filePath || ''))
    let root = roots.get(key)
    if (root && isClosed(root, resolved)) return Promise.resolve(null)
    if (!root) {
      root = {
        key,
        minDepth: minClosedDepth(key),
        running: 0,
        slow: [],
        closed: [],
        head: null,
        tail: null,
        waiting: 0,
        ready: false
      }
      roots.set(key, root)
    }
    const current = root
    return new Promise((resolve) => {
      // Its turn now: nothing of its root waits before it, and there is a slot.
      if (current.waiting === 0 && current.running < rootLimit && inFlight < totalLimit) {
        begin(current, resolved, operation, timeoutMs, resolve)
        return
      }
      if (current.waiting >= maxQueuedPerRoot || queued >= maxQueued) {
        forget(current)
        resolve(null)
        return
      }
      const waiter: BreakerWaiter = {
        root: current,
        resolved,
        start: () => begin(current, resolved, operation, timeoutMs, resolve),
        refuse: () => resolve(null),
        timer: undefined,
        previous: current.tail,
        next: null
      }
      if (current.tail) current.tail.next = waiter
      else current.head = waiter
      current.tail = waiter
      current.waiting += 1
      queued += 1
      // Waited too long for its turn: refused, so the page can try again later.
      waiter.timer = setTimeout(
        () => {
          unlink(waiter)
          forget(current)
          resolve(null)
        },
        Math.max(0, maxWaitMs)
      )
      waiter.timer.unref?.()
      markReady(current)
    })
  }
  return { run }
}

/**
 * The breaker shared by every per-image path check of main: they all use the same threadpool,
 * so a root that one of them found unresponsive is spared by the others too.
 */
export const perImageLocalPathBreaker: LocalPathBreaker = createLocalPathBreaker()

export type RendererLocalPathAuthorizationOptions = LocalMediaPathAuthorizationOptions & {
  /**
   * The gate (default: rendererLocalPathGate), or null for a check the renderer asks once per
   * image (the scoped-path check, the thumbnail service, the local-media protocol): the gate
   * has a few slots and scans its whole queue each time one frees, so thousands of image calls
   * queued behind it would cost main seconds of work. Those run under `breaker` instead.
   */
  gate?: ImportSourceGate | null
  /** The breaker of the calls without a gate (default: perImageLocalPathBreaker). */
  breaker?: LocalPathBreaker
  timeoutMs?: number
}

const UNAVAILABLE: LocalMediaPathAuthorization = { canonicalPath: null, reason: 'unavailable' }

/**
 * Whether a path the renderer named may be read, and its canonical path: when the user granted
 * it or it is under one of `roots`. A refusal says why (see LocalMediaPathRefusalReason): a call
 * that did not answer within the deadline, or that the gate or the breaker refused, is
 * 'unavailable', never 'missing'. Nothing runs on main's event loop: Windows network spellings
 * are refused before any filesystem call (unless granted, or inside a network root with
 * allowNetworkRoots), and every realpath runs on the threadpool, under the import-source
 * deadline and the gate (or, with `gate: null`, the breaker).
 */
export async function checkRendererLocalPath(
  filePath: string,
  roots: readonly LocalMediaRoot[],
  {
    gate = rendererLocalPathGate,
    breaker = perImageLocalPathBreaker,
    timeoutMs = DEFAULT_IMPORT_SOURCE_GUARD.operationTimeoutMs,
    ...options
  }: RendererLocalPathAuthorizationOptions = {}
): Promise<LocalMediaPathAuthorization> {
  if (typeof filePath !== 'string') return { canonicalPath: null, reason: 'refused' }
  const authorize = () => authorizeLocalMediaPathAsync(filePath, roots, options)
  if (gate === null) {
    const result = await breaker.run(filePath, authorize, timeoutMs)
    return result?.value ?? UNAVAILABLE
  }
  try {
    return await runImportSourceOperation(authorize, {
      key: importSourceRootKey(filePath),
      file: filePath,
      timeoutMs,
      gate
    })
  } catch {
    return UNAVAILABLE
  }
}

/** checkRendererLocalPath without the reason: the canonical path, or null. */
export async function authorizeRendererLocalPath(
  filePath: string,
  roots: readonly LocalMediaRoot[],
  options: RendererLocalPathAuthorizationOptions = {}
): Promise<string | null> {
  return (await checkRendererLocalPath(filePath, roots, options)).canonicalPath
}
