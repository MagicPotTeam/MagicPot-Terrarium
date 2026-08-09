import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ValidatedInstallation } from './launcherCore'
import {
  LauncherSmokeTestError,
  runLauncherSmokeTest,
  type LauncherSmokeTestFileSystem,
  type SpawnLauncherSmokeProcess
} from './launcherSmokeTest'

const buildId = '20260717-053138-c9a892c'
const runtimeId = 'comfy-win-x64-20260701-a1b2c3d'
const root = path.resolve('/managed')
const appDirectory = path.join(root, 'apps', buildId)
const runtimeDirectory = path.join(root, 'runtimes', runtimeId)
const installed = {
  app: { buildId, entrypoint: 'app/MagicPot.exe' },
  runtime: { runtimeId },
  appDirectory,
  runtimeDirectory,
  appEntrypoint: path.join(appDirectory, 'app', 'MagicPot.exe'),
  pythonEntrypoint: path.join(runtimeDirectory, 'python.exe'),
  comfyuiEntrypoint: path.join(runtimeDirectory, 'ComfyUI', 'main.py')
} as ValidatedInstallation

function createFileSystem() {
  const fileSystem: LauncherSmokeTestFileSystem = {
    mkdtemp: vi.fn(async () => path.join(path.resolve('/tmp'), 'magicpot-launcher-smoke-123')),
    rm: vi.fn(async () => undefined)
  }
  return fileSystem
}

function createChild() {
  const child = new EventEmitter() as ChildProcess
  child.kill = vi.fn(() => true)
  return child
}

describe('runLauncherSmokeTest', () => {
  it('launches the installed entrypoint with isolated Electron data and launcher environment', async () => {
    const fileSystem = createFileSystem()
    const child = createChild()
    const spawn = vi.fn<SpawnLauncherSmokeProcess>(() => {
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    })

    await expect(
      runLauncherSmokeTest(installed, {
        fileSystem,
        spawn,
        temporaryDirectory: path.resolve('/tmp'),
        launcherExecutable: path.resolve('/launcher/MagicPotLauncher.exe'),
        launchToken: 'smoke-token',
        env: { BASE_ENV: 'kept' }
      })
    ).resolves.toEqual({ exitCode: 0 })

    const [executable, args, spawnOptions] = spawn.mock.calls[0] as [
      string,
      readonly string[],
      SpawnOptions
    ]
    const userDataDirectory = path.join(path.resolve('/tmp'), 'magicpot-launcher-smoke-123')
    expect(executable).toBe(installed.appEntrypoint)
    expect(args).toEqual([
      '--update-smoke-test',
      '--launcher-build-id',
      buildId,
      `--user-data-dir=${userDataDirectory}`,
      '--no-first-run'
    ])
    expect(spawnOptions).toMatchObject({
      shell: false,
      cwd: appDirectory,
      windowsHide: true,
      stdio: 'pipe',
      env: {
        BASE_ENV: 'kept',
        MAGICPOT_MANAGED_ROOT: root,
        MAGICPOT_ACTIVE_BUILD_ID: buildId,
        MAGICPOT_APP_DIR: appDirectory,
        MAGICPOT_RUNTIME_ID: runtimeId,
        MAGICPOT_RUNTIME_DIR: runtimeDirectory,
        MAGICPOT_LAUNCHER_EXE: path.resolve('/launcher/MagicPotLauncher.exe'),
        MAGICPOT_LAUNCH_TOKEN: 'smoke-token'
      }
    })
    expect(fileSystem.rm).toHaveBeenCalledWith(userDataDirectory, {
      recursive: true,
      force: true
    })
  })

  it('rejects a non-zero exit and removes temporary user data', async () => {
    const fileSystem = createFileSystem()
    const child = createChild()
    const spawn: SpawnLauncherSmokeProcess = () => {
      queueMicrotask(() => child.emit('close', 17, null))
      return child
    }

    await expect(runLauncherSmokeTest(installed, { fileSystem, spawn })).rejects.toThrow(
      /exit code 17/
    )
    expect(fileSystem.rm).toHaveBeenCalledOnce()
  })

  it('kills and rejects a process that exceeds the timeout', async () => {
    vi.useFakeTimers()
    try {
      const fileSystem = createFileSystem()
      const child = createChild()
      const result = runLauncherSmokeTest(installed, {
        fileSystem,
        spawn: () => child,
        timeoutMs: 25
      })
      const observed = result.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(25)

      const error = await observed
      expect(error).toBeInstanceOf(LauncherSmokeTestError)
      expect(error).toMatchObject({ message: 'Launcher smoke test timed out after 25ms' })
      expect(child.kill).toHaveBeenCalledOnce()
      expect(fileSystem.rm).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects synchronous spawn failures and still cleans up', async () => {
    const fileSystem = createFileSystem()
    const failure = new Error('spawn exploded')

    await expect(
      runLauncherSmokeTest(installed, {
        fileSystem,
        spawn: () => {
          throw failure
        }
      })
    ).rejects.toMatchObject({ cause: failure })
    expect(fileSystem.rm).toHaveBeenCalledOnce()
  })
})
