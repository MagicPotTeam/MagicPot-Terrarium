import { describe, expect, it } from 'vitest'
import { shouldForceStartupHomeRoute } from './agentManagementRouting'

describe('management deep-link startup boundary', () => {
  it.each([
    '#/agent-management',
    '#/agent-management/?view=local',
    '#/AGENT-MANAGEMENT',
    ' #/Agent-Management/// ',
    '#/%61gent-management',
    '#/agent%2Dmanagement///'
  ])('does not erase explicit management hash %s before the router mounts', (hash) => {
    expect(shouldForceStartupHomeRoute(true, hash)).toBe(false)
  })
  it.each([
    '#/canvas?id=tab-project-existing',
    '#/settings',
    '#/agent-management/unknown'
  ])('retains previous startup-home behavior for other routes %s', (hash) => {
    expect(shouldForceStartupHomeRoute(true, hash)).toBe(true)
  })
  it.each(['', '#', '#/'])('does not rewrite an already home hash %s', (hash) => {
    expect(shouldForceStartupHomeRoute(true, hash)).toBe(false)
  })
  it('does not rewrite any hash without a pending startup snapshot', () => {
    expect(shouldForceStartupHomeRoute(false, '#/canvas?id=tab-project-existing')).toBe(false)
  })
})
