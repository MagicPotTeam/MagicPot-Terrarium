import { describe, expect, it } from 'vitest'
import { resolveTabRoutePath } from './layoutSlice'
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
})
