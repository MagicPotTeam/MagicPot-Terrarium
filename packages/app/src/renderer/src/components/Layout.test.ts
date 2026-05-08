import { describe, expect, it } from 'vitest'
import {
  clampRightPanelWidth,
  clampSidePanelWidth,
  resolveTabIdForCurrentRoute,
  resolveStartupRouteTarget,
  resolveHashRoutePath,
  SIDE_PANEL_DEFAULT_WIDTH,
  shouldPersistCurrentRoute,
  shouldAutoCloseProjectSidePanel
} from './Layout'
import { resolveTabRoutePath } from '../store/slices/layoutSlice'
import {
  LEGACY_PROJECT_WEBGL_ROUTE_PATH,
  PROJECT_CANVAS_ROUTE_PATH
} from '../pages/ProjectCanvasPage/projectCanvasRouting'

describe('Layout resize clamps', () => {
  it('allows the quick app side panel to shrink lower and grow wider than before', () => {
    expect(clampSidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH, -120)).toBe(360)
    expect(clampSidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH, 260)).toBe(720)
    expect(clampSidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH, 600)).toBe(840)
  })

  it('allows the agent side panel to grow beyond the old cap while keeping a lower minimum', () => {
    expect(clampRightPanelWidth(420, -80)).toBe(360)
    expect(clampRightPanelWidth(420, 300)).toBe(720)
    expect(clampRightPanelWidth(420, 900)).toBe(1024)
  })
})

describe('Layout route sync helpers', () => {
  it('reconstructs a missing project tab route path from the tab id', () => {
    expect(resolveTabRoutePath({ id: 'tab-project-42' })).toBe(
      `${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`
    )
  })

  it('reuses the canonical route for known system tabs', () => {
    expect(resolveTabRoutePath({ id: 'tab-model' })).toBe('/model')
    expect(resolveTabRoutePath({ id: 'tab-settings' })).toBe('/settings')
  })

  it('maps the current route back to the matching project tab id', () => {
    expect(
      resolveTabIdForCurrentRoute(
        `${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`,
        PROJECT_CANVAS_ROUTE_PATH,
        '?id=tab-project-42',
        [
          {
            id: 'tab-project-42',
            label: '42',
            routePath: `${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`,
            closable: true
          }
        ]
      )
    ).toBe('tab-project-42')
  })

  it('accepts the legacy canvas path while resolving the active project tab', () => {
    expect(
      resolveTabIdForCurrentRoute(
        `${LEGACY_PROJECT_WEBGL_ROUTE_PATH}?id=tab-project-42`,
        LEGACY_PROJECT_WEBGL_ROUTE_PATH,
        '?id=tab-project-42',
        [
          {
            id: 'tab-project-42',
            label: '42',
            routePath: `${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`,
            closable: true
          }
        ]
      )
    ).toBe('tab-project-42')
  })

  it('maps a system route back to the matching system tab id', () => {
    expect(resolveTabIdForCurrentRoute('/', '/', '', [])).toBe('tab-home')
    expect(resolveTabIdForCurrentRoute('/model', '/model', '', [])).toBe('tab-model')
    expect(resolveTabIdForCurrentRoute('/qappdesign', '/qappdesign', '', [])).toBe('tab-design')
    expect(resolveTabIdForCurrentRoute('/workspace', '/workspace', '', [])).toBeNull()
  })

  it('restores the saved startup route only when it differs from the current route', () => {
    expect(resolveStartupRouteTarget('/canvas?id=tab-project-42', '/')).toBe(
      '/canvas?id=tab-project-42'
    )
    expect(
      resolveStartupRouteTarget('/canvas?id=tab-project-42', '/canvas?id=tab-project-42')
    ).toBe(null)
    expect(resolveStartupRouteTarget('/', '/')).toBeNull()
  })

  it('defers current route persistence until the startup restore navigation has landed', () => {
    expect(shouldPersistCurrentRoute('/canvas?id=tab-project-42', '/')).toBe(false)
    expect(
      shouldPersistCurrentRoute('/canvas?id=tab-project-42', '/canvas?id=tab-project-42')
    ).toBe(true)
    expect(shouldPersistCurrentRoute(null, '/settings')).toBe(true)
  })

  it('normalizes the browser hash route used to catch stale HashRouter locations', () => {
    expect(resolveHashRoutePath('')).toBe('/')
    expect(resolveHashRoutePath('#/settings')).toBe('/settings')
    expect(resolveHashRoutePath('#qappdesign')).toBe('/qappdesign')
    expect(resolveHashRoutePath('#/project-webgl?id=tab-project-42')).toBe(
      '/canvas?id=tab-project-42'
    )
  })

  it('auto-closes the quick app side panel only when first entering a project tab', () => {
    expect(shouldAutoCloseProjectSidePanel(false, true, 'quickapp')).toBe(true)
    expect(shouldAutoCloseProjectSidePanel(true, true, 'quickapp')).toBe(false)
    expect(shouldAutoCloseProjectSidePanel(false, true, null)).toBe(false)
    expect(shouldAutoCloseProjectSidePanel(false, false, 'quickapp')).toBe(false)
    expect(shouldAutoCloseProjectSidePanel(false, true, 'quickapp', true)).toBe(false)
  })
})
