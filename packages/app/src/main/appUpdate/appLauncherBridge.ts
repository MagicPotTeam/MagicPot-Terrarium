import fs from 'node:fs/promises'
import path from 'node:path'
import type { App } from 'electron'
import { isValidBuildId, isValidRuntimeId } from '../../shared/appUpdate/launcherProtocol'
import { DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD, LAUNCHER_HEALTH_FILE } from './launcherCore'
import { createLauncherHealth, isValidLaunchToken } from './launcherHealth'
import { withWaitedUpdateLock } from './updateLock'

export const UPDATE_SMOKE_TEST_ARG = '--update-smoke-test'
export const LAUNCHER_BUILD_ID_ARG = '--launcher-build-id'
export const HEALTH_UPDATE_LOCK_STALE_MS = 10 * 60 * 1_000

interface BridgeApp extends Pick<
  App,
  'exit' | 'getAppPath' | 'getVersion' | 'isPackaged' | 'whenReady'
> {}

export interface AppLauncherBridgeOptions {
  app: BridgeApp
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  resourcesPath?: string
  execPath?: string
  stat?: typeof fs.stat
  lstat?: typeof fs.lstat
  realpath?: typeof fs.realpath
  appPath?: string
  executable?: string
  confirmHealthy?: (
    root: string,
    buildId: string,
    runtimeId: string,
    launchToken: string
  ) => Promise<boolean>
}

export interface ValidatedLauncherBinding {
  readonly root: string
  readonly buildId: string
  readonly runtimeId: string
  readonly launchToken: string
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

async function validateLaunchBinding(
  options: AppLauncherBridgeOptions,
  root: string,
  buildId: string
): Promise<string> {
  const lstat = options.lstat ?? fs.lstat
  const realpath = options.realpath ?? fs.realpath
  const expectedRoot = path.resolve(root)
  const expectedApps = path.join(expectedRoot, 'apps')
  const expectedBuild = path.join(expectedApps, buildId)
  const appPath = options.appPath ?? options.app.getAppPath()
  const executable = options.executable ?? options.execPath ?? process.execPath

  for (const [target, label, kind] of [
    [expectedRoot, 'launcher root', 'directory'],
    [expectedApps, 'managed apps root', 'directory'],
    [expectedBuild, 'managed build', 'directory'],
    [appPath, 'application path', 'either'],
    [executable, 'runtime executable', 'file']
  ] as const) {
    const info = await lstat(target)
    const wrongType =
      kind === 'directory'
        ? !info.isDirectory()
        : kind === 'file'
          ? !info.isFile()
          : !info.isDirectory() && !info.isFile()
    if (info.isSymbolicLink() || wrongType)
      throw new Error(`${label} is redirected or has the wrong type`)
  }

  const [realRoot, realApps, realBuild, realAppPath, realExecutable] = await Promise.all([
    realpath(expectedRoot),
    realpath(expectedApps),
    realpath(expectedBuild),
    realpath(appPath),
    realpath(executable)
  ])
  if (!samePath(realRoot, expectedRoot)) throw new Error('launcher root is redirected')
  if (!samePath(realApps, path.join(realRoot, 'apps'))) throw new Error('apps root is redirected')
  if (!samePath(realBuild, path.join(realApps, buildId))) throw new Error('build is redirected')
  if (!isInside(realBuild, realAppPath) || !isInside(realBuild, realExecutable))
    throw new Error('application is not bound to the launched build')
  return realRoot
}

function readArgument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  return argv[index + 1]
}

function activeBuildFromEnvironment(env: NodeJS.ProcessEnv): string | undefined {
  return env.MAGICPOT_ACTIVE_BUILD ?? env.MAGICPOT_ACTIVE_BUILD_ID
}

function activeRuntimeFromEnvironment(env: NodeJS.ProcessEnv): string | undefined {
  return env.MAGICPOT_ACTIVE_RUNTIME ?? env.MAGICPOT_ACTIVE_RUNTIME_ID
}

export async function resolveValidatedLauncherBinding(
  options: AppLauncherBridgeOptions
): Promise<Readonly<ValidatedLauncherBinding> | null> {
  const env = options.env ?? process.env
  const launchToken = env.MAGICPOT_LAUNCH_TOKEN
  const buildId = env.MAGICPOT_LAUNCH_BUILD_ID
  const runtimeId = env.MAGICPOT_LAUNCH_RUNTIME_ID
  const root = env.MAGICPOT_LAUNCHER_ROOT

  if (
    !isValidLaunchToken(launchToken) ||
    !isValidBuildId(buildId) ||
    !isValidRuntimeId(runtimeId) ||
    typeof root !== 'string' ||
    !path.isAbsolute(root)
  )
    return null
  if (
    activeBuildFromEnvironment(env) !== buildId ||
    activeRuntimeFromEnvironment(env) !== runtimeId
  )
    return null

  try {
    const canonicalRoot = await validateLaunchBinding(options, root, buildId)
    return Object.freeze({ root: canonicalRoot, buildId, runtimeId, launchToken })
  } catch {
    return null
  }
}

async function requireDirectory(
  stat: typeof fs.stat,
  target: string,
  label: string
): Promise<void> {
  if (!(await stat(target)).isDirectory()) throw new Error(`${label} is not a directory`)
}

async function runSmokeTest(options: AppLauncherBridgeOptions): Promise<void> {
  const argv = options.argv ?? process.argv
  const env = options.env ?? process.env
  const expectedBuildId = readArgument(argv, LAUNCHER_BUILD_ID_ARG)
  if (!isValidBuildId(expectedBuildId)) throw new Error('Missing or invalid launcher build ID')

  const activeBuildId = activeBuildFromEnvironment(env)
  if (activeBuildId !== undefined && activeBuildId !== expectedBuildId)
    throw new Error('Launcher build ID does not match the active build')

  const appVersion = options.app.getVersion()
  if (isValidBuildId(appVersion) && appVersion !== expectedBuildId)
    throw new Error('Launcher build ID does not match the application version')

  const stat = options.stat ?? fs.stat
  await requireDirectory(stat, options.app.getAppPath(), 'Application path')
  if (options.app.isPackaged)
    await requireDirectory(stat, options.resourcesPath ?? process.resourcesPath, 'Resources path')

  const executable = options.execPath ?? process.execPath
  if (!(await stat(executable)).isFile()) throw new Error('Runtime executable is not a file')
  process.stdout.write(
    `${JSON.stringify({ ok: true, version: options.app.getVersion(), buildId: expectedBuildId })}\n`
  )
}

async function defaultConfirmHealthy(
  root: string,
  buildId: string,
  runtimeId: string,
  launchToken: string
): Promise<boolean> {
  const health = createLauncherHealth({
    filePath: path.join(root, LAUNCHER_HEALTH_FILE),
    rollbackThreshold: DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD,
    withLock: async (operation) => {
      const lockRoot = path.join(root, '.health-lock')
      await fs.mkdir(lockRoot, { recursive: true })
      return withWaitedUpdateLock(lockRoot, operation, {
        staleAfterMs: HEALTH_UPDATE_LOCK_STALE_MS
      })
    }
  })
  return (await health.confirmHealthy({ buildId, runtimeId, launchToken })).accepted
}

export function startLauncherSmokeTest(options: AppLauncherBridgeOptions): boolean {
  const argv = options.argv ?? process.argv
  if (!argv.includes(UPDATE_SMOKE_TEST_ARG)) return false

  void options.app.whenReady().then(async () => {
    try {
      await runSmokeTest(options)
      options.app.exit(0)
    } catch (error) {
      console.error('[App] Launcher smoke test failed:', error)
      options.app.exit(1)
    }
  })
  return true
}

export async function confirmLauncherHealth(options: AppLauncherBridgeOptions): Promise<boolean> {
  try {
    const binding = await resolveValidatedLauncherBinding(options)
    if (!binding) return false
    return await (options.confirmHealthy ?? defaultConfirmHealthy)(
      binding.root,
      binding.buildId,
      binding.runtimeId,
      binding.launchToken
    )
  } catch (error) {
    console.error('[App] Failed to confirm launcher health:', error)
    return false
  }
}
