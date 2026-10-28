import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { FigPluginCheckpointStore } from './checkpointStore'
import { NOW, binding, context, plan, record, ownedCodec } from './checkpointTestUtils'
import { createHostPlanReadback } from '@shared/figplugin/hostPlan'
import { figPluginTaskRecoveryPrepareRequestSchema } from '@shared/figplugin/taskRecovery'
import { buildPlanExecutionApprovalDetails } from './bridgeApprovalDetails'
import type { FigPluginExecutionAuditEvent } from './executionAudit'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const roots: string[] = [],
  runtimes: FigPluginBridgeRuntime[] = []
afterEach(() => {
  for (const r of runtimes.splice(0)) r.dispose()
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const oldIdentity = context.recoveryIdentity!,
  nextIdentity = 'e'.repeat(32)
function setup() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mp-reload-'))
  roots.push(dir)
  const codec = ownedCodec()
  let now = NOW
  const store = () => new FigPluginCheckpointStore(dir, codec, () => now)
  const saved = record()
  store().save(saved)
  const make = () => {
    const audit: FigPluginExecutionAuditEvent[] = []
    const invoke = vi.fn(async () => {
      throw new Error('No model during recovery')
    })
    const r = new FigPluginBridgeRuntime({
      validateBinding: async () => true,
      invoke,
      allowNativeWrite: () => true,
      now: () => now,
      checkpoints: store(),
      audit: (event) => audit.push(event)
    })
    runtimes.push(r)
    return { r, invoke, audit }
  }
  return {
    store,
    saved,
    make,
    advance: (ms: number) => {
      now += ms
    }
  }
}
async function pair(r: FigPluginBridgeRuntime, overrides: Partial<typeof binding> = {}) {
  const b = { ...binding, ...overrides },
    ticket = await r.createPairing(b)
  return r.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: b.pluginId,
    host: b.host,
    artifactSha256: b.artifactSha256,
    clientNonce: '9'.repeat(32)
  })
}
function request(id = record().value.baselineId, serial = 1, identity = nextIdentity) {
  const captureId = serial.toString(16).padStart(32, '0')
  return {
    protocol: 1,
    requestId: captureId,
    sequence: serial,
    rebindBaselineId: id,
    hostContext: {
      ...structuredClone(context),
      captureId,
      recoveryIdentity: identity,
      nodes: context.nodes.map((n) => ({ ...n, name: 'Later user edit', opacity: 0.2 }))
    }
  }
}
async function prepare(
  r: FigPluginBridgeRuntime,
  s: Awaited<ReturnType<typeof pair>>,
  input = request()
) {
  const result = await r.prepareTaskRecovery(s.sessionId, s.sessionToken, input)
  if (result.status !== 'prepared') throw new Error('Expected prepared')
  const preview = r.listPlanExecutions().find((e) => e.executionId === result.executionId)!
  return {
    result,
    preview,
    claim: () => r.claimPlan(s.sessionId, s.sessionToken, { protocol: 1, callId: result.callId })
  }
}
describe('explicit user-selected recovery after a native plugin reload', () => {
  it('requires explicit checkpoint selection and a distinct trusted rebind consent before any claim', async () => {
    const f = setup(),
      m = f.make(),
      s = await pair(m.r)
    const ordinary = { ...request() }
    delete (ordinary as Partial<typeof ordinary>).rebindBaselineId
    await expect(m.r.prepareTaskRecovery(s.sessionId, s.sessionToken, ordinary)).rejects.toThrow()
    const p = await prepare(m.r, s)
    expect(p.preview.recovery?.rebind).toEqual({ previousIdentity: oldIdentity, nextIdentity })
    expect(p.preview.risk).toBe('high')
    expect(m.audit.at(-1)?.taskRecovery).toMatchObject({
      reassociationRequested: true,
      consumed: false
    })
    expect(buildPlanExecutionApprovalDetails(p.preview)).toContain(
      'NOT proof that this is the original document'
    )
    expect((await p.claim()).status).toBe('pending')
    await expect(
      m.r.approvePlan(p.preview.executionId, p.preview.planSha256)
    ).rejects.toMatchObject({ code: 'DENIED' })
    expect(f.store().find(binding, context)?.value.correctionRoundsUsed).toBe(0)
    expect(f.store().find(binding, request().hostContext)).toBeUndefined()
    await m.r.approvePlan(p.preview.executionId, p.preview.planSha256, true)
    const a = await p.claim(),
      b = await p.claim()
    expect(a).toEqual(b)
    expect(a.status).toBe('ready')
    const recovered = f.store().find(binding, request().hostContext)!
    expect(recovered.value.correctionRoundsUsed).toBe(1)
    expect(m.audit.at(-1)?.taskRecovery).toMatchObject({
      reassociationRequested: true,
      consumed: true
    })
    expect(JSON.stringify(m.audit)).not.toMatch(
      /previousIdentity|nextIdentity|PRIVATE_OWNED_DESIGN_TEXT/
    )

    expect(recovered.value.expiresAt).toBe(f.saved.value.expiresAt)
    expect(f.store().find(binding, context)).toBeUndefined()
    expect(m.invoke).not.toHaveBeenCalled()
  })
  it('verifies exact restored properties, preserves unrelated edits and compares against the same checkpoint', async () => {
    const f = setup(),
      m = f.make(),
      s = await pair(m.r),
      input = request(),
      p = await prepare(m.r, s, input)
    await m.r.approvePlan(p.preview.executionId, p.preview.planSha256, true)
    const c = await p.claim()
    if (c.status !== 'ready') throw new Error('not ready')
    const after = structuredClone(input.hostContext)
    after.nodes[0].name = (plan.steps[0] as { name: string }).name
    const result = m.r.planResult(s.sessionId, s.sessionToken, {
      protocol: 1,
      executionId: p.preview.executionId,
      actionId: c.intent.actionId,
      status: 'completed',
      effect: 'applied',
      completed: 1,
      total: 1,
      readback: createHostPlanReadback(input.hostContext, after, c.intent.plan),
      visualEvidence: [
        {
          targetId: 'owned-node',
          before: { sha256: '6'.repeat(64), width: 2, height: 1 },
          after: { sha256: '5'.repeat(64), width: 2, height: 1 },
          changed: true
        }
      ]
    })
    expect(result.status).toMatchObject({
      state: 'completed',
      recoveryConsumed: true,
      visualBaselineComparison: { baselineId: f.saved.value.baselineId, exactMatch: true }
    })
    expect(after.nodes[0].opacity).toBe(0.2)
  })
  it.each(['deny', 'cancel'] as const)(
    'does not rebind or consume a round when the preview is %s',
    async (kind) => {
      const f = setup(),
        m = f.make(),
        s = await pair(m.r),
        p = await prepare(m.r, s)
      if (kind === 'deny') m.r.denyPlan(p.preview.executionId)
      else m.r.cancelPlan(p.preview.executionId)
      expect((await p.claim()).status).toBe('terminal')
      expect(f.store().find(binding, context)?.value.correctionRoundsUsed).toBe(0)
      expect(f.store().find(binding, request().hostContext)).toBeUndefined()
    }
  )
  it.each(['document', 'scope', 'target', 'parent', 'locked', 'adapter', 'unknown-code'] as const)(
    'rejects %s changes rather than remapping objects',
    async (kind) => {
      const f = setup(),
        m = f.make(),
        s = await pair(m.r),
        input = request()
      if (kind === 'document') input.hostContext.documentId = 'another'
      if (kind === 'scope') input.hostContext.scopeId = 'another'
      if (kind === 'target') input.hostContext.selectedIds = ['another']
      if (kind === 'parent') input.hostContext.nodes[0].parentId = 'another'
      if (kind === 'locked') input.hostContext.nodes[0].locked = true
      if (kind === 'adapter') input.hostContext.execution!.adapterVersion = 'another'
      if (kind === 'unknown-code') input.rebindBaselineId = 'f'.repeat(32)
      await expect(prepare(m.r, s, input)).rejects.toThrow()
      expect(m.r.listPlanExecutions()).toEqual([])
      expect(f.store().find(binding, context)?.value.correctionRoundsUsed).toBe(0)
    }
  )
  it.each(['projectId', 'profileId', 'artifactSha256'] as const)(
    'does not cross the stable %s binding',
    async (key) => {
      const f = setup(),
        m = f.make(),
        s = await pair(m.r, { [key]: key === 'artifactSha256' ? 'f'.repeat(64) : 'another' })
      await expect(prepare(m.r, s)).rejects.toThrow()
    }
  )
  it('serializes two independent runtime claims; stale instance cannot reset the binding or budget', async () => {
    const f = setup(),
      a = f.make(),
      b = f.make(),
      sa = await pair(a.r),
      sb = await pair(b.r)
    const pa = await prepare(a.r, sa),
      pb = await prepare(b.r, sb, request(f.saved.value.baselineId, 1, 'f'.repeat(32)))
    await a.r.approvePlan(pa.preview.executionId, pa.preview.planSha256, true)
    await b.r.approvePlan(pb.preview.executionId, pb.preview.planSha256, true)
    expect((await pa.claim()).status).toBe('ready')
    await expect(pb.claim()).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    expect(f.store().find(binding, request().hostContext)?.value.correctionRoundsUsed).toBe(1)
  })
  it('keeps prior rounds across repeated reloads and forbids a fourth claim', async () => {
    const f = setup()
    for (let round = 1; round <= 3; round++) {
      const m = f.make(),
        s = await pair(m.r, { profileRevision: round.toString().repeat(64) }),
        input = request(f.saved.value.baselineId, 1, (round + 5).toString().repeat(32)),
        p = await prepare(m.r, s, input)
      expect(p.preview.recovery?.round).toBe(round)
      await m.r.approvePlan(p.preview.executionId, p.preview.planSha256, true)
      await p.claim()
      m.r.dispose()
      if (round < 3) f.advance(120_001)
    }
    f.advance(120_001)
    const m = f.make(),
      s = await pair(m.r)
    await expect(prepare(m.r, s)).rejects.toMatchObject({ code: 'DENIED' })
    expect(f.store().listSummaries()[0].correctionRoundsUsed).toBe(3)
  })
  it('already matching properties do not rebind silently and do not spend a round', async () => {
    const f = setup(),
      m = f.make(),
      s = await pair(m.r),
      input = request()
    input.hostContext.nodes[0].name = (plan.steps[0] as { name: string }).name
    expect(await m.r.prepareTaskRecovery(s.sessionId, s.sessionToken, input)).toMatchObject({
      status: 'unchanged'
    })
    expect(f.store().find(binding, context)?.value.correctionRoundsUsed).toBe(0)
    expect(f.store().find(binding, input.hostContext)).toBeUndefined()
  })
  it('saved summaries contain no design values, credentials or live authority; expiry removes them', () => {
    const f = setup(),
      rows = f.store().listSummaries()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toMatch(
      /PRIVATE|recoveryIdentity|recoveryPlan|sessionToken|profileRevision/
    )
    f.advance(86400001)
    expect(f.store().listSummaries()).toEqual([])
  })
  it('revocation between review and claim prevents persisted reassociation', async () => {
    const f = setup(),
      m = f.make(),
      s = await pair(m.r),
      p = await prepare(m.r, s)
    await m.r.approvePlan(p.preview.executionId, p.preview.planSha256, true)
    f.store().removeWhere(() => true)
    await expect(p.claim()).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    expect(m.r.listPlanStatuses()[0].recoveryConsumed).toBe(false)
  })
  it('request schema never accepts an injected approval or old/new identity override', () => {
    for (const extra of [
      { approved: true },
      { rebind: { previousIdentity: oldIdentity, nextIdentity } },
      { rebindBaselineId: 'bad' },
      { rebindBaselineId: 'a'.repeat(32) + '\n' }
    ])
      expect(
        figPluginTaskRecoveryPrepareRequestSchema.safeParse({ ...request(), ...extra }).success
      ).toBe(false)
  })
})
