import React, { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InputVideoBoundaryFrames, { InputVideoBoundaryFramesValue } from './InputVideoBoundaryFrames'

const mocks = vi.hoisted(() => ({
  createVideoBoundaryFrameFiles: vi.fn(),
  getView: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  uploadImage: vi.fn()
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfy: {
      getView: mocks.getView,
      uploadImage: mocks.uploadImage
    }
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: mocks.notifyError,
    notifySuccess: mocks.notifySuccess
  })
}))

vi.mock('@renderer/pages/QuickAppPage/utils/videoBoundaryFrameFiles', () => ({
  createVideoBoundaryFrameFiles: mocks.createVideoBoundaryFrameFiles
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

const emptyValue: InputVideoBoundaryFramesValue = {
  videoFileName: '',
  firstFrameValue: '',
  lastFrameValue: ''
}

const renderInput = (value: InputVideoBoundaryFramesValue, onChange = vi.fn()) =>
  render(
    <InputVideoBoundaryFrames
      label="Video"
      value={value}
      onChange={onChange}
      placeholder="Upload video"
    />
  )

const extractedFrame = (name: string) =>
  ({
    name,
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1))
  }) as unknown as File

describe('InputVideoBoundaryFrames', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    let objectUrlId = 0
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => `blob:preview-${++objectUrlId}`)
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn()
    })
  })

  it('ignores a stale frame preview result', async () => {
    const oldPreview = deferred<{ result: Uint8Array }>()
    const newPreview = deferred<{ result: Uint8Array }>()
    mocks.getView.mockReturnValueOnce(oldPreview.promise).mockReturnValueOnce(newPreview.promise)

    const { rerender } = renderInput({
      ...emptyValue,
      firstFrameValue: 'old.png'
    })
    rerender(
      <InputVideoBoundaryFrames
        label="Video"
        value={{ ...emptyValue, firstFrameValue: 'new.png' }}
        onChange={vi.fn()}
        placeholder="Upload video"
      />
    )

    newPreview.resolve({ result: new Uint8Array([2]) })
    await waitFor(() =>
      expect(screen.getByAltText('首帧')).toHaveAttribute('src', 'blob:preview-1')
    )

    oldPreview.resolve({ result: new Uint8Array([1]) })
    await waitFor(() => expect(mocks.getView).toHaveBeenCalledTimes(2))

    expect(screen.getByAltText('首帧')).toHaveAttribute('src', 'blob:preview-1')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('revokes the current preview URL on unmount in StrictMode', async () => {
    mocks.getView.mockResolvedValue({ result: new Uint8Array([1]) })

    const { unmount } = render(
      <StrictMode>
        <InputVideoBoundaryFrames
          label="Video"
          value={{ ...emptyValue, firstFrameValue: 'first.png' }}
          onChange={vi.fn()}
          placeholder="Upload video"
        />
      </StrictMode>
    )

    await waitFor(() =>
      expect(screen.getByAltText('首帧')).toHaveAttribute('src', 'blob:preview-1')
    )
    unmount()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
  })

  it('does not call onChange when an older video operation finishes last', async () => {
    const firstOperation = deferred<{
      firstFrameFile: File
      lastFrameFile: File
    }>()
    const secondOperation = deferred<{
      firstFrameFile: File
      lastFrameFile: File
    }>()
    mocks.createVideoBoundaryFrameFiles
      .mockReturnValueOnce(firstOperation.promise)
      .mockReturnValueOnce(secondOperation.promise)
    mocks.uploadImage.mockImplementation(({ fileItem }: { fileItem: { filename: string } }) =>
      Promise.resolve({ filename: fileItem.filename, type: 'input' })
    )
    const onChange = vi.fn()
    const { container } = renderInput(emptyValue, onChange)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const olderVideo = new File(['older'], 'older.mp4', { type: 'video/mp4' })
    const newerVideo = new File(['newer'], 'newer.mp4', { type: 'video/mp4' })

    fireEvent.change(input, { target: { files: [olderVideo] } })
    fireEvent.change(input, { target: { files: [newerVideo] } })

    secondOperation.resolve({
      firstFrameFile: extractedFrame('newer-first.png'),
      lastFrameFile: extractedFrame('newer-last.png')
    })
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ videoFileName: 'newer.mp4' }))

    firstOperation.resolve({
      firstFrameFile: extractedFrame('older-first.png'),
      lastFrameFile: extractedFrame('older-last.png')
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
