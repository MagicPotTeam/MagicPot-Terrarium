import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComfyHistory } from '@shared/comfy/types'
import { createComfyResultResourceManager } from '@renderer/store/comfyResultResources'
import { transformResults } from './index'

const getViewMock = vi.fn()
const importOutputImageMock = vi.fn()
const svcComfy: {
  getView: typeof getViewMock
  importOutputImage?: typeof importOutputImageMock
} = { getView: getViewMock, importOutputImage: importOutputImageMock }

vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcComfy }) }))

const managedReference = {
  version: 1 as const,
  kind: 'managed' as const,
  relativePath: 'comfy-outputs/global/ab/image.png',
  sha256: 'a'.repeat(64),
  sizeBytes: 123,
  mimeType: 'image/png',
  originalFileName: 'ComfyUI_final.png'
}

function createHistory(): ComfyHistory {
  return {
    prompt: [0, 'prompt-1', {} as ComfyHistory['prompt'][2], { client_id: 'client-1' }, []],
    outputs: {
      previewNode: {
        images: [{ filename: 'ComfyUI_temp_preview.png', subfolder: '', type: 'temp' }]
      },
      outputNode: {
        images: [{ filename: 'ComfyUI_final.png', subfolder: '', type: 'output' }]
      }
    },
    status: { status_str: 'success', completed: true, messages: [] }
  }
}

function buildPngHeader(width: number, height: number, colorType = 6): Uint8Array {
  const buffer = new ArrayBuffer(26)
  const header = new Uint8Array(buffer)
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(buffer)
  view.setUint32(8, 13, false)
  header.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  header[24] = 8
  header[25] = colorType
  return header
}

describe('transformImage', () => {
  const originalCreateObjectURL = URL.createObjectURL
  const originalCreateImageBitmap = globalThis.createImageBitmap

  beforeEach(() => {
    svcComfy.importOutputImage = importOutputImageMock
    importOutputImageMock.mockResolvedValue({
      reference: managedReference,
      localMediaUrl: 'local-media:///managed/ComfyUI_final.png',
      mimeType: 'image/png',
      sizeBytes: 123,
      fileName: 'ComfyUI_final.png'
    })
    getViewMock.mockResolvedValue({ result: new Uint8Array([1, 2, 3]) })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:image-result')
    })
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: vi.fn(async () => ({ width: 3136, height: 2624, close: vi.fn() }))
    })
  })

  afterEach(() => {
    getViewMock.mockReset()
    importOutputImageMock.mockReset()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: originalCreateObjectURL
    })
    if (originalCreateImageBitmap) {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        writable: true,
        value: originalCreateImageBitmap
      })
    } else {
      Reflect.deleteProperty(globalThis, 'createImageBitmap')
    }
  })

  it('imports final outputs as managed media without retaining source bytes', async () => {
    const results = await transformResults('prompt-1', createHistory())
    const image = results[0] as Extract<(typeof results)[number], { type: 'image' }>

    expect(image).toMatchObject({
      type: 'image',
      objectUrl: 'local-media:///managed/ComfyUI_final.png',
      media: managedReference,
      mimeType: 'image/png',
      sizeBytes: 123
    })
    expect(image.sourceBlob).toBeUndefined()
    expect(importOutputImageMock).toHaveBeenCalledWith({
      filename: 'ComfyUI_final.png',
      subfolder: '',
      type: 'output'
    })
    expect(getViewMock).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('falls back to getView when the older preload has no import method', async () => {
    delete svcComfy.importOutputImage

    const results = await transformResults('prompt-1', createHistory())
    const image = results[0] as Extract<(typeof results)[number], { type: 'image' }>

    expect(image.objectUrl).toBe('blob:image-result')
    expect(image.sourceBlob).toBeInstanceOf(Blob)
    expect(getViewMock).toHaveBeenCalledOnce()
  })

  it('tracks the fallback object URL for result teardown', async () => {
    delete svcComfy.importOutputImage
    const revokeObjectURL = vi.fn()
    const manager = createComfyResultResourceManager(revokeObjectURL)

    const results = await transformResults('prompt-1', createHistory())
    manager.sync([], results)
    manager.teardown()

    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledOnce()
    const result = results[0]
    expect(result?.type).toBe('image')
    if (!result || result.type !== 'image') {
      throw new Error('Expected transformed image result')
    }
    expect(revokeObjectURL).toHaveBeenCalledWith(result.objectUrl)
  })

  it('falls back after a strict serialized service rejection', async () => {
    importOutputImageMock.mockRejectedValue({ message: 'network failed', code: 'NETWORK_ERROR' })

    const results = await transformResults('prompt-1', createHistory())

    expect(results[0]).toMatchObject({ objectUrl: 'blob:image-result' })
    expect(getViewMock).toHaveBeenCalledOnce()
  })

  it.each([
    new Error('plain failure'),
    { message: 'missing transport code' },
    { message: 'internal failure', code: 'INTERNAL_ERROR' },
    Object.assign(Object.create({ code: 'NETWORK_ERROR' }), { message: 'inherited code' })
  ])('propagates non-fallback managed import errors', async (importError) => {
    importOutputImageMock.mockRejectedValue(importError)

    await expect(transformResults('prompt-1', createHistory())).rejects.toBe(importError)
    expect(getViewMock).not.toHaveBeenCalled()
  })

  it('keeps temp images on the existing getView path', async () => {
    const results = await transformResults('prompt-1', createHistory(), ['previewNode'])

    expect(results[0]).toMatchObject({
      objectUrl: 'blob:image-result',
      fileItem: { type: 'temp' }
    })
    expect(importOutputImageMock).not.toHaveBeenCalled()
    expect(getViewMock).toHaveBeenCalledWith({
      filename: 'ComfyUI_temp_preview.png',
      subfolder: '',
      type: 'temp'
    })
  })

  it('reads PNG dimensions on the fallback path', async () => {
    delete svcComfy.importOutputImage
    getViewMock.mockResolvedValue({ result: buildPngHeader(4096, 2510) })

    const results = await transformResults('prompt-1', createHistory())

    expect(globalThis.createImageBitmap).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ sourceWidth: 4096, sourceHeight: 2510 })
  })
})
