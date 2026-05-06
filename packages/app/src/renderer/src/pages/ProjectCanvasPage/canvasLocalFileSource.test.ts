import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getCanvasLocalMediaSourceUrl,
  getElectronCanvasFilePath,
  resolveCanvasImageFileSource
} from './canvasLocalFileSource'

const originalElectronFile = window.electronFile
const originalCreateObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')

function setElectronFileBridge(value: typeof window.electronFile): void {
  Object.defineProperty(window, 'electronFile', {
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

  it('uses the preload electronFile bridge when File.path is unavailable', () => {
    const getPathForFile = vi.fn(() => 'D:\\bridge\\image.png')
    setElectronFileBridge({ getPathForFile })

    const file = new File(['png'], 'image.png', { type: 'image/png' })

    expect(getElectronCanvasFilePath(file)).toBe('D:\\bridge\\image.png')
    expect(getCanvasLocalMediaSourceUrl(file)).toBe('local-media:///D:/bridge/image.png')
    expect(getPathForFile).toHaveBeenCalledWith(file)
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
