import { createHash, randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import path from 'node:path'
import type { PolicyRequest } from '../../../shared/magicAgentPlatform2'
import type { MagicAgentPolicyAuthorizationService } from '../policy'

const LIMITS = Object.freeze({
  bytes: 8 * 1024 * 1024,
  cells: 1000,
  sourceBytes: 1024 * 1024,
  metadataBytes: 1024 * 1024,
  outputs: 1000,
  outputBytes: 4 * 1024 * 1024,
  mimeEntries: 256,
  ids: 256,
  depth: 32,
  list: 1000
})
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type CellType = 'markdown' | 'code' | 'raw'
type NotebookCell = {
  id: string
  cell_type: CellType
  source: string[]
  metadata: Record<string, Json>
  execution_count?: number | null
  outputs?: Json[]
  attachments?: Record<string, Json>
}
type Notebook = {
  nbformat: 4
  nbformat_minor: number
  metadata: Record<string, Json>
  cells: NotebookCell[]
}
type ToolName =
  | 'notebook.list'
  | 'notebook.read'
  | 'notebook.insert'
  | 'notebook.replace'
  | 'notebook.delete'
  | 'notebook.convert'
  | 'notebook.clear-outputs'
type AuthorizedCall<T> = Readonly<{
  authorizationId: string
  idempotencyKey: string
  request: PolicyRequest
  input: T
  grantId?: string
  expectedGrantUseCount?: number
  signal?: AbortSignal
}>
export type NotebookFs = Pick<
  typeof nodeFs,
  | 'realpath'
  | 'stat'
  | 'lstat'
  | 'readFile'
  | 'readdir'
  | 'mkdir'
  | 'open'
  | 'rename'
  | 'unlink'
  | 'chmod'
>
export type NotebookAuditEvidence = Readonly<{
  tool: ToolName
  path: string
  outcome: 'completed' | 'rejected'
  beforeSha256?: string
  afterSha256?: string
  cellIds?: string[]
  cellCount?: number
  snapshotId?: string
}>

export class NotebookToolValidationError extends Error {
  readonly code = 'MAGIC_AGENT_NOTEBOOK_VALIDATION'
  constructor(message: string) {
    super(message)
    this.name = 'NotebookToolValidationError'
  }
}
export class NotebookToolAuthorizationError extends Error {
  readonly code = 'MAGIC_AGENT_NOTEBOOK_AUTHORIZATION'
  constructor(
    readonly status: 'denied' | 'awaiting-approval' | 'already-consumed',
    message: string
  ) {
    super(message)
    this.name = 'NotebookToolAuthorizationError'
  }
}

const mode = { executionMode: 'stateless' as const, kernelPersistent: false as const }

export class NotebookToolHost {
  private constructor(
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    private readonly roots: readonly string[],
    private readonly fs: NotebookFs,
    private readonly onAudit?: (e: NotebookAuditEvidence) => void | Promise<void>
  ) {}

  static async create(
    authorization: MagicAgentPolicyAuthorizationService,
    options: Readonly<{
      allowedRoots: readonly string[]
      fs?: NotebookFs
      onAudit?: (e: NotebookAuditEvidence) => void | Promise<void>
    }>
  ): Promise<NotebookToolHost> {
    const impl = options.fs ?? nodeFs
    if (!options.allowedRoots.length)
      throw new NotebookToolValidationError('At least one workspace root is required.')
    const roots: string[] = []
    for (const input of options.allowedRoots) {
      const root = await impl.realpath(input)
      const stat = await impl.stat(root)
      if (!stat.isDirectory())
        throw new NotebookToolValidationError('Workspace root must be a directory.')
      roots.push(root)
    }
    return new NotebookToolHost(authorization, [...new Set(roots)].sort(), impl, options.onAudit)
  }

  async list(call: AuthorizedCall<{ path?: string; maxEntries?: number }>) {
    return this.readOperation('notebook.list', call, async (root, target, relative) => {
      const stat = await this.fs.lstat(target)
      if (!stat.isDirectory())
        throw new NotebookToolValidationError('notebook.list path must be a directory.')
      const max = bounded(call.input.maxEntries, LIMITS.list)
      const notebooks: Array<{ path: string; bytes: number; sha256: string; cellCount: number }> =
        []
      const queue = [target]
      while (queue.length && notebooks.length < max) {
        const dir = queue.shift()!
        const entries = await this.fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isSymbolicLink()) continue
          const absolute = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (!reserved(path.relative(root, absolute))) queue.push(absolute)
            continue
          }
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.ipynb')) continue
          try {
            const loaded = await this.load(root, absolute)
            notebooks.push({
              path: relativePath(root, absolute),
              bytes: loaded.buffer.length,
              sha256: loaded.sha256,
              cellCount: loaded.document.cells.length
            })
          } catch {
            /* invalid notebooks are not listed */
          }
          if (notebooks.length >= max) break
        }
      }
      return {
        ...mode,
        root,
        path: relative,
        notebooks,
        count: notebooks.length,
        truncated: queue.length > 0
      }
    })
  }

  async read(call: AuthorizedCall<{ path: string }>) {
    return this.readOperation('notebook.read', call, async (root, target, relative) => {
      const loaded = await this.load(root, target)
      return {
        ...mode,
        root,
        path: relative,
        sha256: loaded.sha256,
        bytes: loaded.buffer.length,
        notebook: loaded.document
      }
    })
  }

  async insert(
    call: AuthorizedCall<{
      path: string
      expectedSha256: string
      cell: {
        id?: string
        cellType: CellType
        source: string | string[]
        metadata?: Record<string, Json>
      }
      position: 'begin' | 'end' | 'before' | 'after'
      referenceCellId?: string
    }>
  ) {
    return this.mutate('notebook.insert', call, (doc) => {
      const cell = makeCell(call.input.cell)
      const at = positionIndex(doc, call.input.position, call.input.referenceCellId)
      doc.cells.splice(at, 0, cell)
      return [cell.id]
    })
  }
  async replace(
    call: AuthorizedCall<{
      path: string
      expectedSha256: string
      cellId: string
      source?: string | string[]
      cellType?: CellType
      metadata?: Record<string, Json>
      clearOutputs?: boolean
    }>
  ) {
    return this.mutate('notebook.replace', call, (doc) => {
      const cell = exactCell(doc, call.input.cellId)
      if (call.input.source !== undefined) cell.source = normalizeSource(call.input.source)
      if (call.input.metadata !== undefined) cell.metadata = safeMetadata(call.input.metadata)
      if (call.input.cellType !== undefined && call.input.cellType !== cell.cell_type)
        convertCell(cell, call.input.cellType)
      if (call.input.clearOutputs && cell.cell_type === 'code') {
        cell.outputs = []
        cell.execution_count = null
      }
      return [cell.id]
    })
  }
  async delete(call: AuthorizedCall<{ path: string; expectedSha256: string; cellIds: string[] }>) {
    return this.mutate('notebook.delete', call, (doc) => {
      const ids = exactIds(doc, call.input.cellIds)
      doc.cells = doc.cells.filter((c) => !ids.has(c.id))
      return [...ids]
    })
  }
  async convert(
    call: AuthorizedCall<{
      path: string
      expectedSha256: string
      cellIds: string[]
      cellType: CellType
    }>
  ) {
    return this.mutate('notebook.convert', call, (doc) => {
      const ids = exactIds(doc, call.input.cellIds)
      for (const cell of doc.cells) if (ids.has(cell.id)) convertCell(cell, call.input.cellType)
      return [...ids]
    })
  }
  async clearOutputs(
    call: AuthorizedCall<{ path: string; expectedSha256: string; cellIds: string[] }>
  ) {
    return this.mutate('notebook.clear-outputs', call, (doc) => {
      const ids = exactIds(doc, call.input.cellIds)
      for (const cell of doc.cells)
        if (ids.has(cell.id) && cell.cell_type === 'code') {
          cell.outputs = []
          cell.execution_count = null
        }
      return [...ids]
    })
  }

  private async readOperation<T extends { path?: string }, R>(
    tool: 'notebook.list' | 'notebook.read',
    call: AuthorizedCall<T>,
    fn: (root: string, target: string, relative: string) => Promise<R>
  ): Promise<R> {
    const requested = validatePath(call.input.path ?? '.')
    try {
      validateRequest(call.request, tool, requested, false)
      const auth = this.authorization.authorize({
        authorizationId: call.authorizationId,
        request: call.request,
        evaluatedAt: Date.now(),
        grantId: call.grantId,
        expectedGrantUseCount: call.expectedGrantUseCount,
        idempotencyKey: `${call.idempotencyKey}:authorize`
      })
      if (auth.status !== 'authorized')
        throw new NotebookToolAuthorizationError(auth.status, auth.reason)
      const { root, target } = await this.resolve(requested, tool === 'notebook.list')
      const result = await fn(root, target, relativePath(root, target))
      await this.audit({ tool, path: requested, outcome: 'completed' })
      return result
    } catch (error) {
      await this.audit({ tool, path: requested, outcome: 'rejected' })
      throw error
    }
  }

  private async mutate<T extends { path: string; expectedSha256: string }>(
    tool: Exclude<ToolName, 'notebook.list' | 'notebook.read'>,
    call: AuthorizedCall<T>,
    edit: (doc: Notebook) => string[]
  ): Promise<Record<string, unknown>> {
    const requested = validatePath(call.input.path)
    let evidence: {
      beforeSha256?: string
      afterSha256?: string
      cellIds?: string[]
      cellCount?: number
      snapshotId?: string
    } = {}
    try {
      validateRequest(call.request, 'notebook.write', requested, true)
      const auth = this.authorization.authorize({
        authorizationId: call.authorizationId,
        request: call.request,
        evaluatedAt: Date.now(),
        grantId: call.grantId,
        expectedGrantUseCount: call.expectedGrantUseCount,
        idempotencyKey: `${call.idempotencyKey}:authorize`
      })
      if (auth.status !== 'authorized')
        throw new NotebookToolAuthorizationError(auth.status, auth.reason)
      if (!this.authorization.isTrustedPermit(auth.permit))
        throw new NotebookToolAuthorizationError('denied', 'Untrusted execution permit.')
      const { root, target } = await this.resolve(requested, false)
      const loaded = await this.load(root, target)
      if (
        !/^[0-9a-f]{64}$/.test(call.input.expectedSha256) ||
        loaded.sha256 !== call.input.expectedSha256
      )
        throw new NotebookToolValidationError('expectedSha256 is stale.')
      const doc = structuredClone(loaded.document)
      const cellIds = edit(doc)
      validateNotebook(doc)
      const afterBuffer = Buffer.from(`${stableStringify(doc)}\n`, 'utf8')
      if (afterBuffer.length > LIMITS.bytes)
        throw new NotebookToolValidationError('Result exceeds the notebook byte limit.')
      const afterSha256 = hash(afterBuffer)
      evidence = { beforeSha256: loaded.sha256, afterSha256, cellIds, cellCount: doc.cells.length }
      const current = await this.fs.readFile(target)
      if (hash(current) !== loaded.sha256)
        throw new NotebookToolValidationError('Notebook changed during mutation.')
      this.authorization.consumeExecutionPermit({
        permit: auth.permit,
        request: call.request,
        consumedAt: Date.now(),
        idempotencyKey: `${call.idempotencyKey}:consume`
      })
      const snapshotId = await this.snapshot(root, loaded.buffer, loaded.sha256)
      evidence.snapshotId = snapshotId
      await this.atomicReplace(target, afterBuffer, loaded.mode)
      await this.audit({ tool, path: requested, outcome: 'completed', ...evidence })
      return {
        ...mode,
        root,
        path: requested,
        beforeSha256: loaded.sha256,
        afterSha256,
        cellIds,
        cellCount: doc.cells.length,
        snapshotId
      }
    } catch (error) {
      await this.audit({ tool, path: requested, outcome: 'rejected', ...evidence })
      throw error
    }
  }

  private async resolve(requested: string, allowDirectory: boolean) {
    for (const root of this.roots) {
      const target = path.resolve(root, requested)
      if (!inside(root, target)) continue
      let real: string
      try {
        real = await this.fs.realpath(target)
      } catch {
        continue
      }
      if (!inside(root, real) || real !== target)
        throw new NotebookToolValidationError('Symlinks are not allowed.')
      const stat = await this.fs.lstat(real)
      if (allowDirectory ? !stat.isDirectory() : !stat.isFile())
        throw new NotebookToolValidationError(
          allowDirectory ? 'Path must be a directory.' : 'Notebook must be a regular file.'
        )
      if (!allowDirectory && !requested.toLowerCase().endsWith('.ipynb'))
        throw new NotebookToolValidationError('Notebook path must end in .ipynb.')
      return { root, target: real }
    }
    throw new NotebookToolValidationError(
      'Path is outside the allowed workspace or does not exist.'
    )
  }

  private async load(root: string, target: string) {
    if (!inside(root, target))
      throw new NotebookToolValidationError('Notebook is outside the workspace.')
    const stat = await this.fs.lstat(target)
    if (!stat.isFile() || stat.size > LIMITS.bytes)
      throw new NotebookToolValidationError('Notebook must be a bounded regular file.')
    const buffer = await this.fs.readFile(target)
    if (buffer.includes(0))
      throw new NotebookToolValidationError('Binary notebooks are not allowed.')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw new NotebookToolValidationError('Notebook must be UTF-8 JSON.')
    }
    let value: unknown
    try {
      value = JSON.parse(text, rejectPrototype)
    } catch (error) {
      if (error instanceof NotebookToolValidationError) throw error
      throw new NotebookToolValidationError('Notebook must contain valid JSON.')
    }
    const document = validateNotebook(value)
    return { document, buffer, sha256: hash(buffer), mode: stat.mode }
  }

  private async snapshot(root: string, content: Buffer, sha256: string) {
    const dir = path.join(root, '.magicpot', 'notebook-snapshots')
    await this.fs.mkdir(dir, { recursive: true })
    const snapshotId = sha256
    const target = path.join(dir, `${snapshotId}.ipynb`)
    try {
      const existing = await this.fs.readFile(target)
      if (hash(existing) !== sha256)
        throw new NotebookToolValidationError('Snapshot hash collision.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.atomicReplace(target, content)
    }
    return snapshotId
  }

  private async atomicReplace(target: string, content: Buffer, modeValue?: number) {
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
    let handle
    try {
      handle = await this.fs.open(temp, 'wx', modeValue)
      await handle.writeFile(content)
      await handle.sync()
      await handle.close()
      handle = undefined
      if (modeValue !== undefined) await this.fs.chmod(temp, modeValue)
      await this.fs.rename(temp, target)
      const dir = await this.fs.open(path.dirname(target), 'r')
      try {
        await dir.sync().catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EINVAL' && error.code !== 'EPERM') throw error
        })
      } finally {
        await dir.close()
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await this.fs.unlink(temp).catch(() => undefined)
      throw error
    }
  }
  private async audit(e: NotebookAuditEvidence) {
    await this.onAudit?.(e)
  }
}

function validateNotebook(value: unknown): Notebook {
  if (!plain(value)) throw new NotebookToolValidationError('Notebook must be an object.')
  const doc = value as unknown as Notebook
  if (doc.nbformat !== 4 || !Number.isInteger(doc.nbformat_minor) || doc.nbformat_minor < 0)
    throw new NotebookToolValidationError('Only nbformat v4 notebooks are supported.')
  doc.metadata = safeMetadata(doc.metadata)
  if (!Array.isArray(doc.cells) || doc.cells.length > LIMITS.cells)
    throw new NotebookToolValidationError('Notebook cell count is invalid or oversized.')
  const ids = new Set<string>()
  let outputBytes = 0
  for (const cell of doc.cells) {
    if (!plain(cell) || !ID_RE.test(cell.id) || ids.has(cell.id))
      throw new NotebookToolValidationError('Every cell requires a unique stable id.')
    ids.add(cell.id)
    if (!['markdown', 'code', 'raw'].includes(cell.cell_type))
      throw new NotebookToolValidationError('Unsupported cell type.')
    cell.source = normalizeSource(cell.source)
    cell.metadata = safeMetadata(cell.metadata)
    if (cell.cell_type === 'code') {
      if (
        cell.execution_count !== null &&
        cell.execution_count !== undefined &&
        (!Number.isInteger(cell.execution_count) || cell.execution_count < 0)
      )
        throw new NotebookToolValidationError('Invalid execution_count.')
      if (!Array.isArray(cell.outputs) || cell.outputs.length > LIMITS.outputs)
        throw new NotebookToolValidationError('Code outputs are invalid or oversized.')
      for (const output of cell.outputs) {
        validateJson(output)
        outputBytes += Buffer.byteLength(stableStringify(output))
        validateMime(output)
      }
    } else if ('outputs' in cell || 'execution_count' in cell)
      throw new NotebookToolValidationError(
        'Only code cells may contain outputs or execution_count.'
      )
    if (cell.attachments !== undefined) {
      validateJson(cell.attachments)
      validateMime(cell.attachments)
    }
  }
  if (outputBytes > LIMITS.outputBytes)
    throw new NotebookToolValidationError('Notebook outputs exceed the byte limit.')
  if (Buffer.byteLength(stableStringify(doc)) > LIMITS.bytes)
    throw new NotebookToolValidationError('Notebook exceeds the total byte limit.')
  return doc
}
function makeCell(input: {
  id?: string
  cellType: CellType
  source: string | string[]
  metadata?: Record<string, Json>
}): NotebookCell {
  const id = input.id ?? randomUUID().replace(/-/g, '').slice(0, 16)
  if (!ID_RE.test(id)) throw new NotebookToolValidationError('Invalid cell id.')
  const base: NotebookCell = {
    id,
    cell_type: input.cellType,
    source: normalizeSource(input.source),
    metadata: safeMetadata(input.metadata ?? {})
  }
  if (input.cellType === 'code') {
    base.execution_count = null
    base.outputs = []
  }
  return base
}
function convertCell(cell: NotebookCell, type: CellType) {
  cell.cell_type = type
  if (type === 'code') {
    cell.execution_count = null
    cell.outputs = []
  } else {
    delete cell.execution_count
    delete cell.outputs
  }
}
function exactCell(doc: Notebook, id: string) {
  if (!ID_RE.test(id)) throw new NotebookToolValidationError('Invalid cell id.')
  const found = doc.cells.filter((c) => c.id === id)
  if (found.length !== 1)
    throw new NotebookToolValidationError('Cell id must match exactly one cell.')
  return found[0]
}
function exactIds(doc: Notebook, ids: string[]) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > LIMITS.ids ||
    new Set(ids).size !== ids.length
  )
    throw new NotebookToolValidationError('cellIds must be a bounded distinct non-empty list.')
  for (const id of ids) exactCell(doc, id)
  return new Set(ids)
}
function positionIndex(doc: Notebook, position: string, reference?: string) {
  if (position === 'begin') return 0
  if (position === 'end') return doc.cells.length
  if ((position === 'before' || position === 'after') && reference) {
    const at = doc.cells.indexOf(exactCell(doc, reference))
    return at + (position === 'after' ? 1 : 0)
  }
  throw new NotebookToolValidationError('before/after requires referenceCellId.')
}
function normalizeSource(value: unknown) {
  const lines = typeof value === 'string' ? [value] : value
  if (!Array.isArray(lines) || lines.some((v) => typeof v !== 'string'))
    throw new NotebookToolValidationError('Cell source must be a string or string array.')
  if (Buffer.byteLength(lines.join('')) > LIMITS.sourceBytes)
    throw new NotebookToolValidationError('Cell source exceeds the byte limit.')
  return [...lines] as string[]
}
function safeMetadata(value: unknown) {
  if (!plain(value)) throw new NotebookToolValidationError('Metadata must be an object.')
  validateJson(value)
  if (Buffer.byteLength(stableStringify(value)) > LIMITS.metadataBytes)
    throw new NotebookToolValidationError('Metadata exceeds the byte limit.')
  return value as Record<string, Json>
}
function validateJson(value: unknown, depth = 0): asserts value is Json {
  if (depth > LIMITS.depth) throw new NotebookToolValidationError('JSON nesting is too deep.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new NotebookToolValidationError('Non-finite numbers are not allowed.')
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) validateJson(v, depth + 1)
    return
  }
  if (!plain(value)) throw new NotebookToolValidationError('Only plain JSON values are allowed.')
  for (const [key, v] of Object.entries(value)) {
    if (PROTOTYPE_KEYS.has(key))
      throw new NotebookToolValidationError('Prototype keys are not allowed.')
    validateJson(v, depth + 1)
  }
}
function validateMime(value: unknown) {
  if (!plain(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === 'data' || key === 'attachments') &&
      plain(child) &&
      Object.keys(child).length > LIMITS.mimeEntries
    )
      throw new NotebookToolValidationError('MIME bundle is oversized.')
    validateMime(child)
  }
}
function rejectPrototype(key: string, value: unknown) {
  if (PROTOTYPE_KEYS.has(key))
    throw new NotebookToolValidationError('Prototype keys are not allowed.')
  return value
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (plain(value))
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`
  return JSON.stringify(value)
}
function validateRequest(request: PolicyRequest, tool: string, requested: string, write: boolean) {
  if (
    request.target.kind !== 'tool' ||
    request.target.id !== tool ||
    request.action !==
      (write
        ? 'notebook.write'
        : tool === 'notebook.list'
          ? 'filesystem.list'
          : 'filesystem.read') ||
    !request.filesystem?.paths?.includes(requested)
  )
    throw new NotebookToolValidationError('Policy request does not match the notebook operation.')
}
function validatePath(value: string) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\0'))
    throw new NotebookToolValidationError('Path must be workspace-relative.')
  const normalized = value.replace(/\\/g, '/')
  if (normalized.split('/').includes('..') || reserved(normalized))
    throw new NotebookToolValidationError(
      'Path traversal and workspace metadata paths are not allowed.'
    )
  return normalized === '' ? '.' : normalized
}
function reserved(value: string) {
  const normalized = value.replace(/\\/g, '/')
  return normalized === '.magicpot' || normalized.startsWith('.magicpot/')
}
function relativePath(root: string, target: string) {
  return path.relative(root, target).replace(/\\/g, '/') || '.'
}
function inside(root: string, target: string) {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}
function bounded(value: number | undefined, max: number) {
  return value === undefined
    ? max
    : Number.isInteger(value) && value > 0 && value <= max
      ? value
      : (() => {
          throw new NotebookToolValidationError('Bound is invalid.')
        })()
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}
