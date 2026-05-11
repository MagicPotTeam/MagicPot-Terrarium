import { describe, expect, it } from 'vitest'
import { resolveTabRoutePath, saveState, type LayoutState } from './layoutSlice'
import {
  LEGACY_PROJECT_WEBGL_ROUTE_PATH,
  PROJECT_CANVAS_ROUTE_PATH
} from '../../pages/ProjectWebglPage/projectWebglRouting'

describe('layoutSlice project route persistence', () => {
  it('normalizes legacy WebGL project routes to ProjectCanvas', () => {
    expect(
      resolveTabRoutePath({
        id: 'tab-project-42',
        routePath: `${LEGACY_PROJECT_WEBGL_ROUTE_PATH}?id=tab-project-42`
      })
    ).toBe(`${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`)
  })

  it('constructs canonical ProjectCanvas routes for project tabs without a saved path', () => {
    expect(resolveTabRoutePath({ id: 'tab-project-42' })).toBe(
      `${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`
    )
  })

  it('does not restore the removed workspace system tab route', () => {
    expect(resolveTabRoutePath({ id: 'tab-workspace' })).toBe('')
  })

  it('persists the startup restore snapshot instead of the temporary home state', () => {
    const projectRoute = `${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`
    const state: LayoutState = {
      activeSidePanel: null,
      sidePanelWidth: 500,
      projectEntrySidePanelIntent: null,
      rightPanelVisible: false,
      bottomPanelVisible: false,
      bottomPanelActiveTab: 'terminal',
      bottomPanelMaximized: false,
      openTabs: [],
      activeTabId: 'tab-home',
      lastActiveProjectId: null,
      lastRoutePath: '/',
      startupRestorePending: true,
      startupRestoreSnapshot: {
        activeSidePanel: 'quickapp',
        sidePanelWidth: 500,
        rightPanelVisible: true,
        bottomPanelVisible: true,
        bottomPanelActiveTab: 'terminal',
        openTabs: [
          {
            id: 'tab-project-42',
            label: '42',
            routePath: projectRoute,
            closable: true
          }
        ],
        activeTabId: 'tab-project-42',
        lastActiveProjectId: 'tab-project-42',
        lastRoutePath: projectRoute
      }
    }

    localStorage.clear()
    saveState(state)

    const persisted = JSON.parse(localStorage.getItem('layout.state') ?? '{}')
    expect(persisted.activeTabId).toBe('tab-project-42')
    expect(persisted.lastRoutePath).toBe(projectRoute)
    expect(persisted.openTabs).toHaveLength(1)
    expect(persisted.startupRestorePending).toBeUndefined()
    expect(persisted.startupRestoreSnapshot).toBeUndefined()
  })
})
