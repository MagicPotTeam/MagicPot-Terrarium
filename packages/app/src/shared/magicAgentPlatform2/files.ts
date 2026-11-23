/**
 * Optional KohakuTerrarium-style walk filtering. Absent fields keep the original
 * unfiltered walk: hidden entries listed, no .gitignore rules, no skipped directories.
 */
export type FilesWalkFilter = Readonly<{
  /** List dot-prefixed entries. Default true. */
  hidden?: boolean
  /** Follow directory-scoped .gitignore rules. Default false. */
  gitignore?: boolean
  /** Skip .git, node_modules, __pycache__, venv and similar directories. Default false. */
  skipCommonDirectories?: boolean
}>

export type FilesTreeInput = Readonly<{
  path?: string
  maxDepth?: number
  maxEntries?: number
  maxStringLength?: number
  timeoutMs?: number
}> &
  FilesWalkFilter

export type FilesReadInput = Readonly<{
  path: string
  maxBytes?: number
  maxStringLength?: number
  timeoutMs?: number
  /** 0-based first line of a plain-text window. */
  offset?: number
  /** Number of lines in a plain-text window. */
  limit?: number
}>

export type FilesGlobInput = Readonly<{
  pattern: string
  path?: string
  maxDepth?: number
  maxFiles?: number
  maxStringLength?: number
  timeoutMs?: number
  /** Return files only, without directories. Default false. */
  filesOnly?: boolean
  /** Result order: by path (default) or most recently modified first. */
  order?: 'path' | 'mtime'
}> &
  FilesWalkFilter

export type FilesGrepInput = Readonly<{
  query: string
  mode?: 'literal' | 'regex'
  path?: string
  fileGlob?: string
  caseSensitive?: boolean
  maxDepth?: number
  maxFiles?: number
  maxMatches?: number
  maxReadBytes?: number
  maxSnippetLength?: number
  timeoutMs?: number
  /** One match per matching line (its first column) instead of one per occurrence. */
  perLine?: boolean
}> &
  FilesWalkFilter

export type FilesJsonReadInput = Readonly<{
  path: string
  pointer?: string
  maxBytes?: number
  maxDepth?: number
  maxEntries?: number
  maxStringLength?: number
  timeoutMs?: number
}>

export type FilesWriteInput = Readonly<{
  path: string
  content: string
  create?: boolean
  expectedSha256?: string
  maxBytes?: number
  maxDiffBytes?: number
  timeoutMs?: number
}>

export type FilesEditReplacement = Readonly<{
  old: string
  new: string
  expectedOccurrences: number
}>

export type FilesEditMode = 'strict' | 'partial' | 'best_effort'
export type FilesEditStep = Readonly<{
  index: number
  status: 'applied' | 'unchanged' | 'failed' | 'skipped'
  expectedOccurrences: number
  observedOccurrences?: number
}>
export type FilesEditReport = Readonly<{
  mode: FilesEditMode
  /** Successfully evaluated steps, including no-change steps; not a count of committed writes. */
  applied: number
  failed: number
  skipped: number
  steps: readonly FilesEditStep[]
  /** Target rename completed. Does not prove later external bytes or successful audit/journal persistence. */
  writeStatus: 'not-written' | 'committed'
  fileChanged: boolean
}>

export type FilesEditInput = Readonly<{
  path: string
  expectedSha256: string
  mode?: FilesEditMode
  replacements: readonly FilesEditReplacement[]
  maxBytes?: number
  maxDiffBytes?: number
  timeoutMs?: number
}>

export type FilesPatchInput = Readonly<{
  path: string
  patch: string
  expectedSha256: string
  maxBytes?: number
  maxDiffBytes?: number
  timeoutMs?: number
}>
export type FilesPatchOutput = FilesMutationOutput

export type FilesMultiEditItem = Readonly<{
  path: string
  expectedSha256: string
  replacements: readonly FilesEditReplacement[]
}>
export type FilesMultiEditInput = Readonly<{
  edits: readonly FilesMultiEditItem[]
  maxBytes?: number
  maxDiffBytes?: number
  timeoutMs?: number
}>
export type FilesMultiEditOutput = Readonly<{
  root: string
  files: readonly FilesMutationOutput[]
  rollback: Readonly<{
    attempted: boolean
    succeeded: boolean
    restoredPaths: readonly string[]
    failedPaths: readonly string[]
  }>
  durationMs: number
}>
export type FilesJsonWriteInput = Readonly<{
  path: string
  value?: unknown
  update?: Readonly<{ path: string; value: unknown }>
  create?: boolean
  expectedSha256?: string
  maxBytes?: number
  maxDiffBytes?: number
  timeoutMs?: number
}>
export type FilesJsonWriteOutput = FilesMutationOutput
export type FilesDiffInput = Readonly<{
  path: string
  text?: string
  snapshotToken?: string
  maxBytes?: number
  maxDiffBytes?: number
  timeoutMs?: number
}>
export type FilesDiffOutput = Readonly<{
  root: string
  path: string
  currentSha256: string
  comparedSha256?: string
  diff: string
  diffBytes: number
  additions: number
  deletions: number
  truncated: boolean
  durationMs: number
}>
export type FilesSnapshotListInput = Readonly<{
  path?: string
  maxEntries?: number
  timeoutMs?: number
}>
export type FilesSnapshotMetadata = Readonly<{
  snapshotId: string
  restoreToken: string
  path: string
  existed: boolean
  beforeSha256?: string
  afterSha256: string
  bytes: number
}>
export type FilesSnapshotListOutput = Readonly<{
  root: string
  snapshots: readonly FilesSnapshotMetadata[]
  entryCount: number
  truncated: boolean
  durationMs: number
}>
export type FilesSnapshotRestoreInput = Readonly<{
  path: string
  restoreToken: string
  expectedSha256: string
  timeoutMs?: number
}>
export type FilesSnapshotRestoreOutput = Readonly<{
  root: string
  path: string
  deleted: boolean
  beforeSha256: string
  afterSha256?: string
  snapshotId: string
  restoreToken: string
  safetySnapshotId: string
  safetyRestoreToken: string
  durationMs: number
}>

export type FilesMutationOutput = Readonly<{
  root: string
  path: string
  created: boolean
  beforeSha256?: string
  afterSha256: string
  bytes: number
  diff: string
  diffBytes: number
  additions: number
  deletions: number
  snapshotId: string
  restoreToken: string
  durationMs: number
}>

export type FilesWriteOutput = FilesMutationOutput
export type FilesEditOutput = FilesMutationOutput & Readonly<{ report: FilesEditReport }>

export type FilesTreeEntry = Readonly<{
  path: string
  type: 'file' | 'directory'
  bytes?: number
  sha256?: string
}>

export type FilesTreeOutput = Readonly<{
  root: string
  path: string
  entries: readonly FilesTreeEntry[]
  entryCount: number
  truncated: boolean
  durationMs: number
}>

export type FilesGlobOutput = Readonly<{
  root: string
  pattern: string
  entries: readonly FilesTreeEntry[]
  entryCount: number
  truncated: boolean
  durationMs: number
}>

export type FilesGrepMatch = Readonly<{
  path: string
  line: number
  column: number
  snippet: string
}>

export type FilesGrepOutput = Readonly<{
  root: string
  matches: readonly FilesGrepMatch[]
  matchCount: number
  filesSearched: number
  binaryFilesSkipped: number
  truncated: boolean
  durationMs: number
}>

export type FilesTextReadOutput = Readonly<{
  kind: 'text'
  root: string
  path: string
  content: string
  bytes: number
  returnedBytes: number
  sha256: string
  truncated: boolean
  durationMs: number
  /** Present only when offset or limit asked for a line window. */
  lineOffset?: number
  lineCount?: number
  /** Lines in the bytes read; a lower bound when the file was longer than maxBytes. */
  totalLines?: number
  totalLinesComplete?: boolean
}>

export type FilesImageReadOutput = Readonly<{
  kind: 'image'
  root: string
  path: string
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  base64: string
  bytes: number
  returnedBytes: number
  width?: number
  height?: number
  sha256: string
  truncated: boolean
  durationMs: number
}>

export type FilesPdfReadOutput = Readonly<{
  kind: 'pdf'
  root: string
  path: string
  content: string
  metadata: Readonly<Record<string, string>>
  bytes: number
  returnedBytes: number
  sha256: string
  truncated: boolean
  incomplete: boolean
  encrypted: boolean
  unsupportedFilters: readonly string[]
  durationMs: number
}>

/** Text retains every legacy field; `kind` only adds discrimination. */
export type FilesReadOutput = FilesTextReadOutput | FilesImageReadOutput | FilesPdfReadOutput

export type FilesJsonReadOutput = Readonly<{
  root: string
  path: string
  pointer?: string
  value: unknown
  bytes: number
  sha256: string
  truncated: boolean
  durationMs: number
}>
