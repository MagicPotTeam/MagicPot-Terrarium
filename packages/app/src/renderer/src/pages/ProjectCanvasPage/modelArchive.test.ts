import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractModelArchive,
  extractModelPackageFiles,
  listContainedModelExtensions,
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
