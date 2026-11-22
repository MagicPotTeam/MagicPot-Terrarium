// Imports into managed media whose reference is not stored yet. The chat page's save guard and
// its stored image migration import an image first and write the reference into the stored
// conversation after; until that write the reference scanner cannot see it. The scanner treats
// such a window like a running chat request: it withdraws the last snapshot when the window opens
// and starts no scan before it closes, so main never cleans up from a snapshot taken before the
// reference was written. (Main also keeps a freshly imported or reused file for its retention
// time; this closes the window from the renderer's side.)

/** Dispatched on window whenever the first window opens or the last one closes. */
export const MANAGED_MEDIA_UNWRITTEN_IMPORTS_EVENT = 'managed-media:unwritten-imports'

let openWindows = 0

const announce = (): void => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(MANAGED_MEDIA_UNWRITTEN_IMPORTS_EVENT))
}

/**
 * Opens a window in which managed references are imported but not yet stored. The returned
 * function closes it (once; later calls do nothing). Close it in a `finally`.
 */
export function beginUnwrittenManagedMediaImports(): () => void {
  openWindows += 1
  if (openWindows === 1) announce()
  let closed = false
  return () => {
    if (closed) return
    closed = true
    openWindows -= 1
    if (openWindows === 0) announce()
  }
}

/** Whether an import whose reference is not stored yet is open in this window. */
export const hasUnwrittenManagedMediaImports = (): boolean => openWindows > 0
