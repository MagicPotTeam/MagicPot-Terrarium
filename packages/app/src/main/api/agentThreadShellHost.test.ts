import { spawn, type ChildProcess } from 'node:child_process'
import { createWindowsJobObjectConfinementAdapter } from '../magicAgentPlatform2/toolHost/windowsJobObjectConfinement'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: process.cwd() } }) }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import { closeAssistantTerminalPolicyRuntime, getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import type { CommandJobsConfinementAdapter } from '../magicAgentPlatform2/toolHost'
import { executeAgentThreadShell, inspectThreadShellExecutable } from './agentThreadShellHost'
import { executeAgentThreadScript } from './agentThreadScriptHost'
const roots: string[] = []
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'proj', threadId: 'pane' } as const
const realShell = process.env.MAGICPOT_TEST_SHELL
const kind = process.env.MAGICPOT_TEST_SHELL_KIND === 'bash' ? 'bash' : 'powershell'
const setup = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'thread-shell-')); roots.push(root)
  const runtime = getAssistantTerminalPolicyRuntime(), config = structuredClone(DEFAULT_CONFIG), controller = new AbortController()
  config.project_trace_config = { ...config.project_trace_config, enable_agent_shell: true, agent_shell_executable: realShell ?? path.join(root, 'powershell.exe'), agent_shell_kind: kind }
  const call = { name: 'shell.execute', route, conversationId: 'chat', namespace: 'c'.repeat(64), workspaceRoot: root, signal: controller.signal, assertLive: () => controller.signal.throwIfAborted() }
  const invoke = (input: Record<string, unknown>) => executeAgentThreadShell({ ...call, input }, { runtime, config: () => config })
  return { root, runtime, config, controller, call, invoke }
}
const approve = (t: ReturnType<typeof setup>) => vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementation(async (request) => ({ authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) }))
afterEach(() => { vi.restoreAllMocks(); closeAssistantTerminalPolicyRuntime(); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })) })
describe('thread general shell production host', () => {
  it('rejects relative/unexpected executables and inspects provenance without running a probe', () => {
    const t = setup(), file = path.join(t.root, 'bash.exe'); writeFileSync(file, 'do not execute')
    expect(inspectThreadShellExecutable(file, 'bash')).toMatchObject({ sha256: createHash('sha256').update('do not execute').digest('hex'), kind: 'bash' })
    expect(() => inspectThreadShellExecutable('bash', 'bash')).toThrow('absolute')
    expect(() => inspectThreadShellExecutable(file, 'powershell')).toThrow('matching')
  })
  it('fails closed on resource confinement before approval or user script creation', async () => {
    const t = setup(), approval = vi.spyOn(t.runtime, 'requestTerminalApproval')
    const none: CommandJobsConfinementAdapter = { platform: 'unsupported', capabilities: { memory: false, cpu: false, processCount: false, networkDeny: false, networkHosts: false }, prepare: () => { throw new Error('never') } }
    await expect(executeAgentThreadShell({ ...t.call, input: { code: 'echo no' } }, { runtime: t.runtime, config: () => t.config, confinement: none })).rejects.toThrow('unsupported')
    expect(approval).not.toHaveBeenCalled()
    expect(existsSync(path.join(t.root, '.magicpot/shell'))).toBe(false)
  })
  it.skipIf(!realShell)('runs real reviewed shell through production OS confinement with exact policy and bounded results', async () => {
    const t = setup(); mkdirSync(path.join(t.root, 'sub'))
    const code = kind === 'bash' ? 'printf "SHELL_RESULT_42\\n"; printf "made" > made.txt' : '[Console]::WriteLine("SHELL_RESULT_42"); [IO.File]::WriteAllText((Join-Path (Get-Location) "made.txt"), "made")'
    const approval = vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementation(async (request) => {
      expect(request).toMatchObject({ action: 'shell.execute', target: { id: 'shell.execute' }, route, sessionId: 'chat', input: { code, explicitShell: true, filesystemNetworkSandbox: false, executableSha256: expect.stringMatching(/^[0-9a-f]{64}$/), codeSha256: createHash('sha256').update(code).digest('hex') } })
      if (kind === 'powershell') expect(Buffer.from((request.input.args as string[]).at(-1)!, 'base64').toString('utf16le')).toBe(code)
      expect(existsSync(path.join(t.root, 'sub/made.txt'))).toBe(false)
      return { authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) }
    })
    const result = await t.invoke({ code, cwd: 'sub', timeoutMs: 10000 })
    expect(result).toMatchObject({ state: 'completed', outcome: 'known', exitCode: 0, stdout: expect.stringContaining('SHELL_RESULT_42'), businessTaskVerified: false })
    expect(readFileSync(path.join(t.root, 'sub/made.txt'), 'utf8')).toBe('made')
    expect(approval).toHaveBeenCalledOnce()
  }, 30000)
  it.skipIf(!realShell)('does not dispatch a real shell until formal desktop approval is resolved', async () => {
    const t = setup(), pending = t.invoke({ code: kind === 'bash' ? 'echo approved' : '[Console]::WriteLine("approved")' }).catch((e) => e)
    await vi.waitFor(() => expect(t.runtime.listPendingTerminalApprovals()).toHaveLength(1))
    const approval = t.runtime.listPendingTerminalApprovals()[0]
    expect(approval.request.request.input).toHaveProperty('code')
    t.runtime.resolvePendingTerminalApproval({ approvalId: approval.approvalId, expectedRevision: approval.revision, approved: true })
    expect(await pending).toMatchObject({ state: 'completed', stdout: expect.stringContaining('approved') })
  }, 30000)
  it.skipIf(!realShell)('reports failure, timeout and output-limit from actual process outcomes', async () => {
    const t = setup(); approve(t)
    expect(await t.invoke({ code: 'exit 7' })).toMatchObject({ state: 'failed', exitCode: 7, outcome: 'known' })
    expect(await t.invoke({ code: kind === 'bash' ? 'sleep 30' : 'Start-Sleep -Seconds 30', timeoutMs: 200 })).toMatchObject({ state: 'timed-out', outcome: 'known' })
    const output = kind === 'bash' ? 'printf "%20000s" "x"' : '[Console]::WriteLine(("x" * 20000))'
    expect(await t.invoke({ code: output, maxOutputBytes: 512 })).toMatchObject({ state: 'failed', truncated: true })
  }, 30000)
  it.skipIf(!realShell)('stops immediately after the real OS spawn event and preserves confirmed closure', async () => {
    const t = setup(); approve(t)
    const code = kind === 'bash' ? 'sleep 8; printf "BAD"' : 'Start-Sleep -Seconds 8; [Console]::WriteLine("BAD")'
    let control: import('./agentThreadProcessHost').ThreadProcessControl | undefined, child: ChildProcess | undefined
    const events: string[] = []
    const confinement = process.platform === 'win32' ? createWindowsJobObjectConfinementAdapter('win32', undefined, ((command, args, options) => {
      child = spawn(command, args, options)
      for (const event of ['spawn', 'exit', 'close', 'error']) child.on(event, () => events.push(`child:${event}`))
      for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) for (const event of ['end', 'close', 'error']) stream?.on(event, () => events.push(`${name}:${event}`))
      return child
    }) as typeof spawn) : undefined
    const pending = executeAgentThreadShell({ ...t.call, input: { code }, onOwned: (owned) => { control = owned }, onStarted: () => { queueMicrotask(() => t.controller.abort(new Error('parent finished truncated'))) } }, { runtime: t.runtime, config: () => t.config, confinement }).catch((error) => error)
    expect(await pending).toBeInstanceOf(Error)
    expect(control).toBeDefined()
    const streams = [child?.stdout, child?.stderr].map((s) => ({ flowing: s?.readableFlowing, ended: s?.readableEnded, destroyed: s?.destroyed, closed: s?.closed, buffered: s?.readableLength }))
    if (process.platform === 'win32') {
      expect(child).toBeDefined()
      expect(child!.spawnfile).toMatch(/magicpot-command-job\.exe$/i)
      expect(events).toContain('child:close')
    }
    expect(control!.status(), JSON.stringify({ job: control!.status(), events, streams })).toMatchObject({ state: 'stopped', outcome: 'known' })
  }, 15000)
  it.skipIf(!realShell)('waits for actual cancellation and shares its operation lock with Python in the same conversation', async () => {
    const t = setup(); approve(t)
    const code = kind === 'bash' ? 'sleep 2; printf "bad" > late.txt' : 'Start-Sleep -Seconds 2; [IO.File]::WriteAllText((Join-Path (Get-Location) "late.txt"), "bad")'
    const pending = t.invoke({ code }).catch((e) => e)
    await new Promise((resolve) => setTimeout(resolve, 300))
    t.config.project_trace_config.enable_agent_python_notebook = true
    await expect(executeAgentThreadScript({ ...t.call, name: 'python.execute', input: { code: 'pass' } }, { runtime: t.runtime, config: () => t.config })).rejects.toThrow('active')
    t.controller.abort(new Error('owner navigated'))
    expect(await pending).toBeInstanceOf(Error)
    await new Promise((resolve) => setTimeout(resolve, 2100))
    expect(existsSync(path.join(t.root, 'late.txt'))).toBe(false)
  }, 30000)
  it.skipIf(!realShell).each(['deny', 'disable', 'cancel', 'config'])('refuses %s changed during approval without executing code', async (mode) => {
    const t = setup()
    vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementationOnce(async (request) => {
      if (mode === 'deny') throw new Error('denied')
      const ref = { authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) }
      if (mode === 'disable') t.config.project_trace_config.enable_agent_shell = false
      else if (mode === 'cancel') t.controller.abort()
      else t.config.project_trace_config.agent_shell_executable = path.join(t.root, 'other.exe')
      return ref
    })
    await expect(t.invoke({ code: 'echo no' })).rejects.toThrow()
  })
  it('rejects executable bytes changed during approval before any spawn', async () => {
    const t = setup(), executable = path.join(t.root, 'bash.exe')
    writeFileSync(executable, 'original fake executable')
    t.config.project_trace_config.agent_shell_executable = executable; t.config.project_trace_config.agent_shell_kind = 'bash'
    const spawn = vi.fn(() => { throw new Error('must not spawn') })
    const adapter: CommandJobsConfinementAdapter = { platform: 'test', capabilities: { memory: true, cpu: true, processCount: false, networkDeny: false, networkHosts: false }, prepare: () => spawn as never }
    vi.spyOn(t.runtime, 'requestTerminalApproval').mockImplementationOnce(async (request) => {
      const ref = { authorizationId: randomUUID(), ...t.runtime.createTrustedApproval(request) }
      writeFileSync(executable, 'changed fake executable'); return ref
    })
    await expect(executeAgentThreadShell({ ...t.call, input: { code: 'echo safe' } }, { runtime: t.runtime, config: () => t.config, confinement: adapter })).rejects.toThrow('identity changed')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('rejects traversal before permission and does not allow Python opt-in to authorize shell', async () => {
    const t = setup(); t.config.project_trace_config.enable_agent_shell = false; t.config.project_trace_config.enable_agent_python_notebook = true
    await expect(t.invoke({ code: 'echo no' })).rejects.toThrow('disabled')
    await expect(t.invoke({ code: 'echo no', cwd: '../escape' })).rejects.toThrow('relative')
  })
})
