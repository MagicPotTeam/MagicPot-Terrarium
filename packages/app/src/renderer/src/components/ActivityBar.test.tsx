import { fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ThemeProvider } from '@mui/material'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ActivityBar from './ActivityBar'
import { theme } from '@renderer/theme'
import layoutSlice from '@renderer/store/slices/layoutSlice'
import { useLocation, useNavigate } from 'react-router-dom'
import { PROJECT_CANVAS_ROUTE_PATH } from '../pages/ProjectCanvasPage/projectCanvasRouting'

const navigateMock = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'menu.home': '首页',
          'menu.project': '项目',
          'menu.quick_app': '快应用',
          'menu.custom_workshop': '自定义工坊',
          'menu.models': '模型',
          'menu.terminal': '终端',
          'menu.settings': '设置'
        }) as Record<string, string>
      )[key] ?? key
  })
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useLocation: vi.fn(),
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
            label: '椤圭洰 1',
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

describe('ActivityBar', () => {
  beforeEach(() => {
    navigateMock.mockReset()
    vi.mocked(useNavigate).mockReturnValue(navigateMock)
    vi.mocked(useLocation).mockReturnValue({
      pathname: PROJECT_CANVAS_ROUTE_PATH,
      search: '?id=tab-project-1',
      hash: '',
      state: null,
      key: 'canvas'
    })
  })

  it('does not render the left-bottom tagging toolkit entry', () => {
    const store = createMockStore()

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    expect(screen.queryByTestId('activity-bar-toolkit')).toBeNull()
  })

  it('labels the home entry as project', () => {
    const store = createMockStore()

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    expect(screen.getByTestId('activity-bar-project')).toHaveAttribute('aria-label', '项目')
  })

  it('keeps the project entry highlighted while quick app is open', () => {
    const store = createMockStore({
      activeSidePanel: 'quickapp',
      rightPanelVisible: false
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    expect(screen.getByTestId('activity-bar-project')).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the project entry highlighted while agent is open', () => {
    const store = createMockStore({
      activeSidePanel: null,
      rightPanelVisible: true
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    expect(screen.getByTestId('activity-bar-project')).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens the project home page when the project entry is clicked from a canvas tab', () => {
    const store = createMockStore()

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('activity-bar-project'))

    expect(store.getState().layout.activeTabId).toBe('tab-home')
    expect(store.getState().layout.openTabs.some((tab) => tab.id === 'tab-home')).toBe(true)
    expect(navigateMock).toHaveBeenCalledWith('/')
  })

  it('keeps agent visible when the quick app entry is clicked from another tab', () => {
    const store = createMockStore({
      activeTabId: 'tab-design',
      activeSidePanel: null,
      rightPanelVisible: true
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('activity-bar-quickapp'))

    expect(store.getState().layout.activeTabId).toBe('tab-project-1')
    expect(store.getState().layout.activeSidePanel).toBe('quickapp')
    expect(store.getState().layout.projectEntrySidePanelIntent).toBe('quickapp')
    expect(store.getState().layout.rightPanelVisible).toBe(true)
    expect(navigateMock).toHaveBeenCalledWith(`${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-1`)
  })

  it('keeps quick app visible when the agent entry is clicked from another tab', () => {
    const store = createMockStore({
      activeTabId: 'tab-design',
      activeSidePanel: 'quickapp',
      rightPanelVisible: false
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('activity-bar-agent'))

    expect(store.getState().layout.activeTabId).toBe('tab-project-1')
    expect(store.getState().layout.activeSidePanel).toBe('quickapp')
    expect(store.getState().layout.rightPanelVisible).toBe(true)
    expect(navigateMock).toHaveBeenCalledWith(`${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-1`)
  })

  it('switches back to the canvas when quick app is clicked from another route on the active project tab', () => {
    vi.mocked(useLocation).mockReturnValue({
      pathname: '/model',
      search: '',
      hash: '',
      state: null,
      key: 'model'
    })
    const store = createMockStore({
      activeTabId: 'tab-project-1',
      activeSidePanel: 'quickapp',
      rightPanelVisible: true
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('activity-bar-quickapp'))

    expect(store.getState().layout.activeTabId).toBe('tab-project-1')
    expect(store.getState().layout.activeSidePanel).toBe('quickapp')
    expect(store.getState().layout.projectEntrySidePanelIntent).toBe('quickapp')
    expect(store.getState().layout.rightPanelVisible).toBe(true)
    expect(navigateMock).toHaveBeenCalledWith(`${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-1`)
  })

  it('switches back to the canvas when agent is clicked from another route on the active project tab', () => {
    vi.mocked(useLocation).mockReturnValue({
      pathname: '/model',
      search: '',
      hash: '',
      state: null,
      key: 'model'
    })
    const store = createMockStore({
      activeTabId: 'tab-project-1',
      activeSidePanel: 'quickapp',
      rightPanelVisible: false
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('activity-bar-agent'))

    expect(store.getState().layout.activeTabId).toBe('tab-project-1')
    expect(store.getState().layout.activeSidePanel).toBe('quickapp')
    expect(store.getState().layout.rightPanelVisible).toBe(true)
    expect(navigateMock).toHaveBeenCalledWith(`${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-1`)
  })

  it('opens quick app on the current project without hiding agent', () => {
    const store = createMockStore({
      activeSidePanel: null,
      rightPanelVisible: true
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('activity-bar-quickapp'))

    expect(store.getState().layout.activeSidePanel).toBe('quickapp')
    expect(store.getState().layout.rightPanelVisible).toBe(true)
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('closes quick app when the quick app entry is clicked while quick app is visible', () => {
    const store = createMockStore({
      activeSidePanel: 'quickapp',
      rightPanelVisible: false
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('activity-bar-quickapp'))

    expect(store.getState().layout.activeSidePanel).toBeNull()
    expect(store.getState().layout.rightPanelVisible).toBe(false)
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('closes quick app while leaving agent visible when both are open', () => {
    const store = createMockStore({
      activeSidePanel: 'quickapp',
      rightPanelVisible: true
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('activity-bar-quickapp'))

    expect(store.getState().layout.activeSidePanel).toBeNull()
    expect(store.getState().layout.rightPanelVisible).toBe(true)
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('opens agent on the current project without hiding quick app', () => {
    const store = createMockStore({
      activeSidePanel: 'quickapp',
      rightPanelVisible: false
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('activity-bar-agent'))

    expect(store.getState().layout.activeSidePanel).toBe('quickapp')
    expect(store.getState().layout.rightPanelVisible).toBe(true)
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('closes agent when the agent entry is clicked while agent is visible', () => {
    const store = createMockStore({
      activeSidePanel: null,
      rightPanelVisible: true
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('activity-bar-agent'))

    expect(store.getState().layout.activeSidePanel).toBeNull()
    expect(store.getState().layout.rightPanelVisible).toBe(false)
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('closes agent while leaving quick app visible when both are open', () => {
    const store = createMockStore({
      activeSidePanel: 'quickapp',
      rightPanelVisible: true
    })

    render(
      <Provider store={store}>
        <ThemeProvider theme={theme}>
          <ActivityBar />
        </ThemeProvider>
      </Provider>
    )

    fireEvent.click(screen.getByTestId('activity-bar-agent'))

    expect(store.getState().layout.activeSidePanel).toBe('quickapp')
    expect(store.getState().layout.rightPanelVisible).toBe(false)
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
