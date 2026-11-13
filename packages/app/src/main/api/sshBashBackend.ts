export type SshBashConfig = { host: string; port?: number; user: string; key_filename?: string; password?: string; known_hosts_policy?: 'auto_add' | 'reject' | 'warn'; keep_alive_seconds?: number; default_timeout_seconds?: number; max_result_size_chars?: number }
export type SshSession = {
  isActive(): boolean
  execute(commandLine: string): Promise<{ stdout: string; stderr: string; exitCode: number; stdoutChars?: number; stderrChars?: number }>
  close(): Promise<void>
}
export type SshConnector = (config: SshBashConfig) => Promise<SshSession>
export const quotePosixArgument = (value: string) => /^[a-zA-Z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`
/** Upstream pooled-session contract; real connector is optional and unavailable until installed.
 * Timeouts stop local waiting only, never claim remote command termination.
 */
export function createSshBashBackend(config: SshBashConfig, connect: SshConnector) {
  const settings = { port: 22, known_hosts_policy: 'auto_add' as const, keep_alive_seconds: 30, default_timeout_seconds: 120, max_result_size_chars: 200000, ...structuredClone(config) }
  let session: SshSession | undefined, connecting: Promise<SshSession> | undefined, busy = false, closed = false
  const ensure = async () => {
    if (session?.isActive()) return session
    if (!connecting) connecting = connect(settings).then(value => { session = value; return value }).finally(() => { connecting = undefined })
    return connecting
  }
  return Object.freeze({
    async execute(command: string, shell = 'bash', timeout = settings.default_timeout_seconds, signal?: AbortSignal) {
      if (closed || busy) throw new Error('SSH backend closed or busy.')
      if (!command.trim() || !['bash','sh','zsh','fish'].includes(shell) || !Number.isFinite(timeout)) throw new Error('Invalid SSH command.')
      busy = true
      const deadline = timeout > 0 ? Date.now() + timeout * 1000 : undefined
      let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
      try {
        signal?.throwIfAborted()
        let cancelWait!: () => void
        const stopped = new Promise<never>((_resolve,reject) => { cancelWait = () => reject(new Error('SSH local waiting ended.')) })
        abort = cancelWait
        signal?.addEventListener('abort',abort,{once:true})
        if (timeout > 0) timer = setTimeout(cancelWait,timeout*1000)
        let client: SshSession
        try { client = await Promise.race([ensure(),stopped]) } catch(error) {
          if (signal?.aborted || error instanceof Error && error.message === 'SSH local waiting ended.') return { error: signal?.aborted ? 'Local waiting cancelled; remote command may continue.' : `Command timed out after ${timeout}s`, remoteMayContinue:true }
          throw error
        }
        if (timer) clearTimeout(timer)
        if (abort) signal?.removeEventListener('abort',abort)
        if (closed) throw new Error('SSH backend closed.')
        signal?.throwIfAborted()
        const waiting = new Promise<{ error: string; remoteMayContinue: true }>(resolve => {
          abort = () => resolve({ error: 'Local waiting cancelled; remote command may continue.', remoteMayContinue: true })
          signal?.addEventListener('abort', abort, { once: true })
          if (timeout > 0) timer = setTimeout(() => resolve({ error: `Command timed out after ${timeout}s`, remoteMayContinue: true }), Math.max(0, (deadline ?? Date.now()) - Date.now()))
        })
        const result = await Promise.race([client.execute(`${shell} -c ${quotePosixArgument(command.trim())}`), waiting])
        if ('error' in result) return result
        const output = result.stdout + (result.stderr ? (result.stdout && !result.stdout.endsWith('\n') ? '\n' : '') + result.stderr : '')
        const chars = Array.from(output), max = settings.max_result_size_chars
        const total = (result.stdoutChars ?? Array.from(result.stdout).length) + (result.stderrChars ?? Array.from(result.stderr).length) + (result.stderr && result.stdout && !result.stdout.endsWith('\n') ? 1 : 0)
        return { exitCode: result.exitCode, output: max > 0 && total > max ? chars.slice(0,max).join('') + `\n... (truncated, ${total-max} chars omitted)` : output, remoteMayContinue: false }
      } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); busy = false }
    },
    async close() { closed = true; try { await connecting } catch { /* best effort */ } const client = session; session = undefined; await client?.close() }
  })
}
