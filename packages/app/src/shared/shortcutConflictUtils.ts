const SHORTCUT_MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift'] as const

const MODIFIER_ALIASES: Record<string, (typeof SHORTCUT_MODIFIER_ORDER)[number]> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  command: 'Ctrl',
  commandorcontrol: 'Ctrl',
  meta: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift'
}

const KEY_ALIASES: Record<string, string> = {
  '`': '`',
  backquote: '`',
  backtick: '`',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  delete: 'Delete',
  backspace: 'Backspace',
  enter: 'Enter',
  tab: 'Tab'
}

const STATIC_RESERVED_CANVAS_SHORTCUTS = [
  'Ctrl+S',
  'Ctrl+Shift+S',
  'Ctrl+E',
  'Ctrl+Shift+E',
  'Ctrl+Alt+I',
  'Ctrl+Shift+I',
  'Ctrl+Z',
  'Ctrl+Shift+Z',
  'Ctrl+Y',
  'Ctrl+A',
  'Ctrl+C',
  'Ctrl+V'
]

export const DEFAULT_SCREENSHOT_SHORTCUT = '`'

function normalizeShortcutPart(part: string): string {
  const trimmed = part.trim()
  if (!trimmed) return ''

  const lowered = trimmed.toLowerCase()
  if (MODIFIER_ALIASES[lowered]) {
    return MODIFIER_ALIASES[lowered]
  }

  if (KEY_ALIASES[lowered]) {
    return KEY_ALIASES[lowered]
  }

  if (trimmed.length === 1) {
    return trimmed.toUpperCase()
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

export function normalizeShortcutForComparison(shortcut: string): string {
  if (!shortcut) return ''

  const modifiers = new Set<(typeof SHORTCUT_MODIFIER_ORDER)[number]>()
  let key = ''

  for (const rawPart of shortcut.split('+')) {
    const normalizedPart = normalizeShortcutPart(rawPart)
    if (!normalizedPart) continue

    if (
      SHORTCUT_MODIFIER_ORDER.includes(normalizedPart as (typeof SHORTCUT_MODIFIER_ORDER)[number])
    ) {
      modifiers.add(normalizedPart as (typeof SHORTCUT_MODIFIER_ORDER)[number])
      continue
    }

    key = normalizedPart
  }

  return [...SHORTCUT_MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key]
    .filter(Boolean)
    .join('+')
}

export function toDisplayShortcut(accelerator: string): string {
  return normalizeShortcutForComparison(accelerator)
}

export function toElectronAccelerator(shortcut: string): string {
  return shortcut
    .split('+')
    .map((part) => {
      const normalizedPart = normalizeShortcutPart(part)
      return normalizedPart === 'Ctrl' ? 'CommandOrControl' : normalizedPart
    })
    .filter(Boolean)
    .join('+')
}

export function buildReservedCanvasShortcuts(
  toolShortcuts?: Record<string, string> | null
): string[] {
  const seen = new Set<string>()
  const shortcuts = [...STATIC_RESERVED_CANVAS_SHORTCUTS, ...Object.values(toolShortcuts ?? {})]
  const normalizedShortcuts: string[] = []

  for (const shortcut of shortcuts) {
    const normalized = normalizeShortcutForComparison(shortcut)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    normalizedShortcuts.push(normalized)
  }

  return normalizedShortcuts
}

export function conflictsWithCanvasShortcut(
  shortcut: string,
  toolShortcuts?: Record<string, string> | null
): boolean {
  const normalizedShortcut = normalizeShortcutForComparison(shortcut)
  if (!normalizedShortcut) return false
  return buildReservedCanvasShortcuts(toolShortcuts).includes(normalizedShortcut)
}
