import { describe, expect, it } from 'vitest'
import { getPathById, getRouteById, getRouteByPath } from './routes'
import {
  LEGACY_PROJECT_WEBGL_ROUTE_PATH,
  PROJECT_CANVAS_ROUTE_PATH
} from './pages/ProjectCanvasPage/projectCanvasRouting'

describe('routes', () => {
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

  it('registers ProjectCanvas as the canonical project surface and preserves a legacy WebGL alias', () => {
    expect(getRouteByPath(PROJECT_CANVAS_ROUTE_PATH)?.id).toBe('project_canvas')
    expect(getRouteById('project_canvas')?.path).toBe(PROJECT_CANVAS_ROUTE_PATH)
    expect(getPathById('project_canvas')).toBe(PROJECT_CANVAS_ROUTE_PATH)
    expect(getRouteByPath(LEGACY_PROJECT_WEBGL_ROUTE_PATH)?.id).toBe('project_webgl_legacy')
  })
})
