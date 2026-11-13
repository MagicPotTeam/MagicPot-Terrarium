import { matchRoutes } from 'react-router-dom'

export const AGENT_MANAGEMENT_ROUTE_PATH = '/agent-management'

/** Match the same case, trailing slash and segment decoding rules as MainArea's router. */
export function isAgentManagementRoute(routePath: string): boolean {
  return (
    routePath.startsWith('/') && matchRoutes([{ path: AGENT_MANAGEMENT_ROUTE_PATH }], routePath) !== null
  )
}

/** Preserve only this explicitly requested local view; other startup-home behavior is unchanged. */
export function shouldForceStartupHomeRoute(startupRestorePending: boolean, hash: string): boolean {
  const route = hash.trim()
  return (
    startupRestorePending &&
    !!route &&
    route !== '#/' &&
    route !== '#' &&
    !isAgentManagementRoute(route.replace(/^#/, ''))
  )
}
