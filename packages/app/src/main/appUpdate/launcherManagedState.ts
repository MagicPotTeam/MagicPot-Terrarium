import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import {
  parseActivePointer,
  type UpdateChannel,
  type UpdateMode
} from '../../shared/appUpdate/launcherProtocol'
import type {
  LauncherManagedState,
  LauncherUpdateResultStatus,
  SaveLauncherSettingsReq
} from '../../shared/api/svcAppUpdate'
import { resolveValidatedLauncherBinding, type AppLauncherBridgeOptions } from './appLauncherBridge'
import { readLastLauncherCommandResult } from './launcherCommand'
import { createLauncherSettingsStore, type LauncherSettingsStore } from './launcherSettingsStore'
import { withWaitedUpdateLock } from './updateLock'
import { scanLauncherInstalledVersions } from './launcherInstalledVersions'

const UPDATE_MODES: readonly UpdateMode[] = ['manual', 'notify-on-launch', 'auto-on-launch']
const UPDATE_CHANNELS: readonly UpdateChannel[] = ['stable', 'beta', 'nightly']
const LAUNCH_STATUSES: readonly LauncherUpdateResultStatus[] = [
  'manual',
  'disabled',
  'unavailable',
  'up-to-date',
  'available',
  'activated',
  'installed',
  'locked',
  'failed'
]
const LAUNCHER_SESSION_LOCK_DIRECTORY = '.launcher-session-lock'
const VERSION_PATTERN = /^[0-9A-Za-z](?:[0-9A-Za-z.+-]{0,126}[0-9A-Za-z])?$/

export interface LauncherManagedStateOptions extends Omit<AppLauncherBridgeOptions, 'app'> {
  app?: AppLauncherBridgeOptions['app']
  createSettingsStore?: (root: string) => Pick<LauncherSettingsStore, 'get' | 'update'>
  withSessionLock?: <T>(root: string, operation: () => Promise<T>) => Promise<T>
}

function memberOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function safeEnvironmentState(env: NodeJS.ProcessEnv) {
  return {
    launchStatus: memberOf(LAUNCH_STATUSES, env.MAGICPOT_UPDATE_STATUS)
      ? env.MAGICPOT_UPDATE_STATUS
      : undefined,
    launchVersion:
      typeof env.MAGICPOT_UPDATE_VERSION === 'string' &&
      VERSION_PATTERN.test(env.MAGICPOT_UPDATE_VERSION)
        ? env.MAGICPOT_UPDATE_VERSION
        : undefined
  }
}

function bridgeOptions(options: LauncherManagedStateOptions): AppLauncherBridgeOptions {
  const {
    createSettingsStore: _createSettingsStore,
    withSessionLock: _withSessionLock,
    ...bridge
  } = options
  return { ...bridge, app: options.app ?? app }
}

function settingsStore(options: LauncherManagedStateOptions, root: string) {
  return options.createSettingsStore?.(root) ?? createLauncherSettingsStore({ root })
}

async function managedMetadata(root: string) {
  try {
    const pointer = parseActivePointer(await fs.readFile(path.join(root, 'active.json'), 'utf8'))
    return {
      activeBuildId: pointer.activeBuildId,
      activeRuntimeId: pointer.activeRuntimeId,
      previousBuildId: pointer.previousBuildId,
      capabilities: {
        checkNow: true,
        installLatest: true,
        rollback: pointer.previousBuildId !== undefined,
        removeVersion: false
      }
    }
  } catch {
    return {
      capabilities: { checkNow: true, installLatest: true, rollback: false, removeVersion: false }
    }
  }
}

export async function getLauncherManagedState(
  options: LauncherManagedStateOptions = {}
): Promise<LauncherManagedState> {
  const env = options.env ?? process.env
  const binding = await resolveValidatedLauncherBinding(bridgeOptions(options))
  if (!binding)
    return {
      managed: false,
      settingsWritable: false,
      capabilities: { checkNow: false, installLatest: false, rollback: false, removeVersion: false }
    }

  const environment = safeEnvironmentState(env)
  const [metadata, lastLauncherCommandResult, inventory] = await Promise.all([
    managedMetadata(binding.root),
    readLastLauncherCommandResult(options).catch(() => undefined),
    scanLauncherInstalledVersions(binding.root).catch(() => ({
      versions: [],
      issues: []
    }))
  ])
  try {
    const settings = await settingsStore(options, binding.root).get()
    return {
      managed: true,
      settingsWritable: true,
      updateMode: settings.updateMode,
      channel: settings.channel,
      lastLauncherCommandResult,
      ...(inventory.versions.length > 0 ? { installedVersions: inventory.versions } : {}),
      ...(inventory.issues.length > 0 ? { inventoryIssues: inventory.issues } : {}),
      ...environment,
      ...metadata
    }
  } catch {
    return {
      managed: true,
      settingsWritable: false,
      lastLauncherCommandResult,
      ...(inventory.versions.length > 0 ? { installedVersions: inventory.versions } : {}),
      ...(inventory.issues.length > 0 ? { inventoryIssues: inventory.issues } : {}),
      ...environment,
      ...metadata
    }
  }
}

export async function saveLauncherManagedSettings(
  request: SaveLauncherSettingsReq,
  options: LauncherManagedStateOptions = {}
): Promise<LauncherManagedState> {
  if (!memberOf(UPDATE_MODES, request.updateMode) || !memberOf(UPDATE_CHANNELS, request.channel))
    throw new TypeError('Invalid launcher settings')

  const binding = await resolveValidatedLauncherBinding(bridgeOptions(options))
  if (!binding) throw new Error('Launcher settings are unavailable')

  const lockRoot = path.join(binding.root, LAUNCHER_SESSION_LOCK_DIRECTORY)
  const withSessionLock = options.withSessionLock ?? withWaitedUpdateLock
  const updated = await withSessionLock(lockRoot, () =>
    settingsStore(options, binding.root).update({
      updateMode: request.updateMode,
      channel: request.channel
    })
  )
  return {
    managed: true,
    settingsWritable: true,
    updateMode: updated.updateMode,
    channel: updated.channel,
    ...safeEnvironmentState(options.env ?? process.env),
    ...(await managedMetadata(binding.root))
  }
}
