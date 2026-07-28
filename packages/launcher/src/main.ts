import path from 'node:path'
import type { LauncherSettingsV1 } from '../../app/src/shared/appUpdate/launcherProtocol'
import { LocalLauncherCore } from '../../app/src/main/appUpdate/launcherCore'
import { createLauncherLayout } from '../../app/src/main/appUpdate/launcherLayout'
import { createLauncherSettingsStore } from '../../app/src/main/appUpdate/launcherSettingsStore'
import type { LauncherUpdateResult } from '../../app/src/main/appUpdate/launcherUpdateCoordinator'
import { withWaitedUpdateLock } from '../../app/src/main/appUpdate/updateLock'

export const UPDATE_MODE_ENV = 'MAGICPOT_UPDATE_MODE'
export const UPDATE_STATUS_ENV = 'MAGICPOT_UPDATE_STATUS'
export const UPDATE_CHANNEL_ENV = 'MAGICPOT_UPDATE_CHANNEL'
export const UPDATE_VERSION_ENV = 'MAGICPOT_UPDATE_VERSION'
export const LAUNCHER_SESSION_LOCK_DIRECTORY = '.launcher-session-lock'

export class LauncherAlreadyRunningError extends Error {
  constructor() {
    super('Another launcher instance is waiting for application health confirmation')
    this.name = 'LauncherAlreadyRunningError'
  }
}

type WithSessionLock = <T>(root: string, operation: () => Promise<T>) => Promise<T>

export type LauncherRunOnLaunchResult =
  | LauncherUpdateResult
  | { status: 'installed'; version?: string }
  | { status: 'disabled' | 'unavailable' }

export interface LauncherUpdateRunner {
  runOnLaunch(settings: LauncherSettingsV1): Promise<LauncherRunOnLaunchResult>
}

type StableLauncherCore = Pick<
  LocalLauncherCore,
  'readHealthState' | 'recoverExpiredPending' | 'resolveActive' | 'spawnActive'
>

export interface StableLauncherOptions {
  execPath?: string
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  launcherRoot?: string
  allowEnvironmentRootOverride?: boolean
  healthPollIntervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  createCore?: (root: string) => StableLauncherCore
  createSettingsStore?: (root: string) => { get(): Promise<LauncherSettingsV1> }
  updateRunner?: LauncherUpdateRunner
  withSessionLock?: WithSessionLock
}

export function resolveStableLauncherRoot(options: StableLauncherOptions = {}): string {
  const environmentOverride = options.allowEnvironmentRootOverride
    ? (options.env ?? process.env).MAGICPOT_LAUNCHER_ROOT
    : undefined
  const override = options.launcherRoot ?? environmentOverride
  if (override !== undefined) {
    if (!path.isAbsolute(override)) throw new TypeError('Launcher root must be absolute')
    return path.resolve(override)
  }
  const execPath = options.execPath ?? process.execPath
  const executableDirectory = path.dirname(path.resolve(execPath))
  return path.basename(executableDirectory).toLowerCase() === 'launcher'
    ? path.dirname(executableDirectory)
    : executableDirectory
}

export function forwardedLauncherArguments(argv: readonly string[]): string[] {
  return argv.slice(1)
}

export function createDisabledUpdateRunner(): LauncherUpdateRunner {
  return {
    async runOnLaunch() {
      // A trusted manifest URL and embedded public key must be supplied by application code.
      // Launcher defaults deliberately do not inspect environment variables or access the network.
      return { status: 'disabled' }
    }
  }
}

function safeVersion(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(value)
    ? value
    : undefined
}

export function updateResultEnvironment(
  settings: LauncherSettingsV1,
  result: LauncherRunOnLaunchResult
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    [UPDATE_MODE_ENV]: settings.updateMode,
    [UPDATE_STATUS_ENV]: result.status,
    [UPDATE_CHANNEL_ENV]: settings.channel
  }
  const version =
    'available' in result && result.available
      ? safeVersion(result.available.version)
      : 'version' in result
        ? safeVersion(result.version)
        : undefined
  if (version) env[UPDATE_VERSION_ENV] = version
  return env
}

export function createLaunchEnvironment(
  source: NodeJS.ProcessEnv,
  settings: LauncherSettingsV1,
  result: LauncherRunOnLaunchResult
): NodeJS.ProcessEnv {
  const env = { ...source }
  delete env[UPDATE_MODE_ENV]
  delete env[UPDATE_STATUS_ENV]
  delete env[UPDATE_CHANNEL_ENV]
  delete env[UPDATE_VERSION_ENV]
  return { ...env, ...updateResultEnvironment(settings, result) }
}

async function waitForLaunchResolution(
  core: Pick<LocalLauncherCore, 'readHealthState' | 'recoverExpiredPending'>,
  options: StableLauncherOptions
): Promise<void> {
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const pollIntervalMs = options.healthPollIntervalMs ?? 250
  for (;;) {
    const state = await core.readHealthState()
    if (!state.pending) return
    if (now() >= Date.parse(state.pending.deadline)) {
      await core.recoverExpiredPending()
      return
    }
    await sleep(pollIntervalMs)
  }
}

export async function runStableLauncher(options: StableLauncherOptions = {}): Promise<void> {
  const root = resolveStableLauncherRoot(options)
  const core = options.createCore?.(root) ?? new LocalLauncherCore(createLauncherLayout(root))
  const sessionLockRoot = path.join(root, LAUNCHER_SESSION_LOCK_DIRECTORY)
  const withSessionLock = options.withSessionLock ?? withWaitedUpdateLock

  await withSessionLock(sessionLockRoot, async () => {
    // Reconcile first: recovery may roll active back, so all later selection must happen afterwards.
    await core.recoverExpiredPending()
    if ((await core.readHealthState()).pending) throw new LauncherAlreadyRunningError()

    const settingsStore =
      options.createSettingsStore?.(root) ?? createLauncherSettingsStore({ root })
    const settings = await settingsStore.get()

    let updateResult: LauncherRunOnLaunchResult = { status: 'manual' }
    if (settings.updateMode !== 'manual') {
      try {
        updateResult = await (options.updateRunner ?? createDisabledUpdateRunner()).runOnLaunch(
          settings
        )
      } catch {
        updateResult = {
          status: 'failed',
          stage: 'manifest',
          error: { name: 'Error', message: '' }
        }
      }
    }

    // Resolve after reconciliation and after an auto update activation. spawnActive resolves once more
    // while atomically creating the pending health marker before the actual spawn.
    if (updateResult.status === 'activated' || updateResult.status === 'installed') {
      await core.resolveActive()
    }
    await core.spawnActive({
      args: forwardedLauncherArguments(options.argv ?? process.argv),
      env: createLaunchEnvironment(options.env ?? process.env, settings, updateResult)
    })
    await waitForLaunchResolution(core, options)
  })
}
