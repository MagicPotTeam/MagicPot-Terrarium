import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface LauncherStateFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface LauncherStateStoreOptions<T> {
  filePath: string
  parse: (text: string) => T
  serialize: (value: T) => string
  fileSystem?: LauncherStateFileSystem
  now?: () => Date
  uniqueId?: () => string
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

// This only coordinates Store instances in this process. The launcher lock will provide
// inter-process exclusion when the launcher owns these files.
const operationQueues = new Map<string, Promise<void>>()

export class LauncherStateStore<T> {
  readonly filePath: string
  private readonly parseValue: (text: string) => T
  private readonly serializeValue: (value: T) => string
  private readonly fileSystem: LauncherStateFileSystem
  private readonly now: () => Date
  private readonly uniqueId: () => string

  constructor(options: LauncherStateStoreOptions<T>) {
    if (!path.isAbsolute(options.filePath))
      throw new TypeError('Launcher state filePath must be absolute')
    this.filePath = path.normalize(options.filePath)
    this.parseValue = options.parse
    this.serializeValue = options.serialize
    this.fileSystem = options.fileSystem ?? fs
    this.now = options.now ?? (() => new Date())
    this.uniqueId = options.uniqueId ?? randomUUID
  }

  load(defaultValue: T): Promise<T> {
    return this.enqueue(() => this.loadSerialized(defaultValue))
  }

  save(value: T): Promise<void> {
    return this.enqueue(() => this.saveAtomic(value))
  }

  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const previous = operationQueues.get(this.filePath) ?? Promise.resolve()
    const result = previous.then(operation)
    const next = result.then(
      () => undefined,
      () => undefined
    )
    operationQueues.set(this.filePath, next)
    void next.finally(() => {
      if (operationQueues.get(this.filePath) === next) operationQueues.delete(this.filePath)
    })
    return result
  }

  private async loadSerialized(defaultValue: T): Promise<T> {
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

  private async saveAtomic(value: T): Promise<void> {
    const serialized = this.serializeValue(value)
    const temporaryPath = `${this.filePath}.${this.uniqueId()}.tmp`
    await this.fileSystem.mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      await this.fileSystem.writeFile(temporaryPath, serialized, 'utf8')
      await this.fileSystem.rename(temporaryPath, this.filePath)
    } finally {
      await this.removeIfPresentBestEffort(temporaryPath)
    }
  }

  private async backUpCorruptFile(): Promise<void> {
    const timestamp = this.now().toISOString().replace(/[:.]/g, '-')
    for (;;) {
      const backupPath = `${this.filePath}.${timestamp}-${this.uniqueId()}.corrupt`
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
        if (hasErrorCode(error, 'ENOENT')) return
        throw error
      }
    }
  }

  private async removeIfPresentBestEffort(target: string): Promise<void> {
    try {
      await this.fileSystem.unlink(target)
    } catch {
      // Cleanup must not hide the write or rename result.
    }
  }
}

export function createLauncherStateStore<T>(
  options: LauncherStateStoreOptions<T>
): LauncherStateStore<T> {
  return new LauncherStateStore(options)
}
