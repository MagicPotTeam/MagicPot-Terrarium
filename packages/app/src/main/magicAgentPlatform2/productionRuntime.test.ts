import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')

vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => ({ pathMap: { data: process.cwd() } })
}))
import {
  closeAssistantTerminalPolicyRuntime,
  getAssistantTerminalPolicyRuntime
} from './productionRuntime'
import { CommandJobsToolHost, type CommandJobsConfinementAdapter } from './toolHost/commandJobs'
import { evaluatePolicy, type PolicyRequest } from '../../shared/magicAgentPlatform2'
import {
  PRODUCTION_FILE_WRITE_POLICY_RULE,
  PRODUCTION_PYTHON_NOTEBOOK_POLICY_RULES
} from './productionRuntime'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const roots: string[] = []

afterEach(() => {
  closeAssistantTerminalPolicyRuntime()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const request = (
  action: 'python.execute' | 'notebook.execute' | 'notebook.write',
  target: string,
  root: string,
  inputTarget = target
): PolicyRequest => ({
  discriminator: 'magic-agent.policy-request.v1',
  version: 1,
  requestId: randomUUID(),
  actor: {
    kind: action === 'notebook.write' ? 'system' : 'agent',
    id: action === 'notebook.write' ? 'notebook-tool-host' : 'test-agent'
  },
  origin: 'assistant',
  action,
  target: { kind: 'tool', id: target },
  input: {
    command: process.execPath,
    args: [],
    interpreterSha256: 'a'.repeat(64),
    codeSha256: 'b'.repeat(64),
    expectedSha256: 'c'.repeat(64),
    expectedGeneration: 0,
    tool: inputTarget
  },
  effects:
    action === 'notebook.write'
      ? [{ kind: 'filesystem.write', target: root, risk: 'high' }]
      : [
          { kind: 'process.execute', target: process.execPath, risk: 'high' },
          { kind: 'filesystem.read', target: root, risk: 'high' },
          ...(action === 'notebook.execute'
            ? [{ kind: 'filesystem.write' as const, target: root, risk: 'high' as const }]
            : [])
        ],
  sessionId: 'session',
  filesystem: { cwd: root, allowedRoots: [root] }
})

describe('production Python and Notebook policy', () => {
  it.each([
    ['python.execute', 'python.run'],
    ['notebook.execute', 'notebook.execute-all']
  ] as const)('authorizes %s with mandatory resource constraints', (action, target) => {
    const root = mkdtempSync(path.join(tmpdir(), 'magic-production-policy-'))
    roots.push(root)
    const runtime = getAssistantTerminalPolicyRuntime()
    const policyRequest = request(action, target, root)
    expect(
      evaluatePolicy(
        policyRequest,
        [...PRODUCTION_PYTHON_NOTEBOOK_POLICY_RULES, PRODUCTION_FILE_WRITE_POLICY_RULE],
        {
          evaluatedAt: Date.now(),
          policyVersion: 'test'
        }
      )
    ).toMatchObject({ effect: 'require-approval' })
    const approval = runtime.createTrustedApproval(policyRequest)
    const result = runtime.authorization.authorize({
      authorizationId: randomUUID(),
      request: policyRequest,
      evaluatedAt: Date.now(),
      ...approval,
      idempotencyKey: randomUUID()
    })

    expect(result.status).toBe('authorized')
    if (result.status !== 'authorized') return
    expect(result.permit.constraints).toMatchObject({
      requireNoShell: true,
      allowedToolNames: expect.arrayContaining([target]),
      metadata: { maxMemoryBytes: 512 * 1024 * 1024, maxCpuTimeMs: 60_000 }
    })
  })

  it('requires one-shot approval for structural Notebook writes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'magic-production-policy-'))
    roots.push(root)
    const runtime = getAssistantTerminalPolicyRuntime()
    const policyRequest = request('notebook.write', 'notebook.write', root)
    expect(
      evaluatePolicy(
        policyRequest,
        [...PRODUCTION_PYTHON_NOTEBOOK_POLICY_RULES, PRODUCTION_FILE_WRITE_POLICY_RULE],
        {
          evaluatedAt: Date.now(),
          policyVersion: 'test'
        }
      )
    ).toMatchObject({
      effect: 'require-approval',
      constraints: {
        requireNoShell: true,
        allowedToolNames: ['notebook.write']
      }
    })
    const approval = runtime.createTrustedApproval(policyRequest)
    const result = runtime.authorization.authorize({
      authorizationId: randomUUID(),
      request: policyRequest,
      evaluatedAt: Date.now(),
      ...approval,
      idempotencyKey: randomUUID()
    })
    expect(result.status).toBe('authorized')
  })

  it('fails unsupported confinement before consuming the production permit', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'magic-production-policy-'))
    roots.push(root)
    const runtime = getAssistantTerminalPolicyRuntime()
    const policyRequest = request('python.execute', 'python.run', root)
    const approval = runtime.createTrustedApproval(policyRequest)
    const authorizationId = randomUUID()
    const unsupported: CommandJobsConfinementAdapter = {
      platform: 'unsupported-test-platform',
      capabilities: {
        memory: false,
        cpu: false,
        processCount: false,
        networkDeny: false,
        networkHosts: false
      },
      prepare: () => {
        throw new Error('must not prepare')
      }
    }
    const host = new CommandJobsToolHost(runtime.authorization, {
      workspaceRoot: root,
      confinementAdapter: unsupported
    })

    await expect(
      host.background({
        authorizationId,
        idempotencyKey: randomUUID(),
        request: policyRequest,
        routeKey: 'route',
        sessionId: 'session',
        command: process.execPath,
        args: [],
        cwd: root,
        ...approval
      })
    ).rejects.toThrow(/unsupported.*memory.*cpu/i)
    expect(
      runtime.eventStore.getResource<{ consumed: boolean }>('policy-audit', authorizationId)?.state
    ).toMatchObject({ consumed: false })
  })
})
