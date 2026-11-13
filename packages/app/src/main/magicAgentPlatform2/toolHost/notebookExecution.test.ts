import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import * as nativeFs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:fs', async () => ({
  ...(await vi.importActual<typeof import('node:fs')>('node:fs'))
}))
vi.unmock('node:fs/promises')
import { createAgentThreadToolProvider } from '../../api/agentThreadTools'
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
  vi.restoreAllMocks()
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

function createHost(
  t: ReturnType<typeof setup>,
  options: Pick<ConstructorParameters<typeof NotebookExecutionCoordinator>[2], 'auditSink'> = {}
) {
  return new NotebookExecutionCoordinator(t.auth, t.boundary, {
    workspaceRoot: t.root,
    provenance,
    ...options
  })
}

async function passiveRunManual(t: ReturnType<typeof setup>) {
  const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'passive-run', threadId: 'pane' } as const
  const before = readFileSync(t.file), entries = readdirSync(t.root)
  const createGrant = vi.spyOn(t.auth, 'createApprovalGrant'), authorize = vi.spyOn(t.auth, 'authorize')
  const consume = vi.spyOn(t.auth, 'consumeExecutionPermit'), start = vi.spyOn(t.boundary, 'start'), stop = vi.spyOn(t.boundary, 'stop')
  const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => [{ name: 'notebook.run', description: 'Existing admitted run', inputSchema: { type: 'object' } }] })
  const result = JSON.parse((await provider.callTool('info', { name: 'notebook.run' }, { route, runId: 'manual', workspaceRootDir: t.root })).content)
  expect(result.documentation).toMatchObject({ contract: 'magicpot-local-notebook-run-manual/v1', grantsPermission: false, execution: { mode: 'stateless', kernelPersistent: false, variablesPersisted: false, automaticRetry: false } })
  expect(readFileSync(t.file)).toEqual(before); expect(readdirSync(t.root)).toEqual(entries)
  expect(existsSync(path.join(t.root, '.magicpot'))).toBe(false)
  for (const callback of [createGrant, authorize, consume, start, stop]) expect(callback).not.toHaveBeenCalled()
  return result.documentation
}

describe('NotebookExecutionCoordinator', () => {
  it('separates a passive run manual from real fixture apply and reports dispatch CAS rather than the newly stored generation/hash', async () => {
    const t = setup(), before = readFileSync(t.file), beforeSha = sha(before)
    const doc = await passiveRunManual(t)
    const host = createHost(t), started = await executeCall(t, host)
    expect(started).toMatchObject({ state: 'running', generation: 0, notebookSha256: beforeSha, executionMode: 'stateless', kernelPersistent: false, variablesPersisted: false })
    expect(readFileSync(t.file)).toEqual(before)
    t.complete()
    const status = host.status({ routeKey: 'r', sessionId: 's', path: 'a.ipynb', executionId: started.executionId })
    expect(status).toMatchObject({ state: 'completed-applied', generation: 0, notebookSha256: beforeSha, snapshotId: beforeSha })
    expect(JSON.parse(readFileSync(t.file, 'utf8')).cells[1].outputs[0]).toMatchObject({ output_type: 'execute_result', data: { 'text/plain': '5' } })
    expect(sha(readFileSync(t.file))).not.toBe(beforeSha)
    expect(status.resultSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(status.resultSha256).not.toBe(sha(readFileSync(t.file)))
    expect(readFileSync(path.join(t.root, '.magicpot/notebook-snapshots', `${beforeSha}.ipynb`))).toEqual(before)
    const generationFile = path.join(t.root, '.magicpot/notebook-executions', `generation-${sha('a.ipynb')}.json`)
    expect(JSON.parse(readFileSync(generationFile, 'utf8'))).toMatchObject({ generation: 1 })
    for (const key of ['status', 'stdout', 'stderr', 'mutation', 'writeStatus', 'businessTaskVerified', 'grantsPermission', 'untrustedData']) expect(Object.hasOwn(status, key)).toBe(false)
    expect(doc.execution.apply).toContain('old dispatch generation')
    await expect(executeCall(t, host, 'stale-returned-generation', status.generation)).rejects.toThrow('expectedGeneration is stale')
  })
  it.each(['stale-sha', 'stale-generation', 'error-protocol', 'cancelled'] as const)('preserves actual %s state after passive info without applying late/partial results', async reason => {
    const t = setup(reason === 'error-protocol' ? `${JSON.stringify({ protocol: 'magicpot-notebook-result.v1', status: 'error', cells: [{ cellId: 'c1', executionCount: 1, stdout: 'PARTIAL_MUST_NOT_APPLY', stderr: '', displays: [] }], error: 'cell2 failed' })}\n` : undefined)
    await passiveRunManual(t)
    const before = readFileSync(t.file), expectedSha256 = sha(before), host = createHost(t)
    const request = host.createPolicyRequest({ target: 'notebook.execute-all', routeKey: 'r', sessionId: 's', path: 'a.ipynb', expectedSha256, expectedGeneration: 0 })
    const controller = new AbortController()
    const input = { authorizationId: 'a', idempotencyKey: `manual-${reason}`, request, routeKey: 'r', sessionId: 's', path: 'a.ipynb', expectedSha256, expectedGeneration: 0, signal: controller.signal, ...approval(t.auth, request) }
    const started = await host.executeAll(input)
    let unchanged = before
    if (reason === 'stale-sha') {
      unchanged = Buffer.from(JSON.stringify(notebook(['EXTERNAL_EDIT', 'x+3'])))
      writeFileSync(t.file, unchanged)
    } else if (reason === 'stale-generation') {
      writeFileSync(path.join(t.root, '.magicpot/notebook-executions', `generation-${sha('a.ipynb')}.json`), JSON.stringify({ path: 'a.ipynb', generation: 1 }))
    }
    if (reason === 'cancelled') {
      // The prior idempotent execution is still running when wait begins; abort
      // after the async call enters, so the production wait loop owns stop.
      const waiting = host.executeAndWait(input)
      controller.abort(Error('notebook document closed'))
      await expect(waiting).rejects.toThrow('notebook document closed')
    }
    t.complete()
    const status = host.status({ routeKey: 'r', sessionId: 's', path: 'a.ipynb', executionId: started.executionId })
    expect(status.state).toBe(reason.startsWith('stale-') ? 'completed-not-applied' : reason === 'error-protocol' ? 'failed' : 'interrupted')
    expect(readFileSync(t.file)).toEqual(unchanged)
    expect(existsSync(path.join(t.root, '.magicpot/notebook-snapshots', `${expectedSha256}.ipynb`))).toBe(false)
    if (reason === 'error-protocol') expect(status.error).toContain('cell2 failed')
    if (reason === 'cancelled') expect(t.boundary.stop).toHaveBeenCalledOnce()
  })
  it('retains file-order approval exactness rather than accepting caller reordering after a passive manual', async () => {
    const t = setup(), before = readFileSync(t.file)
    const doc = await passiveRunManual(t), host = createHost(t)
    const expectedSha256 = sha(before), cellIds = ['c2', 'c1']
    const request = host.createPolicyRequest({ target: 'notebook.execute-cell', routeKey: 'r', sessionId: 's', path: 'a.ipynb', expectedSha256, expectedGeneration: 0, cellIds })
    const input = { authorizationId: 'a', idempotencyKey: 'reversed-selection', request, routeKey: 'r', sessionId: 's', path: 'a.ipynb', expectedSha256, expectedGeneration: 0, cellIds, ...approval(t.auth, request) }
    await expect(host.executeCell(input)).rejects.toThrow('Policy request does not match')
    expect(readFileSync(t.file)).toEqual(before); expect(t.boundary.start).not.toHaveBeenCalled()
    expect(t.auth.createApprovalGrant).toHaveBeenCalledOnce()
    expect(doc.behavior.selection).toContain('after formal approval')
  })
  it('can report failed after output rename and generation advance when terminal audit fails, without rolling bytes back', async () => {
    const t = setup(), before = readFileSync(t.file), beforeSha = sha(before)
    const doc = await passiveRunManual(t)
    const audit = vi.fn((events: readonly { type: string }[]) => {
      if (events.some(event => event.type === 'notebook.execution.completed-applied')) throw Error('late apply audit persistence failed')
    })
    const host = createHost(t, { auditSink: { appendBatch: audit, getEvent: () => undefined, getLastSequence: () => undefined, getResource: () => undefined, mutateResourcesBatch: () => undefined } })
    const started = await executeCall(t, host)
    t.complete()
    const status = host.status({ routeKey: 'r', sessionId: 's', path: 'a.ipynb', executionId: started.executionId })
    expect(status).toMatchObject({ state: 'failed', generation: 0, error: 'late apply audit persistence failed' })
    expect(readFileSync(t.file)).not.toEqual(before)
    expect(JSON.parse(readFileSync(t.file, 'utf8')).cells[1].outputs[0]).toMatchObject({ output_type: 'execute_result', data: { 'text/plain': '5' } })
    expect(readFileSync(path.join(t.root, '.magicpot/notebook-snapshots', `${beforeSha}.ipynb`))).toEqual(before)
    expect(JSON.parse(readFileSync(path.join(t.root, '.magicpot/notebook-executions', `generation-${sha('a.ipynb')}.json`), 'utf8')).generation).toBe(1)
    expect(doc.failure).toMatchObject({ automaticRetry: false, cancellationRollsBack: false, failureProvesNoMutation: false })
    expect(doc.failure.rule).toContain('failure after target rename can leave saved outputs/generation changed')
  })
  it('synchronous wait applies only completed results and cancellation never applies late output', async () => {
    for (const cancel of [false, true]) {
      const t = setup(), host = createHost(t), controller = new AbortController()
      const before = readFileSync(t.file), expectedSha256 = sha(before)
      const request = host.createPolicyRequest({ target: 'notebook.execute-all', routeKey: 'r', sessionId: 's', path: 'a.ipynb', expectedSha256, expectedGeneration: 0 })
      const stop = vi.spyOn(t.boundary, 'stop')
      const waiting = host.executeAndWait({ authorizationId: 'a', idempotencyKey: `sync-${cancel}`, request, routeKey: 'r', sessionId: 's', path: 'a.ipynb', expectedSha256, expectedGeneration: 0, signal: controller.signal, ...approval(t.auth, request) })
      const handled = waiting.catch((error) => error)
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (cancel) controller.abort(new Error('document gone'))
      else t.complete()
      if (cancel) {
        expect(await handled).toBeInstanceOf(Error)
        expect(stop).toHaveBeenCalledOnce()
        t.complete()
        expect(readFileSync(t.file)).toEqual(before)
      } else expect(await handled).toMatchObject({ state: 'completed-applied' })
    }
  })

  it('durably replays active and no-op interrupt receipts', async () => {
    const t = setup()
    const stop = vi.spyOn(t.boundary, 'stop')
    const host = createHost(t)
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
    const recovered = createHost(t)
    expect((await recovered.interrupt(noop.input)).executionId).toBe(noopReceipt.executionId)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('invalidates on restart, replays its generation, rejects policy tampering, and owns process stop', async () => {
    const t = setup()
    const host = createHost(t)
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
    const ownedHost = createHost(owned)
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
    const host = createHost(t)
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
    const host = createHost(t)
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
    const failedHost = createHost(failed)
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
    const host = createHost(t)
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
    const host = createHost(t)
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
    const host = createHost(t)
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
    const recovered = createHost(t)
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
    const host = createHost(t, { auditSink: store })
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

  it.each(['missing', 'symlink', 'linked-parent', 'file-symlink-stat', 'oversize'] as const)(
    'rejects %s declared artifacts without mutating the notebook',
    async (kind) => {
      const t = setup()
      const artifactRelative = kind === 'linked-parent' ? 'linked/artifact.bin' : 'artifact.bin'
      const artifact = path.join(t.root, artifactRelative)
      if (kind === 'oversize') {
        writeFileSync(artifact, '')
        truncateSync(artifact, 16 * 1024 * 1024 + 1)
      }
      const before = readFileSync(t.file)
      const host = createHost(t)
      const expectedSha256 = sha(before)
      const request = host.createPolicyRequest({
        target: 'notebook.execute-all',
        routeKey: 'r',
        sessionId: 's',
        path: 'a.ipynb',
        artifacts: [artifactRelative],
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
        artifacts: [artifactRelative],
        expectedSha256,
        expectedGeneration: 0,
        ...approval(t.auth, request)
      })
      let mockedArtifactHits = 0
      let artifactRead: ReturnType<typeof vi.spyOn> | undefined
      if (kind === 'symlink' || kind === 'linked-parent') {
        const targetDirectory = path.join(t.root, 'target')
        mkdirSync(targetDirectory)
        writeFileSync(path.join(targetDirectory, 'artifact.bin'), 'target')
        // Windows directory junctions require no file-symlink privilege. On
        // Linux/macOS retain the actual native file symlink rejection case.
        const directoryLink = kind === 'linked-parent' || process.platform === 'win32'
        symlinkSync(
          directoryLink ? targetDirectory : path.join(targetDirectory, 'artifact.bin'),
          kind === 'linked-parent' ? path.dirname(artifact) : artifact,
          directoryLink ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'
        )
        expect(
          nativeFs
            .lstatSync(kind === 'linked-parent' ? path.dirname(artifact) : artifact)
            .isSymbolicLink()
        ).toBe(true)
      }
      if (kind === 'file-symlink-stat') {
        writeFileSync(artifact, 'target')
        const canonicalArtifact = realpathSync.native(artifact)
        const actualLstat = nativeFs.lstatSync
        // Model the file-symlink lstat bit only, keeping all other operations
        // native. The real junction cases above separately cover OS traversal.
        vi.spyOn(nativeFs, 'lstatSync').mockImplementation((value, options) => {
          const stat = actualLstat(value, options)
          if (path.resolve(String(value)) !== canonicalArtifact || !stat) return stat
          mockedArtifactHits += 1
          return Object.assign(Object.create(stat), { isSymbolicLink: () => true })
        })
        artifactRead = vi.spyOn(nativeFs, 'readFileSync')
      }
      t.complete()
      const status = host.status({
        routeKey: 'r',
        sessionId: 's',
        path: 'a.ipynb',
        executionId: started.executionId
      })
      expect(status.state).toBe('failed')
      if (kind === 'symlink' || kind === 'linked-parent' || kind === 'file-symlink-stat')
        expect(status.error).toBe('Symlinks are not allowed.')
      if (kind === 'file-symlink-stat') {
        expect(mockedArtifactHits).toBeGreaterThan(0)
        expect(
          artifactRead!.mock.calls.some(
            ([value]) => path.resolve(String(value)) === realpathSync.native(artifact)
          )
        ).toBe(false)
      }
      expect(readFileSync(t.file)).toEqual(before)
    }
  )

  it('marks successful results completed-not-applied after stale CAS', async () => {
    const t = setup()
    const host = createHost(t)
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
