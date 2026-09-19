import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, authorizeMock, resolveMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  authorizeMock: vi.fn(),
  resolveMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => `C:/${name}`) },
  ipcMain: { handle: handleMock }
}))
vi.mock('./config/userDataDirectory', () => ({
  getCurrentUserDataDirectoryState: () => ({
    projectRoot: 'C:/project',
    autoSaveRoot: 'C:/autosave'
  })
}))
vi.mock('./localMediaAccess', () => ({
  authorizeScopedLocalMediaPath: authorizeMock,
  resolveAuthorizedLocalMediaPath: resolveMock
}))

import {
  registerLocalMediaFileIntakeIpc,
  resetLocalMediaFileIntakeIpcForTest
} from './localMediaFileIntakeIpc'

describe('local media file intake IPC', () => {
  beforeEach(() => {
    resetLocalMediaFileIntakeIpcForTest()
    handleMock.mockReset()
    authorizeMock.mockReset()
    resolveMock.mockReset()
    delete process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK
    delete process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT
    delete process.env.MAGICPOT_TEST_ARTIFACT_ROOT
  })

  it('registers async handlers before a window exists and trusts only the current main renderer', () => {
    let mainWindow: any = null
    registerLocalMediaFileIntakeIpc(() => mainWindow)

    expect(handleMock.mock.calls.map(([channel]) => channel)).toEqual([
      'local-media:authorize-picker-path',
      'local-media:resolve-scoped-path'
    ])

    const authorizeHandler = handleMock.mock.calls[0]?.[1]
    const resolveHandler = handleMock.mock.calls[1]?.[1]
    const trustedSender = { isDestroyed: () => false }
    const untrustedSender = { isDestroyed: () => false }
    authorizeMock.mockReturnValue(true)
    resolveMock.mockReturnValue('C:/picked/image.png')

    expect(authorizeHandler({ sender: trustedSender }, 'C:/picked/image.png')).toBe(false)
    expect(authorizeMock).not.toHaveBeenCalled()

    mainWindow = {
      isDestroyed: () => false,
      webContents: trustedSender
    }
    expect(authorizeHandler({ sender: untrustedSender }, 'C:/picked/image.png')).toBe(false)
    expect(authorizeHandler({ sender: trustedSender }, 'C:/picked/image.png')).toBe(true)
    expect(resolveHandler({ sender: untrustedSender }, 'C:/picked/image.png')).toBe('')
    expect(resolveHandler({ sender: trustedSender }, 'C:/picked/image.png')).toBe(
      'C:/picked/image.png'
    )
    expect(resolveMock).toHaveBeenCalledWith('C:/picked/image.png', [
      expect.stringMatching(/C:[\\/]userData/),
      expect.stringMatching(/C:[\\/]temp[\\/]magicpot-local-media/),
      expect.stringMatching(/C:[\\/]project/),
      expect.stringMatching(/C:[\\/]autosave/)
    ])
  })

  it('shares the benchmark cache-only scope and never grants broad artifacts', () => {
    process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK = '1'
    process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT = 'C:/shared-thumbnail-cache'
    process.env.MAGICPOT_TEST_ARTIFACT_ROOT = 'C:/artifacts'
    const mainWindow: any = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false }
    }
    registerLocalMediaFileIntakeIpc(() => mainWindow)

    const resolveHandler = handleMock.mock.calls[1]?.[1]
    resolveMock.mockReturnValue('C:/shared-thumbnail-cache/image.webp')
    expect(
      resolveHandler({ sender: mainWindow.webContents }, 'C:/shared-thumbnail-cache/image.webp')
    ).toBe('C:/shared-thumbnail-cache/image.webp')

    expect(resolveMock).toHaveBeenCalledWith('C:/shared-thumbnail-cache/image.webp', [
      expect.stringMatching(/C:[\\/]userData/),
      expect.stringMatching(/C:[\\/]temp[\\/]magicpot-local-media/),
      expect.stringMatching(/C:[\\/]project/),
      expect.stringMatching(/C:[\\/]autosave/),
      expect.stringMatching(/C:[\\/]shared-thumbnail-cache/)
    ])
    expect(resolveMock.mock.calls[0][1]).not.toContain(expect.stringMatching(/artifacts/))
  })
})
