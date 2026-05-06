import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  hasActiveQuickAppImagePasteTarget,
  resetQuickAppImagePasteTargetsForTest
} from '@renderer/utils/quickAppPasteTarget'
import { useImagePasteTarget } from './useImagePasteTarget'

const Harness: React.FC<{
  onPasteImage: (targetId: string, file: File) => void | Promise<void>
}> = ({ onPasteImage }) => {
  const { getPasteTargetProps, isPasteTargetActive } = useImagePasteTarget({
    onPasteImage
  })

  return (
    <div>
      <div data-testid="target" {...getPasteTargetProps('single')}>
        {isPasteTargetActive('single') ? 'active' : 'idle'}
      </div>
    </div>
  )
}

describe('useImagePasteTarget', () => {
  afterEach(() => {
    resetQuickAppImagePasteTargetsForTest()
  })

  it('uploads a pasted image while the target is hovered', async () => {
    const onPasteImage = vi.fn().mockResolvedValue(undefined)

    render(<Harness onPasteImage={onPasteImage} />)

    const target = screen.getByTestId('target')
    const clipboardFile = new File(['image-bytes'], 'clipboard.png', { type: 'image/png' })
    const getAsFile = vi.fn(() => clipboardFile)

    fireEvent.mouseEnter(target)

    expect(screen.getByText('active')).toBeTruthy()
    expect(hasActiveQuickAppImagePasteTarget()).toBe(true)

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
      expect(onPasteImage).toHaveBeenCalledTimes(1)
    })

    expect(onPasteImage.mock.calls[0][0]).toBe('single')
    expect(onPasteImage.mock.calls[0][1]).toBeInstanceOf(File)
    expect(getAsFile).toHaveBeenCalledTimes(1)
  })

  it('releases the active paste target when the pointer leaves', () => {
    const onPasteImage = vi.fn().mockResolvedValue(undefined)

    render(<Harness onPasteImage={onPasteImage} />)

    const target = screen.getByTestId('target')

    fireEvent.mouseEnter(target)
    expect(hasActiveQuickAppImagePasteTarget()).toBe(true)

    fireEvent.mouseLeave(target)

    expect(screen.getByText('idle')).toBeTruthy()
    expect(hasActiveQuickAppImagePasteTarget()).toBe(false)
  })
})
