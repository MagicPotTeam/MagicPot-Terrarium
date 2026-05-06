import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as buildEnvMod from '../config/buildEnv'
import * as configMod from '../config/config'

vi.mock(import('../config/config'), () => ({
  getConfig: vi.fn()
}))

vi.mock(import('../config/buildEnv'), () => ({
  getBuildEnv: vi.fn()
}))

type WatchCallback = (eventType: string, filename: string | null) => void

type WatchRecord = {
  path: string
  callback: WatchCallback
  close: ReturnType<typeof vi.fn>
}

const { existsSyncMock, mkdirSyncMock, watchMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(() => true),
  mkdirSyncMock: vi.fn(),
  watchMock: vi.fn()
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    watch: watchMock
  }
})

function createWindowStub() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn()
    }
  }
}

describe('qApp watcher restart safety', () => {
  const watchRecords: WatchRecord[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    watchRecords.length = 0
    existsSyncMock.mockClear()
    existsSyncMock.mockReturnValue(true)
    mkdirSyncMock.mockClear()
    watchMock.mockReset()
    watchMock.mockImplementation(
      (watchPath: string, _options: unknown, callback: WatchCallback) => {
        const record: WatchRecord = {
          path: watchPath,
          callback,
          close: vi.fn()
        }
        watchRecords.push(record)
        return { close: record.close }
      }
    )

    vi.mocked(configMod.getConfig).mockReturnValue({} as never)
    vi.mocked(buildEnvMod.getBuildEnv).mockReturnValue({
      env: {
        build: 'development',
        platform: 'unknown',
        buildMode: 'pure',
        packageVersion: 'test'
      },
      pathMap: {
        data: '/data',
        file: '/file',
        resources: '/resources'
      },
      embeddedDefaults: {
        pythonCmd: '',
        comfyuiDir: '',
        comfyuiArgs: []
      }
    } as never)
  })

  afterEach(async () => {
    const mod = await import('./watcher')
    mod.stopQAppWatcher()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('closes the previous watcher before starting a replacement watcher', async () => {
    const mod = await import('./watcher')
    const firstWindow = createWindowStub()
    const secondWindow = createWindowStub()

    mod.startQAppWatcher(firstWindow as never)
    expect(watchRecords).toHaveLength(1)

    mod.startQAppWatcher(secondWindow as never)

    expect(watchRecords).toHaveLength(2)
    expect(watchRecords[0]?.close).toHaveBeenCalledTimes(1)
    expect(watchRecords[1]?.close).not.toHaveBeenCalled()
  })

  it('drops the old debounced callback and only notifies the replacement window', async () => {
    const mod = await import('./watcher')
    const firstWindow = createWindowStub()
    const secondWindow = createWindowStub()

    mod.startQAppWatcher(firstWindow as never)
    watchRecords[0]?.callback('change', 'first.qacfg.json')

    mod.startQAppWatcher(secondWindow as never)
    watchRecords[1]?.callback('change', 'second.qacfg.json')

    vi.advanceTimersByTime(500)

    expect(firstWindow.webContents.send).not.toHaveBeenCalled()
    expect(secondWindow.webContents.send).toHaveBeenCalledTimes(1)
    expect(secondWindow.webContents.send).toHaveBeenCalledWith('qapp:dir-changed')
  })
})
