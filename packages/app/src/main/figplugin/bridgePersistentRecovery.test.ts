import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { FigPluginCheckpointStore } from './checkpointStore'
import { NOW, binding, context, plan, record, ownedCodec } from './checkpointTestUtils'
import { createHostPlanningPreview } from '@shared/figplugin/hostPlanPreview'
import { createHostPlanReadback } from '@shared/figplugin/hostPlan'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const roots: string[] = []
const runtimes: FigPluginBridgeRuntime[] = []
afterEach(() => {
  for (const r of runtimes.splice(0)) r.dispose()
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function setup() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mp-recovery-'))
  roots.push(dir)
  const codec = ownedCodec()
  let now = NOW
  const store = () => new FigPluginCheckpointStore(dir, codec, () => now)
  const make = () => {
    const invoke = vi.fn(async () => ({
      content: JSON.stringify(createHostPlanningPreview(JSON.stringify(plan), context))
    }))
    const r = new FigPluginBridgeRuntime({
      validateBinding: async () => true,
      invoke,
      allowNativeWrite: () => true,
      now: () => now,
      checkpoints: store()
    })
    runtimes.push(r)
    return { r, invoke }
  }
  return {
    dir,
    store,
    make,
    advance: (value: number) => {
      now += value
    }
  }
}
async function pair(r: FigPluginBridgeRuntime, revision = binding.profileRevision) {
  const ticket = await r.createPairing({ ...binding, profileRevision: revision })
  return r.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: binding.pluginId,
    host: binding.host,
    artifactSha256: binding.artifactSha256,
    clientNonce: '9'.repeat(32)
  })
}
const input = (serial = 1) => ({
  protocol: 1,
  requestId: serial.toString(16).padStart(32, '0'),
  sequence: serial,
  hostContext: {
    ...structuredClone(context),
    captureId: serial.toString(16).padStart(32, '0'),
    nodes: context.nodes.map((n) => ({ ...n, name: 'Later edit', opacity: 0.2 }))
  }
})
async function accept(r: FigPluginBridgeRuntime) {
  const session = await pair(r)
  const prepared = await r.prepare(session.sessionId, session.sessionToken, {
    protocol: 1,
    sequence: 1,
    requestId: 'owned-plan',
    prompt: 'Rename owned node',
    featureId: 'plan-preview',
    hostContext: context,
    context: {
      selectionRevision: context.captureId,
      nodes: [{ id: 'owned-node', name: 'Original', type: 'RECTANGLE', locked: false }]
    }
  })
  const preview = r.listPreviews()[0]
  await r.approve(prepared.callId, preview.payloadSha256)
  for (let i = 0; i < 30 && !r.listPlanExecutions().length; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
  const execution = r.listPlanExecutions()[0]
  expect(execution).toBeDefined()
  await r.approvePlan(execution.executionId, execution.planSha256)
  const claimed = await r.claimPlan(session.sessionId, session.sessionToken, {
    protocol: 1,
    callId: prepared.callId
  })
  if (claimed.status !== 'ready') throw new Error('not claimed')
  const after = structuredClone(context)
  after.nodes[0].name = (plan.steps[0] as { name: string }).name
  const evidence = [
    {
      targetId: 'owned-node',
      before: { sha256: '4'.repeat(64), width: 2, height: 1 },
      after: { sha256: '5'.repeat(64), width: 2, height: 1 },
      changed: true
    }
  ]
  const result = r.planResult(session.sessionId, session.sessionToken, {
    protocol: 1,
    executionId: execution.executionId,
    actionId: claimed.intent.actionId,
    status: 'completed',
    effect: 'applied',
    completed: 1,
    total: 1,
    readback: createHostPlanReadback(context, after, plan),
    visualEvidence: evidence
  })
  const baseline = await r.acceptVisualBaseline(
    execution.executionId,
    result.status.visualEvidenceSha256!
  )
  return { session, baseline, execution, result }
}
async function prepare(
  r: FigPluginBridgeRuntime,
  session: Awaited<ReturnType<typeof pair>>,
  serial = 1
) {
  const response = await r.prepareTaskRecovery(
    session.sessionId,
    session.sessionToken,
    input(serial)
  )
  if (response.status !== 'prepared') throw new Error('not prepared')
  return response
}
async function approveClaim(
  r: FigPluginBridgeRuntime,
  session: Awaited<ReturnType<typeof pair>>,
  prepared: Awaited<ReturnType<typeof prepare>>
) {
  const preview = r.listPlanExecutions().find((v) => v.executionId === prepared.executionId)!
  await r.approvePlan(preview.executionId, preview.planSha256)
  return r.claimPlan(session.sessionId, session.sessionToken, {
    protocol: 1,
    callId: prepared.callId
  })
}
describe('persistent accepted task checkpoints through the production runtime', () => {
  it('survives desktop runtime disposal with used rounds, rejects old credentials and requires fresh approval without a model', async () => {
    const f = setup(),
      first = f.make(),
      accepted = await accept(first.r)
    expect(accepted.baseline.storage).toBe('encrypted-local')
    expect(f.store().find(binding, context)?.value.baselineId).toBe(accepted.baseline.baselineId)
    const prepared = await prepare(first.r, accepted.session, 2)
    expect((await approveClaim(first.r, accepted.session, prepared)).status).toBe('ready')
    first.r.dispose()
    const next = f.make()
    expect(next.r.listSessions()).toEqual([])
    expect(next.r.listVisualBaselines()).toEqual([])
    expect(next.r.listPlanExecutions()).toEqual([])
    await expect(
      next.r.prepareTaskRecovery(accepted.session.sessionId, accepted.session.sessionToken, input())
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    const session = await pair(next.r, 'f'.repeat(64))
    const blocked = next.r.prepareTaskRecovery(session.sessionId, session.sessionToken, input())
    await expect(blocked).rejects.toMatchObject({ code: 'BUSY' })
    // The previous process consumed the round but did not leave a host receipt. The
    // persisted crash fence expires before a fresh recovery intent may be prepared.
    f.advance(120_001)
    const freshSession = await pair(next.r, 'f'.repeat(64))
    const recovered = await prepare(next.r, freshSession)
    expect(recovered.recovery.round).toBe(2)
    expect(
      (
        await next.r.claimPlan(freshSession.sessionId, freshSession.sessionToken, {
          protocol: 1,
          callId: recovered.callId
        })
      ).status
    ).toBe('pending')
    expect(f.store().find(binding, context)?.value.correctionRoundsUsed).toBe(1)
    const claimed = await approveClaim(next.r, freshSession, recovered)
    if (claimed.status !== 'ready') throw new Error('missing intent')
    const after = structuredClone(input().hostContext)
    after.nodes[0].name = (plan.steps[0] as { name: string }).name
    const result = next.r.planResult(freshSession.sessionId, freshSession.sessionToken, {
      protocol: 1,
      executionId: recovered.executionId,
      actionId: claimed.intent.actionId,
      status: 'completed',
      effect: 'applied',
      completed: 1,
      total: 1,
      readback: createHostPlanReadback(input().hostContext, after, claimed.intent.plan),
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
      visualBaselineComparison: { exactMatch: true }
    })
    expect(f.store().find(binding, context)?.activeRecovery).toBeUndefined()
    expect(after.nodes[0].opacity).toBe(0.2)
    expect(f.store().find(binding, context)?.value.correctionRoundsUsed).toBe(2)
    expect(next.invoke).not.toHaveBeenCalled()
    next.r.dispose()
    const settled = f.make(),
      settledSession = await pair(settled.r)
    expect((await prepare(settled.r, settledSession)).recovery.round).toBe(3)
  })
  it('declining before claim spends no round, restarting cannot exceed the shared three-round limit', async () => {
    const f = setup()
    f.store().save(record())
    let current = f.make(),
      session = await pair(current.r),
      p = await prepare(current.r, session)
    current.r.denyPlan(p.executionId)
    expect(f.store().find(binding, context)?.value.correctionRoundsUsed).toBe(0)
    current.r.dispose()
    for (let round = 1; round <= 3; round++) {
      current = f.make()
      session = await pair(current.r)
      p = await prepare(current.r, session)
      const [a, b] = await Promise.all([
        approveClaim(current.r, session, p),
        current.r.claimPlan(session.sessionId, session.sessionToken, {
          protocol: 1,
          callId: p.callId
        })
      ])
      expect(a.status).toBe('ready')
      expect(['pending', 'ready']).toContain(b.status)
      expect(f.store().find(binding, context)?.value.correctionRoundsUsed).toBe(round)
      current.r.dispose()
      if (round < 3) f.advance(120_001)
    }
    f.advance(120_001)
    const fourth = f.make(),
      s = await pair(fourth.r)
    await expect(prepare(fourth.r, s)).rejects.toMatchObject({ code: 'DENIED' })
  })
  it('revokes checkpoints before they have been rehydrated, then refuses them in a third runtime', async () => {
    const f = setup()
    f.store().save(record())
    const revoked = f.make()
    revoked.r.revokePlugin(binding.pluginId)
    revoked.r.dispose()
    const later = f.make(),
      s = await pair(later.r)
    await expect(prepare(later.r, s)).rejects.toMatchObject({ code: 'EXPIRED' })
    expect(f.store().find(binding, context)).toBeUndefined()
  })
  it('refuses a grant when the saved budget is removed or changed after preview', async () => {
    for (const fault of ['deleted', 'spent']) {
      const f = setup(),
        store = f.store()
      store.save(record())
      const current = f.make(),
        s = await pair(current.r),
        p = await prepare(current.r, s)
      if (fault === 'deleted') store.removeWhere(() => true)
      else store.consume(store.find(binding, context)!, 1)
      await expect(approveClaim(current.r, s, p)).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
      expect(current.r.listPlanStatuses()[0].state).toBe('approved')
      expect(current.r.listPlanStatuses()[0].recoveryConsumed).toBe(false)
      current.r.dispose()
    }
  })
  it('never accepts an unsaved checkpoint when encryption fails', async () => {
    const f = setup(),
      current = f.make()
    const spy = vi.spyOn(FigPluginCheckpointStore.prototype, 'save').mockImplementation(() => {
      throw new Error('OWNED_STORE_FAILURE')
    })
    try {
      await expect(accept(current.r)).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
      expect(current.r.listVisualBaselines()).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
  it('does not reload a changed native instance, expired result, or unrelated selection', async () => {
    const f = setup()
    f.store().save(record())
    const current = f.make(),
      s = await pair(current.r)
    for (const change of [{ recoveryIdentity: 'f'.repeat(32) }, { documentId: 'another-document' }])
      await expect(
        current.r.prepareTaskRecovery(s.sessionId, s.sessionToken, {
          ...input(),
          hostContext: { ...input().hostContext, ...change }
        })
      ).rejects.toThrow()
    f.advance(86400001)
    const next = f.make(),
      fresh = await pair(next.r)
    await expect(prepare(next.r, fresh)).rejects.toMatchObject({ code: 'EXPIRED' })
    expect(next.invoke).not.toHaveBeenCalled()
  })
})
