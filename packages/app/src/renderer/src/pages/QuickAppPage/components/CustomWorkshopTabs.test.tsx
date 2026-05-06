import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { theme } from '@renderer/theme'
import CustomWorkshopTabs from './CustomWorkshopTabs'

const { navigateMock, useLocationMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  useLocationMock: vi.fn()
}))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useLocation: () => useLocationMock()
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      (
        ({
          'menu.custom_app': 'Custom App',
          'custom_workshop.custom_skill': 'Custom Skill'
        }) as Record<string, string>
      )[key] ??
      options?.defaultValue ??
      key
  })
}))

describe('CustomWorkshopTabs', () => {
  beforeEach(() => {
    navigateMock.mockReset()
    useLocationMock.mockReset()
  })

  it('shows the two top-level workshop tabs', () => {
    useLocationMock.mockReturnValue({ pathname: '/qappdesign' })

    render(
      <ThemeProvider theme={theme}>
        <CustomWorkshopTabs />
      </ThemeProvider>
    )

    expect(screen.getByRole('tab', { name: 'Custom App' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Custom Skill' })).toHaveAttribute(
      'aria-selected',
      'false'
    )
  })

  it('navigates to the other page when a tab is clicked', () => {
    useLocationMock.mockReturnValue({ pathname: '/custom-skill-manager' })

    render(
      <ThemeProvider theme={theme}>
        <CustomWorkshopTabs />
      </ThemeProvider>
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Custom App' }))
    expect(navigateMock).toHaveBeenCalledWith('/qappdesign')
  })
})
