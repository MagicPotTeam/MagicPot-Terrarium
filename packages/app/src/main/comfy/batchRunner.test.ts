import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComfyBatchProfile, StartComfyBatchReq } from '@shared/api/svcComfyBatch'
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
  name: id,
  baseUrl: `http://${id}.example`,
  enabled: true,
  maxConcurrency: 1
})

type Runtime = { profile: ComfyBatchProfile; inflight: number; id: string }

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

  it('requires one unique type=output image from bound nodes', () => {
    const baseImage = { filename: 'result.png', subfolder: '', type: 'output' }
    expect(
      selectBoundOutputImage(
        {
          outputs: {
            '9': { images: [{ ...baseImage, type: 'temp' }, baseImage] },
            '10': { images: [{ filename: 'other.png', subfolder: '', type: 'output' }] }
          }
        },
        ['9']
      )
    ).toEqual(baseImage)
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
    expect(await fs.readFile(`${sourceDir}.output/source.png`)).toEqual(png)
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

  it('retry mode rescans and reruns failed, added, changed, and missing-output items', async () => {
    const sourceDir = await createTempDir()
    await Promise.all([
      fs.writeFile(path.join(sourceDir, 'failed.jpg'), 'failed'),
      fs.writeFile(path.join(sourceDir, 'stable.jpg'), 'stable'),
      fs.writeFile(path.join(sourceDir, 'changed.jpg'), 'before'),
      fs.writeFile(path.join(sourceDir, 'missing.jpg'), 'missing')
    ])
    const calls: string[] = []
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
        if (source) calls.push(source)
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
        if (failFailedItem && calls.at(-1) === 'failed') throw new Error('first failure')
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
    expect(await first.run()).toMatchObject({ success: 3, failed: 1 })

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
