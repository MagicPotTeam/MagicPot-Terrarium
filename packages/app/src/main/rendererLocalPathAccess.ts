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
 * scoped-path IPC, the thumbnail service). It never queues: a call is run at once or refused at
 * once, and each check costs O(path length), whatever is in flight. A filesystem call that
 * never returns holds one of libuv's threadpool threads whatever main does, so a place that
 * stops answering must not get more of them:
 * - a call still pending after `slowMs` (or its deadline, if sooner) marks its folder as not
 *   answering; while it is pending, no new call is made inside the closest folder that holds
 *   every such call of its root (see importSourceRootKey). The folder grows towards the mount
 *   that stopped answering as more of its calls stall, while the rest of the root (on macOS
 *   all of /Users: the app's data, the pictures, a cloud folder) keeps working;
 * - no root ever has more than `maxInFlight` calls in flight (a healthy disk answers within
 *   microseconds, so a board or a chat that asks for hundreds of images at once is never
 *   refused).
 */
export type LocalPathBreaker = {
  /**
   * The operation's value, or null when it was refused, rejected or passed `timeoutMs` (it then
   * keeps counting against its folder until it really returns).
   */
  run<T>(
    filePath: string,
    operation: () => Promise<T>,
    timeoutMs: number
  ): Promise<{ value: T } | null>
}

export const LOCAL_PATH_BREAKER_MAX_IN_FLIGHT_PER_ROOT = 2048
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

export function createLocalPathBreaker({
  maxInFlight = LOCAL_PATH_BREAKER_MAX_IN_FLIGHT_PER_ROOT,
  slowMs = LOCAL_PATH_BREAKER_SLOW_MS
}: { maxInFlight?: number; slowMs?: number } = {}): LocalPathBreaker {
  /** `slow`: the folders of the calls still pending after slowMs; `closed`: what holds them. */
  type RootState = { inFlight: number; slow: string[]; closed: string | null }
  const roots = new Map<string, RootState>()
  const close = (state: RootState): void => {
    state.closed = state.slow.length > 0 ? state.slow.reduce(commonFolder) : null
  }
  const run = <T>(
    filePath: string,
    operation: () => Promise<T>,
    timeoutMs: number
  ): Promise<{ value: T } | null> => {
    const key = importSourceRootKey(filePath)
    const resolved = path.resolve(String(filePath || ''))
    const known = roots.get(key)
    if (
      known &&
      (known.inFlight >= maxInFlight ||
        (known.closed !== null && isSameOrInsideFolder(known.closed, resolved)))
    ) {
      return Promise.resolve(null)
    }
    const state = known ?? { inFlight: 0, slow: [], closed: null }
    if (!known) roots.set(key, state)
    state.inFlight += 1
    const folder = path.dirname(resolved)
    const deadline = Math.max(0, timeoutMs)
    const slowAfter = Math.min(Math.max(0, slowMs), deadline)
    return new Promise((resolve) => {
      let slow = false
      let late = false
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined
      const slowTimer = setTimeout(() => {
        slow = true
        state.slow.push(folder)
        close(state)
        deadlineTimer = setTimeout(() => {
          late = true
          resolve(null)
        }, deadline - slowAfter)
        deadlineTimer.unref?.()
      }, slowAfter)
      slowTimer.unref?.()
      // The call returned: its folder answers again. A late value is dropped (null was answered).
      const finish = (result: { value: T } | null): void => {
        clearTimeout(slowTimer)
        clearTimeout(deadlineTimer)
        state.inFlight -= 1
        if (slow) {
          state.slow.splice(state.slow.indexOf(folder), 1)
          close(state)
        }
        if (state.inFlight <= 0 && roots.get(key) === state) roots.delete(key)
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
