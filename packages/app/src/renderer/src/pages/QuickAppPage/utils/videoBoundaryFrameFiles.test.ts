import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createVideoBoundaryFrameFiles,
  getVideoBoundaryFrameFileName
} from './videoBoundaryFrameFiles'

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9VE3d2wAAAAASUVORK5CYII='

describe('videoBoundaryFrameFiles', () => {
  const createObjectURL = vi.fn(() => 'blob:video-source')
  const revokeObjectURL = vi.fn()
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  beforeEach(() => {
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURL
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeObjectURL
    })
  })

  afterEach(() => {
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: originalCreateObjectURL
      })
    }
    if (originalRevokeObjectURL) {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: originalRevokeObjectURL
      })
    }
  })

  it('builds first and last frame file names from the source video', () => {
    expect(getVideoBoundaryFrameFileName('demo.mp4', 'first')).toBe('demo-first-frame.png')
    expect(getVideoBoundaryFrameFileName('demo.mp4', 'last')).toBe('demo-last-frame.png')
  })

  it('creates first and last frame files and revokes the temporary video url', async () => {
    const file = new File(['video'], 'demo.mp4', { type: 'video/mp4' })

    const result = await createVideoBoundaryFrameFiles(file, async (videoUrl) => {
      expect(videoUrl).toBe('blob:video-source')
      return {
        firstFrameDataUrl: PNG_DATA_URL,
        lastFrameDataUrl: PNG_DATA_URL
      }
    })

    expect(result.firstFrameFile?.name).toBe('demo-first-frame.png')
    expect(result.firstFrameFile?.type).toBe('image/png')
    expect(result.lastFrameFile?.name).toBe('demo-last-frame.png')
    expect(result.lastFrameFile?.type).toBe('image/png')
    expect(createObjectURL).toHaveBeenCalledWith(file)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:video-source')
  })

  it('returns partial frame files when only one boundary frame is available', async () => {
    const file = new File(['video'], 'clip.mov', { type: 'video/quicktime' })

    const result = await createVideoBoundaryFrameFiles(file, async () => ({
      firstFrameDataUrl: PNG_DATA_URL
    }))

    expect(result.firstFrameFile?.name).toBe('clip-first-frame.png')
    expect(result.lastFrameFile).toBeUndefined()
  })
})
