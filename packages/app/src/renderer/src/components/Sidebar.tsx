import React from 'react'
import {
  Box,
  Collapse,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  styled
} from '@mui/material'
import { useLocation, useNavigate } from 'react-router-dom'
import { PageType, getSidebarRoutes, getIdByPath, getPathById } from '../routes'
import { BUILD_MODE, PACKAGE_VERSION } from '@shared/config/viteEnv'
import { useConfig } from '@renderer/hooks/useConfig'
import { TransitionGroup } from 'react-transition-group'
import SidebarCollapseProvider from './SidebarCollapseProvider'
import { useSidebarCollapse } from './SidebarCollapseContext'
import SidebarHeader from './SidebarHeader'
import { useTranslation } from 'react-i18next'

// 尺寸与动画时间
const SIDEBAR_WIDTH = 236
const SIDEBAR_WIDTH_COLLAPSED = 72
const WIDTH_MS = 220
const ITEM_MIN_HEIGHT = 48

const StyledListItemButton = styled(ListItemButton)(({ theme }) => ({
  mx: 0.5,
  borderRadius: 2,
  fontWeight: 600,
  transition: 'all .18s ease',
  minHeight: ITEM_MIN_HEIGHT,
  '& .MuiListItemIcon-root': {
    color: theme.palette.menu.inactive
  },
  '& .MuiListItemText-primary': {
    color: theme.palette.menu.inactive,
    fontWeight: 600
  },
  '&:hover': {
    ml: 0,
    mr: 0.2,
    backgroundColor: theme.palette.menu.hoverBg,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderTopRightRadius: 22,
    borderBottomRightRadius: 22,
    boxShadow: 'none'
  },
  '&.Mui-selected': {
    ml: 0,
    mr: 0.2,
    backgroundColor: theme.palette.menu.selectedBg,
    color: '#fff',
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderTopRightRadius: 22,
    borderBottomRightRadius: 22,
    boxShadow: theme.palette.menu.sideShadow,
    '& .MuiListItemIcon-root': {
      color: '#fff'
    },
    '& .MuiListItemText-primary': {
      color: '#fff'
    },
    '&:hover': {
      backgroundColor: theme.palette.menu.selectedBg,
      boxShadow: theme.palette.menu.sideShadow
    }
  },
  '&:hover .sidebar-label': {
    opacity: 1,
    maxHeight: 32,
    transform: 'translateY(0)',
    pointerEvents: 'auto'
  }
}))

const SidebarInner: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { configUtils, config } = useConfig()
  const { t } = useTranslation()
  const comfyuiDirAvailable = configUtils.isComfyUIDirAvailable()
  const pythonCmdAvailable = configUtils.isPythonCmdAvailable()
  const comfyUICommandAvailable = configUtils.isComfyUICommandAvailable()
  const isRemoteLLMMode = config?.use_remote_llm || false

  const currentPage = getIdByPath(location.pathname)
  const handlePageChange = (page: PageType) => navigate(getPathById(page))
  const menuItems = getSidebarRoutes()

  const { collapsed } = useSidebarCollapse()

  return (
    <Box
      sx={(theme) => ({
        position: 'relative',
        width: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH,
        transition: `width ${WIDTH_MS}ms ease`,
        // ★★★ 核心修复：添加 height: '100%' 撑满父容器 ★★★
        height: '100%',
        background:
          theme.palette.mode === 'light'
            ? 'linear-gradient(to bottom left, #e7eaf5 0%, #d0d0e3 100%)'
            : theme.palette.background.paper,
        display: 'flex',
        flexDirection: 'column',
        overflowX: 'visible',
        overflowY: 'visible'
      })}
    >
      <SidebarHeader />

      <Box sx={{ flex: 1, overflowX: 'visible' }}>
        <List sx={{ pt: 1 }}>
          <TransitionGroup>
            {menuItems
              .filter((item) => comfyuiDirAvailable || !item.onlyWhenComfyUIDirAvailable)
              .filter((item) => pythonCmdAvailable || !item.onlyWhenPythonCmdAvailable)
              .filter((item) => comfyUICommandAvailable || !item.onlyWhenComfyUICommandAvailable)
              .filter((item) => !isRemoteLLMMode || !item.hideWhenRemoteLLM)
              .map((item) => {
                const selected = currentPage === item.id
                // @ts-ignore labelKey is valid
                const label: string = item.labelKey ? t(item.labelKey) : item.label

                const TextBox = (
                  <Box
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'clip'
                    }}
                  >
                    <ListItemText
                      primary={label}
                      slotProps={{ primary: { style: { fontWeight: 600 } } }}
                    />
                  </Box>
                )

                return (
                  <Collapse key={item.id}>
                    <ListItem disablePadding>
                      <StyledListItemButton
                        selected={selected}
                        onClick={() => handlePageChange(item.id)}
                        sx={
                          collapsed
                            ? {
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                py: 1.5,
                                gap: 0.5
                              }
                            : undefined
                        }
                      >
                        <ListItemIcon
                          sx={{
                            minWidth: collapsed ? 0 : 42,
                            justifyContent: 'center'
                          }}
                        >
                          <item.Icon />
                        </ListItemIcon>

                        {collapsed ? (
                          <Box
                            className="sidebar-label"
                            sx={{
                              maxHeight: 0,
                              opacity: 0,
                              mt: 0.5,
                              overflow: 'hidden',
                              transform: 'translateY(-4px)',
                              transition:
                                'opacity 160ms ease, max-height 160ms ease, transform 160ms ease',
                              pointerEvents: 'none'
                            }}
                          >
                            <ListItemText
                              primary={label}
                              primaryTypographyProps={{
                                variant: 'caption',
                                sx: {
                                  fontWeight: 600,
                                  textAlign: 'center',
                                  lineHeight: 1.2
                                }
                              }}
                            />
                          </Box>
                        ) : (
                          TextBox
                        )}
                      </StyledListItemButton>
                    </ListItem>
                  </Collapse>
                )
              })}
          </TransitionGroup>
        </List>
      </Box>

      {/* 底部版本号 */}
      <Box
        sx={{
          p: 2,
          borderTop: 1,
          borderColor: 'divider',
          opacity: collapsed ? 0 : 1,
          transition: 'opacity 180ms ease',
          transitionDelay: collapsed ? '0ms' : `${WIDTH_MS}ms`
        }}
      >
        {!collapsed && (
          <Box
            component="span"
            sx={{
              display: 'block',
              textAlign: 'center',
              fontSize: 12,
              fontWeight: 600,
              color: 'text.secondary',
              whiteSpace: 'nowrap'
            }}
          >
            Magic Pot {BUILD_MODE} {PACKAGE_VERSION}
          </Box>
        )}
      </Box>
    </Box>
  )
}

const Sidebar: React.FC = () => (
  <SidebarCollapseProvider>
    <SidebarInner />
  </SidebarCollapseProvider>
)

export default Sidebar
