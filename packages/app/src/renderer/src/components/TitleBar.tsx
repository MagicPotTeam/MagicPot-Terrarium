import React, { Suspense, lazy, useEffect, useRef, useState } from 'react'
import {
  Box,
  Dialog,
  Typography,
  IconButton,
  Tooltip,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  useTheme
} from '@mui/material'
import { Close as CloseIcon } from '@mui/icons-material'
import { useNavigate, useLocation } from 'react-router-dom'
import { getPathById } from '@renderer/routes'
import { useTranslation } from 'react-i18next'
import { updateProjectName } from '@renderer/pages/MainPage/projectStore'

import iconHelp from '@renderer/assets/help.png'
import iconMin from '@renderer/assets/min.png'
import iconMax from '@renderer/assets/max.png'
import iconClose from '@renderer/assets/close.png'
import { useConfig } from '@renderer/hooks/useConfig'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  toggleSidePanel,
  toggleBottomPanel,
  toggleRightPanel,
  setActiveTab,
  openTab,
  closeTab,
  updateTabLabel,
  reorderTabs,
  resolveTabRoutePath
} from '@renderer/store/slices/layoutSlice'

const ContactPage = lazy(() => import('@renderer/pages/ContactPage'))

// VSCode 风格面板布局 SVG 图标
const PanelIconSidebar: React.FC<{ active: boolean }> = ({ active }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect
      x="1"
      y="2"
      width="14"
      height="12"
      rx="1"
      stroke="currentColor"
      strokeWidth="1.2"
      fill="none"
    />
    <rect
      className="panel-inner"
      x="1.5"
      y="2.5"
      width="4.5"
      height="11"
      rx="0.5"
      fill={active ? 'currentColor' : 'none'}
      stroke={active ? 'none' : 'currentColor'}
      strokeWidth="0.5"
    />
  </svg>
)

const PanelIconBottom: React.FC<{ active: boolean }> = ({ active }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect
      x="1"
      y="2"
      width="14"
      height="12"
      rx="1"
      stroke="currentColor"
      strokeWidth="1.2"
      fill="none"
    />
    <rect
      className="panel-inner"
      x="1.5"
      y="9.5"
      width="13"
      height="4"
      rx="0.5"
      fill={active ? 'currentColor' : 'none'}
      stroke={active ? 'none' : 'currentColor'}
      strokeWidth="0.5"
    />
  </svg>
)

const PanelIconRight: React.FC<{ active: boolean }> = ({ active }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect
      x="1"
      y="2"
      width="14"
      height="12"
      rx="1"
      stroke="currentColor"
      strokeWidth="1.2"
      fill="none"
    />
    <rect
      className="panel-inner"
      x="10"
      y="2.5"
      width="4.5"
      height="11"
      rx="0.5"
      fill={active ? 'currentColor' : 'none'}
      stroke={active ? 'none' : 'currentColor'}
      strokeWidth="0.5"
    />
  </svg>
)

const BAR_HEIGHT = 34
const BTN_SIZE = 16
const MIN_BTN_HEIGHT = 2
const HELP_SIZE = 20
const TAB_MIN_WIDTH = 72
const titleBarLogoImg = new URL('../../../../../runtime-assets/build/icon.png', import.meta.url)
  .href

// System tab ID → i18n key mapping for dynamic label resolution
const SYSTEM_TAB_I18N_MAP: Record<string, string> = {
  'tab-home': 'project.my',
  'tab-settings': 'menu.settings',
  'tab-design': 'menu.custom_workshop',
  'tab-model': 'menu.models'
}

const baseIconFilter = (mode: 'light' | 'dark') =>
  mode === 'dark' ? 'invert(1) saturate(0) brightness(1.05)' : 'none'

const hoverIconFilter = (mode: 'light' | 'dark') =>
  mode === 'dark' ? 'invert(1) saturate(0) brightness(1.25)' : 'none'

const TitleBar: React.FC = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const [isMax, setIsMax] = useState(false)
  const navigate = useNavigate()
  const { buildEnv } = useConfig()
  const isMacos = buildEnv.env.platform === 'macos'
  const dispatch = useAppDispatch()
  const activeSidePanel = useAppSelector((s) => s.layout.activeSidePanel)
  const bottomPanelVisible = useAppSelector((s) => s.layout.bottomPanelVisible)
  const rightPanelVisible = useAppSelector((s) => s.layout.rightPanelVisible)
  const openTabs = useAppSelector((s) => s.layout.openTabs)
  const activeTabId = useAppSelector((s) => s.layout.activeTabId)
  const location = useLocation()
  const currentRoute = `${location.pathname}${location.search}${location.hash}`
  const [contactOpen, setContactOpen] = useState(false)
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  // 提交重命名
  const commitRename = (tabId: string, newLabel: string) => {
    const trimmed = newLabel.trim()
    if (trimmed && trimmed !== openTabs.find((t) => t.id === tabId)?.label) {
      dispatch(updateTabLabel({ id: tabId, label: trimmed }))
      updateProjectName(tabId, trimmed)
      // 同步更新 localStorage 中的项目名
      try {
        const raw = localStorage.getItem('ai_engine_projects')
        if (raw) {
          const projects = JSON.parse(raw)
          const proj = projects.find((p: { id: string }) => p.id === tabId)
          if (proj) {
            proj.name = trimmed
            updateProjectName(tabId, trimmed)
          }
        }
      } catch {
        /* ignore */
      }
    }
    setEditingTabId(null)
  }

  const openProjectHome = () => {
    const has = openTabs.some((t) => t.id === 'tab-home')
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
  }

  useEffect(() => {
    let off = () => {
      /* noop */
    }
    window.win.isMaximized().then(setIsMax)
    off = window.win.onMaximizeChanged(setIsMax)
    return () => off && off()
  }, [])

  // 面板切换图标的公共样式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panelIconSx = (active: boolean) => (theme: any) => ({
    width: 24,
    height: 24,
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    borderRadius: '4px',
    color: active
      ? theme.palette.mode === 'dark'
        ? '#fff'
        : theme.palette.primary.main
      : theme.palette.mode === 'dark'
        ? '#a0a0a0'
        : '#888',
    backgroundColor: active
      ? theme.palette.mode === 'dark'
        ? 'rgba(255,255,255,0.08)'
        : 'rgba(0,0,0,0.06)'
      : 'transparent',
    transition: 'all 0.15s ease',
    '&:hover': {
      color: theme.palette.mode === 'dark' ? '#e0e0e0' : theme.palette.primary.main,
      backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)',
      '& .panel-inner': {
        fill: 'currentColor',
        stroke: 'none',
        opacity: 0.5
      }
    },
    '& .panel-inner': {
      transition: 'all 0.15s ease',
      opacity: active ? 0.5 : 1
    }
  })

  return (
    <>
      <Box
        sx={(theme) => ({
          height: BAR_HEIGHT,
          minHeight: BAR_HEIGHT,
          maxHeight: BAR_HEIGHT,
          flex: '0 0 auto',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 0,
          pr: 3,
          WebkitAppRegion: 'drag',
          background: theme.palette.mode === 'light' ? '#eaecf5' : '#1a1a1a',
          borderBottom: 'none',
          overflow: 'visible'
        })}
      >
        {/* Logo 区域 — 48px 宽，与 ActivityBar 对齐 */}
        <Box
          sx={{
            width: 48,
            minWidth: 48,
            display: 'grid',
            placeItems: 'center',
            WebkitAppRegion: 'drag'
          }}
        >
          <Box
            role="button"
            aria-label={t('project.my')}
            data-testid="titlebar-home-logo"
            onClick={openProjectHome}
            component="img"
            src={titleBarLogoImg}
            alt="魔壶"
            sx={{
              width: 26,
              height: 26,
              display: 'block',
              cursor: 'pointer',
              WebkitAppRegion: 'no-drag',
              borderRadius: 1,
              userSelect: 'none'
            }}
          />
        </Box>

        <Box
          sx={(theme) => ({
            flex: 1,
            display: 'flex',
            alignItems: 'flex-end',
            height: '100%',
            // 修复拖动：容器继承父级的 drag，内部元素单独设为 no-drag
            overflowX: 'auto',
            overflowY: 'hidden',
            '&::-webkit-scrollbar': { height: 0 },
            pt: 0.5
          })}
        >
          {openTabs.map((tab) => {
            if (tab.id === 'tab-home') return null
            const isActive = tab.id === activeTabId
            return (
              <Box
                key={tab.id}
                draggable={editingTabId !== tab.id}
                onDragStart={(e) => {
                  if (editingTabId === tab.id) {
                    e.preventDefault()
                    return
                  }
                  setDraggingTabId(tab.id)
                  setDragOverTabId(tab.id)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', tab.id)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (draggingTabId && draggingTabId !== tab.id) {
                    setDragOverTabId(tab.id)
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const fromId = draggingTabId || e.dataTransfer.getData('text/plain')
                  if (fromId && fromId !== tab.id) {
                    dispatch(reorderTabs({ fromId, toId: tab.id }))
                  }
                  setDraggingTabId(null)
                  setDragOverTabId(null)
                }}
                onDragEnd={() => {
                  setDraggingTabId(null)
                  setDragOverTabId(null)
                }}
                onClick={() => {
                  if (editingTabId === tab.id) return
                  dispatch(setActiveTab(tab.id))
                  const targetRoutePath = resolveTabRoutePath(tab)
                  if (targetRoutePath && targetRoutePath !== currentRoute) {
                    navigate(targetRoutePath)
                  }
                }}
                onDoubleClick={() => {
                  if (!tab.closable || SYSTEM_TAB_I18N_MAP[tab.id]) return
                  setEditingTabId(tab.id)
                  setEditingLabel(tab.label)
                  setTimeout(() => editInputRef.current?.select(), 0)
                }}
                sx={(theme) => ({
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1,
                  px: 1.5,
                  minWidth: TAB_MIN_WIDTH,
                  flexShrink: 0,
                  height: 30,
                  WebkitAppRegion: 'no-drag', // 必须显式设置 no-drag 才能点击
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontSize: 12,
                  fontWeight: 600,
                  borderRight: `1px solid ${theme.palette.divider}`,
                  borderLeft:
                    dragOverTabId === tab.id && draggingTabId && draggingTabId !== tab.id
                      ? `2px solid ${theme.palette.primary.main}`
                      : '2px solid transparent',
                  borderTopLeftRadius: 6,
                  borderTopRightRadius: 6,
                  backgroundColor: isActive
                    ? theme.palette.mode === 'dark'
                      ? '#2b2d31' // 更醒目的深色模式选中背景
                      : '#ffffff' // 浅色模式选中用纯白脱颖而出
                    : 'transparent',
                  color: isActive
                    ? theme.palette.mode === 'dark'
                      ? '#ffffff'
                      : theme.palette.primary.main
                    : theme.palette.text.secondary,
                  opacity: isActive ? 1 : 0.6,
                  transition: 'all 0.12s ease',
                  transform: draggingTabId === tab.id ? 'scale(0.98)' : 'none',
                  '&:hover': {
                    backgroundColor: isActive
                      ? undefined
                      : theme.palette.mode === 'dark'
                        ? 'rgba(255,255,255,0.05)'
                        : 'rgba(0,0,0,0.04)',
                    opacity: 1
                  }
                })}
              >
                {editingTabId === tab.id ? (
                  <input
                    ref={editInputRef}
                    value={editingLabel}
                    size={Math.max(editingLabel.length, 1)}
                    onChange={(e) => setEditingLabel(e.target.value)}
                    onBlur={() => commitRename(tab.id, editingLabel)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(tab.id, editingLabel)
                      if (e.key === 'Escape') setEditingTabId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      all: 'unset',
                      fontSize: 12,
                      fontWeight: 600,
                      minWidth: 0,
                      color: 'inherit',
                      borderBottom: '1px solid currentColor',
                      paddingBottom: 1
                    }}
                  />
                ) : (
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 600,
                      fontSize: 12,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {SYSTEM_TAB_I18N_MAP[tab.id] ? t(SYSTEM_TAB_I18N_MAP[tab.id]) : tab.label}
                  </Typography>
                )}
                {tab.closable && (
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation()
                      const idx = openTabs.findIndex((t) => t.id === tab.id)
                      const remaining = openTabs.filter((t) => t.id !== tab.id)
                      if (tab.id === activeTabId && remaining.length > 0) {
                        const nextTab = remaining[Math.min(idx, remaining.length - 1)]
                        const nextRoutePath = nextTab ? resolveTabRoutePath(nextTab) : ''
                        if (nextRoutePath) navigate(nextRoutePath)
                      }
                      dispatch(closeTab(tab.id))
                    }}
                    sx={{
                      p: 0.15,
                      ml: 0.5,
                      opacity: 0.5,
                      '&:hover': { opacity: 1 }
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                )}
              </Box>
            )
          })}
          {/* Add Tab Button */}
          <Box
            sx={{
              px: 1,
              display: 'flex',
              alignItems: 'center',
              height: 30,
              WebkitAppRegion: 'no-drag'
            }}
          >
            <Tooltip title={t('project.new')}>
              <IconButton size="small" onClick={openProjectHome} sx={{ width: 24, height: 24 }}>
                <Box component="span" sx={{ fontSize: 16, fontWeight: 'bold' }}>
                  +
                </Box>
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        {/* 图标容器 */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            WebkitAppRegion: 'no-drag',
            gap: 1.5
          }}
        >
          {/* 面板切换图标组（仅在项目内显示） */}
          {activeTabId?.startsWith('tab-project-') && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mr: 0.5 }}>
              <Box
                title={t('titlebar.toggle_quickapp')}
                onClick={() => dispatch(toggleSidePanel(activeSidePanel || 'quickapp'))}
                sx={panelIconSx(!!activeSidePanel)}
              >
                <PanelIconSidebar active={!!activeSidePanel} />
              </Box>
              <Box
                title={t('titlebar.toggle_terminal')}
                onClick={() => dispatch(toggleBottomPanel())}
                sx={panelIconSx(bottomPanelVisible)}
              >
                <PanelIconBottom active={bottomPanelVisible} />
              </Box>
              <Box
                title={t('titlebar.toggle_agent')}
                onClick={() => dispatch(toggleRightPanel())}
                sx={panelIconSx(rightPanelVisible)}
              >
                <PanelIconRight active={rightPanelVisible} />
              </Box>
            </Box>
          )}

          {/* Help Icon */}
          <Box
            title={t('titlebar.help')}
            onClick={() => setContactOpen(true)}
            sx={(theme) => ({
              width: 24,
              height: 24,
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer',
              borderRadius: '4px',
              transition: 'all 0.15s ease',
              '& img': {
                filter: baseIconFilter(theme.palette.mode),
                transition: 'filter 150ms ease, opacity 150ms ease',
                opacity: 0.8
              },
              '&:hover': {
                backgroundColor:
                  theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)',
                '& img': {
                  filter: hoverIconFilter(theme.palette.mode),
                  opacity: 1
                }
              }
            })}
          >
            <Box
              component="img"
              src={iconHelp}
              alt="help"
              sx={{
                width: HELP_SIZE,
                height: HELP_SIZE,
                display: 'block',
                userSelect: 'none',
                pointerEvents: 'none'
              }}
            />
          </Box>
          {/* Minimize */}
          {!isMacos && (
            <Box
              title={t('titlebar.minimize')}
              sx={(theme) => ({
                width: 24,
                height: 24,
                display: 'grid',
                placeItems: 'center',
                cursor: 'pointer',
                userSelect: 'none',
                borderRadius: '4px',
                transition: 'all 0.15s ease',
                '& img': {
                  filter: baseIconFilter(theme.palette.mode),
                  transition: 'filter 150ms ease, opacity 150ms ease',
                  opacity: 0.8
                },
                '&:hover': {
                  backgroundColor:
                    theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)',
                  '& img': {
                    filter: hoverIconFilter(theme.palette.mode),
                    opacity: 1
                  }
                }
              })}
              onClick={() => window.win.minimize()}
            >
              <Box
                component="img"
                src={iconMin}
                alt="minimize"
                sx={{
                  width: BTN_SIZE,
                  height: MIN_BTN_HEIGHT,
                  display: 'block',
                  pointerEvents: 'none'
                }}
              />
            </Box>
          )}

          {/* Maximize / Restore */}
          {!isMacos && (
            <Box
              title={isMax ? t('titlebar.restore') : t('titlebar.maximize')}
              sx={(theme) => ({
                width: 24,
                height: 24,
                display: 'grid',
                placeItems: 'center',
                cursor: 'pointer',
                userSelect: 'none',
                borderRadius: '4px',
                transition: 'all 0.15s ease',
                '& img': {
                  filter: baseIconFilter(theme.palette.mode),
                  transition: 'filter 150ms ease, opacity 150ms ease',
                  opacity: 0.8
                },
                '&:hover': {
                  backgroundColor:
                    theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)',
                  '& img': {
                    filter: hoverIconFilter(theme.palette.mode),
                    opacity: 1
                  }
                }
              })}
              onClick={() => window.win.toggleMaximize()}
            >
              <Box
                component="img"
                src={iconMax}
                alt={isMax ? 'restore' : 'maximize'}
                sx={{
                  width: BTN_SIZE,
                  height: BTN_SIZE,
                  display: 'block',
                  pointerEvents: 'none'
                }}
              />
            </Box>
          )}

          {/* Close */}
          {!isMacos && (
            <Box
              title={t('titlebar.close')}
              sx={(theme) => ({
                width: 24,
                height: 24,
                display: 'grid',
                placeItems: 'center',
                cursor: 'pointer',
                userSelect: 'none',
                borderRadius: '4px',
                transition: 'all 0.15s ease',
                '& img': {
                  filter: baseIconFilter(theme.palette.mode),
                  transition: 'filter 150ms ease, opacity 150ms ease',
                  opacity: 0.8
                },
                '&:hover': {
                  backgroundColor:
                    theme.palette.mode === 'dark' ? 'rgba(255,0,0,0.3)' : 'rgba(255,0,0,0.15)',
                  '& img': {
                    filter: hoverIconFilter(theme.palette.mode),
                    opacity: 1
                  }
                }
              })}
              onClick={() => window.win.close()}
            >
              <Box
                component="img"
                src={iconClose}
                alt="close"
                sx={{
                  width: BTN_SIZE,
                  height: BTN_SIZE,
                  display: 'block',
                  pointerEvents: 'none'
                }}
              />
            </Box>
          )}
        </Box>
      </Box>

      {/* 帮助/联系我们独立窗口 */}
      <Dialog
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        maxWidth="md"
        fullWidth
        PaperProps={{
          sx: (theme) => ({
            height: '80vh',
            maxHeight: '80vh',
            bgcolor: theme.palette.mode === 'dark' ? '#1e1e1e' : '#e7e9f5',
            backgroundImage: 'none',
            borderRadius: '12px',
            overflow: 'hidden'
          })
        }}
      >
        <Suspense fallback={<Box sx={{ height: '100%' }} />}>
          <ContactPage />
        </Suspense>
      </Dialog>
    </>
  )
}

export default TitleBar
