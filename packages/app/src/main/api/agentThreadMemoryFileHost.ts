import fs, { type BigIntStats } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import type { AssistantRoute, AssistantRunToolProvider } from '../assistantRuntime/types'
import { acquireMemoryFileBindingLease, memoryFileBindingLockPath, memoryFileRouteIdentity, readMemoryFileBindingRecord, type MemoryFileBindingLease } from '../assistantRuntime/memoryFileBinding'
import { getAssistantWorkspaceState } from '../assistantRuntime/workspace'
import type { MemoryFileSession } from './agentThreadMemoryFiles'

type Result = Awaited<ReturnType<MemoryFileSession['callTool']>>
type Pin = { file: string; identity: string }
type Chain = { existing: Pin[]; absent: string[] }
type ReadReceipt = { chain: Chain; preimage: string | null; content?: string; fileIdentity?: string; step: number; generation: string | null }
export type MemoryFileWriteApproval = {
  conversationId: string; routeIdentity: [string, string, string, string | null]; workspaceId: string; bindingRevision: string | null
  namespace: string; namespaceGeneration: string | null; namespaceCreation: boolean
  ancestorDigest: string; path: string; content: string; create: boolean; preimage: string | null
  parentRunId: string; parentToolCallId: string; childRunId: string; operationId: string
}
export type MemoryFileHostOptions = {
  route: AgentRouteLike; conversationId: string; writable: boolean; childRunId: string; parentRunId: string; parentToolCallId: string
  signal: AbortSignal; assertLive(): void
  /** MAIN-only exact-payload approval; return a synchronous one-shot permit consumer. */
  approve(input: MemoryFileWriteApproval, signal: AbortSignal): Promise<() => void>
  /** Existing execution adapter: persist intent BEFORE calling the supplied private provider. */
  durable(provider: AssistantRunToolProvider, args: Record<string, unknown>, context: Parameters<AssistantRunToolProvider['callTool']>[2]): Promise<Result>
}
const FILE_BYTES = 8192, MAX_ENTRIES = 64, NAMESPACE_BYTES = 256 * 1024
const OWNER = '.owner.json', LOCK = '.writer-lock', SNAPSHOTS = '.snapshots'
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const same = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code
const unknownOutcome = (cause: unknown) => Object.assign(new Error('Memory write may have partial effects; review required.', { cause }), { code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' })
class MemoryPrecommitRejection extends Error {}
function boundedDirectory(directory: string, limit: number, check: () => void): fs.Dirent[] {
  const handle = fs.opendirSync(directory, { bufferSize: 16 }), entries: fs.Dirent[] = []
  try {
    for (;;) {
      check()
      const entry = handle.readSync()
      if (!entry) return entries
      entries.push(entry)
      if (entries.length > limit) throw new MemoryPrecommitRejection('Memory directory capacity exceeded.')
    }
  } finally { handle.closeSync() }
}
function identity(stat: BigIntStats): string {
  if (stat.ino <= 0n || stat.birthtimeNs <= 0n) throw new Error('Memory filesystem identity is unavailable; cannot fall back to path strings.')
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}
const statMaybe = (file: string) => { try { return fs.lstatSync(file, { bigint: true }) } catch (error) { if (code(error) === 'ENOENT') return undefined; throw error } }
function chainTo(directory: string): Chain {
  const absolute = path.resolve(directory), root = path.parse(absolute).root, parts = absolute.slice(root.length).split(path.sep).filter(Boolean)
  const existing: Pin[] = [], absent: string[] = []
  let current = root, missing = false
  for (const segment of ['', ...parts]) {
    if (segment) current = path.join(current, segment)
    const stat = missing ? undefined : statMaybe(current)
    if (!stat) { missing = true; absent.push(current); continue }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(fs.realpathSync.native(current), current)) throw new Error(`Memory directory path traverses a link or non-directory at ${current}; canonical=${fs.realpathSync.native(current)}.`)
    existing.push({ file: current, identity: identity(stat) })
  }
  return { existing, absent }
}
function verifyChain(expected: Chain): void {
  const last = expected.absent.at(-1) ?? expected.existing.at(-1)?.file
  if (!last || JSON.stringify(chainTo(last)) !== JSON.stringify(expected)) throw new Error('Memory directory identity changed; review required.')
}
function fullRead(file: string, maxBytes: number): { content: string; digest: string; identity: string } {
  const before = fs.lstatSync(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes) || !same(fs.realpathSync.native(file), file)) throw new Error('Memory path is not a bounded unlinked regular file.')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || identity(opened) !== identity(before)) throw new Error('Memory file identity changed before read.')
    const bytes = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < bytes.length) { const count = fs.readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count }
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true })
    if (length > maxBytes || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || identity(after) !== identity(before) || identity(current) !== identity(before) || current.nlink !== 1n || current.isSymbolicLink()) throw new Error('Memory file changed during complete read.')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    if (content.includes('\0')) throw new Error('Memory file is not supported UTF-8 text.')
    return { content, digest: sha(bytes.subarray(0, length)), identity: identity(after) }
  } finally { fs.closeSync(fd) }
}
function relativePath(input: unknown, directory = false): string {
  if (input === undefined && directory) return ''
  if (typeof input !== 'string' || input.length > 384 || /[\\:]/.test(input) || [...input].some(character => character.charCodeAt(0) < 32)) throw new Error('Invalid memory path.')
  if (directory && (input === './memory' || input === './memory/')) return ''
  if (!input.startsWith('./memory/')) throw new Error('Memory path must be a virtual ./memory relative path.')
  const parts = input.slice(9).split('/')
  if (!parts.length || parts.length > 6 || parts.some(part => !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(part) || part.endsWith('.') || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('Invalid or reserved memory path.')
  if (!directory && !/\.(?:md|txt|json)$/.test(parts.at(-1)!)) throw new Error('Memory path requires a supported text extension.')
  return parts.join('/')
}
const pathSchema = { type: 'string', maxLength: 384, description: 'Virtual ./memory path only; lowercase ASCII names, no absolute/root/parent overrides.' }
const definitions = [
  { name: 'memory.files.tree', description: 'List bounded confined memory-file paths, never general filesystem paths.', inputSchema: { type: 'object', additionalProperties: false, properties: { path: pathSchema } } },
  { name: 'memory.files.read', description: 'Read one complete bounded UTF-8 memory file, or observe absence. Must read in an earlier model step before updating/creating.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: pathSchema } } },
  { name: 'memory.files.grep', description: 'Literal bounded memory-file content search; not a successful full-file read receipt.', inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 128 } } } },
  { name: 'memory.files.write', description: 'Formally approved complete memory-file replacement after a successful earlier-step read in this child; create:true only after observed absence.', inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'content', 'create'], properties: { path: pathSchema, content: { type: 'string', maxLength: FILE_BYTES }, create: { type: 'boolean' } } } }
]
function ownedRemove(file: string, expected: string): void {
  const current = statMaybe(file)
  if (!current || !current.isFile() || current.isSymbolicLink() || identity(current) !== expected || current.nlink !== 1n) throw new Error('Memory staging/lock identity changed; review required.')
  fs.unlinkSync(file)
}
function createExclusive(file: string, content: string): { identity: string; fd: number } {
  const fd = fs.openSync(file, 'wx', 0o600)
  let createdIdentity: string | undefined, descriptorOpen = true
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    createdIdentity = identity(stat)
    if (!stat.isFile() || stat.nlink !== 1n || createdIdentity !== identity(fs.lstatSync(file, { bigint: true }))) throw new Error('Memory exclusive file identity changed.')
    fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd)
    return { identity: createdIdentity, fd }
  } catch (error) {
    try {
      fs.closeSync(fd); descriptorOpen = false
      if (!createdIdentity) throw new Error('Exclusive memory file ownership unavailable.')
      ownedRemove(file, createdIdentity)
    } catch (cleanup) { throw unknownOutcome(cleanup) }
    finally { if (descriptorOpen) try { fs.closeSync(fd) } catch { /* Unknown effect already reported. */ } }
    throw error
  }
}

/** Bounded synchronous commit, controlled MAIN writers + stable ancestors only.
 * NOT an OS-level CAS or sandbox against an uncooperative external host process. */
export function createMemoryFileSession(options: MemoryFileHostOptions): MemoryFileSession {
  const route = Object.freeze(normalizeAgentRoute(structuredClone(options.route))) as Readonly<AssistantRoute>, key = getAgentSessionKey(route), routeIdentity = memoryFileRouteIdentity(route), exactRoute = JSON.stringify(routeIdentity)
  const { conversationId, writable, childRunId, parentRunId, parentToolCallId, signal } = options
  if (!conversationId || !childRunId || !parentRunId || !parentToolCallId) throw new Error('Memory session requires immutable MAIN owner identity.')
  const workspace = getAssistantWorkspaceState(route), root = path.join(workspace.memoryDir, '.agent-memory-v1'), ownerFile = path.join(root, OWNER)
  const creationGeneration = randomUUID()
  let pinned = chainTo(root), generation: string | null = null, ownerIdentity: string | undefined, closed = false
  const receipts = new Map<string, ReadReceipt>()
  let bindingLease: MemoryFileBindingLease | undefined
  const readBinding = () => {
    if (!bindingLease && statMaybe(memoryFileBindingLockPath(workspace))) throw new Error('Memory binding has a live/interrupted writer; review required.')
    const incarnation = readMemoryFileBindingRecord(workspace)
    if (incarnation?.routeIdentity && JSON.stringify(incarnation.routeIdentity) !== exactRoute) throw new Error('Memory binding owner route collision; review required.')
    if (!statMaybe(workspace.contextFile)) {
      if (incarnation?.present) throw new Error('Memory binding/context publication is incomplete; review required.')
      return { present: false, workspaceId: workspace.workspaceId, revision: null as string | null, incarnation: incarnation?.revision ?? null }
    }
    const record = JSON.parse(fullRead(workspace.contextFile, 64 * 1024).content)
    if (record.sessionKey !== key || !record.route || JSON.stringify(memoryFileRouteIdentity(record.route)) !== exactRoute || typeof record.workspaceId !== 'string' || !record.workspaceId.trim() || record.workspaceId.length > 120 || record.memoryBindingRevision !== undefined && (typeof record.memoryBindingRevision !== 'string' || !/^[a-f0-9-]{36}$/.test(record.memoryBindingRevision))) throw new Error('Memory route owner collision or invalid workspace mapping.')
    if (incarnation && (!incarnation.present || JSON.stringify(incarnation.routeIdentity) !== exactRoute || incarnation.workspaceId !== record.workspaceId || incarnation.revision !== record.memoryBindingRevision)) throw new Error('Memory binding/context incarnation mismatch; review required.')
    return { present: true, workspaceId: record.workspaceId as string, revision: record.memoryBindingRevision as string | undefined ?? null, incarnation: incarnation?.revision ?? null }
  }
  const binding = Object.freeze(readBinding())
  const check = () => { signal.throwIfAborted(); if (closed) throw new Error('Memory file session closed.'); options.assertLive(); verifyChain(pinned); checkRoute() }
  function checkRoute(): void {
    if (JSON.stringify(readBinding()) !== JSON.stringify(binding)) throw new Error('Memory workspace binding changed or disappeared; start a fresh child.')
  }
  function inspectOwner(): void {
    if (pinned.absent.length) return
    const stat = statMaybe(ownerFile)
    if (!stat) throw new Error('Existing memory namespace has no owner; review required, never adopt.')
    const read = fullRead(ownerFile, 4096), owner = JSON.parse(read.content)
    if (owner.version !== 2 || owner.routeKey !== key || JSON.stringify(owner.routeIdentity) !== exactRoute || typeof owner.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.generation)) throw new Error('Memory namespace owner identity is invalid.')
    if (generation !== null && (owner.generation !== generation || read.identity !== ownerIdentity)) throw new Error('Memory namespace owner generation changed; review required.')
    generation = owner.generation; ownerIdentity = read.identity
  }
  check(); inspectOwner()
  if (statMaybe(path.join(root, LOCK))) throw new Error('Memory namespace has a live/interrupted writer; review required.')
  function readPath(relative: string, step: number, issue: boolean): ReadReceipt {
    check(); inspectOwner()
    const file = path.join(root, relative), chain = chainTo(path.dirname(file)), stat = statMaybe(file)
    const observed = stat ? fullRead(file, FILE_BYTES) : undefined
    verifyChain(chain); check(); inspectOwner()
    const receipt: ReadReceipt = { chain, generation, preimage: observed?.digest ?? null, ...(observed ? { content: observed.content, fileIdentity: observed.identity } : {}), step }
    if (issue) receipts.set(relative, receipt)
    return receipt
  }
  function verifyReceipt(relative: string, receipt: ReadReceipt): void {
    check(); inspectOwner(); verifyChain(receipt.chain)
    const current = readPath(relative, receipt.step, false)
    if (receipt.generation !== generation || current.preimage !== receipt.preimage || current.fileIdentity !== receipt.fileIdentity) throw new Error('Memory file preimage changed; read conflict, no overwrite.')
  }
  function walk(relative = ''): string[] {
    check(); inspectOwner()
    const target = path.join(root, relative), chain = chainTo(target)
    if (chain.absent.length) return []
    const found: string[] = []
    let entriesSeen = 0
    const visit = (dir: string, prefix: string, depth: number) => {
      check(); verifyChain(chain)
      const directoryChain = chainTo(dir)
      if (directoryChain.absent.length) throw new Error('Memory tree directory changed.')
      if (depth > 6) throw new Error('Memory tree depth limit exceeded.')
      const entries = boundedDirectory(dir, MAX_ENTRIES * 2, () => { check(); verifyChain(directoryChain) }).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (!prefix && [OWNER, LOCK, SNAPSHOTS].includes(entry.name)) continue
        if (++entriesSeen > MAX_ENTRIES * 2) throw new Error('Memory tree entry limit exceeded.')
        verifyChain(directoryChain)
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isSymbolicLink()) throw new Error('Memory tree contains a link.')
        if (entry.isDirectory()) { relativePath(`./memory/${rel}`, true); visit(path.join(dir, entry.name), rel, depth + 1) }
        else { relativePath(`./memory/${rel}`); fullRead(path.join(root, rel), FILE_BYTES); found.push(rel) }
        if (found.length > MAX_ENTRIES) throw new Error('Memory namespace entry limit exceeded.')
      }
      verifyChain(directoryChain)
    }
    visit(target, relative, 0); check(); return found
  }
  function checkCapacity(relative: string, receipt: ReadReceipt, content: string): void {
    check(); inspectOwner()
    const snapshotRoot = path.join(root, SNAPSHOTS), snapshotChain = chainTo(snapshotRoot)
    if (!snapshotChain.absent.length && boundedDirectory(snapshotRoot, 64, () => { check(); verifyChain(snapshotChain) }).length >= 64) throw new MemoryPrecommitRejection('Memory recovery snapshots are full; explicit maintenance required.')
    const files = walk(), bytes = files.reduce((sum, rel) => sum + Number(fs.lstatSync(path.join(root, rel), { bigint: true }).size), 0)
    if ((receipt.preimage === null && files.length >= MAX_ENTRIES) || bytes - Buffer.byteLength(receipt.content ?? '') + Buffer.byteLength(content) > NAMESPACE_BYTES) throw new MemoryPrecommitRejection(`Memory namespace capacity exceeded for ./memory/${relative}.`)
  }
  return {
    listTools: () => structuredClone(definitions.filter(tool => tool.name !== (writable ? 'memory.files.grep' : 'memory.files.write'))),
    close: () => { closed = true; receipts.clear() },
    async callTool(name, args, context) {
      const input = structuredClone(args), owner = { route: structuredClone(context.route), runId: context.runId, toolCallId: context.toolCallId, modelStep: context.modelStep }
      check()
      if (owner.runId !== childRunId || JSON.stringify(memoryFileRouteIdentity(owner.route)) !== exactRoute || !owner.toolCallId || !Number.isSafeInteger(owner.modelStep) || owner.modelStep < 1) throw new Error('Memory call belongs to another child/session.')
      if (name === 'memory.files.tree') {
        if (Object.keys(input).some(key => key !== 'path')) throw new Error('Invalid memory tree arguments.')
        const relative = relativePath(input.path, true), entries = walk(relative)
        return { content: JSON.stringify({ path: relative ? `./memory/${relative}` : './memory', entries: entries.map(file => `./memory/${file}`), namespaceExists: !pinned.absent.length, complete: true }) }
      }
      if (name === 'memory.files.read') {
        if (Object.keys(input).some(key => key !== 'path')) throw new Error('Invalid memory read arguments.')
        const relative = relativePath(input.path), observed = readPath(relative, owner.modelStep, false)
        const content = JSON.stringify({ path: `./memory/${relative}`, exists: observed.preimage !== null, ...(observed.preimage !== null ? { content: observed.content, sha256: observed.preimage } : {}), complete: true })
        if (Buffer.byteLength(content) > 40 * 1024) throw new Error('Memory read exceeds complete-result budget.')
        receipts.set(relative, observed)
        return { content }
      }
      if (name === 'memory.files.grep' && !writable) {
        if (Object.keys(input).some(key => key !== 'query') || typeof input.query !== 'string' || !input.query.length || input.query.length > 128) throw new Error('Invalid memory grep arguments.')
        const matches: Array<{ path: string; line: number; excerpt: string }> = []
        let truncated = false
        for (const file of walk()) {
          const read = readPath(file, owner.modelStep, false)
          for (const [index, line] of (read.content ?? '').split(/\r?\n/).entries()) if (line.includes(input.query)) {
            if (matches.length >= 16) { truncated = true; break }
            matches.push({ path: `./memory/${file}`, line: index + 1, excerpt: line.slice(0, 512) })
          }
        }
        return { content: JSON.stringify({ query: input.query, matches, truncated }) }
      }
      if (name !== 'memory.files.write' || !writable) throw new Error('Unavailable memory-file tool; read-only helpers cannot write.')
      const relative = relativePath(input.path)
      if (Object.keys(input).some(key => !['path', 'content', 'create'].includes(key)) || typeof input.content !== 'string' || input.content.includes('\0') || Buffer.byteLength(input.content) > FILE_BYTES || typeof input.create !== 'boolean') throw new Error('Invalid bounded memory write arguments.')
      const receipt = receipts.get(relative)
      if (!receipt) throw new Error('Must read before a memory write in this child session.')
      if (receipt.step >= owner.modelStep) throw new Error('Memory write requires a later model step than the complete read.')
      if (input.create !== (receipt.preimage === null)) throw new Error('Memory create/overwrite condition conflicts with the observed preimage.')
      verifyReceipt(relative, receipt)
      checkCapacity(relative, receipt, input.content)
      const operationId = sha(JSON.stringify([parentRunId, parentToolCallId, owner.toolCallId.replace(childRunId, 'child'), relative]))
      const approval: MemoryFileWriteApproval = Object.freeze({ conversationId, routeIdentity: structuredClone(routeIdentity), workspaceId: binding.workspaceId, bindingRevision: binding.incarnation ?? binding.revision, namespace: root, namespaceGeneration: generation ?? creationGeneration, namespaceCreation: pinned.absent.length > 0, ancestorDigest: sha(JSON.stringify(receipt.chain)), path: `./memory/${relative}`, content: input.content, create: input.create, preimage: receipt.preimage, parentRunId, parentToolCallId, childRunId, operationId })
      const tuple = structuredClone(approval) as unknown as Record<string, unknown>, lockFile = path.join(root, LOCK)
      let lock: { identity: string; fd: number } | undefined, effects = false, committed = false
      const privateProvider: AssistantRunToolProvider = {
        listTools: () => [{ ...definitions[3], inputSchema: { type: 'object' } }],
        async callTool(tool, actual, execution) {
          check()
          if (tool !== 'memory.files.write' || sha(JSON.stringify(actual)) !== sha(JSON.stringify(tuple)) || JSON.stringify(memoryFileRouteIdentity(execution.route)) !== exactRoute || execution.runId !== parentRunId || execution.toolCallId !== `memory-write-${operationId}`) throw new Error('Memory write immutable runtime invocation conflict.')
          verifyReceipt(relative, receipt)
          const consume = await options.approve(structuredClone(approval), signal)
          check(); verifyReceipt(relative, receipt)
          checkCapacity(relative, receipt, approval.content)
          if (statMaybe(lockFile)) throw new Error('Memory namespace has a live/interrupted writer; review required.')
          consume(); check()
          // No await from the last authorization check through all bounded filesystem effects.
          try {
            let creationChain = pinned
            const acquireBinding = () => { bindingLease = acquireMemoryFileBindingLease(workspace); effects = true; checkRoute() }
            if (statMaybe(workspace.rootDir)) acquireBinding()
            for (const directory of pinned.absent) {
              options.assertLive(); signal.throwIfAborted(); verifyChain(creationChain)
              effects = true; fs.mkdirSync(directory); creationChain = chainTo(root)
              if (same(directory, workspace.rootDir)) acquireBinding()
            }
            if (!bindingLease) throw new Error('Memory MAIN mapping lease is unavailable.')
            const creating = pinned.absent.length > 0
            lock = createExclusive(lockFile, JSON.stringify({ operationId, owner: randomUUID(), pid: process.pid }) + '\n')
            effects = true
            if (creating) {
              generation = creationGeneration
              const marker = createExclusive(ownerFile, JSON.stringify({ version: 2, routeKey: key, routeIdentity, generation }) + '\n'); fs.closeSync(marker.fd)
              pinned = chainTo(root); ownerIdentity = marker.identity
            }
            check(); inspectOwner()
            checkCapacity(relative, receipt, approval.content)
            const file = path.join(root, relative), parentChain = chainTo(path.dirname(file))
            for (const directory of parentChain.absent) { check(); fs.mkdirSync(directory) }
            const commitChain = chainTo(path.dirname(file)), snapshotRoot = path.join(root, SNAPSHOTS)
            check(); verifyChain(commitChain)
            if (statMaybe(snapshotRoot)) { if (chainTo(snapshotRoot).absent.length) throw new Error('Memory snapshot directory is unavailable.') }
            else fs.mkdirSync(snapshotRoot)
            const snapshotChain = chainTo(snapshotRoot)
            verifyChain(snapshotChain)
            const snapshot = createExclusive(path.join(snapshotRoot, `${operationId}.json`), JSON.stringify({ operationId, path: approval.path, preimage: receipt.preimage, content: receipt.content ?? null }) + '\n'); fs.closeSync(snapshot.fd)
            check(); verifyChain(commitChain); verifyChain(snapshotChain)
            const tempFile = path.join(path.dirname(file), `.pending-${operationId}-${randomUUID()}.tmp`), temp = createExclusive(tempFile, approval.content)
            fs.closeSync(temp.fd)
            try {
              check(); verifyChain(commitChain); inspectOwner()
              const current = statMaybe(file) ? fullRead(file, FILE_BYTES) : undefined
              if ((current?.digest ?? null) !== receipt.preimage || current?.identity !== receipt.fileIdentity) throw new Error('Memory preimage changed during staging; conflict.')
              check(); verifyChain(commitChain)
              if (approval.create) {
                // Atomic no-clobber only; never fall back to replacing rename. The
                // owned temp is briefly a second link, then removed before reporting.
                fs.linkSync(tempFile, file)
                const linked = fs.lstatSync(file, { bigint: true })
                if (identity(linked) !== temp.identity || linked.nlink !== 2n) throw new Error('Memory exclusive create identity is uncertain.')
                fs.unlinkSync(tempFile)
              } else fs.renameSync(tempFile, file)
              committed = true; check(); verifyChain(commitChain)
              const after = fullRead(file, FILE_BYTES)
              if (after.digest !== sha(approval.content)) throw new Error('Memory committed output identity changed; review required.')
              receipts.delete(relative)
              return { content: JSON.stringify({ path: approval.path, written: true, created: approval.create, sha256: after.digest, operationId }), metadata: { source: 'memory-file-write', operationId } }
            } finally {
              const left = statMaybe(tempFile)
              if (left && !committed && left.nlink === 1n && identity(left) === temp.identity) ownedRemove(tempFile, temp.identity)
            }
          } catch (error) {
            if (error instanceof MemoryPrecommitRejection && !approval.namespaceCreation && !committed && lock) {
              try {
                fs.closeSync(lock.fd); const held = lock; lock = undefined; check(); ownedRemove(lockFile, held.identity)
                bindingLease?.release(); bindingLease = undefined
              }
              catch (cleanup) { throw unknownOutcome(cleanup) }
              throw error
            }
            if (effects) throw unknownOutcome(error)
            throw error
          }
        }
      }
      try {
        const result = await options.durable(privateProvider, tuple, { route, runId: parentRunId, toolCallId: `memory-write-${operationId}`, signal })
        if (lock) {
          try { fs.closeSync(lock.fd); const held = lock; lock = undefined; check(); ownedRemove(lockFile, held.identity) }
          catch (cleanup) { throw unknownOutcome(cleanup) }
        }
        if (bindingLease) { bindingLease.release(); bindingLease = undefined }
        return result
      } catch (error) {
        const cleanupErrors: unknown[] = []
        if (lock) {
          const held = lock; lock = undefined // Keep the review lock; never adopt it after interruption.
          try { fs.closeSync(held.fd) } catch (cleanup) { cleanupErrors.push(cleanup) }
        }
        if (bindingLease) {
          const held = bindingLease; bindingLease = undefined
          try { held.abandon() } catch (cleanup) { cleanupErrors.push(cleanup) }
        }
        if (cleanupErrors.length) throw unknownOutcome(new AggregateError([error, ...cleanupErrors], 'Memory journal/cleanup failed; original outcome evidence retained.'))
        throw error
      }
    }
  }
}
