import { useEffect } from 'react'

import {
  DEFAULT_SCREENSHOT_SHORTCUT,
  buildReservedCanvasShortcuts,
  conflictsWithCanvasShortcut,
  toDisplayShortcut,
  toElectronAccelerator
} from '@shared/shortcutConflictUtils'

type ScreenshotShortcutInvoke = (
  channel: 'screenshot:getShortcut' | 'screenshot:setShortcut',
  ...args: unknown[]
) => Promise<unknown>

export type UseCanvasScreenshotShortcutSyncOptions = {
  toolShortcuts: Record<string, string>
  setCurrentShortcut: (shortcut: string) => void
  notifyWarning: (message: string) => void
  notifyError: (message: string) => void
  invoke?: ScreenshotShortcutInvoke
}

function getDefaultScreenshotShortcutInvoke(): ScreenshotShortcutInvoke | undefined {
  return window.electron?.ipcRenderer?.invoke as ScreenshotShortcutInvoke | undefined
}

export function useCanvasScreenshotShortcutSync({
  toolShortcuts,
  setCurrentShortcut,
  notifyWarning,
  notifyError,
  invoke = getDefaultScreenshotShortcutInvoke()
}: UseCanvasScreenshotShortcutSyncOptions) {
  useEffect(() => {
    if (!invoke) return
    let cancelled = false

    void (async () => {
      try {
        const result = (await invoke('screenshot:getShortcut')) as
          | { shortcut?: unknown }
          | undefined
        const activeShortcut = toDisplayShortcut(
          typeof result?.shortcut === 'string' ? result.shortcut : DEFAULT_SCREENSHOT_SHORTCUT
        )

        if (cancelled) return

        setCurrentShortcut(activeShortcut || DEFAULT_SCREENSHOT_SHORTCUT)

        if (!conflictsWithCanvasShortcut(activeShortcut, toolShortcuts)) {
          return
        }

        const resetResult = (await invoke(
          'screenshot:setShortcut',
          toElectronAccelerator(DEFAULT_SCREENSHOT_SHORTCUT),
          buildReservedCanvasShortcuts(toolShortcuts)
        )) as { success?: unknown; error?: unknown } | undefined

        if (cancelled) return

        if (resetResult?.success) {
          setCurrentShortcut(DEFAULT_SCREENSHOT_SHORTCUT)
          notifyWarning(
            `Screenshot shortcut ${activeShortcut} conflicts with a canvas shortcut; restored to ${DEFAULT_SCREENSHOT_SHORTCUT}.`
          )
          return
        }

        notifyError(
          typeof resetResult?.error === 'string'
            ? resetResult.error
            : 'Screenshot shortcut conflicts with a canvas shortcut, and automatic reset failed.'
        )
      } catch (error) {
        console.error('[Canvas] Failed to sync screenshot shortcut.', error)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [invoke, notifyError, notifyWarning, setCurrentShortcut, toolShortcuts])
}
