import { EventEmitter } from 'node:events'
import { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  createMainWindow,
  MAIN_WINDOW_BACKGROUND_COLOR,
  MAIN_WINDOW_FIXED_WEB_CONTENTS_LISTENERS,
  MAIN_WINDOW_RUNNING_REQUEST_LISTENERS,
  MAIN_WINDOW_WEB_CONTENTS_MAX_LISTENERS
} from './mainWindow'
import { getAuthoritativeMainWindow, winController } from './winControls'
import { installStartupStorageReadBinding } from './storageMetadata/startupStorageReadBinding'
import { installInstalledCatalogReadBinding } from './magicAgentRuntime/installedCatalogReadBinding'
import {
  registerMagicAgentTrustedRouteBinding,
  unregisterMagicAgentTrustedRouteBinding
} from './magicAgentRuntime/trustedRouteBinding'

const { bindings, catalogInstall, catalogDisposers, storageInstall, storageDisposers, registered } = vi.hoisted(() => ({
  bindings: new Map<number, unknown>(), catalogInstall: vi.fn(), catalogDisposers: new Map<object, ReturnType<typeof vi.fn>>(), storageInstall: vi.fn(), storageDisposers: new Map<object, ReturnType<typeof vi.fn>>(), registered: { window: null as unknown }
}))

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
vi.mock('./winControls', () => {
  const controller = { registerWindow: vi.fn((window: unknown) => { registered.window = window }), getMainWindow: vi.fn(() => registered.window as BrowserWindow | null) }
  return { winController: controller, getAuthoritativeMainWindow: () => controller.getMainWindow() }
})
vi.mock('./storageMetadata/startupStorageReadBinding', () => ({ installStartupStorageReadBinding: storageInstall }))
vi.mock('./magicAgentRuntime/installedCatalogReadBinding', () => ({ installInstalledCatalogReadBinding: catalogInstall }))
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
    bindings.clear(); catalogDisposers.clear(); storageDisposers.clear(); registered.window = null
    catalogInstall.mockReset(); catalogInstall.mockImplementation((window: object) => { const dispose = vi.fn(); catalogDisposers.set(window, dispose); return dispose })
    storageInstall.mockReset(); storageInstall.mockImplementation((window: object) => { const dispose = vi.fn(); storageDisposers.set(window, dispose); return dispose })
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
      expect(catalogDisposers.get(window)).toHaveBeenCalledOnce()
      expect(catalogDisposers.get(otherWindow)).not.toHaveBeenCalled()
    }
  )
  it('raises the listener limit of its WebContents before anything subscribes to it', async () => {
    const limitsAtInstall: number[] = []
    storageInstall.mockImplementation((window: FakeWindow) => { limitsAtInstall.push(window.webContents.getMaxListeners()); return vi.fn() })
    const window = createMainWindow() as unknown as FakeWindow
    expect(MAIN_WINDOW_WEB_CONTENTS_MAX_LISTENERS).toBeGreaterThan(10)
    expect(window.webContents.getMaxListeners()).toBe(MAIN_WINDOW_WEB_CONTENTS_MAX_LISTENERS)
    expect(limitsAtInstall).toEqual([MAIN_WINDOW_WEB_CONTENTS_MAX_LISTENERS])
    // Updated: the limit no longer counts one listener per retained Agent background process. All
    // interaction leases of a WebContents share one dispatcher (agentThreadInteractions.test.ts pins
    // that 200 leases hold one listener of each event), so what grows is only the running requests.
    // What the running app can hold by design does not warn: at most 13 listeners of one event
    // measured in the real app (within the fixed allowance) plus one per running request.
    expect(MAIN_WINDOW_FIXED_WEB_CONTENTS_LISTENERS).toBeGreaterThanOrEqual(13)
    expect(MAIN_WINDOW_WEB_CONTENTS_MAX_LISTENERS).toBe(
      MAIN_WINDOW_FIXED_WEB_CONTENTS_LISTENERS + MAIN_WINDOW_RUNNING_REQUEST_LISTENERS
    )
    const byDesign = MAIN_WINDOW_FIXED_WEB_CONTENTS_LISTENERS + MAIN_WINDOW_RUNNING_REQUEST_LISTENERS
    const warnings: Error[] = []
    const onWarning = (warning: Error) => warnings.push(warning)
    process.on('warning', onWarning)
    try {
      // The fixed allowance includes what createMainWindow already added.
      const already = window.webContents.listenerCount('render-process-gone')
      for (let index = already; index < byDesign; index += 1) window.webContents.on('render-process-gone', () => undefined)
      // Node emits the warning on a later tick.
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('warning', onWarning)
    }
    expect(warnings.filter((warning) => warning.name === 'MaxListenersExceededWarning')).toEqual([])
    // One more (a leak) warns.
    process.on('warning', onWarning)
    try {
      window.webContents.on('render-process-gone', () => undefined)
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('warning', onWarning)
    }
    expect(warnings.filter((warning) => warning.name === 'MaxListenersExceededWarning')).toHaveLength(1)
  })

  it('paints the dark theme background, never white, while no page is shown', async () => {
    createMainWindow()
    const options = vi.mocked(BrowserWindow).mock.calls[0]?.[0]
    expect(options?.backgroundColor).toBe(MAIN_WINDOW_BACKGROUND_COLOR)
    expect(MAIN_WINDOW_BACKGROUND_COLOR.toUpperCase()).not.toBe('#FFFFFF')
    // Keep the window colour in step with the renderer's dark theme background.
    // node:fs is an in-memory volume in this suite: read the real file.
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
    const themeSource = readFileSync(join(__dirname, '../renderer/src/theme.ts'), 'utf8')
    const darkBackground = /dark:\s*\{\s*palette:\s*\{[\s\S]*?background:\s*\{\s*default:\s*'([^']+)'/.exec(themeSource)?.[1]
    expect(darkBackground).toBe(MAIN_WINDOW_BACKGROUND_COLOR)
  })
  it('installs the exact independent binding before onCreated navigation, registration and first built-in load', () => {
    const callback = vi.fn((window: BrowserWindow) => {
      expect(installInstalledCatalogReadBinding).toHaveBeenCalledOnce()
      expect(catalogInstall.mock.calls[0]?.[0]).toBe(window)
      expect(winController.registerWindow).not.toHaveBeenCalled()
      window.loadURL('file:///callback-initiated-navigation.html')
    })
    const window = createMainWindow(callback) as unknown as FakeWindow
    expect(catalogInstall.mock.calls[0]?.[1]).toBe(window.loadURL.mock.calls[1]?.[0])
    const senderId = window.webContents.id
    expect(registerMagicAgentTrustedRouteBinding).toHaveBeenCalledWith(senderId, undefined, { trustedUrl: catalogInstall.mock.calls[0]?.[1], trustedWebContents: window.webContents })
    expect(catalogInstall.mock.invocationCallOrder[0]).toBeLessThan(callback.mock.invocationCallOrder[0]!)
    expect(callback.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(winController.registerWindow).mock.invocationCallOrder[0]!)
    expect(catalogInstall.mock.invocationCallOrder[0]).toBeLessThan(window.loadURL.mock.invocationCallOrder[0]!)
  })
  it('passes a live authoritative controller getter, not a captured result or callback-provided substitute', () => {
    const first = createMainWindow() as unknown as FakeWindow
    const getter = catalogInstall.mock.calls[0]?.[2]
    expect(getter).toBeTypeOf('function'); expect(getter()).toBe(first)
    const second = createMainWindow() as unknown as FakeWindow
    expect(getter()).toBe(second); registered.window = null; expect(getter()).toBeNull()
    first.destroyed = true; first.contents.destroyed = true
    expect(() => first.emit('closed')).not.toThrow()
    expect(catalogDisposers.get(first)).toHaveBeenCalledOnce(); expect(catalogDisposers.get(second)).not.toHaveBeenCalled()
  })
  it.each(['callback', 'register', 'load'] as const)('disposes the exact installed binding on synchronous %s failure and rethrows the original error', kind => {
    const error = new Error('original setup failure'), window = new FakeWindow()
    vi.mocked(BrowserWindow).mockImplementationOnce(function () { return window as unknown as BrowserWindow })
    if (kind === 'register') vi.mocked(winController.registerWindow).mockImplementationOnce(() => { throw error })
    if (kind === 'load') window.loadURL.mockImplementationOnce(() => { throw error })
    expect(() => createMainWindow(kind === 'callback' ? () => { throw error } : undefined)).toThrow(error)
    expect(catalogInstall).toHaveBeenCalledOnce(); expect(catalogDisposers.get(window)).toHaveBeenCalledOnce()
  })
  it('installs storage independently BEFORE onCreated with the shared getter FUNCTION identity and no eager getter call', () => {
    const callback = vi.fn((window: BrowserWindow) => {
      expect(installStartupStorageReadBinding).toHaveBeenCalledOnce()
      expect(storageInstall.mock.calls[0]?.[0]).toBe(window); expect(storageInstall.mock.calls[0]?.[1]).toBe(catalogInstall.mock.calls[0]?.[1])
      expect(storageInstall.mock.calls[0]?.[2]).toBe(getAuthoritativeMainWindow)
      expect(winController.getMainWindow).not.toHaveBeenCalled(); expect(winController.registerWindow).not.toHaveBeenCalled()
      expect(installInstalledCatalogReadBinding).toHaveBeenCalledOnce()
      window.loadURL('file:///callback-initiated-navigation.html')
    })
    const window = createMainWindow(callback) as unknown as FakeWindow
    expect(storageInstall.mock.calls[0]?.[1]).toBe(window.loadURL.mock.calls[1]?.[0])
    expect(storageInstall.mock.invocationCallOrder[0]).toBeLessThan(callback.mock.invocationCallOrder[0]!)
    expect(storageInstall.mock.invocationCallOrder[0]).toBeLessThan(window.loadURL.mock.invocationCallOrder[0]!)
    const getter = storageInstall.mock.calls[0]?.[2]
    expect(getter).toBe(getAuthoritativeMainWindow); expect(getter()).toBe(window)
    const next = createMainWindow() as unknown as FakeWindow; expect(getter()).toBe(next)
    registered.window = null; expect(getter()).toBeNull()
    expect(catalogInstall.mock.calls[0]?.[2]).not.toBe(getter) // Existing catalog seam is not parameterized/replaced.
  })
  it.each(['callback', 'register', 'load'] as const)('disposes BOTH exact independent owners after %s failure and keeps the original error', kind => {
    const error = new Error('original dual-owner setup failure'), window = new FakeWindow()
    vi.mocked(BrowserWindow).mockImplementationOnce(function () { return window as unknown as BrowserWindow })
    if (kind === 'register') vi.mocked(winController.registerWindow).mockImplementationOnce(() => { throw error })
    if (kind === 'load') window.loadURL.mockImplementationOnce(() => { throw error })
    expect(() => createMainWindow(kind === 'callback' ? () => { throw error } : undefined)).toThrow(error)
    expect(storageInstall).toHaveBeenCalledOnce(); expect(storageDisposers.get(window)).toHaveBeenCalledOnce(); expect(catalogDisposers.get(window)).toHaveBeenCalledOnce()
  })
  it('does not leak the earlier catalog owner if storage installation itself throws', () => {
    const error = new Error('storage install failure'), window = new FakeWindow()
    vi.mocked(BrowserWindow).mockImplementationOnce(function () { return window as unknown as BrowserWindow })
    storageInstall.mockImplementationOnce(() => { throw error })
    expect(() => createMainWindow()).toThrow(error)
    expect(catalogDisposers.get(window)).toHaveBeenCalledOnce()
  })
  it.each(['storage', 'catalog'] as const)('closed cleanup still disposes the other owner and route when %s cleanup throws', kind => {
    const window = createMainWindow() as unknown as FakeWindow, senderId = window.webContents.id
    const failed = (kind === 'storage' ? storageDisposers : catalogDisposers).get(window)!
    expect(failed).toBeTypeOf('function'); failed.mockImplementation(() => { throw new Error('private cleanup failure') })
    // A teardown exception may propagate, but must never skip the second exact disposer or route.
    try { window.emit('closed') } catch { /* Teardown chain, not error formatting contract. */ }
    expect(storageDisposers.get(window)).toHaveBeenCalledOnce(); expect(catalogDisposers.get(window)).toHaveBeenCalledOnce()
    expect(unregisterMagicAgentTrustedRouteBinding).toHaveBeenCalledExactlyOnceWith(senderId)
  })
  it('closed cleanup uses captured disposers and cannot revoke another window after contents are dead', () => {
    const first = createMainWindow() as unknown as FakeWindow, second = createMainWindow() as unknown as FakeWindow
    first.destroyed = true; first.contents.destroyed = true
    expect(() => first.emit('closed')).not.toThrow()
    expect(storageDisposers.get(first)).toHaveBeenCalledOnce(); expect(catalogDisposers.get(first)).toHaveBeenCalledOnce()
    expect(storageDisposers.get(second)).not.toHaveBeenCalled(); expect(catalogDisposers.get(second)).not.toHaveBeenCalled()
  })
  it('does not let cleanup failure replace the original callback failure or read dead webContents during cleanup', () => {
    const original = new Error('original callback failure'), cleanup = vi.fn(() => { throw new Error('cleanup failure') })
    catalogInstall.mockImplementationOnce((window: object) => { catalogDisposers.set(window, cleanup); return cleanup })
    expect(() => createMainWindow(window => { (window as unknown as FakeWindow).destroyed = true; throw original })).toThrow(original)
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
