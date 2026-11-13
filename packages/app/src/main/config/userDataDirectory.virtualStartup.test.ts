import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// All product filesystem calls below go to this in-memory fake, never Node fs.
const state = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: unknown[] }>,
  bootstrapCalls: 0,
  automated: false,
  bootstrap: ''
}))

vi.mock('fs', () => {
  const fake = new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined
      return (...args: unknown[]) => {
        const method = String(property)
        state.calls.push({ method, args })
        if (method === 'mkdirSync') return undefined
        if (method === 'accessSync' && args[0] === state.bootstrap) return undefined
        if (method === 'readFileSync' && args[0] === state.bootstrap) {
          return JSON.stringify({ customStorageRoot: '/synthetic/persisted' })
        }
        throw new Error(`Unexpected virtual fs operation: ${method}`)
      }
    }
  })
  return { default: fake }
})
vi.mock('fs/promises', () => ({
  default: new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined
      return async (...args: unknown[]) => {
        state.calls.push({ method: `promises.${String(property)}`, args })
        throw new Error(`Unexpected virtual fs operation: ${String(property)}`)
      }
    }
  })
}))
vi.mock('electron', () => ({ app: { getPath: (name: string) => {
  if (name === 'desktop') return '/synthetic/desktop'
  if (name === 'temp') return '/synthetic/temp'
  throw new Error(`Unexpected app path: ${name}`)
} } }))
vi.mock('../testUiPolicy', () => ({
  readTestUiEnv: () => ({}),
  resolveTestUiPolicy: () => ({ automatedRun: state.automated }),
  resolveConfiguredDesktopPath: (value: string) => value,
  resolveTestArtifactPath: () => '/synthetic/automated'
}))
vi.mock('./portablePaths', () => ({
  STORAGE_ROOT_OVERRIDE_ENV: 'MAGICPOT_STORAGE_ROOT',
  USER_DATA_OVERRIDE_ENV: 'MAGICPOT_USER_DATA_DIR',
  USER_DATA_BOOTSTRAP_FILENAME: 'bootstrap.json',
  LEGACY_BOOTSTRAPS_RETIRED_FIELD: 'legacyBootstrapsRetired',
  getDefaultPortableStorageRoot: () => '/synthetic/default',
  getDefaultPortableUserDataDirectory: () => '/synthetic/default/Data',
  getLegacyPortableUserDataDirectory: () => '/synthetic/legacy',
  getPortableUserDataBootstrapPath: () => state.bootstrap,
  getPortableUserDataBootstrapPaths: () => { state.bootstrapCalls++; return [state.bootstrap] }
}))
vi.mock('./startupStorageSnapshot', () => ({ startupStorageSnapshot: {} }))

// Candidate paths are fully absolute on either platform: importing this
// disabled test must not resolve a rooted path against the real working drive.
const syntheticRoot = path.sep === '\\' ? 'Z:\\synthetic' : '/synthetic'
const absolute = (value: string) => path.join(syntheticRoot, value.replace(/^\/synthetic\/?/, ''))
const root = absolute('/synthetic/owned')
const autoRoot = absolute('/synthetic/automated')
const layoutPaths = (base: string) => [base, path.join(base, 'Data'), path.join(base, 'Projects'), path.join(base, 'AutoSave')]

// Replace only the product module's synchronous view of process, and restore it
// immediately: no inherited environment is made available to the code under test.
function withSyntheticProcess<T>(env: Record<string, string>, fn: () => T): T {
  const original = globalThis.process
  vi.stubGlobal('process', { env, platform: path.sep === '\\' ? 'win32' : 'linux', cwd: () => absolute('/synthetic/cwd') })
  try { return fn() } finally { vi.stubGlobal('process', original) }
}

// DO NOT RUN: the import-time environment and loader boundary have not been
// proven isolated. This candidate is intentionally disabled until that audit.
describe.skip('startup userData selection with virtual-only I/O', () => {
  beforeEach(() => {
    state.calls = []
    state.bootstrapCalls = 0
    state.automated = false
    state.bootstrap = absolute('/synthetic/bootstrap.json')
  })
  afterEach(() => vi.unstubAllGlobals())

  async function load() { return import('./userDataDirectory') }
  function expectOnlyMkdir(paths: string[]) {
    expect(state.bootstrapCalls).toBe(0)
    expect(state.calls).toEqual(paths.map(target => ({ method: 'mkdirSync', args: [target, { recursive: true }] })))
  }

  it('prefers storage root over legacy override without bootstrap or migration', async () => {
    const module = await load()
    const result = withSyntheticProcess({ MAGICPOT_STORAGE_ROOT: root, MAGICPOT_USER_DATA_DIR: absolute('/synthetic/other') }, () => module.resolveStartupUserDataDirectory())
    expect(result).toEqual({ path: path.join(root, 'Data'), source: 'env', storageRoot: root, projectRoot: path.join(root, 'Projects'), autoSaveRoot: path.join(root, 'AutoSave'), legacyLayout: false })
    expectOnlyMkdir(layoutPaths(root))
  })
  it('uses the legacy exact userData override without bootstrap or migration', async () => {
    const module = await load()
    const result = withSyntheticProcess({ MAGICPOT_USER_DATA_DIR: root }, () => module.resolveStartupUserDataDirectory())
    expect(result).toEqual({ path: root, source: 'env', storageRoot: root, projectRoot: path.join(root, 'renderer-state', 'project-canvas'), autoSaveRoot: path.join(root, 'AutoSave'), legacyLayout: true })
    expectOnlyMkdir([root])
  })
  it('accepts an automated storage root inside the synthetic artifact root', async () => {
    state.automated = true
    const module = await load()
    const selected = path.join(autoRoot, 'selected')
    const result = withSyntheticProcess({ MAGICPOT_STORAGE_ROOT: selected }, () => module.resolveStartupUserDataDirectory())
    expect(result.path).toBe(path.join(selected, 'Data'))
    expect(result.source).toBe('env')
    expectOnlyMkdir(layoutPaths(selected))
  })
  it('ignores out-of-root automated overrides and falls back inside the artifact root', async () => {
    state.automated = true
    const module = await load()
    const result = withSyntheticProcess({ MAGICPOT_STORAGE_ROOT: root, MAGICPOT_USER_DATA_DIR: root }, () => module.resolveStartupUserDataDirectory())
    expect(result.path).toBe(path.join(autoRoot, 'Data'))
    expect(result.source).toBe('default')
    expectOnlyMkdir(layoutPaths(autoRoot))
  })
  it('negative control: no override reads synthetic bootstrap before using persisted root', async () => {
    const module = await load()
    const result = withSyntheticProcess({}, () => module.resolveStartupUserDataDirectory())
    const persisted = absolute('/synthetic/persisted')
    expect(result.storageRoot).toBe(persisted)
    expect(state.bootstrapCalls).toBeGreaterThan(0)
    expect(state.calls).toEqual([
      { method: 'accessSync', args: [state.bootstrap] },
      { method: 'readFileSync', args: [state.bootstrap, 'utf8'] },
      ...layoutPaths(persisted).map(target => ({ method: 'mkdirSync', args: [target, { recursive: true }] }))
    ])
  })
  it('contrast: getCurrentUserDataDirectoryState reads bootstrap despite storage override', async () => {
    const module = await load()
    const result = withSyntheticProcess({ MAGICPOT_STORAGE_ROOT: root }, () => module.getCurrentUserDataDirectoryState(path.join(root, 'Data')))
    expect(result.storageRoot).toBe(root)
    expect(state.bootstrapCalls).toBeGreaterThan(0)
    expect(state.calls).toEqual([
      { method: 'accessSync', args: [state.bootstrap] },
      { method: 'readFileSync', args: [state.bootstrap, 'utf8'] }
    ])
  })
})
