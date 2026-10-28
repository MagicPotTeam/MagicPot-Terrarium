import { describe, expect, it } from 'vitest'
import {
  LEGACY_MODEL_ROUTE_PATH,
  WORKSHOP_MODELS_ROUTE_PATH,
  WORKSHOP_PLUGINS_ROUTE_PATH,
  isWorkshopModelsRoutePath,
  resolveWorkshopRoutePath
} from './workshopRouting'

describe('workshopRouting', () => {
  it.each([
    [WORKSHOP_MODELS_ROUTE_PATH, WORKSHOP_MODELS_ROUTE_PATH],
    [LEGACY_MODEL_ROUTE_PATH, WORKSHOP_MODELS_ROUTE_PATH],
    [WORKSHOP_PLUGINS_ROUTE_PATH, WORKSHOP_PLUGINS_ROUTE_PATH]
  ])('resolves %s to %s', (pathname, expected) => {
    expect(resolveWorkshopRoutePath(pathname)).toBe(expected)
  })

  it.each(['/workshop', '/workshop/models/child', '/model?tab=vae', ''])(
    'does not broaden the route matcher for %s',
    (pathname) => {
      expect(resolveWorkshopRoutePath(pathname)).toBeNull()
    }
  )

  it('identifies canonical and legacy model paths without treating plugins as models', () => {
    expect(isWorkshopModelsRoutePath(WORKSHOP_MODELS_ROUTE_PATH)).toBe(true)
    expect(isWorkshopModelsRoutePath(LEGACY_MODEL_ROUTE_PATH)).toBe(true)
    expect(isWorkshopModelsRoutePath(WORKSHOP_PLUGINS_ROUTE_PATH)).toBe(false)
  })
})
