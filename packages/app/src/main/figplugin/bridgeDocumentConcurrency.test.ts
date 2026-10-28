import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SqliteNativeWriteCoordinator } from './nativeWriteCoordinator'
import { FigPluginCheckpointStore } from './checkpointStore'
import { record, ownedCodec, NOW } from './checkpointTestUtils'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { binding, context } from './checkpointTestUtils'
import { createHostPlanningPreview } from '@shared/figplugin/hostPlanPreview'
import { createHostPlanReadback, type HostContext, type HostPlan } from '@shared/figplugin/hostPlan'

const runtimes: FigPluginBridgeRuntime[] = []
const roots: string[] = []
afterEach(() => {
  for (const r of runtimes.splice(0)) r.dispose()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture(options: Partial<ConstructorParameters<typeof FigPluginBridgeRuntime>[0]> = {}) {
  const r = new FigPluginBridgeRuntime({
    validateBinding: async () => true,
    allowNativeWrite: () => true,
    invoke: async (_binding, preview) => {
      const c = preview.hostContext!
      const plan: HostPlan = {
        schemaVersion: 2,
        kind: 'host-plan',
        captureId: c.captureId,
        steps: [
          { command: 'node.rename', targetId: c.selectedIds![0], name: 'Accepted owned name' }
        ]
      }
      return { content: JSON.stringify(createHostPlanningPreview(JSON.stringify(plan), c)) }
    },
    ...options
  })
  runtimes.push(r)
  return r
}
async function prepared(r: FigPluginBridgeRuntime, serial: number, doc = 'owned-document') {
  const b = { ...binding, pluginId: `owned.plugin${serial}`, projectId: `project${serial}` }
  const ticket = await r.createPairing(b)
  const session = await r.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: b.pluginId,
    host: b.host,
    artifactSha256: b.artifactSha256,
    clientNonce: serial.toString(16).padStart(32, '0')
  })
  const captureId = serial.toString(16).padStart(32, '0')
  const c: HostContext = {
    ...structuredClone(context),
    captureId,
    documentId: doc,
    recoveryIdentity: serial.toString(16).padStart(32, '0'),
    execution: { ...context.execution!, visualAudit: 'unavailable' }
  }
  const receipt = await r.prepare(session.sessionId, session.sessionToken, {
    protocol: 1,
    requestId: `owned-request-${serial}`,
    sequence: 1,
    featureId: 'plan-preview',
    prompt: 'Rename owned node',
    hostContext: c,
    context: {
      selectionRevision: captureId,
      nodes: [{ id: 'owned-node', type: 'RECTANGLE', name: 'Original', locked: false }]
    }
  })
  const model = r.listPreviews().find((p) => p.callId === receipt.callId)!
  await r.approve(receipt.callId, model.payloadSha256)
  for (let i = 0; i < 30 && !r.listPlanExecutions().some((p) => p.callId === receipt.callId); i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
  const preview = r.listPlanExecutions().find((p) => p.callId === receipt.callId)!
  expect(preview).toBeDefined()
  await r.approvePlan(preview.executionId, preview.planSha256)
  const claim = () =>
    r.claimPlan(session.sessionId, session.sessionToken, { protocol: 1, callId: receipt.callId })
  const after = structuredClone(c)
  after.nodes[0].name = 'Accepted owned name'
  const result = {
    protocol: 1,
    executionId: preview.executionId,
    actionId: preview.executionId,
    status: 'completed',
    effect: 'applied',
    completed: 1,
    total: 1,
    readback: createHostPlanReadback(c, after, preview.plan)
  }
  return {
    preview,
    session,
    claim,
    result,
    finish: () => r.planResult(session.sessionId, session.sessionToken, result)
  }
}
describe('document-wide native execution coordination', () => {
  it('only grants one simultaneous write across different plugin/project/instance bindings', async () => {
    const r = fixture(),
      a = await prepared(r, 1),
      b = await prepared(r, 2)
    const results = await Promise.all([a.claim(), b.claim()])
    expect(results.filter((v) => v.status === 'ready')).toHaveLength(1)
    expect(results.filter((v) => v.status === 'pending')).toHaveLength(1)
  })
  it('releases after verified completion; a repeated old result cannot release the next owner', async () => {
    const r = fixture(),
      a = await prepared(r, 1),
      b = await prepared(r, 2),
      c = await prepared(r, 3)
    expect((await a.claim()).status).toBe('ready')
    expect((await b.claim()).status).toBe('pending')
    a.finish()
    expect((await b.claim()).status).toBe('ready')
    a.finish()
    expect((await c.claim()).status).toBe('pending')
    b.finish()
    expect((await c.claim()).status).toBe('ready')
  })
  it('does not block a different document', async () => {
    const r = fixture(),
      a = await prepared(r, 1),
      b = await prepared(r, 2, 'other-document')
    expect((await a.claim()).status).toBe('ready')
    expect((await b.claim()).status).toBe('ready')
  })
  it('does not release a claimed document merely because desktop cancels its task', async () => {
    const r = fixture(),
      a = await prepared(r, 1),
      b = await prepared(r, 2)
    expect((await a.claim()).status).toBe('ready')
    r.cancelPlan(a.preview.executionId)
    expect((await b.claim()).status).toBe('pending')
    expect((await a.claim()).status).toBe('terminal')
  })
})

function disk() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mp-runtime-writes-'))
  roots.push(root)
  let now = NOW
  return {
    root,
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
    writes: () => new SqliteNativeWriteCoordinator(root, () => now)
  }
}
describe('production runtime with shared disk coordination', () => {
  it.each(['cancel', 'close', 'revoke', 'dispose'] as const)(
    'retains outstanding exclusion after %s; re-created runtimes restore no authority',
    async (kind) => {
      const d = disk(),
        r = fixture({ writes: d.writes(), now: d.now }),
        a = await prepared(r, 1)
      expect((await a.claim()).status).toBe('ready')
      if (kind === 'cancel') r.cancelPlan(a.preview.executionId)
      if (kind === 'close') r.closeSession(a.session.sessionId, a.session.sessionToken)
      if (kind === 'revoke') r.revokePlugin('owned.plugin1')
      if (kind === 'dispose') r.dispose()
      const other = fixture({ writes: d.writes(), now: d.now })
      expect(other.listSessions()).toEqual([])
      expect(other.listPlanExecutions()).toEqual([])
      const b = await prepared(other, 2)
      expect((await b.claim()).status).toBe('pending')
      d.advance(150001)
      const c = await prepared(other, 3)
      expect((await c.claim()).status).toBe('ready')
    }
  )
  it('never releases on invalid or unknown host readback', async () => {
    const d = disk(),
      r = fixture({ writes: d.writes(), now: d.now }),
      a = await prepared(r, 1),
      b = await prepared(r, 2)
    await a.claim()
    expect(() =>
      r.planResult(a.session.sessionId, a.session.sessionToken, {
        ...a.result,
        actionId: 'f'.repeat(32)
      })
    ).toThrow()
    expect((await b.claim()).status).toBe('pending')
    r.planResult(a.session.sessionId, a.session.sessionToken, {
      ...a.result,
      status: 'failed',
      effect: 'unknown',
      completed: 0
    })
    expect((await b.claim()).status).toBe('pending')
  })
  it('a reservation failure never returns an intent', async () => {
    const d = disk(),
      writes = d.writes(),
      r = fixture({ writes, now: d.now }),
      a = await prepared(r, 1)
    vi.spyOn(writes, 'reserve').mockImplementation(() => {
      throw new Error('PRIVATE filesystem failure')
    })
    await expect(a.claim()).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    expect(r.listPlanStatuses()[0].state).toBe('approved')
  })
  it('release failure retains exclusion without falsifying an already verified successful write', async () => {
    const d = disk(),
      writes = d.writes(),
      r = fixture({ writes, now: d.now }),
      a = await prepared(r, 1),
      b = await prepared(r, 2)
    await a.claim()
    vi.spyOn(writes, 'release').mockImplementation(() => {
      throw new Error('PRIVATE disk failure')
    })
    expect(a.finish().status.state).toBe('completed')
    expect((await b.claim()).status).toBe('pending')
  })
  it('missing coordination ownership cannot be reused as a valid live grant', async () => {
    const d = disk(),
      writes = d.writes(),
      r = fixture({ writes, now: d.now }),
      a = await prepared(r, 1)
    await a.claim()
    fs.unlinkSync(writes.file)
    const status = await r.planStatus(a.session.sessionId, a.session.sessionToken, {
      protocol: 1,
      callId: a.preview.callId
    })
    expect(status).toMatchObject({ state: 'failed', effect: 'unknown', errorCode: 'QUARANTINED' })
    expect((await a.claim()).status).toBe('terminal')
    expect(() => a.finish()).toThrow()
  })
  it('waiting behind an ordinary write does not consume a recovery round', async () => {
    const d = disk(),
      checkpoints = new FigPluginCheckpointStore(
        path.join(d.root, 'checkpoints'),
        ownedCodec(),
        d.now
      )
    checkpoints.save(record())
    const r = fixture({ writes: d.writes(), now: d.now, checkpoints }),
      a = await prepared(r, 1)
    await a.claim()
    const ticket = await r.createPairing(binding)
    const session = await r.redeem({
      protocol: 1,
      ticketId: ticket.ticketId,
      pairingSecret: ticket.pairingSecret,
      pluginId: binding.pluginId,
      host: binding.host,
      artifactSha256: binding.artifactSha256,
      clientNonce: 'a'.repeat(32)
    })
    const c = structuredClone(context)
    c.captureId = 'b'.repeat(32)
    c.nodes[0].name = 'Drifting owned name'
    const recovery = await r.prepareTaskRecovery(session.sessionId, session.sessionToken, {
      protocol: 1,
      requestId: c.captureId,
      sequence: 1,
      hostContext: c
    })
    if (recovery.status !== 'prepared') throw new Error('No preview')
    const preview = r.listPlanExecutions().find((p) => p.executionId === recovery.executionId)!
    await r.approvePlan(preview.executionId, preview.planSha256)
    const claim = () =>
      r.claimPlan(session.sessionId, session.sessionToken, { protocol: 1, callId: recovery.callId })
    expect((await claim()).status).toBe('pending')
    expect(checkpoints.find(binding, context)?.value.correctionRoundsUsed).toBe(0)
    a.finish()
    expect((await claim()).status).toBe('ready')
    expect(checkpoints.find(binding, context)?.value.correctionRoundsUsed).toBe(1)
  })
})
