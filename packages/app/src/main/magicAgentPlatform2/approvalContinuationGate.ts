import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A caller-owned check for one tool start: it runs after a formal approval of that tool resolves and before the
 * approved effect. It can only refuse to continue (for example a team member whose team ended while the user was
 * deciding); it never grants or widens anything.
 */
const continuationCheck = new AsyncLocalStorage<() => void>()

/** Runs one tool start with `check` (none: the operation runs exactly as before). */
export function runWithApprovalContinuationCheck<T>(
  check: (() => void) | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return check ? continuationCheck.run(check, operation) : operation()
}

/** Called right after an approval resolves. Throws the caller's error when its check refuses; a no-op otherwise. */
export function assertApprovalContinuationAllowed(): void {
  continuationCheck.getStore()?.()
}
