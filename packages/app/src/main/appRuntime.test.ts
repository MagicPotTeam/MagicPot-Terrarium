import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    commandLine: {
      appendSwitch: vi.fn()
    },
    isPackaged: false,
    on: vi.fn(),
    quit: vi.fn()
  },
  BrowserWindow: vi.fn(),
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
  it('registers local-media as a CORS-enabled privileged scheme', () => {
    initializeMainProcessRuntime(() => null)

    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({
        scheme: 'local-media',
        privileges: expect.objectContaining({
          corsEnabled: true,
          secure: true,
          standard: true,
          supportFetchAPI: true
        })
      })
    ])
  })

  it('adds CORS headers while preserving the proxied local file response metadata', async () => {
    const response = withLocalMediaCorsHeaders(
      new Response('image-bytes', {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'Content-Type': 'image/webp',
          'Content-Length': '11'
        }
      })
    )

    expect(response.status).toBe(206)
    expect(response.statusText).toBe('Partial Content')
    expect(response.headers.get('Content-Type')).toBe('image/webp')
    expect(response.headers.get('Content-Length')).toBe('11')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS')
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Range, Content-Type')
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin')
    expect(await response.text()).toBe('image-bytes')
  })
})
