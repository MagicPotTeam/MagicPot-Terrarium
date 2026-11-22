import { PROJECTS_STORAGE_KEY } from '../MainPage/projectStore'
import { buildAgentPaneScope } from '../ProjectCanvasPage/canvasPageLocalStateUtils'

export type ManagementPaneOwner = {
  projectId: string
  projectName: string
  paneId: string
  storageScope: string
}
export type ManagementPaneSnapshot =
  | { status: 'unavailable'; reason: 'metadata-unavailable' | 'invalid-metadata' | 'limit-exceeded' }
  | { status: 'ready'; owners: ManagementPaneOwner[]; isCurrent: () => boolean }

const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value &&
  value.length <= 512 &&
  value.trim() === value &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Read only canonical existing associations; never invoke the workspace's repair/default path. */
export function readManagementPaneSnapshot(storage?: Pick<Storage, 'getItem'>): ManagementPaneSnapshot {
  try {
    const source = storage ?? localStorage
    const captured = new Map<string, string>()
    let inputSize = 0
    const read = (key: string, cap: number): string | null => {
      const raw = source.getItem(key)
      if (raw === null) return null
      if (raw.length > cap || (inputSize += raw.length) > 1024 * 1024) {
        throw new RangeError('Metadata limit')
      }
      captured.set(key, raw)
      return raw
    }
    const invalid = (): ManagementPaneSnapshot => ({
      status: 'unavailable',
      reason: 'invalid-metadata'
    })
    const raw = read(PROJECTS_STORAGE_KEY, 512 * 1024)
    if (raw === null) return { status: 'unavailable', reason: 'metadata-unavailable' }
    const projects: unknown = JSON.parse(raw)
    if (!Array.isArray(projects)) return invalid()
    if (projects.length > 256) throw new RangeError('Project limit')
    const projectIds = new Set<string>()
    const scopes = new Set<string>()
    const owners: ManagementPaneOwner[] = []
    for (const project of projects) {
      if (
        !record(project) ||
        !validId(project.id) ||
        typeof project.name !== 'string' ||
        !project.name.trim() ||
        project.name.length > 120 ||
        project.chatStorageScopePrefix !== project.id ||
        projectIds.has(project.id)
      ) {
        return invalid()
      }
      projectIds.add(project.id)
      // AgentWorkspace persists its array at this exact key, not a '.panes.' key.
      const paneRaw = read(`agent.workspace.${project.id}`, 64 * 1024)
      if (paneRaw === null) return { status: 'unavailable', reason: 'metadata-unavailable' }
      const panes: unknown = JSON.parse(paneRaw)
      if (!Array.isArray(panes)) return invalid()
      if (panes.length > 256) throw new RangeError('Pane limit')
      const paneIds = new Set<string>()
      for (const pane of panes) {
        if (
          !record(pane) ||
          !validId(pane.id) ||
          typeof pane.enabled !== 'boolean' ||
          paneIds.has(pane.id)
        ) {
          return invalid()
        }
        paneIds.add(pane.id)
        const storageScope = buildAgentPaneScope(project.id, pane.id)
        if (scopes.has(storageScope)) return invalid()
        scopes.add(storageScope)
        if (scopes.size > 256) throw new RangeError('Scope limit')
        if (pane.enabled) {
          owners.push({
            projectId: project.id,
            projectName: project.name,
            paneId: pane.id,
            storageScope
          })
        }
      }
    }
    return {
      status: 'ready',
      owners,
      // Display snapshot only: equality cannot detect ABA or authorize a later Open.
      isCurrent: () => {
        try {
          return [...captured].every(([key, value]) => source.getItem(key) === value)
        } catch {
          return false
        }
      }
    }
  } catch (error) {
    return {
      status: 'unavailable',
      reason:
        error instanceof RangeError
          ? 'limit-exceeded'
          : error instanceof SyntaxError
            ? 'invalid-metadata'
            : 'metadata-unavailable'
    }
  }
}
