import { describe, expect, it, vi } from 'vitest'
import { createAgentThreadShellTools } from './agentThreadShellTools'
import { createAgentThreadToolProvider } from './agentThreadTools'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' } as const
const setup = (initial = true) => {
  let enabled = initial
  const controller = new AbortController(), execute = vi.fn(async () => ({ state: 'completed', exitCode: 0 }))
  const assertInvocation = vi.fn(), assertLive = vi.fn()
  const provider = createAgentThreadShellTools({ route, conversationId: 'chat', signal: controller.signal, enabled: () => enabled, execute, assertInvocation, assertLive })
  const context = { route, runId: 'r', workspaceRootDir: 'C:/owned/workspace' }
  const call = (args: Record<string, unknown> = { code: 'echo approved' }) => provider.callTool('shell.execute', args, context)
  return { provider, call, context, execute, controller, assertInvocation, assertLive, setEnabled: (value: boolean) => { enabled = value } }
}
describe('local thread shell tools', () => {
  it('reads the actual admitted shell schema passively without spending two explicit execution attempts', async () => {
    const t = setup(), request = vi.fn()
    const info = createAgentThreadToolProvider({ route, messages: [], assertInvocation: t.assertInvocation, listVisibleTools: () => t.provider.listTools(), interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: t.controller.signal } })
    for (let i = 0; i < 3; i++) {
      const result = JSON.parse((await info.callTool('info', { name: 'shell.execute' }, t.context)).content)
      expect(result.inputSchema).toEqual(t.provider.listTools()[0].inputSchema)
      expect(result.documentation).toMatchObject({ contract: 'magicpot-local-shell-execution-manual/v1', authority: { requiresFreshFormalApproval: true, filesystemNetworkSandbox: false }, limits: { codeUtf8Bytes: 6000, synchronousAttemptsPerRequest: 2 } })
    }
    expect(t.execute).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled()
    for (const args of [{ code: 'echo x', approved: true }, { code: 'echo x', type: 'bash' }, { code: 'echo x', timeoutMs: 99 }, { code: 'echo x', maxOutputBytes: 511 }]) await expect(t.call(args)).rejects.toThrow('Invalid')
    expect(t.execute).not.toHaveBeenCalled()
    await t.call({ code: 'echo first', timeoutMs: 100, maxOutputBytes: 512 })
    await t.call({ code: 'echo second', timeoutMs: 120000, maxOutputBytes: 262144 })
    expect(t.execute).toHaveBeenCalledTimes(2)
    expect(t.execute).toHaveBeenLastCalledWith(expect.objectContaining({ input: { code: 'echo second', timeoutMs: 120000, maxOutputBytes: 262144 } }))
    await expect(t.call()).rejects.toThrow('budget')
    expect(t.execute).toHaveBeenCalledTimes(2); expect(request).not.toHaveBeenCalled()
  })
  it('cannot read or unlock an unadmitted shell by documentation and rechecks disablement after a passive read', async () => {
    const off = setup(false)
    const absent = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => off.provider.listTools() })
    await expect(absent.callTool('info', { name: 'shell.execute' }, off.context)).rejects.toThrow('not available')
    off.setEnabled(true)
    await expect(absent.callTool('info', { name: 'shell.execute' }, off.context)).rejects.toThrow('not available')
    await expect(off.call()).rejects.toThrow('outside'); expect(off.execute).not.toHaveBeenCalled()
    const t = setup()
    const admitted = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => t.provider.listTools() })
    const result = JSON.parse((await admitted.callTool('info', { name: 'shell.execute' }, t.context)).content)
    expect(result.documentation.authority.readingUnlocksTool).toBe(false)
    t.setEnabled(false); await expect(t.call()).rejects.toThrow('disabled'); expect(t.execute).not.toHaveBeenCalled()
  })
  it('defaults off and cannot gain admission mid-request', async () => {
    const t = setup(false); expect(t.provider.listTools()).toEqual([])
    t.setEnabled(true); await expect(t.call()).rejects.toThrow('outside')
    expect(t.execute).not.toHaveBeenCalled()
  })
  it('passes only exact bounded code and main-owned identity and rejects cross-route or missing workspace', async () => {
    const t = setup(); expect(t.provider.listTools().map((tool) => tool.name)).toEqual(['shell.execute'])
    await t.call({ code: 'echo "reviewed"', cwd: 'src', timeoutMs: 1000 })
    expect(t.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'shell.execute', route, conversationId: 'chat', input: { code: 'echo "reviewed"', cwd: 'src', timeoutMs: 1000 }, workspaceRoot: 'C:/owned/workspace' }))
    await expect(t.provider.callTool('shell.execute', { code: 'echo x' }, { ...t.context, route: { ...route, threadId: 'other' } })).rejects.toThrow('outside')
    await expect(t.provider.callTool('shell.execute', { code: 'echo x' }, { ...t.context, workspaceRootDir: undefined })).rejects.toThrow('outside')
  })
  it.each([{ code: 'echo x', command: 'evil' }, { code: 'echo x', env: { SECRET: 'x' } }, { code: 'echo x', background: true }, { code: ' ' }, { code: 'a\0b' }, { code: '字'.repeat(2001) }, { code: 'a'.repeat(6001) }, { code: 'echo x', timeoutMs: 120001 }])('rejects unsupported or oversized inputs %j', async (args) => {
    const t = setup(); await expect(t.call(args)).rejects.toThrow('Invalid'); expect(t.execute).not.toHaveBeenCalled()
  })
  it('caps calls, checks revocation after execution and binds inherited invocation liveness', async () => {
    const t = setup(); await t.call(); await t.call(); await expect(t.call()).rejects.toThrow('budget')
    const revoked = setup(); revoked.execute.mockImplementationOnce(async () => { revoked.setEnabled(false); return { state: 'completed', exitCode: 0 } })
    await expect(revoked.call()).rejects.toThrow('disabled')
    const stopped = setup(); stopped.controller.abort(); await expect(stopped.call()).rejects.toThrow()
    const foreign = setup(); foreign.assertInvocation.mockImplementation(() => { throw new Error('not live') }); await expect(foreign.call()).rejects.toThrow('not live')
  })
})
