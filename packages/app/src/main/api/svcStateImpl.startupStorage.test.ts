import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getConfig: vi.fn(), getState: vi.fn(), begin: vi.fn(), save: vi.fn(), effect: vi.fn(), relaunch: vi.fn(), quit: vi.fn() }))
vi.mock('../config/config', () => ({ getConfig: h.getConfig, saveConfig: h.save, listenConfig: h.effect }))
vi.mock('../config/userDataDirectory', () => ({ getCurrentUserDataDirectoryState: h.getState, beginUserDataDirectoryChange: h.begin }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: h.effect }))
vi.mock('../config/storageLocations', () => ({ getStorageLocations: h.effect }))
vi.mock('../mcp/status', () => ({ getMcpRuntimeStatus: h.effect }))
vi.mock('../llmProxy/accessUsage', () => ({ getLlmProxyAccessUsageSnapshot: h.effect }))
vi.mock('../llmProxy/server', () => ({ getLLMProxyServerStatus: h.effect }))
vi.mock('electron', () => ({ app: { relaunch: h.relaunch, quit: h.quit } }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); h.getConfig.mockReset(); h.getState.mockReset(); h.begin.mockReset() })
afterEach(() => { vi.restoreAllMocks() })
async function setup() {
  const { startupStorageSnapshot: owner } = await import('../config/startupStorageSnapshot')
  const { StateSvcImpl } = await import('./svcStateImpl')
  expect(owner.publish({ source: 'persisted', legacyLayout: false })).toBe(true)
  return { owner, captured: owner.capture()!, service: new StateSvcImpl() }
}
const state = () => ({ currentPath: path.resolve('/startup-storage-service/Data'), storageRoot: path.resolve('/startup-storage-service'), projectRoot: path.resolve('/startup-storage-service/Projects') })

describe('actual StateSvc storage-change service-entry fence before existing preflight, including plan-review P2', () => {
  it('invalidates even if uninitialized getConfig throws before canonical begin can run', async () => {
    const { owner, captured, service } = await setup()
    h.getConfig.mockImplementation(() => { expect(captured.isCurrent()).toBe(false); throw new Error('Config not initialized') })
    await expect(service.setUserDataDirectory({ path: null })).rejects.toThrow('Config not initialized')
    expect(h.getConfig).toHaveBeenCalledTimes(1); expect(h.getState).not.toHaveBeenCalled(); expect(h.begin).not.toHaveBeenCalled()
    expect(owner.capture()).toBeNull(); expect(owner.publish({ source: 'default', legacyLayout: false })).toBe(false)
  })
  it('invalidates before the directory getter can migrate/read bootstrap or throw', async () => {
    const { owner, captured, service } = await setup()
    h.getConfig.mockReturnValue({ download_dir: '' })
    h.getState.mockImplementation(() => { expect(captured.isCurrent()).toBe(false); throw new Error('fixture bootstrap read failed') })
    await expect(service.setUserDataDirectory({ path: null })).rejects.toThrow('fixture bootstrap read failed')
    expect(h.getState).toHaveBeenCalledTimes(1); expect(h.begin).not.toHaveBeenCalled(); expect(owner.capture()).toBeNull()
  })
  it('invalidates before AutoSave filesystem preflight failure, not only before begin', async () => {
    const { owner, captured, service } = await setup()
    h.getConfig.mockReturnValue({ download_dir: '' }); h.getState.mockReturnValue(state())
    const exists = vi.spyOn(fs, 'existsSync').mockImplementation(() => { expect(captured.isCurrent()).toBe(false); throw new Error('fixture filesystem preflight failed') })
    await expect(service.setUserDataDirectory({ path: null })).rejects.toThrow('fixture filesystem preflight failed')
    expect(exists).toHaveBeenCalledTimes(1); expect(h.begin).not.toHaveBeenCalled(); expect(owner.capture()).toBeNull()
  })
  it('keeps conservative unavailable on a no-change result and preserves the existing service result without save/relaunch', async () => {
    const { owner, captured, service } = await setup()
    h.getConfig.mockImplementation(() => { expect(captured.isCurrent()).toBe(false); return { download_dir: '' } })
    h.getState.mockReturnValue(state()); vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    h.begin.mockResolvedValue({ changed: false, commit: vi.fn(), rollback: vi.fn() })
    await expect(service.setUserDataDirectory({ path: null })).resolves.toEqual({ restartRequired: false })
    expect(h.begin).toHaveBeenCalledTimes(1); expect(owner.capture()).toBeNull()
    expect(h.save).not.toHaveBeenCalled(); expect(h.effect).not.toHaveBeenCalled(); expect(h.relaunch).not.toHaveBeenCalled(); expect(h.quit).not.toHaveBeenCalled()
  })
})
