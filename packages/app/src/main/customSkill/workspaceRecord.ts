import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

/** Optional tiny main-owned workspace identity record, never a writable migration. */
export async function readSkillWorkspaceRecord(file: string, maxBytes: number, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  signal.throwIfAborted()
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    if (!path.isAbsolute(file) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) throw new Error('Procedural skill workspace record bounds are invalid.')
    const before = await fs.lstat(file)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes || !samePath(path.resolve(await fs.realpath(file)), path.resolve(file))) throw new Error('Procedural skill workspace record unavailable.')
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Procedural skill workspace record identity changed.')
    const buffer = Buffer.alloc(maxBytes + 1); let count = 0
    while (count < buffer.length) { signal.throwIfAborted(); const read = await handle.read(buffer, count, buffer.length - count, count); if (!read.bytesRead) break; count += read.bytesRead }
    const after = await handle.stat(), current = await fs.lstat(file)
    signal.throwIfAborted()
    if (count > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('Procedural skill workspace record changed.')
    const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)))
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Procedural skill workspace record is invalid.')
    return record as Record<string, unknown>
  } catch (error) { signal.throwIfAborted(); if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  finally { await handle?.close() }
}
