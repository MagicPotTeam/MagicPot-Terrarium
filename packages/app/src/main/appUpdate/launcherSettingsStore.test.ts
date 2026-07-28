import fs from 'node:fs/promises'
import path from 'node:path'
import { vol } from 'memfs'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseLauncherSettings } from '../../shared/appUpdate/launcherProtocol'
import { type LauncherStateFileSystem } from './launcherStateStore'
import { createLauncherSettingsStore, DEFAULT_LAUNCHER_SETTINGS } from './launcherSettingsStore'

const root = '/launcher'

function memfs(): LauncherStateFileSystem {
  return {
    mkdir: (...args) => fs.mkdir(...args),
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rename: (...args) => fs.rename(...args),
    unlink: (...args) => fs.unlink(...args)
  }
}

beforeEach(() => vol.reset())

describe('LauncherSettingsStore', () => {
  it('returns the safe defaults when settings.json is absent', async () => {
    await expect(createLauncherSettingsStore({ root, fileSystem: memfs() }).get()).resolves.toEqual(
      DEFAULT_LAUNCHER_SETTINGS
    )
  })

  it('persists updates atomically and reloads them', async () => {
    const store = createLauncherSettingsStore({ root, fileSystem: memfs() })
    await store.update({ updateMode: 'auto-on-launch', channel: 'beta' })

    const text = await fs.readFile(path.join(root, 'settings.json'), 'utf8')
    expect(parseLauncherSettings(text)).toEqual({
      ...DEFAULT_LAUNCHER_SETTINGS,
      updateMode: 'auto-on-launch',
      channel: 'beta'
    })
    await expect(store.get()).resolves.toEqual(parseLauncherSettings(text))
    await expect(fs.readdir(root)).resolves.toEqual(['settings.json'])
  })

  it('moves corrupt settings aside and recovers defaults', async () => {
    vol.fromJSON({ [path.join(root, 'settings.json')]: '{broken' })
    const store = createLauncherSettingsStore({
      root,
      fileSystem: memfs(),
      now: () => new Date('2026-01-02T03:04:05.006Z'),
      uniqueId: () => 'corrupt'
    })

    await expect(store.get()).resolves.toEqual(DEFAULT_LAUNCHER_SETTINGS)
    await expect(fs.readdir(root)).resolves.toEqual([
      'settings.json.2026-01-02T03-04-05-006Z-corrupt.corrupt'
    ])
  })

  it('strictly rejects an invalid merged update without persisting it', async () => {
    const store = createLauncherSettingsStore({ root, fileSystem: memfs() })
    await expect(store.update({ retainAppVersions: 0 })).rejects.toThrow(/schema 1/)
    await expect(store.get()).resolves.toEqual(DEFAULT_LAUNCHER_SETTINGS)
  })

  it('serializes concurrent read-modify-write updates without losing fields', async () => {
    const store = createLauncherSettingsStore({ root, fileSystem: memfs() })
    await Promise.all([
      store.update({ channel: 'nightly' }),
      store.update({ retainNightlyVersions: 7 }),
      store.update({ allowPrerelease: true })
    ])
    await expect(store.get()).resolves.toEqual({
      ...DEFAULT_LAUNCHER_SETTINGS,
      channel: 'nightly',
      retainNightlyVersions: 7,
      allowPrerelease: true
    })
  })
})
