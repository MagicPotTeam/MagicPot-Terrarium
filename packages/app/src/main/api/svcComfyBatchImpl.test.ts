import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ComfyBatchStatus, StartComfyBatchReq } from '@shared/api/svcComfyBatch'
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

vi.mock(import('../comfy/batchRunner'), () => ({
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
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(configModule.getConfig).mockReturnValue({
      ...DEFAULT_CONFIG,
      comfy_batch_profiles: [
        {
          id: 'one',
          name: 'One',
          baseUrl: 'http://127.0.0.1:8188',
          enabled: true,
          maxConcurrency: 1
        }
      ]
    } as Config)
    vi.mocked(configModule.saveConfig).mockResolvedValue(undefined)
    vi.mocked(buildEnvModule.getBuildEnv).mockReturnValue(DEFAULT_BUILD_ENV)
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
              inputs: [],
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

  it('returns a running job immediately and exposes live runner progress', async () => {
    let current = status('job-1', 'idle')
    let resolveRun!: (value: ComfyBatchStatus) => void
    const runPromise = new Promise<ComfyBatchStatus>((resolve) => {
      resolveRun = resolve
    })
    const runner = {
      jobId: 'job-1',
      get status() {
        return current
      },
      startingStatus: vi.fn(() => {
        current = status('job-1', 'running')
        return current
      }),
      run: vi.fn(() => runPromise),
      cancel: vi.fn()
    }
    vi.mocked(ComfyBatchRunner).mockImplementation(function MockRunner() {
      return runner as never
    })

    const svc = new ComfyBatchSvcImpl()
    await expect(svc.start(request)).resolves.toMatchObject({
      status: { jobId: 'job-1', state: 'running' }
    })
    current = { ...current, running: 0, success: 1 }
    await expect(svc.status({ jobId: 'job-1' })).resolves.toMatchObject({
      status: { success: 1 }
    })
    await expect(svc.start(request)).rejects.toThrow(/already running/i)

    current = { ...current, state: 'completed', running: 0 }
    resolveRun(current)
    await runPromise
  })

  it('serializes concurrent starts around asynchronous Quick App validation', async () => {
    let current = status('job-1', 'idle')
    let resolveRun!: (value: ComfyBatchStatus) => void
    const runPromise = new Promise<ComfyBatchStatus>((resolve) => {
      resolveRun = resolve
    })
    const runner = {
      jobId: 'job-1',
      get status() {
        return current
      },
      startingStatus: vi.fn(() => {
        current = status('job-1', 'running')
        return current
      }),
      run: vi.fn(() => runPromise),
      cancel: vi.fn()
    }
    vi.mocked(ComfyBatchRunner).mockImplementation(function MockRunner() {
      return runner as never
    })
    delayQAppLookup = true
    const svc = new ComfyBatchSvcImpl()
    const first = svc.start(request)
    const second = svc.start(request)
    await vi.waitFor(() => expect(releaseQAppLookup).toBeTypeOf('function'))
    releaseQAppLookup?.()

    await expect(first).resolves.toMatchObject({ status: { state: 'running' } })
    await expect(second).rejects.toThrow(/already running/i)
    current = { ...current, state: 'completed', running: 0 }
    resolveRun(current)
    await runPromise
  })
})
