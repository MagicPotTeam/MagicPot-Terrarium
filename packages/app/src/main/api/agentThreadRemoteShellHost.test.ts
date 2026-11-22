import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { ThreadScriptInvocation } from './agentThreadScriptTools'
import type { AssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
const backend = vi.hoisted(() => ({ execute: vi.fn(async () => ({ output: 'fixture', exitCode: 0 })), close: vi.fn(async () => {}) }))
vi.mock('./sshBashBackend', () => ({ createSshBashBackend: vi.fn(() => backend) }))
vi.mock('./dockerBashBackend', () => ({ createDockerBashBackend: vi.fn(() => backend) }))
import { executeApprovedDockerShell, closeAgentDockerSessions } from './agentThreadRemoteShellHost'
afterEach(async () => { await closeAgentDockerSessions(); vi.clearAllMocks() })
describe('Docker exact formal approval host', () => {
  function fixture() {
    const config = structuredClone(DEFAULT_CONFIG)
    config.project_trace_config.enable_agent_shell = true
    config.project_trace_config.agent_shell_backend = 'docker'
    config.project_trace_config.agent_docker_config = { image: 'synthetic', network_mode: 'none' }
    const requestTerminalApproval = vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({ authorizationId: 'fixture-auth' }))
    const authorization = { authorize: vi.fn(() => ({ status: 'authorized', permit: { constraints: {} } })), consumeExecutionPermit: vi.fn() }
    const runtime = { requestTerminalApproval, authorization } as unknown as AssistantTerminalPolicyRuntime
    const call = { route: { channel: 'test', scopeType: 'project', scopeId: 'fixture' }, conversationId: 'fixture', input: { code: 'echo fixture' }, signal: new AbortController().signal, assertLive: vi.fn() } as unknown as ThreadScriptInvocation
    return { config, runtime, call, authorization, requestTerminalApproval }
  }
  it('consumes single use permission before dispatch and includes remote semantics/config in approval', async () => {
    const f = fixture()
    await executeApprovedDockerShell(f.call, () => f.config, f.runtime, process.cwd(), { timeoutMs: 30000, maxOutputBytes: 1024 })
    expect(f.authorization.consumeExecutionPermit).toHaveBeenCalledOnce()
    expect(f.authorization.consumeExecutionPermit.mock.invocationCallOrder[0]).toBeLessThan(backend.execute.mock.invocationCallOrder[0])
    expect(f.requestTerminalApproval.mock.calls[0][0]).toMatchObject({ input: { backend: 'docker', remoteMayContinueOnTimeout: true, maxOutputBytes: 1024 } })
  })
  it('binds SSH configuration without leaking password and consumes before connecting', async () => {
    const f = fixture()
    f.config.project_trace_config.agent_shell_backend = 'ssh'
    f.config.project_trace_config.agent_ssh_config = {host:'fixture.invalid',user:'synthetic',password:'not-for-audit'}
    await executeApprovedDockerShell(f.call,()=>f.config,f.runtime,process.cwd(),{timeoutMs:1000,maxOutputBytes:1024})
    const request = f.requestTerminalApproval.mock.calls[0][0]
    expect(JSON.stringify(request)).not.toContain('not-for-audit')
    expect(request).toMatchObject({input:{backend:'ssh',cwd:'remote-login-default (local workspace is not transferred)',configuration:{host:'fixture.invalid',known_hosts_policy:'auto_add'}}})
    expect(f.authorization.consumeExecutionPermit.mock.invocationCallOrder[0]).toBeLessThan(backend.execute.mock.invocationCallOrder[0])
  })
  it('does not dispatch when permission consumption fails', async () => {
    const f = fixture()
    f.authorization.consumeExecutionPermit.mockImplementation(() => { throw new Error('permission consumed') })
    await expect(executeApprovedDockerShell(f.call, () => f.config, f.runtime, process.cwd(), { timeoutMs: 30000, maxOutputBytes: 1024 })).rejects.toThrow('permission consumed')
    expect(backend.execute).not.toHaveBeenCalled()
  })
})
