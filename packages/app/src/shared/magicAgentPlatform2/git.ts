export type GitToolCommonInput = Readonly<{
  repository?: string
  timeoutMs?: number
  maxOutputBytes?: number
}>

export type GitStatusInput = GitToolCommonInput
export type GitDiffInput = GitToolCommonInput &
  Readonly<{ revision?: string; pathspecs?: readonly string[] }>
export type GitLogInput = GitToolCommonInput &
  Readonly<{ revision?: string; pathspecs?: readonly string[]; maxCommits?: number }>
export type GitShowInput = GitToolCommonInput &
  Readonly<{ revision: string; pathspecs?: readonly string[] }>
export type GitBranchInput = GitToolCommonInput & Readonly<{ branch: string; expectedHead: string }>
export type GitCheckoutInput = GitToolCommonInput &
  Readonly<{ branch: string; expectedHead: string; expectedStatusDigest: string }>
export type GitAddInput = GitToolCommonInput &
  Readonly<{ pathspecs: readonly string[]; expectedHead: string; expectedStatusDigest: string }>
export type GitCommitInput = GitToolCommonInput &
  Readonly<{ message: string; expectedHead: string; expectedStagedDiffDigest: string }>

export type GitStatusEntry = Readonly<{
  path: string
  index: string
  worktree: string
  originalPath?: string
}>
export type GitCommit = Readonly<{
  hash: string
  authorName: string
  authorEmail: string
  authoredAt: string
  subject: string
}>
export type GitFileStat = Readonly<{ path: string; additions: number; deletions: number }>

export type GitStatusOutput = Readonly<{
  repository: string
  branch?: string
  head?: string
  entries: readonly GitStatusEntry[]
  statusDigest: string
  stagedDiffDigest: string
  raw: string
  truncated: boolean
  durationMs: number
}>
export type GitDiffOutput = Readonly<{
  repository: string
  revision?: string
  pathspecs: readonly string[]
  files: readonly GitFileStat[]
  additions: number
  deletions: number
  diff: string
  truncated: boolean
  durationMs: number
}>
export type GitLogOutput = Readonly<{
  repository: string
  revision?: string
  pathspecs: readonly string[]
  commits: readonly GitCommit[]
  count: number
  truncated: boolean
  durationMs: number
}>
export type GitShowOutput = Readonly<{
  repository: string
  revision: string
  pathspecs: readonly string[]
  commit: GitCommit
  files: readonly GitFileStat[]
  additions: number
  deletions: number
  diff: string
  truncated: boolean
  durationMs: number
}>
export type GitBranchOutput = Readonly<{
  repository: string
  branch: string
  beforeHead: string
  afterHead: string
  durationMs: number
}>
export type GitCheckoutOutput = Readonly<{
  repository: string
  branch: string
  beforeHead: string
  afterHead: string
  statusDigest: string
  durationMs: number
}>
export type GitAddOutput = Readonly<{
  repository: string
  pathspecs: readonly string[]
  beforeHead: string
  afterHead: string
  beforeStatusDigest: string
  afterStatusDigest: string
  stagedDiffDigest: string
  previewFiles: readonly GitFileStat[]
  indexSnapshot: string
  rollback: 'not-needed' | 'restored' | 'uncertain'
  durationMs: number
}>
export type GitCommitOutput = Readonly<{
  repository: string
  beforeHead: string
  afterHead: string
  parentHead: string
  stagedDiffDigest: string
  files: readonly GitFileStat[]
  durationMs: number
}>
