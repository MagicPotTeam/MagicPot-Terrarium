import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { readManagementPaneSnapshot } from '@renderer/pages/AgentManagementPage/managementPaneMetadata'
import { PROJECTS_STORAGE_KEY } from '@renderer/pages/MainPage/projectStore'
import type { ExistingConversationOpenInput } from '@renderer/pages/ChatPage/useExistingConversationOpen'
import type { ExistingConversationOpenCoordinator, ExistingConversationTarget, OpenRequestHandle, PresentationLease } from '@renderer/utils/existingConversationOpen'

export type ExistingConversationWorkspaceAdapter = Readonly<{
  coordinator: ExistingConversationOpenCoordinator
  request?: Readonly<{ handle: OpenRequestHandle; presentation: PresentationLease }>
}>
export type ExistingWorkspacePane = { id: string; enabled: boolean; [key: string]: unknown }
export type ExistingWorkspacePanes = { panes: ExistingWorkspacePane[]; raw: string }

/** Preserve the FULL validated raw array, including disabled records/unknown fields. Never repair. */
export function readExistingWorkspacePanes(projectId: string, target?: ExistingConversationTarget): ExistingWorkspacePanes | null {
  try {
    const metadata = readManagementPaneSnapshot()
    if (metadata.status !== 'ready') return null
    // Targetless retained visits must also belong to the canonical registry. The
    // enabled-owner projection omits valid projects whose panes are all disabled.
    const projectsRaw = localStorage.getItem(PROJECTS_STORAGE_KEY)
    if (projectsRaw === null || projectsRaw.length > 512 * 1024) return null
    const projects: unknown = JSON.parse(projectsRaw)
    if (!Array.isArray(projects) || projects.filter(project => project?.id === projectId).length !== 1) return null
    if (target && (target.projectId !== projectId || target.storageScope !== `${projectId}.${target.paneId}` ||
      metadata.owners.filter(owner => owner.projectId === projectId && owner.paneId === target.paneId && owner.storageScope === target.storageScope).length !== 1)) return null
    const raw = localStorage.getItem(`agent.workspace.${projectId}`)
    if (raw === null || raw.length > 64 * 1024) return null
    const panes: unknown = JSON.parse(raw)
    if (!Array.isArray(panes) || !metadata.isCurrent()) return null
    // Every record has already been validated by the canonical snapshot reader.
    return { raw, panes: panes as ExistingWorkspacePane[] }
  } catch { return null }
}

type ForeignVisit = { projectId: string; coordinator: ExistingConversationOpenCoordinator; foreignProjectId: string }

/** Retain every supplied live visit, not merely the most recently supplied coordinator. */
export function useExistingConversationWorkspaceProtection(projectId: string, adapter?: ExistingConversationWorkspaceAdapter) {
  const retained = useRef({ coordinators: new Set<ExistingConversationOpenCoordinator>(), foreign: [] as ForeignVisit[] })
  const coordinator = adapter?.coordinator
  const handle = adapter?.request?.handle
  const mismatch = !!handle && handle.target.projectId !== projectId
  const foreignProjectId = mismatch ? handle.target.projectId : undefined
  // start() supersedes visit tokens without departing the guarded project. Tokens
  // fence departure authority; protection follows the still-guarded project instead.
  const visitExists = (source: ForeignVisit) => source.coordinator.isGuarded(source.foreignProjectId)
  useLayoutEffect(() => {
    const sources = retained.current
    for (const source of sources.coordinators) if (!source.getSnapshot().visits.length) sources.coordinators.delete(source)
    sources.foreign = sources.foreign.filter(visitExists)
    if (coordinator?.isGuarded(projectId)) sources.coordinators.add(coordinator)
    if (coordinator && foreignProjectId && coordinator.isGuarded(foreignProjectId) && !sources.foreign.some(source => source.coordinator === coordinator && source.foreignProjectId === foreignProjectId && source.projectId === projectId)) {
      sources.foreign.push({ projectId, coordinator, foreignProjectId })
    }
  }, [coordinator, handle, projectId, foreignProjectId])
  const isBlocked = useCallback(() => mismatch ||
    retained.current.foreign.some(source => source.projectId === projectId && visitExists(source)),
  [mismatch, projectId])
  const isProtected = useCallback(() => isBlocked() || coordinator?.isGuarded(projectId) === true ||
    [...retained.current.coordinators].some(source => source.isGuarded(projectId)), [isBlocked, coordinator, projectId])
  return { isProtected, isBlocked, hasPolicy: !!adapter || retained.current.coordinators.size > 0 || retained.current.foreign.length > 0 }
}

type WorkspaceView = {
  adapter?: ExistingConversationWorkspaceAdapter
  projectId: string
  activePaneId: string | null
  panes: readonly { id: string; enabled: boolean }[]
  tracePanelOpen: boolean
}

/** Only committed exact-pane state may supply a lease; no creation/enablement/fallback here. */
export function useExistingConversationWorkspacePane(view: WorkspaceView): ExistingConversationOpenInput | undefined {
  const committed = useRef(view)
  const live = useRef(false)
  useLayoutEffect(() => { committed.current = view })
  useLayoutEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])
  const request = view.adapter?.request
  const coordinator = view.adapter?.coordinator
  const [bound, setBound] = useState<ExistingConversationOpenInput>()
  useEffect(() => {
    if (!coordinator || !request || !live.current) return
    const { handle, presentation } = request
    const target = handle.target
    const exact = () => {
      const current = committed.current
      return live.current && current.adapter?.coordinator === coordinator &&
        current.adapter.request?.handle === handle && current.adapter.request.presentation === presentation &&
        current.projectId === target.projectId && current.activePaneId === target.paneId && !current.tracePanelOpen &&
        current.panes.filter(pane => pane.id === target.paneId && pane.enabled).length === 1 &&
        readExistingWorkspacePanes(target.projectId, target) !== null
    }
    if (!exact()) return
    const pane = coordinator.attachPane(presentation, exact)
    if (!pane) return
    setBound(Object.freeze({ coordinator, handle, pane }))
    return () => { coordinator.detachPane(pane) }
  }, [coordinator, request?.handle, request?.presentation, view.projectId, view.activePaneId, view.panes, view.tracePanelOpen])
  return useMemo(() => bound && request?.handle === bound.handle && coordinator === bound.coordinator &&
    view.projectId === bound.handle.target.projectId && view.activePaneId === bound.handle.target.paneId && !view.tracePanelOpen
    ? bound : undefined, [bound, coordinator, request?.handle, view.projectId, view.activePaneId, view.tracePanelOpen])
}
