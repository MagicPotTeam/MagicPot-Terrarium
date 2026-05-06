import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComfyHistory } from '@shared/comfy/types'
import { transformResults } from './index'

const getViewMock = vi.fn()

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfy: {
      getView: getViewMock
    }
  })
}))

function createHistory(): ComfyHistory {
  return {
    prompt: [0, 'prompt-1', {} as ComfyHistory['prompt'][2], { client_id: 'client-1' }, []],
    outputs: {
      previewNode: {
        images: [
          {
            filename: 'ComfyUI_temp_preview.png',
            subfolder: '',
            type: 'temp'
          }
        ]
      },
      outputNode: {
        images: [
          {
            filename: 'ComfyUI_final.png',
            subfolder: '',
            type: 'output'
          }
        ]
      }
    },
    status: {
      status_str: 'success',
      completed: true,
      messages: []
    }
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
    getViewMock.mockResolvedValue({ result: new Uint8Array([1, 2, 3]) })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:image-result')
    })
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: vi.fn(async () => ({
        width: 3136,
        height: 2624,
        close: vi.fn()
      }))
    })
  })

  afterEach(() => {
    getViewMock.mockReset()
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: originalCreateObjectURL
      })
    }
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

  it('ignores transient preview images when no explicit output nodes are configured', async () => {
    const results = await transformResults('prompt-1', createHistory())

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      type: 'image',
      promptId: 'prompt-1',
      objectUrl: 'blob:image-result',
      sourceWidth: 3136,
      sourceHeight: 2624,
      fileItem: {
        filename: 'ComfyUI_final.png',
        subfolder: '',
        type: 'output'
      }
    })
    expect(
      (results[0] as Extract<(typeof results)[number], { type: 'image' }>).sourceBlob
    ).toBeInstanceOf(Blob)
    expect(
      (results[0] as Extract<(typeof results)[number], { type: 'image' }>).sourceBlob?.type
    ).toBe('image/png')
    expect(getViewMock).toHaveBeenCalledTimes(1)
    expect(getViewMock).toHaveBeenCalledWith({
      filename: 'ComfyUI_final.png',
      subfolder: '',
      type: 'output'
    })
    expect(getViewMock).not.toHaveBeenCalledWith({
      filename: 'ComfyUI_temp_preview.png',
      subfolder: '',
      type: 'temp'
    })
  })

  it('honors transient preview images when their output node is explicitly selected', async () => {
    const results = await transformResults('prompt-1', createHistory(), ['previewNode'])

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      type: 'image',
      promptId: 'prompt-1',
      objectUrl: 'blob:image-result',
      fileItem: {
        filename: 'ComfyUI_temp_preview.png',
        subfolder: '',
        type: 'temp'
      }
    })
    expect(getViewMock).toHaveBeenCalledTimes(1)
    expect(getViewMock).toHaveBeenCalledWith({
      filename: 'ComfyUI_temp_preview.png',
      subfolder: '',
      type: 'temp'
    })
  })

  it('reads PNG header dimensions without fully decoding the image blob', async () => {
    getViewMock.mockResolvedValue({ result: buildPngHeader(4096, 2510) })

    const results = await transformResults('prompt-1', createHistory())

    expect(globalThis.createImageBitmap).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({
      type: 'image',
      objectUrl: 'blob:image-result',
      sourceWidth: 4096,
      sourceHeight: 2510
    })
  })
})
