import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createCanvasLocalImageObjectUrl,
  resolveCanvasLocalFilePathFromSource
} from './canvasLocalImageSource'

describe('canvasLocalImageSource', () => {
  const originalApi = window.api
  const originalCreateObjectURL = URL.createObjectURL

  afterEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: originalApi
    })
    URL.createObjectURL = originalCreateObjectURL
    vi.restoreAllMocks()
  })

  it('resolves canonical and browser-normalized local media URLs to file paths', () => {
    expect(resolveCanvasLocalFilePathFromSource('local-media:///C:/Users/me/image.png')).toBe(
      'C:/Users/me/image.png'
    )
    expect(resolveCanvasLocalFilePathFromSource('local-media://c/Users/me/image.png')).toBe(
      'c:/Users/me/image.png'
    )
    expect(resolveCanvasLocalFilePathFromSource('file:///C:/Users/me/image.png')).toBe(
      'C:/Users/me/image.png'
    )
  })

  it('creates a blob URL from a local image path through svcFs', async () => {
    const image = new Uint8Array([1, 2, 3, 4])
    const readImageFromPath = vi.fn(async () => ({ image, filename: '无标题(95).png' }))
    const createObjectUrl = vi.fn((_blob: Blob) => 'blob:local-image')
    URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL

    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        svcFs: {
          readImageFromPath
        }
      }
    })

    const objectUrl = await createCanvasLocalImageObjectUrl(
      'local-media://c/Users/17290/Desktop/%E6%96%B0%E5%BB%BA%E6%96%87%E4%BB%B6%E5%A4%B9/%E6%97%A0%E6%A0%87%E9%A2%98(95).png'
    )

    expect(objectUrl).toBe('blob:local-image')
    expect(readImageFromPath).toHaveBeenCalledWith({
      fullPath: 'c:/Users/17290/Desktop/新建文件夹/无标题(95).png'
    })
    expect((createObjectUrl.mock.calls[0]?.[0] as Blob | undefined)?.type).toBe('image/png')
  })
})
