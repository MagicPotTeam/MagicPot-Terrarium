import React from 'react'
import { render, fireEvent, waitFor, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  QAPP_IMAGE_DRAG_MIME,
  UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE
} from '@renderer/utils/droppedImageUtils'

const apiMocks = vi.hoisted(() => ({
  getView: vi.fn(),
  uploadImage: vi.fn(),
  loadImageFromPhotoshop: vi.fn()
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfy: {
      getView: apiMocks.getView,
      uploadImage: apiMocks.uploadImage
    },
    svcPhotoshop: {
      loadImageFromPhotoshop: apiMocks.loadImageFromPhotoshop
    }
  })
}))

import InputComfyImage from './InputComfyImage'
import { parseDeferredComfyImageInputValue } from '@shared/comfy/deferredImages'

const notifyErrorMock = vi.fn()
const notifySuccessMock = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: notifyErrorMock,
    notifySuccess: notifySuccessMock
  })
}))

const createDataTransfer = (data: Record<string, string> = {}, files: File[] = []) =>
  ({
    files,
    getData: (key: string) => data[key] || '',
    clearData: vi.fn()
  }) as unknown as DataTransfer

describe('InputComfyImage', () => {
  beforeEach(() => {
    notifyErrorMock.mockReset()
    notifySuccessMock.mockReset()
    apiMocks.getView.mockReset()
    apiMocks.uploadImage.mockReset()
    apiMocks.loadImageFromPhotoshop.mockReset()
  })

  it('rejects unsupported external files with a clear error from the Quick App image-input path', async () => {
    render(
      <InputComfyImage
        label="Quick App Image"
        value=""
        onChange={vi.fn()}
        placeholder="Drop an image"
      />
    )

    const dropZone = screen.getByText('Drop an image').closest('[tabindex="0"]')
    expect(dropZone).toBeTruthy()

    fireEvent.drop(dropZone as Element, {
      dataTransfer: createDataTransfer({}, [
        new File(['doc'], 'brief.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        }),
        new File(['notes'], 'note.txt', { type: 'text/plain' })
      ])
    })

    await waitFor(() => {
      expect(notifyErrorMock).toHaveBeenCalledTimes(1)
    })

    expect(notifyErrorMock.mock.calls[0][0]).toContain('图片输入')
    expect(notifyErrorMock.mock.calls[0][0]).toContain('.docx')
    expect(notifyErrorMock.mock.calls[0][0]).toContain('.txt')
  })

  it('accepts local images without uploading to ComfyUI and shows a local preview', async () => {
    const onChange = vi.fn()

    render(
      <InputComfyImage
        label="Quick App Image"
        value=""
        onChange={onChange}
        placeholder="Drop an image"
      />
    )

    const dropZone = screen.getByText('Drop an image').closest('[tabindex="0"]')
    expect(dropZone).toBeTruthy()

    const file = new File(['local-image-bytes'], 'folder-photo.png', { type: 'image/png' })
    fireEvent.drop(dropZone as Element, {
      dataTransfer: createDataTransfer({}, [file])
    })

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1)
    })

    const nextValue = onChange.mock.calls[0][0] as string
    const deferredImage = parseDeferredComfyImageInputValue(nextValue)
    expect(deferredImage).toMatchObject({
      fileName: 'folder-photo.png',
      mimeType: 'image/png',
      sizeBytes: file.size
    })
    expect(deferredImage?.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(apiMocks.uploadImage).not.toHaveBeenCalled()
    expect(apiMocks.getView).not.toHaveBeenCalled()
    expect(notifyErrorMock).not.toHaveBeenCalled()

    const preview = await screen.findByRole('img', { name: 'folder-photo.png' })
    expect(preview).toHaveAttribute('src', deferredImage?.dataUrl)
  })

  it('rejects unsupported internal canvas nodes with a clear error from the Quick App image-input path', async () => {
    render(
      <InputComfyImage
        label="Quick App Image"
        value=""
        onChange={vi.fn()}
        placeholder="Drop an image"
      />
    )

    const dropZone = screen.getByText('Drop an image').closest('[tabindex="0"]')
    expect(dropZone).toBeTruthy()

    fireEvent.drop(dropZone as Element, {
      dataTransfer: createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:file-card',
          itemTypes: ['file']
        })
      })
    })

    await waitFor(() => {
      expect(notifyErrorMock).toHaveBeenCalledTimes(1)
    })

    expect(notifyErrorMock.mock.calls[0][0]).toBe(UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE)
  })

  it('preserves the selected value when preview loading fails', async () => {
    apiMocks.getView.mockRejectedValue(new Error('preview offline'))
    const onChange = vi.fn()

    render(
      <InputComfyImage
        label="Quick App Image"
        value="demo.png"
        onChange={onChange}
        placeholder="Drop an image"
      />
    )

    await waitFor(() => {
      expect(apiMocks.getView).toHaveBeenCalledTimes(1)
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('Drop an image')).toBeInTheDocument()
  })

  it('clears a selected image from the preview delete button', async () => {
    const createObjectURLMock = vi.fn(() => 'blob:preview')
    const revokeObjectURLMock = vi.fn()

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURLMock
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURLMock
    })

    apiMocks.getView.mockResolvedValue({ result: new Uint8Array([1, 2, 3]) })
    const changes: string[] = []

    const ControlledInput = () => {
      const [value, setValue] = React.useState('demo.png')
      return (
        <InputComfyImage
          label="Quick App Image"
          value={value}
          onChange={(nextValue) => {
            changes.push(nextValue)
            setValue(nextValue)
          }}
          placeholder="Drop an image"
        />
      )
    }

    render(<ControlledInput />)

    expect(await screen.findByRole('img', { name: 'demo.png' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'input.image.clear' }))

    await waitFor(() => {
      expect(changes).toContain('')
    })

    expect(screen.queryByRole('img', { name: 'demo.png' })).not.toBeInTheDocument()
    expect(screen.getByText('Drop an image')).toBeInTheDocument()
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:preview')
  })
})
