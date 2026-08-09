import {
  executeManagedMediaCleanup,
  planManagedMediaCleanup,
  type ManagedMediaCleanupPlan,
  type ManagedMediaCleanupResult
} from './managedMediaCleanup'

export const MANAGED_MEDIA_CLEANUP_DEBOUNCE_MS = 1_000
export const MANAGED_MEDIA_CLEANUP_DAILY_MS = 24 * 60 * 60 * 1_000

export type CompleteManagedMediaReferenceSnapshot = {
  complete: true
  chatMediaRoot: string
  referencedMediaIds: Iterable<string>
}

export type ManagedMediaReferenceSnapshot = Omit<
  CompleteManagedMediaReferenceSnapshot,
  'complete'
> & {
  complete: boolean
}

export type ManagedMediaCleanupTimer = ReturnType<typeof setTimeout>
export type ManagedMediaCleanupSchedulerDependencies = {
  setTimeout?: (callback: () => void, delayMs: number) => ManagedMediaCleanupTimer
  clearTimeout?: (timer: ManagedMediaCleanupTimer) => void
  now?: () => number
  plan?: (input: {
    chatMediaRoot: string
    referencedMediaIds: Iterable<string>
  }) => Promise<ManagedMediaCleanupPlan>
  execute?: (
    plan: ManagedMediaCleanupPlan,
    options: { dryRun: false }
  ) => Promise<ManagedMediaCleanupResult>
  logger?: {
    cleanupCompleted?: (counts: { deletedCount: number; skippedCount: number }) => void
    cleanupFailed?: () => void
  }
  debounceMs?: number
  dailyMs?: number
}

export type ManagedMediaCleanupScheduler = {
  submitSnapshot(snapshot: ManagedMediaReferenceSnapshot): void
  stop(): Promise<void>
}

/** Main-process-only lifecycle coordinator for complete authoritative snapshots. */
export function createManagedMediaCleanupScheduler(
  dependencies: ManagedMediaCleanupSchedulerDependencies = {}
): ManagedMediaCleanupScheduler {
  const setTimer = dependencies.setTimeout ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer))
  const now = dependencies.now ?? (() => Date.now())
  const plan = dependencies.plan ?? planManagedMediaCleanup
  const execute = dependencies.execute ?? executeManagedMediaCleanup
  const debounceMs = dependencies.debounceMs ?? MANAGED_MEDIA_CLEANUP_DEBOUNCE_MS
  const dailyMs = dependencies.dailyMs ?? MANAGED_MEDIA_CLEANUP_DAILY_MS

  let snapshot: CompleteManagedMediaReferenceSnapshot | undefined
  let timer: ManagedMediaCleanupTimer | undefined
  let inFlight: Promise<void> | undefined
  let rerunRequested = false
  let stopped = false
  let lastRunAt: number | undefined
  let generation = 0

  const schedule = (delayMs = debounceMs) => {
    if (stopped || timer || !snapshot || inFlight) return
    const scheduledGeneration = generation
    timer = setTimer(() => {
      if (scheduledGeneration !== generation) return
      timer = undefined
      void run()
    }, delayMs)
  }

  const run = async (): Promise<void> => {
    if (stopped || !snapshot || inFlight) return
    if (lastRunAt !== undefined && now() - lastRunAt < dailyMs) return
    const current = snapshot
    inFlight = (async () => {
      try {
        const cleanupPlan = await plan({
          chatMediaRoot: current.chatMediaRoot,
          referencedMediaIds: current.referencedMediaIds
        })
        const result = await execute(cleanupPlan, { dryRun: false })
        lastRunAt = now()
        dependencies.logger?.cleanupCompleted?.({
          deletedCount: result.deleted.length,
          skippedCount: result.skipped.length
        })
      } catch {
        dependencies.logger?.cleanupFailed?.()
      } finally {
        inFlight = undefined
        if (rerunRequested && snapshot) {
          rerunRequested = false
          const remainingDailyMs =
            lastRunAt === undefined ? debounceMs : Math.max(0, dailyMs - (now() - lastRunAt))
          schedule(Math.max(debounceMs, remainingDailyMs))
        } else if (snapshot) {
          schedule(dailyMs)
        }
      }
    })()
    await inFlight
  }

  return {
    submitSnapshot(nextSnapshot) {
      if (stopped) return
      if (nextSnapshot.complete !== true) {
        generation += 1
        if (timer) clearTimer(timer)
        timer = undefined
        snapshot = undefined
        rerunRequested = false
        return
      }
      generation += 1
      snapshot = { ...nextSnapshot, complete: true }
      if (inFlight) {
        rerunRequested = true
        return
      }
      if (timer) clearTimer(timer)
      timer = undefined
      if (lastRunAt !== undefined && now() - lastRunAt < dailyMs) {
        schedule(Math.max(0, dailyMs - (now() - lastRunAt)))
        return
      }
      schedule()
    },
    async stop() {
      stopped = true
      if (timer) {
        clearTimer(timer)
        timer = undefined
      }
      await inFlight
    }
  }
}
