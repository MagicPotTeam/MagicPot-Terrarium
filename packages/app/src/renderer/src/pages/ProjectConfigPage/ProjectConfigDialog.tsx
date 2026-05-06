// packages/app/src/renderer/src/pages/ProjectConfigPage/ProjectConfigDialog.tsx
import React from 'react'
import { Box, Typography, Dialog, IconButton, Tooltip, Fade } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import CloseIcon from '@mui/icons-material/Close'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import TuneIcon from '@mui/icons-material/Tune'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  closeProjectConfig,
  setSubPage,
  WORKFLOW_PRESETS
} from '@renderer/store/slices/projectConfigSlice'
import WorkflowSelectPanel from './WorkflowSelectPanel'
import ParamsSettingPanel from './ParamsSettingPanel'

/* ──────────────────────────────────────────
 *  子页面导航配置
 * ────────────────────────────────────────── */
const NAV_ITEMS: { id: 'workflow' | 'params'; label: string; icon: React.ReactNode }[] = [
  { id: 'workflow', label: '工作流选择', icon: <AccountTreeIcon sx={{ fontSize: 20 }} /> },
  { id: 'params', label: '参数配置', icon: <TuneIcon sx={{ fontSize: 20 }} /> }
]

/* ──────────────────────────────────────────
 *  主弹窗
 * ────────────────────────────────────────── */
const ProjectConfigDialog: React.FC = () => {
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const dispatch = useAppDispatch()

  const dialogOpen = useAppSelector((s) => s.projectConfig.dialogOpen)
  const activeSubPage = useAppSelector((s) => s.projectConfig.activeSubPage)
  const selectedWorkflow = useAppSelector((s) => s.projectConfig.selectedWorkflow)
  const preset = WORKFLOW_PRESETS.find((p) => p.id === selectedWorkflow)

  return (
    <Dialog
      open={dialogOpen}
      onClose={() => dispatch(closeProjectConfig())}
      maxWidth={false}
      fullWidth
      TransitionComponent={Fade}
      transitionDuration={220}
      PaperProps={{
        sx: {
          width: '85vw',
          maxWidth: 1100,
          height: '80vh',
          maxHeight: '80vh',
          bgcolor: isLight ? '#e7e9f5' : '#1a1a1a',
          backgroundImage: 'none',
          borderRadius: '16px',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'row',
          border: `1px solid ${isLight ? '#d0d2e0' : '#333'}`
        }
      }}
    >
      {/* ─── 左侧导航栏 ─── */}
      <Box
        sx={{
          width: 220,
          minWidth: 220,
          display: 'flex',
          flexDirection: 'column',
          bgcolor: isLight ? '#dcddf0' : '#151515',
          borderRight: `1px solid ${isLight ? '#c8c9dd' : '#2a2a2a'}`
        }}
      >
        {/* 标题 */}
        <Box sx={{ px: 2.5, pt: 2.5, pb: 2 }}>
          <Typography
            sx={{
              fontWeight: 800,
              fontSize: 16,
              letterSpacing: 0.3,
              background: 'linear-gradient(135deg, #7d72fc, #9b8fff)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent'
            }}
          >
            项目配置
          </Typography>
          <Typography sx={{ fontSize: 11, color: 'text.disabled', mt: 0.5, fontWeight: 500 }}>
            Project Configuration
          </Typography>
        </Box>

        {/* 导航列表 */}
        <Box sx={{ flex: 1, px: 1.5, py: 0.5 }}>
          {NAV_ITEMS.map((item) => {
            const isActive = activeSubPage === item.id
            return (
              <Box
                key={item.id}
                onClick={() => dispatch(setSubPage(item.id))}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  px: 2,
                  py: 1.25,
                  mb: 0.5,
                  borderRadius: 2,
                  cursor: 'pointer',
                  transition: 'all 0.18s ease',
                  color: isActive ? '#fff' : isLight ? '#666' : '#999',
                  bgcolor: isActive ? '#7d72fc' : 'transparent',
                  boxShadow: isActive ? '0 2px 12px rgba(125, 114, 252, 0.35)' : 'none',
                  '&:hover': {
                    bgcolor: isActive
                      ? '#7d72fc'
                      : isLight
                        ? 'rgba(0,0,0,0.04)'
                        : 'rgba(255,255,255,0.05)',
                    color: isActive ? '#fff' : 'text.primary'
                  }
                }}
              >
                {item.icon}
                <Typography sx={{ fontWeight: 600, fontSize: 13 }}>{item.label}</Typography>
              </Box>
            )
          })}
        </Box>

        {/* 底部工作流小标识 */}
        {preset && (
          <Box
            sx={{
              mx: 1.5,
              mb: 2,
              px: 2,
              py: 1.5,
              borderRadius: 2,
              bgcolor: isLight ? 'rgba(125, 114, 252, 0.08)' : 'rgba(125, 114, 252, 0.1)',
              border: `1px solid ${isLight ? 'rgba(125, 114, 252, 0.15)' : 'rgba(125, 114, 252, 0.2)'}`
            }}
          >
            <Typography sx={{ fontSize: 11, color: 'text.disabled', fontWeight: 600, mb: 0.5 }}>
              当前工作流
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={{ fontSize: 18 }}>{preset.icon}</Typography>
              <Typography sx={{ fontSize: 13, fontWeight: 700, color: '#7d72fc' }}>
                {preset.label}
              </Typography>
            </Box>
          </Box>
        )}
      </Box>

      {/* ─── 右侧内容区 ─── */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* 顶部操作栏 */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            px: 2,
            py: 1,
            minHeight: 44
          }}
        >
          <Tooltip title="关闭" arrow>
            <IconButton
              size="small"
              onClick={() => dispatch(closeProjectConfig())}
              sx={{
                color: 'text.secondary',
                '&:hover': { bgcolor: 'rgba(255,0,0,0.08)', color: 'error.main' }
              }}
            >
              <CloseIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Tooltip>
        </Box>

        {/* 面板内容 */}
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          {activeSubPage === 'workflow' ? <WorkflowSelectPanel /> : <ParamsSettingPanel />}
        </Box>
      </Box>
    </Dialog>
  )
}

export default ProjectConfigDialog
