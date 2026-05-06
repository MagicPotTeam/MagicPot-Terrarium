import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PromptTagEditor from './PromptTagEditor'

vi.mock('react-dnd', () => ({
  useDrag: () => [{ isDragging: false }, vi.fn()],
  useDrop: () => [{ canDrop: false }, vi.fn()]
}))

const renderPromptTagEditor = (storageKey?: string) =>
  render(
    <ThemeProvider theme={createTheme()}>
      <PromptTagEditor value="alpha, beta" onChange={vi.fn()} storageKey={storageKey} />
    </ThemeProvider>
  )

describe('PromptTagEditor collapsed state persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('remembers collapsed state for the same storage key across remounts', () => {
    const { unmount } = renderPromptTagEditor('prompt-a')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse tags' }))

    expect(localStorage.getItem('promptTagEditor.collapsed.prompt-a')).toBe('1')
    expect(screen.getByRole('button', { name: 'Expand tags' })).toBeInTheDocument()

    unmount()

    renderPromptTagEditor('prompt-a')

    expect(screen.getByRole('button', { name: 'Expand tags' })).toBeInTheDocument()
  })

  it('restores state when switching between different storage keys', () => {
    localStorage.setItem('promptTagEditor.collapsed.prompt-a', '1')
    localStorage.setItem('promptTagEditor.collapsed.prompt-b', '0')

    const { rerender } = render(
      <ThemeProvider theme={createTheme()}>
        <PromptTagEditor value="alpha, beta" onChange={vi.fn()} storageKey="prompt-a" />
      </ThemeProvider>
    )

    expect(screen.getByRole('button', { name: 'Expand tags' })).toBeInTheDocument()

    rerender(
      <ThemeProvider theme={createTheme()}>
        <PromptTagEditor value="alpha, beta" onChange={vi.fn()} storageKey="prompt-b" />
      </ThemeProvider>
    )

    expect(screen.getByRole('button', { name: 'Collapse tags' })).toBeInTheDocument()
  })
})
