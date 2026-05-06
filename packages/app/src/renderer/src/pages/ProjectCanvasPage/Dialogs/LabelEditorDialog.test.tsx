import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import { theme } from '@renderer/theme'
import { LabelEditorDialog } from './LabelEditorDialog'

describe('LabelEditorDialog', () => {
  it('uses the updated edit-annotation copy', () => {
    render(
      <ThemeProvider theme={theme}>
        <LabelEditorDialog
          open
          text="现有标注"
          onTextChange={vi.fn()}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />
      </ThemeProvider>
    )

    expect(screen.getByText('编辑标注')).toBeInTheDocument()
    expect(screen.queryByText('编辑标注标签')).toBeNull()
  })

  it('submits on Enter', () => {
    const onConfirm = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <LabelEditorDialog
          open
          text="现有标注"
          onTextChange={vi.fn()}
          onClose={vi.fn()}
          onConfirm={onConfirm}
        />
      </ThemeProvider>
    )

    fireEvent.keyDown(screen.getByPlaceholderText('输入标注文字 (可留空)'), { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
