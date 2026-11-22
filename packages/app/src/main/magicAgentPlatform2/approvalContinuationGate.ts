import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A caller-owned check for one tool start: it runs after a formal approval of that tool resolves and before the
 * approved effect. It can only refuse to continue (for example a team member whose team ended while the user was
 * deciding); it never grants or widens anything.
 */
const continuationCheck = new AsyncLocalStorage<() => void>()

/**
 * Runs one tool start with `check`. Without a check, a check inherited from an enclosing tool run is cleared, so work
 * started inside a member's tool run never carries that member's check into an unrelated request's approval.
 */
export function runWithApprovalContinuationCheck<T>(
  check: (() => void) | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return check ? continuationCheck.run(check, operation) : continuationCheck.exit(operation)
}

const refusals = new WeakSet<object>()

/** Called right after an approval resolves. Throws the caller's error when its check refuses; a no-op otherwise. */
export function assertApprovalContinuationAllowed(): void {
  const check = continuationCheck.getStore()
  if (!check) return
  try {
    check()
  } catch (error) {
    if (typeof error === 'object' && error !== null) refusals.add(error)
    throw error
  }
}

/** True for the exact error a continuation check threw: wrappers pass it on unchanged instead of a generic failure. */
export function isApprovalContinuationRefusal(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && refusals.has(error)
}
