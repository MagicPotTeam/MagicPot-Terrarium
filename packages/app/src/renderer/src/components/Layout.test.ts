import { describe, expect, it } from 'vitest'
import {
  clampRightPanelWidth,
  clampSidePanelWidth,
  resolveTabIdForCurrentRoute,
  resolveStartupFallbackRoutePath,
  resolveStartupRouteTarget,
  resolveHashRoutePath,
  resolveBottomPanelOverlayBounds,
  resolveMainAreaOverlayInsets,
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

describe('Layout overlay insets', () => {
  it('keeps the main canvas area out from under overlay side, right, and bottom panels', () => {
    expect(
      resolveMainAreaOverlayInsets({
        sidePanelVisible: true,
        sidePanelWidth: 460,
        rightPanelVisible: true,
        rightPanelWidth: 420,
        bottomPanelVisible: true,
        bottomPanelMaximized: false,
        bottomPanelHeight: 220
      })
    ).toEqual({ top: 0, left: 464, right: 420, bottom: 224 })
  })

  it('does not reserve bottom space while the bottom panel is maximized', () => {
    expect(
      resolveMainAreaOverlayInsets({
        sidePanelVisible: false,
        sidePanelWidth: 460,
        rightPanelVisible: false,
        rightPanelWidth: 420,
        bottomPanelVisible: true,
        bottomPanelMaximized: true,
        bottomPanelHeight: 220
      })
    ).toEqual({ top: 0, left: 0, right: 0, bottom: 0 })
  })

  it('keeps the bottom panel between the left quick-app panel and the right agent panel', () => {
    expect(
      resolveBottomPanelOverlayBounds({
        sidePanelVisible: true,
        sidePanelWidth: 460,
        rightPanelVisible: true,
        rightPanelWidth: 420,
        bottomPanelMaximized: false,
        bottomPanelHeight: 220
      })
    ).toEqual({ left: 464, right: 420, height: 224 })
  })

  it('lets the maximized bottom panel cover only the center workspace, not the side panels', () => {
    expect(
      resolveBottomPanelOverlayBounds({
        sidePanelVisible: true,
        sidePanelWidth: 460,
        rightPanelVisible: true,
        rightPanelWidth: 420,
        bottomPanelMaximized: true,
        bottomPanelHeight: 220
      })
    ).toEqual({ left: 464, right: 420, height: '100%' })
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

  it('maps the new management route and restores its own system tab without borrowing a project identity', () => {
    expect(resolveTabIdForCurrentRoute('/agent-management', '/agent-management', '', [])).toBe('tab-agent-management')
    expect(resolveTabRoutePath({ id: 'tab-agent-management' })).toBe('/agent-management')
    expect(resolveStartupFallbackRoutePath('tab-agent-management', [])).toBe('/agent-management')
    expect(resolveStartupRouteTarget('/', '/', '/agent-management')).toBe('/agent-management')
    expect(resolveTabIdForCurrentRoute('/agent-studio', '/agent-studio', '', [])).toBeNull()
  })
  it('does not restore a stale saved project over an explicit exact management route', () => {
    expect(resolveStartupRouteTarget('/canvas?id=tab-project-stale', '/agent-management')).toBeNull()
  })
  it.each(['/agent-management/', '/AGENT-MANAGEMENT', '/Agent-Management///', '/%61gent-management', '/agent%2Dmanagement///'])('recognizes router-equivalent management path %s and does not restore a stale project over an explicit management route', (pathname) => {
    expect(resolveTabIdForCurrentRoute(pathname, pathname, '', [])).toBe('tab-agent-management')
    expect(resolveStartupRouteTarget('/canvas?id=tab-project-stale', `${pathname}?view=local`)).toBeNull()
  })
  it('does not treat a nested unknown management path as the management route', () => {
    expect(resolveTabIdForCurrentRoute('/agent-management/unknown', '/agent-management/unknown', '', [])).toBeNull()
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

  it('falls back to the active tab route when the saved startup route is home', () => {
    expect(resolveStartupRouteTarget('/', '/', '/canvas?id=tab-project-42')).toBe(
      '/canvas?id=tab-project-42'
    )
    expect(resolveStartupRouteTarget('/', '/', '/settings')).toBe('/settings')
    expect(resolveStartupRouteTarget('/settings', '/', '/canvas?id=tab-project-42')).toBe(
      '/settings'
    )
  })

  it('derives a startup fallback route from the active tab', () => {
    expect(
      resolveStartupFallbackRoutePath('tab-project-42', [
        {
          id: 'tab-project-42',
          label: '42',
          routePath: `${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`,
          closable: true
        }
      ])
    ).toBe(`${PROJECT_CANVAS_ROUTE_PATH}?id=tab-project-42`)
    expect(resolveStartupFallbackRoutePath('tab-settings', [])).toBe('/settings')
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
