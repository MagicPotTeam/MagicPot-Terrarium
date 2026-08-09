import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { confirmLauncherHealth, startLauncherSmokeTest } from './appLauncherBridge'

const buildId = '20260717-053138-c9a892c'
const runtimeId = 'comfy-win-x64-20260701'

function app() {
  return {
    exit: vi.fn(),
    getAppPath: vi.fn(() => '/app'),
    getVersion: vi.fn(() => '1.0.0'),
    isPackaged: true,
    whenReady: vi.fn(() => Promise.resolve())
  }
}

function stat(isFile: boolean) {
  return Promise.resolve({ isDirectory: () => !isFile, isFile: () => isFile }) as never
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('application launcher bridge', () => {
  it('runs smoke mode without starting normal work and exits successfully after sanity checks', async () => {
    const electronApp = app()
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const statMock = vi.fn((target: string) => stat(target === '/runtime/electron'))

    expect(
      startLauncherSmokeTest({
        app: electronApp,
        argv: ['app', '--update-smoke-test', '--launcher-build-id', buildId],
        env: { MAGICPOT_ACTIVE_BUILD: buildId },
        resourcesPath: '/resources',
        execPath: '/runtime/electron',
        stat: statMock as never
      })
    ).toBe(true)
    await settle()

    expect(stdoutWrite).toHaveBeenCalledWith(
      `${JSON.stringify({ ok: true, version: '1.0.0', buildId })}
`
    )
    expect(electronApp.exit).toHaveBeenCalledWith(0)
    expect(statMock).toHaveBeenCalledTimes(3)
  })

  it('fails smoke mode for a mismatched active build', async () => {
    const electronApp = app()
    startLauncherSmokeTest({
      app: electronApp,
      argv: ['app', '--update-smoke-test', '--launcher-build-id', buildId],
      env: { MAGICPOT_ACTIVE_BUILD: '20260718-053138-c9a892c' },
      stat: vi.fn() as never
    })
    await settle()
    expect(electronApp.exit).toHaveBeenCalledWith(1)
  })

  it('confirms a valid managed launch', async () => {
    const confirm = vi.fn(() => Promise.resolve(true))
    const root = path.resolve('/launcher')
    const buildRoot = path.join(root, 'apps', buildId)
    const appPath = path.join(buildRoot, 'resources', 'app.asar')
    const executable = path.join(buildRoot, 'MagicPot.exe')
    const lstat = vi.fn(async (target: string) => ({
      isDirectory: () => target !== executable,
      isFile: () => target === executable,
      isSymbolicLink: () => false
    }))

    await expect(
      confirmLauncherHealth({
        app: app(),
        appPath,
        executable,
        lstat: lstat as never,
        realpath: vi.fn(async (target: string) => path.resolve(target)) as never,
        env: {
          MAGICPOT_LAUNCH_TOKEN: 'token',
          MAGICPOT_LAUNCH_BUILD_ID: buildId,
          MAGICPOT_LAUNCH_RUNTIME_ID: runtimeId,
          MAGICPOT_LAUNCHER_ROOT: root,
          MAGICPOT_ACTIVE_BUILD: buildId,
          MAGICPOT_ACTIVE_RUNTIME: runtimeId
        },
        confirmHealthy: confirm
      })
    ).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith(root, buildId, runtimeId, 'token')
  })

  it.each([
    ['a redirected launcher root', (root: string) => path.join(root, '..', 'evil')],
    ['an executable outside the build', (_root: string) => path.resolve('/outside/MagicPot.exe')]
  ])('rejects %s before confirming health', async (_label, redirect) => {
    const confirm = vi.fn(() => Promise.resolve(true))
    const root = path.resolve('/launcher')
    const buildRoot = path.join(root, 'apps', buildId)
    const appPath = path.join(buildRoot, 'resources', 'app.asar')
    const executable = path.join(buildRoot, 'MagicPot.exe')

    await expect(
      confirmLauncherHealth({
        app: app(),
        appPath,
        executable,
        lstat: vi.fn(async (target: string) => ({
          isDirectory: () => target !== executable,
          isFile: () => target === executable,
          isSymbolicLink: () => false
        })) as never,
        realpath: vi.fn(async (target: string) =>
          target === root || target === executable ? redirect(root) : path.resolve(target)
        ) as never,
        env: {
          MAGICPOT_LAUNCH_TOKEN: 'token',
          MAGICPOT_LAUNCH_BUILD_ID: buildId,
          MAGICPOT_LAUNCH_RUNTIME_ID: runtimeId,
          MAGICPOT_LAUNCHER_ROOT: root,
          MAGICPOT_ACTIVE_BUILD: buildId,
          MAGICPOT_ACTIVE_RUNTIME: runtimeId
        },
        confirmHealthy: confirm
      })
    ).resolves.toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('rejects a mismatched active runtime before confirming health', async () => {
    const confirm = vi.fn(async () => true)
    const root = path.resolve('/launcher')
    const buildRoot = path.join(root, 'apps', buildId)
    const appPath = path.join(buildRoot, 'resources', 'app.asar')
    const executable = path.join(buildRoot, 'MagicPot.exe')

    expect(
      await confirmLauncherHealth({
        app: app(),
        appPath,
        executable,
        lstat: vi.fn(async (target: string) => ({
          isDirectory: () => target !== executable,
          isFile: () => target === executable,
          isSymbolicLink: () => false
        })) as never,
        realpath: vi.fn(async (target: string) => path.resolve(target)) as never,
        env: {
          MAGICPOT_LAUNCH_TOKEN: 'token',
          MAGICPOT_LAUNCH_BUILD_ID: buildId,
          MAGICPOT_LAUNCH_RUNTIME_ID: runtimeId,
          MAGICPOT_LAUNCHER_ROOT: root,
          MAGICPOT_ACTIVE_BUILD: buildId,
          MAGICPOT_ACTIVE_RUNTIME_ID: 'comfy-win-x64-20260702'
        },
        confirmHealthy: confirm
      })
    ).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('rejects a symlinked managed build', async () => {
    const confirm = vi.fn(() => Promise.resolve(true))
    const root = path.resolve('/launcher')
    const buildRoot = path.join(root, 'apps', buildId)
    await expect(
      confirmLauncherHealth({
        app: app(),
        appPath: path.join(buildRoot, 'resources', 'app.asar'),
        executable: path.join(buildRoot, 'MagicPot.exe'),
        lstat: vi.fn(async (target: string) => ({
          isDirectory: () => !target.endsWith('.exe'),
          isFile: () => target.endsWith('.exe'),
          isSymbolicLink: () => target === buildRoot
        })) as never,
        realpath: vi.fn(async (target: string) => path.resolve(target)) as never,
        env: {
          MAGICPOT_LAUNCH_TOKEN: 'token',
          MAGICPOT_LAUNCH_BUILD_ID: buildId,
          MAGICPOT_LAUNCH_RUNTIME_ID: runtimeId,
          MAGICPOT_LAUNCHER_ROOT: root,
          MAGICPOT_ACTIVE_BUILD: buildId,
          MAGICPOT_ACTIVE_RUNTIME: runtimeId
        },
        confirmHealthy: confirm
      })
    ).resolves.toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { MAGICPOT_LAUNCH_TOKEN: 'token' },
    {
      MAGICPOT_LAUNCH_TOKEN: 'token',
      MAGICPOT_LAUNCH_BUILD_ID: 'bad',
      MAGICPOT_LAUNCHER_ROOT: '/launcher'
    },
    {
      MAGICPOT_LAUNCH_TOKEN: 'token',
      MAGICPOT_LAUNCH_BUILD_ID: buildId,
      MAGICPOT_LAUNCHER_ROOT: 'relative'
    }
  ])('is a no-op for missing or malformed launcher environment %#', async (env) => {
    const confirm = vi.fn()
    await expect(confirmLauncherHealth({ app: app(), env, confirmHealthy: confirm })).resolves.toBe(
      false
    )
    expect(confirm).not.toHaveBeenCalled()
  })

  it('is a no-op for a normal legacy launch', () => {
    const electronApp = app()
    expect(startLauncherSmokeTest({ app: electronApp, argv: ['app'] })).toBe(false)
    expect(electronApp.whenReady).not.toHaveBeenCalled()
    expect(electronApp.exit).not.toHaveBeenCalled()
  })
})
