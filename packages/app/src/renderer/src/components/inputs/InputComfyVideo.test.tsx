import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InputComfyVideo from './InputComfyVideo'

const comfyMocks = vi.hoisted(() => ({
  getView: vi.fn(),
  uploadImage: vi.fn()
}))
const notifyErrorMock = vi.hoisted(() => vi.fn())

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfy: {
      getView: comfyMocks.getView,
      uploadImage: comfyMocks.uploadImage
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
    comfyMocks.getView.mockReset()
    comfyMocks.uploadImage.mockReset()
    notifyErrorMock.mockReset()
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
    comfyMocks.getView.mockRejectedValueOnce(new Error('ComfyUI busy'))

    render(
      <InputComfyVideo
        label="Video"
        value="clip.mp4"
        onChange={onChange}
        placeholder="Upload video"
      />
    )

    await waitFor(() => expect(comfyMocks.getView).toHaveBeenCalled())
    expect(onChange).not.toHaveBeenCalled()
  })
})
