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

export type RendererLocalPathAuthorizationOptions = LocalMediaPathAuthorizationOptions & {
  /**
   * The gate (default: rendererLocalPathGate), or null for none. A path the canvas names once
   * per image (the scoped-path check, the thumbnail service) runs with its deadline only: the
   * gate has a few slots and scans its whole queue each time one frees, so thousands of image
   * calls queued behind it would cost main seconds of work.
   */
  gate?: ImportSourceGate | null
  timeoutMs?: number
}

/** The promise's value, or `fallback` once it rejects or `timeoutMs` passes. */
function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), Math.max(0, timeoutMs))
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

const UNAVAILABLE: LocalMediaPathAuthorization = { canonicalPath: null, reason: 'unavailable' }

/**
 * Whether a path the renderer named may be read, and its canonical path: when the user granted
 * it or it is under one of `roots`. A refusal says why (see LocalMediaPathRefusalReason): a call
 * that did not answer within the deadline, or that the gate or the breaker refused, is
 * 'unavailable', never 'missing'. Nothing runs on main's event loop: Windows network spellings
 * are refused before any filesystem call (unless granted, or inside a network root with
 * allowNetworkRoots), and every realpath runs on the threadpool, under the import-source
 * deadline (and the gate, unless `gate` is null).
 */
export async function checkRendererLocalPath(
  filePath: string,
  roots: readonly LocalMediaRoot[],
  {
    gate = rendererLocalPathGate,
    timeoutMs = DEFAULT_IMPORT_SOURCE_GUARD.operationTimeoutMs,
    ...options
  }: RendererLocalPathAuthorizationOptions = {}
): Promise<LocalMediaPathAuthorization> {
  if (typeof filePath !== 'string') return { canonicalPath: null, reason: 'refused' }
  const authorize = () => authorizeLocalMediaPathAsync(filePath, roots, options)
  if (gate === null) {
    return settleWithin(Promise.resolve().then(authorize), timeoutMs, UNAVAILABLE)
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
