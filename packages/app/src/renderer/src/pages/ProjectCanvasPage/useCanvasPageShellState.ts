import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { isColorLight } from './components/ColorWheelSquarePicker'
import {
  buildNormalizedDefaultGroupName,
  shouldRepairNormalizedDefaultGroupName
} from './canvasPageLocalStateUtils'
import type { CanvasGroup } from './types'

type UseCanvasPageShellStateOptions = {
  canvasId: string
  defaultCanvasBgColor: string
  language?: string | null
  themeMode: 'light' | 'dark'
  setGroups: Dispatch<SetStateAction<CanvasGroup[]>>
}

export function useCanvasPageShellState({
  canvasId,
  defaultCanvasBgColor,
  language,
  themeMode,
  setGroups
}: UseCanvasPageShellStateOptions) {
  useEffect(() => {
    setGroups((prev) => {
      let fallbackIndex = prev.reduce(
        (maxValue, group) => Math.max(maxValue, group.defaultIndex ?? 0),
        0
      )
      let changed = false
      const next = prev.map((group) => {
        if (!shouldRepairNormalizedDefaultGroupName(group.name)) {
          return group
        }
        changed = true
        const repairedIndex = group.defaultIndex ?? ++fallbackIndex
        return {
          ...group,
          defaultIndex: repairedIndex,
          name: buildNormalizedDefaultGroupName(repairedIndex, language)
        }
      })
      return changed ? next : prev
    })
  }, [language, setGroups])

  const transparentPattern = useMemo(
    () =>
      themeMode === 'light'
        ? 'repeating-conic-gradient(#f7f8fc 0% 25%, #e8edf5 0% 50%)'
        : 'repeating-conic-gradient(#2a2a2a 0% 25%, #1a1a1a 0% 50%)',
    [themeMode]
  )

  const bgStorageKey = `canvas.bgColor.${canvasId}`
  const [bgColor, setBgColor] = useState<string>(() => {
    return localStorage.getItem(bgStorageKey) || defaultCanvasBgColor
  })
  const [bgColorPickerAnchor, setBgColorPickerAnchor] = useState<HTMLElement | null>(null)
  const [bgCustomColor, setBgCustomColor] = useState<string>(defaultCanvasBgColor)

  const handleBgColorChange = (color: string) => {
    setBgColor(color)
    localStorage.setItem(bgStorageKey, color)
  }

  useEffect(() => {
    const storedBgColor = localStorage.getItem(bgStorageKey)
    if (storedBgColor) {
      setBgColor((current) => (current === storedBgColor ? current : storedBgColor))
      return
    }

    setBgColor((current) => (current === defaultCanvasBgColor ? current : defaultCanvasBgColor))
    setBgCustomColor((current) =>
      current === defaultCanvasBgColor ? current : defaultCanvasBgColor
    )
  }, [bgStorageKey, defaultCanvasBgColor])

  const gridColor = useMemo(() => {
    if (bgColor === 'transparent') {
      return themeMode === 'light' ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.07)'
    }
    return isColorLight(bgColor) ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.07)'
  }, [bgColor, themeMode])

  return {
    bgColor,
    bgColorPickerAnchor,
    bgCustomColor,
    gridColor,
    handleBgColorChange,
    setBgColor,
    setBgColorPickerAnchor,
    setBgCustomColor,
    transparentPattern
  }
}
