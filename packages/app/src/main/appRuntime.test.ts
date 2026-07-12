import { describe, expect, it, vi } from 'vitest'

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

vi.mock('./testWindowRuntime', () => ({
  getTestWindowPolicy: vi.fn()
}))

import { protocol } from 'electron'
import { initializeMainProcessRuntime, withLocalMediaCorsHeaders } from './appRuntime'

describe('appRuntime local-media protocol helpers', () => {
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
