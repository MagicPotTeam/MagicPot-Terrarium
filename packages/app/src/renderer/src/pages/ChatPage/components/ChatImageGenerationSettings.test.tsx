import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import { theme } from '@renderer/theme'
import ChatImageGenerationSettings from './ChatImageGenerationSettings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      language: 'zh-CN',
      resolvedLanguage: 'zh-CN'
    }
  })
}))

describe('ChatImageGenerationSettings', () => {
  it('shows localized auto placeholders when image size dimensions are empty', () => {
    render(
      <ThemeProvider theme={theme}>
        <ChatImageGenerationSettings
          value={{
            enabled: true,
            size: 'auto',
            outputFormat: 'png',
            quality: 'high',
            background: 'auto'
          }}
          onChange={vi.fn()}
        />
      </ThemeProvider>
    )

    fireEvent.click(screen.getByTestId('chat-image-generation-settings-button'))

    expect(screen.getAllByPlaceholderText('自动')).toHaveLength(2)
    expect(screen.getByText('宽度和高度需为 16 的倍数')).toBeTruthy()
  })

  it('keeps normalized reference image dimensions editable', () => {
    const onChange = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <ChatImageGenerationSettings
          value={{
            enabled: true,
            size: 'auto',
            outputFormat: 'png',
            quality: 'high',
            background: 'auto'
          }}
          onChange={onChange}
          referenceImageSize={{
            width: 1152,
            height: 208
          }}
        />
      </ThemeProvider>
    )

    fireEvent.click(screen.getByTestId('chat-image-generation-settings-button'))

    const widthInput = screen.getByDisplayValue('1776') as HTMLInputElement
    const heightInput = screen.getByDisplayValue('592') as HTMLInputElement

    expect(widthInput.disabled).toBe(false)
    expect(heightInput.disabled).toBe(false)

    fireEvent.change(heightInput, { target: { value: '768' } })

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        size: '1776x768'
      })
    )
  })
})
