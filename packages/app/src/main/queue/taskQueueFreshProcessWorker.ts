import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ComfyJobStatus } from '@shared/comfy/dispatch'
import type { Workflow } from '@shared/comfy/types'
import { initConfig } from '../config/config'
import { ComfyInstanceRegistry } from '../comfy/instanceRegistry'
import {
  getComfyInstanceReservationCountForTest,
  tryReserveComfyInstanceCapacity
} from '../comfy/instancePool'
import { ComfyJobStore } from '../comfy/jobStore'
import {
  closeComfyOutputRouteStore,
  SqliteComfyOutputRouteStore,
  type ComfyOutputRoute
} from '../comfy/outputRouteStore'
import { comfyBatchStateDatabasePath, comfyInstanceStoreDatabasePath } from '../comfy/statePaths'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { addTask, getQueue, getTask, initTaskQueue, stopTaskQueue } from './taskQueue'

const RESULT_MARKER = '__MAGICPOT_TASK_QUEUE_FRESH_PROCESS__'
const INSTANCE_ID = 'fresh-process-loopback'
const WORKFLOW_CLASS = 'FreshProcessIntegrationNode'
const WORKFLOW: Workflow = {
  '1': {
    class_type: WORKFLOW_CLASS,
    inputs: { value: 7 }
  }
}

const scenarios = [
  'queued',
  'leased',
  'prepared',
  'submitting',
  'submitted',
  'unknown',
  'cancel_requested'
] as const

type Scenario = (typeof scenarios)[number]
type Phase = 'seed' | 'produce' | 'recover'

const isScenario = (value: string | undefined): value is Scenario =>
  scenarios.includes(value as Scenario)

const ordinaryTaskQueueDatabasePath = (root: string): string =>
  path.join(root, 'ordinary-task-queue', 'jobs.sqlite')

const promptIdFor = (jobId: string): string => `${jobId}-prompt`

const requireArguments = (): {
  root: string
  phase: Phase
  scenario: Scenario
  jobId: string
  origin: string
} => {
  const [, , root, phaseValue, scenarioValue, jobId, origin] = process.argv
  if (!root) throw new Error('Fresh-process worker requires a user-data root.')
  if (phaseValue !== 'seed' && phaseValue !== 'produce' && phaseValue !== 'recover') {
    throw new Error('Fresh-process worker requires a seed, produce, or recover phase.')
  }
  if (!isScenario(scenarioValue))
    throw new Error('Fresh-process worker received an invalid scenario.')
  if (!jobId?.trim()) throw new Error('Fresh-process worker requires a job id.')
  if (!origin?.trim()) throw new Error('Fresh-process worker requires a ComfyUI origin.')
  return { root: path.resolve(root), phase: phaseValue, scenario: scenarioValue, jobId, origin }
}

const seedRegistry = (databasePath: string, origin: string): void => {
  const eventStore = new MagicAgentEventStore(databasePath)
  try {
    const registry = new ComfyInstanceRegistry(eventStore)
    const created = registry.create({
      id: INSTANCE_ID,
      name: 'Fresh-process loopback',
      origin,
      kind: 'local',
      enabled: true,
      maxConcurrency: 1,
      tags: ['fresh-process'],
      capabilities: {
        tags: ['fresh-process'],
        models: [],
        customNodes: [WORKFLOW_CLASS]
      },
      createdAt: 1_700_000_000_000,
      idempotencyKey: 'fresh-process-registry-create'
    })
    registry.updateHealth({
      id: INSTANCE_ID,
      expectedRevision: created.revision,
      status: 'online',
      checkedAt: 1_700_000_000_001,
      idempotencyKey: 'fresh-process-registry-online'
    })
  } finally {
    eventStore.close()
  }
}

const seedJob = (
  jobs: ComfyJobStore,
  scenario: Scenario,
  jobId: string,
  route: ComfyOutputRoute
): ComfyJobStatus => {
  const created = jobs.create({
    jobId,
    workflow: WORKFLOW,
    clientId: 'fresh-process-renderer',
    target: { mode: 'specific', instanceId: INSTANCE_ID },
    requirements: { customNodes: [WORKFLOW_CLASS] },
    cleanupAfterRun: false,
    maxAttempts: 1,
    createdAt: 1_700_000_000_000,
    idempotencyKey: `fresh-process-create-${scenario}`
  })
  if (scenario === 'queued') return created.state.status

  const leased = jobs.assign({
    jobId,
    expectedRevision: created.revision,
    instanceId: INSTANCE_ID,
    instanceRouteId: route.routeId,
    instanceOrigin: route.origin,
    instanceKind: route.kind,
    leaseOwner: 'crashed-seed-process',
    leaseExpiresAt: 1_700_086_400_000,
    at: 1_700_000_000_001,
    idempotencyKey: `fresh-process-assign-${scenario}`
  })
  if (scenario === 'leased') return leased.state.status

  const prepared = jobs.prepare({
    jobId,
    expectedRevision: leased.revision,
    submissionToken: jobId,
    promptWorkflow: WORKFLOW,
    historyWorkflow: WORKFLOW,
    at: 1_700_000_000_002,
    idempotencyKey: `fresh-process-prepare-${scenario}`
  })
  if (scenario === 'prepared') return prepared.state.status

  if (scenario === 'cancel_requested') {
    return jobs.requestCancel({
      jobId,
      expectedRevision: prepared.revision,
      at: 1_700_000_000_003,
      idempotencyKey: 'fresh-process-request-cancel'
    }).state.status
  }

  const submitting = jobs.markSubmitting({
    jobId,
    expectedRevision: prepared.revision,
    at: 1_700_000_000_003,
    idempotencyKey: `fresh-process-submitting-${scenario}`
  })
  if (scenario === 'submitting') return submitting.state.status

  if (scenario === 'unknown') {
    return jobs.markUnknown({
      jobId,
      expectedRevision: submitting.revision,
      code: 'SEED_PROCESS_CRASHED_AFTER_POST',
      message: 'The seed process lost the accepted response.',
      at: 1_700_000_000_004,
      idempotencyKey: 'fresh-process-unknown'
    }).state.status
  }

  return jobs.bindPrompt({
    jobId,
    expectedRevision: submitting.revision,
    promptId: promptIdFor(jobId),
    at: 1_700_000_000_004,
    idempotencyKey: 'fresh-process-bind-prompt'
  }).state.status
}

const runSeed = ({
  root,
  scenario,
  jobId,
  origin
}: ReturnType<typeof requireArguments>): Record<string, unknown> => {
  const jobsPath = ordinaryTaskQueueDatabasePath(root)
  const routePath = comfyBatchStateDatabasePath(root)
  const registryPath = comfyInstanceStoreDatabasePath(root)
  const routeStore = new SqliteComfyOutputRouteStore(routePath)
  const eventStore = new MagicAgentEventStore(jobsPath)
  try {
    const route = routeStore.capture({ id: INSTANCE_ID, origin, kind: 'local' })
    const jobs = new ComfyJobStore(eventStore)
    const seededStatus = seedJob(jobs, scenario, jobId, route)
    if (scenario === 'queued') seedRegistry(registryPath, origin)
    const seeded = jobs.get(jobId)
    return {
      phase: 'seed',
      pid: process.pid,
      nodeEnv: process.env.NODE_ENV ?? null,
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
      scenario,
      jobId,
      jobsPath,
      routePath,
      registryPath,
      route,
      seededStatus,
      cleanupAfterRun: seeded?.state.cleanupAfterRun,
      registryExists: existsSync(registryPath)
    }
  } finally {
    routeStore.close()
    eventStore.close()
  }
}

type PublicSnapshot = Readonly<{
  status: ReturnType<typeof getTask>[0]
  promptId: string | null
  cancelRequested: boolean
  instanceId: string | null
  instanceRouteId: string | null
  reservation: number
  queue: Readonly<{
    pending: number
    running: number
    unknown: number
    completed: number
  }>
}>

const publicSnapshot = (jobId: string): PublicSnapshot => {
  const [status, task] = getTask(jobId)
  const queue = getQueue()
  return {
    status,
    promptId: task?.prompt_id ?? null,
    cancelRequested: task?.cancelRequested === true,
    instanceId: task?.instanceId ?? null,
    instanceRouteId: task?.instanceRouteId ?? null,
    reservation: getComfyInstanceReservationCountForTest(INSTANCE_ID),
    queue: {
      pending: queue.pending.length,
      running: queue.running.length,
      unknown: queue.unknown.length,
      completed: queue.completed.length
    }
  }
}

const waitForPublicStatus = async (
  jobId: string,
  expected: 'completed' | 'unknown',
  timeoutMs = 15_000
): Promise<PublicSnapshot> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = publicSnapshot(jobId)
    if (snapshot.status === expected) return snapshot
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${jobId} to become ${expected}; current status is ${snapshot.status}.`
      )
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

const runProducer = async ({
  root,
  scenario,
  origin
}: ReturnType<typeof requireArguments>): Promise<never> => {
  if (scenario !== 'submitting') {
    throw new Error('The live crash producer currently supports only the submitting boundary.')
  }
  const jobsPath = ordinaryTaskQueueDatabasePath(root)
  const registryPath = comfyInstanceStoreDatabasePath(root)
  seedRegistry(registryPath, origin)
  await initConfig()
  const eventStore = new MagicAgentEventStore(jobsPath)
  const jobs = new ComfyJobStore(eventStore)
  await initTaskQueue({ eventStore })
  const actualJobId = addTask({
    id: '',
    type: 'comfy_prompt',
    client_id: 'fresh-process-live-producer',
    created_at: Date.now(),
    prompt_id: null,
    payload: WORKFLOW,
    target: { mode: 'specific', instanceId: INSTANCE_ID },
    requirements: { customNodes: [WORKFLOW_CLASS] },
    result: null
  })
  const deadline = Date.now() + 15_000
  for (;;) {
    const resource = jobs.get(actualJobId)
    if (resource?.state.status === 'submitting') {
      process.stdout.write(
        `${RESULT_MARKER}${JSON.stringify({
          phase: 'produce',
          pid: process.pid,
          scenario,
          jobId: actualJobId,
          jobsPath,
          routePath: comfyBatchStateDatabasePath(root),
          registryPath,
          durableStatus: resource.state.status,
          instanceId: resource.state.instanceId ?? null,
          instanceRouteId: resource.state.instanceRouteId ?? null
        })}\n`
      )
      await new Promise<never>(() => undefined)
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the live producer to reach submitting; current status is ${resource?.state.status ?? 'missing'}.`
      )
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

const runRecovery = async ({
  root,
  scenario,
  jobId
}: ReturnType<typeof requireArguments>): Promise<Record<string, unknown>> => {
  const jobsPath = ordinaryTaskQueueDatabasePath(root)
  const routePath = comfyBatchStateDatabasePath(root)
  const registryPath = comfyInstanceStoreDatabasePath(root)
  const registryExistsBeforeInit = existsSync(registryPath)
  const eventStore = new MagicAgentEventStore(jobsPath)
  const jobs = new ComfyJobStore(eventStore)
  const shutdownOrder: string[] = []
  let queueStopped = false
  let routeClosed = false
  let eventStoreClosed = false

  try {
    await initConfig()
    let beforeStart: PublicSnapshot | null = null
    let capacityAvailableBeforeStart: boolean | null = null
    await initTaskQueue({
      eventStore,
      beforeStart: async () => {
        beforeStart = publicSnapshot(jobId)
        const competingRelease = tryReserveComfyInstanceCapacity(
          { id: INSTANCE_ID, maxConcurrency: 1 },
          0,
          0
        )
        capacityAvailableBeforeStart = competingRelease !== null
        competingRelease?.()
      }
    })
    if (!beforeStart) throw new Error('TaskQueue did not invoke its beforeStart hydration barrier.')

    const expected =
      scenario === 'unknown' || scenario === 'cancel_requested' ? 'unknown' : 'completed'
    const final = await waitForPublicStatus(jobId, expected)
    const durableBeforeStop = jobs.get(jobId)?.state
    const reservationBeforeStop = getComfyInstanceReservationCountForTest(INSTANCE_ID)
    const competingReleaseAtFinal = tryReserveComfyInstanceCapacity(
      { id: INSTANCE_ID, maxConcurrency: 1 },
      0,
      0
    )
    const capacityAvailableAtFinal = competingReleaseAtFinal !== null
    competingReleaseAtFinal?.()

    await stopTaskQueue()
    queueStopped = true
    shutdownOrder.push('stopTaskQueue')
    const reservationAfterStop = getComfyInstanceReservationCountForTest(INSTANCE_ID)

    closeComfyOutputRouteStore()
    routeClosed = true
    shutdownOrder.push('closeComfyOutputRouteStore')

    const durableAfterStop = jobs.get(jobId)?.state
    eventStore.close()
    eventStoreClosed = true
    shutdownOrder.push('eventStore.close')

    return {
      phase: 'recover',
      pid: process.pid,
      nodeEnv: process.env.NODE_ENV ?? null,
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
      scenario,
      jobId,
      jobsPath,
      routePath,
      registryPath,
      registryExistsBeforeInit,
      registryExistsAfterStop: existsSync(registryPath),
      capturedInsideBeforeStart: true,
      beforeStart,
      final,
      capacityAvailableBeforeStart,
      capacityAvailableAtFinal,
      reservationBeforeStop,
      reservationAfterStop,
      durableBeforeStop: durableBeforeStop
        ? {
            status: durableBeforeStop.status,
            promptId: durableBeforeStop.promptId ?? null,
            cancelRequested: durableBeforeStop.cancelRequested === true,
            instanceId: durableBeforeStop.instanceId ?? null,
            instanceRouteId: durableBeforeStop.instanceRouteId ?? null
          }
        : null,
      durableAfterStop: durableAfterStop
        ? {
            status: durableAfterStop.status,
            promptId: durableAfterStop.promptId ?? null,
            cancelRequested: durableAfterStop.cancelRequested === true
          }
        : null,
      shutdownOrder
    }
  } finally {
    if (!queueStopped) {
      try {
        await stopTaskQueue()
      } catch {
        // Preserve the original worker failure.
      }
    }
    if (!routeClosed) closeComfyOutputRouteStore()
    if (!eventStoreClosed) eventStore.close()
  }
}

const main = async (): Promise<void> => {
  const options = requireArguments()
  if (options.phase === 'produce') await runProducer(options)
  const result = options.phase === 'seed' ? runSeed(options) : await runRecovery(options)
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`)
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
