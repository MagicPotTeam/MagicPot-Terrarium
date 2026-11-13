import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const paths = new Map<string, string>(), listeners = new Map<string, (...args: unknown[]) => unknown>()
  return {
    paths, listeners, beforeSet: vi.fn(), resolver: vi.fn(), updateInstall: vi.fn(() => false), confirm: vi.fn(async () => true), shutdown: vi.fn(async () => {}),
    app: { isPackaged: false, setPath: vi.fn((name: string, value: string) => { h.beforeSet(name); paths.set(name, value) }), getPath: vi.fn((name: string) => paths.get(name)), whenReady: vi.fn(() => new Promise<void>(() => {})), on: vi.fn((name: string, callback: (...args: unknown[]) => unknown) => { listeners.set(name, callback) }), quit: vi.fn(), exit: vi.fn() }
  }
})
vi.mock('electron', () => ({ app: h.app, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./config/userDataDirectory', () => ({ resolveStartupUserDataDirectory: h.resolver }))
vi.mock('./utils/loggingOverride', () => ({}))
vi.mock('./appRuntime', () => ({ getAppStartupTestWindowPolicy: () => ({ automatedRun: false }), initializeMainProcessRuntime: vi.fn(), setupReadyAppRuntime: vi.fn() }))
vi.mock('./lifeCycle', () => ({ beforeShow: vi.fn(), beforeQuit: vi.fn() }))
vi.mock('./magicAgentPlatform2/productionRuntime', () => ({ runMagicAgentApprovalSmoke: vi.fn() }))
vi.mock('./mainWindow', () => ({ createMainWindow: vi.fn() }))
vi.mock('./qApp/watcher', () => ({ startQAppWatcher: vi.fn(), stopQAppWatcher: vi.fn() }))
vi.mock('./screenshot/screenshotManager', () => ({ initScreenshotManager: vi.fn(), cleanupScreenshotManager: vi.fn() }))
vi.mock('./appUpdate/appLauncherBridge', () => ({ confirmLauncherHealth: vi.fn(), startLauncherSmokeTest: () => false }))
vi.mock('./appUpdate/updateManager', () => ({ initializeAppUpdateManager: vi.fn(), isAppUpdateInstallInProgress: h.updateInstall }))
vi.mock('./localMediaAccess', () => ({ flushLocalMediaAccessGrants: vi.fn() }))
vi.mock('./localMediaFileIntakeIpc', () => ({ registerLocalMediaFileIntakeIpc: vi.fn() }))
vi.mock('./subprocess/subprocess', () => ({ cleanupSubProcesses: vi.fn(async () => {}) }))
vi.mock('./winControls', () => ({ winController: { confirmAppQuit: h.confirm } }))
vi.mock('./llmProxy/providerDispatchOwner', () => ({ shutdownProviderDispatchOwner: h.shutdown }))

let startup: { path: string; source: string; legacyLayout: boolean; storageRoot: string; projectRoot: string; autoSaveRoot: string }
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); h.paths.clear(); h.listeners.clear(); h.beforeSet.mockReset(); h.confirm.mockReset().mockResolvedValue(true); h.updateInstall.mockReset().mockReturnValue(false); h.shutdown.mockReset().mockResolvedValue()
  h.app.setPath.mockReset().mockImplementation((name: string, value: string) => { h.beforeSet(name); h.paths.set(name, value) })
  h.app.getPath.mockReset().mockImplementation((name: string) => h.paths.get(name))
  startup = { path: path.resolve('startup-storage-fixture/Data'), source: 'persisted', legacyLayout: false, storageRoot: path.resolve('startup-storage-fixture'), projectRoot: 'FIXTURE_PROJECT_NOT_FOR_METADATA', autoSaveRoot: 'FIXTURE_AUTOSAVE_NOT_FOR_METADATA' }
  h.resolver.mockReset().mockImplementation(() => startup)
})
afterEach(() => { vi.restoreAllMocks() })

describe('actual main entry publishes only successfully applied startup storage metadata under mocked Electron and memfs, not native boot', () => {
  it('publishes after successful setPath and exact readback, never reruns resolution during captures', async () => {
    const { startupStorageSnapshot: owner } = await import('./config/startupStorageSnapshot')
    h.beforeSet.mockImplementation(name => { if (name === 'userData') expect(owner.capture()).toBeNull() })
    await import('./index')
    expect(owner.capture()?.snapshot).toEqual({ source: 'persisted', legacyLayout: false })
    expect(h.resolver).toHaveBeenCalledTimes(1)
    expect(h.app.getPath).toHaveBeenCalledWith('userData')
    expect(h.app.setPath.mock.invocationCallOrder[0]).toBeLessThan(h.app.getPath.mock.invocationCallOrder[0])
    const count = h.app.getPath.mock.calls.length, capture = owner.capture()!
    expect(capture.isCurrent()).toBe(true); expect(owner.capture()?.snapshot).toEqual(capture.snapshot)
    expect(h.app.getPath).toHaveBeenCalledTimes(count); expect(h.resolver).toHaveBeenCalledTimes(1)
    expect(Reflect.ownKeys(capture.snapshot).sort()).toEqual(['legacyLayout', 'source'])
    expect(JSON.stringify(capture.snapshot)).not.toContain('FIXTURE')
  })
  it.each([{ source: 'default', legacyLayout: false }, { source: 'env', legacyLayout: true }])('records actual source/layout without inferring customness: $source / $legacyLayout', async metadata => {
    startup = { ...startup, ...metadata }; await import('./index')
    const { startupStorageSnapshot: owner } = await import('./config/startupStorageSnapshot')
    expect(owner.capture()?.snapshot).toEqual(metadata); expect(owner.capture()?.isCurrent()).toBe(true)
  })
  it('remains unavailable when setPath returns but the applied userData does not match', async () => {
    h.app.getPath.mockReturnValue(path.resolve('unrelated-fixture/Data'))
    await import('./index'); const { startupStorageSnapshot: owner } = await import('./config/startupStorageSnapshot')
    expect(owner.capture()).toBeNull(); expect(owner.publish({ source: 'default', legacyLayout: false })).toBe(false)
  })
  it('fails closed on readback errors without changing the existing entry success behavior', async () => {
    h.app.getPath.mockImplementation(() => { throw new Error('fixture getPath failed') })
    await expect(import('./index')).resolves.toBeDefined()
    const { startupStorageSnapshot: owner } = await import('./config/startupStorageSnapshot')
    expect(owner.capture()).toBeNull(); expect(owner.publish({ source: 'default', legacyLayout: false })).toBe(false)
  })
  it('does not publish when normal startup setPath itself fails', async () => {
    h.app.setPath.mockImplementation(() => { throw new Error('fixture setPath failed') })
    await expect(import('./index')).rejects.toThrow('fixture setPath failed')
    const { startupStorageSnapshot: owner } = await import('./config/startupStorageSnapshot')
    expect(owner.capture()).toBeNull()
  })
  it('does not substitute defaults when startup metadata is incomplete even if path application succeeded', async () => {
    delete (startup as Partial<typeof startup>).legacyLayout
    await import('./index'); const { startupStorageSnapshot: owner } = await import('./config/startupStorageSnapshot')
    expect(owner.capture()).toBeNull(); expect(owner.publish({ source: 'default', legacyLayout: false })).toBe(false)
  })
  it('revokes before update-install async cleanup and stays terminal on allowFinalQuit replay without duplicate cleanup', async () => {
    h.updateInstall.mockReturnValue(true)
    let complete: () => void = () => { throw new Error('fixture shutdown not entered') }
    h.shutdown.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
    await import('./index'); const { startupStorageSnapshot: owner } = await import('./config/startupStorageSnapshot')
    const captured = owner.capture()!; expect(captured.isCurrent()).toBe(true)
    const event = { preventDefault: vi.fn() }, finalEvent = { preventDefault: vi.fn() }
    const pending = h.listeners.get('before-quit')!(event)
    expect(captured.isCurrent()).toBe(false); expect(owner.capture()).toBeNull()
    expect(event.preventDefault).toHaveBeenCalledTimes(1); expect(h.confirm).not.toHaveBeenCalled()
    expect(h.shutdown).toHaveBeenCalledTimes(1); expect(h.app.quit).not.toHaveBeenCalled()
    complete(); await pending
    expect(h.app.quit).toHaveBeenCalledTimes(1)
    await h.listeners.get('before-quit')!(finalEvent)
    expect(finalEvent.preventDefault).not.toHaveBeenCalled(); expect(h.shutdown).toHaveBeenCalledTimes(1)
    expect(captured.isCurrent()).toBe(false); expect(owner.capture()).toBeNull()
    expect(owner.publish({ source: 'default', legacyLayout: false })).toBe(false)
  })
  it.each([true, false])('revokes startup captures at before-quit before awaiting confirmation, including confirmed=%s', async approved => {
    h.confirm.mockResolvedValue(approved)
    await import('./index'); const { startupStorageSnapshot: owner } = await import('./config/startupStorageSnapshot')
    const captured = owner.capture()!; expect(captured.isCurrent()).toBe(true)
    const preventDefault = vi.fn(); h.confirm.mockImplementation(async () => { expect(captured.isCurrent()).toBe(false); return approved })
    await h.listeners.get('before-quit')?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalled(); expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(captured.isCurrent()).toBe(false); expect(owner.capture()).toBeNull()
    expect(owner.publish({ source: 'env', legacyLayout: true })).toBe(false)
    expect(h.shutdown).toHaveBeenCalledTimes(approved ? 1 : 0)
  })
})
