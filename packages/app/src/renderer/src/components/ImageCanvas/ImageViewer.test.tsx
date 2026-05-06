import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import ImageViewer from './ImageViewer'

const getQAppCfgMock = vi.fn(async () => ({ cfg: {}, workflow: {} }))

vi.mock('./utils/imageUtils', () => ({
  loadImage: vi.fn(async () => {
    const img = document.createElement('img')
    Object.defineProperty(img, 'width', { value: 640 })
    Object.defineProperty(img, 'height', { value: 360 })
    return img
  })
}))

vi.mock('./WebGLImageBoard', () => ({
  __esModule: true,
  default: () => <div data-testid="webgl-image-board" />
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: vi.fn(),
    notifyError: vi.fn()
  })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcDialog: {
      showOpenDialog: vi.fn()
    },
    svcState: {
      saveConfig: vi.fn()
    },
    svcHyper: {
      saveImageToDir: vi.fn()
    },
    svcQApp: {
      getQAppCfg: getQAppCfgMock
    }
  })
}))

describe('ImageViewer', () => {
  beforeEach(() => {
    getQAppCfgMock.mockClear()
    getQAppCfgMock.mockResolvedValue({ cfg: {}, workflow: {} })
  })

  it('shows the shipped viewplane workflow panel when the toolbar button is selected', async () => {
    render(
      <MemoryRouter>
        <ImageViewer imageUrl="https://example.com/test.png" />
      </MemoryRouter>
    )

    fireEvent.click((await screen.findByTestId('AspectRatioIcon')).closest('button')!)

    expect(
      await screen.findByText('Viewplane opens the shipped image perspective workflow')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open viewplane workflow' })).toBeInTheDocument()
  })
})
