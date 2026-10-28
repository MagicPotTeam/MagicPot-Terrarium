import {
  executeManagedMediaCleanup,
  planManagedMediaCleanup,
  type ManagedMediaCleanupPlan,
  type ManagedMediaCleanupResult,
  type ManagedMediaCleanupAudit,
  type ManagedMediaRetentionPolicy
} from './managedMediaCleanup'

export const MANAGED_MEDIA_CLEANUP_DEBOUNCE_MS = 1_000
export const MANAGED_MEDIA_CLEANUP_DAILY_MS = 24 * 60 * 60 * 1_000

export type CompleteManagedMediaReferenceSnapshot = {
  complete: true
  chatMediaRoot: string
  referencedMediaIds: Iterable<string>
  /** Durable occurrence counts keyed by managed media ID. */
  referenceCounts?: Readonly<Record<string, number>>
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
  retention?: Partial<ManagedMediaRetentionPolicy>
  plan?: (input: {
    /** Canonical base root; the planner may enumerate safe global/task roots below it. */
    chatMediaRoot: string
    referencedMediaIds: Iterable<string>
    referenceCounts?: Readonly<Record<string, number>>
    retention?: Partial<ManagedMediaRetentionPolicy>
    now?: number
  }) => Promise<ManagedMediaCleanupPlan>
  execute?: (
    plan: ManagedMediaCleanupPlan,
    options: { dryRun: false; shouldContinue?: () => boolean }
  ) => Promise<ManagedMediaCleanupResult>
  logger?: {
    cleanupCompleted?: (summary: {
      deletedCount: number
      skippedCount: number
      audit: ManagedMediaCleanupAudit & { deletedCount: number; skippedCount: number }
    }) => void
    cleanupFailed?: () => void
    snapshotPersistenceFailed?: () => void
  }
  /** Persist only the bounded reference IDs; never persist task content or bytes. */
  persistSnapshot?: (snapshot: CompleteManagedMediaReferenceSnapshot) => Promise<void>
  /** Load a prior snapshot as a conservative baseline after an app restart. */
  loadPersistedSnapshot?: () => Promise<CompleteManagedMediaReferenceSnapshot | undefined>
  debounceMs?: number
  dailyMs?: number
}

export type ManagedMediaCleanupScheduler = {
  submitSnapshot(snapshot: ManagedMediaReferenceSnapshot): void
  restorePersistedSnapshot(): Promise<boolean>
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
  let snapshotIsFresh = false
  let persistenceInFlight: Promise<void> | undefined
  let persistedSnapshotLoaded = false

  const materializeReferenceCounts = (
    ids: readonly string[],
    counts: Readonly<Record<string, number>> | undefined
  ): Record<string, number> => {
    const knownIds = new Set(ids)
    // Do not silently discard a count for an ID that is absent from the
    // authoritative renderer snapshot. Treating malformed input as a partial
    // snapshot could authorize an unsafe cleanup with incomplete provenance.
    if (counts !== undefined) {
      for (const id of Object.keys(counts)) {
        if (!knownIds.has(id)) throw new TypeError('referenceCounts has an unknown media ID')
      }
    }
    const result: Record<string, number> = {}
    for (const id of ids) {
      const count = counts?.[id] ?? 1
      if (!Number.isSafeInteger(count) || count <= 0)
        throw new TypeError('referenceCounts must contain positive safe integers')
      result[id] = count
    }
    return result
  }

  const schedule = (delayMs = debounceMs) => {
    if (stopped || timer || !snapshot || !snapshotIsFresh || inFlight) return
    const scheduledGeneration = generation
    timer = setTimer(() => {
      if (scheduledGeneration !== generation) return
      timer = undefined
      void run()
    }, delayMs)
  }

  const run = async (): Promise<void> => {
    if (stopped || !snapshot || !snapshotIsFresh || inFlight) return
    if (lastRunAt !== undefined && now() - lastRunAt < dailyMs) return
    const current = snapshot
    const runGeneration = generation
    inFlight = (async () => {
      try {
        const cleanupPlan = await plan({
          chatMediaRoot: current.chatMediaRoot,
          referencedMediaIds: current.referencedMediaIds,
          referenceCounts: current.referenceCounts,
          retention: dependencies.retention,
          now: now()
        })
        // A newer renderer snapshot invalidates the plan. The built-in
        // executor also checks this guard before each destructive action so
        // an update arriving during execution cannot be deleted by an older
        // plan.
        if (stopped || generation !== runGeneration || snapshot !== current) {
          rerunRequested = rerunRequested || Boolean(snapshot && snapshotIsFresh)
          return
        }
        const result = await execute(cleanupPlan, {
          dryRun: false,
          shouldContinue: () => !stopped && generation === runGeneration && snapshot === current
        })
        // An executor may return after a newer snapshot invalidated the plan
        // (including a custom test/host executor that ignores shouldContinue).
        // Do not count that partial run against the daily budget or report it
        // as a completed cleanup; the fresh snapshot must be scheduled again.
        if (stopped || generation !== runGeneration || snapshot !== current) {
          rerunRequested = rerunRequested || Boolean(snapshot && snapshotIsFresh)
          return
        }
        lastRunAt = now()
        const skippedCount = cleanupPlan.skipped.length + result.skipped.length
        dependencies.logger?.cleanupCompleted?.({
          deletedCount: result.deleted.length,
          // Planner skips (unsafe/retained entries) are part of the same
          // cleanup decision and must not disappear from the completion audit.
          skippedCount,
          audit: { ...result.audit, skippedCount }
        })
      } catch {
        dependencies.logger?.cleanupFailed?.()
      } finally {
        inFlight = undefined
        if (rerunRequested && snapshot && snapshotIsFresh) {
          rerunRequested = false
          const remainingDailyMs =
            lastRunAt === undefined ? debounceMs : Math.max(0, dailyMs - (now() - lastRunAt))
          schedule(Math.max(debounceMs, remainingDailyMs))
        } else if (snapshot && snapshotIsFresh) {
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
        snapshotIsFresh = false
        rerunRequested = false
        return
      }
      generation += 1
      // Materialize the iterable at the submission boundary. Renderer-owned
      // arrays/generators may otherwise be mutated or consumed before the
      // deferred planner and persistence chain inspect them.
      const ids = [...nextSnapshot.referencedMediaIds]
      snapshot = {
        ...nextSnapshot,
        complete: true,
        referencedMediaIds: ids,
        referenceCounts: materializeReferenceCounts(ids, nextSnapshot.referenceCounts)
      }
      snapshotIsFresh = true
      if (dependencies.persistSnapshot) {
        const persisted = snapshot
        const previousPersistence = persistenceInFlight ?? Promise.resolve()
        const currentPersistence = previousPersistence
          .catch(() => undefined)
          .then(async () => {
            try {
              await dependencies.persistSnapshot!(persisted)
            } catch {
              dependencies.logger?.snapshotPersistenceFailed?.()
            }
          })
        const trackedPersistence = currentPersistence.finally(() => {
          if (persistenceInFlight === trackedPersistence) persistenceInFlight = undefined
        })
        persistenceInFlight = trackedPersistence
      }
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
    async restorePersistedSnapshot() {
      if (stopped || persistedSnapshotLoaded || !dependencies.loadPersistedSnapshot) return false
      persistedSnapshotLoaded = true
      const restoreGeneration = generation
      try {
        const restored = await dependencies.loadPersistedSnapshot()
        // A renderer snapshot may arrive while the disk read is in flight;
        // never let an older baseline overwrite that authoritative state.
        if (
          !restored ||
          restored.complete !== true ||
          stopped ||
          generation !== restoreGeneration ||
          snapshotIsFresh
        )
          return false
        const ids = [...restored.referencedMediaIds]
        snapshot = {
          ...restored,
          complete: true,
          referencedMediaIds: ids,
          referenceCounts: materializeReferenceCounts(ids, restored.referenceCounts)
        }
        // A persisted snapshot is deliberately not enough to authorize deletion:
        // require a fresh renderer scan after restart to avoid stale-state GC.
        snapshotIsFresh = false
        return true
      } catch {
        return false
      }
    },
    async stop() {
      stopped = true
      if (timer) {
        clearTimer(timer)
        timer = undefined
      }
      await inFlight
      await persistenceInFlight
    }
  }
}
