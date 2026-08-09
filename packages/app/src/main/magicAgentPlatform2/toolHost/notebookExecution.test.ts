import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import type { PolicyRequest, PolicyRule } from '../../../shared/magicAgentPlatform2'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import {
  NotebookExecutionCoordinator,
  type NotebookExecutionJobBoundary
} from './notebookExecution'

const roots: string[] = []
const stores: MagicAgentEventStore[] = []
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }))
})
const sha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex')
const provenance = {
  executable: 'python',
  sha256: 'a'.repeat(64),
  implementation: 'CPython',
  version: '3.test',
  platform: process.platform
}
const notebook = (source = ['x=2', 'x+3']) => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: source.map((s, i) => ({
    id: `c${i + 1}`,
    cell_type: 'code',
    metadata: {},
    source: [s],
    execution_count: null,
    outputs: []
  }))
})
function setup(result?: string) {
  const root = path.join(tmpdir(), `nb-exec-${process.pid}-${Math.random()}`)
  mkdirSync(root)
  roots.push(root)
  const file = path.join(root, 'a.ipynb')
  writeFileSync(file, JSON.stringify(notebook()))
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  const rules: PolicyRule[] = [
    {
      ruleId: 'all',
      priority: 1,
      effect: 'allow-with-constraints',
      explanation: 'test',
      constraints: { allowedRoots: [root] }
    }
  ]
  const auth = new MagicAgentPolicyAuthorizationService({
    store,
    rules,
    policyVersion: 'test',
    storeId: 'test',
    trustedApprovers: [{ kind: 'user', id: 'u' }]
  })
  let state: ReturnType<NotebookExecutionJobBoundary['status']> = {
    jobId: 'j1',
    routeKey: 'r',
    sessionId: 's',
    state: 'running',
    outcome: 'unknown',
    command: 'python',
    args: [],
    cwd: root,
    createdAt: 1,
    stdoutBytes: 0,
    stderrBytes: 0,
    logsTruncated: false
  }
  const boundary: NotebookExecutionJobBoundary = {
    async start(input) {
      await input.beforeSpawn?.()
      return state
    },
    status() {
      return state
    },
    read() {
      return {
        data:
          result ??
          JSON.stringify({
            protocol: 'magicpot-notebook-result.v1',
            status: 'completed',
            cells: [
              { cellId: 'c1', executionCount: 1, stdout: '', stderr: '', displays: [] },
              { cellId: 'c2', executionCount: 2, stdout: '', stderr: '', displays: [], result: '5' }
            ]
          }) + '\n'
      }
    },
    stop() {
      state = { ...state, state: 'stopped-interrupted', outcome: 'known' }
      return state
    }
  }
  return {
    root,
    file,
    auth,
    boundary,
    complete: () => {
      state = { ...state, state: 'completed', outcome: 'known' }
    }
  }
}
function approval(auth: MagicAgentPolicyAuthorizationService, request: PolicyRequest) {
  const now = Date.now(),
    grantId = `g-${Math.random()}`
  auth.createApprovalGrant({
    grantId,
    request,
    approvedBy: { kind: 'user', id: 'u' },
    issuedAt: now,
    expiresAt: now + 60000,
    maxUses: 1,
    idempotencyKey: grantId
  })
  return { grantId, expectedGrantUseCount: 0 }
}

function executeCall(
  t: ReturnType<typeof setup>,
  host: NotebookExecutionCoordinator,
  idempotencyKey = `execute-${Math.random()}`,
  expectedGeneration = 0
) {
  const expectedSha256 = sha(readFileSync(t.file))
  const request = host.createPolicyRequest({
    target: 'notebook.execute-all',
    routeKey: 'r',
    sessionId: 's',
    path: 'a.ipynb',
    expectedSha256,
    expectedGeneration
  })
  return host.executeAll({
    authorizationId: 'a',
    idempotencyKey,
    request,
    routeKey: 'r',
    sessionId: 's',
    path: 'a.ipynb',
    expectedSha256,
    expectedGeneration,
    ...approval(t.auth, request)
  })
}
function controlCall(
  t: ReturnType<typeof setup>,
  host: NotebookExecutionCoordinator,
  target: 'notebook.interrupt' | 'notebook.restart',
  idempotencyKey: string,
  executionId?: string
) {
  const request = host.createPolicyRequest({
    target,
    routeKey: 'r',
    sessionId: 's',
    path: 'a.ipynb'
  })
  return {
    request,
    input: {
      authorizationId: `control-${idempotencyKey}`,
      idempotencyKey,
      request,
      routeKey: 'r',
      sessionId: 's',
      path: 'a.ipynb',
      executionId,
      ...approval(t.auth, request)
    }
  }
}

describe('NotebookExecutionCoordinator', () => {
  it('durably replays active and no-op interrupt receipts', async () => {
    const t = setup()
    const stop = vi.spyOn(t.boundary, 'stop')
    const host = new NotebookExecutionCoordinator(t.auth, t.boundary, {
      workspaceRoot: t.root,
      provenance
    })
    const started = await executeCall(t, host)
    const active = controlCall(
      t,
      host,
      'notebook.interrupt',
      'interrupt-active',
      started.executionId
    )
    const receipt = await host.interrupt(active.input)
    expect(receipt.state).toBe('interrupted')
    expect((await host.interrupt(active.input)).executionId).toBe(receipt.executionId)
    expect(stop).toHaveBeenCalledTimes(1)
    const noop = controlCall(t, host, 'notebook.interrupt', 'interrupt-noop')
    const noopReceipt = await host.interrupt(noop.input)
    expect(noopReceipt.state).toBe('completed-not-applied')
    expect((await host.interrupt(noop.input)).executionId).toBe(noopReceipt.executionId)
    const recovered = new NotebookExecutionCoordinator(t.auth, t.boundary, {
      workspaceRoot: t.root,
      provenance
    })
    expect((await recovered.interrupt(noop.input)).executionId).toBe(noopReceipt.executionId)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('invalidates on restart, replays its generation, rejects policy tampering, and owns process stop', async () => {
    const t = setup()
    const host = new NotebookExecutionCoordinator(t.auth, t.boundary, {
      workspaceRoot: t.root,
      provenance
    })
    await executeCall(t, host)
    const restart = controlCall(t, host, 'notebook.restart', 'restart-once')
    const receipt = await host.restart(restart.input)
    expect(receipt.generation).toBe(1)
    expect((await host.restart(restart.input)).generation).toBe(1)
    await expect(executeCall(t, host, 'stale', 0)).rejects.toThrow('expectedGeneration is stale')
    const tampered = controlCall(t, host, 'notebook.interrupt', 'tampered')
    await expect(
      host.interrupt({ ...tampered.input, request: { ...tampered.request, sessionId: 'other' } })
    ).rejects.toThrow('Policy request does not match')

    const owned = setup()
    const ownedHost = new NotebookExecutionCoordinator(owned.auth, owned.boundary, {
      workspaceRoot: owned.root,
      provenance
    })
    const started = await executeCall(owned, ownedHost)
    const wrong = controlCall(owned, ownedHost, 'notebook.interrupt', 'wrong', started.executionId)
    await expect(ownedHost.interrupt({ ...wrong.input, routeKey: 'other' })).rejects.toThrow()
  })

  it.each([
    ['image/svg+xml', '<svg/>'],
    ['image/png', 'not base64'],
    ['image/jpeg', 'YQ==='],
    ['text/plain', { unsafe: true }],
    ['text/markdown', 7]
  ])('rejects invalid %s data without mutating the notebook', async (mime, data) => {
    const t = setup(
      `${JSON.stringify({
        protocol: 'magicpot-notebook-result.v1',
        status: 'completed',
        cells: [
          { cellId: 'c1', executionCount: 1, stdout: '', stderr: '', displays: [{ mime, data }] },
          { cellId: 'c2', executionCount: 2, stdout: '', stderr: '', displays: [] }
        ]
      })}\n`
    )
    const before = readFileSync(t.file)
    const host = new NotebookExecutionCoordinator(t.auth, t.boundary, {
      workspaceRoot: t.root,
      provenance
    })
    const started = await executeCall(t, host)
    t.complete()
    expect(
      host.status({
        routeKey: 'r',
        sessionId: 's',
        path: 'a.ipynb',
        executionId: started.executionId
      }).state
    ).toBe('failed')
    expect(readFileSync(t.file)).toEqual(before)
  })

  it('accepts bounded images and safe JSON while redacting textual results and errors', async () => {
    const secret = 'token=super-secret-value'
    const t = setup(
      `${JSON.stringify({
        protocol: 'magicpot-notebook-result.v1',
        status: 'completed',
        cells: [
          {
            cellId: 'c1',
            executionCount: 1,
            stdout: '',
            stderr: '',
            result: secret,
            displays: [
              { mime: 'image/png', data: Buffer.from('png').toString('base64') },
              { mime: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') },
              { mime: 'application/json', data: { ok: [true, 1, null, 'value'] } },
              { mime: 'text/markdown', data: secret }
            ]
          },
          { cellId: 'c2', executionCount: 2, stdout: '', stderr: '', displays: [] }
        ]
      })}\n`
    )
    const host = new NotebookExecutionCoordinator(t.auth, t.boundary, {
      workspaceRoot: t.root,
      provenance
    })
    const started = await executeCall(t, host)
    t.complete()
    expect(
      host.status({
        routeKey: 'r',
        sessionId: 's',
        path: 'a.ipynb',
        executionId: started.executionId
      }).state
    ).toBe('completed-applied')
    expect(readFileSync(t.file, 'utf8')).not.toContain('super-secret-value')

    const failed = setup(
      `${JSON.stringify({ protocol: 'magicpot-notebook-result.v1', status: 'error', cells: [], error: secret })}\n`
    )
    const failedHost = new NotebookExecutionCoordinator(failed.auth, failed.boundary, {
      workspaceRoot: failed.root,
      provenance
    })
    const failedStarted = await executeCall(failed, failedHost)
    failed.complete()
    const status = failedHost.status({
      routeKey: 'r',
      sessionId: 's',
      path: 'a.ipynb',
      executionId: failedStarted.executionId
    })
    expect(status.error).toContain('[REDACTED]')
    expect(status.error).not.toContain('super-secret-value')
  })

  it('orders cells, shares globals within one invocation, and atomically applies final expression output', async () => {
    const t = setup()
    const host = new NotebookExecutionCoordinator(t.auth, t.boundary, {
      workspaceRoot: t.root,
      provenance
    })
    const expected = sha(readFileSync(t.file))
    const request = host.createPolicyRequest({
      target: 'notebook.execute-all',
      routeKey: 'r',
      sessionId: 's',
      path: 'a.ipynb',
      expectedSha256: expected,
      expectedGeneration: 0
    })
    const started = await host.executeAll({
      authorizationId: 'a',
      idempotencyKey: 'k',
      request,
      routeKey: 'r',
      sessionId: 's',
      path: 'a.ipynb',
      expectedSha256: expected,
      expectedGeneration: 0,
      ...approval(t.auth, request)
    })
    expect(started.state).toBe('running')
    t.complete()
    const done = host.status({
      routeKey: 'r',
      sessionId: 's',
      path: 'a.ipynb',
      executionId: started.executionId
    })
    expect(done.state).toBe('completed-applied')
    expect(done.variablesPersisted).toBe(false)
    expect(JSON.parse(readFileSync(t.file, 'utf8')).cells[1].outputs[0].data['text/plain']).toBe(
      '5'
    )
  })
  it('is idempotent and rejects concurrent execution', async () => {
    const t = setup()
    const host = new NotebookExecutionCoordinator(t.auth, t.boundary, {
      workspaceRoot: t.root,
      provenance
    })
    const expected = sha(readFileSync(t.file))
    const request = host.createPolicyRequest({
      target: 'notebook.execute-all',
      routeKey: 'r',
      sessionId: 's',
      path: 'a.ipynb',
      expectedSha256: expected,
      expectedGeneration: 0
    })
    const call = {
      authorizationId: 'a',
      idempotencyKey: 'same',
      request,
      routeKey: 'r',
      sessionId: 's',
      path: 'a.ipynb',
      expectedSha256: expected,
      expectedGeneration: 0,
      ...approval(t.auth, request)
    }
    const first = await host.executeAll(call)
    expect((await host.executeAll(call)).executionId).toBe(first.executionId)
    await expect(host.executeAll({ ...call, idempotencyKey: 'other' })).rejects.toThrow(
      'Concurrent'
    )
  })
  it('does not commit partial outputs on protocol error and reconciles crashes without rerun', async () => {
    const t = setup('{bad\n')
    const before = readFileSync(t.file)
    const host = new NotebookExecutionCoordinator(t.auth, t.boundary, {
      workspaceRoot: t.root,
      provenance
    })
    const expected = sha(before)
    const request = host.createPolicyRequest({
      target: 'notebook.execute-all',
      routeKey: 'r',
      sessionId: 's',
      path: 'a.ipynb',
      expectedSha256: expected,
      expectedGeneration: 0
    })
    const started = await host.executeAll({
      authorizationId: 'a',
      idempotencyKey: 'k',
      request,
      routeKey: 'r',
      sessionId: 's',
      path: 'a.ipynb',
      expectedSha256: expected,
      expectedGeneration: 0,
      ...approval(t.auth, request)
    })
    t.complete()
    expect(
      host.status({
        routeKey: 'r',
        sessionId: 's',
        path: 'a.ipynb',
        executionId: started.executionId
      }).state
    ).toBe('failed')
    expect(readFileSync(t.file)).toEqual(before)
    const recovered = new NotebookExecutionCoordinator(t.auth, t.boundary, {
      workspaceRoot: t.root,
      provenance
    })
    expect(
      recovered.status({
        routeKey: 'r',
        sessionId: 's',
        path: 'a.ipynb',
        executionId: started.executionId
      }).state
    ).toBe('failed')
  })
  it('persists content-free audit and artifact resources without leaking execution content', async () => {
    const secret = 'sqlite-leak-sentinel-7f1c'
    const t = setup(
      `${JSON.stringify({
        protocol: 'magicpot-notebook-result.v1',
        status: 'completed',
        cells: [
          {
            cellId: 'c1',
            executionCount: 1,
            stdout: secret,
            stderr: '',
            displays: [{ mime: 'text/plain', data: secret }],
            result: secret
          },
          { cellId: 'c2', executionCount: 2, stdout: '', stderr: '', displays: [] }
        ]
      })}\n`
    )
    const artifactContent = 'artifact-content-sentinel-3b9d'
    writeFileSync(path.join(t.root, 'report.txt'), artifactContent)
    const databasePath = path.join(t.root, 'events.sqlite')
    const store = new MagicAgentEventStore(databasePath)
    stores.push(store)
    const host = new NotebookExecutionCoordinator(t.auth, t.boundary, {
      workspaceRoot: t.root,
      provenance,
      auditSink: store
    })
    const expectedSha256 = sha(readFileSync(t.file))
    const request = host.createPolicyRequest({
      target: 'notebook.execute-all',
      routeKey: 'route-leak-sentinel',
      sessionId: 'session-leak-sentinel',
      path: 'a.ipynb',
      artifacts: ['report.txt'],
      expectedSha256,
      expectedGeneration: 0
    })
    const started = await host.executeAll({
      authorizationId: 'a',
      idempotencyKey: 'persist-artifact',
      request,
      routeKey: 'route-leak-sentinel',
      sessionId: 'session-leak-sentinel',
      path: 'a.ipynb',
      artifacts: ['report.txt'],
      expectedSha256,
      expectedGeneration: 0,
      ...approval(t.auth, request)
    })
    t.complete()
    expect(
      host.status({
        routeKey: 'route-leak-sentinel',
        sessionId: 'session-leak-sentinel',
        path: 'a.ipynb',
        executionId: started.executionId
      }).state
    ).toBe('completed-applied')
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = new MagicAgentEventStore(databasePath)
    stores.push(reopened)
    const artifacts = reopened.listResources({ kind: 'artifact' })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].state).toMatchObject({
      sha256: sha(artifactContent),
      mimeType: 'text/plain',
      size: Buffer.byteLength(artifactContent),
      relativePath: 'report.txt'
    })
    expect(reopened.readStream(`notebook-execution:${started.executionId}`).length).toBeGreaterThan(
      1
    )
    const sqlite = readFileSync(databasePath).toString('latin1')
    for (const leaked of [
      secret,
      artifactContent,
      'x=2',
      'route-leak-sentinel',
      'session-leak-sentinel'
    ])
      expect(sqlite).not.toContain(leaked)
  })

  it.each(['missing', 'symlink', 'oversize'] as const)(
    'rejects %s declared artifacts without mutating the notebook',
    async (kind) => {
      const t = setup()
      const artifact = path.join(t.root, 'artifact.bin')
      if (kind === 'oversize') {
        writeFileSync(artifact, '')
        truncateSync(artifact, 16 * 1024 * 1024 + 1)
      }
      const before = readFileSync(t.file)
      const host = new NotebookExecutionCoordinator(t.auth, t.boundary, {
        workspaceRoot: t.root,
        provenance
      })
      const expectedSha256 = sha(before)
      const request = host.createPolicyRequest({
        target: 'notebook.execute-all',
        routeKey: 'r',
        sessionId: 's',
        path: 'a.ipynb',
        artifacts: ['artifact.bin'],
        expectedSha256,
        expectedGeneration: 0
      })
      const started = await host.executeAll({
        authorizationId: 'a',
        idempotencyKey: `artifact-${kind}`,
        request,
        routeKey: 'r',
        sessionId: 's',
        path: 'a.ipynb',
        artifacts: ['artifact.bin'],
        expectedSha256,
        expectedGeneration: 0,
        ...approval(t.auth, request)
      })
      if (kind === 'symlink') {
        writeFileSync(path.join(t.root, 'target.bin'), 'target')
        symlinkSync(path.join(t.root, 'target.bin'), artifact)
      }
      t.complete()
      expect(
        host.status({
          routeKey: 'r',
          sessionId: 's',
          path: 'a.ipynb',
          executionId: started.executionId
        }).state
      ).toBe('failed')
      expect(readFileSync(t.file)).toEqual(before)
    }
  )

  it('marks successful results completed-not-applied after stale CAS', async () => {
    const t = setup()
    const host = new NotebookExecutionCoordinator(t.auth, t.boundary, {
      workspaceRoot: t.root,
      provenance
    })
    const expected = sha(readFileSync(t.file))
    const request = host.createPolicyRequest({
      target: 'notebook.execute-all',
      routeKey: 'r',
      sessionId: 's',
      path: 'a.ipynb',
      expectedSha256: expected,
      expectedGeneration: 0
    })
    const started = await host.executeAll({
      authorizationId: 'a',
      idempotencyKey: 'k',
      request,
      routeKey: 'r',
      sessionId: 's',
      path: 'a.ipynb',
      expectedSha256: expected,
      expectedGeneration: 0,
      ...approval(t.auth, request)
    })
    writeFileSync(t.file, JSON.stringify(notebook(['changed'])))
    t.complete()
    expect(
      host.status({
        routeKey: 'r',
        sessionId: 's',
        path: 'a.ipynb',
        executionId: started.executionId
      }).state
    ).toBe('completed-not-applied')
  })
})
