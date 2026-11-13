import { describe, expect, it, vi } from 'vitest'
import { createStartupStorageSnapshot, startupStorageSnapshot } from './startupStorageSnapshot'

// Bounded module-evaluation/call firebreak, not a complete dependency graph or native IO proof.
const h = vi.hoisted(() => ({ imports: [] as string[], calls: vi.fn() }))
vi.mock('node:fs', () => { h.imports.push('node:fs'); return { default: { readFileSync: h.calls, writeFileSync: h.calls }, readFileSync: h.calls, writeFileSync: h.calls } })
vi.mock('fs', () => { h.imports.push('fs'); return { default: { readFileSync: h.calls, writeFileSync: h.calls }, readFileSync: h.calls, writeFileSync: h.calls } })
vi.mock('node:fs/promises', () => { h.imports.push('node:fsp'); return { default: { readFile: h.calls }, readFile: h.calls } })
vi.mock('fs/promises', () => { h.imports.push('fsp'); return { default: { readFile: h.calls }, readFile: h.calls } })
vi.mock('electron', () => { h.imports.push('electron'); return { app: { getPath: h.calls, setPath: h.calls } } })
vi.mock('./config', () => { h.imports.push('config'); return { getConfig: h.calls, initConfig: h.calls, listenConfig: h.calls } })
vi.mock('./userDataDirectory', () => { h.imports.push('directory'); return { resolveStartupUserDataDirectory: h.calls, getCurrentUserDataDirectoryState: h.calls, beginUserDataDirectoryChange: h.calls } })
vi.mock('./storageLocations', () => { h.imports.push('locations'); return { getStorageLocations: h.calls } })
vi.mock('../api/agentThreadNotesStore', () => { h.imports.push('notes'); return { getAgentThreadNotesStore: h.calls } })
vi.mock('../magicAgentRuntime/platformAdapter', () => { h.imports.push('runtime'); return { getMagicAgentPlatformAdapter: h.calls } })
vi.mock('../magicAgentPlatform2/productionRuntime', () => { h.imports.push('platform2'); return { getProductionRuntime: h.calls } })
vi.mock('../llmProxy/providerDispatchOwner', () => { h.imports.push('provider'); return { shutdownProviderDispatchOwner: h.calls } })

it('imports/captures/publishes/revokes only memory, never enumerated FS/Electron/config/directory/DB/runtime/provider owners', () => {
  expect(h.imports).toEqual([]); expect(h.calls).not.toHaveBeenCalled()
  expect(startupStorageSnapshot.capture()).toBeNull()
  const owner = createStartupStorageSnapshot()
  expect(owner.capture()).toBeNull(); expect(owner.publish({ source: 'default', legacyLayout: false })).toBe(true)
  const capture = owner.capture()!; expect(capture.isCurrent()).toBe(true); owner.invalidate()
  expect(capture.isCurrent()).toBe(false); expect(owner.capture()).toBeNull()
  expect(h.imports).toEqual([]); expect(h.calls).not.toHaveBeenCalled()
})

describe('no unrelated global readiness implied', () => {
  it('exposes neither credentials/content/paths nor a service/policy/config/DB getter', () => {
    const owner = createStartupStorageSnapshot()
    expect(Reflect.ownKeys(owner).sort()).toEqual(['capture', 'invalidate', 'publish'])
    expect(owner.publish({ source: 'env', legacyLayout: true })).toBe(true)
    expect(Reflect.ownKeys(owner.capture()!.snapshot).sort()).toEqual(['legacyLayout', 'source'])
  })
})
