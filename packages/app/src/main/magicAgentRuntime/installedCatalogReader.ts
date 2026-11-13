import fs, { type BigIntStats, type Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ManagementReadLease } from './managementReadAdmission'
import { isInstalledCatalogDirectoryId, projectInstalledCatalogMetadata, INSTALLED_CATALOG_METADATA_MAX_BYTES, type InstalledCatalogEntry } from './installedCatalogMetadata'

export type InstalledCatalogUnavailableReason = 'revoked' | 'deadline' | 'missing-root' | 'limit-exceeded' | 'unsafe-path' | 'stale' | 'invalid-metadata' | 'unavailable'
export type InstalledCatalogSnapshot = Readonly<{ status: 'available'; entries: readonly InstalledCatalogEntry[] }> | Readonly<{ status: 'unavailable'; reason: InstalledCatalogUnavailableReason }>
export type InstalledCatalogReadOptions = { userData: string; lease: ManagementReadLease; now?: () => number }
const unavailable = (reason: InstalledCatalogUnavailableReason): InstalledCatalogSnapshot => Object.freeze({ status: 'unavailable', reason })
class ReadFailure extends Error { constructor(readonly reason: InstalledCatalogUnavailableReason) { super(reason) } }
const fail = (reason: InstalledCatalogUnavailableReason): never => { throw new ReadFailure(reason) }
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const identity = (stat: BigIntStats): string => {
  if (stat.ino <= 0n || stat.birthtimeNs <= 0n) return fail('unsafe-path')
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}
const fingerprint = (stat: BigIntStats): string => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.nlink}`
type Pin = { file: string; kind: 'directory' | 'file'; stat: BigIntStats }
// One process-local module owner, no queue. A stuck operation/uncertain close retains capacity.
let workerOccupied = false

function validUserData(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 8192 || value !== value.trim() || !path.isAbsolute(value) || path.resolve(value) !== value || [...value].some(c => c.charCodeAt(0) < 32)) return false
  if (process.platform === 'win32' && (value.startsWith('\\\\') || !/^[a-z]:\\/i.test(value))) return false
  const root = path.parse(value).root, parts = value.slice(root.length).split(path.sep)
  return parts.length <= 64 && parts.every(part => part && part.length <= 255 && !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
}

/** Readonly optimistic snapshot for app-managed storage/stable ancestors, NOT strict OS confinement or ABA protection. */
export async function readInstalledCatalogSnapshot(options: InstalledCatalogReadOptions): Promise<InstalledCatalogSnapshot> {
  if (workerOccupied) return unavailable('unavailable')
  workerOccupied = true // Reserve before any callback; synchronous reentry cannot create a second worker.
  let started = false, uncertainCleanup = false, timer: ReturnType<typeof setTimeout> | undefined
  let stopReason: InstalledCatalogUnavailableReason | undefined, interrupt: ((value: InstalledCatalogSnapshot) => void) | undefined
  let signal: AbortSignal | undefined
  const stop = (reason: InstalledCatalogUnavailableReason): void => { if (!stopReason) { stopReason = reason; interrupt?.(unavailable(reason)) } }
  const onAbort = (): void => stop('revoked')
  const detach = (): void => { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
  try {
    if (!validUserData(options.userData)) return unavailable('unsafe-path')
    signal = options.lease.signal
    const now = options.now ?? Date.now
    let previousTime: number, deadline: number
    try { previousTime = now(); if (!Number.isFinite(previousTime) || previousTime < 0) return unavailable('deadline'); deadline = previousTime + 2000 } catch { return unavailable('deadline') }
    const guard = (): void => {
      if (stopReason) fail(stopReason)
      try { if (signal!.aborted || !options.lease.isCurrent() || signal!.aborted) stop('revoked') } catch { stop('revoked') }
      if (stopReason) fail(stopReason)
      try {
        const time = now()
        if (!Number.isFinite(time) || time < previousTime || time >= deadline) stop('deadline')
        previousTime = time
      } catch { stop('deadline') }
      if (stopReason) fail(stopReason)
    }
    guard()
    const interrupted = new Promise<InstalledCatalogSnapshot>(resolve => { interrupt = resolve })
    signal.addEventListener('abort', onAbort, { once: true }); guard()
    timer = setTimeout(() => stop('deadline'), 2000)
    const checked = async <T>(operation: () => Promise<T>): Promise<T> => { guard(); const value = await operation(); guard(); return value }
    const close = async (handle: { close(): Promise<void> }): Promise<void> => {
      try { await handle.close() } catch { uncertainCleanup = true; fail('unavailable') }
    }
    const capture = async (file: string, kind: Pin['kind']): Promise<Pin> => {
      const stat = await checked(() => fsp.lstat(file, { bigint: true }))
      if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail('unsafe-path')
      identity(stat)
      if (!samePath(await checked(() => fsp.realpath(file)), file)) fail('unsafe-path')
      return { file, kind, stat }
    }
    const verify = async (pin: Pin, full = true): Promise<void> => {
      const current = await capture(pin.file, pin.kind)
      if ((full ? fingerprint(current.stat) !== fingerprint(pin.stat) : identity(current.stat) !== identity(pin.stat))) fail('stale')
    }
    const root = path.join(options.userData, 'magic-agent-packages', 'installed')
    const enumerate = async (): Promise<string[]> => {
      guard(); const handle = await fsp.opendir(root, { bufferSize: 1 })
      const entries: Dirent[] = []
      try {
        guard()
        while (true) {
          const entry = await checked(() => handle.read())
          if (!entry) break
          entries.push(entry)
          if (entries.length > 128) fail('limit-exceeded')
        }
      } finally { await close(handle) }
      guard()
      if (entries.some(entry => !entry.isDirectory() || entry.isSymbolicLink() || !isInstalledCatalogDirectoryId(entry.name))) fail('unsafe-path')
      if (entries.length > 64) fail('limit-exceeded')
      return entries.map(entry => entry.name).sort()
    }
    const work = async (): Promise<InstalledCatalogSnapshot> => {
      try {
        const volume = path.parse(root).root, segments = root.slice(volume.length).split(path.sep), chain: Pin[] = []
        let current = volume
        try {
          for (const part of ['', ...segments]) { if (part) current = path.join(current, part); chain.push(await capture(current, 'directory')) }
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('missing-root'); throw error }
        const rootPin = chain.at(-1)!, names = await enumerate(), pins: Pin[] = [], rows: InstalledCatalogEntry[] = []
        let aggregate = 0
        for (const id of names) {
          const child = await capture(path.join(root, id), 'directory'), before = await capture(path.join(child.file, 'magicpot-installed-package.json'), 'file')
          if (before.stat.size < 0n || before.stat.size > BigInt(INSTALLED_CATALOG_METADATA_MAX_BYTES)) fail('limit-exceeded')
          if (aggregate + Number(before.stat.size) > 2 * 1024 * 1024) fail('limit-exceeded')
          guard()
          // Windows uses ordinary readonly handles by explicit bounded contract, not a strict no-follow fallback.
          const handle = await fsp.open(before.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
          let row: InstalledCatalogEntry | null
          try {
            guard()
            const opened = await checked(() => handle.stat({ bigint: true }))
            if (!opened.isFile() || opened.nlink !== 1n || fingerprint(opened) !== fingerprint(before.stat)) fail('stale')
            const buffer = Buffer.alloc(INSTALLED_CATALOG_METADATA_MAX_BYTES + 1)
            let length = 0
            while (length < buffer.length) {
              const result = await checked(() => handle.read(buffer, length, Math.min(8192, buffer.length - length), length))
              if (!result.bytesRead) break
              length += result.bytesRead; aggregate += result.bytesRead
              if (length > INSTALLED_CATALOG_METADATA_MAX_BYTES || aggregate > 2 * 1024 * 1024) fail('limit-exceeded')
            }
            const after = await checked(() => handle.stat({ bigint: true }))
            if (fingerprint(after) !== fingerprint(before.stat) || BigInt(length) !== before.stat.size) fail('stale')
            row = projectInstalledCatalogMetadata(id, buffer.subarray(0, length))
            if (!row) fail('invalid-metadata')
          } finally { await close(handle) }
          guard(); await verify(before); await verify(child); await verify(rootPin)
          pins.push(child, before); rows.push(row!)
        }
        const finalNames = await enumerate()
        if (JSON.stringify(finalNames) !== JSON.stringify(names)) fail('stale')
        for (const pin of pins) await verify(pin)
        await verify(rootPin)
        for (const ancestor of chain) await verify(ancestor, false)
        guard()
        return Object.freeze({ status: 'available', entries: Object.freeze(rows) })
      } catch (error) { return unavailable(stopReason ?? (error instanceof ReadFailure ? error.reason : 'unavailable')) }
    }
    started = true
    const worker = work().finally(() => { detach(); if (!uncertainCleanup) workerOccupied = false })
    const result = await Promise.race([worker, interrupted])
    // Worker cleanup and the race add promise boundaries; an available candidate is not publication authority.
    if (result.status === 'available') guard()
    return result
  } catch (error) { return unavailable(stopReason ?? (error instanceof ReadFailure ? error.reason : 'unavailable')) }
  finally { if (!started) { detach(); workerOccupied = false } }
}
