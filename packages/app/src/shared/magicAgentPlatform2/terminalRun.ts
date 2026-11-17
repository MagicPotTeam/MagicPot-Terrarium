export type TerminalRunStatus = 'completed' | 'timed-out' | 'output-limit' | 'failed' | 'cancelled'

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
  /**
   * win32 only, present when the run was stopped (timeout, output limit or cancel): how the
   * process tree was stopped. 'job-object': the Job Object helper was terminated, which kills the
   * whole job. 'tree-swept': taskkill plus a process-table sweep confirmed that no member of the
   * tree is alive. 'tree-unconfirmed': no snapshot could be taken or the sweep deadline passed, so
   * descendants may still be running.
   */
  processTreeStop?: 'job-object' | 'tree-swept' | 'tree-unconfirmed'
}>
