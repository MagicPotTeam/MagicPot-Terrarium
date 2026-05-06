import { beforeEach, describe, expect, it, vi } from 'vitest'

const getViewMock = vi.fn()
const readImageFromPathMock = vi.fn()

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfy: {
      getView: getViewMock
    },
    svcFs: {
      readImageFromPath: readImageFromPathMock
    }
  })
}))

import { getDroppedImageFile, hasDroppedImageData } from './imageDrop'
import { INTERNAL_IMAGE_DRAG_PREFIX, QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'

const createDataTransfer = (data: Record<string, string>, files: File[] = []) =>
  ({
    files,
    getData: (key: string) => data[key] || ''
  }) as unknown as DataTransfer

describe('hy3d imageDrop', () => {
  beforeEach(() => {
    getViewMock.mockReset()
    readImageFromPathMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('accepts internal canvas image payloads during drag over', () => {
    const dataTransfer = createDataTransfer({
      [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
        objectUrl: 'blob:canvas-image'
      })
    })

    expect(hasDroppedImageData(dataTransfer)).toBe(true)
  })

  it('loads a file from the internal canvas fallback payload', async () => {
    const responseBlob = new Blob(['canvas-image'], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(responseBlob)
    })
    vi.stubGlobal('fetch', fetchMock)

    const dataTransfer = createDataTransfer({
      'text/plain': `${INTERNAL_IMAGE_DRAG_PREFIX}${JSON.stringify({
        objectUrl: 'blob:canvas-image'
      })}`
    })

    const file = await getDroppedImageFile(dataTransfer)

    expect(fetchMock).toHaveBeenCalledWith('blob:canvas-image')
    expect(file).toBeInstanceOf(File)
    expect(file?.name).toBe('canvas-image')
    expect(file?.type).toBe('image/png')
  })
})
