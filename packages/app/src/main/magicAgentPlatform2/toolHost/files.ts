import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import type {
  FilesGlobInput,
  FilesGlobOutput,
  FilesGrepInput,
  FilesGrepOutput,
  FilesJsonReadInput,
  FilesJsonReadOutput,
  FilesReadInput,
  FilesReadOutput,
  FilesTreeEntry,
  FilesTreeInput,
  FilesTreeOutput,
  FilesWriteInput,
  FilesWriteOutput,
  FilesEditInput,
  FilesEditOutput,
  FilesPatchInput,
  FilesPatchOutput,
  FilesMultiEditInput,
  FilesMultiEditOutput,
  FilesJsonWriteInput,
  FilesJsonWriteOutput,
  FilesDiffInput,
  FilesDiffOutput,
  FilesSnapshotListInput,
  FilesSnapshotListOutput,
  FilesSnapshotRestoreInput,
  FilesSnapshotRestoreOutput,
  FilesMutationOutput,
  PolicyConstraints,
  PolicyRequest
} from '../../../shared/magicAgentPlatform2'
import type { MagicAgentPolicyAuthorizationService } from '../policy'

const LIMITS = Object.freeze({
  depth: 12,
  entries: 2_000,
  files: 2_000,
  multiFiles: 32,
  matches: 2_000,
  bytes: 1_048_576,
  chars: 1_048_576,
  diffBytes: 262_144,
  replacements: 100,
  runtimeMs: 10_000,
  pattern: 512,
  jsonEntries: 10_000
})
type ToolName =
  | 'files.tree'
  | 'files.read'
  | 'files.glob'
  | 'files.grep'
  | 'files.json.read'
  | 'files.write'
  | 'files.edit'
  | 'files.patch'
  | 'files.multi-edit'
  | 'files.json.write'
  | 'files.diff'
  | 'files.snapshot.list'
  | 'files.snapshot.restore'
export type FilesToolAuditEvidence = Readonly<{
  tool: ToolName
  authorizationId: string
  path: string
  outcome: 'completed' | 'rejected' | 'cancelled'
  bytes?: number
  returnedBytes?: number
  entryCount?: number
  matchCount?: number
  filesSearched?: number
  sha256?: string
  beforeSha256?: string
  afterSha256?: string
  diffBytes?: number
  additions?: number
  deletions?: number
  snapshotId?: string
  mutationUncertain?: boolean
  truncated?: boolean
  durationMs: number
}>
type AuthorizedInput<T> = Readonly<{
  authorizationId: string
  idempotencyKey: string
  request: PolicyRequest
  input: T
  grantId?: string
  expectedGrantUseCount?: number
  signal?: AbortSignal
}>

export class FilesToolValidationError extends Error {
  readonly code = 'MAGIC_AGENT_FILES_VALIDATION'
  constructor(message: string) {
    super(message)
    this.name = 'FilesToolValidationError'
  }
}
export class FilesToolAuthorizationError extends Error {
  readonly code = 'MAGIC_AGENT_FILES_AUTHORIZATION'
  constructor(
    readonly status: 'denied' | 'awaiting-approval' | 'already-consumed',
    message: string
  ) {
    super(message)
    this.name = 'FilesToolAuthorizationError'
  }
}
export class FilesToolMutationError extends Error {
  readonly code = 'MAGIC_AGENT_FILES_MUTATION'
  constructor(
    message: string,
    readonly rollback: {
      attempted: boolean
      succeeded: boolean
      restoredPaths: string[]
      failedPaths: string[]
    }
  ) {
    super(message)
    this.name = 'FilesToolMutationError'
  }
}

export class FilesToolHost {
  private readonly roots: readonly string[]
  private constructor(
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    roots: readonly string[],
    private readonly onAudit?: (evidence: FilesToolAuditEvidence) => void | Promise<void>
  ) {
    this.roots = roots
  }
  static async create(
    authorization: MagicAgentPolicyAuthorizationService,
    options: Readonly<{
      allowedRoots: readonly string[]
      onAudit?: (evidence: FilesToolAuditEvidence) => void | Promise<void>
    }>
  ): Promise<FilesToolHost> {
    if (!options.allowedRoots.length)
      throw new FilesToolValidationError('At least one workspace root is required.')
    const roots: string[] = []
    for (const root of options.allowedRoots) {
      const canonical = await fs.realpath(root)
      const stat = await fs.stat(canonical)
      if (!stat.isDirectory())
        throw new FilesToolValidationError('Workspace root must be a directory.')
      roots.push(canonical)
    }
    return new FilesToolHost(authorization, [...new Set(roots)].sort(comparePath), options.onAudit)
  }

  async tree(call: AuthorizedInput<FilesTreeInput>): Promise<FilesTreeOutput> {
    return this.execute('files.tree', call, async (root, target, started) => {
      const maxDepth = bounded(call.input.maxDepth, LIMITS.depth, 0, LIMITS.depth)
      const maxEntries = bounded(call.input.maxEntries, LIMITS.entries, 1, LIMITS.entries)
      const maxChars = bounded(call.input.maxStringLength, LIMITS.chars, 1, LIMITS.chars)
      const deadline =
        started + bounded(call.input.timeoutMs, LIMITS.runtimeMs, 1, LIMITS.runtimeMs)
      const { entries, truncated } = await walkEntries(
        root,
        target,
        maxDepth,
        maxEntries,
        maxChars,
        call.signal,
        deadline
      )
      const stat = await fs.lstat(target)
      if (!stat.isDirectory())
        throw new FilesToolValidationError('files.tree path must be a directory.')
      const output = {
        root,
        path: relativePath(root, target),
        entries,
        entryCount: entries.length,
        truncated,
        durationMs: Date.now() - started
      }
      return { output, audit: { entryCount: entries.length, truncated } }
    })
  }

  async glob(call: AuthorizedInput<FilesGlobInput>): Promise<FilesGlobOutput> {
    const pattern = validateGlob(call.input.pattern)
    return this.execute('files.glob', call, async (root, target, started) => {
      const deadline =
        started + bounded(call.input.timeoutMs, LIMITS.runtimeMs, 1, LIMITS.runtimeMs)
      const maxFiles = bounded(call.input.maxFiles, LIMITS.files, 1, LIMITS.files)
      const maxDepth = bounded(call.input.maxDepth, LIMITS.depth, 0, LIMITS.depth)
      const maxChars = bounded(call.input.maxStringLength, LIMITS.chars, 1, LIMITS.chars)
      const stat = await fs.lstat(target)
      if (!stat.isDirectory())
        throw new FilesToolValidationError('files.glob path must be a directory.')
      const all = await walkEntries(
        root,
        target,
        maxDepth,
        LIMITS.entries,
        maxChars,
        call.signal,
        deadline
      )
      const base = relativePath(root, target)
      const entries = all.entries
        .filter((entry) =>
          globMatches(pattern, base === '.' ? entry.path : path.posix.relative(base, entry.path))
        )
        .slice(0, maxFiles)
      const truncated =
        all.truncated ||
        entries.length <
          all.entries.filter((entry) =>
            globMatches(pattern, base === '.' ? entry.path : path.posix.relative(base, entry.path))
          ).length
      const output = {
        root,
        pattern,
        entries,
        entryCount: entries.length,
        truncated,
        durationMs: Date.now() - started
      }
      return { output, audit: { entryCount: entries.length, truncated } }
    })
  }

  async grep(call: AuthorizedInput<FilesGrepInput>): Promise<FilesGrepOutput> {
    const query = validateQuery(
      call.input.query,
      call.input.mode ?? 'literal',
      call.input.caseSensitive !== false
    )
    const fileGlob = validateGlob(call.input.fileGlob ?? '**')
    return this.execute('files.grep', call, async (root, target, started) => {
      const deadline =
        started + bounded(call.input.timeoutMs, LIMITS.runtimeMs, 1, LIMITS.runtimeMs)
      const maxFiles = bounded(call.input.maxFiles, LIMITS.files, 1, LIMITS.files)
      const maxMatches = bounded(call.input.maxMatches, LIMITS.matches, 1, LIMITS.matches)
      const maxBytes = bounded(call.input.maxReadBytes, LIMITS.bytes, 1, LIMITS.bytes)
      const maxSnippet = bounded(call.input.maxSnippetLength, 500, 1, 2_000)
      const maxDepth = bounded(call.input.maxDepth, LIMITS.depth, 0, LIMITS.depth)
      const stat = await fs.lstat(target)
      if (!stat.isDirectory())
        throw new FilesToolValidationError('files.grep path must be a directory.')
      const all = await walkEntries(
        root,
        target,
        maxDepth,
        LIMITS.entries,
        LIMITS.chars,
        call.signal,
        deadline
      )
      const matchingFiles = all.entries.filter(
        (entry) =>
          entry.type === 'file' &&
          globMatches(fileGlob, relativePath(target, path.join(root, entry.path)))
      )
      const files = matchingFiles.slice(0, maxFiles)
      const matches: FilesGrepOutput['matches'][number][] = []
      let binaryFilesSkipped = 0
      let truncated = all.truncated
      for (const file of files) {
        check(call.signal, deadline)
        const absolute = path.join(root, file.path)
        const buffer = await readBounded(absolute, maxBytes)
        if (isBinary(buffer)) {
          binaryFilesSkipped++
          continue
        }
        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
        } catch {
          binaryFilesSkipped++
          continue
        }
        const lines = text.split(/\r?\n/)
        for (let index = 0; index < lines.length; index++) {
          check(call.signal, deadline)
          const found = findMatches(lines[index], query)
          for (const column of found) {
            matches.push({
              path: file.path,
              line: index + 1,
              column: column + 1,
              snippet: redactSecrets(lines[index].slice(0, maxSnippet))
            })
            if (matches.length >= maxMatches) {
              truncated = true
              break
            }
          }
          if (truncated && matches.length >= maxMatches) break
        }
        if (truncated && matches.length >= maxMatches) break
      }
      if (matchingFiles.length > files.length) truncated = true
      const output = {
        root,
        matches,
        matchCount: matches.length,
        filesSearched: files.length,
        binaryFilesSkipped,
        truncated,
        durationMs: Date.now() - started
      }
      return {
        output,
        audit: { matchCount: matches.length, filesSearched: files.length, truncated }
      }
    })
  }

  async read(call: AuthorizedInput<FilesReadInput>): Promise<FilesReadOutput> {
    return this.execute<FilesReadOutput, FilesReadInput>(
      'files.read',
      call,
      async (root, target, started) => {
        const maxBytes = bounded(call.input.maxBytes, LIMITS.bytes, 1, LIMITS.bytes)
        const maxChars = bounded(call.input.maxStringLength, LIMITS.chars, 1, LIMITS.chars)
        const deadline =
          started + bounded(call.input.timeoutMs, LIMITS.runtimeMs, 1, LIMITS.runtimeMs)
        check(call.signal, deadline)
        const stat = await fs.lstat(target)
        if (!stat.isFile())
          throw new FilesToolValidationError('files.read path must be a regular file.')
        const sampled = await readBounded(target, maxBytes + 1)
        const returned = sampled.subarray(0, maxBytes)
        const sha256 = await hashFile(target, call.signal, deadline)
        const common = {
          root,
          path: relativePath(root, target),
          bytes: stat.size,
          sha256,
          durationMs: Date.now() - started
        }
        const image = detectImage(sampled)
        if (image) {
          const dimensions = imageDimensions(returned, image.mime)
          const output: FilesReadOutput = {
            kind: 'image',
            ...common,
            mime: image.mime,
            base64: returned.toString('base64'),
            returnedBytes: returned.length,
            ...dimensions,
            truncated: stat.size > returned.length
          }
          return {
            output,
            audit: {
              bytes: stat.size,
              returnedBytes: returned.length,
              sha256,
              truncated: output.truncated
            }
          }
        }
        if (sampled.subarray(0, 5).toString('ascii') === '%PDF-') {
          const pdf = extractPdf(returned, maxChars, call.signal, deadline)
          const output: FilesReadOutput = {
            kind: 'pdf',
            ...common,
            ...pdf,
            returnedBytes: Buffer.byteLength(pdf.content),
            truncated: stat.size > returned.length || pdf.truncated
          }
          return {
            output,
            audit: {
              bytes: stat.size,
              returnedBytes: output.returnedBytes,
              sha256,
              truncated: output.truncated
            }
          }
        }
        if (isKnownMediaExtension(target))
          throw new FilesToolValidationError(
            'File media extension does not match an allowed magic signature.'
          )
        if (isBinary(sampled))
          throw new FilesToolValidationError('Unknown binary files are not readable.')
        let content = new TextDecoder('utf-8', { fatal: true }).decode(returned)
        let truncated = stat.size > returned.length
        if (content.length > maxChars) {
          content = content.slice(0, maxChars)
          truncated = true
        }
        const output: FilesReadOutput = {
          kind: 'text',
          ...common,
          content,
          returnedBytes: Buffer.byteLength(content),
          truncated
        }
        return {
          output,
          audit: { bytes: stat.size, returnedBytes: output.returnedBytes, sha256, truncated }
        }
      }
    )
  }

  async jsonRead(call: AuthorizedInput<FilesJsonReadInput>): Promise<FilesJsonReadOutput> {
    return this.execute('files.json.read', call, async (root, target, started) => {
      const deadline =
        started + bounded(call.input.timeoutMs, LIMITS.runtimeMs, 1, LIMITS.runtimeMs)
      check(call.signal, deadline)
      const maxBytes = bounded(call.input.maxBytes, LIMITS.bytes, 1, LIMITS.bytes)
      const stat = await fs.lstat(target)
      if (!stat.isFile())
        throw new FilesToolValidationError('files.json.read path must be a regular file.')
      if (stat.size > maxBytes)
        throw new FilesToolValidationError('JSON file exceeds the read byte limit.')
      const buffer = await readBounded(target, maxBytes)
      if (isBinary(buffer)) throw new FilesToolValidationError('JSON file must be UTF-8 text.')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
      let parsed: unknown
      try {
        parsed = JSON.parse(text, (key, value) => {
          if (key === '__proto__' || key === 'prototype' || key === 'constructor')
            throw new FilesToolValidationError('JSON prototype keys are not allowed.')
          return value
        })
      } catch (error) {
        if (error instanceof FilesToolValidationError) throw error
        throw new FilesToolValidationError('File does not contain valid JSON.')
      }
      const selected = selectJson(parsed, call.input.pointer)
      const boundedValue = boundJson(
        selected,
        bounded(call.input.maxDepth, LIMITS.depth, 0, LIMITS.depth),
        bounded(call.input.maxEntries, LIMITS.jsonEntries, 1, LIMITS.jsonEntries),
        bounded(call.input.maxStringLength, 16_384, 1, LIMITS.chars)
      )
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      const output = {
        root,
        path: relativePath(root, target),
        pointer: call.input.pointer,
        value: boundedValue.value,
        bytes: stat.size,
        sha256,
        truncated: boundedValue.truncated,
        durationMs: Date.now() - started
      }
      return { output, audit: { bytes: stat.size, sha256, truncated: boundedValue.truncated } }
    })
  }

  async write(call: AuthorizedInput<FilesWriteInput>): Promise<FilesWriteOutput> {
    return this.mutate(
      'files.write',
      call,
      (before) => call.input.content,
      call.input.create === true
    )
  }

  async edit(call: AuthorizedInput<FilesEditInput>): Promise<FilesEditOutput> {
    validateReplacements(call.input.replacements, 'files.edit')
    return this.mutate(
      'files.edit',
      call,
      (before) => applyReplacements(before, call.input.replacements),
      false
    )
  }

  async patch(call: AuthorizedInput<FilesPatchInput>): Promise<FilesPatchOutput> {
    const requestedPath = validateRelativePath(call.input.path)
    if (!call.input.patch || Buffer.byteLength(call.input.patch) > LIMITS.diffBytes)
      throw new FilesToolValidationError('Patch is empty or exceeds the enforced bound.')
    const patched = applyUnifiedPatch(requestedPath, call.input.patch)
    return this.mutate(
      'files.patch',
      call,
      (before) => {
        if (before !== patched.before)
          throw new FilesToolValidationError('Patch hunk does not match the complete current file.')
        return patched.after
      },
      false
    )
  }

  async jsonWrite(call: AuthorizedInput<FilesJsonWriteInput>): Promise<FilesJsonWriteOutput> {
    if ((call.input.value === undefined) === (call.input.update === undefined))
      throw new FilesToolValidationError(
        'files.json.write requires exactly one of value or update.'
      )
    return this.mutate(
      'files.json.write',
      call,
      (before) => {
        let value: unknown
        if (call.input.update) {
          try {
            value = parseSafeJson(before)
          } catch {
            throw new FilesToolValidationError('Existing file does not contain valid safe JSON.')
          }
          value = updateJson(value, call.input.update.path, call.input.update.value)
        } else value = call.input.value
        validateJsonValue(value)
        return `${JSON.stringify(value, null, 2)}\n`
      },
      call.input.create === true
    )
  }

  async multiEdit(call: AuthorizedInput<FilesMultiEditInput>): Promise<FilesMultiEditOutput> {
    const started = Date.now()
    const edits = call.input.edits
    if (!Array.isArray(edits) || !edits.length || edits.length > LIMITS.multiFiles)
      throw new FilesToolValidationError(
        'files.multi-edit requires a bounded non-empty edits list.'
      )
    const ordered = edits
      .map((item) => ({ item, path: validateRelativePath(item.path) }))
      .sort((a, b) => comparePath(a.path, b.path))
    const paths = ordered.map(({ path }) => path)
    if (new Set(paths).size !== paths.length)
      throw new FilesToolValidationError('files.multi-edit paths must be distinct.')
    validateRequest(call.request, 'files.multi-edit', requestedPolicyPath(call.request))
    const authorized = this.authorization.authorize({
      authorizationId: call.authorizationId,
      request: call.request,
      evaluatedAt: Date.now(),
      grantId: call.grantId,
      expectedGrantUseCount: call.expectedGrantUseCount,
      idempotencyKey: `${call.idempotencyKey}:authorize`
    })
    if (authorized.status !== 'authorized')
      throw new FilesToolAuthorizationError(authorized.status, authorized.reason)
    validateConstraints('files.multi-edit', authorized.permit.constraints)
    if (!this.authorization.isTrustedPermit(authorized.permit))
      throw new FilesToolAuthorizationError('denied', 'Untrusted execution permit.')
    const prepared: PreparedMutation[] = []
    const deadline = started + bounded(call.input.timeoutMs, LIMITS.runtimeMs, 1, LIMITS.runtimeMs)
    for (let i = 0; i < ordered.length; i++) {
      const edit = ordered[i].item
      validateReplacements(edit.replacements, 'files.multi-edit')
      prepared.push(
        await this.prepareMutation(
          paths[i],
          edit.expectedSha256,
          false,
          bounded(call.input.maxBytes, LIMITS.bytes, 1, LIMITS.bytes),
          bounded(call.input.maxDiffBytes, LIMITS.diffBytes, 1, LIMITS.diffBytes),
          (before) => applyReplacements(before, edit.replacements),
          authorized.permit.constraints
        )
      )
    }
    for (const item of prepared) await assertUnchanged(item.target, item.existed, item.beforeSha256)
    check(call.signal, deadline)
    this.authorization.consumeExecutionPermit({
      permit: authorized.permit,
      request: call.request,
      consumedAt: Date.now(),
      idempotencyKey: `${call.idempotencyKey}:consume`
    })
    const snapshots: Awaited<ReturnType<typeof createSnapshot>>[] = []
    for (const item of prepared)
      snapshots.push(
        await createSnapshot(
          item.root,
          item.path,
          item.beforeBuffer,
          item.beforeSha256,
          item.afterSha256,
          item.existed
        )
      )
    const committed: number[] = []
    try {
      for (let i = 0; i < prepared.length; i++) {
        check(call.signal, deadline)
        await atomicReplace(prepared[i].target, prepared[i].afterBuffer, prepared[i].mode)
        committed.push(i)
      }
    } catch (error) {
      const rollback = {
        attempted: committed.length > 0,
        succeeded: true,
        restoredPaths: [] as string[],
        failedPaths: [] as string[]
      }
      for (const i of committed.reverse()) {
        try {
          await restorePrepared(prepared[i])
          rollback.restoredPaths.push(prepared[i].path)
        } catch {
          rollback.succeeded = false
          rollback.failedPaths.push(prepared[i].path)
        }
      }
      throw new FilesToolMutationError(
        `Multi-file commit failed: ${(error as Error).message}`,
        rollback
      )
    }
    const files = prepared.map((item, i) =>
      mutationOutput(item, snapshots[i], Date.now() - started)
    )
    return {
      root: prepared[0].root,
      files,
      rollback: { attempted: false, succeeded: true, restoredPaths: [], failedPaths: [] },
      durationMs: Date.now() - started
    }
  }

  async diff(call: AuthorizedInput<FilesDiffInput>): Promise<FilesDiffOutput> {
    if ((call.input.text === undefined) === (call.input.snapshotToken === undefined))
      throw new FilesToolValidationError('files.diff requires exactly one comparison source.')
    return this.execute('files.diff', call, async (root, target, started) => {
      const maxBytes = bounded(call.input.maxBytes, LIMITS.bytes, 1, LIMITS.bytes)
      const current = await readBounded(target, maxBytes + 1)
      if (current.length > maxBytes || isBinary(current))
        throw new FilesToolValidationError('Diff input must be bounded UTF-8 text.')
      const before = new TextDecoder('utf-8', { fatal: true }).decode(current)
      let comparison: Buffer
      if (call.input.snapshotToken) {
        const manifest = await loadSnapshot(root, call.input.snapshotToken)
        if (manifest.path !== validateRelativePath(call.input.path))
          throw new FilesToolValidationError('Snapshot path does not match.')
        comparison = manifest.existed
          ? await fs.readFile(snapshotContentPath(root, manifest.snapshotId))
          : Buffer.alloc(0)
      } else comparison = Buffer.from(call.input.text!, 'utf8')
      if (comparison.length > maxBytes)
        throw new FilesToolValidationError('Comparison exceeds byte limit.')
      const after = comparison.toString('utf8')
      let diff = buildUnifiedDiff(call.input.path, before, after)
      const limit = bounded(call.input.maxDiffBytes, LIMITS.diffBytes, 1, LIMITS.diffBytes)
      const truncated = Buffer.byteLength(diff) > limit
      if (truncated) diff = Buffer.from(diff).subarray(0, limit).toString('utf8')
      const stats = diffStats(before, after)
      const output = {
        root,
        path: call.input.path,
        currentSha256: sha256(current),
        comparedSha256: sha256(comparison),
        diff,
        diffBytes: Buffer.byteLength(diff),
        ...stats,
        truncated,
        durationMs: Date.now() - started
      }
      return {
        output,
        audit: { sha256: output.currentSha256, diffBytes: output.diffBytes, ...stats, truncated }
      }
    })
  }

  async snapshotList(
    call: AuthorizedInput<FilesSnapshotListInput>
  ): Promise<FilesSnapshotListOutput> {
    return this.execute(
      'files.snapshot.list',
      { ...call, input: { ...call.input, path: call.input.path ?? '.' } },
      async (root, _target, started) => {
        const dir = snapshotRoot(root)
        const names = await fs
          .readdir(dir)
          .catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : Promise.reject(e)))
        const max = bounded(call.input.maxEntries, 100, 1, 1000)
        const snapshots: ReturnType<typeof publicManifest>[] = []
        let matched = 0
        for (const name of names.sort(comparePath)) {
          try {
            const manifest = await loadSnapshot(root, `files-restore:${name}`)
            if (
              !call.input.path ||
              call.input.path === '.' ||
              manifest.path === validateRelativePath(call.input.path)
            ) {
              matched++
              if (snapshots.length < max) snapshots.push(publicManifest(manifest))
            }
          } catch {
            /* ignore invalid internal entries */
          }
        }
        const output = {
          root,
          snapshots,
          entryCount: snapshots.length,
          truncated: matched > snapshots.length,
          durationMs: Date.now() - started
        }
        return { output, audit: { entryCount: snapshots.length, truncated: output.truncated } }
      }
    )
  }

  async snapshotRestore(
    call: AuthorizedInput<FilesSnapshotRestoreInput>
  ): Promise<FilesSnapshotRestoreOutput> {
    const started = Date.now()
    const requestedPath = validateRelativePath(call.input.path)
    validateRequest(call.request, 'files.snapshot.restore', requestedPath)
    const authorized = this.authorization.authorize({
      authorizationId: call.authorizationId,
      request: call.request,
      evaluatedAt: Date.now(),
      grantId: call.grantId,
      expectedGrantUseCount: call.expectedGrantUseCount,
      idempotencyKey: `${call.idempotencyKey}:authorize`
    })
    if (authorized.status !== 'authorized')
      throw new FilesToolAuthorizationError(authorized.status, authorized.reason)
    validateConstraints('files.snapshot.restore', authorized.permit.constraints)
    const { root, target } = await this.resolveWritable(
      requestedPath,
      authorized.permit.constraints
    )
    const manifest = await loadSnapshot(root, call.input.restoreToken)
    if (manifest.path !== requestedPath)
      throw new FilesToolValidationError('Snapshot path does not match.')
    const current = await fs
      .readFile(target)
      .catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)))
    if (!current || sha256(current) !== call.input.expectedSha256)
      throw new FilesToolValidationError('expectedSha256 is stale.')
    const content = manifest.existed
      ? await fs.readFile(snapshotContentPath(root, manifest.snapshotId))
      : undefined
    if (manifest.existed && sha256(content!) !== manifest.beforeSha256)
      throw new FilesToolValidationError('Snapshot content hash mismatch.')
    const safety = await createSnapshot(
      root,
      requestedPath,
      current,
      sha256(current),
      content ? sha256(content) : sha256(''),
      true
    )
    check(call.signal, started + LIMITS.runtimeMs)
    this.authorization.consumeExecutionPermit({
      permit: authorized.permit,
      request: call.request,
      consumedAt: Date.now(),
      idempotencyKey: `${call.idempotencyKey}:consume`
    })
    if (content) await atomicReplace(target, content)
    else await atomicDelete(target)
    return {
      root,
      path: requestedPath,
      deleted: !content,
      beforeSha256: sha256(current),
      afterSha256: content ? sha256(content) : undefined,
      snapshotId: manifest.snapshotId,
      restoreToken: manifest.restoreToken,
      safetySnapshotId: safety.snapshotId,
      safetyRestoreToken: safety.restoreToken,
      durationMs: Date.now() - started
    }
  }

  private async prepareMutation(
    pathValue: string,
    expectedSha256: string | undefined,
    allowCreate: boolean,
    maxBytes: number,
    maxDiffBytes: number,
    transform: (before: string) => string,
    constraints?: PolicyConstraints
  ): Promise<PreparedMutation> {
    if (reserved(pathValue))
      throw new FilesToolValidationError('Workspace metadata paths are reserved.')
    const { root, target } = await this.resolveWritable(pathValue, constraints)
    let beforeBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0),
      before = '',
      mode: number | undefined,
      existed = false
    try {
      const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.size > maxBytes)
        throw new FilesToolValidationError('Writable target must be a bounded regular file.')
      existed = true
      mode = stat.mode
      beforeBuffer = await readBounded(target, maxBytes + 1)
      if (isBinary(beforeBuffer))
        throw new FilesToolValidationError('Binary files are not writable.')
      before = new TextDecoder('utf-8', { fatal: true }).decode(beforeBuffer)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!allowCreate) throw new FilesToolValidationError('Target does not exist.')
    }
    const beforeSha256 = existed ? sha256(beforeBuffer) : undefined
    if (existed && expectedSha256 !== beforeSha256)
      throw new FilesToolValidationError('expectedSha256 is stale.')
    if (!existed && expectedSha256)
      throw new FilesToolValidationError('expectedSha256 is invalid for create.')
    const after = transform(before)
    const afterBuffer = Buffer.from(after, 'utf8')
    if (afterBuffer.length > maxBytes || isBinary(afterBuffer))
      throw new FilesToolValidationError('Result must be bounded UTF-8 text.')
    const diff = buildUnifiedDiff(pathValue, before, after)
    if (Buffer.byteLength(diff) > maxDiffBytes)
      throw new FilesToolValidationError('Pre-write diff exceeds the byte limit.')
    return {
      root,
      target,
      path: pathValue,
      beforeBuffer,
      beforeSha256,
      existed,
      mode,
      afterBuffer,
      afterSha256: sha256(afterBuffer),
      diff,
      ...diffStats(before, after)
    }
  }

  private async mutate<T extends FilesWriteInput | FilesEditInput | FilesJsonWriteInput>(
    tool: 'files.write' | 'files.edit' | 'files.patch' | 'files.json.write',
    call: AuthorizedInput<T>,
    transform: (before: string) => string,
    allowCreate: boolean
  ): Promise<FilesWriteOutput> {
    const started = Date.now()
    const requestedPath = validateRelativePath(call.input.path)
    let audit: Partial<FilesToolAuditEvidence> = {}
    let consumed = false
    try {
      const deadline =
        started + bounded(call.input.timeoutMs, LIMITS.runtimeMs, 1, LIMITS.runtimeMs)
      check(call.signal, deadline)
      if (requestedPath === '.magicpot' || requestedPath.startsWith('.magicpot/'))
        throw new FilesToolValidationError('Workspace metadata paths are reserved.')
      validateRequest(call.request, tool, requestedPath)
      const authorized = this.authorization.authorize({
        authorizationId: call.authorizationId,
        request: call.request,
        evaluatedAt: Date.now(),
        grantId: call.grantId,
        expectedGrantUseCount: call.expectedGrantUseCount,
        idempotencyKey: `${call.idempotencyKey}:authorize`
      })
      if (authorized.status !== 'authorized')
        throw new FilesToolAuthorizationError(authorized.status, authorized.reason)
      validateConstraints(tool, authorized.permit.constraints)
      if (!this.authorization.isTrustedPermit(authorized.permit))
        throw new FilesToolAuthorizationError('denied', 'Untrusted execution permit.')
      const { root, target } = await this.resolveWritable(
        requestedPath,
        authorized.permit.constraints
      )
      const maxBytes = bounded(call.input.maxBytes, LIMITS.bytes, 1, LIMITS.bytes)
      const maxDiffBytes = bounded(call.input.maxDiffBytes, LIMITS.diffBytes, 1, LIMITS.diffBytes)
      let beforeBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let before = ''
      let mode: number | undefined
      let existed = false
      try {
        const stat = await fs.lstat(target)
        existed = true
        if (!stat.isFile())
          throw new FilesToolValidationError('Writable target must be a regular file.')
        if (stat.size > maxBytes)
          throw new FilesToolValidationError('Existing file exceeds the byte limit.')
        beforeBuffer = await readBounded(target, maxBytes + 1)
        if (isBinary(beforeBuffer))
          throw new FilesToolValidationError('Binary files are not writable.')
        try {
          before = new TextDecoder('utf-8', { fatal: true }).decode(beforeBuffer)
        } catch {
          throw new FilesToolValidationError('Writable files must be UTF-8 text.')
        }
        mode = stat.mode
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (!allowCreate)
          throw new FilesToolValidationError(
            'Target does not exist; files.write creation requires create=true.'
          )
      }
      if (existed && !call.input.expectedSha256)
        throw new FilesToolValidationError('expectedSha256 is required for an existing file.')
      if (!existed && 'expectedSha256' in call.input && call.input.expectedSha256)
        throw new FilesToolValidationError('expectedSha256 is not valid when creating a file.')
      const beforeSha256 = existed ? sha256(beforeBuffer) : undefined
      if (existed && call.input.expectedSha256 !== beforeSha256)
        throw new FilesToolValidationError('expectedSha256 is stale.')
      const after = transform(before)
      const afterBuffer = Buffer.from(after, 'utf8')
      if (afterBuffer.length > maxBytes)
        throw new FilesToolValidationError('Result exceeds the byte limit.')
      if (isBinary(afterBuffer))
        throw new FilesToolValidationError('Result must be regular UTF-8 text.')
      const afterSha256 = sha256(afterBuffer)
      const diff = buildUnifiedDiff(requestedPath, before, after)
      const diffBytes = Buffer.byteLength(diff)
      if (diffBytes > maxDiffBytes)
        throw new FilesToolValidationError('Pre-write diff exceeds the byte limit.')
      const stats = diffStats(before, after)
      audit = { beforeSha256, afterSha256, diffBytes, ...stats }
      check(call.signal, deadline)
      await assertUnchanged(target, existed, beforeSha256)
      this.authorization.consumeExecutionPermit({
        permit: authorized.permit,
        request: call.request,
        consumedAt: Date.now(),
        idempotencyKey: `${call.idempotencyKey}:consume`
      })
      consumed = true
      const snapshot = await createSnapshot(
        root,
        requestedPath,
        beforeBuffer,
        beforeSha256,
        afterSha256,
        existed
      )
      audit = { ...audit, snapshotId: snapshot.snapshotId }
      await atomicReplace(target, afterBuffer, mode)
      const output = {
        root,
        path: requestedPath,
        created: !existed,
        beforeSha256,
        afterSha256,
        bytes: afterBuffer.length,
        diff,
        diffBytes,
        ...stats,
        ...snapshot,
        durationMs: Date.now() - started
      }
      await this.onAudit?.({
        tool,
        authorizationId: call.authorizationId,
        path: requestedPath,
        outcome: 'completed',
        durationMs: output.durationMs,
        ...audit
      })
      return output
    } catch (error) {
      await this.onAudit?.({
        tool,
        authorizationId: call.authorizationId,
        path: requestedPath,
        outcome: isAbort(error) ? 'cancelled' : 'rejected',
        durationMs: Date.now() - started,
        ...audit,
        ...(consumed ? { mutationUncertain: true } : {})
      })
      throw error
    }
  }

  private async resolveWritable(
    relative: string,
    constraints?: PolicyConstraints
  ): Promise<{ root: string; target: string }> {
    const policyRoots = constraints?.allowedRoots
      ? await Promise.all(constraints.allowedRoots.map((root) => fs.realpath(root)))
      : undefined
    for (const root of this.roots) {
      if (policyRoots && !policyRoots.some((policyRoot) => inside(policyRoot, root))) continue
      const target = path.resolve(root, relative)
      if (!inside(root, target)) continue
      let ancestor = path.dirname(target)
      for (;;) {
        try {
          const canonical = await fs.realpath(ancestor)
          if (!inside(root, canonical) || canonical !== ancestor)
            throw new FilesToolValidationError('Symbolic links and junctions are not writable.')
          const stat = await fs.lstat(canonical)
          if (!stat.isDirectory())
            throw new FilesToolValidationError('Writable target parent must be a directory.')
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          const parent = path.dirname(ancestor)
          if (parent === ancestor) throw error
          ancestor = parent
        }
      }
      try {
        const canonicalTarget = await fs.realpath(target)
        if (canonicalTarget !== target || !inside(root, canonicalTarget))
          throw new FilesToolValidationError('Symbolic links and junctions are not writable.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (path.dirname(target) !== ancestor)
        throw new FilesToolValidationError('Target parent directory must already exist.')
      return { root, target }
    }
    throw new FilesToolValidationError('Path is outside the allowed workspace root.')
  }

  private async execute<T, I extends { path?: string }>(
    tool: ToolName,
    call: AuthorizedInput<I>,
    operation: (
      root: string,
      target: string,
      started: number,
      constraints?: PolicyConstraints
    ) => Promise<{ output: T; audit: Partial<FilesToolAuditEvidence> }>
  ): Promise<T> {
    const started = Date.now()
    const requestedPath = validateRelativePath(call.input.path || '.')
    if (reserved(requestedPath))
      throw new FilesToolValidationError('Workspace metadata paths are reserved.')
    try {
      check(call.signal, started + LIMITS.runtimeMs)
      validateRequest(call.request, tool, requestedPath)
      const authorized = this.authorization.authorize({
        authorizationId: call.authorizationId,
        request: call.request,
        evaluatedAt: Date.now(),
        grantId: call.grantId,
        expectedGrantUseCount: call.expectedGrantUseCount,
        idempotencyKey: `${call.idempotencyKey}:authorize`
      })
      if (authorized.status !== 'authorized')
        throw new FilesToolAuthorizationError(authorized.status, authorized.reason)
      validateConstraints(tool, authorized.permit.constraints)
      this.authorization.consumeExecutionPermit({
        permit: authorized.permit,
        request: call.request,
        consumedAt: Date.now(),
        idempotencyKey: `${call.idempotencyKey}:consume`
      })
      const { root, target } = await this.resolve(requestedPath, authorized.permit.constraints)
      const result = await operation(root, target, started, authorized.permit.constraints)
      await this.onAudit?.({
        tool,
        authorizationId: call.authorizationId,
        path: relativePath(root, target),
        outcome: 'completed',
        durationMs: Date.now() - started,
        ...result.audit
      })
      return result.output
    } catch (error) {
      await this.onAudit?.({
        tool,
        authorizationId: call.authorizationId,
        path: requestedPath,
        outcome: isAbort(error) ? 'cancelled' : 'rejected',
        durationMs: Date.now() - started
      })
      throw error
    }
  }
  private async resolve(
    relative: string,
    constraints?: PolicyConstraints
  ): Promise<{ root: string; target: string }> {
    const policyRoots = constraints?.allowedRoots
      ? await Promise.all(constraints.allowedRoots.map((root) => fs.realpath(root)))
      : undefined
    for (const root of this.roots) {
      if (policyRoots && !policyRoots.some((policyRoot) => inside(policyRoot, root))) continue
      const target = path.resolve(root, relative)
      if (!inside(root, target)) continue
      const canonicalTarget = await fs.realpath(target)
      if (!inside(root, canonicalTarget) || canonicalTarget !== target)
        throw new FilesToolValidationError('Symbolic links and junctions are not readable.')
      return { root, target: canonicalTarget }
    }
    throw new FilesToolValidationError('Path is outside the allowed workspace root.')
  }
}

function applyUnifiedPatch(
  relativePath: string,
  patchText: string
): { before: string; after: string } {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n')
  const normalizedPath = relativePath.replaceAll(String.fromCharCode(92), '/')
  if (lines[0] !== `--- a/${normalizedPath}` || lines[1] !== `+++ b/${normalizedPath}`)
    throw new FilesToolValidationError('Patch headers must bind exactly to the requested path.')
  const match = /^@@ -1,(\d+) \+1,(\d+) @@$/.exec(lines[2] ?? '')
  if (!match)
    throw new FilesToolValidationError('Only one complete-file unified patch hunk is supported.')
  const before: string[] = []
  const after: string[] = []
  let noFinalNewline = false
  for (const line of lines.slice(3)) {
    if (line === `${String.fromCharCode(92)} No newline at end of file`) {
      noFinalNewline = true
      continue
    }
    if (line === '' && lines.at(-1) === '') continue
    const marker = line[0]
    const content = line.slice(1)
    if (marker === ' ') {
      before.push(content)
      after.push(content)
    } else if (marker === '-') before.push(content)
    else if (marker === '+') after.push(content)
    else throw new FilesToolValidationError('Patch contains an unsupported line.')
  }
  if (before.length !== Number(match[1]) || after.length !== Number(match[2]))
    throw new FilesToolValidationError('Patch hunk line counts do not match its header.')
  const suffix = noFinalNewline ? '' : '\n'
  return { before: `${before.join('\n')}${suffix}`, after: `${after.join('\n')}${suffix}` }
}

function validateRequest(request: PolicyRequest, tool: ToolName, requestedPath: string): void {
  const writable =
    tool === 'files.write' ||
    tool === 'files.edit' ||
    tool === 'files.patch' ||
    tool === 'files.multi-edit' ||
    tool === 'files.json.write' ||
    tool === 'files.snapshot.restore'
  const action = writable
    ? 'filesystem.write'
    : tool === 'files.tree' || tool === 'files.glob' || tool === 'files.snapshot.list'
      ? 'filesystem.list'
      : tool === 'files.grep'
        ? 'filesystem.search'
        : 'filesystem.read'
  if (request.action !== action || request.target.kind !== 'tool' || request.target.id !== tool)
    throw new FilesToolValidationError('Policy request does not match the file operation.')
  if (tool !== 'files.multi-edit' && request.input.path !== requestedPath)
    throw new FilesToolValidationError('Policy request path does not match.')
  const effect = request.effects.find(
    (item) => item.kind === (writable ? 'filesystem.write' : 'filesystem.read')
  )
  if (!effect || (writable && effect.risk !== 'high'))
    throw new FilesToolValidationError(
      'Policy request does not declare the required filesystem risk.'
    )
}
function validateConstraints(tool: ToolName, constraints?: PolicyConstraints): void {
  const writable =
    tool === 'files.write' ||
    tool === 'files.edit' ||
    tool === 'files.patch' ||
    tool === 'files.multi-edit' ||
    tool === 'files.json.write' ||
    tool === 'files.snapshot.restore'
  if (!writable && constraints?.readOnly === false)
    throw new FilesToolValidationError('Read file tools require read-only policy constraints.')
  if (writable && constraints?.readOnly === true)
    throw new FilesToolValidationError('Policy constraints are read-only.')
  if (constraints?.allowedToolNames && !constraints.allowedToolNames.includes(tool))
    throw new FilesToolValidationError(`Policy does not allow ${tool}.`)
}
function validateRelativePath(value: string): string {
  if (
    !value ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^[/\\]{2}/.test(value) ||
    /^\\\\[.?]\\/.test(value)
  )
    throw new FilesToolValidationError('Path must be workspace-relative.')
  const normalized = value.replace(/\\/g, '/')
  if (normalized.split('/').some((part) => part === '..'))
    throw new FilesToolValidationError('Path traversal is not allowed.')
  return normalized || '.'
}
function validateGlob(value: string): string {
  if (!value || value.length > LIMITS.pattern || value.includes('\0'))
    throw new FilesToolValidationError('Glob pattern is invalid or too long.')
  const normalized = validateRelativePath(value)
  for (const part of normalized.split('/'))
    if (part.includes('**') && part !== '**')
      throw new FilesToolValidationError('** must be a complete path segment.')
  return normalized
}
function globMatches(pattern: string, candidate: string): boolean {
  const ps = pattern.split('/'),
    cs = candidate.split('/')
  const match = (pi: number, ci: number): boolean =>
    pi === ps.length
      ? ci === cs.length
      : ps[pi] === '**'
        ? match(pi + 1, ci) || (ci < cs.length && match(pi, ci + 1))
        : ci < cs.length && segmentMatches(ps[pi], cs[ci]) && match(pi + 1, ci + 1)
  return match(0, 0)
}
function segmentMatches(pattern: string, value: string): boolean {
  let pi = 0,
    vi = 0,
    star = -1,
    mark = 0
  while (vi < value.length) {
    if (pi < pattern.length && (pattern[pi] === '?' || pattern[pi] === value[vi])) {
      pi++
      vi++
    } else if (pi < pattern.length && pattern[pi] === '*') {
      star = pi++
      mark = vi
    } else if (star >= 0) {
      pi = star + 1
      vi = ++mark
    } else return false
  }
  while (pattern[pi] === '*') pi++
  return pi === pattern.length
}
async function walkEntries(
  root: string,
  directory: string,
  maxDepth: number,
  maxEntries: number,
  maxChars: number,
  signal: AbortSignal | undefined,
  deadline: number
): Promise<{ entries: FilesTreeEntry[]; truncated: boolean }> {
  const entries: FilesTreeEntry[] = []
  let truncated = false
  const walk = async (current: string, depth: number): Promise<void> => {
    check(signal, deadline)
    const children = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) =>
      comparePath(a.name, b.name)
    )
    for (const child of children) {
      check(signal, deadline)
      if (entries.length >= maxEntries) {
        truncated = true
        return
      }
      if (child.isSymbolicLink()) continue
      const absolute = path.join(current, child.name)
      const stat = await fs.lstat(absolute)
      const relative = relativePath(root, absolute)
      if (relative.length > maxChars) {
        truncated = true
        continue
      }
      if (stat.isDirectory()) {
        entries.push({ path: relative, type: 'directory' })
        if (depth < maxDepth) await walk(absolute, depth + 1)
        else truncated = true
      } else if (stat.isFile()) entries.push({ path: relative, type: 'file', bytes: stat.size })
      if (truncated && entries.length >= maxEntries) return
    }
  }
  await walk(directory, 0)
  return { entries, truncated }
}
type SearchQuery = { regex?: RegExp; literal?: string; caseSensitive: boolean }
function validateQuery(
  value: string,
  mode: 'literal' | 'regex',
  caseSensitive: boolean
): SearchQuery {
  if (!value || value.length > LIMITS.pattern)
    throw new FilesToolValidationError('Search query is invalid or too long.')
  if (mode === 'literal')
    return { literal: caseSensitive ? value : value.toLocaleLowerCase('en'), caseSensitive }
  if (/\\[1-9]|\(\?[=!<:]|[{}|]|(?:\*|\+|\?){2}|\[[^\]]*$|\([^)]*[+*][^)]*\)[+*?]/.test(value))
    throw new FilesToolValidationError('Unsafe or unsupported regular expression.')
  try {
    return { regex: new RegExp(value, caseSensitive ? 'g' : 'gi'), caseSensitive }
  } catch {
    throw new FilesToolValidationError('Invalid regular expression.')
  }
}
function findMatches(line: string, query: SearchQuery): number[] {
  if (query.literal !== undefined) {
    const source = query.caseSensitive ? line : line.toLocaleLowerCase('en')
    const out: number[] = []
    let from = 0
    while ((from = source.indexOf(query.literal, from)) >= 0) {
      out.push(from)
      from += Math.max(1, query.literal.length)
    }
    return out
  }
  const out: number[] = []
  query.regex!.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = query.regex!.exec(line))) {
    out.push(match.index)
    if (!match[0]) query.regex!.lastIndex++
  }
  return out
}
function redactSecrets(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|token|password|secret|authorization)\b\s*[:=]\s*["']?[^\s,"']+/gi,
      '$1=[REDACTED]'
    )
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}

type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
function detectImage(buffer: Buffer): { mime: ImageMime } | undefined {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: 'image/png' }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return { mime: 'image/jpeg' }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  )
    return { mime: 'image/gif' }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return { mime: 'image/webp' }
  return undefined
}
function isKnownMediaExtension(file: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|pdf)$/i.test(file)
}
function imageDimensions(buffer: Buffer, mime: ImageMime): { width?: number; height?: number } {
  if (
    mime === 'image/png' &&
    buffer.length >= 24 &&
    buffer.subarray(12, 16).toString('ascii') === 'IHDR'
  )
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  if (mime === 'image/gif' && buffer.length >= 10)
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  if (mime === 'image/webp' && buffer.length >= 30) {
    const type = buffer.subarray(12, 16).toString('ascii')
    if (type === 'VP8X')
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
    if (
      type === 'VP8 ' &&
      buffer.length >= 30 &&
      buffer[23] === 0x9d &&
      buffer[24] === 0x01 &&
      buffer[25] === 0x2a
    )
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    if (type === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
    }
  }
  if (mime === 'image/jpeg') {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset++] !== 0xff) continue
      const marker = buffer[offset++]
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue
      if (offset + 2 > buffer.length) break
      const length = buffer.readUInt16BE(offset)
      if (length < 2 || offset + length > buffer.length) break
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      )
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) }
      offset += length
    }
  }
  return {}
}

function decodePdfString(value: string): string {
  return value
    .replace(
      /\\([nrtbf()\\])/g,
      (_match, escaped: string) =>
        ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[escaped] ?? escaped
    )
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8))
    )
}
function extractPdf(
  buffer: Buffer,
  maxChars: number,
  signal: AbortSignal | undefined,
  deadline: number
): {
  content: string
  metadata: Readonly<Record<string, string>>
  truncated: boolean
  incomplete: boolean
  encrypted: boolean
  unsupportedFilters: readonly string[]
} {
  const source = buffer.toString('latin1')
  const encrypted = /\/Encrypt\b/.test(source)
  const metadata: Record<string, string> = Object.create(null)
  for (const key of [
    'Title',
    'Author',
    'Subject',
    'Keywords',
    'Creator',
    'Producer',
    'CreationDate',
    'ModDate'
  ]) {
    const match = new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)]){0,4096})\\)`).exec(source)
    if (match) metadata[key] = redactSecrets(decodePdfString(match[1])).slice(0, 4096)
  }
  const unsupported = new Set<string>()
  const fragments: string[] = []
  let outputChars = 0
  let truncated = false
  let incomplete = encrypted || buffer.length === 0 || !/%%EOF\s*$/.test(source)
  const streamPattern = /<<(\s|.){0,16384}?>>\s*stream\r?\n/g
  let match: RegExpExecArray | null
  let streams = 0
  while ((match = streamPattern.exec(source)) && streams++ < 128) {
    check(signal, deadline)
    const dictionary = match[0].slice(0, match[0].lastIndexOf('stream'))
    const end = source.indexOf('endstream', streamPattern.lastIndex)
    if (end < 0) {
      incomplete = true
      break
    }
    const filters = [...dictionary.matchAll(/\/Filter\s*(?:\[([^\]]{0,256})\]|\/(\w+))/g)]
      .flatMap((item) => (item[1] ?? item[2] ?? '').match(/\/(\w+)|\w+/g) ?? [])
      .map((item) => item.replace(/^\//, ''))
    for (const filter of filters)
      if (filter !== 'FlateDecode' && filter !== 'Fl') unsupported.add(filter)
    if (filters.some((filter) => filter !== 'FlateDecode' && filter !== 'Fl')) {
      incomplete = true
      streamPattern.lastIndex = end + 9
      continue
    }
    let data = buffer.subarray(
      Buffer.byteLength(source.slice(0, streamPattern.lastIndex), 'latin1'),
      Buffer.byteLength(source.slice(0, end), 'latin1')
    )
    try {
      if (filters.length)
        data = inflateSync(data, { maxOutputLength: Math.min(LIMITS.bytes, maxChars * 8 + 65_536) })
    } catch {
      incomplete = true
      streamPattern.lastIndex = end + 9
      continue
    }
    const decoded = data.toString('latin1')
    for (const textMatch of decoded.matchAll(/\(((?:\\.|[^\\)]){0,16384})\)\s*(?:Tj|'|")/g)) {
      const text = redactSecrets(decodePdfString(textMatch[1]))
      const remaining = maxChars - outputChars
      if (text.length > remaining) {
        fragments.push(text.slice(0, remaining))
        truncated = true
        break
      }
      fragments.push(text)
      outputChars += text.length
    }
    for (const arrayMatch of decoded.matchAll(/\[((?:\s|.){0,32768}?)\]\s*TJ/g)) {
      const text = redactSecrets(
        [...arrayMatch[1].matchAll(/\(((?:\\.|[^\\)]){0,8192})\)/g)]
          .map((item) => decodePdfString(item[1]))
          .join('')
      )
      const remaining = maxChars - outputChars
      if (text.length > remaining) {
        fragments.push(text.slice(0, remaining))
        truncated = true
        break
      }
      fragments.push(text)
      outputChars += text.length
    }
    streamPattern.lastIndex = end + 9
    if (truncated) break
  }
  if (match || streams >= 128) {
    truncated = true
    incomplete = true
  }
  return {
    content: fragments.join('\n'),
    metadata,
    truncated,
    incomplete,
    encrypted,
    unsupportedFilters: [...unsupported].sort()
  }
}
function selectJson(value: unknown, pointer?: string): unknown {
  if (!pointer) return value
  const parts = pointer.startsWith('/')
    ? pointer
        .slice(1)
        .split('/')
        .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    : pointer.split('.')
  let current = value
  for (const part of parts) {
    if (!part || part === '__proto__' || part === 'prototype' || part === 'constructor')
      throw new FilesToolValidationError('Invalid JSON selection path.')
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)]
    else if (
      current &&
      typeof current === 'object' &&
      Object.prototype.hasOwnProperty.call(current, part)
    )
      current = (current as Record<string, unknown>)[part]
    else throw new FilesToolValidationError('JSON selection path was not found.')
  }
  return current
}
function boundJson(
  value: unknown,
  maxDepth: number,
  maxEntries: number,
  maxString: number
): { value: unknown; truncated: boolean } {
  let entries = 0,
    truncated = false
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') {
      const redacted = redactSecrets(item)
      if (redacted.length > maxString) {
        truncated = true
        return redacted.slice(0, maxString)
      }
      return redacted
    }
    if (!item || typeof item !== 'object') return item
    if (depth >= maxDepth) {
      truncated = true
      return Array.isArray(item) ? [] : {}
    }
    if (Array.isArray(item)) {
      const out: unknown[] = []
      for (const child of item) {
        if (++entries > maxEntries) {
          truncated = true
          break
        }
        out.push(visit(child, depth + 1))
      }
      return out
    }
    const out: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(item as object).sort(comparePath)) {
      if (++entries > maxEntries) {
        truncated = true
        break
      }
      out[key] = /^(?:api[_-]?key|token|password|secret|authorization)$/i.test(key)
        ? '[REDACTED]'
        : visit((item as Record<string, unknown>)[key], depth + 1)
    }
    return out
  }
  return { value: visit(value, 0), truncated }
}
async function readBounded(file: string, bytes: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const result = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}
function relativePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/') || '.'
}
function comparePath(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'case', numeric: false })
}
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value!) : fallback))
}
function check(signal: AbortSignal | undefined, deadline: number): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
  if (Date.now() > deadline) throw new FilesToolValidationError('File tool runtime limit exceeded.')
}
function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as { name?: string })?.name === 'AbortError'
}
function isBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true
  let controls = 0
  for (const byte of buffer) if (byte < 9 || (byte > 13 && byte < 32)) controls++
  return buffer.length > 0 && controls / buffer.length > 0.05
}
async function hashFile(
  file: string,
  signal: AbortSignal | undefined,
  deadline: number
): Promise<string> {
  const hash = createHash('sha256')
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    let position = 0
    for (;;) {
      check(signal, deadline)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}
function countOccurrences(value: string, needle: string): number {
  let count = 0,
    from = 0
  while ((from = value.indexOf(needle, from)) >= 0) {
    count++
    from += needle.length
  }
  return count
}
function validateReplacements(
  replacements: readonly { old: string; new: string; expectedOccurrences: number }[],
  tool: string
): void {
  if (
    !Array.isArray(replacements) ||
    !replacements.length ||
    replacements.length > LIMITS.replacements
  )
    throw new FilesToolValidationError(`${tool} requires a bounded non-empty replacements list.`)
  for (const replacement of replacements)
    if (
      !replacement ||
      typeof replacement.old !== 'string' ||
      !replacement.old ||
      typeof replacement.new !== 'string' ||
      !Number.isSafeInteger(replacement.expectedOccurrences) ||
      replacement.expectedOccurrences < 1
    )
      throw new FilesToolValidationError(
        'Each replacement requires non-empty exact old text and a positive occurrence expectation.'
      )
}
function applyReplacements(
  before: string,
  replacements: readonly { old: string; new: string; expectedOccurrences: number }[]
): string {
  let value = before
  for (const replacement of replacements) {
    const count = countOccurrences(value, replacement.old)
    if (count !== replacement.expectedOccurrences)
      throw new FilesToolValidationError(
        `Exact replacement occurrence expectation failed: expected ${replacement.expectedOccurrences}, found ${count}.`
      )
    value = value.split(replacement.old).join(replacement.new)
  }
  return value
}
function parseSafeJson(text: string): unknown {
  return JSON.parse(text, (key, value) => {
    if (prototypeKey(key))
      throw new FilesToolValidationError('JSON prototype keys are not allowed.')
    return value
  })
}
function prototypeKey(key: string): boolean {
  return key === '__proto__' || key === 'prototype' || key === 'constructor'
}
function validateJsonValue(value: unknown): void {
  let entries = 0
  const visit = (item: unknown, depth: number): void => {
    if (depth > LIMITS.depth || ++entries > LIMITS.jsonEntries)
      throw new FilesToolValidationError('JSON value exceeds structural limits.')
    if (typeof item === 'number' && !Number.isFinite(item))
      throw new FilesToolValidationError('JSON numbers must be finite.')
    if (
      typeof item === 'undefined' ||
      typeof item === 'function' ||
      typeof item === 'symbol' ||
      typeof item === 'bigint'
    )
      throw new FilesToolValidationError('Value is not JSON-safe.')
    if (!item || typeof item !== 'object') return
    for (const key of Object.keys(item as object)) {
      if (prototypeKey(key))
        throw new FilesToolValidationError('JSON prototype keys are not allowed.')
      visit((item as Record<string, unknown>)[key], depth + 1)
    }
  }
  visit(value, 0)
}
function updateJson(value: unknown, pointer: string, replacement: unknown): unknown {
  validateJsonValue(replacement)
  const parts = pointer.startsWith('/')
    ? pointer
        .slice(1)
        .split('/')
        .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    : pointer.split('.')
  if (!parts.length || parts.some((p) => !p || prototypeKey(p)))
    throw new FilesToolValidationError('Invalid JSON update path.')
  let current: unknown = value
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)]
    else if (
      current &&
      typeof current === 'object' &&
      Object.prototype.hasOwnProperty.call(current, part)
    )
      current = (current as Record<string, unknown>)[part]
    else throw new FilesToolValidationError('JSON update path was not found.')
  }
  const last = parts[parts.length - 1]
  if (Array.isArray(current) && /^\d+$/.test(last) && Number(last) < current.length)
    current[Number(last)] = replacement
  else if (
    current &&
    typeof current === 'object' &&
    Object.prototype.hasOwnProperty.call(current, last)
  )
    (current as Record<string, unknown>)[last] = replacement
  else throw new FilesToolValidationError('JSON update path was not found.')
  return value
}
function reserved(relative: string): boolean {
  return relative === '.magicpot' || relative.startsWith('.magicpot/')
}
function requestedPolicyPath(request: PolicyRequest): string {
  return typeof request.input.path === 'string' ? request.input.path : '.'
}
type PreparedMutation = {
  root: string
  target: string
  path: string
  beforeBuffer: Buffer
  beforeSha256?: string
  existed: boolean
  mode?: number
  afterBuffer: Buffer
  afterSha256: string
  diff: string
  additions: number
  deletions: number
}
function mutationOutput(
  item: PreparedMutation,
  snapshot: { snapshotId: string; restoreToken: string },
  durationMs: number
): FilesMutationOutput {
  return {
    root: item.root,
    path: item.path,
    created: !item.existed,
    beforeSha256: item.beforeSha256,
    afterSha256: item.afterSha256,
    bytes: item.afterBuffer.length,
    diff: item.diff,
    diffBytes: Buffer.byteLength(item.diff),
    additions: item.additions,
    deletions: item.deletions,
    ...snapshot,
    durationMs
  }
}
async function restorePrepared(item: PreparedMutation): Promise<void> {
  if (item.existed) await atomicReplace(item.target, item.beforeBuffer, item.mode)
  else await atomicDelete(item.target)
}
type SnapshotManifest = {
  version: number
  path: string
  existed: boolean
  beforeSha256: string | null
  afterSha256: string
  bytes: number
  snapshotId: string
  restoreToken: string
}
function snapshotRoot(root: string): string {
  return path.join(root, '.magicpot', 'tool-host', 'snapshots')
}
function snapshotContentPath(root: string, id: string): string {
  return path.join(snapshotRoot(root), id, 'content')
}
async function loadSnapshot(root: string, token: string): Promise<SnapshotManifest> {
  const match = /^files-restore:([0-9a-f]{64})$/.exec(token)
  if (!match) throw new FilesToolValidationError('Invalid snapshot token.')
  const file = path.join(snapshotRoot(root), match[1], 'manifest.json')
  let parsed: SnapshotManifest
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    throw new FilesToolValidationError('Snapshot was not found or is invalid.')
  }
  const core = {
    version: parsed.version,
    path: parsed.path,
    existed: parsed.existed,
    beforeSha256: parsed.beforeSha256,
    afterSha256: parsed.afterSha256,
    bytes: parsed.bytes
  }
  if (
    parsed.snapshotId !== match[1] ||
    parsed.restoreToken !== token ||
    sha256(JSON.stringify(core)) !== parsed.snapshotId ||
    reserved(validateRelativePath(parsed.path))
  )
    throw new FilesToolValidationError('Snapshot manifest validation failed.')
  return parsed
}
function publicManifest(manifest: SnapshotManifest) {
  return {
    snapshotId: manifest.snapshotId,
    restoreToken: manifest.restoreToken,
    path: manifest.path,
    existed: manifest.existed,
    beforeSha256: manifest.beforeSha256 ?? undefined,
    afterSha256: manifest.afterSha256,
    bytes: manifest.bytes
  }
}
function diffStats(before: string, after: string): { additions: number; deletions: number } {
  const a = before.split(/\r?\n/),
    b = after.split(/\r?\n/)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++
  return { deletions: a.length - prefix - suffix, additions: b.length - prefix - suffix }
}
function buildUnifiedDiff(relative: string, before: string, after: string): string {
  if (before === after) return ''
  const a = before.split(/\r?\n/),
    b = after.split(/\r?\n/)
  const lines = [`--- a/${relative}`, `+++ b/${relative}`, `@@ -1,${a.length} +1,${b.length} @@`]
  for (const line of a) lines.push(`-${line}`)
  for (const line of b) lines.push(`+${line}`)
  return `${lines.join('\n')}\n`
}
async function assertUnchanged(target: string, existed: boolean, expected?: string): Promise<void> {
  try {
    const stat = await fs.lstat(target)
    if (!existed || !stat.isFile() || sha256(await fs.readFile(target)) !== expected)
      throw new FilesToolValidationError('File changed while preparing the mutation.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existed) return
    throw error
  }
}
async function createSnapshot(
  root: string,
  relative: string,
  before: Buffer,
  beforeSha256: string | undefined,
  afterSha256: string,
  existed: boolean
): Promise<{ snapshotId: string; restoreToken: string }> {
  const manifestCore = {
    version: 1,
    path: relative,
    existed,
    beforeSha256: beforeSha256 ?? null,
    afterSha256,
    bytes: before.length
  }
  const snapshotId = sha256(JSON.stringify(manifestCore))
  const restoreToken = `files-restore:${snapshotId}`
  const dir = path.join(root, '.magicpot', 'tool-host', 'snapshots', snapshotId)
  await fs.mkdir(dir, { recursive: true })
  if (existed)
    await fs
      .writeFile(path.join(dir, 'content'), before, { flag: 'wx' })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
  await fs
    .writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...manifestCore, snapshotId, restoreToken }, null, 2),
      { flag: 'wx' }
    )
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  return { snapshotId, restoreToken }
}
async function atomicReplace(target: string, content: Buffer, mode?: number): Promise<void> {
  const directory = path.dirname(target)
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`
  )
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(temporary, 'wx', mode === undefined ? 0o600 : mode & 0o777)
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, target)
    try {
      const dir = await fs.open(directory, 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    } catch {
      /* directory fsync is not supported on every platform */
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
async function atomicDelete(target: string): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.deleted`
  )
  await fs.rename(target, temporary)
  try {
    await fs.rm(temporary)
  } catch (error) {
    await fs.rename(temporary, target).catch(() => undefined)
    throw error
  }
}
