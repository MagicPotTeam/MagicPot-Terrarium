import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getLauncherManagedState, saveLauncherManagedSettings } from './launcherManagedState'

const buildId = '20260717-053138-c9a892c'
const runtimeId = 'comfy-win-x64-20260701'
const root = path.resolve('/launcher')
const buildRoot = path.join(root, 'apps', buildId)
const appPath = path.join(buildRoot, 'resources', 'app.asar')
const executable = path.join(buildRoot, 'MagicPot.exe')
const env = {
  MAGICPOT_LAUNCH_TOKEN: 'token',
  MAGICPOT_LAUNCH_BUILD_ID: buildId,
  MAGICPOT_LAUNCH_RUNTIME_ID: runtimeId,
  MAGICPOT_LAUNCHER_ROOT: root,
  MAGICPOT_ACTIVE_BUILD: buildId,
  MAGICPOT_ACTIVE_RUNTIME: runtimeId,
  MAGICPOT_UPDATE_STATUS: 'installed',
  MAGICPOT_UPDATE_VERSION: '1.2.3-beta.1'
}
const app = {
  exit: vi.fn(),
  getAppPath: () => appPath,
  getVersion: () => '1.0.0',
  isPackaged: true,
  whenReady: () => Promise.resolve()
}
const binding = {
  app,
  appPath,
  executable,
  env,
  lstat: vi.fn(async (target: string) => ({
    isDirectory: () => target !== executable,
    isFile: () => target === executable,
    isSymbolicLink: () => false
  })) as never,
  realpath: vi.fn(async (target: string) => path.resolve(target)) as never
}

describe('launcher managed state', () => {
  it('returns validated settings and whitelisted launch state', async () => {
    await expect(
      getLauncherManagedState({
        ...binding,
        createSettingsStore: () => ({
          get: async () => ({
            schema: 1,
            updateMode: 'manual',
            channel: 'stable',
            retainAppVersions: 5,
            retainNightlyVersions: 4,
            allowPrerelease: true
          }),
          update: vi.fn()
        })
      })
    ).resolves.toEqual({
      managed: true,
      settingsWritable: true,
      updateMode: 'manual',
      channel: 'stable',
      launchStatus: 'installed',
      launchVersion: '1.2.3-beta.1',
      lastLauncherCommandResult: undefined,
      capabilities: { checkNow: true, installLatest: true, rollback: false, removeVersion: false }
    })
  })
  it('does not expose state or write when binding validation fails', async () => {
    const createSettingsStore = vi.fn()
    await expect(
      getLauncherManagedState({
        ...binding,
        env: { ...env, MAGICPOT_ACTIVE_BUILD: 'other' },
        createSettingsStore
      })
    ).resolves.toEqual({
      managed: false,
      settingsWritable: false,
      capabilities: { checkNow: false, installLatest: false, rollback: false, removeVersion: false }
    })
    expect(createSettingsStore).not.toHaveBeenCalled()
  })
  it('updates only mode/channel while the store preserves other settings', async () => {
    const update = vi.fn(async (patch) => ({
      schema: 1,
      ...patch,
      retainAppVersions: 5,
      retainNightlyVersions: 4,
      allowPrerelease: true
    }))
    const lockRoots: string[] = []
    const withSessionLock = async <T>(
      lockRoot: string,
      operation: () => Promise<T>
    ): Promise<T> => {
      lockRoots.push(lockRoot)
      return operation()
    }
    await expect(
      saveLauncherManagedSettings(
        { updateMode: 'auto-on-launch', channel: 'beta' },
        { ...binding, createSettingsStore: () => ({ get: vi.fn(), update }), withSessionLock }
      )
    ).resolves.toMatchObject({ managed: true, updateMode: 'auto-on-launch', channel: 'beta' })
    expect(lockRoots).toEqual([path.join(root, '.launcher-session-lock')])
    expect(update).toHaveBeenCalledWith({ updateMode: 'auto-on-launch', channel: 'beta' })
  })
  it('rejects values outside the enums', async () => {
    await expect(
      saveLauncherManagedSettings({ updateMode: 'evil', channel: 'stable' } as never, binding)
    ).rejects.toThrow('Invalid launcher settings')
  })
})
