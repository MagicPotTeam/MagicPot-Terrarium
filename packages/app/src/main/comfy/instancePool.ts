import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Workflow } from '@shared/comfy/types'
import type {
  ComfyDispatchTarget,
  ComfyInstanceState,
  ComfyJobRequirements
} from '@shared/comfy/dispatch'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { ComfyInstanceRegistry } from './instanceRegistry'
import { ComfyHttpCli } from './http'
import { ComfyLeastUtilizationScheduler, getWorkflowRequiredNodeClasses } from './scheduler'
import { comfyInstanceStoreDatabasePath } from './statePaths'

export const comfyInstanceStorePath = (userDataRoot?: string): string => {
  const root = userDataRoot ?? (app?.getPath ? app.getPath('userData') : undefined)
  return root ? comfyInstanceStoreDatabasePath(root) : ':memory:'
}

const DEFAULT_CAPACITY_WAIT_TIMEOUT_MS = 5 * 60_000
const CAPACITY_POLL_MS = 1_000
const queueStats = new Map<string, { active: number; pending: number }>()
const reservations = new Map<string, number>()
const restoredReservations = new Map<string, string>()
const scheduler = new ComfyLeastUtilizationScheduler()

export const getComfyInstanceReservationCount = (instanceId: string): number =>
  reservations.get(instanceId) ?? 0

export const retainRestoredComfyInstanceCapacity = (
  taskId: string,
  instanceId: string
): (() => void) => {
  if (typeof taskId !== 'string' || !taskId.trim()) throw new TypeError('taskId is required.')
  if (typeof instanceId !== 'string' || !instanceId.trim())
    throw new TypeError('instanceId is required.')
  const existing = restoredReservations.get(taskId)
  if (existing) {
    if (existing !== instanceId) throw new Error(`Task ${taskId} is bound to another instance.`)
    return () => releaseRestoredComfyInstanceCapacity(taskId)
  }
  restoredReservations.set(taskId, instanceId)
  reservations.set(instanceId, getComfyInstanceReservationCount(instanceId) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    releaseRestoredComfyInstanceCapacity(taskId)
  }
}

export const releaseRestoredComfyInstanceCapacity = (taskId: string): void => {
  const instanceId = restoredReservations.get(taskId)
  if (!instanceId) return
  restoredReservations.delete(taskId)
  const remaining = getComfyInstanceReservationCount(instanceId) - 1
  if (remaining > 0) reservations.set(instanceId, remaining)
  else reservations.delete(instanceId)
}

export const tryReserveComfyInstanceCapacity = (
  state: Pick<ComfyInstanceState, 'id' | 'maxConcurrency'>,
  observedActive: number,
  observedPending: number
): (() => void) | null => {
  const reserved = getComfyInstanceReservationCount(state.id)
  if (observedActive + observedPending + reserved >= state.maxConcurrency) return null
  reservations.set(state.id, reserved + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = getComfyInstanceReservationCount(state.id) - 1
    if (remaining > 0) reservations.set(state.id, remaining)
    else reservations.delete(state.id)
  }
}
let store: MagicAgentEventStore | null = null
let registry: ComfyInstanceRegistry | null = null

export const getComfyInstanceRegistry = (): ComfyInstanceRegistry => {
  if (registry) return registry
  const databasePath = comfyInstanceStorePath()
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(databasePath), { recursive: true })
    if (!existsSync(databasePath)) closeSync(openSync(databasePath, 'a'))
  }
  store = new MagicAgentEventStore(databasePath)
  registry = new ComfyInstanceRegistry(store)
  return registry
}

export const getComfyInstanceClient = (state: ComfyInstanceState): ComfyHttpCli =>
  new ComfyHttpCli(undefined, undefined, {
    origin: state.origin,
    remote: state.kind === 'remote',
    networkRetries: 3
  })

export type ComfyInstanceLease = Readonly<{
  state: ComfyInstanceState
  cli: ComfyHttpCli
  release: () => void
}>

export type AcquireComfyInstanceOptions = Readonly<{
  target?: ComfyDispatchTarget
  requirements?: ComfyJobRequirements
  excludedIds?: ReadonlySet<string>
  signal?: AbortSignal
  timeoutMs?: number
  waitForCapacity?: boolean
}>

const delay = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) throw signal.reason ?? new Error('ComfyUI capacity wait aborted')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('ComfyUI capacity wait aborted'))
      },
      { once: true }
    )
  })
}

const probeProfile = async (
  profile: ReturnType<ComfyInstanceRegistry['list']>[number]
): Promise<void> => {
  try {
    const cli = getComfyInstanceClient(profile.state)
    const [objectInfo, queue] = await Promise.all([cli.objectInfo(), cli.getQueue()])
    queueStats.set(profile.state.id, {
      active: queue.queue_running.length,
      pending: queue.queue_pending.length
    })
    const current = getComfyInstanceRegistry().get(profile.state.id)
    if (!current || current.deleted) return
    const withCapabilities = getComfyInstanceRegistry().update({
      id: profile.state.id,
      expectedRevision: current.revision,
      updatedAt: Date.now(),
      idempotencyKey: crypto.randomUUID(),
      patch: {
        capabilities: {
          ...current.state.capabilities,
          customNodes: Object.keys(objectInfo).sort()
        }
      }
    })
    getComfyInstanceRegistry().updateHealth({
      id: profile.state.id,
      expectedRevision: withCapabilities.revision,
      status: 'online',
      checkedAt: Date.now(),
      idempotencyKey: crypto.randomUUID()
    })
  } catch (error) {
    const current = getComfyInstanceRegistry().get(profile.state.id)
    if (!current || current.deleted) return
    try {
      getComfyInstanceRegistry().updateHealth({
        id: profile.state.id,
        expectedRevision: current.revision,
        status: 'offline',
        checkedAt: Date.now(),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
        idempotencyKey: crypto.randomUUID()
      })
    } catch {
      // A concurrent probe may have committed a newer health revision.
    }
  }
}

export const acquireComfyInstance = async (
  workflow: Workflow,
  options: AcquireComfyInstanceOptions = {}
): Promise<ComfyInstanceLease | null> => {
  const target = options.target ?? { mode: 'auto' as const }
  const requirements = options.requirements ?? {
    customNodes: getWorkflowRequiredNodeClasses(workflow)
  }
  const excludedIds = options.excludedIds ?? new Set<string>()
  const waitForCapacity = options.waitForCapacity ?? true
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CAPACITY_WAIT_TIMEOUT_MS)
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('ComfyUI capacity wait aborted')
    }
    const registered = getComfyInstanceRegistry()
      .list()
      .filter((entry) => !entry.deleted && !excludedIds.has(entry.state.id))
    if (registered.length === 0) return null
    const profiles = registered.filter((entry) => entry.state.enabled)
    if (profiles.length === 0) {
      throw new Error('No enabled ComfyUI instance is available.')
    }

    await Promise.all(profiles.map(probeProfile))
    const refreshed = getComfyInstanceRegistry()
      .list()
      .filter((entry) => !entry.deleted && entry.state.enabled && !excludedIds.has(entry.state.id))
    const candidate = scheduler.select(
      refreshed.map((profile) => {
        const stats = queueStats.get(profile.state.id) ?? { active: 0, pending: 0 }
        return {
          state: profile.state,
          active: stats.active + getComfyInstanceReservationCount(profile.state.id),
          pending: stats.pending
        }
      }),
      target,
      requirements,
      excludedIds
    )

    if (candidate) {
      const stats = queueStats.get(candidate.state.id) ?? { active: 0, pending: 0 }
      const release = tryReserveComfyInstanceCapacity(candidate.state, stats.active, stats.pending)
      if (release) {
        return {
          state: candidate.state,
          cli: getComfyInstanceClient(candidate.state),
          release
        }
      }
    }

    if (!waitForCapacity || Date.now() >= deadline) {
      throw new Error('Timed out waiting for a compatible ComfyUI instance with capacity.')
    }
    await delay(Math.min(CAPACITY_POLL_MS, Math.max(1, deadline - Date.now())), options.signal)
  }
}

export const getComfyInstanceReservationCountForTest = getComfyInstanceReservationCount
