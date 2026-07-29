import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeCanvasLocalMediaSourceUrl,
  getCanvasLocalMediaSourceUrl,
  getElectronCanvasFilePath,
  resolveCanvasImageFileSource
} from './canvasLocalFileSource'

const originalElectronFile = window.electronFile
const originalElectronApi = (window as Window & { electronAPI?: unknown }).electronAPI
const originalCreateObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')

function setElectronFileBridge(value: typeof window.electronFile | undefined): void {
  Object.defineProperty(window, 'electronFile', {
    configurable: true,
    value
  })
}

function setElectronApiBridge(value: typeof window.electronFile | undefined): void {
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

  it('falls back to the standard electronAPI bridge when electronFile is unavailable', () => {
    setElectronFileBridge(undefined)
    const getPathForFile = vi.fn(() => String.raw`E:\project\project.mpcanvas`)
    setElectronApiBridge({ getPathForFile, authorizeLocalMediaFile: vi.fn() })
    const file = new File(['{}'], 'project.mpcanvas', { type: 'application/json' })

    expect(getElectronCanvasFilePath(file)).toBe(String.raw`E:\project\project.mpcanvas`)
    expect(getPathForFile).toHaveBeenCalledWith(file)
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
