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
import { evaluatePolicy, createFilesToolPolicyRequest, createTerminalPolicyRequest, type PolicyRequest } from '../../shared/magicAgentPlatform2'
import { FilesToolHost } from './toolHost/files'
import {
  PRODUCTION_THREAD_SHELL_POLICY_RULE,
  PRODUCTION_FILE_WRITE_POLICY_RULE,
  PRODUCTION_PYTHON_NOTEBOOK_POLICY_RULES
} from './productionRuntime'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it('matches the complete shell effect set and grants actual CPU/memory limits instead of unbounded fallback approval', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'magic-shell-policy-')); roots.push(root)
    const runtime = getAssistantTerminalPolicyRuntime()
    const base = createTerminalPolicyRequest({ requestId: randomUUID(), actor: { kind: 'agent', id: 'thread' }, target: { kind: 'tool', id: 'shell.execute' }, command: process.execPath, args: [], cwd: root })
    const input: PolicyRequest = { ...base, action: 'shell.execute', effects: [...base.effects, { kind: 'filesystem.write', target: root, risk: 'high' }] }
    const decision = evaluatePolicy(input, [PRODUCTION_THREAD_SHELL_POLICY_RULE], { evaluatedAt: Date.now(), policyVersion: 'test' })
    expect(decision).toMatchObject({ effect: 'require-approval', matchedRuleIds: [PRODUCTION_THREAD_SHELL_POLICY_RULE.ruleId], constraints: { metadata: { maxMemoryBytes: 536870912, maxCpuTimeMs: 60000 } } })
    const grant = runtime.createTrustedApproval(input)
    const result = runtime.authorization.authorize({ authorizationId: randomUUID(), request: input, evaluatedAt: Date.now(), ...grant, idempotencyKey: randomUUID() })
    expect(result).toMatchObject({ status: 'authorized', permit: { constraints: { allowedToolNames: ['shell.execute'], maxTimeoutMs: 120000, maxOutputChars: 262144, metadata: { maxMemoryBytes: 536870912, maxCpuTimeMs: 60000 } } } })
  })
  it('executes bounded grep/diff/snapshot queries under the real production read policy', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'magic-thread-files-'))
    roots.push(root)
    writeFileSync(path.join(root, 'notes.txt'), 'hello workspace\n')
    const runtime = getAssistantTerminalPolicyRuntime()
    const host = await FilesToolHost.create(runtime.authorization, { allowedRoots: [root] })
    const call = (tool: string, action: Parameters<typeof createFilesToolPolicyRequest>[0]['action'], input: Record<string, unknown>) => ({
      authorizationId: randomUUID(), idempotencyKey: randomUUID(), input,
      request: createFilesToolPolicyRequest({ requestId: randomUUID(), origin: 'assistant', actor: { kind: 'system', id: 'files-tool-host' }, target: { kind: 'tool', id: tool }, action, toolInput: { path: String(input.path || '.') }, filesystem: { paths: [String(input.path || '.')], allowedRoots: [root] } })
    })
    const grep = await host.grep(call('files.grep', 'filesystem.search', { path: '.', query: 'hello' }) as Parameters<FilesToolHost['grep']>[0])
    expect(grep.matches).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'notes.txt' })]))
    const diff = await host.diff(call('files.diff', 'filesystem.read', { path: 'notes.txt', text: 'new\n' }) as Parameters<FilesToolHost['diff']>[0])
    expect(diff.diff).toContain('hello workspace')
    const snapshots = await host.snapshotList(call('files.snapshot.list', 'filesystem.list', { path: '.' }) as Parameters<FilesToolHost['snapshotList']>[0])
    expect(snapshots.snapshots).toEqual([])
    await expect(host.grep(call('files.grep', 'filesystem.search', { path: '../', query: 'hello' }) as Parameters<FilesToolHost['grep']>[0])).rejects.toThrow('traversal')
    const write = call('files.write', 'filesystem.write', { path: 'notes.txt' })
    const result = runtime.authorization.authorize({ authorizationId: write.authorizationId, idempotencyKey: write.idempotencyKey, request: write.request, evaluatedAt: Date.now() })
    expect(result.status).not.toBe('authorized')
  })
  it('memory-file writes require their independent exact one-shot policy, not generic file or scratchpad grants', async () => {
    const { createAssistantToolPolicyRequest } = await import('../../shared/magicAgentPlatform2')
    const runtime = getAssistantTerminalPolicyRuntime(), input = {
      ...createAssistantToolPolicyRequest({ requestId: randomUUID(), actor: { kind: 'agent' as const, id: 'memory-test' }, target: { kind: 'tool' as const, id: 'memory_write' }, route: { channel: 'canvas', scopeType: 'thread' as const, scopeId: 'project', threadId: 'pane' }, sessionId: 'conversation', toolInput: { content: 'FULL_EXACT_MEMORY', path: './memory/facts.md', preimage: null, create: true, namespace: 'fixture-memory', namespaceCreation: true, namespaceGeneration: 'fixture-generation', routeIdentity: ['canvas', 'thread', 'project', 'pane'], workspaceId: 'workspace', bindingRevision: null, operationId: 'main-operation' } }),
      action: 'memory.file.write'
    }
    expect(runtime.authorization.authorize({ authorizationId: randomUUID(), request: input, evaluatedAt: Date.now(), idempotencyKey: randomUUID() }).status).toBe('awaiting-approval')
    const reference = runtime.createTrustedApproval(input), authorizationId = randomUUID()
    const result = runtime.authorization.authorize({ authorizationId, request: input, evaluatedAt: Date.now(), ...reference, idempotencyKey: randomUUID() })
    expect(result.status).toBe('authorized')
    if (result.status !== 'authorized') throw new Error('Expected approved memory permit')
    expect(result.permit.constraints?.allowedToolNames).toEqual(['memory_write'])
    for (const [field, replacement] of [['content', 'CHANGED_CONTENT'], ['namespace', 'other-root'], ['preimage', 'a'.repeat(64)], ['workspaceId', 'other-workspace'], ['bindingRevision', 'other-revision'], ['operationId', 'other-operation']] as const) {
      const changed = { ...input, input: { ...input.input, [field]: replacement } }
      expect(() => runtime.authorization.consumeExecutionPermit({ permit: result.permit, request: changed, consumedAt: Date.now(), idempotencyKey: randomUUID() })).toThrow()
    }
    runtime.authorization.consumeExecutionPermit({ permit: result.permit, request: input, consumedAt: Date.now(), idempotencyKey: randomUUID() })
    expect(() => runtime.authorization.consumeExecutionPermit({ permit: result.permit, request: input, consumedAt: Date.now(), idempotencyKey: randomUUID() })).toThrow()
    for (const target of ['files.write', 'scratchpad', 'memory.files.write']) {
      expect(runtime.authorization.authorize({ authorizationId: randomUUID(), request: { ...input, requestId: randomUUID(), target: { kind: 'tool', id: target } }, evaluatedAt: Date.now(), idempotencyKey: randomUUID() }).status).not.toBe('authorized')
    }
  })
  it('requires a real one-shot policy approval for scratchpad writes and refuses other tool targets', async () => {
    const { createAssistantToolPolicyRequest } = await import('../../shared/magicAgentPlatform2')
    const runtime = getAssistantTerminalPolicyRuntime()
    const input = {
      ...createAssistantToolPolicyRequest({ requestId: randomUUID(), actor: { kind: 'agent' as const, id: 'notes-test' }, target: { kind: 'tool' as const, id: 'scratchpad' }, route: { channel: 'canvas', scopeType: 'thread' as const, scopeId: 'project', threadId: 'pane' }, sessionId: 'conversation', toolInput: { action: 'set', key: 'theme', value: 'Blue', expectedRevision: 0 } }),
      action: 'memory.note.write'
    }
    expect(runtime.authorization.authorize({ authorizationId: randomUUID(), request: input, evaluatedAt: Date.now(), idempotencyKey: randomUUID() }).status).toBe('awaiting-approval')
    const grant = runtime.createTrustedApproval(input)
    const result = runtime.authorization.authorize({ authorizationId: randomUUID(), request: input, evaluatedAt: Date.now(), ...grant, idempotencyKey: randomUUID() })
    expect(result.status).toBe('authorized')
    const wrong = { ...input, requestId: randomUUID(), target: { kind: 'tool' as const, id: 'files.write' } }
    expect(runtime.authorization.authorize({ authorizationId: randomUUID(), request: wrong, evaluatedAt: Date.now(), idempotencyKey: randomUUID() }).status).not.toBe('authorized')
  })
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
