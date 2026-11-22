import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Layout from './Layout'
import layoutSlice, { type LayoutState } from '../store/slices/layoutSlice'

const probes = vi.hoisted(() => ({
  canvasPageRenders: vi.fn(),
  settingsPageRenders: vi.fn(),
  dispatch: vi.fn(),
  navigate: null as null | ((path: string) => void)
}))
let layout: LayoutState
vi.mock('../store', () => ({
  useAppDispatch: () => probes.dispatch,
  useAppSelector: (selector: (state: { layout: LayoutState }) => unknown) => selector({ layout })
}))
vi.mock('../routes', () => ({
  routes: [
    {
      id: 'canvas',
      path: '/canvas',
      Page: function CanvasPageProbe() {
        probes.canvasPageRenders()
        const navigate = useNavigate()
        probes.navigate = navigate
        return <div data-testid="canvas-page" />
      }
    },
    {
      id: 'settings',
      path: '/settings',
      Page: function SettingsPageProbe() {
        probes.settingsPageRenders()
        return <div data-testid="settings-page" />
      }
    }
  ]
}))
vi.mock('./TitleBar', () => ({ default: () => null }))
vi.mock('./ActivityBar', () => ({ default: () => null }))
vi.mock('./AgentWorkspace', () => ({ default: () => <div data-testid="agent-workspace" /> }))
vi.mock('./SidePanel', () => ({ default: () => <div data-testid="side-panel" /> }))
vi.mock('./BottomPanel', () => ({ default: () => <div data-testid="bottom-panel" /> }))

const CANVAS_ROUTE = '/canvas?id=tab-project-existing'

function LayoutWithNavigationStore() {
  const [store] = React.useState(() =>
    configureStore({ reducer: { layout: layoutSlice.reducer }, preloadedState: { layout } })
  )
  return (
    <Provider store={store}>
      <Layout />
    </Provider>
  )
}

function nextFrame() {
  return act(
    () =>
      new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve())
      })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', `/#${CANVAS_ROUTE}`)
  layout = {
    activeSidePanel: null,
    sidePanelWidth: 460,
    projectEntrySidePanelIntent: null,
    rightPanelVisible: true,
    bottomPanelVisible: true,
    bottomPanelActiveTab: 'terminal',
    bottomPanelMaximized: false,
    openTabs: [
      { id: 'tab-project-existing', label: 'Existing', routePath: CANVAS_ROUTE, closable: true }
    ],
    activeTabId: 'tab-project-existing',
    lastActiveProjectId: 'tab-project-existing',
    lastRoutePath: CANVAS_ROUTE,
    startupRestorePending: false,
    startupRestoreSnapshot: null
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MainArea memoisation', () => {
  it('does not re-render the page when Layout commits a new Agent column width or panel height', async () => {
    render(
      <MemoryRouter initialEntries={[CANVAS_ROUTE]}>
        <LayoutWithNavigationStore />
      </MemoryRouter>
    )
    await screen.findByTestId('canvas-page')
    await screen.findByTestId('agent-workspace')
    const rendersBefore = probes.canvasPageRenders.mock.calls.length

    const rightHandle = document.querySelector(
      '[data-canvas-document-drop-bypass="right-panel-resize"]'
    ) as HTMLElement
    fireEvent.mouseDown(rightHandle, { clientX: 1000, buttons: 1 })
    fireEvent.mouseMove(window, { clientX: 940, buttons: 1 })
    await nextFrame()
    fireEvent.mouseUp(window)
    const rightPanel = document.querySelector(
      '[data-canvas-document-drop-bypass="right-panel"]'
    ) as HTMLElement
    expect(getComputedStyle(rightPanel).width).toBe('480px')

    // The bottom panel still commits its height per frame through Layout state.
    const bottomPanel = await screen.findByTestId('bottom-panel')
    const bottomHandle = bottomPanel.parentElement?.parentElement?.firstElementChild as HTMLElement
    fireEvent.mouseDown(bottomHandle, { clientY: 700, buttons: 1 })
    fireEvent.mouseMove(window, { clientY: 650, buttons: 1 })
    await nextFrame()
    fireEvent.mouseMove(window, { clientY: 620, buttons: 1 })
    await nextFrame()
    fireEvent.mouseUp(window)

    expect(probes.canvasPageRenders.mock.calls.length).toBe(rendersBefore)
  })

  it('still renders the page that the route selects', async () => {
    render(
      <MemoryRouter initialEntries={[CANVAS_ROUTE]}>
        <LayoutWithNavigationStore />
      </MemoryRouter>
    )
    await screen.findByTestId('canvas-page')

    act(() => {
      probes.navigate?.('/settings')
    })

    expect(await screen.findByTestId('settings-page')).toBeInTheDocument()
    expect(screen.queryByTestId('canvas-page')).toBeNull()
  })
})
