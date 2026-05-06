import * as fs from 'fs'

export type WindowState = {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized: boolean
}

type WindowStateSnapshot = Pick<WindowState, 'x' | 'y' | 'width' | 'height'>

type WindowStatePersistenceTarget = {
  getBounds(): WindowStateSnapshot
  isMaximized(): boolean
  on(event: 'resize' | 'move' | 'close', listener: () => void): unknown
}

const DEFAULT_WINDOW_WIDTH = 2564
const DEFAULT_WINDOW_HEIGHT = 1384

function createDefaultWindowState(): WindowState {
  return {
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    x: undefined,
    y: undefined,
    isMaximized: false
  }
}

export function readWindowState(statePath: string): { state: WindowState; hasSavedState: boolean } {
  const state = createDefaultWindowState()

  try {
    if (!fs.existsSync(statePath)) {
      return { state, hasSavedState: false }
    }

    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (parsed.width) state.width = parsed.width
    if (parsed.height) state.height = parsed.height
    if (parsed.x !== undefined) state.x = parsed.x
    if (parsed.y !== undefined) state.y = parsed.y
    if (typeof parsed.isMaximized === 'boolean') state.isMaximized = parsed.isMaximized

    return { state, hasSavedState: true }
  } catch {
    return { state, hasSavedState: false }
  }
}

export function writeWindowState(
  window: Pick<WindowStatePersistenceTarget, 'getBounds' | 'isMaximized'>,
  statePath: string
): void {
  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ ...window.getBounds(), isMaximized: window.isMaximized() })
    )
  } catch {
    // ignore write error
  }
}

export function attachWindowStatePersistence(
  window: WindowStatePersistenceTarget,
  statePath: string
): void {
  let saveTimer: NodeJS.Timeout | null = null

  const saveState = () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
    }
    saveTimer = setTimeout(() => {
      writeWindowState(window, statePath)
    }, 500)
  }

  window.on('resize', saveState)
  window.on('move', saveState)
  window.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
    }
    writeWindowState(window, statePath)
  })
}
