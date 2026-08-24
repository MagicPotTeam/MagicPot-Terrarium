import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build, type Plugin } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ComfyInstanceRegistry } from '../comfy/instanceRegistry'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'

vi.mock('node:fs', async (importActual) => importActual())
vi.mock('node:fs/promises', async (importActual) => importActual())

const RESULT_MARKER = '__MAGICPOT_TASK_QUEUE_FRESH_PROCESS__'
const INSTANCE_ID = 'fresh-process-loopback'
const WORKFLOW_CLASS = 'FreshProcessIntegrationNode'
const WORKFLOW = {
  '1': {
    class_type: WORKFLOW_CLASS,
    inputs: { value: 7 }
  }
}

const scenarios = [
  {
    name: 'queued durable snapshot before lease through the registry',
    scenario: 'queued',
    seededStatus: 'queued',
    beforeStatus: 'pending',
    beforeReservation: 0,
    finalStatus: 'completed',
    finalDurableStatus: 'succeeded',
    finalReservation: 0,
    promptPosts: 1,
    registryExists: true
  },
  {
    name: 'leased durable snapshot through captured authority with no registry',
    scenario: 'leased',
    seededStatus: 'leased',
    beforeStatus: 'pending',
    beforeReservation: 1,
    finalStatus: 'completed',
    finalDurableStatus: 'succeeded',
    finalReservation: 0,
    promptPosts: 1,
    registryExists: false
  },
  {
    name: 'prepared-before-POST snapshot with one recovery POST',
    scenario: 'prepared',
    seededStatus: 'prepared',
    beforeStatus: 'pending',
    beforeReservation: 1,
    finalStatus: 'completed',
    finalDurableStatus: 'succeeded',
    finalReservation: 0,
    promptPosts: 1,
    registryExists: false
  },
  {
    name: 'submitting response-loss snapshot reconciled from historyAll',
    scenario: 'submitting',
    seededStatus: 'submitting',
    beforeStatus: 'pending',
    beforeReservation: 1,
    finalStatus: 'completed',
    finalDurableStatus: 'succeeded',
    finalReservation: 0,
    promptPosts: 0,
    registryExists: false
  },
  {
    name: 'submitted known-prompt resume with a single logical capacity release',
    scenario: 'submitted',
    seededStatus: 'submitted',
    beforeStatus: 'pending',
    beforeReservation: 1,
    finalStatus: 'completed',
    finalDurableStatus: 'succeeded',
    finalReservation: 0,
    promptPosts: 0,
    registryExists: false
  },
  {
    name: 'unknown restoration retaining logical capacity',
    scenario: 'unknown',
    seededStatus: 'unknown',
    beforeStatus: 'unknown',
    beforeReservation: 1,
    finalStatus: 'unknown',
    finalDurableStatus: 'unknown',
    finalReservation: 1,
    promptPosts: 0,
    registryExists: false
  },
  {
    name: 'cancel_requested restoration preserving intent and capacity',
    scenario: 'cancel_requested',
    seededStatus: 'cancel_requested',
    beforeStatus: 'unknown',
    beforeReservation: 1,
    finalStatus: 'unknown',
    finalDurableStatus: 'unknown',
    finalReservation: 1,
    promptPosts: 0,
    registryExists: false
  }
] as const

type Scenario = (typeof scenarios)[number]['scenario']
type Phase = 'seed' | 'produce' | 'recover'
type PublicSnapshot = Readonly<{
  status: string | null
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
type SeedResult = Readonly<{
  phase: 'seed'
  pid: number
  nodeEnv: string | null
  electronRunAsNode: string | null
  scenario: Scenario
  jobId: string
  jobsPath: string
  routePath: string
  registryPath: string
  route: Readonly<{
    routeId: string
    instanceId: string
    origin: string
    kind: string
  }>
  seededStatus: string
  cleanupAfterRun: boolean
  registryExists: boolean
}>
type RecoveryResult = Readonly<{
  phase: 'recover'
  pid: number
  nodeEnv: string | null
  electronRunAsNode: string | null
  scenario: Scenario
  jobId: string
  jobsPath: string
  routePath: string
  registryPath: string
  registryExistsBeforeInit: boolean
  registryExistsAfterStop: boolean
  capturedInsideBeforeStart: boolean
  beforeStart: PublicSnapshot
  final: PublicSnapshot
  capacityAvailableBeforeStart: boolean
  capacityAvailableAtFinal: boolean
  reservationBeforeStop: number
  reservationAfterStop: number
  durableBeforeStop: Readonly<{
    status: string
    promptId: string | null
    cancelRequested: boolean
    instanceId: string | null
    instanceRouteId: string | null
  }>
  durableAfterStop: Readonly<{
    status: string
    promptId: string | null
    cancelRequested: boolean
  }>
  shutdownOrder: readonly string[]
}>
type ProducerResult = Readonly<{
  phase: 'produce'
  pid: number
  scenario: 'submitting'
  jobId: string
  jobsPath: string
  routePath: string
  registryPath: string
  durableStatus: 'submitting'
  instanceId: string | null
  instanceRouteId: string | null
}>

type FakeComfyState = {
  jobId: string
  promptId: string
  exposeTokenInHistoryAll: boolean
  holdPromptResponse: boolean
  completedPromptIds: Set<string>
  counts: Map<string, number>
  promptBodies: Record<string, unknown>[]
}

const repositoryRoot = path.resolve(__dirname, '../../../../..')
const temporaryRoots: string[] = []
let workerBuildRoot = ''
let workerBundle = ''
let fakeServer: Server | null = null
let fakeOrigin = ''
let fakeState: FakeComfyState | null = null

const makeTemporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

const electronToolkitUtilsShim: Plugin = {
  name: 'fresh-process-electron-toolkit-utils-shim',
  setup(buildContext) {
    buildContext.onResolve({ filter: /^@electron-toolkit\/utils$/ }, () => ({
      path: '@electron-toolkit/utils',
      namespace: 'fresh-process-shim'
    }))
    buildContext.onLoad(
      { filter: /^@electron-toolkit\/utils$/, namespace: 'fresh-process-shim' },
      () => ({
        loader: 'js',
        contents: `
          exports.is = { dev: false };
          exports.platform = {
            isWindows: process.platform === 'win32',
            isMacOS: process.platform === 'darwin',
            isLinux: process.platform === 'linux'
          };
        `
      })
    )
  }
}

const promptIdFor = (jobId: string): string => `${jobId}-prompt`

const successHistory = (promptId: string, jobId: string): Record<string, unknown> => ({
  prompt: [
    0,
    promptId,
    WORKFLOW,
    {
      client_id: 'fake-comfy',
      extra_data: { magicpot_task_id: jobId }
    },
    []
  ],
  outputs: {
    '1': { images: [] }
  },
  status: {
    status_str: 'success',
    completed: true,
    messages: []
  }
})

const sendJson = (response: ServerResponse, value: unknown, statusCode = 200): void => {
  const body = JSON.stringify(value)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  response.end(body)
}

const readJsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > 1024 * 1024) throw new Error('Fake ComfyUI request body exceeded 1 MiB.')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Fake ComfyUI received a non-object JSON body.')
  }
  return parsed as Record<string, unknown>
}

const countRequest = (state: FakeComfyState, method: string, pathname: string): void => {
  const key = `${method} ${pathname}`
  state.counts.set(key, (state.counts.get(key) ?? 0) + 1)
}

const handleFakeComfyRequest = async (
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const state = fakeState
  if (!state) {
    sendJson(response, { error: 'No active fake ComfyUI scenario.' }, 503)
    return
  }
  const method = request.method ?? 'GET'
  const pathname = new URL(request.url ?? '/', fakeOrigin).pathname
  countRequest(state, method, pathname)

  if (method === 'GET' && pathname === '/object_info') {
    sendJson(response, {
      [WORKFLOW_CLASS]: {
        input: { required: { value: ['INT', { default: 0 }] } },
        output: [],
        output_name: [],
        name: WORKFLOW_CLASS,
        display_name: WORKFLOW_CLASS,
        description: 'Fresh process integration node',
        category: 'integration',
        output_node: false
      }
    })
    return
  }
  if (method === 'GET' && pathname === '/queue') {
    sendJson(response, { queue_running: [], queue_pending: [] })
    return
  }
  if (method === 'POST' && pathname === '/prompt') {
    const body = await readJsonBody(request)
    state.promptBodies.push(body)
    const extraData = body.extra_data
    if (extraData && typeof extraData === 'object' && !Array.isArray(extraData)) {
      const taskId = (extraData as Record<string, unknown>).magicpot_task_id
      if (typeof taskId === 'string' && taskId) state.jobId = taskId
    }
    state.completedPromptIds.add(state.promptId)
    if (!state.holdPromptResponse) sendJson(response, { prompt_id: state.promptId })
    return
  }
  if (method === 'GET' && pathname === '/history') {
    sendJson(
      response,
      state.exposeTokenInHistoryAll
        ? { [state.promptId]: successHistory(state.promptId, state.jobId) }
        : {}
    )
    return
  }
  if (method === 'GET' && pathname.startsWith('/history/')) {
    const promptId = decodeURIComponent(pathname.slice('/history/'.length))
    sendJson(
      response,
      state.completedPromptIds.has(promptId)
        ? { [promptId]: successHistory(promptId, state.jobId) }
        : {}
    )
    return
  }
  if (method === 'POST' && (pathname === '/queue' || pathname === '/interrupt')) {
    await readJsonBody(request)
    sendJson(response, {})
    return
  }
  sendJson(response, { error: `Unexpected fake ComfyUI request: ${method} ${pathname}` }, 404)
}

const requestCount = (method: string, pathname: string): number =>
  fakeState?.counts.get(`${method} ${pathname}`) ?? 0

const totalRequestCount = (): number =>
  [...(fakeState?.counts.values() ?? [])].reduce((total, count) => total + count, 0)

const totalPostCount = (): number =>
  [...(fakeState?.counts.entries() ?? [])]
    .filter(([key]) => key.startsWith('POST '))
    .reduce((total, [, count]) => total + count, 0)

const runWorker = <T>(root: string, phase: Phase, scenario: Scenario, jobId: string): Promise<T> =>
  new Promise((resolveWorker, rejectWorker) => {
    execFile(
      process.execPath,
      [workerBundle, root, phase, scenario, jobId, fakeOrigin],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'production',
          ELECTRON_RUN_AS_NODE: '1'
        },
        timeout: 12_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectWorker(
            new Error(
              `TaskQueue fresh-process worker failed.\nstdout:\n${String(stdout)}\nstderr:\n${String(stderr)}`,
              { cause: error }
            )
          )
          return
        }
        const markerLine = String(stdout)
          .split(/\r?\n/u)
          .filter((line) => line.startsWith(RESULT_MARKER))
          .at(-1)
        if (!markerLine) {
          rejectWorker(
            new Error(
              `TaskQueue fresh-process worker returned no marker.\nstdout:\n${String(stdout)}`
            )
          )
          return
        }
        try {
          resolveWorker(JSON.parse(markerLine.slice(RESULT_MARKER.length)) as T)
        } catch (parseError) {
          rejectWorker(
            new Error(
              `TaskQueue fresh-process worker returned invalid marker JSON: ${markerLine}`,
              {
                cause: parseError
              }
            )
          )
        }
      }
    )
  })

const liveProducerChildren = new Set<ChildProcessWithoutNullStreams>()

const terminateLiveProducer = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('exit', () => resolve()))
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await exited
  liveProducerChildren.delete(child)
}

const startLiveProducer = (
  root: string,
  scenario: 'submitting',
  requestedJobId: string
): Promise<Readonly<{ result: ProducerResult; child: ChildProcessWithoutNullStreams }>> =>
  new Promise((resolveProducer, rejectProducer) => {
    const child = spawn(
      process.execPath,
      [workerBundle, root, 'produce', scenario, requestedJobId, fakeOrigin],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          ELECTRON_RUN_AS_NODE: '1'
        },
        windowsHide: true,
        stdio: 'pipe'
      }
    )
    liveProducerChildren.add(child)
    let stdout = ''
    let stderr = ''
    let resolved = false
    const timeout = setTimeout(() => {
      if (!resolved) {
        void terminateLiveProducer(child)
        rejectProducer(
          new Error(
            `Live TaskQueue producer returned no boundary marker.\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        )
      }
    }, 12_000)
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      const markerLine = stdout
        .split(/\r?\n/u)
        .filter((line) => line.startsWith(RESULT_MARKER))
        .at(-1)
      if (!markerLine || resolved) return
      try {
        const result = JSON.parse(markerLine.slice(RESULT_MARKER.length)) as ProducerResult
        resolved = true
        clearTimeout(timeout)
        resolveProducer({ result, child })
      } catch (error) {
        resolved = true
        clearTimeout(timeout)
        void terminateLiveProducer(child)
        rejectProducer(
          new Error(`Live TaskQueue producer returned invalid marker: ${markerLine}`, {
            cause: error
          })
        )
      }
    })
    child.once('error', (error) => {
      liveProducerChildren.delete(child)
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      rejectProducer(error)
    })
    child.once('exit', (code, signal) => {
      liveProducerChildren.delete(child)
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      rejectProducer(
        new Error(
          `Live TaskQueue producer exited before the crash boundary (code=${code}, signal=${signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      )
    })
  })

beforeAll(async () => {
  workerBuildRoot = await mkdtemp(path.join(tmpdir(), 'magicpot-task-queue-fresh-worker-'))
  workerBundle = path.join(workerBuildRoot, 'task-queue-fresh-process-worker.cjs')
  await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [path.join(__dirname, 'taskQueueFreshProcessWorker.ts')],
    outfile: workerBundle,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    define: {
      'import.meta.env.VITE_BUILD_MODE': JSON.stringify('pure'),
      'import.meta.env.VITE_PACKAGE_MODE': JSON.stringify('pure'),
      'import.meta.env.VITE_BUILD_MODE_NAME': JSON.stringify('pure'),
      'import.meta.env.VITE_MAGICPOT_UPDATE_OWNER': JSON.stringify(''),
      'import.meta.env.VITE_MAGICPOT_UPDATE_REPO': JSON.stringify(''),
      'import.meta.env.VITE_MAGICPOT_UPDATE_CHANNEL': JSON.stringify(''),
      'import.meta.env.PACKAGE_VERSION': JSON.stringify('0.0.0-test')
    },
    external: ['node:sqlite'],
    plugins: [electronToolkitUtilsShim],
    alias: {
      electron: path.join(__dirname, '../comfy/sqliteDurabilityElectronStub.ts')
    },
    tsconfig: path.join(repositoryRoot, 'config/tsconfig/tsconfig.node.json')
  })

  fakeServer = createServer((request, response) => {
    void handleFakeComfyRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500)
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    fakeServer!.once('error', reject)
    fakeServer!.listen(0, '127.0.0.1', () => {
      fakeServer!.off('error', reject)
      resolve()
    })
  })
  const address = fakeServer.address() as AddressInfo
  fakeOrigin = `http://127.0.0.1:${address.port}/`
})

afterEach(async () => {
  await Promise.all([...liveProducerChildren].map((child) => terminateLiveProducer(child)))
  fakeState = null
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
})

afterAll(async () => {
  if (fakeServer) {
    fakeServer.closeAllConnections()
    await new Promise<void>((resolve) => fakeServer!.close(() => resolve()))
  }
  if (workerBuildRoot) {
    await rm(workerBuildRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    })
  }
})

describe.sequential('ordinary TaskQueue durability across fresh child processes', () => {
  it('kills a live accepted-response-lost producer and recovers without reposting', async () => {
    const root = await makeTemporaryRoot('magicpot-task-queue-live-crash-')
    const promptId = 'live-crash-accepted-prompt'
    const state: FakeComfyState = {
      jobId: 'pending-live-producer-id',
      promptId,
      exposeTokenInHistoryAll: true,
      holdPromptResponse: true,
      completedPromptIds: new Set(),
      counts: new Map(),
      promptBodies: []
    }
    fakeState = state

    const producer = await startLiveProducer(root, 'submitting', 'live-crash-request')
    try {
      await vi.waitFor(() => expect(requestCount('POST', '/prompt')).toBe(1), {
        timeout: 5_000,
        interval: 10
      })
      expect(producer.result).toMatchObject({
        phase: 'produce',
        scenario: 'submitting',
        durableStatus: 'submitting',
        instanceId: INSTANCE_ID,
        instanceRouteId: expect.any(String)
      })
      expect(state.jobId).toBe(producer.result.jobId)
      expect(state.completedPromptIds).toContain(promptId)
    } finally {
      await terminateLiveProducer(producer.child)
    }

    const registryStore = new MagicAgentEventStore(producer.result.registryPath)
    try {
      const registry = new ComfyInstanceRegistry(registryStore)
      const current = registry.get(INSTANCE_ID)
      if (!current) throw new Error('Live producer did not persist its target registry entry.')
      registry.update({
        id: INSTANCE_ID,
        expectedRevision: current.revision,
        updatedAt: Date.now(),
        idempotencyKey: 'live-crash-conflicting-registry-origin',
        patch: { origin: 'http://127.0.0.1:9/' }
      })
    } finally {
      registryStore.close()
    }

    const firstRecovery = await runWorker<RecoveryResult>(
      root,
      'recover',
      'submitting',
      producer.result.jobId
    )
    expect(firstRecovery).toMatchObject({
      beforeStart: {
        status: 'pending',
        reservation: 1,
        instanceId: INSTANCE_ID,
        instanceRouteId: producer.result.instanceRouteId
      },
      final: {
        status: 'completed',
        promptId,
        reservation: 0,
        instanceRouteId: producer.result.instanceRouteId
      },
      durableBeforeStop: { status: 'succeeded', promptId },
      durableAfterStop: { status: 'succeeded', promptId },
      capacityAvailableBeforeStart: false,
      capacityAvailableAtFinal: true,
      reservationBeforeStop: 0,
      reservationAfterStop: 0
    })
    expect(requestCount('POST', '/prompt')).toBe(1)
    expect(state.promptBodies).toHaveLength(1)
    expect(requestCount('GET', '/history')).toBeGreaterThanOrEqual(1)
    expect(requestCount('GET', `/history/${promptId}`)).toBeGreaterThanOrEqual(1)

    const requestsAfterRecovery = totalRequestCount()
    const terminalRecovery = await runWorker<RecoveryResult>(
      root,
      'recover',
      'submitting',
      producer.result.jobId
    )
    expect(terminalRecovery).toMatchObject({
      beforeStart: { status: 'completed', reservation: 0 },
      final: { status: 'completed', reservation: 0 },
      durableBeforeStop: { status: 'succeeded', promptId },
      durableAfterStop: { status: 'succeeded', promptId },
      capacityAvailableBeforeStart: true,
      capacityAvailableAtFinal: true,
      reservationBeforeStop: 0,
      reservationAfterStop: 0
    })
    expect(totalRequestCount()).toBe(requestsAfterRecovery)
    expect(requestCount('POST', '/prompt')).toBe(1)
  }, 35_000)

  it.each(scenarios)(
    '$name',
    async (matrix) => {
      const root = await makeTemporaryRoot(`magicpot-task-queue-${matrix.scenario}-`)
      const jobId = `fresh-process-${matrix.scenario}`
      const promptId = promptIdFor(jobId)
      fakeState = {
        jobId,
        promptId,
        exposeTokenInHistoryAll: matrix.scenario === 'submitting',
        holdPromptResponse: false,
        completedPromptIds: new Set(
          matrix.scenario === 'submitting' || matrix.scenario === 'submitted' ? [promptId] : []
        ),
        counts: new Map(),
        promptBodies: []
      }

      const seed = await runWorker<SeedResult>(root, 'seed', matrix.scenario, jobId)
      expect(totalRequestCount()).toBe(0)
      const recovery = await runWorker<RecoveryResult>(root, 'recover', matrix.scenario, jobId)

      const expectedJobsPath = path.join(root, 'ordinary-task-queue', 'jobs.sqlite')
      const expectedRoutePath = path.join(root, 'comfy-batch', 'state.sqlite')
      const expectedRegistryPath = path.join(root, 'comfy-batch', 'instances.sqlite')

      expect(seed).toMatchObject({
        phase: 'seed',
        scenario: matrix.scenario,
        jobId,
        nodeEnv: 'production',
        electronRunAsNode: '1',
        jobsPath: expectedJobsPath,
        routePath: expectedRoutePath,
        registryPath: expectedRegistryPath,
        seededStatus: matrix.seededStatus,
        cleanupAfterRun: false,
        registryExists: matrix.registryExists,
        route: {
          instanceId: INSTANCE_ID,
          origin: fakeOrigin,
          kind: 'local'
        }
      })
      expect(seed.jobsPath).not.toBe(seed.routePath)
      expect(seed.jobsPath).not.toBe(seed.registryPath)

      expect(recovery).toMatchObject({
        phase: 'recover',
        scenario: matrix.scenario,
        jobId,
        nodeEnv: 'production',
        electronRunAsNode: '1',
        jobsPath: expectedJobsPath,
        routePath: expectedRoutePath,
        registryPath: expectedRegistryPath,
        registryExistsBeforeInit: matrix.registryExists,
        registryExistsAfterStop: matrix.registryExists,
        capturedInsideBeforeStart: true,
        beforeStart: {
          status: matrix.beforeStatus,
          reservation: matrix.beforeReservation
        },
        final: {
          status: matrix.finalStatus,
          reservation: matrix.finalReservation
        },
        capacityAvailableBeforeStart: matrix.beforeReservation === 0,
        capacityAvailableAtFinal: matrix.finalReservation === 0,
        reservationBeforeStop: matrix.finalReservation,
        reservationAfterStop: 0,
        durableBeforeStop: {
          status: matrix.finalDurableStatus
        },
        durableAfterStop: {
          status: matrix.finalDurableStatus
        },
        shutdownOrder: ['stopTaskQueue', 'closeComfyOutputRouteStore', 'eventStore.close']
      })
      expect(seed.pid).toBeGreaterThan(0)
      expect(recovery.pid).toBeGreaterThan(0)
      expect(seed.pid).not.toBe(process.pid)
      expect(recovery.pid).not.toBe(process.pid)
      expect(recovery.beforeStart.queue.running).toBe(0)

      if (matrix.beforeStatus === 'pending') {
        expect(recovery.beforeStart.queue).toMatchObject({ pending: 1, unknown: 0, completed: 0 })
      } else {
        expect(recovery.beforeStart.queue).toMatchObject({ pending: 0, unknown: 1, completed: 0 })
      }

      expect(requestCount('POST', '/prompt')).toBe(matrix.promptPosts)
      expect(fakeState.promptBodies).toHaveLength(matrix.promptPosts)
      expect(requestCount('POST', '/free')).toBe(0)
      if (matrix.promptPosts === 1) {
        expect(fakeState.promptBodies[0]).toEqual(
          expect.objectContaining({
            prompt: WORKFLOW,
            extra_data: expect.objectContaining({ magicpot_task_id: jobId })
          })
        )
      } else {
        expect(totalPostCount()).toBe(0)
      }

      if (matrix.scenario === 'queued') {
        expect(requestCount('GET', '/object_info')).toBeGreaterThanOrEqual(1)
        expect(requestCount('GET', '/queue')).toBeGreaterThanOrEqual(1)
        expect(recovery.beforeStart.instanceRouteId).toBeNull()
      } else {
        expect(seed.registryExists).toBe(false)
        expect(recovery.registryExistsBeforeInit).toBe(false)
        expect(recovery.beforeStart.instanceId).toBe(INSTANCE_ID)
        expect(recovery.beforeStart.instanceRouteId).toBe(seed.route.routeId)
      }

      if (matrix.scenario === 'leased' || matrix.scenario === 'prepared') {
        expect(recovery.final.instanceRouteId).toBe(seed.route.routeId)
      }
      if (matrix.scenario === 'prepared') {
        expect(requestCount('GET', '/object_info')).toBe(0)
      }
      if (matrix.scenario === 'submitting') {
        expect(requestCount('GET', '/history')).toBeGreaterThanOrEqual(1)
        expect(recovery.beforeStart.promptId).toBe(promptId)
        expect(recovery.final.promptId).toBe(promptId)
      }
      if (matrix.scenario === 'submitted') {
        expect(requestCount('GET', `/history/${promptId}`)).toBeGreaterThanOrEqual(1)
        expect(recovery.beforeStart.promptId).toBe(promptId)
        expect([
          recovery.beforeStart.reservation,
          recovery.final.reservation,
          recovery.reservationAfterStop
        ]).toEqual([1, 0, 0])
      }
      if (matrix.scenario === 'unknown') {
        expect(recovery.beforeStart.cancelRequested).toBe(false)
        expect(recovery.final.cancelRequested).toBe(false)
        expect(recovery.durableBeforeStop.cancelRequested).toBe(false)
      }
      if (matrix.scenario === 'cancel_requested') {
        expect(recovery.beforeStart.cancelRequested).toBe(true)
        expect(recovery.final.cancelRequested).toBe(true)
        expect(recovery.durableBeforeStop.cancelRequested).toBe(true)
        expect(recovery.durableAfterStop.cancelRequested).toBe(true)
      }
    },
    30_000
  )
})
