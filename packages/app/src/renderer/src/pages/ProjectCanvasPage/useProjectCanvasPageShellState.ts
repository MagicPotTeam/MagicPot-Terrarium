import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import {
  STORAGE_KEY_SELECTED_PROFILE,
  getBaseProfileId,
  scopedStorageKey
} from '../ChatPage/chatPageShared'
import { resolveActiveAgentProfileId, resolveActiveAgentScope } from './canvasPageLocalStateUtils'
import type { CanvasGroup } from './types'
import { useCanvasPageShellState } from './useCanvasPageShellState'
import { useCanvasShortcutSettings } from './useCanvasShortcutSettings'

const SHOW_GRID_STORAGE_PREFIX = 'canvas.showGrid.'

type UseProjectCanvasPageShellStateOptions = {
  canvasId: string
  defaultCanvasBgColor: string
  language?: string | null
  themeMode: 'light' | 'dark'
  setGroups: Dispatch<SetStateAction<CanvasGroup[]>>
  defaultShowGrid?: boolean
}

function readLocalStorageValue(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocalStorageValue(key: string, value: string | null) {
  try {
    if (value == null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // Ignore local storage write failures and keep the in-memory state.
  }
}

function readBooleanStorageValue(key: string, fallback: boolean): boolean {
  const storedValue = readLocalStorageValue(key)
  if (storedValue == null) return fallback
  return storedValue !== 'false'
}

export function useProjectCanvasPageShellState({
  canvasId,
  defaultCanvasBgColor,
  language,
  themeMode,
  setGroups,
  defaultShowGrid = true
}: UseProjectCanvasPageShellStateOptions) {
  const shellAppearance = useCanvasPageShellState({
    canvasId,
    defaultCanvasBgColor,
    language,
    themeMode,
    setGroups
  })
  const shortcutSettings = useCanvasShortcutSettings()

  const showGridStorageKey = `${SHOW_GRID_STORAGE_PREFIX}${canvasId}`
  const [showGrid, setShowGridState] = useState<boolean>(() =>
    readBooleanStorageValue(showGridStorageKey, defaultShowGrid)
  )

  const setShowGrid = useCallback(
    (value: SetStateAction<boolean>) => {
      setShowGridState((current) => {
        const nextValue = typeof value === 'function' ? value(current) : value
        writeLocalStorageValue(showGridStorageKey, nextValue ? 'true' : 'false')
        return nextValue
      })
    },
    [showGridStorageKey]
  )

  const toggleShowGrid = useCallback(() => {
    setShowGrid((current) => !current)
  }, [setShowGrid])

  const getScopedSelectedProfileStorageKey = useCallback(
    (scope?: string) =>
      scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, scope || resolveActiveAgentScope(canvasId)),
    [canvasId]
  )

  const readSelectedProfileId = useCallback(
    (scope?: string) => {
      const storageKey = getScopedSelectedProfileStorageKey(scope)
      return getBaseProfileId(readLocalStorageValue(storageKey))
    },
    [getScopedSelectedProfileStorageKey]
  )

  const writeSelectedProfileId = useCallback(
    (profileId: string | null, scope?: string) => {
      const storageKey = getScopedSelectedProfileStorageKey(scope)
      writeLocalStorageValue(storageKey, profileId)
    },
    [getScopedSelectedProfileStorageKey]
  )

  const shellLocalState = useMemo(
    () => ({
      showGrid,
      setShowGrid,
      toggleShowGrid,
      resolveDefaultProfileId: () => resolveActiveAgentProfileId(canvasId),
      resolveActiveProfileScope: (scope?: string) => scope || resolveActiveAgentScope(canvasId),
      readSelectedProfileId,
      writeSelectedProfileId
    }),
    [canvasId, readSelectedProfileId, setShowGrid, showGrid, toggleShowGrid, writeSelectedProfileId]
  )

  return {
    ...shellAppearance,
    ...shortcutSettings,
    ...shellLocalState
  }
}
