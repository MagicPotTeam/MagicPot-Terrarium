import { describe, expect, it, vi } from 'vitest'
import { createSshBashBackend, type SshBashConfig } from './sshBashBackend'
describe('upstream SSH pooled-session behavior', () => {
  it('defaults auto_add and reuses lazy session, quoting and merging stdout then stderr', async () => {
    const session = { isActive: () => true, execute: vi.fn(async (_line: string) => ({ stdout: 'out', stderr: 'err', exitCode: 2 })), close: vi.fn(async () => {}) }
    const connect = vi.fn(async (_config: SshBashConfig) => session)
    const backend = createSshBashBackend({ host: 'fixture', user: 'fixture' }, connect)
    expect(connect).not.toHaveBeenCalled()
    expect(await backend.execute("echo 'x'")).toMatchObject({ output: 'out\nerr', exitCode: 2 })
    await backend.execute('pwd', 'sh')
    expect(connect).toHaveBeenCalledOnce()
    expect(connect.mock.calls[0][0]).toMatchObject({ known_hosts_policy: 'auto_add', port: 22 })
    expect(session.execute.mock.calls[0][0]).toBe(`bash -c 'echo '"'"'x'"'"''`)
    await backend.close(); await backend.close()
    expect(session.close).toHaveBeenCalledOnce()
  })
  it('timeouts stop only local waiting and do not close the pooled session', async () => {
    vi.useFakeTimers()
    try {
      const session = { isActive: () => true, execute: vi.fn(() => new Promise<{ stdout:string; stderr:string; exitCode:number }>(() => {})), close: vi.fn(async () => {}) }
      const backend = createSshBashBackend({ host:'fixture',user:'fixture' }, async () => session)
      const pending = backend.execute('sleep 60','bash',1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await pending).toMatchObject({ error:'Command timed out after 1s',remoteMayContinue:true })
      expect(session.close).not.toHaveBeenCalled()
      await backend.close()
    } finally { vi.useRealTimers() }
  })
})
