import { sshBashConfigSchema } from '@shared/sshBashConfig'
import { createSshBashBackend } from './sshBashBackend'
import { connectSsh2Session } from './ssh2SessionConnector'
import { createHmac, randomBytes } from 'node:crypto'
import { dockerBashConfigSchema } from '@shared/dockerBashConfig'
import { randomUUID } from 'node:crypto'
import { assertPolicyRequest, createAssistantToolPolicyRequest } from '@shared/magicAgentPlatform2'
import type { Config } from '@shared/config/config'
import type { ThreadScriptInvocation } from './agentThreadScriptTools'
import type { AssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { createDockerBashBackend } from './dockerBashBackend'

const configurationKey = randomBytes(32)
const dockerOwners = new Map<string, { snapshot: string; backend: ReturnType<typeof createDockerBashBackend> | ReturnType<typeof createSshBashBackend> }>()
/** Only this MAIN host consumes permission. Timeout ends local wait, not remote execution. */
export async function executeApprovedDockerShell(call: ThreadScriptInvocation, config: () => Config, runtime: AssistantTerminalPolicyRuntime, cwd: string, limits: { timeoutMs: number; maxOutputBytes: number }) {
  const current = config().project_trace_config
  const backendKind = current.agent_shell_backend
  if (!current.enable_agent_shell || backendKind !== 'docker' && backendKind !== 'ssh') throw new Error('Remote execution disabled.')
  if (call.background) throw new Error('Docker background jobs are not supported; use synchronous local-wait semantics.')
  const settings = backendKind === 'ssh' ? sshBashConfigSchema.parse(current.agent_ssh_config ?? {}) : dockerBashConfigSchema.parse(current.agent_docker_config ?? {})
  const publicSettings = { ...settings } as Record<string, string | number | boolean | string[] | Record<string, string>>
  delete publicSettings.password
  const configurationDigest = createHmac('sha256', configurationKey).update(JSON.stringify(settings)).digest('hex')
  const configuredOutput = settings.max_result_size_chars ?? 200000
  if (!Number.isSafeInteger(configuredOutput) || configuredOutput < 1 || configuredOutput > 200000) throw new Error('Docker output configuration must be 1..200000 characters.')
  const effectiveOutputChars = Math.min(configuredOutput, limits.maxOutputBytes)
  const snapshot = JSON.stringify(backendKind === 'ssh' ? current.agent_ssh_config ?? {} : current.agent_docker_config ?? {}), key = JSON.stringify([backendKind, call.route, call.conversationId, cwd])
  const command = String(call.input.code ?? ''), timeout = limits.timeoutMs / 1000
  const shell = 'bash'
  const request = assertPolicyRequest({ ...createAssistantToolPolicyRequest({ requestId: randomUUID(), actor: { kind: 'agent', id: key }, target: { kind: 'tool', id: 'shell.execute' }, route: call.route, sessionId: call.conversationId,
    toolInput: { backend: backendKind, command, shell, cwd: backendKind === 'ssh' ? 'remote-login-default (local workspace is not transferred)' : cwd, timeout, configuration: publicSettings, configurationDigest, effectiveOutputChars, maxOutputBytes: limits.maxOutputBytes, localWaitingOnly: true, remoteMayContinueOnTimeout: true }
  }), action: 'shell.execute', metadata: { limitation: backendKind === 'ssh' ? 'SSH reuses a configured session; default auto_add accepts unknown host keys. Timeout/cancel ends local waiting only; remote commands may continue. Close ends the whole session.' : 'Docker lazy persistent container may create image-configured resources and host bind mounts. Timeout/cancel stops only local waiting, not remote execution. Close stops/removes the whole container. Not a sandbox certificate.' } })
  const check = () => {
    call.assertLive(); call.signal.throwIfAborted()
    const now = config()
    if (now.use_remote_llm || !now.project_trace_config.enable_agent_shell || now.project_trace_config.agent_shell_backend !== backendKind || JSON.stringify(backendKind === 'ssh' ? now.project_trace_config.agent_ssh_config ?? {} : now.project_trace_config.agent_docker_config ?? {}) !== snapshot) throw new Error('Docker configuration changed during approval.')
  }
  check()
  const reference = await runtime.requestTerminalApproval(request, call.signal)
  check()
  const authorized = runtime.authorization.authorize({ authorizationId: reference.authorizationId!, request, evaluatedAt: Date.now(), grantId: reference.grantId, expectedGrantUseCount: reference.expectedGrantUseCount, idempotencyKey: `docker-authorize:${reference.authorizationId}` })
  if (authorized.status !== 'authorized') throw new Error('Docker shell was not authorized.')
  const constraints = authorized.permit.constraints
  if (constraints && Object.keys(constraints).some(name => !['maxTimeoutMs', 'maxOutputChars'].includes(name))) throw new Error('Docker cannot fulfill local terminal permit constraints.')
  if (constraints?.maxTimeoutMs !== undefined && timeout * 1000 > constraints.maxTimeoutMs || constraints?.maxOutputChars !== undefined && effectiveOutputChars > constraints.maxOutputChars) throw new Error('Docker exceeds approved limits.')
  check()
  runtime.authorization.consumeExecutionPermit({ permit: authorized.permit, request, consumedAt: Date.now(), idempotencyKey: `docker-consume:${reference.authorizationId}` })
  let owner = dockerOwners.get(key)
  if (owner && owner.snapshot !== snapshot) { await owner.backend.close(); dockerOwners.delete(key); owner = undefined }
  check()
  if (!owner) { owner = { snapshot, backend: backendKind === 'ssh' ? createSshBashBackend(sshBashConfigSchema.parse(settings), connectSsh2Session) : createDockerBashBackend(settings) }; dockerOwners.set(key, owner) }
  const result = backendKind === 'ssh'
    ? await (owner.backend as ReturnType<typeof createSshBashBackend>).execute(command, shell, timeout, call.signal)
    : await (owner.backend as ReturnType<typeof createDockerBashBackend>).execute(command, cwd, shell, timeout, call.signal, effectiveOutputChars)
  if ('output' in result && typeof result.output === 'string') {
    const chars = Array.from(result.output)
    if (chars.length > effectiveOutputChars) result.output = chars.slice(0, effectiveOutputChars).join('')
  }
  if ('output' in result && typeof result.output === 'string' && Buffer.byteLength(result.output) > limits.maxOutputBytes) {
    let output = result.output
    while (Buffer.byteLength(output) > limits.maxOutputBytes) output = output.slice(0, Math.max(0, output.length - Math.ceil((Buffer.byteLength(output) - limits.maxOutputBytes) / 4)))
    result.output = output
  }
  call.assertLive()
  return { ...result, backend: backendKind, untrustedData: true, filesystemNetworkSandbox: false, authorizationId: reference.authorizationId }
}
export async function closeAgentDockerSessions() {
  const owners = [...dockerOwners.values()]; dockerOwners.clear()
  await Promise.allSettled(owners.map(owner => owner.backend.close()))
}
