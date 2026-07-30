import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ImagePreviewOverlay from './ImagePreviewOverlay'

const chatImageTranslations: Record<string, string> = {
  'chat.preview_alt': 'Image preview',
  'chat.preview_controls': '{{scale}}% image preview controls',
  'chat.image_loading': 'Loading image',
  'chat.image_load_failed': 'Image failed to load',
  'chat.retry_image': 'Retry image',
  'chat.close_image_preview': 'Close image preview'
}

const translate = (key: string, options?: Record<string, unknown>) => {
  const template =
    chatImageTranslations[key] ?? (options?.defaultValue as string | undefined) ?? key
  return template.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate })
}))

const props = {
  previewImage: 'https://example.com/image.png',
  imageScale: 1,
  imagePosition: { x: 0, y: 0 },
  isPreviewDragging: false,
  currentImageIndex: 0,
  aiImageListLength: 1,
  closePreview: vi.fn(),
  handlePreviewClick: vi.fn(),
  handlePreviewWheel: vi.fn(),
  handlePreviewMouseMove: vi.fn(),
  handlePreviewMouseUp: vi.fn(),
  handlePreviewMouseDown: vi.fn(),
  handleImageContextMenu: vi.fn()
}

describe('ImagePreviewOverlay', () => {
  it('loads eagerly with accessible controls while preserving image interactions', () => {
    render(<ImagePreviewOverlay {...props} />)

    const image = screen.getByAltText('Image preview')
    expect(image).toHaveAttribute('loading', 'eager')
    expect(image).toHaveAttribute('decoding', 'async')
    expect(screen.getByRole('status', { name: 'Loading image' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close image preview' })).toBeInTheDocument()

    fireEvent.load(image)
    expect(screen.queryByRole('status', { name: 'Loading image' })).not.toBeInTheDocument()
    fireEvent.mouseDown(image)
    fireEvent.contextMenu(image)
    expect(props.handlePreviewMouseDown).toHaveBeenCalled()
    expect(props.handleImageContextMenu).toHaveBeenCalledWith(expect.anything(), props.previewImage)
  })

  it('resets loading state when the preview URL changes and accepts a cached load', () => {
    const { rerender } = render(<ImagePreviewOverlay {...props} />)
    fireEvent.load(screen.getByAltText('Image preview'))

    rerender(<ImagePreviewOverlay {...props} previewImage="https://example.com/new.png" />)
    const nextImage = screen.getByAltText('Image preview')
    expect(nextImage).toHaveAttribute('src', 'https://example.com/new.png')
    expect(screen.getByRole('status', { name: 'Loading image' })).toBeInTheDocument()

    Object.defineProperties(nextImage, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 640 }
    })
    fireEvent.load(nextImage)
    expect(screen.queryByRole('status', { name: 'Loading image' })).not.toBeInTheDocument()
  })

  it('cache-busts HTTP retries but safely remounts local sources unchanged', () => {
    const { rerender } = render(<ImagePreviewOverlay {...props} />)
    fireEvent.error(screen.getByAltText('Image preview'))
    expect(screen.getByRole('alert')).toHaveTextContent('Image failed to load')

    fireEvent.click(screen.getByRole('button', { name: 'Retry image' }))
    expect(screen.getByAltText('Image preview').getAttribute('src')).toContain('_magicpot_retry=1')

    rerender(<ImagePreviewOverlay {...props} previewImage="blob:preview-image" />)
    fireEvent.error(screen.getByAltText('Image preview'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry image' }))
    expect(screen.getByAltText('Image preview')).toHaveAttribute('src', 'blob:preview-image')
  })

  it('offers a translated close action after a load error', () => {
    const closePreview = vi.fn()
    render(<ImagePreviewOverlay {...props} closePreview={closePreview} />)

    fireEvent.error(screen.getByAltText('Image preview'))
    fireEvent.click(screen.getByText('Close image preview'))
    expect(closePreview).toHaveBeenCalled()
  })
})
