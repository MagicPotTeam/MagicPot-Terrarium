import { describe, expect, it } from 'vitest'
import layoutSlice, { closeTab, completeStartupRestore, openTab, resolveTabRoutePath, saveState, type LayoutState } from './layoutSlice'
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

  it('does not restore the removed Agent Studio system tab', () => {
    expect(resolveTabRoutePath({ id: 'tab-agent-studio' })).toBe('')
  })

  it('reconstructs the management route, deduplicates repeated opens and returns to Settings on close', () => {
    expect(resolveTabRoutePath({ id: 'tab-agent-management' })).toBe('/agent-management')
    const management = { id: 'tab-agent-management', label: 'Agent management', routePath: '/agent-management', closable: true }
    let state: LayoutState = { ...layoutSlice.getInitialState(), openTabs: [{ id: 'tab-settings', label: 'Settings', routePath: '/settings', closable: true }], activeTabId: 'tab-settings', startupRestorePending: false, startupRestoreSnapshot: null }
    state = layoutSlice.reducer(state, openTab(management)); state = layoutSlice.reducer(state, openTab(management))
    expect(state.openTabs.filter(tab => tab.id === management.id)).toHaveLength(1); expect(state.activeTabId).toBe(management.id)
    state = layoutSlice.reducer(state, closeTab(management.id))
    expect(state.activeTabId).toBe('tab-settings'); expect(resolveTabRoutePath(state.openTabs[0])).toBe('/settings')
  })
  it('retains the management tab in a saved startup snapshot without creating a new conversation', () => {
    const prior = layoutSlice.getInitialState(), tab = { id: 'tab-agent-management', label: 'Agent management', routePath: '/agent-management', closable: true }
    const snapshot = { activeSidePanel: null, sidePanelWidth: 460, rightPanelVisible: true, bottomPanelVisible: false, bottomPanelActiveTab: 'terminal' as const, openTabs: [tab], activeTabId: tab.id, lastActiveProjectId: 'tab-project-prior', lastRoutePath: tab.routePath }
    const state = layoutSlice.reducer({ ...prior, startupRestorePending: true, startupRestoreSnapshot: snapshot }, completeStartupRestore())
    expect(state.openTabs).toEqual([tab]); expect(state.activeTabId).toBe(tab.id); expect(state.lastRoutePath).toBe(tab.routePath); expect(state.lastActiveProjectId).toBe('tab-project-prior')
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
