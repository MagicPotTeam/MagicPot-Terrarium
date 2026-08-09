import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ValidatedInstallation } from './launcherCore'

export const DEFAULT_LAUNCHER_SMOKE_TIMEOUT_MS = 30_000

export interface LauncherSmokeTestFileSystem {
  mkdtemp(prefix: string): Promise<string>
  rm(path: string, options: { recursive: true; force: true }): Promise<void>
}

export type SpawnLauncherSmokeProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

export interface LauncherSmokeTestOptions {
  launcherExecutable?: string
  launchToken?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  temporaryDirectory?: string
  fileSystem?: LauncherSmokeTestFileSystem
  spawn?: SpawnLauncherSmokeProcess
}

export interface LauncherSmokeTestResult {
  exitCode: 0
}

export class LauncherSmokeTestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LauncherSmokeTestError'
  }
}

function waitForSuccessfulExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      operation()
    }
    const onError = (error: Error) =>
      finish(() =>
        reject(
          new LauncherSmokeTestError('Launcher smoke test process failed to start', {
            cause: error
          })
        )
      )
    const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(() => {
        if (code === 0) resolve()
        else {
          const outcome = signal ? `signal ${signal}` : `exit code ${String(code)}`
          reject(new LauncherSmokeTestError(`Launcher smoke test failed with ${outcome}`))
        }
      })
    const timeout = setTimeout(() => {
      finish(() => {
        child.kill()
        reject(new LauncherSmokeTestError(`Launcher smoke test timed out after ${timeoutMs}ms`))
      })
    }, timeoutMs)

    child.once('error', onError)
    child.once('close', onClose)
  })
}

export async function runLauncherSmokeTest(
  installed: ValidatedInstallation,
  options: LauncherSmokeTestOptions = {}
): Promise<LauncherSmokeTestResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LAUNCHER_SMOKE_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError('Launcher smoke test timeout must be a positive integer')

  const fileSystem = options.fileSystem ?? fs
  const spawnProcess = options.spawn ?? nodeSpawn
  const temporaryDirectory = options.temporaryDirectory ?? os.tmpdir()
  const userDataDirectory = await fileSystem.mkdtemp(
    path.join(temporaryDirectory, 'magicpot-launcher-smoke-')
  )

  try {
    const child = spawnProcess(
      installed.appEntrypoint,
      [
        '--update-smoke-test',
        '--launcher-build-id',
        installed.app.buildId,
        `--user-data-dir=${userDataDirectory}`,
        '--no-first-run'
      ],
      {
        shell: false,
        cwd: installed.appDirectory,
        env: {
          ...(options.env ?? process.env),
          MAGICPOT_MANAGED_ROOT: path.dirname(path.dirname(installed.appDirectory)),
          MAGICPOT_ACTIVE_BUILD_ID: installed.app.buildId,
          MAGICPOT_APP_DIR: installed.appDirectory,
          MAGICPOT_RUNTIME_ID: installed.runtime.runtimeId,
          MAGICPOT_RUNTIME_DIR: installed.runtimeDirectory,
          MAGICPOT_LAUNCHER_EXE: options.launcherExecutable ?? process.execPath,
          MAGICPOT_LAUNCH_TOKEN: options.launchToken ?? randomUUID()
        },
        windowsHide: true,
        stdio: 'pipe'
      }
    )
    await waitForSuccessfulExit(child, timeoutMs)
    return { exitCode: 0 }
  } catch (error) {
    if (error instanceof LauncherSmokeTestError) throw error
    throw new LauncherSmokeTestError('Launcher smoke test process could not be created', {
      cause: error
    })
  } finally {
    await fileSystem.rm(userDataDirectory, { recursive: true, force: true })
  }
}
