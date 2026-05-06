// packages/app/src/renderer/src/pages/ProjectConfigPage/WorkflowSelectPanel.tsx
import React from 'react'
import { Box, Typography, Chip } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  selectWorkflow,
  WorkflowType,
  WORKFLOW_PRESETS,
  setSubPage
} from '@renderer/store/slices/projectConfigSlice'

const WorkflowSelectPanel: React.FC = () => {
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const dispatch = useAppDispatch()
  const selectedWorkflow = useAppSelector((s) => s.projectConfig.selectedWorkflow)

  const handleSelect = (id: WorkflowType) => {
    dispatch(selectWorkflow(id))
  }

  return (
    <Box sx={{ p: 3, height: '100%', overflowY: 'auto' }}>
      {/* 标题 */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800, mb: 0.5 }}>
          选择工作流
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          为当前项目选择基础模型架构，参数将自动适配
        </Typography>
      </Box>

      {/* 工作流网格 */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 2
        }}
      >
        {WORKFLOW_PRESETS.map((preset) => {
          const isSelected = selectedWorkflow === preset.id
          return (
            <Box
              key={preset.id}
              onClick={() => handleSelect(preset.id)}
              sx={{
                position: 'relative',
                p: 2.5,
                borderRadius: 3,
                cursor: 'pointer',
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                border: isSelected
                  ? '2px solid #7d72fc'
                  : `2px solid ${isLight ? '#d0d2e0' : '#333'}`,
                background: isSelected
                  ? isLight
                    ? 'linear-gradient(135deg, #f0eeff 0%, #e8e4ff 100%)'
                    : 'linear-gradient(135deg, #2a2545 0%, #1e1e2e 100%)'
                  : isLight
                    ? '#fff'
                    : '#222',
                boxShadow: isSelected
                  ? '0 4px 20px rgba(125, 114, 252, 0.25), 0 2px 8px rgba(125, 114, 252, 0.15)'
                  : isLight
                    ? '0 2px 8px rgba(0,0,0,0.04)'
                    : '0 2px 8px rgba(0,0,0,0.3)',
                '&:hover': {
                  transform: 'translateY(-2px)',
                  boxShadow: isSelected
                    ? '0 8px 28px rgba(125, 114, 252, 0.3), 0 4px 12px rgba(125, 114, 252, 0.2)'
                    : isLight
                      ? '0 6px 20px rgba(0,0,0,0.08)'
                      : '0 6px 20px rgba(0,0,0,0.5)',
                  borderColor: isSelected ? '#7d72fc' : isLight ? '#8b85e0' : '#555'
                }
              }}
            >
              {/* 选中勾标 */}
              {isSelected && (
                <CheckCircleIcon
                  sx={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    fontSize: 22,
                    color: '#7d72fc',
                    filter: 'drop-shadow(0 1px 3px rgba(125, 114, 252, 0.4))'
                  }}
                />
              )}

              {/* 图标 + 标题 */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
                <Box
                  sx={{
                    width: 44,
                    height: 44,
                    borderRadius: 2,
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 22,
                    background: isSelected
                      ? 'linear-gradient(135deg, #7d72fc, #9b8fff)'
                      : isLight
                        ? 'linear-gradient(135deg, #e8e6f8, #d8d6ee)'
                        : 'linear-gradient(135deg, #333, #444)',
                    boxShadow: isSelected
                      ? '0 2px 8px rgba(125, 114, 252, 0.3)'
                      : '0 1px 4px rgba(0,0,0,0.1)',
                    flexShrink: 0
                  }}
                >
                  {preset.icon}
                </Box>
                <Box>
                  <Typography
                    sx={{
                      fontWeight: 700,
                      fontSize: 15,
                      color: isSelected ? (isLight ? '#4a3fc7' : '#b4a8ff') : 'text.primary'
                    }}
                  >
                    {preset.label}
                  </Typography>
                </Box>
              </Box>

              {/* 描述 */}
              <Typography
                variant="body2"
                sx={{
                  color: 'text.secondary',
                  fontSize: 13,
                  lineHeight: 1.5,
                  mb: 2,
                  minHeight: 40
                }}
              >
                {preset.description}
              </Typography>

              {/* 默认参数标签 */}
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                <Chip
                  label={`${preset.defaultWidth}×${preset.defaultHeight}`}
                  size="small"
                  sx={{
                    fontSize: 11,
                    fontWeight: 600,
                    height: 22,
                    bgcolor: isLight ? '#eeedf6' : '#333',
                    color: 'text.secondary'
                  }}
                />
                <Chip
                  label={`${preset.defaultSteps} 步`}
                  size="small"
                  sx={{
                    fontSize: 11,
                    fontWeight: 600,
                    height: 22,
                    bgcolor: isLight ? '#eeedf6' : '#333',
                    color: 'text.secondary'
                  }}
                />
                <Chip
                  label={`CFG ${preset.defaultCfg}`}
                  size="small"
                  sx={{
                    fontSize: 11,
                    fontWeight: 600,
                    height: 22,
                    bgcolor: isLight ? '#eeedf6' : '#333',
                    color: 'text.secondary'
                  }}
                />
                {!preset.supportsNegativePrompt && (
                  <Chip
                    label="无需负向"
                    size="small"
                    sx={{
                      fontSize: 11,
                      fontWeight: 600,
                      height: 22,
                      bgcolor: 'rgba(125, 114, 252, 0.15)',
                      color: '#7d72fc'
                    }}
                  />
                )}
              </Box>
            </Box>
          )
        })}
      </Box>

      {/* 底部快捷操作提示 */}
      <Box
        sx={{
          mt: 3,
          p: 2,
          borderRadius: 2,
          bgcolor: isLight ? '#f4f3fa' : '#2a2a2a',
          border: `1px solid ${isLight ? '#e0dff0' : '#333'}`
        }}
      >
        <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: 13 }}>
          💡 选择工作流后，点击左侧 <strong>「参数配置」</strong>{' '}
          可以微调当前工作流的生成参数（提示词、步数、尺寸等）。
        </Typography>
      </Box>
    </Box>
  )
}

export default WorkflowSelectPanel
