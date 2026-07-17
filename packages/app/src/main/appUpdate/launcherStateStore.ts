import fs from 'node:fs/promises'
import path from 'node:path'

export interface LauncherStateFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
}

export interface LauncherStateStoreOptions<T> {
  filePath: string
  parse: (text: string) => T
  serialize: (value: T) => string
  fileSystem?: LauncherStateFileSystem
  now?: () => Date
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class LauncherStateStore<T> {
  readonly filePath: string
  private readonly parseValue: (text: string) => T
  private readonly serializeValue: (value: T) => string
  private readonly fileSystem: LauncherStateFileSystem
  private readonly now: () => Date
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(options: LauncherStateStoreOptions<T>) {
    if (!path.isAbsolute(options.filePath))
      throw new TypeError('Launcher state filePath must be absolute')
    this.filePath = path.normalize(options.filePath)
    this.parseValue = options.parse
    this.serializeValue = options.serialize
    this.fileSystem = options.fileSystem ?? fs
    this.now = options.now ?? (() => new Date())
  }

  async load(defaultValue: T): Promise<T> {
    let text: string
    try {
      text = await this.fileSystem.readFile(this.filePath, 'utf8')
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return defaultValue
      throw error
    }

    try {
      return this.parseValue(text)
    } catch (error) {
      try {
        await this.backUpCorruptFile()
      } catch (backupError) {
        throw new AggregateError(
          [error, backupError],
          `Failed to recover corrupt launcher state at ${this.filePath}`
        )
      }
      return defaultValue
    }
  }

  save(value: T): Promise<void> {
    const operation = this.saveQueue.then(() => this.saveAtomic(value))
    this.saveQueue = operation.catch(() => undefined)
    return operation
  }

  private async saveAtomic(value: T): Promise<void> {
    const serialized = this.serializeValue(value)
    const directory = path.dirname(this.filePath)
    const temporaryPath = `${this.filePath}.tmp`
    await this.fileSystem.mkdir(directory, { recursive: true })
    await this.fileSystem.writeFile(temporaryPath, serialized, 'utf8')
    await this.fileSystem.rename(temporaryPath, this.filePath)
  }

  private async backUpCorruptFile(): Promise<void> {
    const timestamp = this.now().toISOString().replace(/[:.]/g, '-')
    for (let sequence = 0; ; sequence += 1) {
      const suffix = sequence === 0 ? '' : `-${sequence}`
      const backupPath = `${this.filePath}.${timestamp}${suffix}.corrupt`
      try {
        await this.fileSystem.readFile(backupPath, 'utf8')
        continue
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error
      }
      try {
        await this.fileSystem.rename(this.filePath, backupPath)
        return
      } catch (error) {
        if (hasErrorCode(error, 'EEXIST')) continue
        throw error
      }
    }
  }
}

export function createLauncherStateStore<T>(
  options: LauncherStateStoreOptions<T>
): LauncherStateStore<T> {
  return new LauncherStateStore(options)
}
