import fs from 'node:fs/promises'
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
  getComfyBatchOutputDir,
  getComfyBatchOutputRelativePath,
  selectBoundOutputImage,
  scanComfyBatchImages,
  LeastLoadRoundRobinScheduler,
  atomicCommitPng,
  isValidPng,
  validateComfyBatchBindings
} from './batchRunner'
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

describe('Comfy batch paths and discovery', () => {
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

  it('keeps one extra item queued for a single-slot instance', () => {
    const scheduler = new LeastLoadRoundRobinScheduler<Runtime>()
    const instance = runtime('single-slot', 1)

    expect(scheduler.pick([instance])?.profile.id).toBe('single-slot')
    instance.inflight = 2
    expect(scheduler.pick([instance])).toBeNull()
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
    const png = validPng
    const fakeClient = {
      probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
      objectInfo: async () => objectInfo(),
      uploadImage: async () => ({ name: 'upload.png', subfolder: '', type: 'input' as const }),
      prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
        promptCalls += 1
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
      view: async () => new Uint8Array(png)
    } as unknown as ComfyBatchHttpClient

    const first = new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    })
    const firstStatus = await first.run()
    expect(firstStatus).toMatchObject({ state: 'completed', success: 1, failed: 0, skipped: 0 })
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
    const fakeClient = {
      probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
      objectInfo: async () => objectInfo(),
      uploadImage: async () => ({ filename: 'upload.png', subfolder: '', type: 'input' }),
      prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => {
        promptCalls += 1
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
    } as unknown as ComfyBatchHttpClient

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
    const fakeClient = {
      probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
      objectInfo: async () => objectInfo(),
      uploadImage: async () => ({ filename: 'upload.png', subfolder: '', type: 'input' }),
      prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => promptId,
      history: async (promptId: string) => ({
        [promptId]: {
          outputs: {
            '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] }
          },
          status: { status_str: 'success', completed: true, messages: [] }
        }
      }),
      view: async () => new Uint8Array(validPng)
    } as unknown as ComfyBatchHttpClient

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
    const fakeClient = {
      probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
      objectInfo: async () => objectInfo(),
      uploadImage: async () => ({ filename: 'upload.png', subfolder: '', type: 'input' }),
      prompt: async (_workflow: Workflow, _clientId: string, promptId: string) => promptId,
      history: async (promptId: string) => ({
        [promptId]: {
          outputs: {
            '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] }
          },
          status: { status_str: 'success', completed: true, messages: [] }
        }
      }),
      view: async () => new Uint8Array(validPng)
    } as unknown as ComfyBatchHttpClient

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
    let failFailedItem = true
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
        if (failFailedItem && sourceByPromptId.get(promptId) === 'failed') {
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
      state: 'error',
      success: 3,
      failed: 1,
      error: '1 batch item(s) failed'
    })

    calls.length = 0
    failFailedItem = false
    await fs.writeFile(path.join(sourceDir, 'changed.jpg'), 'changed')
    await fs.writeFile(path.join(sourceDir, 'added.jpg'), 'added')
    await fs.rm(path.join(`${sourceDir}.output`, 'missing.png'))

    const retry = new ComfyBatchRunner(request(sourceDir), [profile('one')], {
      createClient: () => fakeClient
    })
    const retryStatus = await retry.run()

    expect(retryStatus).toMatchObject({ state: 'completed', success: 4, skipped: 1, failed: 0 })
    expect(calls.sort()).toEqual(['added', 'changed', 'failed', 'missing'])
  })

  it('discovers a profile added while the first item is blocked', async () => {
    const sourceDir = await createTempDir()
    await Promise.all([
      fs.writeFile(path.join(sourceDir, 'first.jpg'), 'first'),
      fs.writeFile(path.join(sourceDir, 'second.jpg'), 'second'),
      fs.writeFile(path.join(sourceDir, 'third.jpg'), 'third')
    ])
    const calls: string[] = []
    let profiles = [profile('one')]
    let releaseInitial!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    let blockedPromptCount = 0
    const clientFor = (id: string) => {
      const client = {
        probe: async () => ({ endpoint: 'system_stats' as const, latencyMs: 1 }),
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
        history: async (promptId: string) => ({
          [promptId]: {
            outputs: {
              '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] }
            },
            status: { status_str: 'success', completed: true, messages: [] }
          }
        }),
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
    // Let the supervisor observe the changed profile fingerprint before the
    // first runtime is released; this proves the new profile is usable in a
    // subsequent dispatch round rather than relying on initial probing.
    await new Promise((resolve) => setTimeout(resolve, 300))
    releaseInitial()
    const result = await runPromise

    expect(result).toMatchObject({ state: 'completed', success: 3, failed: 0 })
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
})
