export const WORKSHOP_MODELS_ROUTE_PATH = '/workshop/models'
export const WORKSHOP_PLUGINS_ROUTE_PATH = '/workshop/plugins'
export const LEGACY_MODEL_ROUTE_PATH = '/model'

export type WorkshopRoutePath =
  typeof WORKSHOP_MODELS_ROUTE_PATH | typeof WORKSHOP_PLUGINS_ROUTE_PATH

/**
 * Resolve only the bounded Workshop routes owned by this surface.
 * The legacy model URL remains readable, but all callers receive the canonical path.
 */
export const resolveWorkshopRoutePath = (pathname: string): WorkshopRoutePath | null => {
  if (pathname === WORKSHOP_MODELS_ROUTE_PATH || pathname === LEGACY_MODEL_ROUTE_PATH) {
    return WORKSHOP_MODELS_ROUTE_PATH
  }
  if (pathname === WORKSHOP_PLUGINS_ROUTE_PATH) return WORKSHOP_PLUGINS_ROUTE_PATH
  return null
}

export const isWorkshopModelsRoutePath = (pathname: string): boolean =>
  resolveWorkshopRoutePath(pathname) === WORKSHOP_MODELS_ROUTE_PATH
