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
   * process tree was stopped.
   * - 'job-object': the Job Object helper was terminated, which makes Windows kill every process
   *   of the job. The only value that means nothing of the tree runs any more.
   * - 'tree-swept': no Job Object. taskkill plus a process-table sweep found no live process
   *   linked by parent pid to the command. NOT covered: descendants whose parent had exited
   *   before the stop (orphans) and children of processes the sweep never saw alive. Such
   *   processes can still be running.
   * - 'tree-unconfirmed': no Job Object, and no snapshot could be taken or the sweep deadline
   *   passed: linked descendants may still be running, too.
   */
  processTreeStop?: 'job-object' | 'tree-swept' | 'tree-unconfirmed'
}>
