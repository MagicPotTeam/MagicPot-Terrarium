import path from 'node:path'
import {
  parseLauncherSettings,
  serializeLauncherSettings,
  type LauncherSettingsV1,
  type NormalizedLauncherSettingsV1
} from '../../shared/appUpdate/launcherProtocol'
import {
  createLauncherStateStore,
  type LauncherStateFileSystem,
  type LauncherStateStore
} from './launcherStateStore'

export const DEFAULT_LAUNCHER_SETTINGS: NormalizedLauncherSettingsV1 = Object.freeze({
  schema: 1,
  updateMode: 'manual',
  channel: 'stable',
  retainAppVersions: 3,
  retainNightlyVersions: 3,
  allowPrerelease: false
})

export type LauncherSettingsUpdate = Partial<Omit<LauncherSettingsV1, 'schema'>>

export interface LauncherSettingsStoreOptions {
  root: string
  fileSystem?: LauncherStateFileSystem
  now?: () => Date
  uniqueId?: () => string
}

export class LauncherSettingsStore {
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(private readonly store: LauncherStateStore<NormalizedLauncherSettingsV1>) {}

  get(): Promise<NormalizedLauncherSettingsV1> {
    return this.store.load(DEFAULT_LAUNCHER_SETTINGS)
  }

  update(patch: LauncherSettingsUpdate): Promise<NormalizedLauncherSettingsV1> {
    const operation = this.updateQueue.then(async () => {
      const current = await this.get()
      const next = parseLauncherSettings(
        JSON.stringify({ ...current, ...patch, schema: DEFAULT_LAUNCHER_SETTINGS.schema })
      )
      await this.store.save(next)
      return next
    })
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}

export function createLauncherSettingsStore(
  options: LauncherSettingsStoreOptions
): LauncherSettingsStore {
  if (!path.isAbsolute(options.root)) throw new TypeError('Launcher root must be absolute')
  return new LauncherSettingsStore(
    createLauncherStateStore({
      filePath: path.join(path.normalize(options.root), 'settings.json'),
      parse: parseLauncherSettings,
      serialize: serializeLauncherSettings,
      fileSystem: options.fileSystem,
      now: options.now,
      uniqueId: options.uniqueId
    })
  )
}
