import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BaseInputComfyImage from './BaseInputComfyImage'
import {
  QAPP_IMAGE_DRAG_MIME,
  UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE
} from '@renderer/utils/droppedImageUtils'
import { resetQuickAppImagePasteTargetsForTest } from '@renderer/utils/quickAppPasteTarget'

const notifyErrorMock = vi.fn()
const fetchMock = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: notifyErrorMock
  })
}))

const createDataTransfer = (data: Record<string, string> = {}, files: File[] = []) =>
  ({
    files,
    getData: (key: string) => data[key] || '',
    clearData: vi.fn()
  }) as unknown as DataTransfer

describe('BaseInputComfyImage', () => {
  beforeEach(() => {
    notifyErrorMock.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    resetQuickAppImagePasteTargetsForTest()
    vi.unstubAllGlobals()
  })

  it('uploads a dropped image file', async () => {
    const doUpload = vi.fn().mockResolvedValue(undefined)

    render(
      <BaseInputComfyImage
        label="Image"
        internalValue=""
        isLoading={false}
        previewUrl={null}
        doUpload={doUpload}
        placeholder="Drop an image"
      />
    )

    const dropZone = screen.getByText('Drop an image').closest('[tabindex="0"]')
    expect(dropZone).toBeTruthy()

    const file = new File(['image-bytes'], 'demo.png', { type: 'image/png' })
    fireEvent.drop(dropZone as Element, {
      dataTransfer: createDataTransfer({}, [file])
    })

    await waitFor(() => {
      expect(doUpload).toHaveBeenCalledWith(file)
    })
    expect(notifyErrorMock).not.toHaveBeenCalled()
  })

  it('rejects unsupported external files with a clear error', async () => {
    const doUpload = vi.fn().mockResolvedValue(undefined)

    render(
      <BaseInputComfyImage
        label="Image"
        internalValue=""
        isLoading={false}
        previewUrl={null}
        doUpload={doUpload}
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

    expect(doUpload).not.toHaveBeenCalled()
    expect(notifyErrorMock.mock.calls[0][0]).toContain('当前图片输入只支持图片文件')
    expect(notifyErrorMock.mock.calls[0][0]).toContain('.docx')
    expect(notifyErrorMock.mock.calls[0][0]).toContain('.txt')
  })

  it('rejects unsupported internal canvas nodes with a clear error', async () => {
    const doUpload = vi.fn().mockResolvedValue(undefined)

    render(
      <BaseInputComfyImage
        label="Image"
        internalValue=""
        isLoading={false}
        previewUrl={null}
        doUpload={doUpload}
        placeholder="Drop an image"
      />
    )

    const dropZone = screen.getByText('Drop an image').closest('[tabindex="0"]')
    expect(dropZone).toBeTruthy()

    fireEvent.drop(dropZone as Element, {
      dataTransfer: createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:model3d-card',
          itemTypes: ['model3d']
        })
      })
    })

    await waitFor(() => {
      expect(notifyErrorMock).toHaveBeenCalledTimes(1)
    })

    expect(doUpload).not.toHaveBeenCalled()
    expect(notifyErrorMock.mock.calls[0][0]).toContain('当前图片输入只支持图片内容')
    expect(notifyErrorMock.mock.calls[0][0]).toContain('3D')
  })

  it('shows the unified file-format warning for internal drags that contain file attachments', async () => {
    const doUpload = vi.fn().mockResolvedValue(undefined)

    render(
      <BaseInputComfyImage
        label="Image"
        internalValue=""
        isLoading={false}
        previewUrl={null}
        doUpload={doUpload}
        placeholder="Drop an image"
      />
    )

    const dropZone = screen.getByText('Drop an image').closest('[tabindex="0"]')
    expect(dropZone).toBeTruthy()

    fireEvent.drop(dropZone as Element, {
      dataTransfer: createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:canvas-selection',
          itemTypes: ['image', 'file'],
          attachments: [
            {
              type: 'file',
              url: 'local-media:///C:/demo/spec.md',
              fileName: 'spec.md',
              mimeType: 'text/markdown'
            }
          ]
        })
      })
    })

    await waitFor(() => {
      expect(notifyErrorMock).toHaveBeenCalledTimes(1)
    })

    expect(doUpload).not.toHaveBeenCalled()
    expect(notifyErrorMock.mock.calls[0][0]).toBe(UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE)
  })

  it('accepts internal canvas drags that advertise image semantics', async () => {
    const doUpload = vi.fn().mockResolvedValue(undefined)
    fetchMock.mockResolvedValue(
      new Response(new Blob(['image-bytes'], { type: 'image/png' }), {
        status: 200
      })
    )

    render(
      <BaseInputComfyImage
        label="Image"
        internalValue=""
        isLoading={false}
        previewUrl={null}
        doUpload={doUpload}
        placeholder="Drop an image"
      />
    )

    const dropZone = screen.getByText('Drop an image').closest('[tabindex="0"]')
    expect(dropZone).toBeTruthy()

    fireEvent.drop(dropZone as Element, {
      dataTransfer: createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:text-like-preview',
          itemTypes: ['image']
        })
      })
    })

    await waitFor(() => {
      expect(doUpload).toHaveBeenCalledTimes(1)
    })

    const uploadedFile = doUpload.mock.calls[0][0] as File
    expect(uploadedFile).toBeInstanceOf(File)
    expect(uploadedFile.name).toBe('text-like-preview')
    expect(fetchMock).toHaveBeenCalledWith('blob:text-like-preview')
    expect(notifyErrorMock).not.toHaveBeenCalled()
  })

  it('renders previews without forcing the image to fill and crop the load area', () => {
    render(
      <BaseInputComfyImage
        label="Image"
        internalValue="demo.png"
        isLoading={false}
        previewUrl="blob:preview"
        doUpload={vi.fn()}
        placeholder="Drop an image"
      />
    )

    const preview = screen.getByRole('img', { name: 'demo.png' })
    expect(preview).toHaveStyle({
      display: 'block',
      maxWidth: '100%',
      maxHeight: '100%',
      width: 'auto',
      height: 'auto',
      objectFit: 'contain'
    })
  })

  it('calls onClear from the preview delete button', () => {
    const onClear = vi.fn()

    render(
      <BaseInputComfyImage
        label="Image"
        internalValue="demo.png"
        isLoading={false}
        previewUrl="blob:preview"
        doUpload={vi.fn()}
        onClear={onClear}
        placeholder="Drop an image"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'input.image.clear' }))

    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('clears the paste-target highlight when deleting the preview', () => {
    const ControlledInput = () => {
      const [previewUrl, setPreviewUrl] = React.useState<string | null>('blob:preview')
      return (
        <BaseInputComfyImage
          label="Image"
          internalValue={previewUrl ? 'demo.png' : ''}
          isLoading={false}
          previewUrl={previewUrl}
          doUpload={vi.fn()}
          onClear={() => setPreviewUrl(null)}
          placeholder="Drop an image"
        />
      )
    }

    render(<ControlledInput />)

    const dropZone = screen.getByRole('img', { name: 'demo.png' }).closest('[tabindex="0"]')
    expect(dropZone).toBeTruthy()
    fireEvent.mouseEnter(dropZone as Element)

    fireEvent.click(screen.getByRole('button', { name: 'input.image.clear' }))

    expect(screen.getByText('Drop an image')).toBeInTheDocument()
    expect(screen.queryByText('input.image.paste_hint')).not.toBeInTheDocument()
  })

  it('uploads a pasted image while the load area is hovered', async () => {
    const doUpload = vi.fn().mockResolvedValue(undefined)

    render(
      <BaseInputComfyImage
        label="Image"
        internalValue=""
        isLoading={false}
        previewUrl={null}
        doUpload={doUpload}
        placeholder="Drop an image"
      />
    )

    const dropZone = screen.getByText('Drop an image').closest('[tabindex="0"]')
    expect(dropZone).toBeTruthy()

    const file = new File(['image-bytes'], 'pasted.png', { type: 'image/png' })
    const getAsFile = vi.fn(() => file)
    fireEvent.mouseEnter(dropZone as Element)
    fireEvent.paste(document, {
      clipboardData: {
        items: [
          {
            type: 'image/png',
            getAsFile
          }
        ]
      }
    })

    await waitFor(() => {
      expect(doUpload).toHaveBeenCalledTimes(1)
    })

    const uploadedFile = doUpload.mock.calls[0][0] as File
    expect(uploadedFile).toBeInstanceOf(File)
    expect(uploadedFile.type).toBe('image/png')
    expect(getAsFile).toHaveBeenCalledTimes(1)
  })

  it('uploads a clipboard image on ctrl+v while the load area is hovered', async () => {
    const doUpload = vi.fn().mockResolvedValue(undefined)
    const getType = vi.fn().mockResolvedValue(new Blob(['image-bytes'], { type: 'image/png' }))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        read: vi.fn().mockResolvedValue([
          {
            types: ['image/png'],
            getType
          }
        ])
      }
    })

    render(
      <BaseInputComfyImage
        label="Image"
        internalValue=""
        isLoading={false}
        previewUrl={null}
        doUpload={doUpload}
        placeholder="Drop an image"
      />
    )

    const dropZone = screen.getByText('Drop an image').closest('[tabindex="0"]')
    expect(dropZone).toBeTruthy()

    fireEvent.mouseEnter(dropZone as Element)
    fireEvent.keyDown(window, {
      key: 'v',
      ctrlKey: true
    })

    await waitFor(() => {
      expect(doUpload).toHaveBeenCalledTimes(1)
    })

    const uploadedFile = doUpload.mock.calls[0][0] as File
    expect(uploadedFile).toBeInstanceOf(File)
    expect(uploadedFile.type).toBe('image/png')
    expect(getType).toHaveBeenCalledWith('image/png')
  })
})
