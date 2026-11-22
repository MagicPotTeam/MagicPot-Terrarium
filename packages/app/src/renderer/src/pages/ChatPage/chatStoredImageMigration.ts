// Background migration of the inline images an open pane's stored conversations still hold
// (FIX-PLAN item 4, part 2). One conversation at a time, in idle time: an attempt never starts
// while a reply runs or the user is typing, and once started it holds up no save. Each
// conversation is tried a bounded number of times per start: a failure leaves its record as it
// was and it is tried again at the next start, never in a loop.

/** What one migration attempt of one conversation came to. */
export type StoredImageMigrationOutcome =
  /** Written: the record now references managed media. */
  | 'migrated'
  /** Nothing to migrate. */
  | 'unchanged'
  /** The conversation was in use (unsaved changes, a save or another migration running). */
  | 'busy'
  /** The stored record was not the one this page expects, or changed meanwhile: not written. */
  | 'not-written'
  /** An import or the write failed; the record is untouched. */
  | 'failed'
  /** The conversation is no longer in the pane. */
  | 'gone'

export type StoredImageMigrationTiming = {
  /** Wait after the pane opened before the first look, so opening is not slowed down. */
  startDelayMs: number
  /** requestIdleCallback timeout: the longest an attempt waits for an idle period. */
  idleTimeoutMs: number
  /** How soon to look again while paused (reply running, typing). */
  pauseRetryMs: number
  /** How soon to try a conversation again that was busy or not written. */
  busyRetryMs: number
  /** Attempts per conversation per start, for busy and not-written outcomes. */
  maxAttemptsPerSession: number
}

export const STORED_IMAGE_MIGRATION_TIMING: StoredImageMigrationTiming = {
  startDelayMs: 2_000,
  idleTimeoutMs: 5_000,
  pauseRetryMs: 3_000,
  busyRetryMs: 10_000,
  maxAttemptsPerSession: 3
}

/**
 * Longest one image's import may take in an attempt; the image then stays inline. The imports
 * run outside the conversation's save chain, so no save waits for them; this bounds how long an
 * attempt (and the reference scanner's pause for its unwritten imports) lasts when main hangs.
 */
export const STORED_IMAGE_MIGRATION_IMPORT_TIMEOUT_MS = 30_000

/** Attempts of this start, per conversation id; kept by the owner across pane (de)activations. */
export type StoredImageMigrationProgress = {
  attempts: Map<string, number>
  /** Conversations not tried again in this start: migrated, unchanged, failed or out of tries. */
  settled: Set<string>
}

export const createStoredImageMigrationProgress = (): StoredImageMigrationProgress => ({
  attempts: new Map(),
  settled: new Set()
})

type RequestIdle = (callback: () => void, timeoutMs: number) => () => void

const defaultRequestIdle: RequestIdle = (callback, timeoutMs) => {
  const idleWindow = typeof window === 'undefined' ? undefined : window
  if (typeof idleWindow?.requestIdleCallback === 'function') {
    const handle = idleWindow.requestIdleCallback(() => callback(), { timeout: timeoutMs })
    return () => idleWindow.cancelIdleCallback?.(handle)
  }
  const timer = setTimeout(callback, Math.min(timeoutMs, 50))
  return () => clearTimeout(timer)
}

export type StoredImageMigrationSchedulerOptions = {
  /** The pane's conversations that still hold inline images, the one on screen first. */
  pendingSessionIds: () => readonly string[]
  /** True while a reply runs or the user is typing: no attempt starts then. */
  isPaused: () => boolean
  /** Migrates one conversation; a rejection counts as 'failed'. */
  migrate: (sessionId: string) => Promise<StoredImageMigrationOutcome>
  progress?: StoredImageMigrationProgress
  timing?: StoredImageMigrationTiming
  requestIdle?: RequestIdle
}

export type StoredImageMigrationScheduler = {
  /** Stops for good: a pending wait is cancelled; an attempt in progress finishes on its own. */
  stop(): void
}

/** Starts the background migration of one open pane. */
export function startStoredImageMigration(
  options: StoredImageMigrationSchedulerOptions
): StoredImageMigrationScheduler {
  const timing = options.timing ?? STORED_IMAGE_MIGRATION_TIMING
  const progress = options.progress ?? createStoredImageMigrationProgress()
  const requestIdle = options.requestIdle ?? defaultRequestIdle
  let stopped = false
  let cancelWait: (() => void) | null = null
  // Set once the wait before a retry has passed.
  let retryDue = false

  const schedule = (delayMs: number): void => {
    if (stopped) return
    let cancelIdle: (() => void) | null = null
    const timer = setTimeout(() => {
      cancelIdle = requestIdle(() => {
        cancelWait = null
        void step()
      }, timing.idleTimeoutMs)
    }, delayMs)
    cancelWait = () => {
      clearTimeout(timer)
      cancelIdle?.()
    }
  }

  /** A conversation not tried yet first; then one to try again. */
  const nextSessionId = (): { id: string; untried: boolean } | undefined => {
    let retry: string | undefined
    for (const id of options.pendingSessionIds()) {
      if (progress.settled.has(id)) continue
      const attempts = progress.attempts.get(id) ?? 0
      if (attempts === 0) return { id, untried: true }
      if (retry === undefined && attempts < timing.maxAttemptsPerSession) retry = id
    }
    return retry === undefined ? undefined : { id: retry, untried: false }
  }

  const step = async (): Promise<void> => {
    if (stopped) return
    if (options.isPaused()) {
      schedule(timing.pauseRetryMs)
      return
    }
    const next = nextSessionId()
    // Nothing left for this start: no timer keeps running.
    if (!next) return
    // A conversation that was busy waits a while; untried ones are not held up by it.
    if (!next.untried && !retryDue) {
      retryDue = true
      schedule(timing.busyRetryMs)
      return
    }
    retryDue = false
    const sessionId = next.id
    const attempt = (progress.attempts.get(sessionId) ?? 0) + 1
    progress.attempts.set(sessionId, attempt)
    let outcome: StoredImageMigrationOutcome
    try {
      outcome = await options.migrate(sessionId)
    } catch (error) {
      console.warn('[ChatStoredImageMigration] A conversation was left as it was:', error)
      outcome = 'failed'
    }
    const retryLater = outcome === 'busy' || outcome === 'not-written'
    if (!retryLater || attempt >= timing.maxAttemptsPerSession) progress.settled.add(sessionId)
    schedule(0)
  }

  schedule(timing.startDelayMs)
  return {
    stop() {
      stopped = true
      cancelWait?.()
      cancelWait = null
    }
  }
}
