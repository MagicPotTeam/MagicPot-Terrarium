// packages/app/src/renderer/src/pages/MainPage/components/SlideShow.tsx
import { Box, Paper, SxProps, Theme } from '@mui/material'
import React, { useState, useEffect, useRef, useCallback } from 'react'
import './SlideShow.css'

export type SlideShowProps = {
  images: string[]
  alt?: string
  interval: number
  slideDirection?: 'left' | 'right'
  sx?: SxProps<Theme>
  children?: React.ReactNode
}

const ANIM_MS = 450

// 与快速访问按钮一致方向的 3D 阴影
const SIDE_SHADOW_LIGHT = '8px 0 16px rgba(0,0,0,0.30), 0 8px 16px rgba(0,0,0,0.30)'
const SIDE_SHADOW_DARK = '8px 0 14px rgba(0,0,0,0.45), 0 8px 18px rgba(0,0,0,0.55)'

const SlideShow = ({
  images,
  interval,
  alt,
  sx,
  children,
  slideDirection = 'left'
}: SlideShowProps) => {
  const [currentImageIndex, setCurrentImageIndex] = useState(0)
  const [nextImageIndex, setNextImageIndex] = useState(1)
  const [isAnimating, setIsAnimating] = useState(false)
  const [animDirection, setAnimDirection] = useState<'left' | 'right'>(slideDirection)

  const timerRef = useRef<number | null>(null)

  const showNextSlide = useCallback(() => {
    if (isAnimating || images.length === 0) return
    setIsAnimating(true)
    setAnimDirection('left')
    const nextIndex = (currentImageIndex + 1) % images.length
    setNextImageIndex(nextIndex)
    setTimeout(() => {
      setCurrentImageIndex(nextIndex)
      setIsAnimating(false)
    }, ANIM_MS)
  }, [currentImageIndex, images, isAnimating])

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const startTimer = useCallback(() => {
    stopTimer()
    timerRef.current = window.setInterval(() => {
      showNextSlide()
    }, interval)
  }, [interval, showNextSlide, stopTimer])

  useEffect(() => {
    startTimer()
    return stopTimer
  }, [startTimer, stopTimer, images])

  const goToSlide = (targetIndex: number) => {
    if (isAnimating || targetIndex === currentImageIndex || images.length === 0) return
    const total = images.length
    const forwardSteps = (targetIndex - currentImageIndex + total) % total
    const backwardSteps = (currentImageIndex - targetIndex + total) % total
    const dir: 'left' | 'right' = forwardSteps <= backwardSteps ? 'left' : 'right'
    setIsAnimating(true)
    setAnimDirection(dir)
    setNextImageIndex(targetIndex)
    startTimer()
    setTimeout(() => {
      setCurrentImageIndex(targetIndex)
      setIsAnimating(false)
    }, ANIM_MS)
  }

  // 基础样式：把阴影/裁切放在 Paper 自己上，去掉边框
  const baseSx: SxProps<Theme> = (t) => ({
    position: 'relative',
    overflow: 'hidden', // 防止圆角处出现任何缝隙
    boxShadow: t.palette.mode === 'dark' ? SIDE_SHADOW_DARK : SIDE_SHADOW_LIGHT,
    border: 'none', // ← 去掉那圈白色 outline
    outline: 'none',
    backgroundImage: 'none', // 保守起见禁用任何默认背景纹理
    borderRadius: 2, // 你在 MainPage 也有传，合并后以更具体者为准
    backgroundColor: 'transparent' // 避免动画瞬间露出白底
  })
  const mergedSx: SxProps<Theme> = Array.isArray(sx)
    ? [baseSx, ...sx]
    : sx
      ? [baseSx, sx]
      : [baseSx]

  return (
    <Paper sx={mergedSx}>
      {/* 当前图片 */}
      <Box
        component="img"
        src={images[currentImageIndex]}
        alt={alt}
        sx={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: 1,
          position: 'absolute',
          top: 0,
          left: 0,
          transform: isAnimating
            ? animDirection === 'left'
              ? 'translateX(-100%)'
              : 'translateX(100%)'
            : 'translateX(0)',
          transition: isAnimating ? `transform ${ANIM_MS}ms ease-in-out` : 'none',
          willChange: 'transform' // 减少动画中出现的细微缝隙
        }}
      />

      {/* 下一张（动画时显示） */}
      {isAnimating && (
        <Box
          component="img"
          src={images[nextImageIndex]}
          alt={alt}
          sx={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: 1,
            position: 'absolute',
            top: 0,
            left: 0,
            transform: animDirection === 'left' ? 'translateX(100%)' : 'translateX(-100%)',
            animation:
              animDirection === 'left'
                ? `slideInFromRight ${ANIM_MS}ms ease-in-out forwards`
                : `slideInFromLeft ${ANIM_MS}ms ease-in-out forwards`,
            willChange: 'transform'
          }}
        />
      )}

      {/* 覆盖层（浅色透明，深色加轻遮罩；左对齐垂直居中） */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          background: (theme) =>
            theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.30)' : 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          pl: { xs: 2, sm: 4, md: 6 },
          pr: { xs: 2, sm: 4, md: 6 },
          zIndex: 1,
          textAlign: 'left'
        }}
      >
        {children}
      </Box>

      {/* 右下角小圆点 */}
      {images.length > 1 && (
        <Box
          sx={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            display: 'flex',
            gap: 1,
            zIndex: 2
          }}
          role="tablist"
          aria-label="选择幻灯片"
        >
          {images.map((_, i) => {
            const active = i === currentImageIndex
            return (
              <Box
                key={i}
                component="button"
                onClick={() => goToSlide(i)}
                disabled={isAnimating}
                aria-label={`第 ${i + 1} 张`}
                aria-current={active ? 'true' : undefined}
                title={`第 ${i + 1} 张`}
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  border: 'none',
                  backgroundColor: active ? '#dd5e35' : 'rgba(255,255,255,0.45)',
                  cursor: 'pointer',
                  p: 0,
                  m: 0,
                  appearance: 'none',
                  outline: 'none',
                  transition: 'transform 120ms ease, background-color 120ms ease',
                  '&:hover': {
                    transform: 'scale(1.1)',
                    backgroundColor: active ? '#dd5e35' : 'rgba(255,255,255,0.75)'
                  }
                }}
              />
            )
          })}
        </Box>
      )}
    </Paper>
  )
}

export default SlideShow
