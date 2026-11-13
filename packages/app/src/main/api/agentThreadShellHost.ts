import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { assertPolicyRequest, createTerminalPolicyRequest } from '@shared/magicAgentPlatform2'
import type { Config } from '@shared/config/config'
import type { AssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import type { CommandJobsConfinementAdapter } from '../magicAgentPlatform2/toolHost'
import { isInsideTerminalRoot } from '../magicAgentPlatform2/toolHost/terminalRun'
import { acquireThreadProcessOperation, assertThreadProcessAvailable, getThreadProcessHost, threadProcessControl } from './agentThreadProcessHost'
import type { ThreadScriptInvocation } from './agentThreadScriptTools'

const TERMINAL = new Set(['completed', 'failed', 'timed-out', 'stopped', 'stopped-interrupted'])
export function inspectThreadShellExecutable(configured: string, kind: string) {
  if (!configured || !path.isAbsolute(configured) || configured.includes('\0')) throw new Error('Configure an absolute trusted shell executable, not a command line or PATH alias.')
  const executable = path.resolve(realpathSync.native(configured)), leaf = lstatSync(configured)
  if (leaf.isSymbolicLink() || !leaf.isFile() || !['bash', 'powershell'].includes(kind) || !(/^(?:bash)(?:\.exe)?$/i.test(path.basename(executable)) && kind === 'bash' || /^(?:powershell|pwsh)(?:\.exe)?$/i.test(path.basename(executable)) && kind === 'powershell')) throw new Error('Configured shell must be a regular Bash or PowerShell executable matching the selected kind.')
  if (leaf.size < 1 || leaf.size > 128 * 1024 * 1024) throw new Error('Shell executable exceeds provenance size limit.')
  const fd = openSync(executable, 'r')
  try {
    const before = fstatSync(fd), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
    if (!before.isFile() || before.dev !== leaf.dev || before.ino !== leaf.ino || before.size !== leaf.size) throw new Error('Shell executable changed while opening.')
    let position = 0
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, position)
      if (!count) break
      position += count
      if (position > 128 * 1024 * 1024) throw new Error('Shell executable grew beyond provenance limit.')
      hash.update(buffer.subarray(0, count))
    }
    const after = fstatSync(fd), current = lstatSync(configured)
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size || current.dev !== after.dev || current.ino !== after.ino || current.isSymbolicLink() || path.resolve(realpathSync.native(configured)) !== executable) throw new Error('Shell executable changed during provenance check.')
    return { executable, sha256: hash.digest('hex'), kind }
  } finally { closeSync(fd) }
}
export async function executeAgentThreadShell(call: ThreadScriptInvocation, dependencies: { config?: () => Config; runtime?: AssistantTerminalPolicyRuntime; confinement?: CommandJobsConfinementAdapter } = {}): Promise<unknown> {
  call.assertLive()
  if (call.name !== 'shell.execute') throw new Error('Unsupported shell tool.')
  const input = structuredClone(call.input), code = input.code
  if (typeof code !== 'string' || !code.trim() || code.includes('\0') || Buffer.byteLength(code) > 6000) throw new Error('Shell code exceeds the 6000-byte limit.')
  const timeoutMs = Number(input.timeoutMs ?? 30000), maxOutputBytes = Number(input.maxOutputBytes ?? 65536)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 512 || maxOutputBytes > 262144) throw new Error('Invalid shell execution limits.')
  const root = path.resolve(realpathSync.native(call.workspaceRoot))
  const relative = typeof input.cwd === 'string' ? input.cwd : '.'
  if (path.isAbsolute(relative) || relative.includes('\0') || relative.split(/[\\/]/).includes('..')) throw new Error('Shell cwd must be workspace-relative.')
  const cwd = path.resolve(realpathSync.native(path.resolve(root, relative)))
  if (!isInsideTerminalRoot(root, cwd) || !lstatSync(cwd).isDirectory()) throw new Error('Shell cwd escapes the workspace.')
  const cwdIdentity = lstatSync(cwd)
  const runtime = dependencies.runtime ?? (await import('../magicAgentPlatform2/productionRuntime')).getAssistantTerminalPolicyRuntime()
  const config = dependencies.config ?? (await import('../config/config')).getConfig
  const selectedBackend = config().project_trace_config.agent_shell_backend ?? 'local'
  if (selectedBackend === 'docker' || selectedBackend === 'ssh') return (await import('./agentThreadRemoteShellHost')).executeApprovedDockerShell(call, config, runtime, cwd, { timeoutMs, maxOutputBytes })
  const settings = (checkAvailability = true) => {
    call.assertLive(); call.signal.throwIfAborted()
    const current = config()
    if (current.use_remote_llm || current.project_trace_config.enable_agent_shell !== true) throw new Error('General shell execution is disabled.')
    if (checkAvailability) assertThreadProcessAvailable(runtime, root)
    return { executable: current.project_trace_config.agent_shell_executable?.trim() ?? '', kind: current.project_trace_config.agent_shell_kind ?? '' }
  }
  const initial = settings(), release = acquireThreadProcessOperation(root, call.namespace)
  try {
    const manager = getThreadProcessHost(runtime, root, dependencies.confinement)
    const provenance = inspectThreadShellExecutable(initial.executable, initial.kind)
    // No login/interactive profile; no caller argv/environment. PowerShell code
    // is base64 transported to avoid shell quoting ambiguities, not to hide review.
    const args = initial.kind === 'bash' ? ['--noprofile', '--norc', '-c', code] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')]
    const identity = { routeKey: JSON.stringify(call.route), sessionId: call.conversationId }
    const base = createTerminalPolicyRequest({ requestId: randomUUID(), actor: { kind: 'agent', id: identity.routeKey }, target: { kind: 'tool', id: 'shell.execute' }, route: { ...call.route }, sessionId: call.conversationId, command: provenance.executable, args, cwd, filesystem: { cwd, allowedRoots: [root] } })
    const request = assertPolicyRequest({ ...base, action: 'shell.execute', input: { ...base.input, ...(call.background ? { background: true, survivesSuccessfulParentOnly: true } : {}), explicitShell: true, shellKind: initial.kind, executableSha256: provenance.sha256, code, codeSha256: createHash('sha256').update(code).digest('hex'), cwd, timeoutMs, maxOutputBytes, filesystemNetworkSandbox: false }, effects: [...base.effects, { kind: 'filesystem.write', target: root, risk: 'high' }], metadata: { limitation: 'General host shell execution, not a filesystem/network sandbox. OS limits and child termination are platform-dependent. Approval is not a rollback guarantee.' } })
    const check = (checkAvailability = true) => {
      const current = settings(checkAvailability)
      if (current.executable !== initial.executable || current.kind !== initial.kind) throw new Error('Shell configuration changed while awaiting approval.')
      const currentCwd = lstatSync(cwd)
      if (currentCwd.dev !== cwdIdentity.dev || currentCwd.ino !== cwdIdentity.ino || !currentCwd.isDirectory() || currentCwd.isSymbolicLink() || path.resolve(realpathSync.native(path.resolve(root, relative))) !== cwd) throw new Error('Shell cwd changed while awaiting approval.')
    }
    const reference = await runtime.requestTerminalApproval(request, call.signal)
    check()
    const started = await manager.background({ ...identity, ...reference, authorizationId: reference.authorizationId!, idempotencyKey: randomUUID(), request, command: provenance.executable, args, cwd, env: {}, shell: false, signal: call.signal, timeoutMs, maxLogBytes: maxOutputBytes,
      onOwned: call.onOwned ? (job) => call.onOwned!(threadProcessControl(manager, job)) : undefined,
      onStarted: call.onStarted ? (job) => call.onStarted!(threadProcessControl(manager, job)) : undefined,
      beforeDispatch: () => { check(); const current = inspectThreadShellExecutable(initial.executable, initial.kind); if (current.executable !== provenance.executable || current.sha256 !== provenance.sha256) throw new Error('Approved shell executable identity changed before dispatch.') }
    })
    const scope = { ...identity, jobId: started.jobId }
    let job = started
    try {
      while (!TERMINAL.has(job.state)) {
        check(false)
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
        job = manager.status(scope)
      }
      check(false)
    } catch (error) { await manager.stop(scope); throw error }
    const stdout = manager.read({ ...scope, stream: 'stdout', maxBytes: maxOutputBytes }), stderr = manager.read({ ...scope, stream: 'stderr', maxBytes: maxOutputBytes })
    return { state: job.state, outcome: job.outcome, exitCode: job.exitCode ?? null, stopOutcome: job.stopOutcome, stdout: stdout.data, stderr: stderr.data, truncated: job.logsTruncated || stdout.truncated || stderr.truncated, executable: provenance.executable, shellKind: initial.kind, codeSha256: request.input.codeSha256, businessTaskVerified: false, filesystemNetworkSandbox: false, untrustedData: true }
  } finally { release() }
}
