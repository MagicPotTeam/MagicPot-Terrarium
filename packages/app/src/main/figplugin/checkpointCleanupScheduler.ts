import type { CheckpointCleanupSummary, RecoveryCheckpointStore } from './checkpointStore'

/** Checkpoint retention is short-lived; a daily pass keeps cleanup bounded while the app runs. */
export const FIGPLUGIN_CHECKPOINT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000

export type CheckpointCleanupSchedulerDependencies = {
  createStore: () => Pick<RecoveryCheckpointStore, 'cleanupExpired'>
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  intervalMs?: number
  cleanupCompleted?: (summary: CheckpointCleanupSummary) => void
  cleanupFailed?: () => void
}

export type CheckpointCleanupScheduler = {
  start(): void
  stop(): Promise<void>
}

/**
 * Runs encrypted checkpoint retention cleanup outside request paths.  Each pass opens a
 * fresh store so SQLite connections are short-lived and can serialize with bridge requests;
 * a failed pass is retried on the next interval and never replaces or deletes a database.
 */
export function createCheckpointCleanupScheduler(
  dependencies: CheckpointCleanupSchedulerDependencies
): CheckpointCleanupScheduler {
  const setTimer = dependencies.setTimeout ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer))
  const intervalMs = dependencies.intervalMs ?? FIGPLUGIN_CHECKPOINT_CLEANUP_INTERVAL_MS

  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let started = false
  let stopped = false

  const schedule = () => {
    if (stopped || !started || timer || inFlight) return
    timer = setTimer(() => {
      timer = undefined
      void run()
    }, intervalMs)
    timer.unref?.()
  }

  const run = async (): Promise<void> => {
    if (stopped || !started || inFlight) return
    inFlight = Promise.resolve()
      .then(() => {
        const summary = dependencies.createStore().cleanupExpired?.()
        if (summary) dependencies.cleanupCompleted?.(summary)
      })
      .catch(() => {
        dependencies.cleanupFailed?.()
      })
      .finally(() => {
        inFlight = undefined
        schedule()
      })
    await inFlight
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      // Run once at startup so a restart does not leave expired ciphertext until tomorrow.
      void run()
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (timer) {
        clearTimer(timer)
        timer = undefined
      }
      await inFlight
    }
  }
}
