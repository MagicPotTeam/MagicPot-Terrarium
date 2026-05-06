import React from 'react'
import { render, fireEvent, waitFor, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import InputComfyImage from './InputComfyImage'
import {
  QAPP_IMAGE_DRAG_MIME,
  UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE
} from '@renderer/utils/droppedImageUtils'

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
})
