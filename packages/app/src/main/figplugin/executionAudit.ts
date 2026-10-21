import fs from 'node:fs/promises'
import { constants, type BigIntStats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import {
  FIGPLUGIN_AUDIT_TTL_MS,
  FIGPLUGIN_AUDIT_MAX_RECORDS,
  FIGPLUGIN_AUDIT_MAX_BYTES,
  FIGPLUGIN_AUDIT_MAX_LINE_BYTES,
  figPluginExecutionAuditEventSchema,
  type FigPluginExecutionAuditEvent
} from '@shared/figplugin/executionAudit'

export {
  FIGPLUGIN_AUDIT_TTL_MS,
  FIGPLUGIN_AUDIT_MAX_RECORDS,
  FIGPLUGIN_AUDIT_MAX_BYTES,
  FIGPLUGIN_AUDIT_MAX_LINE_BYTES,
  type FigPluginExecutionAuditEvent
} from '@shared/figplugin/executionAudit'

type Queue = { tail: Promise<void>; writeFailed: boolean }
// All controllers/windows in this main process share ordering for the same audit file.
const queues = new Map<string, Queue>()
const stores = new Map<string, FigPluginExecutionAuditStore>()
const keyFor = (root: string): string =>
  process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)
const missing = (error: unknown): boolean =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
const unavailable = (): Error => new Error('FIGPLUGIN_AUDIT_UNAVAILABLE')
const sameIdentity = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  sameIdentity(left, right) &&
  left.nlink === 1n &&
  right.nlink === 1n &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs

type Directory = { path: string; info: BigIntStats }
type Snapshot = {
  directories: Directory[]
  info?: BigIntStats
  original: string
  events: FigPluginExecutionAuditEvent[]
}

const parseLine = (line: string): FigPluginExecutionAuditEvent | undefined => {
  if (!line || Buffer.byteLength(line, 'utf8') > FIGPLUGIN_AUDIT_MAX_LINE_BYTES) return undefined
  try {
    const parsed = figPluginExecutionAuditEventSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
const serialize = (events: readonly FigPluginExecutionAuditEvent[]): string =>
  events.map((event) => `${JSON.stringify(event)}\n`).join('')

/** Fixed-file, bounded history only. It never recreates sessions, grants or executable plans. */
export class FigPluginExecutionAuditStore {
  readonly #root: string
  readonly #file: string
  readonly #queue: Queue
  readonly #now: () => number

  constructor(root: string, now: () => number = Date.now) {
    if (!path.isAbsolute(root) || root.includes('\0') || /^[\\/]{2}/.test(root))
      throw new Error('INVALID_AUDIT_ROOT')
    this.#root = path.resolve(root)
    this.#file = path.join(this.#root, 'execution-audit.jsonl')
    this.#now = now
    const key = keyFor(this.#root)
    this.#queue = queues.get(key) ?? { tail: Promise.resolve(), writeFailed: false }
    queues.set(key, this.#queue)
  }

  get writeFailed(): boolean {
    return this.#queue.writeFailed
  }

  #ordered<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.tail.then(work)
    this.#queue.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  record(value: FigPluginExecutionAuditEvent): void {
    const parsed = figPluginExecutionAuditEventSchema.safeParse(value)
    if (!parsed.success) {
      this.#queue.writeFailed = true
      return
    }
    const line = `${JSON.stringify(parsed.data)}\n`
    if (Buffer.byteLength(line, 'utf8') > FIGPLUGIN_AUDIT_MAX_LINE_BYTES) {
      this.#queue.writeFailed = true
      return
    }
    void this.#ordered(async () => {
      try {
        const snapshot = await this.#read(true)
        if (!snapshot) throw unavailable()
        const now = this.#now()
        const events = [...snapshot.events, parsed.data]
          .filter((event) => event.at <= now && event.at > now - FIGPLUGIN_AUDIT_TTL_MS)
          .slice(-FIGPLUGIN_AUDIT_MAX_RECORDS)
        let text = serialize(events)
        while (Buffer.byteLength(text, 'utf8') > FIGPLUGIN_AUDIT_MAX_BYTES && events.length) {
          events.shift()
          text = serialize(events)
        }
        // Enforce TTL/count on disk on every record, not only above the byte threshold.
        await this.#replace(snapshot, text)
        // A later successful write cannot restore events already lost in this process.
      } catch {
        // Execution cannot be undone by a log failure. Surface loss in the history UI.
        this.#queue.writeFailed = true
      }
    })
  }

  flush(): Promise<void> {
    return this.#queue.tail
  }

  list(): Promise<readonly FigPluginExecutionAuditEvent[]> {
    return this.#ordered(async () => {
      try {
        const snapshot = await this.#read(false)
        if (!snapshot) return []
        const text = serialize(snapshot.events)
        // Opening history also removes expired/malformed entries from an idle log.
        if (snapshot.info && text !== snapshot.original) await this.#replace(snapshot, text)
        return structuredClone(snapshot.events)
      } catch {
        throw unavailable()
      }
    })
  }

  async #directories(create: boolean): Promise<Directory[] | undefined> {
    const parsed = path.parse(this.#root)
    const segments = this.#root.slice(parsed.root.length).split(path.sep).filter(Boolean)
    if (segments.length > 64) throw unavailable()
    const result: Directory[] = []
    let current = parsed.root
    for (const segment of ['', ...segments]) {
      current = path.join(current, segment)
      let info: BigIntStats
      try {
        info = await fs.lstat(current, { bigint: true })
      } catch (error) {
        if (!missing(error)) throw error
        if (!create) return undefined
        try {
          await fs.mkdir(current, { mode: 0o700 })
        } catch (failure) {
          if (
            !failure ||
            typeof failure !== 'object' ||
            !('code' in failure) ||
            failure.code !== 'EEXIST'
          )
            throw failure
        }
        info = await fs.lstat(current, { bigint: true })
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw unavailable()
      result.push({ path: current, info })
    }
    await this.#checkDirectories(result)
    return result
  }

  async #checkDirectories(chain: Directory[]): Promise<void> {
    for (const directory of chain) {
      const info = await fs.lstat(directory.path, { bigint: true })
      if (info.isSymbolicLink() || !info.isDirectory() || !sameIdentity(info, directory.info))
        throw unavailable()
    }
  }

  async #read(create: boolean): Promise<Snapshot | undefined> {
    const directories = await this.#directories(create)
    if (!directories) return undefined
    let info: BigIntStats
    try {
      info = await fs.lstat(this.#file, { bigint: true })
    } catch (error) {
      if (missing(error)) return { directories, original: '', events: [] }
      throw error
    }
    // Bound the allocation before reading; permit a bounded migration from the old store.
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.nlink !== 1n ||
      info.size > BigInt(FIGPLUGIN_AUDIT_MAX_BYTES * 2)
    )
      throw unavailable()
    const handle = await fs.open(
      this.#file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    let original: string
    try {
      const opened = await handle.stat({ bigint: true })
      if (!sameFile(info, opened)) throw unavailable()
      const buffer = Buffer.alloc(Number(opened.size) + 1)
      let count = 0
      while (count < buffer.length) {
        const part = await handle.read(buffer, count, buffer.length - count, count)
        if (!part.bytesRead) break
        count += part.bytesRead
      }
      if (BigInt(count) !== opened.size || !sameFile(opened, await handle.stat({ bigint: true })))
        throw unavailable()
      original = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count))
    } finally {
      await handle.close()
    }
    await this.#checkDirectories(directories)
    if (!sameFile(info, await fs.lstat(this.#file, { bigint: true }))) throw unavailable()
    const now = this.#now()
    const events = original
      .split('\n')
      .map(parseLine)
      .filter(
        (event): event is FigPluginExecutionAuditEvent =>
          !!event && event.at <= now && event.at > now - FIGPLUGIN_AUDIT_TTL_MS
      )
      .slice(-FIGPLUGIN_AUDIT_MAX_RECORDS)
    return { directories, info, original, events }
  }

  async #replace(snapshot: Snapshot, text: string): Promise<void> {
    if (Buffer.byteLength(text, 'utf8') > FIGPLUGIN_AUDIT_MAX_BYTES) throw unavailable()
    await this.#checkDirectories(snapshot.directories)
    const temporary = `${this.#file}.${randomBytes(16).toString('hex')}.tmp`
    const handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    const identity = await handle.stat({ bigint: true })
    let renamed = false
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
      await handle.close()
      await this.#checkDirectories(snapshot.directories)
      let current: BigIntStats | undefined
      try {
        current = await fs.lstat(this.#file, { bigint: true })
      } catch (error) {
        if (!missing(error)) throw error
      }
      if (snapshot.info ? !current || !sameFile(snapshot.info, current) : current !== undefined)
        throw unavailable()
      const tempInfo = await fs.lstat(temporary, { bigint: true })
      if (!sameIdentity(identity, tempInfo) || !tempInfo.isFile() || tempInfo.nlink !== 1n)
        throw unavailable()
      await fs.rename(temporary, this.#file)
      renamed = true
    } finally {
      await handle.close().catch(() => undefined)
      if (!renamed) {
        // Remove only the exact temporary file created by this operation.
        try {
          await this.#checkDirectories(snapshot.directories)
          const info = await fs.lstat(temporary, { bigint: true })
          if (sameIdentity(identity, info) && info.isFile() && info.nlink === 1n)
            await fs.unlink(temporary)
        } catch {
          /* Never touch a substituted directory or file. */
        }
      }
    }
  }
}

export function getFigPluginExecutionAuditStore(root: string): FigPluginExecutionAuditStore {
  const key = keyFor(root)
  let store = stores.get(key)
  if (!store) {
    store = new FigPluginExecutionAuditStore(root)
    stores.set(key, store)
  }
  return store
}

export async function flushFigPluginExecutionAuditStores(): Promise<void> {
  await Promise.all([...stores.values()].map((store) => store.flush()))
}
