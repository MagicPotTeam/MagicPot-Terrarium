/* eslint-disable react-refresh/only-export-components */
// packages/app/src/renderer/src/pages/ProjectCanvasPage/components/ColorWheelSquarePicker.tsx
// 从 ProjectCanvasPage.tsx 中提取的颜色工具函数和拾色器组件

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Box } from '@mui/material'

// ─── 颜色工具函数 ───

export type HSVColor = {
  h: number
  s: number
  v: number
}

export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace('#', '')
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => char + char)
          .join('')
      : normalized.padEnd(6, '0').slice(0, 6)

  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  }
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (value: number) => Math.round(value).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export function rgbToHsv(r: number, g: number, b: number): HSVColor {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min

  let h = 0
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6
    else if (max === gn) h = (bn - rn) / delta + 2
    else h = (rn - gn) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }

  return {
    h,
    s: max === 0 ? 0 : delta / max,
    v: max
  }
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const hh = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = v - c

  let rn = 0
  let gn = 0
  let bn = 0

  if (hh < 60) [rn, gn, bn] = [c, x, 0]
  else if (hh < 120) [rn, gn, bn] = [x, c, 0]
  else if (hh < 180) [rn, gn, bn] = [0, c, x]
  else if (hh < 240) [rn, gn, bn] = [0, x, c]
  else if (hh < 300) [rn, gn, bn] = [x, 0, c]
  else [rn, gn, bn] = [c, 0, x]

  return {
    r: (rn + m) * 255,
    g: (gn + m) * 255,
    b: (bn + m) * 255
  }
}

export function colorToHsv(color: string, fallback = '#ef4444'): HSVColor {
  const source = color === 'transparent' ? fallback : color
  const { r, g, b } = hexToRgb(source)
  return rgbToHsv(r, g, b)
}

export function hsvToHex(h: number, s: number, v: number): string {
  const { r, g, b } = hsvToRgb(h, s, v)
  return rgbToHex(r, g, b)
}

export function isColorLight(hex: string): boolean {
  if (hex === 'transparent') return false
  const c = hex.replace('#', '')
  if (c.length < 6) return false
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 128
}

// ─── ColorWheelSquarePicker 组件 ───

export const ColorWheelSquarePicker: React.FC<{
  color: string
  onChange: (color: string) => void
  size?: number
}> = ({ color, onChange, size = 220 }) => {
  const [localColor, setLocalColor] = useState(color)
  const pickerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setLocalColor(color)
  }, [color])

  const hsv = useMemo(() => colorToHsv(localColor), [localColor])
  const ringThickness = 20
  const center = size / 2
  const outerRadius = size / 2
  const innerRadius = outerRadius - ringThickness
  const squareSize = Math.round(innerRadius * Math.sqrt(2) - 12)
  const squareLeft = center - squareSize / 2
  const squareTop = center - squareSize / 2
  const dragModeRef = useRef<'wheel' | 'square' | null>(null)

  const updateWheel = useCallback(
    (clientX: number, clientY: number, rect: DOMRect) => {
      const x = clientX - rect.left - center
      const y = clientY - rect.top - center
      const angle = (Math.atan2(y, x) * 180) / Math.PI
      const hex = hsvToHex((angle + 360) % 360, hsv.s, hsv.v)
      setLocalColor(hex)
      React.startTransition(() => {
        onChange(hex)
      })
    },
    [center, hsv.s, hsv.v, onChange]
  )

  const updateSquare = useCallback(
    (clientX: number, clientY: number, rect: DOMRect) => {
      const x = clamp01((clientX - rect.left - squareLeft) / squareSize)
      const y = clamp01((clientY - rect.top - squareTop) / squareSize)
      const hex = hsvToHex(hsv.h, x, 1 - y)
      setLocalColor(hex)
      React.startTransition(() => {
        onChange(hex)
      })
    },
    [hsv.h, onChange, squareLeft, squareSize, squareTop]
  )

  const startDrag = useCallback(
    (mode: 'wheel' | 'square', event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragModeRef.current = mode
      const rect =
        pickerRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect()
      if (mode === 'wheel') updateWheel(event.clientX, event.clientY, rect)
      else updateSquare(event.clientX, event.clientY, rect)

      const move = (moveEvent: PointerEvent) => {
        if (!dragModeRef.current) return
        if (dragModeRef.current === 'wheel') updateWheel(moveEvent.clientX, moveEvent.clientY, rect)
        else updateSquare(moveEvent.clientX, moveEvent.clientY, rect)
      }

      const stop = () => {
        dragModeRef.current = null
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
    },
    [updateSquare, updateWheel]
  )

  const squareCursorLeft = squareLeft + hsv.s * squareSize
  const squareCursorTop = squareTop + (1 - hsv.v) * squareSize
  const wheelRadians = (hsv.h * Math.PI) / 180
  const wheelCursorLeft = center + Math.cos(wheelRadians) * ((outerRadius + innerRadius) / 2)
  const wheelCursorTop = center + Math.sin(wheelRadians) * ((outerRadius + innerRadius) / 2)

  return (
    <Box
      ref={pickerRef}
      sx={{ width: size, height: size, position: 'relative', userSelect: 'none' }}
    >
      <Box
        onPointerDown={(event: React.PointerEvent<HTMLDivElement>) => startDrag('wheel', event)}
        sx={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          background:
            'conic-gradient(#ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
          cursor: 'crosshair'
        }}
      />
      <Box
        sx={(theme) => ({
          position: 'absolute',
          inset: ringThickness,
          borderRadius: '50%',
          backgroundColor: theme.palette.mode === 'dark' ? '#4a4a4a' : '#d7d7d7'
        })}
      />
      <Box
        onPointerDown={(event: React.PointerEvent<HTMLDivElement>) => startDrag('square', event)}
        sx={{
          position: 'absolute',
          left: squareLeft,
          top: squareTop,
          width: squareSize,
          height: squareSize,
          backgroundColor: hsvToHex(hsv.h, 1, 1),
          backgroundImage:
            'linear-gradient(to top, black, transparent), linear-gradient(to right, white, transparent)',
          cursor: 'crosshair'
        }}
      />
      <Box
        sx={{
          position: 'absolute',
          left: wheelCursorLeft - 6,
          top: wheelCursorTop - 6,
          width: 12,
          height: 12,
          borderRadius: '50%',
          border: '2px solid white',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.45)'
        }}
      />
      <Box
        sx={{
          position: 'absolute',
          left: squareCursorLeft - 6,
          top: squareCursorTop - 6,
          width: 12,
          height: 12,
          borderRadius: '50%',
          border: '2px solid white',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.45)'
        }}
      />
    </Box>
  )
}
