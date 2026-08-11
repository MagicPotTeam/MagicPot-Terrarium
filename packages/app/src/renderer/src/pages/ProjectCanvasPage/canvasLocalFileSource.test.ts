import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeCanvasLocalMediaSourceUrl,
  getCanvasLocalMediaSourceUrl,
  getElectronCanvasFilePath,
  resolveAuthorizedCanvasLocalMediaSourceUrl,
  resolveCanvasImageFileSource
} from './canvasLocalFileSource'

const originalElectronFile = window.electronFile
const originalElectronApi = (window as Window & { electronAPI?: unknown }).electronAPI
const originalCreateObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')

function setElectronFileBridge(
  value: Partial<NonNullable<typeof window.electronFile>> | undefined
): void {
  Object.defineProperty(window, 'electronFile', {
    configurable: true,
    value
  })
}

function setElectronApiBridge(
  value: Partial<NonNullable<typeof window.electronFile>> | undefined
): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value
  })
}

function setCreateObjectUrl(value: ((file: Blob | MediaSource) => string) | undefined): void {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value
  })
}

describe('canvasLocalFileSource', () => {
  afterEach(() => {
    setElectronFileBridge(originalElectronFile)
    setElectronApiBridge(originalElectronApi as typeof window.electronFile | undefined)
    if (originalCreateObjectUrlDescriptor) {
      Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrlDescriptor)
    } else {
      Reflect.deleteProperty(URL, 'createObjectURL')
    }
  })

  it('prefers legacy Electron file paths and normalizes them into local media URLs', () => {
    const file = new File(['png'], 'image.png', { type: 'image/png' })
    Object.defineProperty(file, 'path', {
      configurable: true,
      value: 'C:\\assets\\image.png'
    })

    expect(getElectronCanvasFilePath(file)).toBe('C:\\assets\\image.png')
    expect(getCanvasLocalMediaSourceUrl(file)).toBe('local-media:///C:/assets/image.png')
  })

  it.each([
    {
      label: 'Windows drive',
      filePath: String.raw`C:\assets\hash#query?\literal%2F-%25-图像.png`,
      expectedUrl:
        'local-media:///C:/assets/hash%23query%3F/literal%252F-%2525-%E5%9B%BE%E5%83%8F.png',
      expectedPath: 'C:/assets/hash#query?/literal%2F-%25-图像.png'
    },
    {
      label: 'POSIX',
      filePath: '/Users/demo/hash#query?/literal%2F-%25-图像.png',
      expectedUrl:
        'local-media:///Users/demo/hash%23query%3F/literal%252F-%2525-%E5%9B%BE%E5%83%8F.png',
      expectedPath: '/Users/demo/hash#query?/literal%2F-%25-图像.png'
    },
    {
      label: 'UNC',
      filePath: String.raw`\\server-name\share\hash#query?\literal%2F-%25-图像.png`,
      expectedUrl:
        'local-media://server-name/share/hash%23query%3F/literal%252F-%2525-%E5%9B%BE%E5%83%8F.png',
      expectedPath: '//server-name/share/hash#query?/literal%2F-%25-图像.png'
    }
  ])(
    'round-trips URL-safe $label paths without treating literal percent escapes as syntax',
    async ({ filePath, expectedUrl, expectedPath }) => {
      const file = new File(['png'], 'image.png', { type: 'image/png' })
      Object.defineProperty(file, 'path', { configurable: true, value: filePath })
      expect(getCanvasLocalMediaSourceUrl(file)).toBe(expectedUrl)

      const resolveAuthorizedLocalMediaPath = vi.fn(async () => filePath)
      setElectronFileBridge({ resolveAuthorizedLocalMediaPath })
      await expect(resolveAuthorizedCanvasLocalMediaSourceUrl(expectedUrl)).resolves.toBe(
        expectedUrl
      )
      expect(resolveAuthorizedLocalMediaPath).toHaveBeenCalledWith(expectedPath)
    }
  )

  it('returns null for a pathless non-File blob', () => {
    expect(getCanvasLocalMediaSourceUrl(new Blob(['png'], { type: 'image/png' }))).toBeNull()
  })

  it('uses the preload electronFile bridge when File.path is unavailable', () => {
    const getPathForFile = vi.fn(() => 'D:\\bridge\\image.png')
    setElectronFileBridge({
      getPathForFile,
      authorizeLocalMediaFile: vi.fn()
    })

    const file = new File(['png'], 'image.png', { type: 'image/png' })

    expect(getElectronCanvasFilePath(file)).toBe('D:\\bridge\\image.png')
    expect(getCanvasLocalMediaSourceUrl(file)).toBe('local-media:///D:/bridge/image.png')
    expect(getPathForFile).toHaveBeenCalledWith(file)
  })

  it('does not fall back to a renderer-provided bridge when electronFile is unavailable', () => {
    setElectronFileBridge(undefined)
    const getPathForFile = vi.fn(() => String.raw`E:\project\project.mpcanvas`)
    setElectronApiBridge({ getPathForFile, authorizeLocalMediaFile: vi.fn() })
    const file = new File(['{}'], 'project.mpcanvas', { type: 'application/json' })

    expect(getElectronCanvasFilePath(file)).toBe('')
    expect(getPathForFile).not.toHaveBeenCalled()
  })

  it('returns a local-media URL only after the preload bridge authorizes the file', async () => {
    const authorizeLocalMediaFile = vi.fn(async () => 'D:\\bridge\\video.mp4')
    setElectronFileBridge({ getPathForFile: vi.fn(() => ''), authorizeLocalMediaFile })
    const file = new File(['video'], 'video.mp4', { type: 'video/mp4' })

    await expect(authorizeCanvasLocalMediaSourceUrl(file)).resolves.toBe(
      'local-media:///D:/bridge/video.mp4'
    )
    expect(authorizeLocalMediaFile).toHaveBeenCalledWith(file)
  })

  it('does not create a persistent local-media URL when authorization fails', async () => {
    setElectronFileBridge({
      getPathForFile: vi.fn(() => 'D:\\bridge\\video.mp4'),
      authorizeLocalMediaFile: vi.fn(async () => '')
    })

    await expect(
      authorizeCanvasLocalMediaSourceUrl(new File(['video'], 'video.mp4', { type: 'video/mp4' }))
    ).resolves.toBeNull()
  })

  it('authorizes image Files before returning a persistent local-media URL', async () => {
    const authorizeLocalMediaFile = vi.fn(async () => 'D:\\bridge\\image.png')
    setElectronFileBridge({
      getPathForFile: vi.fn(() => 'D:\\bridge\\image.png'),
      authorizeLocalMediaFile
    })
    const createObjectURL = vi.fn(() => 'blob:canvas-image')
    setCreateObjectUrl(createObjectURL)

    const file = new File(['png'], 'image.png', { type: 'image/png' })
    const readFileAsDataURL = vi.fn(async () => 'data:image/png;base64,AAAA')

    await expect(resolveCanvasImageFileSource(file, readFileAsDataURL)).resolves.toBe(
      'local-media:///D:/bridge/image.png'
    )
    expect(authorizeLocalMediaFile).toHaveBeenCalledWith(file)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(readFileAsDataURL).not.toHaveBeenCalled()
  })

  it('falls back to an object URL when image authorization fails', async () => {
    const authorizeLocalMediaFile = vi.fn(async () => {
      throw new Error('authorization failed')
    })
    setElectronFileBridge({
      getPathForFile: vi.fn(() => 'D:\\bridge\\image.png'),
      authorizeLocalMediaFile
    })
    const createObjectURL = vi.fn(() => 'blob:canvas-image')
    setCreateObjectUrl(createObjectURL)

    const file = new File(['png'], 'image.png', { type: 'image/png' })
    const readFileAsDataURL = vi.fn(async () => 'data:image/png;base64,AAAA')

    await expect(resolveCanvasImageFileSource(file, readFileAsDataURL)).resolves.toBe(
      'blob:canvas-image'
    )
    expect(authorizeLocalMediaFile).toHaveBeenCalledWith(file)
    expect(createObjectURL).toHaveBeenCalledWith(file)
    expect(readFileAsDataURL).not.toHaveBeenCalled()
  })

  it('falls back to object URLs for browser-only image files', async () => {
    setElectronFileBridge(undefined)
    setCreateObjectUrl(vi.fn(() => 'blob:canvas-image'))

    const file = new File(['png'], 'image.png', { type: 'image/png' })
    const readFileAsDataURL = vi.fn(async () => 'data:image/png;base64,AAAA')

    await expect(resolveCanvasImageFileSource(file, readFileAsDataURL)).resolves.toBe(
      'blob:canvas-image'
    )
    expect(readFileAsDataURL).not.toHaveBeenCalled()
  })

  it('falls back to data URLs when no local path or object URL API is available', async () => {
    setElectronFileBridge(undefined)
    setCreateObjectUrl(undefined)

    const file = new File(['png'], 'image.png', { type: 'image/png' })
    const readFileAsDataURL = vi.fn(async () => 'data:image/png;base64,AAAA')

    await expect(resolveCanvasImageFileSource(file, readFileAsDataURL)).resolves.toBe(
      'data:image/png;base64,AAAA'
    )
    expect(readFileAsDataURL).toHaveBeenCalledWith(file)
  })
})
