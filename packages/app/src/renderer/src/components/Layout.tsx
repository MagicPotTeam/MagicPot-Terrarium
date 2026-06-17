/* eslint-disable react-refresh/only-export-components */
// packages/app/src/renderer/src/components/Layout.tsx
import React, { Suspense, useState, useCallback, useRef, useEffect } from 'react'
import { Box } from '@mui/material'
import TitleBar from './TitleBar'
import ActivityBar from './ActivityBar'
import MainArea from './MainArea'
import { MAX_SIZE_LAYOUT_REMEASURE_EVENT } from './MaxSizeLayout'
import { lazyWithRetry } from '../utils/lazyWithRetry'
import { useAppDispatch, useAppSelector } from '../store'
import {
  toggleRightPanel,
  setLastRoutePath,
  closeTab,
  closeSidePanel,
  clearProjectEntrySidePanelIntent,
  setActiveTab,
  completeStartupRestore,
  resolveTabRoutePath,
  type TabItem
} from '../store/slices/layoutSlice'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  isProjectCanvasRoutePath,
  normalizeProjectCanvasRoutePath
} from '../pages/ProjectCanvasPage/projectCanvasRouting'

const SidePanel = lazyWithRetry(() => import('./SidePanel'))
const BottomPanel = lazyWithRetry(() => import('./BottomPanel'))
const AgentWorkspace = lazyWithRetry(() => import('./AgentWorkspace'))
const prefetchPrimaryWorkspaceModules = () => Promise.allSettled([import('./SidePanel')])

const RIGHT_PANEL_DEFAULT_WIDTH = 420
export const SIDE_PANEL_DEFAULT_WIDTH = 460
const SIDE_PANEL_MIN_WIDTH = 360
const SIDE_PANEL_MAX_WIDTH = 840
const RIGHT_PANEL_MIN_WIDTH = 360
const RIGHT_PANEL_MAX_WIDTH = 1024
const BOTTOM_PANEL_DEFAULT_HEIGHT = 220
const LAYOUT_RESIZE_HANDLE_SIZE = 4
const ROUTE_TAB_SYNC_DELAY_MS = 50
const LAYOUT_RESIZE_REMEASURE_SETTLE_DELAY_MS = 120
export const STARTUP_HOME_PAINT_DELAY_MS = 160

export const clampSidePanelWidth = (currentWidth: number, delta: number): number =>
  Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(SIDE_PANEL_MAX_WIDTH, currentWidth + delta))

export const clampRightPanelWidth = (currentWidth: number, delta: number): number =>
  Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, currentWidth + delta))

export const clampBottomPanelHeight = (
  currentHeight: number,
  delta: number,
  windowHeight: number
): number =>
  Math.max(BOTTOM_PANEL_DEFAULT_HEIGHT, Math.min(windowHeight - 34, currentHeight + delta))

export function dispatchMaxSizeLayoutRemeasure() {
  window.dispatchEvent(new Event(MAX_SIZE_LAYOUT_REMEASURE_EVENT))
}

const SYSTEM_ROUTE_TAB_IDS: Record<string, string> = {
  '/': 'tab-home',
  '/settings': 'tab-settings',
  '/qappdesign': 'tab-design',
  '/target-manager': 'tab-design',
  '/custom-skill-manager': 'tab-design',
  '/model': 'tab-model'
}

export const resolveTabIdForCurrentRoute = (
  currentRoute: string,
  pathname: string,
  search: string,
  openTabs: TabItem[]
): string | null => {
  const canonicalRoute = normalizeProjectCanvasRoutePath(currentRoute)
  const matchedTab = openTabs.find((tab) => resolveTabRoutePath(tab) === canonicalRoute)
  if (matchedTab) {
    return matchedTab.id
  }

  if (isProjectCanvasRoutePath(pathname)) {
    return new URLSearchParams(search).get('id')
  }

  return SYSTEM_ROUTE_TAB_IDS[pathname] ?? null
}

export const shouldAutoCloseProjectSidePanel = (
  hasEnteredProjectTab: boolean,
  isProjectTab: boolean,
  activeSidePanel: string | null,
  hasProjectEntrySidePanelIntent = false
): boolean =>
  isProjectTab &&
  !hasEnteredProjectTab &&
  activeSidePanel !== null &&
  !hasProjectEntrySidePanelIntent

export const resolveStartupRouteTarget = (
  lastRoutePath: string,
  currentRoute: string,
  fallbackRoutePath = ''
): string | null => {
  const normalizedSavedRoute = normalizeProjectCanvasRoutePath(lastRoutePath)
  const normalizedCurrentRoute = normalizeProjectCanvasRoutePath(currentRoute)
  const normalizedFallbackRoute = normalizeProjectCanvasRoutePath(fallbackRoutePath)
  const restoreRoute =
    normalizedSavedRoute && normalizedSavedRoute !== '/'
      ? normalizedSavedRoute
      : normalizedFallbackRoute

  if (!restoreRoute || restoreRoute === '/' || restoreRoute === normalizedCurrentRoute) {
    return null
  }

  return restoreRoute
}

export const resolveStartupFallbackRoutePath = (
  activeTabId: string,
  openTabs: TabItem[]
): string => {
  const activeTab = openTabs.find((tab) => tab.id === activeTabId)
  return resolveTabRoutePath(activeTab ?? { id: activeTabId })
}

export const shouldPersistCurrentRoute = (
  pendingStartupRoutePath: string | null,
  currentRoute: string
): boolean => {
  if (!pendingStartupRoutePath) {
    return true
  }

  return normalizeProjectCanvasRoutePath(currentRoute) === pendingStartupRoutePath
}

export const resolveHashRoutePath = (hash: string): string => {
  const routePath = hash.replace(/^#/, '').trim()
  if (!routePath) {
    return '/'
  }

  return normalizeProjectCanvasRoutePath(routePath.startsWith('/') ? routePath : `/${routePath}`)
}

export const scheduleStartupRestoreAfterHomePaint = (callback: () => void): (() => void) => {
  let cancelled = false
  let firstFrameId = 0
  let secondFrameId = 0
  let timerId = 0

  firstFrameId = window.requestAnimationFrame(() => {
    secondFrameId = window.requestAnimationFrame(() => {
      timerId = window.setTimeout(() => {
        if (!cancelled) {
          callback()
        }
      }, STARTUP_HOME_PAINT_DELAY_MS)
    })
  })

  return () => {
    cancelled = true
    window.cancelAnimationFrame(firstFrameId)
    window.cancelAnimationFrame(secondFrameId)
    window.clearTimeout(timerId)
  }
}

type ResizeDirection = 'side' | 'right' | 'bottom' | null

type MainAreaOverlayInsetsOptions = {
  sidePanelVisible: boolean
  sidePanelWidth: number
  rightPanelVisible: boolean
  rightPanelWidth: number
  bottomPanelVisible: boolean
  bottomPanelMaximized: boolean
  bottomPanelHeight: number
}

export function resolveMainAreaOverlayInsets({
  sidePanelVisible,
  sidePanelWidth,
  rightPanelVisible,
  rightPanelWidth,
  bottomPanelVisible,
  bottomPanelMaximized,
  bottomPanelHeight
}: MainAreaOverlayInsetsOptions) {
  return {
    top: 0,
    left: sidePanelVisible ? sidePanelWidth + LAYOUT_RESIZE_HANDLE_SIZE : 0,
    right: rightPanelVisible ? rightPanelWidth : 0,
    bottom:
      bottomPanelVisible && !bottomPanelMaximized
        ? bottomPanelHeight + LAYOUT_RESIZE_HANDLE_SIZE
        : 0
  }
}

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical'
  onMouseDown: (e: React.MouseEvent) => void
}

const ResizeHandle: React.FC<ResizeHandleProps> = ({ direction, onMouseDown }) => {
  const isH = direction === 'horizontal'
  return (
    <Box
      onMouseDown={onMouseDown}
      sx={(theme) => ({
        [isH ? 'width' : 'height']: LAYOUT_RESIZE_HANDLE_SIZE,
        [isH ? 'minWidth' : 'minHeight']: LAYOUT_RESIZE_HANDLE_SIZE,
        cursor: isH ? 'col-resize' : 'row-resize',
        backgroundColor:
          theme.palette.mode === 'dark'
            ? theme.palette.background.default
            : theme.palette.background.paper,
        transition: 'background-color 0.15s ease',
        flexShrink: 0,
        zIndex: 10,
        position: 'relative',
        '&::before': {
          content: '""',
          position: 'absolute',
          [isH ? 'top' : 'left']: 0,
          [isH ? 'bottom' : 'right']: 0,
          [isH ? 'left' : 'top']: '50%',
          width: isH ? '1px' : '100%',
          height: isH ? '100%' : '1px',
          transform: isH ? 'translateX(-50%)' : 'translateY(-50%)',
          backgroundColor: theme.palette.divider,
          opacity: 0.7
        },
        '&:hover, &:active': {
          backgroundColor:
            theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
          '&::before': {
            backgroundColor: theme.palette.mode === 'dark' ? '#777' : '#b8c0d4',
            opacity: 1
          }
        }
      })}
    />
  )
}

const Layout: React.FC = () => {
  const dispatch = useAppDispatch()
  const activeSidePanel = useAppSelector((s) => s.layout.activeSidePanel)
  const projectEntrySidePanelIntent = useAppSelector((s) => s.layout.projectEntrySidePanelIntent)
  const bottomPanelVisible = useAppSelector((s) => s.layout.bottomPanelVisible)
  const bottomPanelMaximized = useAppSelector((s) => s.layout.bottomPanelMaximized)
  const rightPanelVisible = useAppSelector((s) => s.layout.rightPanelVisible)
  const lastRoutePath = useAppSelector((s) => s.layout.lastRoutePath)
  const activeTabId = useAppSelector((s) => s.layout.activeTabId)
  const openTabs = useAppSelector((s) => s.layout.openTabs)
  const startupRestorePending = useAppSelector((s) => s.layout.startupRestorePending)
  const startupRestoreSnapshot = useAppSelector((s) => s.layout.startupRestoreSnapshot)

  const navigate = useNavigate()
  const location = useLocation()
  const currentRoute = `${location.pathname}${location.search}${location.hash}`

  const hasRestoredRoute = useRef(false)
  const pendingStartupRoutePathRef = useRef(
    startupRestorePending
      ? null
      : resolveStartupRouteTarget(
          lastRoutePath,
          currentRoute,
          resolveStartupFallbackRoutePath(activeTabId, openTabs)
        )
  )
  useEffect(() => {
    if (hasRestoredRoute.current) {
      return undefined
    }

    if (startupRestorePending) {
      return scheduleStartupRestoreAfterHomePaint(() => {
        if (hasRestoredRoute.current) {
          return
        }

        hasRestoredRoute.current = true
        const startupFallbackRoutePath = startupRestoreSnapshot
          ? resolveStartupFallbackRoutePath(
              startupRestoreSnapshot.activeTabId,
              startupRestoreSnapshot.openTabs
            )
          : ''
        const startupRoutePath = resolveStartupRouteTarget(
          startupRestoreSnapshot?.lastRoutePath ?? '/',
          currentRoute,
          startupFallbackRoutePath
        )
        pendingStartupRoutePathRef.current = startupRoutePath

        if (startupRoutePath) {
          navigate(startupRoutePath, { replace: true })
          return
        }

        dispatch(completeStartupRestore())
      })
    }

    hasRestoredRoute.current = true
    const startupRoutePath = pendingStartupRoutePathRef.current
    if (startupRoutePath) {
      navigate(startupRoutePath, { replace: true })
    }
    return undefined
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hasRestoredRoute.current) {
      return
    }

    if (!shouldPersistCurrentRoute(pendingStartupRoutePathRef.current, currentRoute)) {
      return
    }

    if (startupRestorePending) {
      dispatch(completeStartupRestore())
    }

    pendingStartupRoutePathRef.current = null
    dispatch(setLastRoutePath(normalizeProjectCanvasRoutePath(currentRoute)))
  }, [currentRoute, dispatch, startupRestorePending])

  useEffect(() => {
    if (!hasRestoredRoute.current || startupRestorePending) {
      return
    }

    const syncTimerId = window.setTimeout(() => {
      const hashRoutePath = resolveHashRoutePath(window.location.hash)
      if (hashRoutePath && hashRoutePath !== currentRoute) {
        navigate(hashRoutePath, { replace: true })
        return
      }

      const routeTabId = resolveTabIdForCurrentRoute(
        currentRoute,
        location.pathname,
        location.search,
        openTabs
      )
      if (routeTabId && routeTabId !== activeTabId) {
        dispatch(setActiveTab(routeTabId))
      }
    }, ROUTE_TAB_SYNC_DELAY_MS)

    return () => {
      window.clearTimeout(syncTimerId)
    }
  }, [
    activeTabId,
    currentRoute,
    dispatch,
    location.pathname,
    location.search,
    navigate,
    openTabs,
    startupRestorePending
  ])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void prefetchPrimaryWorkspaceModules()
    }, 150)

    return () => window.clearTimeout(timer)
  }, [])

  const activeTabIdRef = React.useRef(activeTabId)
  const openTabsRef = React.useRef(openTabs)
  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])
  useEffect(() => {
    openTabsRef.current = openTabs
  }, [openTabs])

  useEffect(() => {
    const closeActiveTab = () => {
      const tabId = activeTabIdRef.current
      const tabs = openTabsRef.current
      if (!tabId) return
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab || tab.closable === false) return
      const idx = tabs.findIndex((t) => t.id === tabId)
      const remaining = tabs.filter((t) => t.id !== tabId)
      if (remaining.length > 0) {
        const nextTab = remaining[Math.min(idx, remaining.length - 1)]
        const nextRoutePath = nextTab ? resolveTabRoutePath(nextTab) : ''
        if (nextRoutePath) navigate(nextRoutePath)
      } else {
        navigate('/')
      }
      dispatch(closeTab(tabId))
    }

    const ipc = (
      window as {
        electron?: {
          ipcRenderer?: {
            on: (channel: string, listener: () => void) => void
            removeListener: (channel: string, listener: () => void) => void
          }
        }
      }
    ).electron?.ipcRenderer
    ipc?.on('app:close-tab', closeActiveTab)

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        closeActiveTab()
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      ipc?.removeListener('app:close-tab', closeActiveTab)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [dispatch, navigate])

  const [sidePanelWidth, setSidePanelWidth] = useState(SIDE_PANEL_DEFAULT_WIDTH)
  const [bottomPanelHeight, setBottomPanelHeight] = useState(BOTTOM_PANEL_DEFAULT_HEIGHT)
  const [rightPanelWidth, setRightPanelWidth] = useState(RIGHT_PANEL_DEFAULT_WIDTH)

  const resizingRef = useRef<ResizeDirection>(null)
  const startPosRef = useRef(0)
  const startSizeRef = useRef(0)
  const pendingResizeSizeRef = useRef<number | null>(null)
  const resizeFrameRef = useRef<number | null>(null)

  const applyPendingResizeSize = useCallback(() => {
    resizeFrameRef.current = null
    const dir = resizingRef.current
    const nextSize = pendingResizeSizeRef.current
    pendingResizeSizeRef.current = null
    if (!dir || nextSize === null) {
      return
    }

    if (dir === 'side') {
      setSidePanelWidth((previousWidth) => (previousWidth === nextSize ? previousWidth : nextSize))
    } else if (dir === 'right') {
      setRightPanelWidth((previousWidth) => (previousWidth === nextSize ? previousWidth : nextSize))
    } else if (dir === 'bottom') {
      setBottomPanelHeight((previousHeight) =>
        previousHeight === nextSize ? previousHeight : nextSize
      )
    }
  }, [])

  const scheduleResizeSizeUpdate = useCallback(
    (nextSize: number) => {
      if (pendingResizeSizeRef.current === nextSize && resizeFrameRef.current !== null) {
        return
      }

      pendingResizeSizeRef.current = nextSize
      if (resizeFrameRef.current !== null) {
        return
      }

      resizeFrameRef.current = window.requestAnimationFrame(applyPendingResizeSize)
    },
    [applyPendingResizeSize]
  )

  const finishResizeInteraction = useCallback(() => {
    const dir = resizingRef.current
    if (!dir) {
      return
    }

    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
    }
    applyPendingResizeSize()
    resizingRef.current = null
    pendingResizeSizeRef.current = null
  }, [applyPendingResizeSize])

  const handleMouseDown = useCallback(
    (dir: ResizeDirection) => (e: React.MouseEvent) => {
      if (!dir) {
        return
      }

      e.preventDefault()
      resizingRef.current = dir
      if (dir === 'side' || dir === 'right') {
        startPosRef.current = e.clientX
        startSizeRef.current = dir === 'side' ? sidePanelWidth : rightPanelWidth
      } else {
        startPosRef.current = e.clientY
        startSizeRef.current = bottomPanelHeight
      }
    },
    [sidePanelWidth, rightPanelWidth, bottomPanelHeight]
  )

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const dir = resizingRef.current
      if (!dir) return

      if (dir === 'side') {
        const delta = e.clientX - startPosRef.current
        scheduleResizeSizeUpdate(clampSidePanelWidth(startSizeRef.current, delta))
      } else if (dir === 'right') {
        const delta = startPosRef.current - e.clientX
        scheduleResizeSizeUpdate(clampRightPanelWidth(startSizeRef.current, delta))
      } else if (dir === 'bottom') {
        const delta = startPosRef.current - e.clientY
        scheduleResizeSizeUpdate(
          clampBottomPanelHeight(startSizeRef.current, delta, window.innerHeight)
        )
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', finishResizeInteraction)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', finishResizeInteraction)
      finishResizeInteraction()
    }
  }, [finishResizeInteraction, scheduleResizeSizeUpdate])

  const isProjectTab = activeTabId?.startsWith('tab-project-')
  const isProjectRoute = isProjectCanvasRoutePath(location.pathname)
  const hasEnteredProjectTabRef = useRef(false)

  useEffect(() => {
    if (!isProjectTab) {
      hasEnteredProjectTabRef.current = false
      return
    }

    const hasProjectEntrySidePanelIntent =
      projectEntrySidePanelIntent !== null && projectEntrySidePanelIntent === activeSidePanel

    if (
      shouldAutoCloseProjectSidePanel(
        hasEnteredProjectTabRef.current,
        Boolean(isProjectTab && isProjectRoute),
        activeSidePanel,
        hasProjectEntrySidePanelIntent
      )
    ) {
      dispatch(closeSidePanel())
    }
    if (projectEntrySidePanelIntent !== null && isProjectRoute) {
      dispatch(clearProjectEntrySidePanelIntent())
    }

    if (isProjectRoute) {
      hasEnteredProjectTabRef.current = true
    }
  }, [activeSidePanel, dispatch, isProjectRoute, isProjectTab, projectEntrySidePanelIntent])

  const effectSidePanel = isProjectTab && isProjectRoute ? activeSidePanel : null
  const effectRightPanelVisible = isProjectTab && isProjectRoute ? rightPanelVisible : false
  const mainAreaInsets = resolveMainAreaOverlayInsets({
    sidePanelVisible: Boolean(effectSidePanel),
    sidePanelWidth,
    rightPanelVisible: effectRightPanelVisible,
    rightPanelWidth,
    bottomPanelVisible,
    bottomPanelMaximized,
    bottomPanelHeight
  })

  useEffect(() => {
    const firstFrameId = window.requestAnimationFrame(dispatchMaxSizeLayoutRemeasure)
    const secondFrameId = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(dispatchMaxSizeLayoutRemeasure)
    })
    const settledTimerId = window.setTimeout(
      dispatchMaxSizeLayoutRemeasure,
      LAYOUT_RESIZE_REMEASURE_SETTLE_DELAY_MS
    )

    return () => {
      window.cancelAnimationFrame(firstFrameId)
      window.cancelAnimationFrame(secondFrameId)
      window.clearTimeout(settledTimerId)
    }
  }, [
    activeTabId,
    bottomPanelHeight,
    bottomPanelMaximized,
    bottomPanelVisible,
    effectRightPanelVisible,
    effectSidePanel,
    rightPanelWidth,
    sidePanelWidth
  ])

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden'
      }}
    >
      <TitleBar />

      <Box
        sx={{ display: 'flex', flexDirection: 'row', flex: 1, overflow: 'hidden', minHeight: 0 }}
      >
        <ActivityBar />

        <Box sx={{ position: 'relative', flex: 1, overflow: 'hidden', minWidth: 0, minHeight: 0 }}>
          <Box
            sx={{
              position: 'absolute',
              ...mainAreaInsets,
              display: bottomPanelMaximized ? 'none' : 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              minWidth: 0,
              minHeight: 0
            }}
          >
            <MainArea />
          </Box>

          {effectSidePanel && (
            <Box
              data-canvas-document-drop-bypass="side-panel"
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                bottom: 0,
                zIndex: 30,
                display: 'flex',
                pointerEvents: 'auto'
              }}
            >
              <Suspense
                fallback={
                  <Box sx={{ width: sidePanelWidth, minWidth: sidePanelWidth, height: '100%' }} />
                }
              >
                <SidePanel key={activeTabId} width={sidePanelWidth} projectId={activeTabId} />
                <ResizeHandle direction="horizontal" onMouseDown={handleMouseDown('side')} />
              </Suspense>
            </Box>
          )}

          {bottomPanelVisible && (
            <Box
              data-canvas-document-drop-bypass="bottom-panel"
              sx={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: bottomPanelMaximized ? '100%' : bottomPanelHeight + 4,
                zIndex: 50,
                display: 'flex',
                flexDirection: 'column',
                pointerEvents: 'auto'
              }}
            >
              {!bottomPanelMaximized && (
                <ResizeHandle direction="vertical" onMouseDown={handleMouseDown('bottom')} />
              )}
              <Suspense
                fallback={
                  <Box
                    sx={{ flex: 1, height: bottomPanelMaximized ? '100%' : bottomPanelHeight }}
                  />
                }
              >
                <BottomPanel height={bottomPanelMaximized ? '100%' : bottomPanelHeight} />
              </Suspense>
            </Box>
          )}

          {effectRightPanelVisible && (
            <Box
              data-canvas-document-drop-bypass="right-panel"
              sx={(theme) => ({
                width: rightPanelWidth,
                minWidth: rightPanelWidth,
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                zIndex: 40,
                display: 'flex',
                flexDirection: 'column',
                boxSizing: 'border-box',
                backgroundColor: theme.palette.mode === 'dark' ? '#1b1b1d' : '#eaecf5',
                borderLeft: `1px solid ${theme.palette.divider}`,
                overflow: 'hidden',
                pointerEvents: 'auto'
              })}
            >
              <Box
                data-canvas-document-drop-bypass="right-panel-resize"
                onMouseDown={handleMouseDown('right')}
                sx={(theme) => ({
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  bottom: 0,
                  width: 10,
                  cursor: 'col-resize',
                  zIndex: 20,
                  backgroundColor: 'transparent',
                  transition: 'background-color 0.15s ease',
                  '&:hover': {
                    backgroundColor:
                      theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'
                  }
                })}
              />
              <Suspense fallback={<Box sx={{ flex: 1 }} />}>
                <AgentWorkspace
                  key={activeTabId}
                  projectId={activeTabId}
                  projectName={openTabs.find((tab) => tab.id === activeTabId)?.label}
                />
              </Suspense>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  )
}

export default Layout
