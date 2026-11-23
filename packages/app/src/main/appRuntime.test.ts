import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    commandLine: {
      appendSwitch: vi.fn()
    },
    isPackaged: false,
    on: vi.fn(),
    quit: vi.fn(),
    getPath: vi.fn((name: string) => `C:/${name}`)
  },
  BrowserWindow: vi.fn(),
  ipcMain: {
    on: vi.fn()
  },
  Menu: {
    setApplicationMenu: vi.fn()
  },
  net: {
    fetch: vi.fn()
  },
  protocol: {
    handle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn()
  },
  session: {
    defaultSession: {
      webRequest: {
        onBeforeRequest: vi.fn()
      }
    }
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  electronApp: {
    setAppUserModelId: vi.fn()
  }
}))

const {
  initializeLocalMediaAccessMock,
  resolveAuthorizedLocalMediaPathMock,
  setLocalMediaGrantExcludedFoldersMock,
  realPolicy
} = vi.hoisted(() => ({
  initializeLocalMediaAccessMock: vi.fn(),
  resolveAuthorizedLocalMediaPathMock: vi.fn(),
  setLocalMediaGrantExcludedFoldersMock: vi.fn(),
  // When set, the protocol runs the real policy on the in-memory filesystem.
  realPolicy: { enabled: false }
}))

vi.mock('./localMediaAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./localMediaAccess')>()
  return {
    ...actual,
    initializeLocalMediaAccess: initializeLocalMediaAccessMock,
    setLocalMediaGrantExcludedFolders: (folders: string[]) => {
      setLocalMediaGrantExcludedFoldersMock(folders)
      if (realPolicy.enabled) actual.setLocalMediaGrantExcludedFolders(folders)
    },
    // The protocol authorizes off main's event loop: only the async policy may be used.
    resolveAuthorizedLocalMediaPath: () => {
      throw new Error('the local-media protocol must not use the synchronous policy')
    },
    resolveAuthorizedLocalMediaPathAsync: () => {
      throw new Error('the local-media protocol must say why it refused a path')
    },
    // The canonical path the test chooses; refused when it gives none, unavailable on 'stall'.
    authorizeLocalMediaPathAsync: async (
      filePath: string,
      roots: Parameters<typeof actual.authorizeLocalMediaPathAsync>[1]
    ) => {
      if (realPolicy.enabled) return actual.authorizeLocalMediaPathAsync(filePath, roots)
      const canonicalPath = await resolveAuthorizedLocalMediaPathMock(filePath, roots)
      if (canonicalPath === 'stall') return new Promise(() => undefined)
      return canonicalPath ? { canonicalPath } : { canonicalPath: null, reason: 'refused' }
    }
  }
})

vi.mock('./config/userDataDirectory', () => ({
  getCurrentUserDataDirectoryState: () => ({
    projectRoot: 'C:/project',
    autoSaveRoot: 'C:/autosave'
  })
}))

vi.mock('./testWindowRuntime', () => ({
  getTestWindowPolicy: vi.fn()
}))

import { app, net, protocol } from 'electron'
import { flushReportBundleRegistry } from './reportBundles/reportBundleRegistry'
import { DEFAULT_IMPORT_SOURCE_GUARD } from './llmProxy/managedMediaStore'
import {
  authorizeScopedLocalMediaDirectory,
  clearScopedLocalMediaPathsForTest
} from './localMediaAccess'
import {
  initializeMainProcessRuntime,
  setupReadyAppRuntime,
  withLocalMediaCorsHeaders
} from './appRuntime'

describe('appRuntime local-media protocol helpers', () => {
  beforeEach(() => {
    delete process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK
    delete process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT
    delete process.env.MAGICPOT_TEST_ARTIFACT_ROOT
    initializeLocalMediaAccessMock.mockReset()
    resolveAuthorizedLocalMediaPathMock.mockReset()
    vi.mocked(protocol.handle).mockClear()
    vi.mocked(protocol.registerSchemesAsPrivileged).mockClear()
    vi.mocked(net.fetch).mockReset()
  })

  it('registers local-media as a CORS-enabled privileged scheme without bypassing CSP', () => {
    initializeMainProcessRuntime(() => null)

    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({
        scheme: 'local-media',
        privileges: expect.objectContaining({
          corsEnabled: true,
          secure: true,
          standard: true,
          supportFetchAPI: true,
          stream: true
        })
      })
    ])
    expect(
      (
        protocol.registerSchemesAsPrivileged as unknown as {
          mock: { calls: Array<Array<Array<{ privileges: Record<string, unknown> }>>> }
        }
      ).mock.calls[0][0][0].privileges.bypassCSP
    ).toBeUndefined()
  })

  it('loads durable local-media grants before registering the protocol handler', async () => {
    const order: string[] = []
    initializeLocalMediaAccessMock.mockImplementationOnce(() => order.push('grants'))
    vi.mocked(protocol.handle).mockImplementationOnce(() => {
      order.push('protocol')
    })

    await setupReadyAppRuntime()

    expect(initializeLocalMediaAccessMock).toHaveBeenCalledWith(
      expect.stringMatching(/userData[\\/]local-media-grants\.json$/)
    )
    expect(protocol.handle).toHaveBeenCalledWith('local-media', expect.any(Function))
    expect(order).toEqual(['grants', 'protocol'])
  })

  it('keeps the grants out of the app data folder: only its media folders are served there', async () => {
    setLocalMediaGrantExcludedFoldersMock.mockClear()
    await setupReadyAppRuntime()
    expect(setLocalMediaGrantExcludedFoldersMock).toHaveBeenCalledWith(['C:/userData'])
  })

  it('flushes the report-bundle registry when the app quits', async () => {
    vi.mocked(app.on).mockClear()
    await setupReadyAppRuntime()
    expect(app.on).toHaveBeenCalledWith('will-quit', flushReportBundleRegistry)
  })

  it('uses the shared scoped roots for protocol requests and excludes broad artifacts', async () => {
    const cacheRoot = path.join('C:/', 'shared-thumbnail-cache')
    const artifactRoot = path.join('C:/', 'artifacts')
    process.env.MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK = '1'
    process.env.MAGICPOT_REAL_BOARD_SHARED_THUMBNAIL_CACHE_ROOT = ` ${cacheRoot} `
    process.env.MAGICPOT_TEST_ARTIFACT_ROOT = artifactRoot

    await setupReadyAppRuntime()
    const handler = vi.mocked(protocol.handle).mock.calls.at(-1)?.[1] as (
      request: Request
    ) => Promise<Response>
    const response = await handler(new Request('local-media:///outside/image.webp'))

    expect(response.status).toBe(403)
    expect(resolveAuthorizedLocalMediaPathMock).toHaveBeenCalledWith('/outside/image.webp', [
      // The app's media folders, never the data folder that holds config.json.
      ...[
        '.chat_media',
        'project-canvas-thumbnail-cache',
        'qapp-input-images',
        '.report_bundles',
        'report-bundles'
      ].map((name) => path.win32.normalize(`C:/userData/${name}`)),
      { pinnedCanonicalPath: expect.stringContaining('magicpot-local-media') },
      path.win32.normalize('C:/project'),
      path.win32.normalize('C:/autosave'),
      path.win32.normalize(cacheRoot),
      path.win32.normalize(artifactRoot)
    ])
    expect(resolveAuthorizedLocalMediaPathMock.mock.calls[0][1]).toContain(
      path.win32.normalize(artifactRoot)
    )
  })

  it('preserves traversal guards before resolving protocol paths', async () => {
    await setupReadyAppRuntime()
    const handler = vi.mocked(protocol.handle).mock.calls.at(-1)?.[1] as (
      request: Request
    ) => Promise<Response>
    const response = await handler(new Request('local-media:///safe/%252e%252e/secret.webp'))

    expect(response.status).toBe(403)
    expect(resolveAuthorizedLocalMediaPathMock).not.toHaveBeenCalled()
  })

  it('authorizes and fetches literal percent-escape filenames separately from space filenames', async () => {
    resolveAuthorizedLocalMediaPathMock.mockImplementation((filePath: string) => filePath)
    vi.mocked(net.fetch).mockImplementation(async () => new Response('synthetic-image-bytes'))
    await setupReadyAppRuntime()
    const handler = vi.mocked(protocol.handle).mock.calls.at(-1)?.[1] as (
      request: Request
    ) => Promise<Response>

    const literalPercentResponse = await handler(
      new Request('local-media:///C:/images/image%2520one.png')
    )
    const actualSpaceResponse = await handler(
      new Request('local-media:///C:/images/image%20one.png')
    )

    expect(literalPercentResponse.status).toBe(200)
    expect(actualSpaceResponse.status).toBe(200)
    expect(resolveAuthorizedLocalMediaPathMock).toHaveBeenNthCalledWith(
      1,
      'C:/images/image%20one.png',
      expect.any(Array)
    )
    expect(resolveAuthorizedLocalMediaPathMock).toHaveBeenNthCalledWith(
      2,
      'C:/images/image one.png',
      expect.any(Array)
    )
    expect(net.fetch).toHaveBeenNthCalledWith(1, 'file:///C:/images/image%2520one.png')
    expect(net.fetch).toHaveBeenNthCalledWith(2, 'file:///C:/images/image%20one.png')
  })

  it('answers 503 at its deadline for a path that does not answer, and at once after that', async () => {
    vi.useFakeTimers()
    try {
      resolveAuthorizedLocalMediaPathMock.mockImplementation(() => 'stall')
      await setupReadyAppRuntime()
      const handler = vi.mocked(protocol.handle).mock.calls.at(-1)?.[1] as (
        request: Request
      ) => Promise<Response>

      const pending = handler(new Request('local-media:///Volumes/dead-share/photos/a.png'))
      await vi.advanceTimersByTimeAsync(DEFAULT_IMPORT_SOURCE_GUARD.operationTimeoutMs)
      expect((await pending).status).toBe(503)
      // The folder still has a call that never returned: its next images are refused at once,
      // without another filesystem call.
      resolveAuthorizedLocalMediaPathMock.mockClear()
      expect(
        (await handler(new Request('local-media:///Volumes/dead-share/photos/b.png'))).status
      ).toBe(503)
      expect(resolveAuthorizedLocalMediaPathMock).not.toHaveBeenCalled()
      expect(net.fetch).not.toHaveBeenCalled()

      // Another drive is not affected.
      resolveAuthorizedLocalMediaPathMock.mockImplementation((filePath: string) => filePath)
      vi.mocked(net.fetch).mockImplementation(async () => new Response('bytes'))
      expect((await handler(new Request('local-media:///C:/images/c.png'))).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serves the media folders of the app data folder, never its config, grants, skills or profile', async () => {
    // node:fs is the in-memory filesystem of the node test setup.
    const base = path.join(process.cwd(), '.magicpot-trash', 'app-runtime-media-roots')
    const userData = path.join(base, 'userData')
    const write = (relative: string) => {
      const file = path.join(userData, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'bytes')
      return file
    }
    const served = [
      '.chat_media/task/a.png',
      '.chat_media/derivatives/b.webp',
      'project-canvas-thumbnail-cache/c/256.webp',
      'qapp-input-images/d.png',
      '.report_bundles/bundle-1/images/e.png',
      'report-bundles/0123/manifest.json'
    ].map(write)
    const refused = [
      'config.json',
      'local-media-grants.json',
      'customSkills/cat/cat.skill.json',
      'customSkills/cat/notes.md',
      'Cookies',
      'Local Storage/leveldb/000003.log',
      'Preferences'
    ].map(write)
    const getPath = vi.mocked(app.getPath)
    getPath.mockImplementation((name: string) => path.join(base, name))
    realPolicy.enabled = true
    try {
      vi.mocked(net.fetch).mockImplementation(async () => new Response('bytes'))
      await setupReadyAppRuntime()
      const handler = vi.mocked(protocol.handle).mock.calls.at(-1)?.[1] as (
        request: Request
      ) => Promise<Response>
      const url = (file: string) => pathToFileURL(file).href.replace(/^file:/, 'local-media:')
      for (const file of served) expect((await handler(new Request(url(file)))).status).toBe(200)
      for (const file of refused) expect((await handler(new Request(url(file)))).status).toBe(403)
      // Not even when the user once granted a folder that holds the app's data.
      expect(authorizeScopedLocalMediaDirectory(base)).toBe(true)
      for (const file of refused) expect((await handler(new Request(url(file)))).status).toBe(403)
      expect((await handler(new Request(url(served[0])))).status).toBe(200)
      expect(net.fetch).toHaveBeenCalledTimes(served.length + 1)
    } finally {
      realPolicy.enabled = false
      getPath.mockImplementation((name: string) => `C:/${name}`)
      clearScopedLocalMediaPathsForTest()
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('reads a Windows path near MAX_PATH itself, since Chromium answers ERR_FILE_NOT_FOUND for it', async () => {
    // node:fs is the in-memory filesystem of the node test setup.
    const base = path.join(process.cwd(), '.magicpot-trash', 'app-runtime-long-path')
    const longFile = path.join(
      base,
      'Data',
      '.chat_media',
      'user-output',
      'a'.repeat(64),
      'originals',
      'c6',
      `${'c'.repeat(64)}.png`
    )
    fs.mkdirSync(path.dirname(longFile), { recursive: true })
    fs.writeFileSync(longFile, 'synthetic-png-bytes')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      resolveAuthorizedLocalMediaPathMock.mockImplementation(() => longFile)
      vi.mocked(net.fetch).mockImplementation(async () => new Response('short-path-bytes'))
      await setupReadyAppRuntime()
      const handler = vi.mocked(protocol.handle).mock.calls.at(-1)?.[1] as (
        request: Request
      ) => Promise<Response>

      const response = await handler(
        new Request('local-media:///C:/deep/original.png', { headers: { Origin: 'file://' } })
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('image/png')
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('file://')
      expect(await response.text()).toBe('synthetic-png-bytes')
      expect(net.fetch).not.toHaveBeenCalled()

      // A missing deep file is a plain 404, not the 500 a failed net.fetch turned into.
      fs.rmSync(longFile)
      expect((await handler(new Request('local-media:///C:/deep/original.png'))).status).toBe(404)

      // A short path still goes through Chromium.
      resolveAuthorizedLocalMediaPathMock.mockImplementation((filePath: string) => filePath)
      const short = await handler(new Request('local-media:///C:/images/a.png'))
      expect(await short.text()).toBe('short-path-bytes')
      expect(net.fetch).toHaveBeenCalledWith('file:///C:/images/a.png')
    } finally {
      Object.defineProperty(process, 'platform', platform)
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('adds CORS headers while preserving the proxied local file response metadata', async () => {
    const request = new Request('local-media:///C:/images/a.webp', {
      headers: { Origin: 'file://' }
    })
    const response = withLocalMediaCorsHeaders(
      new Response('image-bytes', {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'Content-Type': 'image/webp',
          'Content-Length': '11'
        }
      }),
      request
    )

    expect(response.status).toBe(206)
    expect(response.statusText).toBe('Partial Content')
    expect(response.headers.get('Content-Type')).toBe('image/webp')
    expect(response.headers.get('Content-Length')).toBe('11')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('file://')
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS')
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Range, Content-Type')
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin')
    expect(await response.text()).toBe('image-bytes')
  })

  it('does not reflect unrelated remote origins in local-media responses', () => {
    const request = new Request('local-media:///C:/images/a.webp', {
      headers: { Origin: 'https://example.com' }
    })

    const response = withLocalMediaCorsHeaders(new Response('image-bytes'), request)

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
