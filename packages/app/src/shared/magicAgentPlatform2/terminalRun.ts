export type TerminalRunStatus = 'completed' | 'timed-out' | 'output-limit' | 'failed'

export type TerminalRunAuditEvidence = Readonly<{
  tool: 'terminal.run'
  authorizationId: string
  status: TerminalRunStatus
  commandSha256: string
  commandChars: number
  argsSha256: string
  argsCount: number
  argsChars: number
  cwdSha256: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdoutSha256: string
  stdoutChars: number
  stderrSha256: string
  stderrChars: number
  truncated: boolean
  durationMs: number
}>
