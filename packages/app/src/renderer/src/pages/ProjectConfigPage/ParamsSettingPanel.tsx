// packages/app/src/renderer/src/pages/ProjectConfigPage/ParamsSettingPanel.tsx
import React, { useCallback } from 'react'
import {
  Box,
  Typography,
  TextField,
  Slider,
  Select,
  MenuItem,
  InputLabel,
  FormControl,
  IconButton,
  Tooltip,
  Button,
  Divider,
  Chip
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import CasinoIcon from '@mui/icons-material/Casino'
import LockIcon from '@mui/icons-material/Lock'
import LockOpenIcon from '@mui/icons-material/LockOpen'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  updateParams,
  resetParamsToDefault,
  randomizeSeed,
  WORKFLOW_PRESETS,
  GenerationParams
} from '@renderer/store/slices/projectConfigSlice'

/* ──────────────────────────────────────────
 *  参数行组件
 * ────────────────────────────────────────── */
interface ParamRowProps {
  label: string
  description?: string
  children: React.ReactNode
  fullWidth?: boolean
}

const ParamRow: React.FC<ParamRowProps> = ({ label, description, children, fullWidth }) => {
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: fullWidth ? 'column' : 'row',
        alignItems: fullWidth ? 'stretch' : 'flex-start',
        gap: fullWidth ? 1 : 3,
        py: 2,
        borderBottom: `1px solid ${isLight ? '#e8e7f0' : '#2e2e2e'}`
      }}
    >
      <Box sx={{ minWidth: fullWidth ? 'auto' : 160, flexShrink: 0 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{label}</Typography>
        {description && (
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.25 }}>
            {description}
          </Typography>
        )}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Box>
  )
}

/* ──────────────────────────────────────────
 *  主面板
 * ────────────────────────────────────────── */
const ParamsSettingPanel: React.FC = () => {
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const dispatch = useAppDispatch()

  const params = useAppSelector((s) => s.projectConfig.params)
  const selectedWorkflow = useAppSelector((s) => s.projectConfig.selectedWorkflow)
  const preset = WORKFLOW_PRESETS.find((p) => p.id === selectedWorkflow) || WORKFLOW_PRESETS[0]

  const update = useCallback(
    (patch: Partial<GenerationParams>) => {
      dispatch(updateParams(patch))
    },
    [dispatch]
  )

  // 图片尺寸预设
  const SIZE_PRESETS = [
    { label: '1:1', w: preset.defaultWidth, h: preset.defaultHeight },
    { label: '3:4', w: Math.round(preset.defaultWidth * 0.75), h: preset.defaultHeight },
    { label: '4:3', w: preset.defaultWidth, h: Math.round(preset.defaultHeight * 0.75) },
    { label: '9:16', w: Math.round(preset.defaultWidth * 0.5625), h: preset.defaultHeight },
    { label: '16:9', w: preset.defaultWidth, h: Math.round(preset.defaultHeight * 0.5625) }
  ]

  return (
    <Box sx={{ p: 3, height: '100%', overflowY: 'auto' }}>
      {/* 标题栏 */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 2
        }}
      >
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800, mb: 0.5 }}>
            参数配置
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              当前工作流：
            </Typography>
            <Chip
              label={`${preset.icon} ${preset.label}`}
              size="small"
              sx={{
                fontWeight: 600,
                fontSize: 12,
                bgcolor: 'rgba(125, 114, 252, 0.12)',
                color: '#7d72fc'
              }}
            />
          </Box>
        </Box>
        <Tooltip title="重置为默认参数" arrow>
          <Button
            size="small"
            startIcon={<RestartAltIcon />}
            onClick={() => dispatch(resetParamsToDefault())}
            sx={{
              textTransform: 'none',
              fontWeight: 600,
              color: 'text.secondary',
              '&:hover': { color: 'error.main' }
            }}
          >
            重置
          </Button>
        </Tooltip>
      </Box>

      <Divider sx={{ mb: 1 }} />

      {/* ─── 提示词 ─── */}
      <ParamRow label="正向提示词" description="描述你想要生成的图像内容" fullWidth>
        <TextField
          multiline
          minRows={3}
          maxRows={8}
          fullWidth
          size="small"
          placeholder="masterpiece, best quality, 1girl, ..."
          value={params.prompt}
          onChange={(e) => update({ prompt: e.target.value })}
          sx={{
            '& .MuiOutlinedInput-root': {
              fontSize: 13,
              bgcolor: isLight ? '#f8f7ff' : '#1e1e2e',
              borderRadius: 2,
              '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                borderColor: '#7d72fc'
              }
            }
          }}
        />
      </ParamRow>

      {/* 负向提示词（仅支持时显示） */}
      {preset.supportsNegativePrompt && (
        <ParamRow label="负向提示词" description="排除不想要的内容" fullWidth>
          <TextField
            multiline
            minRows={2}
            maxRows={5}
            fullWidth
            size="small"
            placeholder="lowres, bad anatomy, blurry, ..."
            value={params.negativePrompt}
            onChange={(e) => update({ negativePrompt: e.target.value })}
            sx={{
              '& .MuiOutlinedInput-root': {
                fontSize: 13,
                bgcolor: isLight ? '#f8f7ff' : '#1e1e2e',
                borderRadius: 2,
                '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                  borderColor: '#7d72fc'
                }
              }
            }}
          />
        </ParamRow>
      )}

      {/* ─── 采样步数 ─── */}
      <ParamRow label="采样步数" description="更多步数 = 更细腻但更慢">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Slider
            min={1}
            max={150}
            value={params.steps}
            onChange={(_, v) => update({ steps: v as number })}
            sx={{
              flex: 1,
              color: '#7d72fc',
              '& .MuiSlider-thumb': {
                width: 16,
                height: 16,
                '&:hover': { boxShadow: '0 0 0 6px rgba(125, 114, 252, 0.15)' }
              }
            }}
          />
          <TextField
            type="number"
            size="small"
            value={params.steps}
            onChange={(e) => update({ steps: Math.max(1, Math.min(150, Number(e.target.value))) })}
            sx={{ width: 72, '& input': { textAlign: 'center', fontSize: 13 } }}
          />
        </Box>
      </ParamRow>

      {/* ─── CFG Scale ─── */}
      <ParamRow label="CFG Scale" description="提示词引导强度">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Slider
            min={0}
            max={30}
            step={0.5}
            value={params.cfgScale}
            onChange={(_, v) => update({ cfgScale: v as number })}
            sx={{
              flex: 1,
              color: '#7d72fc',
              '& .MuiSlider-thumb': {
                width: 16,
                height: 16,
                '&:hover': { boxShadow: '0 0 0 6px rgba(125, 114, 252, 0.15)' }
              }
            }}
          />
          <TextField
            type="number"
            size="small"
            value={params.cfgScale}
            onChange={(e) =>
              update({ cfgScale: Math.max(0, Math.min(30, Number(e.target.value))) })
            }
            inputProps={{ step: 0.5 }}
            sx={{ width: 72, '& input': { textAlign: 'center', fontSize: 13 } }}
          />
        </Box>
      </ParamRow>

      {/* ─── 图片尺寸 ─── */}
      <ParamRow label="图片尺寸" description="生成图片的宽 × 高">
        <Box>
          {/* 预设比例按钮 */}
          <Box sx={{ display: 'flex', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
            {SIZE_PRESETS.map((sp) => {
              const isActive = params.width === sp.w && params.height === sp.h
              return (
                <Chip
                  key={sp.label}
                  label={sp.label}
                  size="small"
                  onClick={() => update({ width: sp.w, height: sp.h })}
                  sx={{
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: 'pointer',
                    bgcolor: isActive ? '#7d72fc' : isLight ? '#eeedf6' : '#333',
                    color: isActive ? '#fff' : 'text.secondary',
                    '&:hover': {
                      bgcolor: isActive ? '#6b62e0' : isLight ? '#e0dff0' : '#444'
                    }
                  }}
                />
              )
            })}
          </Box>
          {/* 宽 × 高 输入 */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <TextField
              label="宽"
              type="number"
              size="small"
              value={params.width}
              onChange={(e) =>
                update({ width: Math.max(64, Math.min(4096, Math.round(Number(e.target.value)))) })
              }
              inputProps={{ step: 64 }}
              sx={{ width: 100, '& input': { fontSize: 13 } }}
            />
            <Typography sx={{ color: 'text.secondary', fontWeight: 600 }}>×</Typography>
            <TextField
              label="高"
              type="number"
              size="small"
              value={params.height}
              onChange={(e) =>
                update({
                  height: Math.max(64, Math.min(4096, Math.round(Number(e.target.value))))
                })
              }
              inputProps={{ step: 64 }}
              sx={{ width: 100, '& input': { fontSize: 13 } }}
            />
          </Box>
        </Box>
      </ParamRow>

      {/* ─── 采样器 ─── */}
      <ParamRow label="采样器" description="去噪采样算法">
        <Box sx={{ display: 'flex', gap: 2 }}>
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel sx={{ fontSize: 13 }}>Sampler</InputLabel>
            <Select
              value={params.sampler}
              label="Sampler"
              onChange={(e) => update({ sampler: e.target.value })}
              sx={{ fontSize: 13 }}
            >
              {preset.supportedSamplers.map((s) => (
                <MenuItem key={s} value={s} sx={{ fontSize: 13 }}>
                  {s}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel sx={{ fontSize: 13 }}>Scheduler</InputLabel>
            <Select
              value={params.scheduler}
              label="Scheduler"
              onChange={(e) => update({ scheduler: e.target.value })}
              sx={{ fontSize: 13 }}
            >
              {preset.supportedSchedulers.map((s) => (
                <MenuItem key={s} value={s} sx={{ fontSize: 13 }}>
                  {s}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
      </ParamRow>

      {/* ─── 随机种 ─── */}
      <ParamRow label="随机种" description="控制生成可复现性，-1 为随机">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TextField
            type="number"
            size="small"
            value={params.seed}
            onChange={(e) => update({ seed: Number(e.target.value) })}
            sx={{ width: 180, '& input': { fontSize: 13, fontFamily: 'monospace' } }}
          />
          <Tooltip title="随机种子" arrow>
            <IconButton
              size="small"
              onClick={() => dispatch(randomizeSeed())}
              sx={{
                color: '#7d72fc',
                bgcolor: 'rgba(125, 114, 252, 0.08)',
                '&:hover': { bgcolor: 'rgba(125, 114, 252, 0.15)' }
              }}
            >
              <CasinoIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title={params.seedLocked ? '解锁种子' : '锁定种子'} arrow>
            <IconButton
              size="small"
              onClick={() => update({ seedLocked: !params.seedLocked })}
              sx={{
                color: params.seedLocked ? '#e57373' : 'text.secondary',
                bgcolor: params.seedLocked ? 'rgba(229, 115, 115, 0.08)' : 'transparent',
                '&:hover': {
                  bgcolor: params.seedLocked ? 'rgba(229, 115, 115, 0.15)' : 'rgba(0,0,0,0.05)'
                }
              }}
            >
              {params.seedLocked ? (
                <LockIcon sx={{ fontSize: 18 }} />
              ) : (
                <LockOpenIcon sx={{ fontSize: 18 }} />
              )}
            </IconButton>
          </Tooltip>
        </Box>
      </ParamRow>

      {/* ─── 批次设置 ─── */}
      <ParamRow label="批次设置" description="每批图片数量和批次数">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <TextField
            label="批大小"
            type="number"
            size="small"
            value={params.batchSize}
            onChange={(e) =>
              update({ batchSize: Math.max(1, Math.min(16, Number(e.target.value))) })
            }
            sx={{ width: 90, '& input': { fontSize: 13 } }}
          />
          <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>×</Typography>
          <TextField
            label="批次数"
            type="number"
            size="small"
            value={params.batchCount}
            onChange={(e) =>
              update({ batchCount: Math.max(1, Math.min(100, Number(e.target.value))) })
            }
            sx={{ width: 90, '& input': { fontSize: 13 } }}
          />
          <Typography variant="body2" sx={{ color: 'text.disabled', fontSize: 12 }}>
            共 {params.batchSize * params.batchCount} 张
          </Typography>
        </Box>
      </ParamRow>

      {/* 底部空白 */}
      <Box sx={{ height: 40 }} />
    </Box>
  )
}

export default ParamsSettingPanel
