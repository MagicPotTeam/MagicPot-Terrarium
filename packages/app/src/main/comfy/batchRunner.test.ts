import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ComfyBatchItemTiming,
  ComfyBatchProfile,
  ComfyBatchStatus,
  StartComfyBatchReq
} from '@shared/api/svcComfyBatch'
import type { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import {
  assertNoComfyBatchOutputCollisions,
  ComfyBatchRunner,
  getComfyBatchInputDir,
  getComfyBatchManifestPath,
  getComfyBatchOutputDir,
  getComfyBatchOutputRelativePath,
  selectBoundOutputImage,
  scanComfyBatchImages,
  LeastLoadRoundRobinScheduler,
  atomicCommitPng,
  buildComfyBatchPlanFingerprint,
  COMFY_BATCH_HISTORY_POLL_MS,
  isValidPng,
  validateComfyBatchBindings,
  NO_RUNTIME_RETRY_WINDOW_MS
} from './batchRunner'
import { ComfyBatchHttpError } from './batchHttp'
import type { ComfyBatchHttpClient } from './batchHttp'

const temporaryDirectories: string[] = []

async function createTempDir(): Promise<string> {
  await fs.mkdir('/tmp', { recursive: true })
  const directory = await fs.mkdtemp('/tmp/magicpot-comfy-batch-')
  const resolved = path.resolve(directory)
  temporaryDirectories.push(resolved)
  return resolved
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

const profile = (id: string): ComfyBatchProfile => ({
  id,
  baseUrl: `http://${id}.example`,
  enabled: true,
  maxConcurrency: 1
})

type Runtime = { profile: ComfyBatchProfile; inflight: number; id: string }

type EtaRunnerInternals = {
  statusValue: ComfyBatchStatus
  recentItems: ComfyBatchItemTiming[]
  runtimes: Array<{
    profile: ComfyBatchProfile
    inflight: number
    compatible: boolean
    available: boolean
  }>
}

function runtime(id: string, inflight = 0): Runtime {
  return { profile: profile(id), inflight, id }
}

const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
)

function objectInfo(): ObjectInfoMap {
  return {
    LoadImage: {
      input: { required: { image: [['example.png'], { image_upload: true }] } },
      output: ['IMAGE']
    },
    SaveImage: { output_node: true, output: [] }
  }
}

const makeBatchRequest = (sourceDir: string): StartComfyBatchReq => ({
  sourceDir,
  qAppKey: 'batch-test',
  workflow: {
    '1': { class_type: 'LoadImage', inputs: { image: '' } },
    '2': { class_type: 'SaveImage', inputs: {} }
  },
  imageInputSlot: '$.1.inputs.image',
  outputNodeIds: ['2']
})

type FakeComfyClientOverrides = Partial<
  Pick<ComfyBatchHttpClient, 'probe' | 'objectInfo' | 'uploadImage' | 'prompt' | 'history' | 'view'>
>

const createFakeComfyClient = (overrides: FakeComfyClientOverrides = {}): ComfyBatchHttpClient =>
  ({
    probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
    objectInfo: async () => objectInfo(),
    uploadImage: async () => ({ filename: 'upload.png', subfolder: '', type: 'input' as const }),
    prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => promptId,
    history: async (promptId: string) => ({
      [promptId]: {
        outputs: { '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } },
        status: { status_str: 'success', completed: true, messages: [] }
      }
    }),
    view: async () => new Uint8Array(validPng),
    ...overrides
  }) as unknown as ComfyBatchHttpClient

describe('Comfy batch paths and discovery', () => {
  it('uses an adjacent input staging directory', async () => {
    const sourceDir = await createTempDir()
    expect(getComfyBatchInputDir(sourceDir)).toBe(`${sourceDir}.input`)
  })

  it('suffixes all batch artifact paths with a valid run key', async () => {
    const sourceDir = await createTempDir()
    const runKey = '20260828213645'
    expect(getComfyBatchInputDir(sourceDir, runKey)).toBe(`${sourceDir}.input.${runKey}`)
    expect(getComfyBatchOutputDir(sourceDir, runKey)).toBe(`${sourceDir}.output.${runKey}`)
    expect(getComfyBatchManifestPath(sourceDir, runKey)).toBe(
      path.join(`${sourceDir}.output.${runKey}`, '.magicpot-batch', 'manifest.json')
    )
  })

  it('rejects unsafe run keys before using them in a path', async () => {
    const sourceDir = await createTempDir()
    expect(() => getComfyBatchInputDir(sourceDir, '../escape')).toThrow(/run key/i)
  })

  it('uses the run key in the runner output status', async () => {
    const sourceDir = await createTempDir()
    const runKey = '20260828213645'
    const runner = new ComfyBatchRunner(makeBatchRequest(sourceDir), [profile('one')], { runKey })
    expect(runner.status.outputDir).toBe(getComfyBatchOutputDir(sourceDir, runKey))
  })

  it('uses only the adjacent .output directory and preserves relative image paths', async () => {
    const sourceDir = await createTempDir()
    await fs.mkdir(path.join(sourceDir, 'nested'))
    await fs.writeFile(path.join(sourceDir, 'cover.jpg'), 'jpg')
    await fs.writeFile(path.join(sourceDir, 'nested', 'photo.webp'), 'webp')
    await fs.writeFile(path.join(sourceDir, 'nested', 'ignore.txt'), 'text')

    const sources = await scanComfyBatchImages(sourceDir)

    expect(getComfyBatchOutputDir(sourceDir)).toBe(`${sourceDir}.output`)
    expect(getComfyBatchOutputRelativePath('nested/photo.webp')).toBe(
      path.join('nested', 'photo.png')
    )
    expect(sources.map((source) => source.relativePath)).toEqual([
      'cover.jpg',
      path.join('nested', 'photo.webp')
    ])
    await expect(fs.stat(`${sourceDir}.work`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects two sources that would overwrite the same PNG', () => {
    expect(() =>
      assertNoComfyBatchOutputCollisions([
        { absolutePath: '/tmp/a.jpg', relativePath: 'a.jpg', size: 1, mtimeMs: 1, sha256: 'a' },
        { absolutePath: '/tmp/a.webp', relativePath: 'a.webp', size: 1, mtimeMs: 1, sha256: 'b' }
      ])
    ).toThrow(/collision/i)
  })

  it('hashes multiple source images concurrently during discovery', async () => {
    const sourceDir = await createTempDir()
    await Promise.all(
      ['first.jpg', 'second.jpg', 'third.jpg', 'fourth.jpg'].map((filename) =>
        fs.writeFile(path.join(sourceDir, filename), filename)
      )
    )

    let activeReads = 0
    let maxActiveReads = 0
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      activeReads += 1
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      await new Promise((resolve) => setTimeout(resolve, 20))
      try {
        return fsSync.readFileSync(args[0] as fsSync.PathLike, args[1] as never) as never
      } finally {
        activeReads -= 1
      }
    })

    const sources = await scanComfyBatchImages(sourceDir)

    expect(sources).toHaveLength(4)
    expect(maxActiveReads).toBeGreaterThan(1)
  })

  it('checks each existing output PNG with one file read when resuming', async () => {
    const sourceDir = await createTempDir()
    await fs.writeFile(path.join(sourceDir, 'source.jpg'), 'source')
    const fakeClient = createFakeComfyClient()
    await new ComfyBatchRunner(makeBatchRequest(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    }).run()

    const outputPath = path.join(`${sourceDir}.output`, 'source.png')
    let outputReads = 0
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const candidate = typeof args[0] === 'string' ? args[0] : String(args[0])
      if (path.resolve(candidate) === path.resolve(outputPath)) outputReads += 1
      return fsSync.readFileSync(args[0] as fsSync.PathLike, args[1] as never) as never
    })

    const resumed = await new ComfyBatchRunner(makeBatchRequest(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    }).run()

    expect(resumed).toMatchObject({ state: 'completed', skipped: 1, success: 0 })
    expect(outputReads).toBe(1)
  })

  it('migrates an existing output without rerunning a legacy task', async () => {
    const sourceDir = await createTempDir()
    await fs.writeFile(path.join(sourceDir, 'source.jpg'), 'source')
    const request = makeBatchRequest(sourceDir)
    const sourceSha256 = createHash('sha256').update('source').digest('hex')
    await fs.mkdir(getComfyBatchOutputDir(sourceDir), { recursive: true })
    await atomicCommitPng(path.join(getComfyBatchOutputDir(sourceDir), 'source.png'), validPng, {
      sourceSha256,
      planFingerprint: buildComfyBatchPlanFingerprint(request)
    })
    let promptCalls = 0
    const fakeClient = createFakeComfyClient({
      prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
        promptCalls += 1
        return promptId
      }
    })

    const status = await new ComfyBatchRunner(request, [profile('one')], {
      createClient: () => fakeClient
    }).run()

    expect(status).toMatchObject({ state: 'completed', skipped: 1, success: 0 })
    expect(promptCalls).toBe(0)
    await expect(fs.stat(path.join(sourceDir, 'source.jpg'))).resolves.toBeDefined()
  })

  it('keeps failed staged images for resume and does not reread the source image', async () => {
    const sourceDir = await createTempDir()
    const sourcePath = path.join(sourceDir, 'pending.jpg')
    await fs.writeFile(sourcePath, 'source')
    const failedClient = createFakeComfyClient({
      uploadImage: async () => {
        throw new Error('temporary failure')
      }
    })
    const firstRunner = new ComfyBatchRunner(makeBatchRequest(sourceDir), [profile('one')], {
      createClient: () => failedClient
    })
    const firstPromise = firstRunner.run()
    await vi.waitFor(() => expect(firstRunner.status.running).toBeGreaterThan(0))
    firstRunner.cancel()
    const first = await firstPromise
    expect(first).toMatchObject({ state: 'cancelled', failed: 0, failedFiles: [] })

    const inputPath = path.join(getComfyBatchInputDir(sourceDir), 'pending.jpg')
    await expect(fs.stat(inputPath)).resolves.toBeDefined()
    await expect(
      fs.stat(path.join(getComfyBatchInputDir(sourceDir), '.magicpot-batch-input.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    const checkpoint = JSON.parse(
      await fs.readFile(getComfyBatchManifestPath(sourceDir), 'utf8')
    ) as { version: number; sourceDir: string; outputDir: string; items: Record<string, unknown> }
    expect(checkpoint.version).toBe(3)
    expect(checkpoint.sourceDir).toBe(path.resolve(sourceDir))
    expect(checkpoint.outputDir).toBe(getComfyBatchOutputDir(sourceDir))
    expect(Object.keys(checkpoint)).not.toContain('relativePaths')

    const reads: string[] = []
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const candidate = typeof args[0] === 'string' ? args[0] : String(args[0])
      reads.push(path.resolve(candidate))
      return fsSync.readFileSync(args[0] as fsSync.PathLike, args[1] as never) as never
    })
    const successfulClient = createFakeComfyClient()
    const resumed = await new ComfyBatchRunner(makeBatchRequest(sourceDir), [profile('one')], {
      createClient: () => successfulClient
    }).run()

    expect(resumed).toMatchObject({ state: 'completed', success: 1, failed: 0 })
    expect(reads).toContain(path.resolve(inputPath))
    expect(reads).not.toContain(path.resolve(sourcePath))
    await expect(fs.stat(inputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resumes from staged files without an input manifest', async () => {
    const sourceDir = await createTempDir()
    const inputDir = getComfyBatchInputDir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'first.jpg'), 'first')
    await fs.writeFile(path.join(sourceDir, 'second.jpg'), 'second')
    await fs.mkdir(inputDir, { recursive: true })
    await fs.copyFile(path.join(sourceDir, 'first.jpg'), path.join(inputDir, 'first.jpg'))
    await fs.copyFile(path.join(sourceDir, 'second.jpg'), path.join(inputDir, 'second.jpg'))

    let releaseSecondRead!: () => void
    const secondReadBlocked = new Promise<void>((resolve) => {
      releaseSecondRead = resolve
    })
    let firstPromptStarted!: () => void
    const firstPrompt = new Promise<void>((resolve) => {
      firstPromptStarted = resolve
    })
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const candidate = path.resolve(String(args[0]))
      if (candidate === path.resolve(path.join(inputDir, 'second.jpg'))) await secondReadBlocked
      return fsSync.readFileSync(args[0] as fsSync.PathLike, args[1] as never) as never
    })
    const fakeClient = createFakeComfyClient({
      prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
        firstPromptStarted()
        return promptId
      }
    })

    const runPromise = new ComfyBatchRunner(makeBatchRequest(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    }).run()
    const startedBeforeWholeScan = await Promise.race([
      firstPrompt.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))
    ])
    releaseSecondRead()

    expect(startedBeforeWholeScan).toBe(true)
    await expect(runPromise).resolves.toMatchObject({ state: 'completed', success: 2 })
  })

  it('migrates a legacy input snapshot without restaging completed files', async () => {
    const sourceDir = await createTempDir()
    const request = makeBatchRequest(sourceDir)
    const outputDir = getComfyBatchOutputDir(sourceDir)
    const inputDir = getComfyBatchInputDir(sourceDir)
    await Promise.all(
      ['pending.jpg', 'done-a.jpg', 'done-b.jpg'].map((filename) =>
        fs.writeFile(path.join(sourceDir, filename), filename)
      )
    )
    await fs.mkdir(inputDir, { recursive: true })
    await fs.copyFile(path.join(sourceDir, 'pending.jpg'), path.join(inputDir, 'pending.jpg'))
    const planFingerprint = buildComfyBatchPlanFingerprint(request)
    for (const filename of ['done-a.jpg', 'done-b.jpg']) {
      const bytes = new Uint8Array(await fs.readFile(path.join(sourceDir, filename)))
      await atomicCommitPng(path.join(outputDir, filename.replace(/\.jpg$/i, '.png')), validPng, {
        sourceSha256: createHash('sha256').update(bytes).digest('hex'),
        planFingerprint
      })
    }
    await fs.writeFile(
      path.join(inputDir, '.magicpot-batch-input.json'),
      JSON.stringify({
        version: 1,
        sourceDir: path.resolve(sourceDir),
        relativePaths: ['pending.jpg', 'done-a.jpg', 'done-b.jpg'],
        files: [],
        sourceMtimeMs: (await fs.stat(sourceDir)).mtimeMs,
        createdAt: Date.now()
      })
    )
    await fs.mkdir(path.join(outputDir, '.magicpot-batch'), { recursive: true })
    await fs.writeFile(
      getComfyBatchManifestPath(sourceDir),
      JSON.stringify({
        version: 2,
        sourceDir: path.resolve(sourceDir),
        outputDir,
        planFingerprint,
        updatedAt: Date.now(),
        items: {}
      })
    )
    let promptCalls = 0
    const fakeClient = createFakeComfyClient({
      prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
        promptCalls += 1
        return promptId
      }
    })

    const status = await new ComfyBatchRunner(request, [profile('one')], {
      createClient: () => fakeClient
    }).run()

    expect(status).toMatchObject({ state: 'completed', total: 3, success: 1, skipped: 2 })
    expect(promptCalls).toBe(1)
    await expect(fs.stat(path.join(inputDir, '.magicpot-batch-input.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('stages the complete source queue before dispatching the first prompt', async () => {
    const sourceDir = await createTempDir()
    const inputDir = getComfyBatchInputDir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'first.jpg'), 'first')
    await fs.mkdir(path.join(sourceDir, 'nested'))
    await fs.writeFile(path.join(sourceDir, 'nested', 'second.png'), 'second')

    let stagedAtPrompt: string[] = []
    let runPromise!: Promise<ComfyBatchStatus>
    const promptStarted = new Promise<void>((resolve) => {
      const fakeClient = createFakeComfyClient({
        prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
          stagedAtPrompt = (await scanComfyBatchImages(inputDir)).map(
            (source) => source.relativePath
          )
          resolve()
          return promptId
        }
      })
      const runner = new ComfyBatchRunner(makeBatchRequest(sourceDir), [profile('one')], {
        createClient: () => fakeClient
      })
      runPromise = runner.run()
    })

    await promptStarted
    expect(stagedAtPrompt).toEqual(['first.jpg', path.join('nested', 'second.png')])
    await expect(fs.stat(path.join(sourceDir, 'first.jpg'))).resolves.toBeDefined()
    await expect(fs.stat(path.join(sourceDir, 'nested', 'second.png'))).resolves.toBeDefined()
    await expect(runPromise).resolves.toMatchObject({ state: 'completed', success: 2 })
  })

  it('automatically retries transient item failures without reporting them as failed', async () => {
    const sourceDir = await createTempDir()
    await fs.writeFile(path.join(sourceDir, 'retry.jpg'), 'retry')
    let uploadAttempts = 0
    const fakeClient = createFakeComfyClient({
      uploadImage: async () => {
        uploadAttempts += 1
        if (uploadAttempts === 1) throw new Error('temporary upload failure')
        return { filename: 'upload.png', subfolder: '', type: 'input' as const }
      }
    })

    const status = await new ComfyBatchRunner(makeBatchRequest(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    }).run()

    expect(status).toMatchObject({ state: 'completed', success: 1, failed: 0, failedFiles: [] })
    expect(uploadAttempts).toBe(2)
  })

  it('keeps retrying an item beyond the old attempt cap until it succeeds', async () => {
    const sourceDir = await createTempDir()
    await fs.writeFile(path.join(sourceDir, 'eventually.jpg'), 'eventually')
    let uploadAttempts = 0
    const fakeClient = createFakeComfyClient({
      uploadImage: async () => {
        uploadAttempts += 1
        if (uploadAttempts <= 5) throw new Error('temporary transport delay')
        return { filename: 'upload.png', subfolder: '', type: 'input' as const }
      }
    })

    const result = await new ComfyBatchRunner(makeBatchRequest(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    }).run()

    expect(result).toMatchObject({ state: 'completed', success: 1, failed: 0, failedFiles: [] })
    expect(uploadAttempts).toBe(6)
  })
})

describe('Comfy batch ETA', () => {
  const configureRunnerForEta = (runner: ComfyBatchRunner, runtimeCount: number): void => {
    const internals = runner as unknown as EtaRunnerInternals
    internals.statusValue = {
      ...internals.statusValue,
      state: 'running',
      total: 100,
      pending: 96,
      running: 4,
      startedAt: Date.now()
    }
    internals.recentItems.push({
      relativePath: 'done.png',
      durationMs: 1_000,
      startedAt: Date.now() - 1_000,
      finishedAt: Date.now(),
      attempt: 1,
      state: 'success'
    })
    internals.runtimes = Array.from({ length: runtimeCount }, (_, index) => ({
      profile: profile(`eta-${index}`),
      inflight: 1,
      compatible: true,
      available: true
    }))
  }

  it('reduces ETA when the same work is spread across four one-slot instances', () => {
    const request = {
      sourceDir: '/tmp/source',
      qAppKey: 'eta-test',
      workflow: {},
      imageInputSlot: '$.1.inputs.image',
      outputNodeIds: ['2']
    } satisfies StartComfyBatchReq
    const oneInstanceRunner = new ComfyBatchRunner(request, [profile('one')])
    const fourInstanceRunner = new ComfyBatchRunner(request, [profile('one')])

    configureRunnerForEta(oneInstanceRunner, 1)
    configureRunnerForEta(fourInstanceRunner, 4)

    expect(oneInstanceRunner.status.etaMs).toBe(100_000)
    expect(fourInstanceRunner.status.etaMs).toBe(25_000)
  })

  it('uses observed throughput when four instances do not scale linearly', () => {
    const request = {
      sourceDir: '/tmp/source',
      qAppKey: 'eta-throughput-test',
      workflow: {},
      imageInputSlot: '$.1.inputs.image',
      outputNodeIds: ['2']
    } satisfies StartComfyBatchReq
    const runner = new ComfyBatchRunner(request, [profile('one')])
    const internals = runner as unknown as EtaRunnerInternals
    const observationStart = Date.now() - 4_000
    internals.statusValue = {
      ...internals.statusValue,
      state: 'running',
      total: 100,
      pending: 96,
      running: 4,
      startedAt: observationStart
    }
    internals.recentItems.push(
      ...Array.from({ length: 4 }, (_, index) => ({
        relativePath: `done-${index}.png`,
        durationMs: 1_000,
        startedAt: observationStart + index * 1_000,
        finishedAt: observationStart + (index + 1) * 1_000,
        attempt: 1,
        state: 'success' as const
      }))
    )
    internals.runtimes = Array.from({ length: 4 }, (_, index) => ({
      profile: profile(`throughput-${index}`),
      inflight: 1,
      compatible: true,
      available: true
    }))

    expect(runner.status.etaMs).toBe(100_000)
  })
})

describe('Comfy batch dispatch and output binding', () => {
  it('polls ComfyUI history frequently enough to avoid GPU idle gaps', () => {
    expect(COMFY_BATCH_HISTORY_POLL_MS).toBe(200)
  })

  const workflow: Workflow = {
    '1': { class_type: 'LoadImage', inputs: { image: '' } },
    '2': { class_type: 'SaveImage', inputs: {} }
  }

  it('strictly validates the image upload path and output node ids', () => {
    expect(validateComfyBatchBindings(workflow, '$.1.inputs.image', ['2'], objectInfo())).toEqual({
      nodeId: '1',
      field: 'image'
    })
    expect(() =>
      validateComfyBatchBindings(workflow, '$.1.inputs.__proto__', ['2'], objectInfo())
    ).toThrow(/forbidden|does not exist/i)
    expect(() =>
      validateComfyBatchBindings(workflow, '$.__proto__.inputs.image', ['2'], objectInfo())
    ).toThrow(/forbidden/i)
    expect(() =>
      validateComfyBatchBindings(workflow, '$.1.inputs.missing', ['2'], objectInfo())
    ).toThrow(/does not exist/i)
    expect(() => validateComfyBatchBindings(workflow, '$.1.inputs.image.extra', ['2'])).toThrow(
      /must match/i
    )
    expect(() => validateComfyBatchBindings(workflow, '$.1.inputs.image', ['2', '2'])).toThrow(
      /unique/i
    )
    expect(() => validateComfyBatchBindings(workflow, '$.1.inputs.image', ['missing'])).toThrow(
      /does not exist/i
    )
    expect(() =>
      validateComfyBatchBindings(workflow, '$.1.inputs.image', ['2'], {
        ...objectInfo(),
        LoadImage: { input: { required: { image: ['STRING', {}] } }, output: ['IMAGE'] }
      })
    ).toThrow(/image upload field/i)
    expect(() =>
      validateComfyBatchBindings(workflow, '$.1.inputs.image', ['2'], {
        ...objectInfo(),
        SaveImage: { output_node: false, output: ['LATENT'] }
      })
    ).toThrow(/output-producing/i)
  })

  it('validates complete PNG structure and rejects corrupt commits', async () => {
    expect(isValidPng(validPng)).toBe(true)
    expect(isValidPng(validPng.subarray(0, validPng.length - 1))).toBe(false)
    expect(isValidPng(Buffer.concat([validPng, Buffer.from([0])]))).toBe(false)
    const crcCorrupt = Buffer.from(validPng)
    crcCorrupt[20] ^= 1
    expect(isValidPng(crcCorrupt)).toBe(false)
    expect(isValidPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false)

    const directory = await createTempDir()
    const destination = path.join(directory, 'result.png')
    await expect(atomicCommitPng(destination, validPng.subarray(0, 20))).rejects.toThrow(
      /valid PNG/i
    )
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.writeFile(destination, 'old')
    await atomicCommitPng(destination, validPng)
    expect(await fs.readFile(destination)).toEqual(validPng)
  })

  it('selects minimum utilization and uses round-robin for ties', () => {
    const runtimes = [runtime('a'), runtime('b'), runtime('busy', 1)]
    const scheduler = new LeastLoadRoundRobinScheduler<Runtime>()
    expect(scheduler.pick(runtimes)?.profile.id).toBe('a')
    expect(scheduler.pick(runtimes)?.profile.id).toBe('b')
  })

  it('allows doubled execution capacity for a single-slot instance', () => {
    const scheduler = new LeastLoadRoundRobinScheduler<Runtime>()
    const instance = runtime('single-slot', 1)

    expect(scheduler.pick([instance])?.profile.id).toBe('single-slot')
    instance.inflight = 2
    expect(scheduler.pick([instance])).toBeNull()
  })

  it('allows twice the configured execution concurrency', () => {
    const scheduler = new LeastLoadRoundRobinScheduler<Runtime>()
    const instance = runtime('double-slot')
    instance.profile.maxConcurrency = 2

    for (let index = 0; index < 4; index += 1) {
      expect(scheduler.pick([instance])).not.toBeNull()
      instance.inflight += 1
    }
    expect(scheduler.pick([instance])).toBeNull()
  })

  it('keeps one source-preparation slot ahead of the execution queue', async () => {
    const sourceDir = await createTempDir()
    await Promise.all(
      ['first.jpg', 'second.jpg', 'third.jpg'].map((filename) =>
        fs.writeFile(path.join(sourceDir, filename), filename)
      )
    )
    let uploadStarted = 0
    let releaseUploads!: () => void
    const uploadsReleased = new Promise<void>((resolve) => {
      releaseUploads = resolve
    })
    const fakeClient = createFakeComfyClient({
      uploadImage: async () => {
        uploadStarted += 1
        await uploadsReleased
        return { filename: 'upload.png', subfolder: '', type: 'input' as const }
      }
    })
    const runner = new ComfyBatchRunner(makeBatchRequest(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    })
    const runPromise = runner.run()

    await vi.waitFor(() => expect(uploadStarted).toBe(3))
    releaseUploads()
    await expect(runPromise).resolves.toMatchObject({ state: 'completed', success: 3 })
  })

  it('accepts one unique saved or preview image from bound nodes', () => {
    const baseImage = { filename: 'result.png', subfolder: '', type: 'output' }
    expect(
      selectBoundOutputImage(
        {
          outputs: {
            '9': { images: [baseImage] },
            '10': { images: [{ filename: 'other.png', subfolder: '', type: 'output' }] }
          }
        },
        ['9']
      )
    ).toEqual(baseImage)
    const previewImage = { filename: 'preview.png', subfolder: '', type: 'temp' }
    expect(selectBoundOutputImage({ outputs: { '9': { images: [previewImage] } } }, ['9'])).toEqual(
      previewImage
    )
    expect(() =>
      selectBoundOutputImage(
        {
          outputs: { '9': { images: [baseImage, { ...baseImage, filename: 'second.png' }] } }
        },
        ['9']
      )
    ).toThrow(/exactly one/i)
  })
})

describe('ComfyBatchRunner resume and retry semantics', () => {
  it('waits for a slow-starting ComfyUI before failing the batch', () => {
    expect(NO_RUNTIME_RETRY_WINDOW_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('dispatches to a ready instance before a slower profile finishes probing', async () => {
    const sourceDir = await createTempDir()
    await Promise.all([
      fs.writeFile(path.join(sourceDir, 'first.jpg'), 'first'),
      fs.writeFile(path.join(sourceDir, 'second.jpg'), 'second')
    ])
    const calls: string[] = []
    let releaseSlowProbe!: () => void
    const slowProbe = new Promise<void>((resolve) => {
      releaseSlowProbe = resolve
    })
    let resolveFastPrompt!: () => void
    const fastPromptStarted = new Promise<void>((resolve) => {
      resolveFastPrompt = resolve
    })
    const clientFor = (id: string) =>
      ({
        probe: async () => {
          if (id === 'slow') await slowProbe
          return { endpoint: 'system_stats' as const, latencyMs: 1 }
        },
        objectInfo: async () => objectInfo(),
        uploadImage: async () => ({
          filename: `${id}.png`,
          subfolder: '',
          type: 'input' as const
        }),
        prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
          calls.push(id)
          if (id === 'fast') resolveFastPrompt()
          return promptId
        },
        history: async (promptId: string) => ({
          [promptId]: {
            outputs: {
              '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] }
            },
            status: { status_str: 'success', completed: true, messages: [] }
          }
        }),
        view: async () => new Uint8Array(validPng)
      }) as unknown as ComfyBatchHttpClient

    const runner = new ComfyBatchRunner(request(sourceDir), [profile('fast'), profile('slow')], {
      createClient: (baseUrl) => clientFor(baseUrl.includes('slow') ? 'slow' : 'fast')
    })
    const runPromise = runner.run()
    const readyDispatch = await Promise.race([
      fastPromptStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000))
    ])
    releaseSlowProbe()

    expect(readyDispatch).toBe(true)
    await expect(runPromise).resolves.toMatchObject({ state: 'completed', success: 2, failed: 0 })
    expect(calls).toContain('fast')
  })

  it('retries a local profile while a slow remote probe is still in flight', async () => {
    const sourceDir = await createTempDir()
    let localProbeAttempts = 0
    let releaseRemoteObjectInfo!: () => void
    const remoteObjectInfoBlocked = new Promise<void>((resolve) => {
      releaseRemoteObjectInfo = resolve
    })
    const localClient = createFakeComfyClient({
      probe: async () => {
        localProbeAttempts += 1
        if (localProbeAttempts === 1) throw new Error('local ComfyUI is still starting')
        return { endpoint: 'system_stats' as const, latencyMs: 1 }
      }
    })
    const remoteClient = createFakeComfyClient({
      objectInfo: async () => {
        await remoteObjectInfoBlocked
        return objectInfo()
      }
    })
    const runner = new ComfyBatchRunner(
      makeBatchRequest(sourceDir),
      [profile('local'), profile('remote')],
      {
        createClient: (baseUrl) => (baseUrl.includes('local') ? localClient : remoteClient)
      }
    )
    const internals = runner as unknown as {
      refreshProfilesIfNeeded: (force?: boolean) => Promise<void>
      runtimes: Array<{ profile: ComfyBatchProfile }>
    }

    const initialRefresh = internals.refreshProfilesIfNeeded(true)
    await vi.waitFor(() => expect(localProbeAttempts).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A refresh must not be held hostage by the unresolved remote object_info
    // request. The second local probe is what happens after an embedded
    // ComfyUI finishes starting in the real batch supervisor.
    await expect(internals.refreshProfilesIfNeeded(true)).resolves.toBeUndefined()
    await vi.waitFor(() => expect(localProbeAttempts).toBe(2))
    await vi.waitFor(() =>
      expect(internals.runtimes.map(({ profile }) => profile.id)).toContain('local')
    )

    releaseRemoteObjectInfo()
    await initialRefresh
  })

  it('starts the first prompt before the whole source directory is prepared', async () => {
    const sourceDir = await createTempDir()
    await Promise.all([
      fs.writeFile(path.join(sourceDir, 'first.jpg'), 'first'),
      fs.writeFile(path.join(sourceDir, 'second.jpg'), 'second')
    ])

    let releaseWholeDirectoryCopy!: () => void
    const wholeDirectoryCopy = new Promise<void>((resolve) => {
      releaseWholeDirectoryCopy = resolve
    })
    vi.spyOn(fs, 'cp').mockImplementation(async (source, destination, options) => {
      await wholeDirectoryCopy
      fsSync.cpSync(source as string, destination as string, options as never)
    })

    let resolveFirstPrompt!: () => void
    const firstPromptStarted = new Promise<void>((resolve) => {
      resolveFirstPrompt = resolve
    })
    const fakeClient = createFakeComfyClient({
      prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
        resolveFirstPrompt()
        return promptId
      }
    })

    const runner = new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    })
    const runPromise = runner.run()
    const firstPromptBeforeCopyRelease = await Promise.race([
      firstPromptStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))
    ])
    releaseWholeDirectoryCopy()

    await expect(runPromise).resolves.toMatchObject({
      state: 'completed',
      success: 2,
      failed: 0
    })
    expect(firstPromptBeforeCopyRelease).toBe(true)
  })

  it('releases the execution slot before a slow output download completes', async () => {
    const sourceDir = await createTempDir()
    await Promise.all([
      fs.writeFile(path.join(sourceDir, 'first.jpg'), 'first'),
      fs.writeFile(path.join(sourceDir, 'second.jpg'), 'second'),
      fs.writeFile(path.join(sourceDir, 'third.jpg'), 'third')
    ])
    const calls: string[] = []
    let resolveThirdPrompt!: () => void
    const thirdPromptStarted = new Promise<void>((resolve) => {
      resolveThirdPrompt = resolve
    })
    let releaseViews!: () => void
    const viewsReleased = new Promise<void>((resolve) => {
      releaseViews = resolve
    })
    const fakeClient = {
      probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
      objectInfo: async () => objectInfo(),
      uploadImage: async () => ({
        filename: 'upload.png',
        subfolder: '',
        type: 'input' as const
      }),
      prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
        calls.push(promptId)
        if (calls.length === 3) resolveThirdPrompt()
        return promptId
      },
      history: async (promptId: string) => ({
        [promptId]: {
          outputs: {
            '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] }
          },
          status: { status_str: 'success', completed: true, messages: [] }
        }
      }),
      view: async () => {
        await viewsReleased
        return new Uint8Array(validPng)
      }
    } as unknown as ComfyBatchHttpClient

    const runner = new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    })
    const runPromise = runner.run()
    const thirdStarted = await Promise.race([
      thirdPromptStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))
    ])
    releaseViews()

    expect(thirdStarted).toBe(true)
    await expect(runPromise).resolves.toMatchObject({ state: 'completed', success: 3, failed: 0 })
  })

  const workflow: Workflow = {
    '1': { class_type: 'LoadImage', inputs: { image: '' } },
    '2': { class_type: 'SaveImage', inputs: {} }
  }

  const request = (sourceDir: string): StartComfyBatchReq => ({
    sourceDir,
    qAppKey: 'test-qapp',
    workflow,
    imageInputSlot: '$.1.inputs.image',
    outputNodeIds: ['2']
  })

  it('atomically commits PNG output, then skips an unchanged valid success on rerun', async () => {
    const sourceDir = await createTempDir()
    await fs.writeFile(path.join(sourceDir, 'source.jpg'), 'source')
    let promptCalls = 0
    const fakeClient = createFakeComfyClient({
      uploadImage: async () => ({ name: 'upload.png', subfolder: '', type: 'input' as const }),
      prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
        promptCalls += 1
        return promptId
      }
    })

    const first = new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    })
    const firstStatus = await first.run()
    expect(firstStatus).toMatchObject({ state: 'completed', success: 1, failed: 0, skipped: 0 })
    await expect(fs.stat(path.join(sourceDir, 'source.jpg'))).resolves.toBeDefined()
    await expect(fs.stat(getComfyBatchInputDir(sourceDir))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(isValidPng(new Uint8Array(await fs.readFile(`${sourceDir}.output/source.png`)))).toBe(
      true
    )
    expect(promptCalls).toBe(1)

    const second = new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    })
    const secondStatus = await second.run()
    expect(secondStatus).toMatchObject({ state: 'completed', success: 0, failed: 0, skipped: 1 })
    expect(promptCalls).toBe(1)
  })

  it('reruns a same-size source edit even when its mtime is restored', async () => {
    const sourceDir = await createTempDir()
    const sourcePath = path.join(sourceDir, 'source.jpg')
    await fs.writeFile(sourcePath, 'before')
    const originalMtime = (await fs.stat(sourcePath)).mtime
    let promptCalls = 0
    const fakeClient = createFakeComfyClient({
      prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
        promptCalls += 1
        return promptId
      }
    })

    await new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    }).run()
    await fs.writeFile(sourcePath, 'change')
    await fs.utimes(sourcePath, originalMtime, originalMtime)
    const status = await new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    }).run()

    expect(status).toMatchObject({ state: 'completed', success: 1, skipped: 0 })
    expect(promptCalls).toBe(2)
  })

  it('rejects an empty source folder without creating an output folder', async () => {
    const sourceDir = await createTempDir()
    const status = await new ComfyBatchRunner(request(sourceDir), [profile('one')]).run()
    expect(status).toMatchObject({ state: 'error', total: 0 })
    expect(status.error).toMatch(/no supported images/i)
    await expect(fs.stat(`${sourceDir}.output`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes stale outputs and manifest entries for deleted sources', async () => {
    const sourceDir = await createTempDir()
    const sourcePath = path.join(sourceDir, 'deleted.jpg')
    await fs.writeFile(sourcePath, 'source')
    const fakeClient = createFakeComfyClient()

    await new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    }).run()
    const outputPath = path.join(`${sourceDir}.output`, 'deleted.png')
    await fs.rm(sourcePath)
    await fs.writeFile(path.join(sourceDir, 'remaining.jpg'), 'source')
    await new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    }).run()

    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(`${sourceDir}.output`, '.magicpot-batch', 'manifest.json'),
        'utf8'
      )
    ) as { items: Record<string, unknown> }
    expect(manifest.items['deleted.jpg']).toBeUndefined()
  })

  it('never follows a corrupted manifest output path outside the output folder', async () => {
    const sourceDir = await createTempDir()
    const protectedPath = path.join(sourceDir, 'protected.png')
    await fs.writeFile(path.join(sourceDir, 'current.jpg'), 'source')
    await fs.writeFile(protectedPath, validPng)
    const manifestDir = path.join(`${sourceDir}.output`, '.magicpot-batch')
    await fs.mkdir(manifestDir, { recursive: true })
    await fs.writeFile(
      path.join(manifestDir, 'manifest.json'),
      JSON.stringify({
        version: 2,
        sourceDir,
        outputDir: `${sourceDir}.output`,
        planFingerprint: 'old',
        updatedAt: Date.now(),
        items: {
          'deleted.jpg': {
            relativePath: 'deleted.jpg',
            size: 1,
            mtimeMs: 1,
            sha256: 'old',
            planFingerprint: 'old',
            status: 'success',
            outputRelativePath: '../protected.png',
            updatedAt: Date.now()
          }
        }
      })
    )
    const fakeClient = createFakeComfyClient()

    await new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    }).run()

    expect(await fs.readFile(protectedPath)).toEqual(validPng)
  })

  it('retry mode rescans and reruns failed, added, changed, and missing-output items', async () => {
    const sourceDir = await createTempDir()
    await Promise.all([
      fs.writeFile(path.join(sourceDir, 'failed.jpg'), 'failed'),
      fs.writeFile(path.join(sourceDir, 'stable.jpg'), 'stable'),
      fs.writeFile(path.join(sourceDir, 'changed.jpg'), 'before'),
      fs.writeFile(path.join(sourceDir, 'missing.jpg'), 'missing')
    ])
    const calls: string[] = []
    const sourceByPromptId = new Map<string, string>()
    let failedAttemptsRemaining = 1
    const fakeClient = {
      probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
      objectInfo: async () => objectInfo(),
      uploadImage: async (filename: string) => {
        const sourceName = filename.includes('.jpg') ? filename : `${filename}.jpg`
        return { filename: sourceName, subfolder: '', type: 'input' }
      },
      prompt: async (submittedWorkflow: Workflow, _clientId: string, promptId: string) => {
        const uploaded = String(submittedWorkflow['1'].inputs.image)
        const source = ['failed', 'stable', 'changed', 'missing', 'added'].find((name) =>
          uploaded.includes(name)
        )
        if (source) {
          calls.push(source)
          sourceByPromptId.set(promptId, source)
        }
        return promptId
      },
      history: async (promptId: string) => {
        if (failedAttemptsRemaining > 0 && sourceByPromptId.get(promptId) === 'failed') {
          failedAttemptsRemaining -= 1
          return {
            [promptId]: {
              outputs: {},
              status: {
                status_str: 'error',
                completed: true,
                messages: [['execution_error', { exception_message: 'first failure' }]]
              }
            }
          }
        }
        return {
          [promptId]: {
            outputs: {
              '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] }
            },
            status: { status_str: 'success', completed: true, messages: [] }
          }
        }
      },
      view: async () => {
        return new Uint8Array(validPng)
      }
    } as unknown as ComfyBatchHttpClient

    // Keep upload names observable while retaining the runner's unique prefix.
    fakeClient.uploadImage = (async (_filename: string, bytes: Uint8Array) => ({
      filename: new TextDecoder().decode(bytes),
      subfolder: '',
      type: 'input'
    })) as ComfyBatchHttpClient['uploadImage']

    const first = new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    })
    expect(await first.run()).toMatchObject({
      state: 'completed',
      success: 4,
      failed: 0,
      skipped: 0
    })

    calls.length = 0
    await fs.writeFile(path.join(sourceDir, 'changed.jpg'), 'changed')
    await fs.writeFile(path.join(sourceDir, 'added.jpg'), 'added')
    await fs.rm(path.join(`${sourceDir}.output`, 'missing.png'))

    const retry = new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    })
    const retryStatus = await retry.run()

    expect(retryStatus).toMatchObject({ state: 'completed', success: 3, skipped: 2, failed: 0 })
    expect(calls.sort()).toEqual(['added', 'changed', 'missing'])
  })

  it('keeps item failure details out of the batch status while retrying', async () => {
    const sourceDir = await createTempDir()
    await fs.writeFile(path.join(sourceDir, 'source.jpg'), 'source')
    const failureReason = 'No compatible ComfyUI instance is available'
    const fakeClient = {
      probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
      objectInfo: async () => objectInfo(),
      uploadImage: async () => {
        throw new Error(failureReason)
      }
    } as unknown as ComfyBatchHttpClient

    const runner = new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    })
    const resultPromise = runner.run()
    await vi.waitFor(() => expect(runner.status.running).toBeGreaterThan(0))
    expect(runner.status).toMatchObject({ failed: 0, failedFiles: [] })
    runner.cancel()
    const result = await resultPromise

    expect(result).toMatchObject({ state: 'cancelled', failed: 0, failedFiles: [] })
  })

  it('discovers a profile added while the first item is blocked', async () => {
    const sourceDir = await createTempDir()
    await Promise.all([
      fs.writeFile(path.join(sourceDir, 'first.jpg'), 'first'),
      fs.writeFile(path.join(sourceDir, 'second.jpg'), 'second'),
      fs.writeFile(path.join(sourceDir, 'third.jpg'), 'third'),
      fs.writeFile(path.join(sourceDir, 'fourth.jpg'), 'fourth'),
      fs.writeFile(path.join(sourceDir, 'fifth.jpg'), 'fifth')
    ])
    const calls: string[] = []
    let profiles = [profile('one')]
    let resolveTwoProbe!: () => void
    const twoProbeStarted = new Promise<void>((resolve) => {
      resolveTwoProbe = resolve
    })
    let releaseInitial!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    let releaseOneHistory!: () => void
    const oneHistoryReleased = new Promise<void>((resolve) => {
      releaseOneHistory = resolve
    })
    let blockedPromptCount = 0
    const clientFor = (id: string) => {
      const client = {
        probe: async () => {
          if (id === 'two') resolveTwoProbe()
          return { endpoint: 'system_stats' as const, latencyMs: 1 }
        },
        objectInfo: async () => objectInfo(),
        uploadImage: async (_filename: string, bytes: Uint8Array) => ({
          filename: `${id}-${new TextDecoder().decode(bytes)}.png`,
          subfolder: '',
          type: 'input' as const
        }),
        prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
          calls.push(id)
          if (id === 'one' && blockedPromptCount < 2) {
            blockedPromptCount += 1
            await firstBlocked
          }
          return promptId
        },
        history: async (promptId: string) => {
          await (id === 'one' ? oneHistoryReleased : Promise.resolve())
          return {
            [promptId]: {
              outputs: {
                '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] }
              },
              status: { status_str: 'success', completed: true, messages: [] }
            }
          }
        },
        view: async () => new Uint8Array(validPng)
      } as unknown as ComfyBatchHttpClient
      return client
    }

    const runner = new ComfyBatchRunner(request(sourceDir), profiles, {
      getProfiles: () => profiles,
      createClient: (baseUrl) => clientFor(baseUrl.includes('two') ? 'two' : 'one')
    })
    const runPromise = runner.run()
    await vi.waitFor(() => expect(blockedPromptCount).toBe(2))
    profiles = [profile('one'), profile('two')]
    // Wait for the supervisor to observe the changed profile fingerprint
    // before the first runtime is released; this proves the new profile is
    // usable in a subsequent dispatch round rather than relying on timing.
    await twoProbeStarted
    releaseInitial()
    await vi.waitFor(() => expect(calls).toContain('two'))
    releaseOneHistory()
    const result = await runPromise

    expect(result).toMatchObject({ state: 'completed', success: 5, failed: 0 })
    expect(calls).toContain('two')
  })

  it('switches to only one other compatible instance after a Comfy execution failure', async () => {
    const sourceDir = await createTempDir()
    await fs.writeFile(path.join(sourceDir, 'source.jpg'), 'source')
    const calls: string[] = []
    const clientFor = (id: string) =>
      ({
        probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
        objectInfo: async () => objectInfo(),
        uploadImage: async () => ({ name: `${id}.png`, subfolder: '', type: 'input' as const }),
        prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
          calls.push(id)
          return promptId
        },
        history: async (promptId: string) => {
          if (id === 'first') {
            return {
              [promptId]: {
                outputs: {},
                status: { status_str: 'error', completed: true, messages: [] }
              }
            }
          }
          return {
            [promptId]: {
              outputs: {
                '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] }
              },
              status: { status_str: 'success', completed: true, messages: [] }
            }
          }
        },
        view: async () => new Uint8Array(validPng)
      }) as unknown as ComfyBatchHttpClient

    const runner = new ComfyBatchRunner(
      request(sourceDir),
      [profile('first'), profile('second'), profile('third')],
      {
        createClient: (baseUrl) =>
          clientFor(
            baseUrl.includes('first') ? 'first' : baseUrl.includes('second') ? 'second' : 'third'
          )
      }
    )
    const status = await runner.run()

    expect(status).toMatchObject({ state: 'completed', success: 1, failed: 0 })
    expect(calls).toEqual(['first', 'second'])
  })

  it('rediscovers another instance when it becomes available after the active one closes', async () => {
    const sourceDir = await createTempDir()
    await fs.writeFile(path.join(sourceDir, 'source.jpg'), 'source')
    let secondReady = false
    const calls: string[] = []
    const clientFor = (id: string) =>
      ({
        probe: async () => {
          if (id === 'second' && !secondReady) {
            throw new ComfyBatchHttpError('connect ECONNREFUSED', true)
          }
          return { endpoint: 'system_stats' as const, latencyMs: 1 }
        },
        objectInfo: async () => objectInfo(),
        uploadImage: async () => ({ name: `${id}.png`, subfolder: '', type: 'input' as const }),
        prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
          calls.push(id)
          return promptId
        },
        history: async (promptId: string) => {
          if (id === 'first') {
            secondReady = true
            throw new ComfyBatchHttpError('connect ECONNREFUSED', true)
          }
          return {
            [promptId]: {
              outputs: {
                '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] }
              },
              status: { status_str: 'success', completed: true, messages: [] }
            }
          }
        },
        view: async () => new Uint8Array(validPng)
      }) as unknown as ComfyBatchHttpClient

    const runner = new ComfyBatchRunner(request(sourceDir), [profile('first'), profile('second')], {
      createClient: (baseUrl) => clientFor(baseUrl.includes('first') ? 'first' : 'second')
    })
    const status = await runner.run()

    expect(status).toMatchObject({ state: 'completed', success: 1, failed: 0 })
    expect(calls).toEqual(['first', 'second'])
  })

  it('switches away from an instance that returns an HTML 404 endpoint error', async () => {
    const sourceDir = await createTempDir()
    await fs.writeFile(path.join(sourceDir, 'source.jpg'), 'source')
    const calls: string[] = []
    const clientFor = (id: string) =>
      ({
        probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
        objectInfo: async () => objectInfo(),
        uploadImage: async () => ({ name: `${id}.png`, subfolder: '', type: 'input' as const }),
        prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
          calls.push(id)
          return promptId
        },
        history: async (promptId: string) => {
          if (id === 'first') {
            throw new ComfyBatchHttpError('ComfyUI HTTP 404', false, 404)
          }
          return {
            [promptId]: {
              outputs: {
                '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] }
              },
              status: { status_str: 'success', completed: true, messages: [] }
            }
          }
        },
        view: async () => new Uint8Array(validPng)
      }) as unknown as ComfyBatchHttpClient

    const runner = new ComfyBatchRunner(request(sourceDir), [profile('first'), profile('second')], {
      createClient: (baseUrl) => clientFor(baseUrl.includes('first') ? 'first' : 'second')
    })
    const status = await runner.run()

    expect(status).toMatchObject({ state: 'completed', success: 1, failed: 0 })
    expect(calls).toEqual(['first', 'second'])
  })

  it('requeues failed items while the batch is running without duplicating other work', async () => {
    const sourceDir = await createTempDir()
    await Promise.all(
      ['first.jpg', 'second.jpg', 'third.jpg', 'fourth.jpg'].map((filename) =>
        fs.writeFile(path.join(sourceDir, filename), filename)
      )
    )
    let releaseSecond!: () => void
    const secondAndThirdBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const processedPaths: string[] = []
    const sourceByPromptId = new Map<string, string>()
    let firstAttemptFailuresRemaining = 5
    const fakeClient = {
      probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
      objectInfo: async () => objectInfo(),
      uploadImage: async (_filename: string, bytes: Uint8Array) => ({
        filename: new TextDecoder().decode(bytes),
        subfolder: '',
        type: 'input' as const
      }),
      prompt: async (submittedWorkflow: Workflow, _clientId: string, promptId: string) => {
        sourceByPromptId.set(
          promptId,
          String(submittedWorkflow['1'].inputs.image).replace(/ \[input\]$/, '')
        )
        return promptId
      },
      history: async (promptId: string) => {
        const relativePath = sourceByPromptId.get(promptId) || ''
        processedPaths.push(relativePath)
        if (relativePath === 'first.jpg' && firstAttemptFailuresRemaining > 0) {
          firstAttemptFailuresRemaining -= 1
          throw new Error('first attempt failed')
        }
        if (relativePath === 'second.jpg' || relativePath === 'third.jpg') {
          await secondAndThirdBlocked
        }
        return {
          [promptId]: {
            outputs: {
              '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] }
            },
            status: { status_str: 'success', completed: true, messages: [] }
          }
        }
      },
      view: async () => new Uint8Array(validPng)
    } as unknown as ComfyBatchHttpClient

    const runner = new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    })
    const runPromise = runner.run()
    await vi.waitFor(
      () => {
        expect(runner.status.failed).toBe(0)
        expect(runner.status.running).toBeGreaterThan(0)
        expect(
          processedPaths.filter((relativePath) => relativePath === 'first.jpg')
        ).not.toHaveLength(0)
      },
      { timeout: 5_000 }
    )

    releaseSecond()
    const status = await runPromise

    expect(status).toMatchObject({ state: 'completed', total: 4, success: 4, failed: 0 })
    expect(processedPaths).toHaveLength(9)
    expect(processedPaths.filter((relativePath) => relativePath === 'first.jpg')).toHaveLength(6)
    expect(processedPaths.filter((relativePath) => relativePath !== 'first.jpg').sort()).toEqual([
      'fourth.jpg',
      'second.jpg',
      'third.jpg'
    ])
  })
})
