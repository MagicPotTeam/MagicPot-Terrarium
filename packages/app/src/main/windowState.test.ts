import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from './testSupport/nodeTestArtifacts'
import { attachWindowStatePersistence, readWindowState } from './windowState'

describe('windowState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('falls back to the default state when the state file is missing', async () => {
    const tempDir = await createNodeTestArtifactDir('window-state')
    const statePath = `${tempDir}/window-state.json`

    expect(readWindowState(statePath)).toEqual({
      state: {
        width: 2564,
        height: 1384,
        x: undefined,
        y: undefined,
        isMaximized: false
      },
      hasSavedState: false
    })
  })

  it('debounces resize and move events before writing the latest window state', async () => {
    const tempDir = await createNodeTestArtifactDir('window-state')
    const statePath = `${tempDir}/window-state.json`
    const listeners = new Map<string, () => void>()
    const windowStub = {
      getBounds: vi.fn(() => ({ x: 10, y: 20, width: 800, height: 600 })),
      isMaximized: vi.fn(() => false),
      on: vi.fn((event: 'resize' | 'move' | 'close', listener: () => void) => {
        listeners.set(event, listener)
      })
    }

    attachWindowStatePersistence(windowStub, statePath)
    listeners.get('resize')?.()
    listeners.get('move')?.()

    expect(fs.existsSync(statePath)).toBe(false)

    await vi.advanceTimersByTimeAsync(500)

    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      isMaximized: false
    })
  })
})
