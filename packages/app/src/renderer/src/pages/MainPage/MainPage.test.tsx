import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ThemeProvider } from '@mui/material'
import MainPage from './MainPage'
import { theme } from '@renderer/theme'
import layoutSlice from '@renderer/store/slices/layoutSlice'
import { useNavigate } from 'react-router-dom'
import { PROJECT_CANVAS_ROUTE_PATH } from '../ProjectCanvasPage/projectCanvasRouting'

const navigateMock = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'project.my': 'My Projects',
          'project.new': 'New Project',
          'project.delete_title': 'Delete Project',
          'project.delete_desc': 'Delete this project?',
          'project.delete_dont_ask': "Don't ask again",
          'project.cancel': 'Cancel',
          'project.delete_confirm': 'Delete'
        }) as Record<string, string>
      )[key] ?? key
  })
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: vi.fn()
  }
})

const createMockStore = () =>
  configureStore({
    reducer: {
      [layoutSlice.name]: layoutSlice.reducer
    }
  })

describe('MainPage', () => {
  beforeEach(() => {
    localStorage.clear()
    navigateMock.mockReset()
    vi.mocked(useNavigate).mockReturnValue(navigateMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('creates a project without leaving the project list page', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1711324800000)
    const store = createMockStore()

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <MainPage />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByText('New Project'))

    expect(navigateMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()

    expect(store.getState().layout.activeTabId).toBe('tab-project-1711324800000')
    expect(store.getState().layout.openTabs).toEqual([
      {
        id: 'tab-project-1711324800000',
        label: '1',
        routePath: `${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-1711324800000`,
        closable: true
      }
    ])

    expect(JSON.parse(localStorage.getItem('ai_engine_projects') ?? '[]')).toEqual([
      {
        id: 'tab-project-1711324800000',
        name: '1',
        createdAt: 1711324800000
      }
    ])
  })

  it('shows an opening overlay before navigating into an existing project canvas', () => {
    vi.useFakeTimers()
    localStorage.setItem(
      'ai_engine_projects',
      JSON.stringify([{ id: 'tab-project-42', name: 'Project 42', createdAt: 1711324800000 }])
    )
    const store = createMockStore()

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <MainPage />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByText('Project 42'))

    expect(screen.getByTestId('project-open-overlay')).toBeInTheDocument()
    expect(navigateMock).not.toHaveBeenCalled()
    expect(store.getState().layout.activeTabId).toBe('')

    vi.advanceTimersByTime(0)

    expect(store.getState().layout.activeTabId).toBe('tab-project-42')
    expect(store.getState().layout.openTabs).toEqual([
      {
        id: 'tab-project-42',
        label: 'Project 42',
        routePath: `${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`,
        closable: true
      }
    ])
    expect(navigateMock).toHaveBeenCalledWith(`${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`)
  })
})
