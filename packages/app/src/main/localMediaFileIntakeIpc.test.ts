import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, authorizeMock, resolveMock, recordImportGrantMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  authorizeMock: vi.fn(),
  resolveMock: vi.fn(),
  recordImportGrantMock: vi.fn()
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
vi.mock('./localMediaTempRoot', () => ({
  getVerifiedLocalMediaTempRoot: (root: string) => `${root}-verified`
}))
vi.mock('./localMediaAccess', () => ({
  authorizeScopedLocalMediaPath: authorizeMock,
  localMediaImportGrantClock: () => 0,
  recordLocalMediaImportGrant: recordImportGrantMock,
  // The scoped-path check runs off main's event loop: only the async policy may be used.
  authorizeLocalMediaPathAsync: async (filePath: string, roots: unknown, options: unknown) => {
    const canonicalPath = await resolveMock(filePath, roots, options)
    return canonicalPath ? { canonicalPath } : { canonicalPath: null, reason: 'refused' }
  }
}))

import {
  registerLocalMediaFileIntakeIpc,
  resetLocalMediaFileIntakeIpcForTest
} from './localMediaFileIntakeIpc'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlerFor = (channel: string): any =>
  handleMock.mock.calls.find(([name]) => name === channel)?.[1]

/** The app's media folders, never its data folder itself. */
const userDataMediaRootMatchers = [
  '.chat_media',
  'project-canvas-thumbnail-cache',
  'qapp-input-images',
  '.report_bundles',
  'report-bundles'
].map((name) =>
  expect.stringMatching(new RegExp(`^C:[\\\\/]userData[\\\\/]${name.replace('.', '\\.')}$`))
)

describe('local media file intake IPC', () => {
  beforeEach(() => {
    resetLocalMediaFileIntakeIpcForTest()
    handleMock.mockReset()
    authorizeMock.mockReset()
    resolveMock.mockReset()
    recordImportGrantMock.mockReset()
    delete process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK
    delete process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT
    delete process.env.MAGICPOT_TEST_ARTIFACT_ROOT
  })

  it('registers async handlers before a window exists and trusts only the current main renderer', async () => {
    let mainWindow: any = null
    registerLocalMediaFileIntakeIpc(() => mainWindow)

    expect(handleMock.mock.calls.map(([channel]) => channel)).toEqual([
      'local-media:authorize-picker-path',
      'local-media:authorize-import-path',
      'local-media:resolve-scoped-path'
    ])

    const authorizeHandler = handlerFor('local-media:authorize-picker-path')
    const resolveHandler = handlerFor('local-media:resolve-scoped-path')
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
    await expect(resolveHandler({ sender: untrustedSender }, 'C:/picked/image.png')).resolves.toBe(
      ''
    )
    await expect(resolveHandler({ sender: trustedSender }, 'C:/picked/image.png')).resolves.toBe(
      'C:/picked/image.png'
    )
    await expect(resolveHandler({ sender: trustedSender }, 42)).resolves.toBe('')
    expect(resolveMock).toHaveBeenCalledTimes(1)
    expect(resolveMock).toHaveBeenCalledWith(
      'C:/picked/image.png',
      [
        ...userDataMediaRootMatchers,
        {
          pinnedCanonicalPath: expect.stringMatching(
            /C:[\\/]temp[\\/]magicpot-local-media-verified$/
          )
        },
        expect.stringMatching(/C:[\\/]project/),
        expect.stringMatching(/C:[\\/]autosave/)
      ],
      expect.anything()
    )
  })

  it('shares the benchmark cache and run-artifact scopes without broad roots', async () => {
    process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK = '1'
    process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT = 'C:/shared-thumbnail-cache'
    process.env.MAGICPOT_TEST_ARTIFACT_ROOT = 'C:/artifacts'
    const mainWindow: any = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false }
    }
    registerLocalMediaFileIntakeIpc(() => mainWindow)

    const resolveHandler = handlerFor('local-media:resolve-scoped-path')
    resolveMock.mockReturnValue('C:/shared-thumbnail-cache/image.webp')
    await expect(
      resolveHandler({ sender: mainWindow.webContents }, 'C:/shared-thumbnail-cache/image.webp')
    ).resolves.toBe('C:/shared-thumbnail-cache/image.webp')

    expect(resolveMock).toHaveBeenCalledWith(
      'C:/shared-thumbnail-cache/image.webp',
      [
        ...userDataMediaRootMatchers,
        {
          pinnedCanonicalPath: expect.stringMatching(
            /C:[\\/]temp[\\/]magicpot-local-media-verified$/
          )
        },
        expect.stringMatching(/C:[\\/]project/),
        expect.stringMatching(/C:[\\/]autosave/),
        expect.stringMatching(/C:[\\/]shared-thumbnail-cache/),
        expect.stringMatching(/C:[\\/]artifacts/)
      ],
      expect.anything()
    )
  })

  it.skipIf(process.platform === 'win32')(
    'grants an existing file to the current main renderer only, once per request',
    async () => {
      // node:fs is the in-memory filesystem of the node test setup.
      const { default: memoryFs } = await import('node:fs')
      memoryFs.mkdirSync('/picked', { recursive: true })
      memoryFs.writeFileSync('/picked/real.png', 'png')
      let mainWindow: any = null
      registerLocalMediaFileIntakeIpc(() => mainWindow)
      const importHandler = handlerFor('local-media:authorize-import-path')
      const trustedSender = { isDestroyed: () => false }
      mainWindow = { isDestroyed: () => false, webContents: trustedSender }

      // Another webContents (a child window, a webview) gets nothing for an existing file.
      await expect(
        importHandler({ sender: { isDestroyed: () => false } }, '/picked/real.png', 'image/png')
      ).resolves.toBeNull()
      expect(recordImportGrantMock).not.toHaveBeenCalled()
      // The main renderer gets the grant for the same file.
      await expect(
        importHandler({ sender: trustedSender }, '/picked/real.png', 'image/png')
      ).resolves.toEqual({ path: '/picked/real.png', sizeBytes: 3 })
      expect(recordImportGrantMock).toHaveBeenCalledExactlyOnceWith(
        '/picked/real.png',
        0,
        'import',
        {
          batch: undefined
        }
      )
      // A drop id from the preload goes with the grant; anything else is ignored.
      recordImportGrantMock.mockClear()
      await importHandler({ sender: trustedSender }, '/picked/real.png', 'image/png', 'drop-7-ab12')
      expect(recordImportGrantMock).toHaveBeenLastCalledWith('/picked/real.png', 0, 'import', {
        batch: 'drop-7-ab12'
      })
      for (const forged of ['../../etc', 'x'.repeat(65), 42, { id: 'drop' }]) {
        await importHandler({ sender: trustedSender }, '/picked/real.png', 'image/png', forged)
        expect(recordImportGrantMock).toHaveBeenLastCalledWith('/picked/real.png', 0, 'import', {
          batch: undefined
        })
      }
    }
  )

  it('records an import grant only for the current main renderer and never a persisted grant', async () => {
    let mainWindow: any = null
    registerLocalMediaFileIntakeIpc(() => mainWindow)
    const importHandler = handlerFor('local-media:authorize-import-path')
    const trustedSender = { isDestroyed: () => false }
    // A path that does not exist: the trust check comes before any filesystem access.
    const picked = process.platform === 'win32' ? 'C:\\nowhere\\a.png' : '/nowhere/a.png'

    await expect(importHandler({ sender: trustedSender }, picked, 'image/png')).resolves.toBeNull()
    mainWindow = { isDestroyed: () => false, webContents: trustedSender }
    await expect(
      importHandler({ sender: { isDestroyed: () => false } }, picked, 'image/png')
    ).resolves.toBeNull()
    // Trusted, but the file does not exist: nothing is recorded.
    await expect(importHandler({ sender: trustedSender }, picked, 'image/png')).resolves.toBeNull()
    expect(recordImportGrantMock).not.toHaveBeenCalled()
    expect(authorizeMock).not.toHaveBeenCalled()
  })
})
