// hy3d/ui.tsx — Small reusable UI components for the Hy3D panel
import React from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import { hyColors } from './theme'

export const PBR_MATERIAL_INFO =
  'PBR（Physically Based Rendering，基于物理的渲染）会生成更完整的材质贴图信息，如颜色、粗糙度、金属度等，在 Blender、Unity、Unreal 等支持 PBR 的软件里会有更真实的光照效果。'

/** Section label with optional badge + info icon */
export const SectionLabel: React.FC<{
  children: React.ReactNode
  badge?: string
  info?: boolean | string
  rightContent?: React.ReactNode
}> = ({ children, badge, info, rightContent }) => {
  const infoLabel = typeof children === 'string' ? `${children}说明` : '字段说明'
  const infoIcon = (
    <Box
      component="span"
      aria-label={infoLabel}
      tabIndex={0}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 15,
        height: 15,
        borderRadius: '50%',
        border: `1px solid ${hyColors.textSecondary}`,
        color: hyColors.textSecondary,
        fontSize: 10.5,
        cursor: 'help',
        flexShrink: 0
      }}
    >
      i
    </Box>
  )

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.9, mb: 1.15, mt: 2.7 }}>
      <Typography
        variant="body2"
        sx={{ fontWeight: 600, color: hyColors.textPrimary, fontSize: 14, letterSpacing: '0.2px' }}
      >
        {children}
      </Typography>
      {typeof info === 'string' ? (
        <Tooltip title={info} placement="top" arrow>
          {infoIcon}
        </Tooltip>
      ) : (
        info && infoIcon
      )}
      {badge && (
        <Box
          sx={{
            px: 0.8,
            py: 0.1,
            borderRadius: '8px',
            bgcolor: hyColors.badgeBg,
            fontSize: 10.5,
            fontWeight: 700,
            fontStyle: badge.toLowerCase() === 'new' ? 'italic' : 'normal',
            color: '#fff',
            lineHeight: 1.4,
            ml: 0.3
          }}
        >
          {badge}
        </Box>
      )}
      {rightContent && <Box sx={{ ml: 'auto' }}>{rightContent}</Box>}
    </Box>
  )
}

/** Top-level mode tabs: 文生图 / 图生多视图 */
export const TopTabs: React.FC<{
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}> = ({ options, value, onChange }) => (
  <Box
    sx={{
      display: 'flex',
      bgcolor: hyColors.softBgStrong,
      borderRadius: '12px',
      p: '4px',
      mb: 2.5,
      boxShadow: `inset 0 0 0 1px ${hyColors.softBorder}`
    }}
  >
    {options.map((opt) => {
      const sel = value === opt.value
      return (
        <Box
          key={opt.value}
          onClick={() => onChange(opt.value)}
          sx={{
            flex: 1,
            py: '8px',
            textAlign: 'center',
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: sel ? 600 : 400,
            color: sel ? hyColors.textPrimary : hyColors.textSecondary,
            bgcolor: sel ? hyColors.activeItemBg : 'transparent',
            borderRadius: '9px',
            boxShadow: sel
              ? `inset 0 0 0 1px ${hyColors.softBorder}, ${hyColors.activeShadow}`
              : 'none',
            transition: 'all 0.2s'
          }}
        >
          {opt.label}
        </Box>
      )
    })}
  </Box>
)

/** Segmented parameter selector */
export const ParamSegment: React.FC<{
  options: { value: string; label: string; badge?: string }[]
  value: string
  onChange: (v: string) => void
}> = ({ options, value, onChange }) => (
  <Box
    sx={{
      display: 'flex',
      bgcolor: hyColors.softBgStrong,
      borderRadius: '12px',
      p: '4px',
      alignItems: 'center',
      boxShadow: `inset 0 0 0 1px ${hyColors.softBorder}`
    }}
  >
    {options.map((opt) => {
      const sel = value === opt.value
      return (
        <Box
          key={opt.value}
          onClick={() => onChange(opt.value)}
          sx={{
            flex: 1,
            position: 'relative',
            py: '8px',
            textAlign: 'center',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: sel ? 600 : 400,
            color: sel ? hyColors.primary : hyColors.textSecondary,
            bgcolor: sel ? hyColors.activeItemBg : 'transparent',
            borderRadius: '8px',
            border: '1px solid',
            borderColor: sel ? hyColors.navActiveOutline : 'transparent',
            boxShadow: sel ? hyColors.activeShadow : 'none',
            transition: 'all 0.2s',
            '&:hover': { color: sel ? hyColors.primary : hyColors.textPrimary }
          }}
        >
          {opt.label}
          {opt.badge && (
            <Box
              sx={{
                position: 'absolute',
                top: -8,
                right: -2,
                px: '4px',
                py: '1px',
                borderRadius: '4px',
                bgcolor: hyColors.badgeBg,
                fontSize: 9.5,
                fontWeight: 600,
                color: '#fff',
                lineHeight: 1,
                zIndex: 1,
                transform: 'scale(0.9)',
                transformOrigin: 'bottom right'
              }}
            >
              {opt.badge}
            </Box>
          )}
        </Box>
      )
    })}
  </Box>
)

/** Tip banner shown at top of post-processing panels */
export const TipBanner: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 1,
      px: 1.6,
      py: 1.15,
      bgcolor: hyColors.tipBg,
      border: `1px solid ${hyColors.softBorder}`,
      borderRadius: '8px',
      mb: 2.1,
      flexShrink: 0
    }}
  >
    <Typography sx={{ fontSize: 12, color: hyColors.textSecondary, lineHeight: 1.55 }}>
      {children}
    </Typography>
  </Box>
)
