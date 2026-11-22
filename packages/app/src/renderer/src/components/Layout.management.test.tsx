import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Layout from './Layout'
import layoutSlice, { type LayoutState } from '../store/slices/layoutSlice'

const mounts = vi.hoisted(() => ({
  agent: vi.fn(),
  side: vi.fn(),
  bottom: vi.fn(),
  dispatch: vi.fn()
}))
let layout: LayoutState
vi.mock('../store', () => ({
  useAppDispatch: () => mounts.dispatch,
  useAppSelector: (selector: (state: { layout: LayoutState }) => unknown) => selector({ layout })
}))
vi.mock('./TitleBar', () => ({ default: () => null }))
vi.mock('./ActivityBar', () => ({ default: () => null }))
vi.mock('./MainArea', () => ({ default: () => <main>Local management surface</main> }))
vi.mock('./AgentWorkspace', () => ({
  default: () => {
    mounts.agent()
    return <div data-testid="agent-workspace" />
  }
}))
vi.mock('./SidePanel', () => ({
  default: () => {
    mounts.side()
    return <div data-testid="side-panel" />
  }
}))
vi.mock('./BottomPanel', () => ({
  default: () => {
    mounts.bottom()
    return <div data-testid="bottom-panel" />
  }
}))

function LayoutWithNavigationStore() {
  // Selectors/dispatch remain this suite's injected passive-boundary fixture;
  // the Open hook additionally requires the same shape from a provider store.
  const [store] = React.useState(() => configureStore({ reducer: { layout: layoutSlice.reducer }, preloadedState: { layout } }))
  return <Provider store={store}><Layout /></Provider>
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/#/agent-management')
  layout = {
    activeSidePanel: 'quickapp',
    sidePanelWidth: 460,
    projectEntrySidePanelIntent: null,
    rightPanelVisible: true,
    bottomPanelVisible: true,
    bottomPanelActiveTab: 'terminal',
    bottomPanelMaximized: true,
    openTabs: [
      {
        id: 'tab-project-existing',
        label: 'Existing',
        routePath: '/canvas?id=tab-project-existing',
        closable: true
      }
    ],
    activeTabId: 'tab-project-existing',
    lastActiveProjectId: 'tab-project-existing',
    lastRoutePath: '/agent-management',
    startupRestorePending: false,
    startupRestoreSnapshot: null
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('management route panel boundary', () => {
  it('does not mount project chat, source or terminal panels even with stale active-project and saved-open/maximized flags', async () => {
    render(
      <React.StrictMode>
        <MemoryRouter initialEntries={['/agent-management']}>
          <LayoutWithNavigationStore />
        </MemoryRouter>
      </React.StrictMode>
    )
    expect(screen.getByRole('main')).toBeVisible()
    await waitFor(() => expect(mounts.dispatch).toHaveBeenCalled())
    expect(screen.queryByTestId('agent-workspace')).toBeNull()
    expect(screen.queryByTestId('side-panel')).toBeNull()
    expect(screen.queryByTestId('bottom-panel')).toBeNull()
    expect(mounts.agent).not.toHaveBeenCalled()
    expect(mounts.side).not.toHaveBeenCalled()
    expect(mounts.bottom).not.toHaveBeenCalled()
    expect(layout.bottomPanelVisible).toBe(true)
    expect(layout.rightPanelVisible).toBe(true)
    expect(mounts.dispatch.mock.calls.map(([action]) => action.type)).not.toContain(
      'layout/toggleBottomPanel'
    )
  })
  it.each([
    '/agent-management/',
    '/AGENT-MANAGEMENT',
    '/Agent-Management///',
    '/%61gent-management',
    '/agent%2Dmanagement///'
  ])(
    'keeps the overview visible and all project/terminal panels unmounted on router-equivalent path %s',
    async (route) => {
      layout.lastRoutePath = route
      window.history.replaceState(null, '', `/#${route}`)
      render(
        <MemoryRouter initialEntries={[route]}>
          <LayoutWithNavigationStore />
        </MemoryRouter>
      )
      expect(screen.getByRole('main')).toBeVisible()
      await waitFor(() => expect(mounts.dispatch).toHaveBeenCalled())
      expect(mounts.agent).not.toHaveBeenCalled()
      expect(mounts.side).not.toHaveBeenCalled()
      expect(mounts.bottom).not.toHaveBeenCalled()
    }
  )
  it('preserves the existing project panel mounts outside the management route', async () => {
    layout.lastRoutePath = '/canvas?id=tab-project-existing'
    layout.bottomPanelMaximized = false
    window.history.replaceState(null, '', '/#/canvas?id=tab-project-existing')
    render(
      <MemoryRouter initialEntries={['/canvas?id=tab-project-existing']}>
        <LayoutWithNavigationStore />
      </MemoryRouter>
    )
    expect(await screen.findByTestId('agent-workspace')).toBeInTheDocument()
    expect(await screen.findByTestId('bottom-panel')).toBeInTheDocument()
  })
})
