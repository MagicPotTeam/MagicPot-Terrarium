import { EventEmitter } from 'node:events'
import { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMainWindow } from './mainWindow'
import {
  registerMagicAgentTrustedRouteBinding,
  unregisterMagicAgentTrustedRouteBinding
} from './magicAgentRuntime/trustedRouteBinding'

const { bindings } = vi.hoisted(() => ({ bindings: new Map<number, unknown>() }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock-user-data'), isPackaged: false },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  nativeImage: {},
  screen: {},
  shell: {}
}))
vi.mock('../../../runtime-assets/resources/icon.png?asset', () => ({ default: 'mock-icon' }))
vi.mock('./config/buildEnv', () => ({ isDev: () => false }))
vi.mock('./testUiPolicy', () => ({ resolveTestArtifactPath: vi.fn() }))
vi.mock('./testWindowRuntime', () => ({
  getTestWindowPolicy: () => ({ noFocus: false, suppressTaskbar: false, hideWindow: false }),
  resolveConfiguredTestWindowPlacement: () => null,
  showWindowForTestPolicy: vi.fn()
}))
vi.mock('./rendererDiagnostics', () => ({ attachRendererDiagnostics: vi.fn() }))
vi.mock('./winControls', () => ({ winController: { registerWindow: vi.fn() } }))
vi.mock('./windowState', () => ({
  attachWindowStatePersistence: vi.fn(),
  readWindowState: () => ({
    state: { width: 800, height: 600, x: 0, y: 0, isMaximized: false },
    hasSavedState: false
  })
}))
vi.mock('./utils/externalUrl', () => ({ normalizeAllowedExternalUrl: vi.fn() }))
vi.mock('./utils/rendererNavigation', () => ({ isTrustedRendererNavigation: vi.fn() }))
vi.mock('./localMediaAccess', () => ({ authorizeScopedLocalMediaPath: vi.fn() }))
vi.mock('./magicAgentRuntime/trustedRouteBinding', () => ({
  registerMagicAgentTrustedRouteBinding: vi.fn(
    (senderId: number, _route: unknown, options: unknown) => bindings.set(senderId, options)
  ),
  unregisterMagicAgentTrustedRouteBinding: vi.fn((senderId: number) => bindings.delete(senderId))
}))

let nextSenderId = 100

class FakeWebContents extends EventEmitter {
  destroyed = false
  private readonly senderId = nextSenderId++
  readonly setWindowOpenHandler = vi.fn()

  get id(): number {
    if (this.destroyed) throw new Error('WebContents has been destroyed')
    return this.senderId
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  readonly contents = new FakeWebContents()
  readonly loadURL = vi.fn<(url: string) => void>()

  get webContents(): FakeWebContents {
    if (this.destroyed) throw new Error('BrowserWindow has been destroyed')
    return this.contents
  }
}

describe('createMainWindow teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bindings.clear()
    vi.mocked(BrowserWindow).mockImplementation(function () {
      return new FakeWindow() as unknown as BrowserWindow
    })
  })

  it.each([true, false])(
    'unregisters the original sender after destruction (window destroyed: %s)',
    (destroyWindow) => {
      const onCreated = vi.fn()
      const window = createMainWindow(onCreated) as unknown as FakeWindow
      const otherWindow = createMainWindow() as unknown as FakeWindow
      const contents = window.webContents
      const senderId = contents.id
      const otherSenderId = otherWindow.webContents.id

      expect(onCreated).toHaveBeenCalledExactlyOnceWith(window)
      expect(registerMagicAgentTrustedRouteBinding).toHaveBeenCalledTimes(2)
      expect(registerMagicAgentTrustedRouteBinding).toHaveBeenCalledWith(senderId, undefined, {
        trustedUrl: window.loadURL.mock.calls[0][0],
        trustedWebContents: contents
      })
      expect(bindings.has(senderId)).toBe(true)
      expect(bindings.has(otherSenderId)).toBe(true)

      window.destroyed = destroyWindow
      contents.destroyed = true
      expect(() => contents.id).toThrow('WebContents has been destroyed')
      if (destroyWindow) {
        expect(() => window.webContents).toThrow('BrowserWindow has been destroyed')
      }

      expect(() => window.emit('closed')).not.toThrow()
      expect(unregisterMagicAgentTrustedRouteBinding).toHaveBeenCalledExactlyOnceWith(senderId)
      expect(bindings.has(senderId)).toBe(false)
      expect(bindings.has(otherSenderId)).toBe(true)
    }
  )
})
