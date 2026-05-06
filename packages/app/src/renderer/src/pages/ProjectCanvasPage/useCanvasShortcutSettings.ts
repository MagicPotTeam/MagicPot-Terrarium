import { useCallback, useState } from 'react'

const SHORTCUT_DEFAULTS: Record<string, string> = {
  select: 'V',
  hand: 'Space',
  rect: 'U',
  arrow: '-',
  freedraw: 'B',
  text: 'T',
  export: 'Ctrl+S'
}

export function useCanvasShortcutSettings() {
  const [shortcutDialogOpen, setShortcutDialogOpen] = useState(false)
  const [recordedShortcut, setRecordedShortcut] = useState('')
  const [currentShortcut, setCurrentShortcut] = useState('`')
  const [toolShortcuts, setToolShortcuts] = useState<Record<string, string>>(() => {
    const saved: Record<string, string> = {}
    for (const key of Object.keys(SHORTCUT_DEFAULTS)) {
      const storageKey = `canvas.shortcut.${key}`
      const storedValue = localStorage.getItem(storageKey)
      if (key === 'freedraw' && (!storedValue || storedValue === 'R')) {
        saved[key] = SHORTCUT_DEFAULTS[key]
        localStorage.setItem(storageKey, SHORTCUT_DEFAULTS[key])
        continue
      }
      saved[key] = storedValue || SHORTCUT_DEFAULTS[key]
    }
    return saved
  })
  const [toolShortcutCtxMenu, setToolShortcutCtxMenu] = useState<{
    x: number
    y: number
    toolKey: string
  } | null>(null)
  const [toolShortcutRecorded, setToolShortcutRecorded] = useState('')

  const updateToolShortcut = useCallback((toolKey: string, combo: string) => {
    setToolShortcuts((prev) => ({ ...prev, [toolKey]: combo }))
    localStorage.setItem(`canvas.shortcut.${toolKey}`, combo)
  }, [])

  return {
    currentShortcut,
    recordedShortcut,
    shortcutDialogOpen,
    toolShortcutCtxMenu,
    toolShortcutRecorded,
    toolShortcuts,
    setCurrentShortcut,
    setRecordedShortcut,
    setShortcutDialogOpen,
    setToolShortcutCtxMenu,
    setToolShortcutRecorded,
    updateToolShortcut
  }
}
