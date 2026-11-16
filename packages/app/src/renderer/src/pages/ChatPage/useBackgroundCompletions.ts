import { useEffect, useRef } from 'react'

/**
 * Calls `onFinish` once for each item that this page saw running and then sees finished, in the
 * lists the page already reads (no reading of its own). Items that were already finished when
 * first seen and everything of an earlier scope are ignored. An item that is missing from one
 * list (a list that is briefly empty) is still remembered as running.
 */
export function useBackgroundCompletions<T>(
  scope: string | null,
  items: readonly T[],
  idOf: (item: T) => string,
  isFinished: (item: T) => boolean,
  onFinish: (item: T) => void
): void {
  const seen = useRef<{ scope: string | null; running: Set<string> }>({
    scope: null,
    running: new Set()
  })
  const latest = useRef({ idOf, isFinished, onFinish })
  latest.current = { idOf, isFinished, onFinish }
  useEffect(() => {
    const { idOf: id, isFinished: finished, onFinish: finish } = latest.current
    if (seen.current.scope !== scope) seen.current = { scope, running: new Set() }
    if (!scope) return
    const running = seen.current.running
    for (const item of items) {
      const key = id(item)
      if (!finished(item)) running.add(key)
      else if (running.delete(key)) finish(item)
    }
  }, [scope, items])
}
