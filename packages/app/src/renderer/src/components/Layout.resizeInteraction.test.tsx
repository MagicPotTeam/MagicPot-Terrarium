import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Layout from './Layout'
import layoutSlice, { type LayoutState } from '../store/slices/layoutSlice'
import {
  CANVAS_LAYOUT_RESIZE_INTERACTION_EVENT,
  getCanvasLayoutResizeInteractionState,
  type CanvasLayoutResizeInteractionDetail
} from '../pages/ProjectCanvasPage/canvasLayoutResizeInteraction'

const mounts = vi.hoisted(() => ({
  agentRenders: vi.fn(),
  mainAreaRenders: vi.fn(),
  titleBarRenders: vi.fn(),
  activityBarRenders: vi.fn(),
  dispatch: vi.fn()
}))
let layout: LayoutState
vi.mock('../store', () => ({
  useAppDispatch: () => mounts.dispatch,
  useAppSelector: (selector: (state: { layout: LayoutState }) => unknown) => selector({ layout })
}))
vi.mock('./TitleBar', () => ({
  default: () => {
    mounts.titleBarRenders()
    return null
  }
}))
vi.mock('./ActivityBar', () => ({
  default: () => {
    mounts.activityBarRenders()
    return null
  }
}))
vi.mock('./MainArea', () => ({
  default: () => {
    mounts.mainAreaRenders()
    return <main data-testid="main-area" />
  }
}))
vi.mock('./AgentWorkspace', () => ({
  default: () => {
    mounts.agentRenders()
    return <div data-testid="agent-workspace" />
  }
}))
vi.mock('./SidePanel', () => ({ default: () => <div data-testid="side-panel" /> }))
vi.mock('./BottomPanel', () => ({ default: () => <div data-testid="bottom-panel" /> }))

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

const CANVAS_ROUTE = '/canvas?id=tab-project-existing'

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={[CANVAS_ROUTE]}>
      <LayoutWithNavigationStore />
    </MemoryRouter>
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

function recordResizeInteractionEvents() {
  const events: CanvasLayoutResizeInteractionDetail[] = []
  const listener = (event: Event) => {
    events.push({ ...(event as CustomEvent<CanvasLayoutResizeInteractionDetail>).detail })
  }
  window.addEventListener(CANVAS_LAYOUT_RESIZE_INTERACTION_EVENT, listener)
  return {
    events,
    dispose: () => window.removeEventListener(CANVAS_LAYOUT_RESIZE_INTERACTION_EVENT, listener)
  }
}

async function findPanels() {
  await screen.findByTestId('agent-workspace')
  const handle = document.querySelector(
    '[data-canvas-document-drop-bypass="right-panel-resize"]'
  ) as HTMLElement
  const rightPanel = document.querySelector(
    '[data-canvas-document-drop-bypass="right-panel"]'
  ) as HTMLElement
  const mainArea = screen.getByTestId('main-area').parentElement as HTMLElement
  expect(handle).not.toBeNull()
  expect(rightPanel).not.toBeNull()
  return { handle, rightPanel, mainArea }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', `/#${CANVAS_ROUTE}`)
  layout = {
    activeSidePanel: null,
    sidePanelWidth: 460,
    projectEntrySidePanelIntent: null,
    rightPanelVisible: true,
    bottomPanelVisible: false,
    bottomPanelActiveTab: 'terminal',
    bottomPanelMaximized: false,
    openTabs: [
      {
        id: 'tab-project-existing',
        label: 'Existing',
        routePath: CANVAS_ROUTE,
        closable: true
      }
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

describe('Layout Agent column resize interaction', () => {
  it('emits one start and one end per drag and moves the column without React renders', async () => {
    renderLayout()
    const { handle, rightPanel, mainArea } = await findPanels()
    const recorder = recordResizeInteractionEvents()
    try {
      const agentRendersBefore = mounts.agentRenders.mock.calls.length
      const mainAreaRendersBefore = mounts.mainAreaRenders.mock.calls.length

      fireEvent.mouseDown(handle, { clientX: 1000, buttons: 1 })
      expect(recorder.events).toEqual([{ active: true, source: 'right' }])
      expect(getCanvasLayoutResizeInteractionState().active).toBe(true)

      for (let step = 1; step <= 5; step += 1) {
        fireEvent.mouseMove(window, { clientX: 1000 - step * 12, buttons: 1 })
        await nextFrame()
      }

      // 420 px default + 60 px: written to the elements, not committed through React.
      expect(rightPanel.style.width).toBe('480px')
      expect(rightPanel.style.minWidth).toBe('480px')
      expect(mainArea.style.right).toBe('480px')
      expect(mounts.agentRenders.mock.calls.length).toBe(agentRendersBefore)
      expect(mounts.mainAreaRenders.mock.calls.length).toBe(mainAreaRendersBefore)
      expect(recorder.events).toHaveLength(1)

      fireEvent.mouseUp(window)

      expect(recorder.events).toEqual([
        { active: true, source: 'right' },
        { active: false, source: 'right' }
      ])
      expect(getCanvasLayoutResizeInteractionState().active).toBe(false)
      // Committed once; the inline overrides are gone and the styles carry the final width.
      expect(rightPanel.style.width).toBe('')
      expect(mainArea.style.right).toBe('')
      expect(getComputedStyle(rightPanel).width).toBe('480px')
      expect(getComputedStyle(mainArea).right).toBe('480px')

      fireEvent.mouseUp(window)
      fireEvent.mouseMove(window, { clientX: 700, buttons: 0 })
      expect(recorder.events).toHaveLength(2)
    } finally {
      recorder.dispose()
    }
  })

  it('commits the final width without re-rendering the title bar, activity bar or Agent column', async () => {
    renderLayout()
    const { handle, rightPanel } = await findPanels()
    const agentRendersBefore = mounts.agentRenders.mock.calls.length
    const titleBarRendersBefore = mounts.titleBarRenders.mock.calls.length
    const activityBarRendersBefore = mounts.activityBarRenders.mock.calls.length
    expect(titleBarRendersBefore).toBeGreaterThan(0)
    expect(activityBarRendersBefore).toBeGreaterThan(0)

    fireEvent.mouseDown(handle, { clientX: 1000, buttons: 1 })
    fireEvent.mouseMove(window, { clientX: 940, buttons: 1 })
    await nextFrame()
    fireEvent.mouseUp(window)

    // The width is committed through Layout state...
    expect(getComputedStyle(rightPanel).width).toBe('480px')
    // ...but nothing inside the frame depends on it.
    expect(mounts.agentRenders.mock.calls.length).toBe(agentRendersBefore)
    expect(mounts.titleBarRenders.mock.calls.length).toBe(titleBarRendersBefore)
    expect(mounts.activityBarRenders.mock.calls.length).toBe(activityBarRendersBefore)
  })

  it('ends the drag when the window loses focus', async () => {
    renderLayout()
    const { handle, rightPanel } = await findPanels()
    const recorder = recordResizeInteractionEvents()
    try {
      fireEvent.mouseDown(handle, { clientX: 1000, buttons: 1 })
      fireEvent.mouseMove(window, { clientX: 980, buttons: 1 })
      await nextFrame()
      act(() => {
        window.dispatchEvent(new Event('blur'))
      })

      expect(recorder.events.map((event) => event.active)).toEqual([true, false])
      expect(getComputedStyle(rightPanel).width).toBe('440px')
      fireEvent.mouseMove(window, { clientX: 900, buttons: 1 })
      await nextFrame()
      expect(getComputedStyle(rightPanel).width).toBe('440px')
    } finally {
      recorder.dispose()
    }
  })

  it('ends the drag when the button was released outside the window', async () => {
    renderLayout()
    const { handle, rightPanel } = await findPanels()
    const recorder = recordResizeInteractionEvents()
    try {
      fireEvent.mouseDown(handle, { clientX: 1000, buttons: 1 })
      fireEvent.mouseMove(window, { clientX: 970, buttons: 1 })
      await nextFrame()
      // The mouseup happened outside; the next move arrives with no button pressed.
      fireEvent.mouseMove(window, { clientX: 900, buttons: 0 })

      expect(recorder.events.map((event) => event.active)).toEqual([true, false])
      expect(getComputedStyle(rightPanel).width).toBe('450px')
      expect(rightPanel.style.width).toBe('')
    } finally {
      recorder.dispose()
    }
  })

  it('ends the drag when the layout unmounts in the middle of it', async () => {
    const { unmount } = renderLayout()
    const { handle } = await findPanels()
    const recorder = recordResizeInteractionEvents()
    try {
      fireEvent.mouseDown(handle, { clientX: 1000, buttons: 1 })
      unmount()

      expect(recorder.events.map((event) => event.active)).toEqual([true, false])
      expect(getCanvasLayoutResizeInteractionState().active).toBe(false)
    } finally {
      recorder.dispose()
    }
  })
})
