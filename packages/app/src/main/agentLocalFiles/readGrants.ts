/* eslint-disable no-control-regex -- Explicitly reject control bytes in paths and non-text content. */
import { createHash, randomBytes } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import fs from 'node:fs/promises'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import { TextDecoder } from 'node:util'
import {
  AGENT_LOCAL_FILE_LIMITS as LIMITS,
  AgentLocalFileError,
  agentLocalFileScopeSchema,
  cancelLocalFileRequestSchema,
  parseAgentLocalFileValue,
  readLocalFileRequestSchema,
  readLocalFileResponseSchema,
  revokeLocalFilesRequestSchema,
  type AgentLocalFileGrant,
  type AgentLocalFileScope,
  type CancelLocalFileRequest,
  type ListLocalFilesResponse,
  type ReadLocalFileRequest,
  type ReadLocalFileResponse,
  type RevokeLocalFilesRequest
} from '@shared/api/svcAgentLocalFiles'
import { ServiceValidationError } from '@shared/api/apiUtils/serviceValidation'
import {
  DOCUMENT_TEXT_PROTOCOL,
  checkDocumentTextResult,
  type DocumentTextRequest,
  type DocumentTextFormat
} from './documents/documentSchema'
import type { DocumentProcessOutcome } from './documents/documentProcessSupervisor'

/** Main-owned dependency: bytes only. Its Promise must wait for actual utility process exit. */
export type LocalDocumentExtractor = {
  extract(request: DocumentTextRequest, signal: AbortSignal): Promise<DocumentProcessOutcome>
  dispose(): void
}

export type LocalFileReadParams = Omit<ReadLocalFileRequest, 'scope'>
export type LocalFileRevokeParams = Omit<RevokeLocalFilesRequest, 'scope'>
export type LocalFileCancelParams = Omit<CancelLocalFileRequest, 'scope'>

type Inspection = { path: string; chain: BigIntStats[]; stat: BigIntStats }
type Grant = {
  public: AgentLocalFileGrant
  senderId: number
  scopeKey: string
  root: Inspection
}
type Operation = {
  controller: AbortController
  senderId: number
  scopeKey: string
  deadline: number
  grant?: Grant
  authorizing: boolean
  awaitingDocumentExit: boolean
}

const readParamsSchema = readLocalFileRequestSchema.omit({ scope: true })
const revokeParamsSchema = revokeLocalFilesRequestSchema.omit({ scope: true })
const cancelParamsSchema = cancelLocalFileRequestSchema.omit({ scope: true })
const windows = process.platform === 'win32'
// libuv reports type 0 on Windows; native realpath must still yield a DOS path, never UNC.
// Elsewhere fail closed for unknown/network/FUSE filesystems.
const localFileSystems = new Set(
  windows
    ? [0n]
    : process.platform === 'darwin'
      ? [17n, 24n] // HFS, APFS
      : [
          0x5346544en, // NTFS
          0x4d44n, // FAT
          0x2011bab0n, // exFAT
          0xef53n, // ext
          0x58465342n, // XFS
          0x9123683en, // Btrfs
          0x01021994n, // tmpfs
          0x794c7630n, // overlay
          0x858458f6n, // ramfs
          0x2fc12fc1n, // ZFS
          0x15013346n, // UDF
          0x9660n // ISO
        ]
)
const credentialExtension =
  /\.(?:pem|key|p12|pfx|p8|ppk|jks|keystore|keychain|kdb|kdbx|credential|credentials|secret|token|crt|cer|der)$/i
const unsupportedExtension = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i
const binaryExtension =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|mp[34]|wav|ogg|flac|mov|avi|mkv|zip|gz|7z|rar|exe|dll|so|dylib|sqlite3?|db|woff2?|ttf|otf|psd)$/i

function fail(code: ConstructorParameters<typeof AgentLocalFileError>[0]): never {
  throw new AgentLocalFileError(code)
}

function safeError(error: unknown): AgentLocalFileError | ServiceValidationError {
  if (error instanceof AgentLocalFileError || error instanceof ServiceValidationError) return error
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return new AgentLocalFileError('NOT_FOUND')
  if (code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') {
    return new AgentLocalFileError('PATH_DENIED')
  }
  return new AgentLocalFileError('IO_ERROR')
}

function allowedComponent(component: string): boolean {
  if (!component || component.length > 255 || component === '.' || component === '..') return false
  if (/[<>:"|?*\u0000-\u001f\u007f]/.test(component) || /[. ]$/.test(component)) return false
  if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(component)) return false
  const lower = component.toLowerCase()
  // Keep all session databases, their journals/locks and backups outside this generic reader.
  if (lower === '.kohakuterrarium' || /\.(?:kohakutr|kt)(?:$|[-.])/.test(lower)) return false
  if (/\.(?:drives|lock|sqlite3?|db)(?:$|[-.])/.test(lower)) return false
  if (/^\.env(?:$|[._-])/.test(lower) || lower === '.envrc') return false
  if (
    /^(?:\.ssh|\.git|\.aws|\.azure|\.gnupg|\.kube|\.npmrc|\.netrc|\.pypirc|\.dockercfg)$/.test(
      lower
    )
  )
    return false
  if (/^(?:auth\.json|cookies?(?:$|[._-])|credentials?(?:$|[._-])|secrets?(?:$|[._-]))/.test(lower))
    return false
  return !credentialExtension.test(component)
}

function localAbsolute(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return fail('PATH_DENIED')
  }
  // Reject UNC, device namespaces, drive-relative paths and POSIX double-slash network paths.
  if (/^[\\/]{2}/.test(value) || !path.isAbsolute(value)) return fail('PATH_DENIED')
  if (windows ? !/^[A-Za-z]:[\\/]/.test(value) : value.includes('\\')) return fail('PATH_DENIED')
  const root = path.parse(value).root
  const components = value.slice(root.length).split(/[\\/]/)
  if (!components.length || components.some((part) => !allowedComponent(part)))
    return fail('PATH_DENIED')
  return path.resolve(value)
}

function samePath(a: string, b: string): boolean {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.isFile() === b.isFile() &&
    a.isDirectory() === b.isDirectory()
  )
}

function sameChain(a: Inspection, b: Inspection): boolean {
  return (
    a.chain.length === b.chain.length && a.chain.every((stat, i) => sameIdentity(stat, b.chain[i]))
  )
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    sameIdentity(a, b) &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.nlink === 1n &&
    b.nlink === 1n
  )
}

function checkSize(stat: BigIntStats, document = false, maxBytes: number = LIMITS.fileBytes): void {
  if (stat.size > BigInt(maxBytes)) fail('FILE_TOO_LARGE')
  if (!document && stat.size > BigInt(LIMITS.returnedBytes)) fail('TEXT_TOO_LARGE')
}

/** Main-internal, memory-only capabilities. authorize is ONLY for trusted native-dialog results. */
export class LocalFileReadGrants {
  private readonly grants = new Map<string, Grant>()
  private readonly operations = new Map<string, Operation>()

  constructor(private readonly documents?: LocalDocumentExtractor) {}

  async authorize(
    senderId: number,
    scope: AgentLocalFileScope,
    selectedPath: string,
    kind: AgentLocalFileGrant['kind']
  ): Promise<AgentLocalFileGrant> {
    const scopeKey = this.owner(senderId, scope)
    if (kind !== 'file' && kind !== 'directory')
      throw new ServiceValidationError('Local file service value')
    const selected = localAbsolute(selectedPath)
    this.prune()
    const pending = [...this.operations.values()].filter((op) => op.authorizing && !op.grant)
    if (
      this.grants.size + pending.length >= LIMITS.grants ||
      [...this.grants.values()].filter((grant) => grant.scopeKey === scopeKey).length +
        pending.filter((op) => op.scopeKey === scopeKey).length >=
        LIMITS.grantsPerScope
    )
      fail('GRANT_LIMIT')

    return this.run(
      senderId,
      scopeKey,
      `@${randomBytes(24).toString('base64url')}`,
      undefined,
      async (op) => {
        const root = await this.inspect(selected, op)
        if (kind === 'file' ? !root.stat.isFile() : !root.stat.isDirectory()) fail('PATH_DENIED')
        this.check(op)
        const grant: Grant = {
          senderId,
          scopeKey,
          root,
          public: {
            id: randomBytes(24).toString('base64url'),
            kind,
            name: path.basename(root.path),
            expiresAt: Date.now() + LIMITS.ttlMs,
            readOnly: true
          }
        }
        op.grant = grant
        this.grants.set(grant.public.id, grant)
        return { ...grant.public }
      }
    )
  }

  async read(
    senderId: number,
    scope: AgentLocalFileScope,
    params: LocalFileReadParams,
    // Main-owned callers may tighten, never expand, the existing file byte ceiling.
    limits: Readonly<{ maxBytes?: number }> = {}
  ): Promise<ReadLocalFileResponse> {
    const scopeKey = this.owner(senderId, scope)
    const req = parseAgentLocalFileValue(readParamsSchema, params)
    const grant = this.get(senderId, scopeKey, req.grantId)
    const requestedMaxBytes =
      limits.maxBytes === undefined
        ? undefined
        : Number.isFinite(limits.maxBytes)
          ? Math.max(1, Math.floor(limits.maxBytes!))
          : undefined
    return this.run(senderId, scopeKey, req.requestId, grant, async (op) => {
      const target = await this.target(grant, req.relativePath, op)
      if (!target.stat.isFile()) fail('PATH_DENIED')
      const extension = path.extname(target.path).slice(1).toLowerCase()
      const documentFormat: DocumentTextFormat | undefined =
        this.documents && ['pdf', 'docx', 'xlsx', 'pptx'].includes(extension)
          ? (extension as DocumentTextFormat)
          : undefined
      const maxBytes = Math.min(
        documentFormat ? LIMITS.documentBytes : LIMITS.fileBytes,
        requestedMaxBytes ?? (documentFormat ? LIMITS.documentBytes : LIMITS.fileBytes)
      )
      checkSize(target.stat, documentFormat !== undefined, maxBytes)
      if (!documentFormat && unsupportedExtension.test(target.path)) fail('UNSUPPORTED_FORMAT')
      if (binaryExtension.test(target.path)) fail('BINARY_FILE')

      // One read-only handle; nonblocking prevents a raced FIFO from hanging open on POSIX.
      const handle = await fs.open(
        target.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
      )
      try {
        this.check(op)
        const before = await handle.stat({ bigint: true })
        this.check(op)
        if (!before.isFile() || before.nlink !== 1n) fail('PATH_DENIED')
        checkSize(before, documentFormat !== undefined, maxBytes)
        if (!sameFile(target.stat, before)) fail('FILE_CHANGED')
        const opened = await this.inspect(target.path, op)
        if (!sameChain(target, opened) || !sameFile(before, opened.stat)) fail('FILE_CHANGED')

        // One extra byte detects growth, including an initially empty file. Never readFile/hash.
        const buffer = Buffer.alloc(Number(before.size) + 1)
        let length = 0
        while (length < buffer.length) {
          this.check(op)
          const { bytesRead } = await handle.read(
            buffer,
            length,
            Math.min(16 * 1024, buffer.length - length),
            length
          )
          this.check(op)
          if (bytesRead === 0) break
          length += bytesRead
        }
        const after = await handle.stat({ bigint: true })
        this.check(op)
        if (!sameFile(before, after) || BigInt(length) !== before.size) fail('FILE_CHANGED')
        const finished = await this.inspect(target.path, op)
        if (!sameChain(target, finished) || !sameFile(after, finished.stat)) fail('FILE_CHANGED')

        const bytes = buffer.subarray(0, length)
        const relativePath =
          grant.public.kind === 'file'
            ? ''
            : path.relative(grant.root.path, target.path).split(path.sep).join('/')
        if (documentFormat) {
          const jobId = randomBytes(16).toString('hex')
          const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
          op.awaitingDocumentExit = true
          let extracted: DocumentProcessOutcome
          try {
            extracted = await this.documents!.extract(
              {
                protocol: DOCUMENT_TEXT_PROTOCOL,
                jobId,
                format: documentFormat,
                bytes: new Uint8Array(bytes)
              },
              op.controller.signal
            )
          } finally {
            op.awaitingDocumentExit = false
          }
          this.check(op)
          // Keep the same open handle until parser closeout, then recheck file and path identity.
          const parsedStat = await handle.stat({ bigint: true })
          this.check(op)
          if (!sameFile(before, parsedStat)) fail('FILE_CHANGED')
          const parsedPath = await this.inspect(target.path, op)
          if (!sameChain(target, parsedPath) || !sameFile(parsedStat, parsedPath.stat))
            fail('FILE_CHANGED')
          this.check(op)
          const checked = checkDocumentTextResult(extracted, jobId, documentFormat)
          if (!checked.ok) {
            if (!extracted.ok && extracted.code === 'CANCELLED') fail('CANCELLED')
            if (!extracted.ok && extracted.code === 'TIMEOUT') fail('TIMEOUT')
            if (!extracted.ok && extracted.code === 'LIMIT') fail('DOCUMENT_LIMIT')
            if (!extracted.ok && extracted.code === 'INVALID') fail('INVALID_DOCUMENT')
            fail('EXTRACTION_FAILED')
          }
          const result = checked.result
          if (!result.ok) {
            const errors = {
              UNSUPPORTED: 'UNSUPPORTED_FORMAT',
              NO_TEXT: 'NO_TEXT',
              INVALID: 'INVALID_DOCUMENT',
              LIMIT: 'DOCUMENT_LIMIT',
              TIMEOUT: 'TIMEOUT',
              CANCELLED: 'CANCELLED',
              EXECUTION_FAILED: 'EXTRACTION_FAILED'
            } as const
            fail(errors[result.code])
          }
          const content = result.segments.map((segment) => segment.text).join('')
          const response = {
            name: path.basename(target.path),
            relativePath,
            content,
            encoding: 'utf-8' as const,
            sizeBytes: length,
            returnedBytes: Buffer.byteLength(content, 'utf8'),
            truncated: result.truncated,
            document: {
              format: documentFormat,
              sourceSha256,
              segments: result.segments,
              warnings: result.warnings
            }
          }
          if (Buffer.byteLength(JSON.stringify(response), 'utf8') > LIMITS.responseBytes)
            fail('DOCUMENT_LIMIT')
          const parsed = readLocalFileResponseSchema.safeParse(response)
          if (!parsed.success) fail('EXTRACTION_FAILED')
          this.check(op)
          return parsed.data
        }
        if (
          (bytes[0] === 0xff && bytes[1] === 0xfe) ||
          (bytes[0] === 0xfe && bytes[1] === 0xff) ||
          (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)
        )
          fail('INVALID_ENCODING')
        if (bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail('UNSUPPORTED_FORMAT')
        let content: string
        try {
          // Preserve a UTF-8 BOM so returnedBytes describes the exact encoded content.
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        } catch {
          return fail('INVALID_ENCODING')
        }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(content))
          fail('BINARY_FILE')
        return {
          name: path.basename(target.path),
          relativePath:
            grant.public.kind === 'file'
              ? ''
              : path.relative(grant.root.path, target.path).split(path.sep).join('/'),
          content,
          encoding: 'utf-8',
          sizeBytes: length,
          returnedBytes: length,
          truncated: false
        }
      } finally {
        await handle.close()
      }
    })
  }

  async list(
    senderId: number,
    scope: AgentLocalFileScope,
    params: LocalFileReadParams
  ): Promise<ListLocalFilesResponse> {
    const scopeKey = this.owner(senderId, scope)
    const req = parseAgentLocalFileValue(readParamsSchema, params)
    const grant = this.get(senderId, scopeKey, req.grantId)
    if (grant.public.kind !== 'directory') fail('PATH_DENIED')
    return this.run(senderId, scopeKey, req.requestId, grant, async (op) => {
      const target = await this.target(grant, req.relativePath, op)
      if (!target.stat.isDirectory()) fail('PATH_DENIED')
      const directory = await fs.opendir(target.path, { bufferSize: 1 })
      try {
        this.check(op)
        if (!sameChain(target, await this.inspect(target.path, op))) fail('FILE_CHANGED')
        const entries: ListLocalFilesResponse['entries'] = []
        let truncated = false
        // Bound inspected entries, not just returned entries (a directory may contain only secrets).
        for (let scanned = 0; scanned <= LIMITS.listEntries; scanned++) {
          this.check(op)
          const entry = await directory.read()
          this.check(op)
          if (!entry) break
          if (scanned === LIMITS.listEntries) {
            truncated = true
            break
          }
          if (!allowedComponent(entry.name) || entry.isSymbolicLink()) continue
          try {
            const child = await this.inspect(path.join(target.path, entry.name), op)
            if (!target.chain.every((stat, i) => sameIdentity(stat, child.chain[i])))
              fail('FILE_CHANGED')
            entries.push({
              name: entry.name,
              kind: child.stat.isDirectory() ? 'directory' : 'file'
            })
          } catch (error) {
            const safe = safeError(error)
            if (safe.code !== 'PATH_DENIED' && safe.code !== 'NOT_FOUND') throw safe
          }
        }
        if (!sameChain(target, await this.inspect(target.path, op))) fail('FILE_CHANGED')
        return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)), truncated }
      } finally {
        await directory.close()
      }
    })
  }

  revoke(senderId: number, scope: AgentLocalFileScope, params: LocalFileRevokeParams): void {
    const scopeKey = this.owner(senderId, scope)
    const req = parseAgentLocalFileValue(revokeParamsSchema, params)
    if (req.grantId !== undefined) {
      this.drop(this.get(senderId, scopeKey, req.grantId))
      return
    }
    for (const grant of this.grants.values()) {
      if (grant.senderId === senderId && grant.scopeKey === scopeKey) this.drop(grant)
    }
    for (const op of this.operations.values()) {
      if (op.senderId === senderId && op.scopeKey === scopeKey)
        op.controller.abort(new AgentLocalFileError('GRANT_DENIED'))
    }
  }

  /** Main window/scope lifecycle, never a renderer-selected sender identity. */
  revokeSender(senderId: number): void {
    // Abort with the scope reason before dropping grants, whose ordinary revoke reason differs.
    for (const op of this.operations.values()) {
      if (op.senderId === senderId) op.controller.abort(new AgentLocalFileError('SCOPE_CHANGED'))
    }
    for (const grant of this.grants.values()) {
      if (grant.senderId === senderId) this.drop(grant)
    }
  }

  cancel(senderId: number, scope: AgentLocalFileScope, params: LocalFileCancelParams): void {
    const scopeKey = this.owner(senderId, scope)
    const req = parseAgentLocalFileValue(cancelParamsSchema, params)
    this.operations
      .get(this.operationKey(senderId, scopeKey, req.requestId))
      ?.controller.abort(new AgentLocalFileError('CANCELLED'))
  }

  /** Recheck at the service delivery boundary after all async work, not just inside read(). */
  assertDeliveryAuthorized(senderId: number, scope: AgentLocalFileScope, grantId: string): void {
    const scopeKey = this.owner(senderId, scope)
    const id = parseAgentLocalFileValue(revokeParamsSchema, { grantId }).grantId!
    this.get(senderId, scopeKey, id)
  }

  private owner(senderId: number, scope: AgentLocalFileScope): string {
    if (!Number.isSafeInteger(senderId) || senderId < 0)
      throw new ServiceValidationError('Local file service value')
    const parsed = parseAgentLocalFileValue(agentLocalFileScopeSchema, scope)
    return JSON.stringify([parsed.projectId, parsed.paneId, parsed.sessionId])
  }

  private operationKey(senderId: number, scopeKey: string, requestId: string): string {
    return JSON.stringify([senderId, scopeKey, requestId])
  }

  private get(senderId: number, scopeKey: string, id: string): Grant {
    this.prune()
    const grant = this.grants.get(id)
    if (!grant || grant.senderId !== senderId || grant.scopeKey !== scopeKey)
      return fail('GRANT_DENIED')
    return grant
  }

  private prune(): void {
    for (const grant of this.grants.values()) {
      if (grant.public.expiresAt <= Date.now()) this.drop(grant)
    }
  }

  private drop(grant: Grant): void {
    this.grants.delete(grant.public.id)
    for (const op of this.operations.values()) {
      if (op.grant === grant) op.controller.abort(new AgentLocalFileError('GRANT_DENIED'))
    }
  }

  private check(op: Operation): void {
    if (!op.controller.signal.aborted && performance.now() >= op.deadline) {
      op.controller.abort(new AgentLocalFileError('TIMEOUT'))
    }
    if (op.controller.signal.aborted) throw op.controller.signal.reason
    if (
      op.grant &&
      (this.grants.get(op.grant.public.id) !== op.grant || op.grant.public.expiresAt <= Date.now())
    ) {
      fail('GRANT_DENIED')
    }
  }

  private async run<T>(
    senderId: number,
    scopeKey: string,
    requestId: string,
    grant: Grant | undefined,
    work: (op: Operation) => Promise<T>
  ): Promise<T> {
    const key = this.operationKey(senderId, scopeKey, requestId)
    if (this.operations.has(key) || this.operations.size >= LIMITS.grants) fail('BUSY')
    const op: Operation = {
      controller: new AbortController(),
      senderId,
      scopeKey,
      grant,
      authorizing: grant === undefined,
      awaitingDocumentExit: false,
      deadline: performance.now() + LIMITS.deadlineMs
    }
    this.operations.set(key, op)
    const timer = setTimeout(
      () => op.controller.abort(new AgentLocalFileError('TIMEOUT')),
      LIMITS.deadlineMs
    )
    timer.unref()
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(op.controller.signal.reason)
      op.controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const task = Promise.resolve().then(() => {
      this.check(op)
      return work(op)
    })
    const cleanup = (): void => {
      clearTimeout(timer)
      op.controller.signal.removeEventListener('abort', onAbort)
      this.operations.delete(key)
    }
    try {
      const result = await Promise.race([task, aborted])
      // No await after this check: revocation/expiry cannot interleave with the returned result.
      this.check(op)
      return result
    } catch (error) {
      // A document cancellation/timeout is not complete at a kill request. The extractor
      // retains its process slot and resolves only at native exit; retain the file handle too.
      if (op.awaitingDocumentExit) await task.catch(() => {})
      if (op.authorizing && op.grant) this.drop(op.grant)
      throw safeError(error)
    } finally {
      // An OS call cannot always be aborted. Retain its slot until its finally closes the handle.
      void task.then(cleanup, cleanup)
    }
  }

  private async inspect(selected: string, op: Operation): Promise<Inspection> {
    this.check(op)
    const absolute = localAbsolute(selected)
    const root = path.parse(absolute).root
    const components = absolute.slice(root.length).split(path.sep)
    let current = root
    const chain: BigIntStats[] = []
    for (let i = -1; i < components.length; i++) {
      if (i >= 0) current = path.join(current, components[i])
      const stat = await fs.lstat(current, { bigint: true })
      this.check(op)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('PATH_DENIED')
      if (i < components.length - 1 && !stat.isDirectory()) fail('PATH_DENIED')
      if (stat.isFile() && stat.nlink !== 1n) fail('PATH_DENIED')
      chain.push(stat)
    }
    const canonical = localAbsolute(await fs.realpath(absolute))
    this.check(op)
    if (!samePath(absolute, canonical)) fail('PATH_DENIED')
    const fileSystem = await fs.statfs(absolute, { bigint: true })
    this.check(op)
    if (!localFileSystems.has(BigInt.asUintN(32, fileSystem.type))) fail('PATH_DENIED')
    return { path: canonical, chain, stat: chain[chain.length - 1] }
  }

  private async target(
    grant: Grant,
    relativePath: string | undefined,
    op: Operation
  ): Promise<Inspection> {
    const relative = relativePath ?? ''
    if (
      relative.length > 4096 ||
      path.isAbsolute(relative) ||
      path.win32.isAbsolute(relative) ||
      (relative && relative.split(/[\\/]/).some((part) => !allowedComponent(part)))
    )
      fail('PATH_DENIED')
    if (grant.public.kind === 'file' && relative !== '') fail('PATH_DENIED')
    const root = await this.inspect(grant.root.path, op)
    if (!sameChain(grant.root, root)) fail('FILE_CHANGED')
    if (!relative) return root
    const childPath = path.resolve(root.path, ...relative.split(/[\\/]/))
    const containment = path.relative(root.path, childPath)
    if (
      !containment ||
      containment === '..' ||
      containment.startsWith(`..${path.sep}`) ||
      path.isAbsolute(containment)
    )
      fail('PATH_DENIED')
    const child = await this.inspect(childPath, op)
    if (!root.chain.every((stat, i) => sameIdentity(stat, child.chain[i]))) fail('FILE_CHANGED')
    return child
  }
}
