import React from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDeferredComfyFileInputValue } from '@shared/comfy/deferredImages'
import InputComfyVideo from './InputComfyVideo'

const apiMocks = vi.hoisted(() => ({
  getView: vi.fn(),
  saveQAppInputImage: vi.fn(),
  readImageFromPath: vi.fn()
}))
const notifyErrorMock = vi.hoisted(() => vi.fn())

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfy: {
      getView: apiMocks.getView
    },
    svcFs: {
      saveQAppInputImage: apiMocks.saveQAppInputImage,
      readImageFromPath: apiMocks.readImageFromPath
    }
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: notifyErrorMock
  })
}))

describe('InputComfyVideo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:video-preview')
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn()
    })
  })

  it('does not clear the selected value when preview loading fails', async () => {
    const onChange = vi.fn()
    apiMocks.getView.mockRejectedValueOnce(new Error('ComfyUI busy'))

    render(
      <InputComfyVideo
        label="Video"
        value="clip.mp4"
        onChange={onChange}
        placeholder="Upload video"
      />
    )

    await waitFor(() => expect(apiMocks.getView).toHaveBeenCalled())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not let an older asynchronous selection overwrite newer controlled props', async () => {
    let resolveSave!: (value: { success: true; fullPath: string; filename: string }) => void
    apiMocks.saveQAppInputImage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        })
    )
    apiMocks.getView.mockResolvedValue({ result: new Uint8Array([1, 2, 3]) })
    const onChange = vi.fn()
    const { container, rerender } = render(
      <InputComfyVideo label="Video" value="" onChange={onChange} placeholder="Upload video" />
    )
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['older'], 'older.mp4', { type: 'video/mp4' })] }
    })
    await waitFor(() => expect(apiMocks.saveQAppInputImage).toHaveBeenCalledTimes(1))

    rerender(
      <InputComfyVideo
        label="Video"
        value="newer.mp4"
        onChange={onChange}
        placeholder="Upload video"
      />
    )
    resolveSave({ success: true, fullPath: 'C:/cache/older.mp4', filename: 'older.mp4' })
    await Promise.resolve()
    await Promise.resolve()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('submits a persisted deferred file value without pre-lease Comfy upload', async () => {
    apiMocks.saveQAppInputImage.mockResolvedValue({
      success: true,
      fullPath: 'C:/cache/clip.mp4',
      filename: 'clip.mp4'
    })
    apiMocks.readImageFromPath.mockResolvedValue({
      image: new Uint8Array([1, 2, 3]),
      filename: 'clip.mp4'
    })
    const onChange = vi.fn()
    const { container } = render(
      <InputComfyVideo label="Video" value="" onChange={onChange} placeholder="Upload video" />
    )
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['video-bytes'], 'clip.mp4', { type: 'video/mp4' })

    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    expect(parseDeferredComfyFileInputValue(onChange.mock.calls[0][0])).toMatchObject({
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: file.size,
      filePath: 'C:/cache/clip.mp4'
    })
    expect(apiMocks.getView).not.toHaveBeenCalled()
  })
})
