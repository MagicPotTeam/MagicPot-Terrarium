import { useSyncExternalStore } from 'react'

/**
 * Bound reports that MAIN refused at the last verification in this window (deleted or edited
 * files, another conversation, an evicted record). Their cards are shown unavailable like an
 * unbound report. Memory only and never persisted: the stored binding is kept, so a report on a
 * drive that was only unreachable verifies again later, and its card recovers then.
 */
const refusedBindings = new Set<string>()
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

/** Records MAIN's per-binding verify results: 'refused' marks a report, 'verified' clears it. */
export function noteReportBundleVerifyResults(
  results: ReadonlyArray<{ binding?: unknown; status?: unknown }>
): void {
  let changed = false
  for (const result of results) {
    if (typeof result?.binding !== 'string') continue
    if (result.status === 'refused' && !refusedBindings.has(result.binding)) {
      refusedBindings.add(result.binding)
      changed = true
    } else if (result.status === 'verified' && refusedBindings.delete(result.binding)) {
      changed = true
    }
  }
  if (changed) emit()
}

export function isReportBundleBindingRefused(binding: unknown): boolean {
  return typeof binding === 'string' && refusedBindings.has(binding)
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True while MAIN's last verification in this window refused this binding. */
export function useReportBundleBindingRefused(binding: unknown): boolean {
  return useSyncExternalStore(subscribe, () => isReportBundleBindingRefused(binding))
}

export function clearReportBundleRefusalsForTest(): void {
  refusedBindings.clear()
  emit()
}
