import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getPath: vi.fn<(name: string) => string>() }))
vi.mock('electron', () => ({ app: { getPath: h.getPath, isPackaged: false } }))
vi.mock('./portablePaths', () => ({ getDefaultPortableStorageRoot: () => '/startup-storage-change/default', getDefaultPortableUserDataDirectory: () => '/startup-storage-change/default/Data', getLegacyPortableUserDataDirectory: () => '/startup-storage-change/legacy', getPortableUserDataBootstrapPath: () => '/startup-storage-change/bootstrap.json', getPortableUserDataBootstrapPaths: () => ['/startup-storage-change/bootstrap.json'], LEGACY_BOOTSTRAPS_RETIRED_FIELD: 'legacyBootstrapsRetired', STORAGE_ROOT_OVERRIDE_ENV: 'MAGICPOT_STORAGE_ROOT', USER_DATA_BOOTSTRAP_FILENAME: 'user-data-bootstrap.json', USER_DATA_OVERRIDE_ENV: 'MAGICPOT_USER_DATA_DIR' }))

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  vi.stubEnv('MAGICPOT_STORAGE_ROOT', ''); vi.stubEnv('MAGICPOT_USER_DATA_DIR', '')
  fs.rmSync(path.resolve('/startup-storage-change'), { recursive: true, force: true })
  h.getPath.mockReset().mockImplementation(name => path.resolve('/startup-storage-change', name))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function setup() {
  const { startupStorageSnapshot: owner } = await import('./startupStorageSnapshot')
  const directory = await import('./userDataDirectory')
  expect(owner.publish({ source: 'default', legacyLayout: false })).toBe(true)
  return { owner, directory, captured: owner.capture()! }
}

describe('actual canonical storage-change entry invalidates startup cache before its existing preflight; memfs not native user data', () => {
  it('revokes before bootstrap existence/read callbacks even when default-root selection is a no-change attempt', async () => {
    const { owner, directory, captured } = await setup()
    const access = vi.spyOn(fs, 'accessSync').mockImplementation(() => { expect(captured.isCurrent()).toBe(false); throw new Error('fixture missing bootstrap') })
    const result = await directory.beginUserDataDirectoryChange(null, path.resolve('/startup-storage-change/default/Data'))
    expect(result.changed).toBe(false); expect(access).toHaveBeenCalled()
    expect(captured.isCurrent()).toBe(false); expect(owner.capture()).toBeNull()
    await result.commit(); await result.rollback()
    expect(owner.publish({ source: 'default', legacyLayout: false })).toBe(false)
  })
  it('revokes synchronously before environment-pinned change rejection and never resurrects on failure', async () => {
    const { owner, directory, captured } = await setup()
    vi.stubEnv('MAGICPOT_STORAGE_ROOT', path.resolve('/startup-storage-change/env'))
    const pending = directory.beginUserDataDirectoryChange(null, path.resolve('/startup-storage-change/env/Data'))
    expect(captured.isCurrent()).toBe(false)
    await expect(pending).rejects.toThrow('forcing the current storage directory')
    expect(owner.capture()).toBeNull(); expect(owner.publish({ source: 'env', legacyLayout: false })).toBe(false)
  })
  it('stays revoked through an actual changed:true bootstrap commit, idempotent commit and rollback in memfs', async () => {
    const { owner, directory, captured } = await setup()
    const root = path.resolve('/startup-storage-change/default'), current = path.join(root, 'Data'), target = path.resolve('/startup-storage-change/next-root'), bootstrap = path.resolve('/startup-storage-change/bootstrap.json')
    fs.mkdirSync(current, { recursive: true })
    const previous = JSON.stringify({ customStorageRoot: root, legacyBootstrapsRetired: true })
    fs.writeFileSync(bootstrap, previous)
    const prepared = await directory.beginUserDataDirectoryChange(target, current)
    expect(prepared.changed).toBe(true); expect(captured.isCurrent()).toBe(false); expect(owner.capture()).toBeNull()
    expect(fs.readFileSync(bootstrap, 'utf8')).toBe(previous)
    await prepared.commit(); await prepared.commit()
    expect(JSON.parse(fs.readFileSync(bootstrap, 'utf8')).customStorageRoot).toBe(target)
    expect(captured.isCurrent()).toBe(false); expect(owner.capture()).toBeNull()
    await prepared.rollback(); await prepared.rollback()
    expect(fs.readFileSync(bootstrap, 'utf8')).toBe(previous)
    expect(captured.isCurrent()).toBe(false); expect(owner.capture()).toBeNull()
    expect(owner.publish({ source: 'persisted', legacyLayout: false })).toBe(false)
  })
  it('also covers prepareUserDataDirectoryChange callers rather than only StateSvc dispatch', async () => {
    const { owner, directory, captured } = await setup()
    const access = vi.spyOn(fs, 'accessSync').mockImplementation(() => { expect(captured.isCurrent()).toBe(false); throw new Error('fixture absent') })
    await expect(directory.prepareUserDataDirectoryChange(null, path.resolve('/startup-storage-change/default/Data'))).resolves.toBe(false)
    expect(access).toHaveBeenCalled(); expect(owner.capture()).toBeNull(); expect(captured.isCurrent()).toBe(false)
  })
})
