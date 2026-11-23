import fs from 'node:fs/promises'

// Windows briefly holds freshly written files and directories open (antivirus, indexing),
// which makes a rename fail with one of these codes even though nothing is wrong.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
// Exponential backoff, about 0.8 s in total before the original error is rethrown.
const DEFAULT_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const

export type TransientRenameOptions = {
  /** Never wait past this time; the last error is rethrown instead. */
  deadlineAt?: number
  delaysMs?: readonly number[]
  rename?: (from: string, to: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const isTransientRenameError = (error: unknown): boolean =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  typeof error.code === 'string' &&
  TRANSIENT_RENAME_CODES.has(error.code)

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Retries the same rename only on transient Windows sharing errors, with a bounded backoff.
 * The rename itself is unchanged: callers keep every safety check they run beforehand, and
 * any other error, or the last transient one, is thrown unchanged.
 */
export async function renameWithTransientRetry(
  from: string,
  to: string,
  options: TransientRenameOptions = {}
): Promise<void> {
  const rename = options.rename ?? ((source: string, target: string) => fs.rename(source, target))
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const deadlineAt = options.deadlineAt ?? Number.MAX_SAFE_INTEGER
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const delay = delays[attempt]
      if (!isTransientRenameError(error) || delay === undefined || now() + delay >= deadlineAt)
        throw error
      await sleep(delay)
    }
  }
}
