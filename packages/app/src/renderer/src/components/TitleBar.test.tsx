import { fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ThemeProvider } from '@mui/material'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useNavigate } from 'react-router-dom'

import TitleBar from './TitleBar'
import { theme } from '@renderer/theme'
import layoutSlice from '@renderer/store/slices/layoutSlice'
import { PROJECT_CANVAS_ROUTE_PATH } from '../pages/ProjectCanvasPage/projectCanvasRouting'

const navigateMock = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'menu.project': 'Project',
          'project.my': 'Projects',
          'project.new': 'New project',
          'menu.settings': 'Settings',
          'menu.custom_workshop': 'Workshop',
          'menu.models': 'Models',
          'titlebar.toggle_quickapp': 'Quick app',
          'titlebar.toggle_terminal': 'Terminal',
          'titlebar.toggle_agent': 'Agent'
        }) as Record<string, string>
      )[key] ?? key
  })
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    buildEnv: {
      env: {
        platform: 'windows'
      }
    }
  })
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: vi.fn()
  }
})

function createMockStore(layoutOverrides: Partial<ReturnType<typeof layoutSlice.reducer>> = {}) {
  const baseLayoutState = layoutSlice.reducer(undefined, { type: '@@INIT' })
  return configureStore({
    reducer: {
      [layoutSlice.name]: layoutSlice.reducer
    },
    preloadedState: {
      layout: {
        ...baseLayoutState,
        openTabs: [
          {
            id: 'tab-project-1',
            label: 'Project 1',
            routePath: `${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-1`,
            closable: true
          }
        ],
        activeTabId: 'tab-project-1',
        lastActiveProjectId: 'tab-project-1',
        ...layoutOverrides
      }
    }
  })
}

describe('TitleBar', () => {
  beforeEach(() => {
    navigateMock.mockReset()
    vi.mocked(useNavigate).mockReturnValue(navigateMock)
    Object.defineProperty(window, 'win', {
      configurable: true,
      value: {
        isMaximized: vi.fn(() => new Promise<boolean>(() => undefined)),
        onMaximizeChanged: vi.fn(() => vi.fn()),
        minimize: vi.fn(),
        toggleMaximize: vi.fn(),
        close: vi.fn()
      }
    })
  })

  it('opens the project home page when the titlebar logo is clicked from a canvas tab', () => {
    const store = createMockStore()

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <MemoryRouter initialEntries={[`${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-1`]}>
            <TitleBar />
          </MemoryRouter>
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('titlebar-home-logo'))

    expect(store.getState().layout.activeTabId).toBe('tab-home')
    expect(store.getState().layout.openTabs.some((tab) => tab.id === 'tab-home')).toBe(true)
    expect(navigateMock).toHaveBeenCalledWith('/')
  })
})
