import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ComfyBatchStatus, StartComfyBatchReq } from '@shared/api/svcComfyBatch'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as configModule from '../config/config'
import * as buildEnvModule from '../config/buildEnv'
import { ComfyBatchRunner } from '../comfy/batchRunner'
import { QAppFSCli } from '../qApp/fs'
import { ComfyBatchSvcImpl } from './svcComfyBatchImpl'

vi.mock(import('../config/config'), () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn()
}))

vi.mock(import('../config/buildEnv'), () => ({
  getBuildEnv: vi.fn()
}))

vi.mock(import('../comfy/batchRunner'), async (importOriginal) => ({
  ...(await importOriginal()),
  ComfyBatchRunner: vi.fn()
}))

vi.mock(import('../qApp/fs'), () => ({
  QAppFSCli: vi.fn()
}))

const request: StartComfyBatchReq = {
  sourceDir: '/tmp/source',
  qAppKey: 'qapp',
  workflow: {
    '1': { class_type: 'LoadImage', inputs: { image: '' } },
    '2': { class_type: 'SaveImage', inputs: {} }
  },
  imageInputSlot: '$.1.inputs.image',
  outputNodeIds: ['2']
}

function status(jobId: string, state: ComfyBatchStatus['state']): ComfyBatchStatus {
  return {
    jobId,
    state,
    total: 1,
    success: 0,
    failed: 0,
    skipped: 0,
    running: state === 'running' ? 1 : 0,
    pending: 0,
    failedFiles: []
  }
}

let releaseQAppLookup: (() => void) | undefined
let delayQAppLookup = false

describe('ComfyBatchSvcImpl live status', () => {
  let dataDir: string

  beforeEach(async () => {
    const testRoot = path.join(process.cwd(), '.tmp-comfy-batch-tests')
    await fs.mkdir(testRoot, { recursive: true })
    dataDir = await fs.mkdtemp(path.join(testRoot, 'job-'))
    vi.clearAllMocks()
    vi.mocked(configModule.getConfig).mockReturnValue({
      ...DEFAULT_CONFIG,
      comfy_batch_profiles: [
        {
          id: 'one',
          baseUrl: 'http://127.0.0.1:8188',
          enabled: true,
          maxConcurrency: 1
        }
      ]
    } as Config)
    vi.mocked(configModule.saveConfig).mockResolvedValue(undefined)
    vi.mocked(buildEnvModule.getBuildEnv).mockReturnValue({
      ...DEFAULT_BUILD_ENV,
      pathMap: { ...DEFAULT_BUILD_ENV.pathMap, data: dataDir }
    })
    delayQAppLookup = false
    releaseQAppLookup = undefined
    vi.mocked(QAppFSCli).mockImplementation(function MockQAppFs() {
      return {
        getQApp: async () => {
          if (delayQAppLookup) {
            await new Promise<void>((resolve) => {
              releaseQAppLookup = resolve
            })
          }
          return {
            cfg: {
              icon: '',
              inputs: [
                { label: '图片', component: 'InputComfyImage', slot: request.imageInputSlot }
              ],
              outputNodeIds: request.outputNodeIds,
              batchProcess: { enabled: true, imageInputSlot: request.imageInputSlot }
            },
            workflow: {
              ...request.workflow,
              '1': { ...request.workflow['1'], inputs: { image: 'template' } }
            },
            manifest: { name: 'qapp', version: '1.0.0' }
          }
        }
      } as never
    })
  })

  it('uses the unified ComfyUI endpoint when no batch profile is configured', async () => {
    vi.mocked(configModule.getConfig).mockReturnValue({
      ...DEFAULT_CONFIG,
      use_remote_comfyui: true,
      remote_comfyui_config: {
        ...DEFAULT_CONFIG.remote_comfyui_config,
        comfyui_origin: 'https://remote.example.com:9443'
      },
      comfy_batch_profiles: []
    } as Config)
    const svc = new ComfyBatchSvcImpl()

    await expect(svc.listProfiles({})).resolves.toEqual({
      profiles: [
        expect.objectContaining({
          id: 'default',
          baseUrl: 'https://remote.example.com:9443/'
        })
      ]
    })
    await expect(svc.replaceProfiles({ profiles: [] })).resolves.toEqual({ profiles: [] })
    expect(configModule.saveConfig).toHaveBeenCalledWith({ comfy_batch_profiles: [] })
  })

  it('accepts a legacy QApp with explicit image input and output bindings', async () => {
    const legacyWorkflow = {
      '1': { class_type: 'LoadImage', inputs: { image: 'template' } },
      '2': { class_type: 'SaveImage', inputs: {} }
    }
    vi.mocked(QAppFSCli).mockImplementation(function MockLegacyQAppFs() {
      return {
        getQApp: async () => ({
          cfg: {
            icon: '',
            inputs: [{ label: '图片', component: 'InputComfyImage', slot: '$.1.inputs.image' }],
            outputNodeIds: ['2'],
            autoInputs: []
          },
          workflow: legacyWorkflow,
          manifest: { name: 'legacy', version: '1.0.0' }
        })
      } as never
    })
    const runner = {
      jobId: 'generated-legacy-job',
      status: status('generated-legacy-job', 'running'),
      startingStatus: vi.fn(() => status('generated-legacy-job', 'running')),
      run: vi.fn(async () => status('generated-legacy-job', 'completed')),
      cancel: vi.fn()
    }
    vi.mocked(ComfyBatchRunner).mockImplementation(function MockRunner() {
      return runner as never
    })

    const result = await new ComfyBatchSvcImpl().start({
      ...request,
      qAppKey: 'legacy',
      workflow: legacyWorkflow
    })
    expect(result.status).toMatchObject({ state: 'queued' })
    expect(result.status.jobId).toEqual(expect.any(String))
    expect(ComfyBatchRunner).toHaveBeenCalled()
  })

  it('queues a second start in FIFO order and exposes live runner progress', async () => {
    const runners: Array<{
      jobId: string
      status: ComfyBatchStatus
      startingStatus: ReturnType<typeof vi.fn>
      run: ReturnType<typeof vi.fn>
      cancel: ReturnType<typeof vi.fn>
    }> = []
    const resolveRuns: Array<(value: ComfyBatchStatus) => void> = []
    vi.mocked(ComfyBatchRunner).mockImplementation(
      function MockRunner(_request, _profiles, options) {
        const jobId = options?.jobId || `runner-${runners.length + 1}`
        let current = status(jobId, 'idle')
        let resolveRun!: (value: ComfyBatchStatus) => void
        const runPromise = new Promise<ComfyBatchStatus>((resolve) => {
          resolveRun = resolve
        })
        const runner = {
          jobId,
          get status() {
            return current
          },
          startingStatus: vi.fn(() => {
            current = status(jobId, 'running')
            return current
          }),
          run: vi.fn(() => runPromise),
          cancel: vi.fn()
        }
        runners.push(runner)
        resolveRuns.push((value) => {
          current = value
          resolveRun(value)
        })
        return runner as never
      }
    )

    const svc = new ComfyBatchSvcImpl()
    const first = await svc.start(request)
    const second = await svc.start(request)
    expect(first.status.state).toBe('queued')
    expect(second.status.state).toBe('queued')
    expect(second.status.queuePosition).toBeGreaterThan(first.status.queuePosition || 0)
    expect(first.status.jobId).not.toBe(second.status.jobId)

    await vi.waitFor(() => expect(runners).toHaveLength(1))
    await vi.waitFor(() => expect(runners[0].startingStatus).toHaveBeenCalled())
    expect((await svc.status({ jobId: second.status.jobId })).status.state).toBe('queued')

    resolveRuns[0]({ ...status(first.status.jobId!, 'completed'), success: 1 })
    await vi.waitFor(() => expect(runners).toHaveLength(2))
    expect(runners[1].startingStatus).toHaveBeenCalled()
    resolveRuns[1]({ ...status(second.status.jobId!, 'completed'), success: 1 })
    await vi.waitFor(() => expect(runners[1].run).toHaveBeenCalled())
  })

  it('rejects an explicitly disabled legacy-capable QApp', async () => {
    vi.mocked(QAppFSCli).mockImplementation(function MockDisabledQAppFs() {
      return {
        getQApp: async () => ({
          cfg: {
            icon: '',
            inputs: [{ label: '图片', component: 'InputComfyImage', slot: '$.1.inputs.image' }],
            outputNodeIds: ['2'],
            batchProcess: { enabled: false, imageInputSlot: '$.1.inputs.image' },
            autoInputs: []
          },
          workflow: request.workflow,
          manifest: { name: 'disabled', version: '1.0.0' }
        })
      } as never
    })

    await expect(new ComfyBatchSvcImpl().start(request)).rejects.toThrow(/bindings changed/i)
  })

  it('serializes concurrent starts around asynchronous Quick App validation', async () => {
    const runners: Array<{ jobId: string; resolve: (status: ComfyBatchStatus) => void }> = []
    vi.mocked(ComfyBatchRunner).mockImplementation(
      function MockRunner(_request, _profiles, options) {
        const jobId = options?.jobId || `runner-${runners.length + 1}`
        let resolve!: (status: ComfyBatchStatus) => void
        const promise = new Promise<ComfyBatchStatus>((nextResolve) => {
          resolve = nextResolve
        })
        let current = status(jobId, 'idle')
        const runner = {
          jobId,
          get status() {
            return current
          },
          startingStatus: vi.fn(() => {
            current = status(jobId, 'running')
            return current
          }),
          run: vi.fn(() => promise),
          cancel: vi.fn()
        }
        runners.push({
          jobId,
          resolve: (next) => {
            current = next
            resolve(next)
          }
        })
        return runner as never
      }
    )
    delayQAppLookup = true
    const svc = new ComfyBatchSvcImpl()
    const first = svc.start(request)
    const second = svc.start(request)
    await vi.waitFor(() => expect(releaseQAppLookup).toBeTypeOf('function'))
    releaseQAppLookup?.()
    delayQAppLookup = false
    const firstResult = await first
    const secondResult = await second
    expect(firstResult.status.state).toBe('queued')
    expect(secondResult.status.state).toBe('queued')
    expect(secondResult.status.queuePosition).toBeGreaterThan(firstResult.status.queuePosition || 0)
    await vi.waitFor(() => expect(runners).toHaveLength(1))
    runners[0].resolve({ ...status(firstResult.status.jobId!, 'completed'), success: 1 })
    await vi.waitFor(() => expect(runners).toHaveLength(2))
    runners[1].resolve({ ...status(secondResult.status.jobId!, 'completed'), success: 1 })
    await vi.waitFor(() => expect(runners[1].resolve).toBeDefined())
  })

  it('persists queued descriptors and restores running jobs as queued', async () => {
    const storePath = path.join(dataDir, 'comfy-batch-jobs.json')
    await fs.writeFile(
      storePath,
      JSON.stringify({
        version: 2,
        latestJobId: 'restored-running',
        nextSequence: 3,
        jobs: [
          {
            request,
            status: { ...status('restored-running', 'running'), submittedAt: 10 },
            submittedAt: 10,
            sequence: 1
          },
          {
            request: { ...request, sourceDir: '/tmp/queued' },
            status: { ...status('restored-queued', 'queued'), submittedAt: 11 },
            submittedAt: 11,
            sequence: 2
          }
        ]
      }),
      'utf8'
    )

    const svc = new ComfyBatchSvcImpl()
    const jobs = await svc.listJobs({})
    expect(jobs.jobs.map((job) => job.jobId)).toEqual(['restored-queued', 'restored-running'])
    expect(jobs.jobs.find((job) => job.jobId === 'restored-running')).toMatchObject({
      state: 'queued',
      submittedAt: 10
    })
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      jobs: Array<{ status: ComfyBatchStatus }>
    }
    expect(persisted.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: expect.objectContaining({ state: 'queued' }) })
      ])
    )
  })

  it('does not expose a completed state when persisted items failed', async () => {
    const storePath = path.join(dataDir, 'comfy-batch-jobs.json')
    await fs.writeFile(
      storePath,
      JSON.stringify({
        version: 2,
        latestJobId: 'partial-job',
        nextSequence: 2,
        jobs: [
          {
            request,
            status: {
              ...status('partial-job', 'completed'),
              total: 4,
              success: 1,
              failed: 3,
              pending: 0,
              running: 0,
              finishedAt: Date.now()
            },
            submittedAt: 10,
            sequence: 1
          }
        ]
      }),
      'utf8'
    )

    const jobs = await new ComfyBatchSvcImpl().listJobs({})
    expect(jobs.jobs[0]).toMatchObject({
      state: 'error',
      success: 1,
      failed: 3,
      error: '3 batch item(s) failed'
    })
  })

  it('rejects retry while running and keeps cancellation durable', async () => {
    let resolveRun!: (value: ComfyBatchStatus) => void
    vi.mocked(ComfyBatchRunner).mockImplementation(
      function MockRunner(_request, _profiles, options) {
        const jobId = options?.jobId || 'running-job'
        let current = status(jobId, 'idle')
        const runPromise = new Promise<ComfyBatchStatus>((resolve) => {
          resolveRun = resolve
        })
        return {
          jobId,
          get status() {
            return current
          },
          startingStatus: vi.fn(() => {
            current = status(jobId, 'running')
            return current
          }),
          run: vi.fn(() => runPromise),
          cancel: vi.fn(() => {
            current = status(jobId, 'cancelled')
          })
        } as never
      }
    )
    const svc = new ComfyBatchSvcImpl()
    const started = await svc.start(request)
    await vi.waitFor(() => expect(ComfyBatchRunner).toHaveBeenCalled())
    await expect(svc.retryFailed({ jobId: started.status.jobId! })).rejects.toThrow(
      /queued or running/i
    )
    const cancelled = await svc.cancel({ jobId: started.status.jobId! })
    expect(cancelled.status.state).toBe('cancelled')
    resolveRun({ ...status(started.status.jobId!, 'completed'), success: 1 })
    await vi.waitFor(async () =>
      expect((await svc.status({ jobId: started.status.jobId! })).status.state).toBe('cancelled')
    )
    const persisted = JSON.parse(
      await fs.readFile(path.join(dataDir, 'comfy-batch-jobs.json'), 'utf8')
    ) as { jobs: Array<{ status: ComfyBatchStatus; cancelRequested?: boolean }> }
    expect(persisted.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cancelRequested: true,
          status: expect.objectContaining({ state: 'cancelled' })
        })
      ])
    )
  })
})
