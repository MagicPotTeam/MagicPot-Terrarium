import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import { theme } from '@renderer/theme'
import CanvasFileActionToolbar from './CanvasFileActionToolbar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

describe('CanvasFileActionToolbar', () => {
  it('renders file drag and chat actions', () => {
    const onDragStart = vi.fn()
    const onChat = vi.fn()

    const { container } = render(
      <ThemeProvider theme={theme}>
        <CanvasFileActionToolbar
          position={{ left: 120, top: 240 }}
          onDragStart={onDragStart}
          onChat={onChat}
        />
      </ThemeProvider>
    )

    const toolbar = container.querySelector('.file-action-toolbar')
    expect(toolbar).toBeTruthy()
    expect(toolbar?.querySelectorAll('button')).toHaveLength(2)

    const buttons = toolbar?.querySelectorAll<HTMLButtonElement>('button') ?? null
    expect(buttons).not.toBeNull()
    fireEvent.dragStart(buttons!.item(0), { dataTransfer: {} })
    fireEvent.click(buttons!.item(1))

    expect(onDragStart).toHaveBeenCalledTimes(1)
    expect(onChat).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument()
  })
})
