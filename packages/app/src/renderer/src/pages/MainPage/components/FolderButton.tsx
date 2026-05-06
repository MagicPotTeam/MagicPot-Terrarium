// packages/app/src/renderer/src/pages/MainPage/components/FolderButton.tsx
import React, { useState } from 'react'
import { Box, Card, CardContent, Typography } from '@mui/material'
import { useMessage } from '@renderer/hooks/useMessage'
import { MESSAGE_COMFYUI_DIR_NOT_SET } from '@shared/config/messageConst'

// 底图
import purpleHu from '@renderer/assets/hu.png'
import whiteHu from '@renderer/assets/whitehu.png'

// 叠加箭头图
import arrowPng from '@renderer/assets/arror.png'
import arrow2Png from '@renderer/assets/arror2.png'
import { api } from '@renderer/utils/windowUtils'
import { useTranslation } from 'react-i18next'

export interface FolderButtonProps {
  label: string
  icon: React.ReactNode // 保留兼容，不使用
  color: string // 保留兼容，不使用
  folderPath: string
}

const PURPLE_MAIN = '#7f73fd'
const PURPLE_LIGHT = '#9f96ff'

// ===== 你要调的参数（位置/尺寸/微缩放） =====
const ARROW_POS_DEFAULT = { right: 13, bottom: 6 }
const ARROW_POS_HOVER = { right: 11, bottom: 13 }
const ARROW_SIZE_DEFAULT = 25
const ARROW_SIZE_HOVER = 25
const HU_SCALE_DEFAULT = 1.3
const HU_SCALE_HOVER = 1.3
// =======================================

// 英文副标题映射（仅用于中文主标题时给出英文释义）
const subtitleMap: Record<string, string> = {
  工作流: 'Workflow',
  模型: 'Checkpoints',
  lora: 'Lora Model',
  controlnet: 'ControlNet Model',
  vae: 'Vae Model',
  输出文件夹: 'Image Output'
}
const getSubTitle = (label: string) => subtitleMap[label] ?? subtitleMap[label.toLowerCase()] ?? ''

// 右 + 下 3D 阴影
const SIDE_SHADOW_LIGHT = '8px 0 16px rgba(0,0,0,0.08), 0 8px 16px rgba(0,0,0,0.12)'
const SIDE_SHADOW_DARK = '8px 0 14px rgba(0,0,0,0.45), 0 8px 18px rgba(0,0,0,0.55)'

const FolderButton: React.FC<FolderButtonProps> = ({ label, icon: _i, color: _c, folderPath }) => {
  const { notifyError } = useMessage()
  const [hovered, setHovered] = useState(false)
  const { i18n } = useTranslation()

  // 仅在中文语言环境下显示副标题；英文环境下不渲染，保持整齐
  const subtitle = getSubTitle(label)
  const showSubtitle = i18n.language === 'zh-CN' && !!subtitle

  return (
    <Card
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      sx={(t) => ({
        position: 'relative',
        height: 150,
        cursor: 'pointer',
        borderRadius: 3,
        overflow: 'hidden',

        background: hovered
          ? `linear-gradient(135deg, ${PURPLE_MAIN} 0%, ${PURPLE_LIGHT} 100%)`
          : t.palette.background.paper,
        color: hovered ? '#fff' : t.palette.text.primary,
        border: hovered ? '1px solid transparent' : `1px solid ${t.palette.divider}`,

        boxShadow: hovered
          ? 'none'
          : t.palette.mode === 'dark'
            ? SIDE_SHADOW_DARK
            : SIDE_SHADOW_LIGHT,

        transition:
          'transform .2s ease, box-shadow .2s ease, background .2s ease, color .2s ease, border-color .2s ease',
        '&:hover': { transform: 'translateY(-6px)' }
      })}
      onClick={() => {
        if (folderPath === '') {
          notifyError(MESSAGE_COMFYUI_DIR_NOT_SET)
          return
        }
        api().svcShell.openPath(folderPath)
      }}
    >
      <CardContent
        sx={{
          position: 'relative',
          zIndex: 1,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'flex-start',
          gap: 0.25,
          p: 2,
          pb: 5 // 右下角叠加区留空间
        }}
      >
        <Typography
          variant="subtitle1"
          sx={{
            fontWeight: 800,
            fontSize: 18,
            lineHeight: 1.15,
            mb: 0.25,
            maxWidth: '100%',
            whiteSpace: 'nowrap',
            wordBreak: 'keep-all',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: 'inherit'
          }}
          title={label}
        >
          {label}
        </Typography>

        {showSubtitle && (
          <Typography
            variant="body2"
            sx={(t) => ({
              fontSize: 12.5,
              opacity: hovered ? 0.95 : 0.7,
              color: hovered ? '#fff' : t.palette.text.secondary,
              maxWidth: '100%',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            })}
            title={subtitle}
          >
            {subtitle}
          </Typography>
        )}
      </CardContent>

      {/* 右下水印容器：底图 + 叠加箭头图 */}
      <Box
        sx={{
          position: 'absolute',
          zIndex: 0,
          right: 0,
          bottom: 0,
          width: 56,
          height: 56,
          pointerEvents: 'none',
          userSelect: 'none'
        }}
      >
        {/* 底图（hover 用紫色，默认用白色） */}
        <Box
          component="img"
          src={hovered ? purpleHu : whiteHu}
          alt=""
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            filter: hovered ? 'none' : 'drop-shadow(0 0 2px rgba(0,0,0,0.08))',
            opacity: hovered ? 0.3 : 0.95,
            transform: `scale(${hovered ? HU_SCALE_HOVER : HU_SCALE_DEFAULT})`,
            transformOrigin: 'right bottom',
            transition: 'transform 120ms ease, opacity 120ms ease, filter 120ms ease'
          }}
        />

        {/* 叠加箭头（统一尺寸；可选缩放） */}
        <Box
          component="img"
          src={hovered ? arrow2Png : arrowPng}
          alt=""
          aria-hidden
          sx={{
            position: 'absolute',
            right: hovered ? ARROW_POS_HOVER.right : ARROW_POS_DEFAULT.right,
            bottom: hovered ? ARROW_POS_HOVER.bottom : ARROW_POS_DEFAULT.bottom,
            width: hovered ? ARROW_SIZE_HOVER : ARROW_SIZE_DEFAULT,
            height: 'auto',
            objectFit: 'contain',
            transformOrigin: 'right bottom',
            opacity: 0.9,
            transition: 'transform 120ms ease, opacity 120ms ease'
          }}
        />
      </Box>
    </Card>
  )
}

export default FolderButton
