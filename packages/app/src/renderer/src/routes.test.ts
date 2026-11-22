import { describe, expect, it } from 'vitest'
import { getPathById, getRouteById, getRouteByPath, getSidebarRoutes } from './routes'
import {
  LEGACY_PROJECT_WEBGL_ROUTE_PATH,
  PROJECT_CANVAS_ROUTE_PATH
} from './pages/ProjectCanvasPage/projectCanvasRouting'

describe('routes', () => {
  it('registers a distinct lazy management route hidden from the sidebar without reviving removed Studio', () => {
    const management = getRouteByPath('/agent-management')
    expect(management).toMatchObject({ id: 'agent_management', path: '/agent-management', showInSidebar: false })
    expect((management?.Page as unknown as { $$typeof?: symbol })?.$$typeof).toBe(Symbol.for('react.lazy'))
    expect(getSidebarRoutes().some(route => route.path === '/agent-management')).toBe(false)
    expect(getRouteByPath('/agent-studio')).toBeUndefined()
  })
  it('registers the custom skill manager as a hidden peer route', () => {
    const route = getRouteByPath('/custom-skill-manager')

    expect(route?.id).toBe('custom_skill_manager')
    expect(route?.showInSidebar).toBe(false)
    expect(getRouteById('custom_skill_manager')?.path).toBe('/custom-skill-manager')
    expect(getPathById('custom_skill_manager')).toBe('/custom-skill-manager')
  })

  it('does not expose the removed workspace route anymore', () => {
    expect(getRouteByPath('/workspace')).toBeUndefined()
  })

  it('does not expose the removed browser route anymore', () => {
    expect(getRouteByPath('/browser')).toBeUndefined()
  })

  it('does not expose the removed Agent Studio route anymore', () => {
    expect(getRouteByPath('/agent-studio')).toBeUndefined()
  })

  it('registers ProjectCanvas as the canonical project surface and preserves a legacy WebGL alias', () => {
    expect(getRouteByPath(PROJECT_CANVAS_ROUTE_PATH)?.id).toBe('project_canvas')
    expect(getRouteById('project_canvas')?.path).toBe(PROJECT_CANVAS_ROUTE_PATH)
    expect(getPathById('project_canvas')).toBe(PROJECT_CANVAS_ROUTE_PATH)
    expect(getRouteByPath(LEGACY_PROJECT_WEBGL_ROUTE_PATH)?.id).toBe('project_webgl_legacy')
  })
})

it('registers the FIGPLUGIN management route as an actual workshop peer', () => {
  const route = getRouteByPath('/workshop/plugins')
  expect(route?.id).toBe('workshop_plugins')
  expect(route?.showInSidebar).toBe(false)
  expect(route?.Page).toBeDefined()
  expect(getRouteById('workshop_plugins')?.path).toBe('/workshop/plugins')
  expect(getPathById('workshop_plugins')).toBe('/workshop/plugins')
})
