import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import ImageViewer from './ImageViewer'
import { loadImage } from './utils/imageUtils'

const getQAppCfgMock = vi.fn(async () => ({ cfg: {}, workflow: {} }))

vi.mock('./utils/imageUtils', () => ({ loadImage: vi.fn() }))
vi.mock('./WebGLImageBoard', () => ({
  __esModule: true,
  default: ({ image }: { image: HTMLImageElement }) => (
    <div data-testid="webgl-image-board">{image.dataset.url}</div>
  )
}))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() })
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcDialog: { showOpenDialog: vi.fn() },
    svcState: { saveConfig: vi.fn() },
    svcHyper: { saveImageToDir: vi.fn() },
    svcQApp: { getQAppCfg: getQAppCfgMock }
  })
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function image(url = 'loaded'): HTMLImageElement {
  const result = document.createElement('img')
  result.dataset.url = url
  Object.defineProperty(result, 'width', { value: 640 })
  Object.defineProperty(result, 'height', { value: 360 })
  return result
}

describe('ImageViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadImage).mockResolvedValue(image())
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

  it('ignores a stale image result after imageUrl changes', async () => {
    const first = deferred<HTMLImageElement>()
    const second = deferred<HTMLImageElement>()
    vi.mocked(loadImage).mockImplementation((url) =>
      url === 'first' ? first.promise : second.promise
    )

    const { rerender } = render(<ImageViewer imageUrl="first" />)
    rerender(<ImageViewer imageUrl="second" />)

    await act(async () => second.resolve(image('second')))
    expect(screen.getByTestId('webgl-image-board')).toHaveTextContent('second')

    await act(async () => first.resolve(image('first')))
    expect(screen.getByTestId('webgl-image-board')).toHaveTextContent('second')
  })

  it('does not let a stale rejection end the current request loading state', async () => {
    const first = deferred<HTMLImageElement>()
    const second = deferred<HTMLImageElement>()
    vi.mocked(loadImage).mockImplementation((url) =>
      url === 'first' ? first.promise : second.promise
    )

    const { rerender } = render(<ImageViewer imageUrl="first" />)
    rerender(<ImageViewer imageUrl="second" />)
    await act(async () => first.reject(new Error('stale failure')))

    expect(screen.getByText('image.loading')).toBeInTheDocument()
    expect(screen.queryByText(/stale failure/)).not.toBeInTheDocument()
  })
})
