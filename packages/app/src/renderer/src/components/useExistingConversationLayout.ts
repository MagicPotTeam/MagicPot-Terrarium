import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, UnknownAction } from '@reduxjs/toolkit'
import type { NavigateFunction } from 'react-router-dom'
import { useStore } from 'react-redux'
import { openRightPanel, resolveTabRoutePath, setActiveTab, toggleBottomPanelMaximized, type LayoutState } from '../store/slices/layoutSlice'
import { normalizeProjectCanvasRoutePath, toProjectCanvasRoutePath } from '../pages/ProjectCanvasPage/projectCanvasRouting'
import { existingConversationOpenStore as coordinator, useExistingConversationOpenSnapshot } from '../utils/existingConversationOpenStore'
import type { OpenRequestHandle, OpenVisit, PresentationLease } from '../utils/existingConversationOpen'
import type { ExistingConversationWorkspaceAdapter } from './existingConversationWorkspace'

export type ExistingConversationLayoutView = Pick<LayoutState, 'activeTabId' | 'openTabs' | 'rightPanelVisible' | 'bottomPanelVisible' | 'bottomPanelMaximized' | 'startupRestorePending'> & {
  route: string
  dispatch: Dispatch<UnknownAction>
  navigate: NavigateFunction
}

/** First slice accepts the existing canonical project route only, never an inferred/new tab. */
function projectRoute(route: string): string | null {
  try {
    const value = new URL(normalizeProjectCanvasRoutePath(route), 'https://existing.invalid')
    if (value.origin !== 'https://existing.invalid' || value.pathname !== '/canvas' || value.hash ||
      [...value.searchParams.keys()].length !== 1 || value.searchParams.getAll('id').length !== 1) return null
    const id = value.searchParams.get('id')
    return id?.startsWith('tab-project-') ? id : null
  } catch { return null }
}
function existingTab(view: ExistingConversationLayoutView, projectId: string): boolean {
  const tabs = view.openTabs.filter(tab => tab.id === projectId)
  return tabs.length === 1 && projectRoute(resolveTabRoutePath(tabs[0])) === projectId
}
const exactProject = (view: ExistingConversationLayoutView, projectId: string) =>
  view.activeTabId === projectId && projectRoute(view.route) === projectId && existingTab(view, projectId)

type Navigation = { handle: OpenRequestHandle; sourceRoute: string; sourceTab: string; issued: boolean; reached: boolean }
type VisitObservation = { visit: OpenVisit; sourceRoute: string; sourceTab: string; reached: boolean }

/** Renderer-only handoff. Only layout-committed parents can grant current presentation authority. */
export function useExistingConversationLayout(view: ExistingConversationLayoutView): {
  allowWorkspace: boolean
  workspaceAdapter: ExistingConversationWorkspaceAdapter
  /** Only Layout's own route/tab reconciliation, never a user tab action. */
  reconcileRouteTab: (route: string, tabId: string, dispatchReconciliation: () => void) => void
} {
  const snapshot = useExistingConversationOpenSnapshot()
  // Navigation may reenter synchronously from Redux subscribers, before React
  // commits. This provider state is never presentation/selection authority.
  const store = useStore<{ layout: LayoutState }>()
  const committed = useRef(view)
  const live = useRef(false)
  const navigation = useRef<Navigation | undefined>(undefined)
  const visits = useRef(new Map<string, VisitObservation>())
  const [, issuedVersion] = useState(0)
  const [visibility, setVisibility] = useState(() => document.visibilityState)
  const [presentation, setPresentation] = useState<{ handle: OpenRequestHandle; lease: PresentationLease }>()
  const capture = () => {
    const request = coordinator.getSnapshot().request
    if (!live.current || !request || navigation.current?.handle === request.handle) return
    const current = committed.current
    navigation.current = { handle: request.handle, sourceRoute: current.route, sourceTab: store.getState().layout.activeTabId, issued: false, reached: false }
  }
  useLayoutEffect(() => { committed.current = view; capture() })
  useLayoutEffect(() => {
    live.current = true
    capture()
    // Capture the source synchronously on accepted start, not after a later navigation render.
    const unsubscribe = coordinator.subscribe(capture)
    return () => { live.current = false; unsubscribe() }
  }, [store])
  useEffect(() => {
    const changed = () => setVisibility(document.visibilityState)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])

  const reconcileRouteTab = useCallback((route: string, tabId: string, dispatchReconciliation: () => void) => {
    const progress = navigation.current
    const request = coordinator.getSnapshot().request
    const current = committed.current
    // A synchronous supersession can inherit the old navigation's intermediate
    // active tab while still on the same source route. Rebase only around this
    // exact internal reconciliation, never by accepting an arbitrary tab change.
    const followsSource = live.current && progress && request?.handle === progress.handle &&
      request.phase === 'preflight' && !progress.issued && current.route === route &&
      progress.sourceRoute === route && window.location.hash.slice(1) === route &&
      store.getState().layout.activeTabId === progress.sourceTab
    if (followsSource) progress.sourceTab = tabId
    try {
      dispatchReconciliation()
    } finally {
      // Do not overwrite/cancel requests installed by reconciliation callbacks.
      if (followsSource && navigation.current === progress && coordinator.getSnapshot().request?.handle === request.handle &&
        (!live.current || committed.current.route !== route || window.location.hash.slice(1) !== route || store.getState().layout.activeTabId !== tabId)) {
        coordinator.cancel(request.handle, 'destination-lost')
      }
    }
  }, [store])

  const request = snapshot.request
  const handle = request?.handle
  useEffect(() => {
    if (!request || !live.current || coordinator.getSnapshot().request?.handle !== request.handle) return
    const current = committed.current
    const actual = store.getState().layout
    const progress = navigation.current
    if (!progress || progress.handle !== request.handle) return
    const projectId = request.handle.target.projectId
    if (!existingTab({ ...current, ...actual }, projectId) || actual.startupRestorePending) {
      coordinator.cancel(request.handle, 'destination-lost')
      return
    }
    const atDestination = exactProject(current, projectId)
    if (!progress.issued) {
      if (current.route !== progress.sourceRoute || actual.activeTabId !== progress.sourceTab ||
        window.location.hash.slice(1) !== current.route) {
        coordinator.cancel(request.handle, 'destination-lost')
        return
      }
      if (request.phase === 'preflight') return
      progress.issued = true
      // Set before dispatch/navigation callbacks. Replays/phase updates cannot retry navigation.
      issuedVersion(version => version + 1)
      // Each dispatch may synchronously replace the request, close its tab, or
      // leave its source. An old operation must not perform even the next panel
      // mutation, and must not cancel a replacement after returning from callbacks.
      const afterDispatch = () => {
        if (!live.current || coordinator.getSnapshot().request?.handle !== request.handle || navigation.current !== progress) return null
        const next = store.getState().layout
        if (committed.current.route !== current.route || window.location.hash.slice(1) !== current.route ||
          next.activeTabId !== projectId || next.startupRestorePending || !existingTab({ ...current, ...next }, projectId)) {
          coordinator.cancel(request.handle, 'destination-lost')
          return null
        }
        return next
      }
      let next = actual
      if (next.activeTabId !== projectId) {
        current.dispatch(setActiveTab(projectId))
        const checked = afterDispatch()
        if (!checked) return
        next = checked
      }
      if (!next.rightPanelVisible) {
        current.dispatch(openRightPanel())
        const checked = afterDispatch()
        if (!checked) return
        next = checked
      }
      if (next.bottomPanelMaximized) {
        current.dispatch(toggleBottomPanelMaximized())
        const checked = afterDispatch()
        if (!checked) return
        next = checked
      }
      // Also fence the no-dispatch path and explicit panel changes from callbacks.
      if (!afterDispatch()) return
      if (!next.rightPanelVisible || (next.bottomPanelVisible && next.bottomPanelMaximized)) {
        coordinator.cancel(request.handle, 'destination-lost')
        return
      }
      if (projectRoute(current.route) !== projectId) current.navigate(toProjectCanvasRoutePath(projectId))
      return
    }
    if (atDestination) progress.reached = true
    const routeConverging = current.route === progress.sourceRoute || projectRoute(current.route) === projectId
    const tabConverging = current.activeTabId === progress.sourceTab || current.activeTabId === projectId
    if (!routeConverging || !tabConverging || (progress.reached && !atDestination) ||
      (progress.reached && (!current.rightPanelVisible || (current.bottomPanelVisible && current.bottomPanelMaximized)))) {
      coordinator.cancel(request.handle, 'destination-lost')
    }
  }, [handle, request?.phase, store, view.activeTabId, view.route, view.openTabs, view.startupRestorePending, view.rightPanelVisible, view.bottomPanelVisible, view.bottomPanelMaximized])

  useEffect(() => {
    // Terminal settlement and effect cleanup are not departure. Observe committed navigation instead.
    for (const visit of snapshot.visits) {
      const current = committed.current
      let observed = visits.current.get(visit.projectId)
      if (!observed) {
        const progress = navigation.current?.handle.target.projectId === visit.projectId ? navigation.current : undefined
        observed = { visit, sourceRoute: progress?.sourceRoute ?? current.route, sourceTab: progress?.sourceTab ?? current.activeTabId, reached: false }
        visits.current.set(visit.projectId, observed)
      }
      observed.visit = visit // Supersession is not departure from this project.
      if (exactProject(current, visit.projectId)) observed.reached = true
      const pending = coordinator.getSnapshot().request
      const progress = navigation.current
      if (pending?.visit === visit && progress?.handle === pending.handle && !progress.reached) continue
      const removed = !existingTab(current, visit.projectId)
      const leftProject = projectRoute(current.route) !== visit.projectId && current.activeTabId !== visit.projectId
      const leftSource = current.route !== observed.sourceRoute && current.activeTabId !== observed.sourceTab
      if (removed || (leftProject && (observed.reached || leftSource))) {
        // Delete local old state before external callbacks can synchronously start a replacement.
        visits.current.delete(visit.projectId)
        coordinator.depart(visit)
      }
    }
  }, [snapshot.visits, view.route, view.activeTabId, view.openTabs])

  const progress = navigation.current
  const ready = !!request && request.phase !== 'preflight' && progress?.handle === request.handle && progress.issued &&
    exactProject(view, request.handle.target.projectId) && view.rightPanelVisible && !view.startupRestorePending &&
    !(view.bottomPanelVisible && view.bottomPanelMaximized) && visibility === 'visible'
  useEffect(() => {
    if (!handle || !ready || !live.current) return
    const check = () => {
      const current = committed.current
      return live.current && coordinator.getSnapshot().request?.handle === handle &&
        exactProject(current, handle.target.projectId) && current.rightPanelVisible && !current.startupRestorePending &&
        !(current.bottomPanelVisible && current.bottomPanelMaximized) && document.visibilityState === 'visible' &&
        window.location.hash.slice(1) === current.route
    }
    const lease = coordinator.attachPresentation(handle, check)
    if (!lease) return
    setPresentation({ handle, lease })
    return () => coordinator.detachPresentation(lease)
  }, [handle, ready])

  const workspaceAdapter = useMemo<ExistingConversationWorkspaceAdapter>(() => Object.freeze({ coordinator,
    ...(ready && presentation && presentation.handle === handle && handle ? { request: Object.freeze({ handle, presentation: presentation.lease }) } : {})
  }), [handle, presentation, ready])
  // No wrong-project transitional mount may precede policy installation or exact route/tab convergence.
  // Keep the fence after the last visit departs too: route/tab updates may still
  // be converging. A terminal result or captured handoff never authorizes fallback mounts.
  const allowWorkspace = request ? request.phase !== 'preflight' && exactProject(view, request.handle.target.projectId) :
    snapshot.visits.length || snapshot.result || progress ? exactProject(view, view.activeTabId) : true
  return { allowWorkspace, workspaceAdapter, reconcileRouteTab }
}
