import path from 'node:path'
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

const { initializeLocalMediaAccessMock, resolveAuthorizedLocalMediaPathMock } = vi.hoisted(() => ({
  initializeLocalMediaAccessMock: vi.fn(),
  resolveAuthorizedLocalMediaPathMock: vi.fn()
}))

vi.mock('./localMediaAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./localMediaAccess')>()
  return {
    ...actual,
    initializeLocalMediaAccess: initializeLocalMediaAccessMock,
    resolveAuthorizedLocalMediaPath: resolveAuthorizedLocalMediaPathMock
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

import { protocol } from 'electron'
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
      path.resolve('C:/userData'),
      path.resolve('C:/temp/magicpot-local-media'),
      path.resolve('C:/project'),
      path.resolve('C:/autosave'),
      path.resolve(cacheRoot),
      path.resolve(artifactRoot)
    ])
    expect(resolveAuthorizedLocalMediaPathMock.mock.calls[0][1]).toContain(
      path.resolve(artifactRoot)
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
