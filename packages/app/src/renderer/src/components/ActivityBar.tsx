import React from 'react'
import { Box, Tooltip } from '@mui/material'
import { useTranslation } from 'react-i18next'
import {
  FlashOn as FlashIcon,
  Architecture as DesignIcon,
  Chat as ChatIcon,
  Terminal as TerminalIcon,
  Settings as SettingsIcon,
  FolderOpen as ProjectIcon,
  Extension as ModelIcon
} from '@mui/icons-material'
import { useAppDispatch, useAppSelector } from '../store'
import {
  closeSidePanel,
  openSidePanel,
  openSidePanelOnProjectEntry,
  toggleBottomPanel,
  openRightPanel,
  closeRightPanel,
  openTab,
  setActiveTab,
  resolveTabRoutePath
} from '../store/slices/layoutSlice'
import { useLocation, useNavigate } from 'react-router-dom'
import { isProjectCanvasRoutePath } from '../pages/ProjectCanvasPage/projectCanvasRouting'
const ACTIVITY_BAR_WIDTH = 48
const ACTIVITY_BAR_ICON_SIZE = 24
const DARK_INACTIVE_ICON_COLOR = '#808694'
const DARK_ACTIVE_ICON_COLOR = '#f2f2f2'
const DARK_HOVER_ICON_COLOR = '#f2f2f2'

const ActivityBar: React.FC = () => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const location = useLocation()
  const activeSidePanel = useAppSelector((state) => state.layout.activeSidePanel)
  const activeTabId = useAppSelector((state) => state.layout.activeTabId)
  const openTabs = useAppSelector((state) => state.layout.openTabs)
  const bottomPanelVisible = useAppSelector((state) => state.layout.bottomPanelVisible)
  const rightPanelVisible = useAppSelector((state) => state.layout.rightPanelVisible)
  const lastActiveProjectId = useAppSelector((state) => state.layout.lastActiveProjectId)
  const isProjectTab = activeTabId?.startsWith('tab-project-')
  const isProjectCanvasRoute = isProjectCanvasRoutePath(location.pathname)
  const isProjectCanvasActive = Boolean(isProjectTab && isProjectCanvasRoute)
  const effectSidePanel = isProjectCanvasActive ? activeSidePanel : null
  const effectRightPanelVisible = isProjectCanvasActive ? rightPanelVisible : false
  const projectEntryActive = activeTabId === 'tab-home' || Boolean(isProjectTab)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iconSx = (active: boolean) => (theme: any) => ({
    width: ACTIVITY_BAR_WIDTH,
    height: ACTIVITY_BAR_WIDTH,
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    position: 'relative' as const,
    border: 0,
    padding: 0,
    background: 'transparent',
    font: 'inherit',
    color: active
      ? theme.palette.mode === 'dark'
        ? DARK_ACTIVE_ICON_COLOR
        : theme.palette.primary.main
      : theme.palette.mode === 'dark'
        ? DARK_INACTIVE_ICON_COLOR
        : '#666',
    transition: 'color 0.15s ease',
    '&:hover': {
      color: theme.palette.mode === 'dark' ? DARK_HOVER_ICON_COLOR : theme.palette.primary.main
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.palette.primary.main}`,
      outlineOffset: -2
    }
  })
  const iconGraphicSx = {
    fontSize: ACTIVITY_BAR_ICON_SIZE
  }

  const toggleTab = (id: string, label: string, routePath: string) => {
    const has = openTabs.some((tab) => tab.id === id)
    if (has) {
      dispatch(setActiveTab(id))
      navigate(routePath)
    } else {
      dispatch(openTab({ id, label, routePath, closable: true }))
      navigate(routePath)
    }
  }

  const switchBackToLastProject = () => {
    if (activeTabId?.startsWith('tab-project-')) {
      if (!isProjectCanvasRoute) {
        const activeProjectTab = openTabs.find((tab) => tab.id === activeTabId)
        navigate(resolveTabRoutePath(activeProjectTab ?? { id: activeTabId }))
      }

      return true
    }

    if (lastActiveProjectId) {
      const targetTab = openTabs.find((tab) => tab.id === lastActiveProjectId)
      if (targetTab) {
        dispatch(setActiveTab(targetTab.id))
        navigate(resolveTabRoutePath(targetTab))
        return true
      }
    }

    const projectTabs = openTabs.filter((tab) => tab.id.startsWith('tab-project-'))
    if (projectTabs.length > 0) {
      const fallback = projectTabs[projectTabs.length - 1]
      dispatch(setActiveTab(fallback.id))
      navigate(resolveTabRoutePath(fallback))
      return true
    }

    return false
  }

  return (
    <Box
      component="nav"
      aria-label={t('menu.navigation', { defaultValue: 'Main navigation' })}
      sx={(theme) => ({
        width: ACTIVITY_BAR_WIDTH,
        minWidth: ACTIVITY_BAR_WIDTH,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: theme.palette.mode === 'dark' ? '#1a1a1a' : '#eaecf5',
        userSelect: 'none',
        flexShrink: 0
      })}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
        <Tooltip title={t('menu.project')} placement="right" arrow>
          <Box
            component="button"
            type="button"
            aria-label={t('menu.project')}
            aria-pressed={projectEntryActive}
            data-testid="activity-bar-project"
            onClick={() => {
              const has = openTabs.some((tab) => tab.id === 'tab-home')
              if (!has) {
                dispatch(
                  openTab({
                    id: 'tab-home',
                    label: t('menu.project'),
                    routePath: '/',
                    closable: false
                  })
                )
              }
              dispatch(setActiveTab('tab-home'))
              navigate('/')
            }}
            sx={iconSx(projectEntryActive)}
          >
            <ProjectIcon sx={iconGraphicSx} />
          </Box>
        </Tooltip>

        {openTabs.some((tab) => tab.id.startsWith('tab-project-')) && (
          <>
            <Tooltip title={t('menu.quick_app')} placement="right" arrow>
              <Box
                component="button"
                type="button"
                aria-label={t('menu.quick_app')}
                aria-pressed={effectSidePanel === 'quickapp'}
                data-testid="activity-bar-quickapp"
                onClick={() => {
                  if (isProjectCanvasActive) {
                    if (activeSidePanel === 'quickapp') {
                      dispatch(closeSidePanel())
                    } else {
                      dispatch(openSidePanel('quickapp'))
                    }
                    return
                  }
                  dispatch(openSidePanelOnProjectEntry('quickapp'))
                  switchBackToLastProject()
                }}
                sx={iconSx(effectSidePanel === 'quickapp')}
              >
                <FlashIcon sx={iconGraphicSx} />
              </Box>
            </Tooltip>

            <Tooltip title="Agent" placement="right" arrow>
              <Box
                component="button"
                type="button"
                aria-label="Agent"
                aria-pressed={effectRightPanelVisible}
                data-testid="activity-bar-agent"
                onClick={() => {
                  if (isProjectCanvasActive) {
                    if (rightPanelVisible) {
                      dispatch(closeRightPanel())
                    } else {
                      dispatch(openRightPanel())
                    }
                    return
                  }
                  dispatch(openRightPanel())
                  switchBackToLastProject()
                }}
                sx={iconSx(effectRightPanelVisible)}
              >
                <ChatIcon sx={iconGraphicSx} />
              </Box>
            </Tooltip>
          </>
        )}

        <Tooltip title={t('menu.custom_workshop')} placement="right" arrow>
          <Box
            component="button"
            type="button"
            aria-label={t('menu.custom_workshop')}
            aria-pressed={activeTabId === 'tab-design'}
            onClick={() => toggleTab('tab-design', t('menu.custom_workshop'), '/qappdesign')}
            sx={iconSx(activeTabId === 'tab-design')}
          >
            <DesignIcon sx={iconGraphicSx} />
          </Box>
        </Tooltip>

        <Tooltip title={t('menu.models')} placement="right" arrow>
          <Box
            component="button"
            type="button"
            aria-label={t('menu.models')}
            aria-pressed={activeTabId === 'tab-model'}
            onClick={() => toggleTab('tab-model', t('menu.models'), '/model')}
            sx={iconSx(activeTabId === 'tab-model')}
          >
            <ModelIcon sx={iconGraphicSx} />
          </Box>
        </Tooltip>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', pb: 0.5 }}>
        <Tooltip title={t('menu.terminal')} placement="right" arrow>
          <Box
            component="button"
            type="button"
            aria-label={t('menu.terminal')}
            aria-pressed={bottomPanelVisible}
            onClick={() => dispatch(toggleBottomPanel())}
            sx={iconSx(bottomPanelVisible)}
          >
            <TerminalIcon sx={iconGraphicSx} />
          </Box>
        </Tooltip>

        <Tooltip title={t('menu.settings')} placement="right" arrow>
          <Box
            component="button"
            type="button"
            aria-label={t('menu.settings')}
            aria-pressed={activeTabId === 'tab-settings'}
            onClick={() => toggleTab('tab-settings', t('menu.settings'), '/settings')}
            sx={iconSx(activeTabId === 'tab-settings')}
          >
            <SettingsIcon sx={iconGraphicSx} />
          </Box>
        </Tooltip>
      </Box>
    </Box>
  )
}

export { ACTIVITY_BAR_WIDTH }
export default ActivityBar
