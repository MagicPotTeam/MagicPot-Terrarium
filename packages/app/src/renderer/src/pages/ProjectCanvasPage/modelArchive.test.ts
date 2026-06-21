import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractModelArchive,
  extractModelPackageFiles,
  listContainedModelExtensions,
  ModelArchiveLimitExceededError,
  ModelArchiveMalformedError,
  ModelPackageUnsupportedFormatError
} from './modelArchive'

describe('extractModelArchive', () => {
  let createObjectURL: ReturnType<typeof vi.fn>
  let revokeObjectURL: ReturnType<typeof vi.fn>
  let objectUrlIndex = 0

  beforeEach(() => {
    objectUrlIndex = 0
    createObjectURL = vi.fn(() => `blob:mock-${objectUrlIndex++}`)
    revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      createObjectURL,
      revokeObjectURL
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('extracts the fbx model and linked fbm assets from a zip package', async () => {
    const zip = new JSZip()
    zip.file('hero.fbx', 'fbx-binary')
    zip.file('hero.fbm/diffuse.png', 'png-binary')
    zip.file('hero.fbm/normal.jpg', 'jpg-binary')
    const blob = await zip.generateAsync({ type: 'blob' })
    const archive = new File([blob], 'hero.fbm.zip', { type: 'application/zip' })

    const extracted = await extractModelArchive(archive)

    expect(extracted).not.toBeNull()
    expect(extracted?.file.name).toBe('hero.fbx')
    expect(extracted?.sourcePath).toBe('hero.fbx')
    expect(extracted?.linkedAssets).toEqual({
      'hero.fbm/diffuse.png': 'blob:mock-0',
      'hero.fbm/normal.jpg': 'blob:mock-1'
    })
  })

  it('prefers the model whose stem matches the archive name when there are multiple models', async () => {
    const zip = new JSZip()
    zip.file('other.fbx', 'fbx-a')
    zip.file('character.fbx', 'fbx-b')
    const blob = await zip.generateAsync({ type: 'blob' })
    const archive = new File([blob], 'character.fbm.zip', { type: 'application/zip' })

    const extracted = await extractModelArchive(archive)

    expect(extracted?.file.name).toBe('character.fbx')
    expect(extracted?.linkedAssets).toEqual({})
  })

  it('extracts only the selected model and linked assets from archive entries', async () => {
    const modelAsync = vi.fn(async () => new Blob(['fbx-binary']))
    const assetAsync = vi.fn(async () => new Blob(['png-binary']))
    const unrelatedAsync = vi.fn(async () => new Blob(['unused-binary']))
    const fakeZip = {
      files: {
        'hero.fbx': {
          name: 'hero.fbx',
          dir: false,
          async: modelAsync,
          _data: { uncompressedSize: 'fbx-binary'.length }
        },
        'hero.fbm/diffuse.png': {
          name: 'hero.fbm/diffuse.png',
          dir: false,
          async: assetAsync,
          _data: { uncompressedSize: 'png-binary'.length }
        },
        'extras/readme.txt': {
          name: 'extras/readme.txt',
          dir: false,
          async: unrelatedAsync,
          _data: { uncompressedSize: 'unused-binary'.length }
        }
      }
    } as unknown as JSZip
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValue(fakeZip)
    const archive = new File(['zip-bytes'], 'hero.zip', { type: 'application/zip' })

    const extracted = await extractModelArchive(archive)

    expect(extracted?.file.name).toBe('hero.fbx')
    expect(extracted?.linkedAssets).toEqual({ 'hero.fbm/diffuse.png': 'blob:mock-0' })
    expect(modelAsync).toHaveBeenCalledOnce()
    expect(assetAsync).toHaveBeenCalledOnce()
    expect(unrelatedAsync).not.toHaveBeenCalled()
  })

  it('rejects archives above the compressed file size safety limit', async () => {
    const zip = new JSZip()
    zip.file('hero.glb', 'glb-binary')
    const blob = await zip.generateAsync({ type: 'blob' })
    const archive = new File([blob], 'hero.zip', { type: 'application/zip' })

    await expect(
      extractModelArchive(archive, ['.glb'], { maxArchiveBytes: archive.size - 1 })
    ).rejects.toMatchObject({
      name: 'ModelArchiveLimitExceededError',
      limitKind: 'archiveSize'
    } satisfies Partial<ModelArchiveLimitExceededError>)
  })

  it('rejects archives above the entry count safety limit', async () => {
    const zip = new JSZip()
    zip.file('hero.glb', 'glb-binary')
    zip.file('texture.png', 'png-binary')
    const blob = await zip.generateAsync({ type: 'blob' })
    const archive = new File([blob], 'hero.zip', { type: 'application/zip' })

    await expect(extractModelArchive(archive, ['.glb'], { maxEntries: 1 })).rejects.toMatchObject({
      name: 'ModelArchiveLimitExceededError',
      limitKind: 'entryCount'
    } satisfies Partial<ModelArchiveLimitExceededError>)
  })

  it('rejects archives above the total extracted size safety limit before extraction', async () => {
    const zip = new JSZip()
    zip.file('hero.glb', 'glb-binary')
    zip.file('texture.png', 'png-binary')
    const blob = await zip.generateAsync({ type: 'blob' })
    const archive = new File([blob], 'hero.zip', { type: 'application/zip' })

    await expect(
      extractModelArchive(archive, ['.glb'], { maxTotalExtractedBytes: 'glb-binary'.length })
    ).rejects.toMatchObject({
      name: 'ModelArchiveLimitExceededError',
      limitKind: 'totalExtractedSize'
    } satisfies Partial<ModelArchiveLimitExceededError>)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('rejects a streaming zip entry as soon as it expands beyond its declared size', async () => {
    let dataCallback: ((chunk: Uint8Array) => void) | undefined
    let endCallback: (() => void) | undefined
    const pause = vi.fn()
    const asyncFallback = vi.fn()
    const stream = {
      on: vi.fn((event: 'data' | 'end' | 'error', callback: unknown) => {
        if (event === 'data') dataCallback = callback as (chunk: Uint8Array) => void
        if (event === 'end') endCallback = callback as () => void
        return stream
      }),
      pause,
      resume: vi.fn(() => {
        dataCallback?.(new Uint8Array([1, 2, 3, 4]))
        endCallback?.()
        return stream
      })
    } as unknown as JSZip.JSZipStreamHelper<Uint8Array>
    const fakeZip = {
      files: {
        'hero.glb': {
          name: 'hero.glb',
          dir: false,
          async: asyncFallback,
          internalStream: vi.fn(() => stream),
          _data: { uncompressedSize: 2 }
        }
      }
    } as unknown as JSZip
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValue(fakeZip)
    const archive = new File(['zip-bytes'], 'hero.zip', { type: 'application/zip' })

    await expect(extractModelArchive(archive, ['.glb'])).rejects.toMatchObject({
      name: 'ModelArchiveMalformedError'
    } satisfies Partial<ModelArchiveMalformedError>)
    expect(pause).toHaveBeenCalledOnce()
    expect(asyncFallback).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('throws a dedicated malformed error for unreadable model archives', async () => {
    const archive = new File(['not a zip'], 'broken.zip', { type: 'application/zip' })

    await expect(extractModelArchive(archive)).rejects.toMatchObject({
      name: 'ModelArchiveMalformedError'
    } satisfies Partial<ModelArchiveMalformedError>)
  })

  it('supports folder-style entries with a shared root directory', () => {
    const extracted = extractModelPackageFiles(
      [
        {
          path: 'hero-folder/hero.fbx',
          file: new File(['fbx-binary'], 'hero.fbx')
        },
        {
          path: 'hero-folder/hero.fbm/diffuse.png',
          file: new File(['png-binary'], 'diffuse.png')
        }
      ],
      'hero-folder'
    )

    expect(extracted?.file.name).toBe('hero.fbx')
    expect(extracted?.sourcePath).toBe('hero.fbx')
    expect(extracted?.linkedAssets).toEqual({
      'hero.fbm/diffuse.png': 'blob:mock-0'
    })
  })

  it('lists contained model extensions from a mixed package', () => {
    const extensions = listContainedModelExtensions([
      {
        path: 'bundle/hero.obj',
        file: new File(['obj'], 'hero.obj')
      },
      {
        path: 'bundle/hero.fbx',
        file: new File(['fbx'], 'hero.fbx')
      },
      {
        path: 'bundle/hero.fbm/diffuse.png',
        file: new File(['png'], 'diffuse.png')
      }
    ])

    expect(extensions).toEqual(['.obj', '.fbx'])
  })

  it('throws a dedicated unsupported-format error when a zip only contains disallowed model types', async () => {
    const zip = new JSZip()
    zip.file('hero.fbx', 'fbx-binary')
    zip.file('hero.fbm/diffuse.png', 'png-binary')
    const blob = await zip.generateAsync({ type: 'blob' })
    const archive = new File([blob], 'hero.zip', { type: 'application/zip' })

    await expect(extractModelArchive(archive, ['.obj', '.glb'])).rejects.toMatchObject({
      name: 'ModelPackageUnsupportedFormatError',
      detectedModelExtensions: ['.fbx']
    } satisfies Partial<ModelPackageUnsupportedFormatError>)
  })
})
