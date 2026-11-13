import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'

/** Structural identity; the legacy colon-joined session key is not injective. */
export const memoryFileRouteIdentity = (input: AgentRouteLike): [string, string, string, string | null] => {
  const route = normalizeAgentRoute(input)
  return [route.channel, route.scopeType, route.scopeId, route.threadId ?? null]
}
export const memoryFileBindingLockPath = (workspace: { rootDir: string }): string => path.join(workspace.rootDir, '.memory-binding-v1.lock')
export type MemoryFileBindingRecord = { version: 1; revision: string; present: boolean; routeIdentity?: [string, string, string, string | null]; workspaceId?: string }
export const memoryFileBindingRecordPath = (workspace: { rootDir: string }): string => path.join(workspace.rootDir, '.memory-binding-v1.json')
export function readMemoryFileBindingRecord(workspace: { rootDir: string }): MemoryFileBindingRecord | undefined {
  const file = memoryFileBindingRecordPath(workspace)
  let before: fs.BigIntStats
  try { before = fs.lstatSync(file, { bigint: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n) throw new Error('Memory binding incarnation is invalid; review required.')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    if (fileIdentity(opened) !== fileIdentity(before) || opened.nlink !== 1n) throw new Error('Memory binding incarnation identity changed.')
    const data = Buffer.alloc(4097), length = fs.readSync(fd, data, 0, data.length, 0), after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true })
    if (length > 4096 || after.size !== BigInt(length) || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || fileIdentity(current) !== fileIdentity(before) || current.nlink !== 1n) throw new Error('Memory binding incarnation changed during read.')
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length)))
    if (value.version !== 1 || typeof value.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(value.revision) || typeof value.present !== 'boolean' ||
      value.routeIdentity !== undefined && (!Array.isArray(value.routeIdentity) || value.routeIdentity.length !== 4 || !value.routeIdentity.slice(0, 3).every((item: unknown) => typeof item === 'string') || value.routeIdentity[3] !== null && typeof value.routeIdentity[3] !== 'string') ||
      value.workspaceId !== undefined && (typeof value.workspaceId !== 'string' || !value.workspaceId.length || value.workspaceId.length > 120)) throw new Error('Memory binding incarnation is invalid; review required.')
    return value as MemoryFileBindingRecord
  } finally { fs.closeSync(fd) }
}
export type MemoryFileBindingLease = { release(): void; abandon(): void; setRecord(input: Omit<MemoryFileBindingRecord, 'version' | 'revision'>, revision?: string): MemoryFileBindingRecord }
const unknown = (cause: unknown) => Object.assign(new Error('Memory binding may have partial effects; review required.', { cause }), { code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' })
const fileIdentity = (stat: fs.BigIntStats) => {
  if (stat.ino <= 0n || stat.birthtimeNs <= 0n) throw new Error('Memory binding filesystem identity unavailable.')
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}
/** Shared by participating MAIN context writers/cleanup and memory commits.
 * Existing locks are never considered stale or adopted, including across restart.
 * Stable ancestors/controlled writers only, not an OS sandbox or atomic file CAS. */
export function acquireMemoryFileBindingLease(workspace: { rootDir: string }): MemoryFileBindingLease {
  const file = memoryFileBindingLockPath(workspace)
  let fd: number
  try { fd = fs.openSync(file, 'wx', 0o600) }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Memory binding has a live/interrupted writer; review required.', { cause }); throw cause }
  let identity: string | undefined, closed = false, settled = false
  const close = () => { if (!closed) { fs.closeSync(fd); closed = true } }
  const remove = () => {
    const stat = fs.lstatSync(file, { bigint: true })
    if (!identity || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n || fileIdentity(stat) !== identity) throw new Error('Memory binding lock identity changed; review required.')
    fs.unlinkSync(file)
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    identity = fileIdentity(stat)
    if (!stat.isFile() || stat.nlink !== 1n || identity !== fileIdentity(fs.lstatSync(file, { bigint: true }))) throw new Error('Memory binding exclusive lock identity changed.')
    fs.writeFileSync(fd, JSON.stringify({ version: 1, owner: randomUUID(), pid: process.pid }) + '\n', 'utf8'); fs.fsyncSync(fd)
  } catch (cause) {
    try { close(); remove() }
    catch (cleanup) { throw unknown(new AggregateError([cause, cleanup], 'Memory binding exclusive creation could not be cleaned up.')) }
    throw cause
  }
  return {
    setRecord: (input, revision) => {
      let output: number | undefined
      try {
        // Even preflight can run after context publication. Never let lookup,
        // identity, clone or RNG errors release a partially published binding.
        if (settled || closed) throw new Error('Memory binding lease is not live.')
        const current = fs.lstatSync(file, { bigint: true })
        if (current.isSymbolicLink() || current.nlink !== 1n || fileIdentity(current) !== identity) throw new Error('Memory binding lease identity changed.')
        const record: MemoryFileBindingRecord = { ...structuredClone(input), version: 1, revision: revision ?? randomUUID() }
        const target = memoryFileBindingRecordPath(workspace), temporary = path.join(workspace.rootDir, `.memory-binding-${randomUUID()}.tmp`)
        output = fs.openSync(temporary, 'wx', 0o600)
        fs.writeFileSync(output, JSON.stringify(record) + '\n', 'utf8'); fs.fsyncSync(output); fs.closeSync(output); output = undefined
        fs.renameSync(temporary, target)
        return record
      } catch (cause) {
        if (output !== undefined) try { fs.closeSync(output) } catch { /* Keep temporary + review lock for explicit recovery. */ }
        throw unknown(cause)
      }
    },
    release: () => { if (settled) throw unknown(new Error('Memory binding lease already settled.')); try { close(); remove(); settled = true } catch (cause) { throw unknown(cause) } },
    abandon: () => { if (settled) return; settled = true; try { close() } catch (cause) { throw unknown(cause) } /* Keep review evidence on disk; never auto-recover. */ }
  }
}
