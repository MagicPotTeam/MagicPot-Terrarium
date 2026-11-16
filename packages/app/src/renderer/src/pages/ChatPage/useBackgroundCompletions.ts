import { useEffect, useRef } from 'react'

/**
 * Calls `onFinish` once for each item of the lists the page already reads (no reading of its own)
 * that finishes while the page shows its scope: one this page saw running and then sees finished,
 * or, with `finishedAt`, one first seen already finished that finished after the page began to
 * show the scope (a short job that ran between two reads of the list). Items that had finished
 * before and everything of an earlier scope are ignored. An item that is missing from one list
 * (a list that is briefly empty) is still remembered as running.
 */
export function useBackgroundCompletions<T>(
  scope: string | null,
  items: readonly T[],
  idOf: (item: T) => string,
  isFinished: (item: T) => boolean,
  onFinish: (item: T) => void,
  finishedAt?: (item: T) => number | undefined
): void {
  const seen = useRef<{ scope: string | null; since: number; running: Set<string>; done: Set<string> }>({
    scope: null,
    since: 0,
    running: new Set(),
    done: new Set()
  })
  const latest = useRef({ idOf, isFinished, onFinish, finishedAt })
  latest.current = { idOf, isFinished, onFinish, finishedAt }
  useEffect(() => {
    const { idOf: id, isFinished: finished, onFinish: finish, finishedAt: endOf } = latest.current
    if (seen.current.scope !== scope) {
      seen.current = { scope, since: Date.now(), running: new Set(), done: new Set() }
    }
    if (!scope) return
    const { since, running, done } = seen.current
    for (const item of items) {
      const key = id(item)
      if (!finished(item)) {
        running.add(key)
        continue
      }
      if (done.has(key)) continue
      done.add(key)
      const end = endOf?.(item)
      if (running.delete(key) || (end !== undefined && end >= since)) finish(item)
    }
  }, [scope, items])
}
