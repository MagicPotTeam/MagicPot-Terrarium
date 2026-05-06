export const PROJECT_CANVAS_ROUTE_PATH = '/canvas'
export const LEGACY_PROJECT_WEBGL_ROUTE_PATH = '/project-webgl'

const LEGACY_PROJECT_WEBGL_ROUTE_PATTERN = /^\/project-webgl(?=[?#]|$)/

export const normalizeProjectCanvasRoutePath = (routePath: string): string => {
  const normalized = routePath.trim()
  if (!normalized) {
    return normalized
  }

  return normalized.replace(LEGACY_PROJECT_WEBGL_ROUTE_PATTERN, PROJECT_CANVAS_ROUTE_PATH)
}

export const toProjectCanvasRoutePath = (projectTabId: string): string =>
  `${PROJECT_CANVAS_ROUTE_PATH}?id=${encodeURIComponent(projectTabId)}`

export const isProjectCanvasRoutePath = (pathname: string): boolean =>
  pathname === PROJECT_CANVAS_ROUTE_PATH || pathname === LEGACY_PROJECT_WEBGL_ROUTE_PATH

export const PROJECT_WEBGL_ROUTE_PATH = LEGACY_PROJECT_WEBGL_ROUTE_PATH
export const LEGACY_PROJECT_CANVAS_ROUTE_PATH = PROJECT_CANVAS_ROUTE_PATH
export const normalizeProjectRoutePath = normalizeProjectCanvasRoutePath
export const toProjectWebglRoutePath = toProjectCanvasRoutePath
export const isProjectWebglRoutePath = isProjectCanvasRoutePath
