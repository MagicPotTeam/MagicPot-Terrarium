import React, { useState } from 'react'
import { Box, ButtonBase, Typography } from '@mui/material'
import { useSidebarCollapse } from './SidebarCollapseContext'

const LOGO_SIZE = 55
const sidebarLogoImg = new URL('../../../../../runtime-assets/build/icon.png', import.meta.url).href
// 提取橙色常量
const ORANGE_COLOR = '#dd653f'
const BLUE_COLOR = '#313386'

const SidebarHeader: React.FC = () => {
  const { collapsed, toggle } = useSidebarCollapse()
  const [isHovered, setIsHovered] = useState(false)

  // 定义通用的文字样式，保持统一
  const textStyle = {
    fontWeight: 600,
    fontSize: 25,
    transform: 'translateY(-3px)',
    transition: 'opacity 0.3s ease-in-out', // 增加过渡时间让 fade 更柔和
    whiteSpace: 'nowrap'
  } as const

  const showAltText = isHovered && !collapsed

  return (
    <Box
      sx={{
        px: 1,
        pb: 2,
        display: 'flex',
        alignItems: 'flex-end',
        position: 'relative',
        overflow: 'visible'
      }}
    >
      <ButtonBase
        onClick={toggle}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        disableRipple
        sx={{
          WebkitAppRegion: 'no-drag',
          borderRadius: 2,
          position: 'relative',
          top: 0,
          overflow: 'visible',
          p: 0,
          // 增加一个 z-index 确保 hover 时 logo 在最上层
          zIndex: 2
        }}
      >
        <Box
          component="img"
          src={sidebarLogoImg}
          alt="Magic Pot"
          sx={{
            width: LOGO_SIZE,
            height: LOGO_SIZE,
            borderRadius: 2,
            objectFit: 'contain',
            display: 'block',
            transition: 'transform 180ms ease, filter 180ms ease, opacity 180ms ease',
            '&:hover': { transform: 'translateY(-1px)' }
          }}
        />
      </ButtonBase>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 0.8,
          lineHeight: 1.1,
          whiteSpace: 'nowrap',
          overflow: 'visible',
          // 这里的 transition 负责折叠时的宽度变化
          transition: 'opacity 200ms ease, max-width 200ms ease, margin 200ms ease',
          maxWidth: collapsed ? 0 : 240,
          opacity: collapsed ? 0 : 1,
          ml: collapsed ? 0 : 0.5,
          position: 'relative' // 确保子元素的绝对定位相对于这里
        }}
      >
        {/* ★★★ 核心修改：使用两个重叠的 Typography 实现 Fade 效果 ★★★ */}
        <Box sx={{ position: 'relative', display: 'inline-block', minWidth: '50px' }}>
          {/* 1. 默认状态文字：“魔壶” */}
          <Typography
            variant="h6"
            sx={{
              ...textStyle,
              color: BLUE_COLOR,
              opacity: showAltText ? 0 : 1 // hover 时透明度变 0
            }}
          >
            魔壶
          </Typography>

          {/* 2. Hover 状态文字：“收起” */}
          <Typography
            variant="h6"
            sx={{
              ...textStyle,
              color: ORANGE_COLOR, // 设置为橙色
              position: 'absolute', // 绝对定位，覆盖在“魔壶”上面
              left: 0,
              top: 0,
              opacity: showAltText ? 1 : 0 // hover 时透明度变 1
            }}
          >
            收起
          </Typography>
        </Box>

        <Typography
          component="span"
          sx={{
            fontWeight: 500,
            fontSize: 18,
            color: BLUE_COLOR,
            position: 'relative',
            top: '-1px'
          }}
        >
          Magic
        </Typography>
        <Typography
          component="span"
          sx={{
            fontWeight: 500,
            fontSize: 18,
            color: ORANGE_COLOR,
            position: 'relative',
            top: '-1px'
          }}
        >
          Pot.
        </Typography>
      </Box>
    </Box>
  )
}

export default SidebarHeader
