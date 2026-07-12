import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MaskEditor from './MaskEditor'
import { hasAlphaChannel, loadImage, separateImageChannels } from './utils/imageUtils'

vi.mock('./utils/imageUtils', () => ({
  hasAlphaChannel: vi.fn(),
  loadImage: vi.fn(),
  separateImageChannels: vi.fn()
}))
vi.mock('react-konva', () => ({ Layer: () => null, Image: () => null, Group: () => null }))
vi.mock('konva/lib/Layer', () => ({ Layer: class Layer {} }))
vi.mock('./BaseImageCanvas', () => ({
  default: ({ paintWidth }: { paintWidth: number }) => (
    <div data-testid="base-image-canvas">{paintWidth}</div>
  )
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

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

function image(width: number): HTMLImageElement {
  const result = document.createElement('img')
  Object.defineProperty(result, 'width', { value: width })
  Object.defineProperty(result, 'height', { value: 10 })
  return result
}

describe('MaskEditor image loading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(separateImageChannels).mockRejectedValue(new Error('unexpected alpha split'))
  })

  it('guards every async stage so an old URL cannot replace the new image', async () => {
    const oldAlphaCheck = deferred<boolean>()
    const newImage = deferred<HTMLImageElement>()
    vi.mocked(hasAlphaChannel).mockImplementation((url) =>
      url === 'old' ? oldAlphaCheck.promise : Promise.resolve(false)
    )
    vi.mocked(loadImage).mockImplementation(() => newImage.promise)

    const { rerender } = render(<MaskEditor imageUrl="old" />)
    rerender(<MaskEditor imageUrl="new" />)
    await act(async () => oldAlphaCheck.resolve(true))

    expect(separateImageChannels).not.toHaveBeenCalled()
    expect(screen.getByText('image.loading')).toBeInTheDocument()

    await act(async () => newImage.resolve(image(222)))
    expect(screen.getByTestId('base-image-canvas')).toHaveTextContent('222')
  })

  it('ignores a stale failure and stale finally while the current URL is loading', async () => {
    const oldCheck = deferred<boolean>()
    const newCheck = deferred<boolean>()
    vi.mocked(hasAlphaChannel).mockImplementation((url) =>
      url === 'old' ? oldCheck.promise : newCheck.promise
    )

    const { rerender } = render(<MaskEditor imageUrl="old" />)
    rerender(<MaskEditor imageUrl="new" />)
    await act(async () => oldCheck.reject(new Error('stale failure')))

    expect(screen.getByText('image.loading')).toBeInTheDocument()
    expect(screen.queryByText(/stale failure/)).not.toBeInTheDocument()
  })
})
