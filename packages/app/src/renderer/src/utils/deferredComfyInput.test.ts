import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseDeferredComfyFileInputValue,
  parseDeferredComfyImageInputValue,
  parseDeferredComfyMaskInputValue
} from '@shared/comfy/deferredImages'
import {
  buildDeferredComfyFileValue,
  buildDeferredComfyImageValue,
  buildDeferredComfyMaskValue,
  DEFERRED_COMFY_PERSIST_MAX_BYTES,
  getDeferredComfyLocalPreview
} from './deferredComfyInput'

const fsMocks = vi.hoisted(() => ({
  saveQAppInputImage: vi.fn(),
  readImageFromPath: vi.fn()
}))

vi.mock('./windowUtils', () => ({
  api: () => ({
    svcFs: {
      saveQAppInputImage: fsMocks.saveQAppInputImage,
      readImageFromPath: fsMocks.readImageFromPath
    }
  })
}))

describe('deferredComfyInput builders', () => {
  beforeEach(() => {
    fsMocks.saveQAppInputImage.mockReset()
    fsMocks.readImageFromPath.mockReset()
    fsMocks.saveQAppInputImage.mockImplementation(({ filename }: { filename: string }) =>
      Promise.resolve({ success: true, filename, fullPath: `C:/cache/${filename}` })
    )
  })

  it('builds persisted deferred values for image and generic file inputs', async () => {
    const image = new File(['image'], 'image.png', { type: 'image/png' })
    const video = new File(['video'], 'video.mp4', { type: 'video/mp4' })

    expect(
      parseDeferredComfyImageInputValue(await buildDeferredComfyImageValue(image))
    ).toMatchObject({
      fileName: 'image.png',
      mimeType: 'image/png',
      sizeBytes: image.size,
      filePath: 'C:/cache/image.png'
    })
    expect(
      parseDeferredComfyFileInputValue(await buildDeferredComfyFileValue(video))
    ).toMatchObject({
      fileName: 'video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: video.size,
      filePath: 'C:/cache/video.mp4'
    })
  })

  it('normalizes unsafe filenames before persistence and encoding', async () => {
    const file = new File(['image'], '../folder\\bad\u0000name.png', { type: 'IMAGE/PNG' })
    const parsed = parseDeferredComfyImageInputValue(await buildDeferredComfyImageValue(file))

    expect(fsMocks.saveQAppInputImage).toHaveBeenCalledWith({
      filename: '.._folder_bad_name.png',
      image: new Uint8Array([105, 109, 97, 103, 101])
    })
    expect(parsed).toMatchObject({
      fileName: '.._folder_bad_name.png',
      mimeType: 'image/png',
      filePath: 'C:/cache/.._folder_bad_name.png'
    })
  })

  it('builds a deferred mask carrying the exact original workflow value', async () => {
    const originalValue = 'MAGICPOT_DEFERRED_COMFY_IMAGE:original'
    const value = await buildDeferredComfyMaskValue({
      blob: new Blob(['mask'], { type: 'image/png' }),
      fileName: 'mask.png',
      originalValue
    })

    expect(parseDeferredComfyMaskInputValue(value)).toMatchObject({
      fileName: 'mask.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      filePath: 'C:/cache/mask.png',
      originalValue
    })
  })

  it('rejects oversized inputs before reading or crossing IPC', async () => {
    const arrayBuffer = vi.fn()
    const oversized = {
      name: 'oversized.bin',
      type: 'application/octet-stream',
      size: DEFERRED_COMFY_PERSIST_MAX_BYTES + 1,
      arrayBuffer
    } as unknown as File

    await expect(buildDeferredComfyFileValue(oversized)).rejects.toThrow('renderer limit')
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(fsMocks.saveQAppInputImage).not.toHaveBeenCalled()
  })

  it('rejects a blob whose bytes do not match its reported size', async () => {
    const changing = {
      name: 'changing.bin',
      type: 'application/octet-stream',
      size: 4,
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
    } as unknown as File

    await expect(buildDeferredComfyFileValue(changing)).rejects.toThrow('size changed')
    expect(fsMocks.saveQAppInputImage).not.toHaveBeenCalled()
  })

  it('fails closed when a persisted local input file is missing', async () => {
    fsMocks.readImageFromPath.mockRejectedValue(new Error('ENOENT'))
    const value = await buildDeferredComfyFileValue(
      new File(['video'], 'missing.mp4', { type: 'video/mp4' })
    )

    await expect(getDeferredComfyLocalPreview(value)).rejects.toThrow('ENOENT')
  })

  it('returns no preview for malformed reserved values without invoking IPC', async () => {
    await expect(
      getDeferredComfyLocalPreview('MAGICPOT_DEFERRED_COMFY_IMAGE:%not-json')
    ).resolves.toBeNull()
    expect(fsMocks.readImageFromPath).not.toHaveBeenCalled()
  })

  it('fails closed before IPC for persisted previews above the renderer limit', async () => {
    const value = `MAGICPOT_DEFERRED_COMFY_FILE:${encodeURIComponent(
      JSON.stringify({
        fileName: 'large.mp4',
        mimeType: 'video/mp4',
        sizeBytes: DEFERRED_COMFY_PERSIST_MAX_BYTES + 1,
        filePath: 'C:/cache/large.mp4'
      })
    )}`

    await expect(getDeferredComfyLocalPreview(value)).resolves.toBeNull()
    expect(fsMocks.readImageFromPath).not.toHaveBeenCalled()
  })

  it('fails closed when persisted preview bytes no longer match metadata', async () => {
    const value = await buildDeferredComfyFileValue(
      new File(['video'], 'changed.mp4', { type: 'video/mp4' })
    )
    fsMocks.readImageFromPath.mockResolvedValue({
      filename: 'changed.mp4',
      image: new Uint8Array([1])
    })

    await expect(getDeferredComfyLocalPreview(value)).rejects.toThrow('no longer matches')
  })

  it('fails closed when persistence is unavailable and an input is too large to inline', async () => {
    fsMocks.saveQAppInputImage.mockRejectedValue(new Error('cache unavailable'))
    const largeFile = new File([new Uint8Array(16 * 1024 * 1024 + 1)], 'large.bin', {
      type: 'application/octet-stream'
    })

    await expect(buildDeferredComfyFileValue(largeFile)).rejects.toThrow('too large to inline')
  })
})
