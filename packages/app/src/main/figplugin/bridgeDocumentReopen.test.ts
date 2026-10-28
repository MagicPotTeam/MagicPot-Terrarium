import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostContext, HostPlan } from '@shared/figplugin/hostPlan'
import { createHostPlanReadback } from '@shared/figplugin/hostPlan'
import {
  captureTaskRecoveryScope,
  figPluginTaskRecoveryPrepareRequestSchema
} from '@shared/figplugin/taskRecovery'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { FigPluginCheckpointStore, type SavedCheckpoint } from './checkpointStore'
import { NOW, binding as baseBinding, hash, record, ownedCodec } from './checkpointTestUtils'
import { buildPlanExecutionApprovalDetails } from './bridgeApprovalDetails'
import type { FigPluginExecutionAuditEvent } from './executionAudit'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const roots: string[] = [],
  runtimes: FigPluginBridgeRuntime[] = []
afterEach(() => {
  for (const r of runtimes.splice(0)) r.dispose()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
const binding = { ...baseBinding, host: 'photoshop' as const, pluginId: 'owned.photoshop' }
const original: HostContext = {
  version: 1,
  host: 'photoshop',
  documentId: '101',
  scopeId: '101',
  captureId: '1'.repeat(32),
  recoveryIdentity: '2'.repeat(32),
  selectedIds: ['7'],
  nodes: [
    {
      id: '7',
      type: 'pixel',
      name: 'Original',
      parentId: '9',
      ancestors: [{ id: '9', type: 'group', locked: false }],
      locked: false,
      visible: true,
      opacity: 1,
      commands: ['node.rename', 'node.opacity', 'node.visibility']
    },
    {
      id: '9',
      type: 'group',
      name: 'Group',
      parentId: null,
      ancestors: [],
      locked: false,
      visible: true,
      commands: []
    }
  ],
  execution: {
    mode: 'native-write',
    adapterVersion: 'photoshop-uxp-native-1',
    supports: ['node.rename', 'node.opacity', 'node.visibility'],
    rollback: 'verified-in-place',
    visualAudit: 'hash-only'
  }
}
const plan: HostPlan = {
  schemaVersion: 2,
  kind: 'host-plan',
  captureId: original.captureId,
  steps: [{ command: 'node.rename', targetId: '7', name: 'Accepted owned name' }]
}
const evidence = [
  {
    targetId: '7',
    before: { sha256: '4'.repeat(64), width: 2, height: 1 },
    after: { sha256: '5'.repeat(64), width: 2, height: 1 },
    changed: true
  }
]
function savedCheckpoint(): SavedCheckpoint {
  const saved = record()
  saved.binding = structuredClone(binding)
  saved.recoveryPlan = structuredClone(plan)
  saved.recoveryScope = captureTaskRecoveryScope(plan, original) as SavedCheckpoint['recoveryScope']
  saved.value = {
    ...saved.value,
    host: 'photoshop',
    pluginId: binding.pluginId,
    documentId: original.documentId,
    scopeId: original.scopeId,
    captureId: original.captureId,
    planSha256: hash(plan),
    contextSha256: hash(original),
    adapterVersion: original.execution!.adapterVersion,
    visualEvidenceSha256: hash(evidence),
    targets: [{ targetId: '7', accepted: evidence[0].after }]
  }
  return saved
}
function setup() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mp-doc-reopen-'))
  roots.push(dir)
  const codec = ownedCodec()
  let now = NOW
  const store = () => new FigPluginCheckpointStore(dir, codec, () => now)
  const saved = savedCheckpoint()
  store().save(saved)
  const make = () => {
    const invoke = vi.fn(async () => {
      throw new Error('No provider in document recovery')
    })
    const audit: FigPluginExecutionAuditEvent[] = []
    const runtime = new FigPluginBridgeRuntime({
      validateBinding: async () => true,
      invoke,
      now: () => now,
      allowNativeWrite: () => true,
      checkpoints: store(),
      audit: (event) => audit.push(event)
    })
    runtimes.push(runtime)
    return { runtime, invoke, audit }
  }
  return {
    dir,
    store,
    saved,
    make,
    advance: (ms: number) => {
      now += ms
    }
  }
}
function request(documentId = '202', serial = 1, identity = 'e'.repeat(32)) {
  const captureId = serial.toString(16).padStart(32, '0')
  return {
    protocol: 1,
    requestId: captureId,
    sequence: serial,
    rebindBaselineId: record().value.baselineId,
    reopenDocument: true as const,
    hostContext: {
      ...structuredClone(original),
      documentId,
      scopeId: documentId,
      captureId,
      recoveryIdentity: identity,
      nodes: structuredClone(original.nodes).map((n) => ({
        ...n,
        ...(n.id === '7' ? { name: 'Later user edit', opacity: 0.25 } : {})
      }))
    }
  }
}
async function pair(runtime: FigPluginBridgeRuntime, changes: Partial<typeof binding> = {}) {
  const b = { ...binding, ...changes },
    ticket = await runtime.createPairing(b)
  return runtime.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: b.pluginId,
    host: b.host,
    artifactSha256: b.artifactSha256,
    clientNonce: '9'.repeat(32)
  })
}
async function prepare(
  runtime: FigPluginBridgeRuntime,
  session: Awaited<ReturnType<typeof pair>>,
  input = request()
) {
  const result = await runtime.prepareTaskRecovery(session.sessionId, session.sessionToken, input)
  if (result.status !== 'prepared') throw new Error('Expected a recovery preview')
  const preview = runtime
    .listPlanExecutions()
    .find((item) => item.executionId === result.executionId)!
  return {
    result,
    preview,
    claim: () =>
      runtime.claimPlan(session.sessionId, session.sessionToken, {
        protocol: 1,
        callId: result.callId
      })
  }
}

describe('explicit Photoshop document-root recovery after reopen', () => {
  it('keeps ordinary and plugin-only reassociation strict; document reassociation needs fresh high-risk consent', async () => {
    const f = setup(),
      m = f.make(),
      s = await pair(m.runtime),
      input = request()
    const { reopenDocument: _, ...pluginOnly } = input
    await expect(
      m.runtime.prepareTaskRecovery(s.sessionId, s.sessionToken, pluginOnly)
    ).rejects.toThrow()
    const p = await prepare(m.runtime, s, input)
    expect(p.preview).toMatchObject({
      risk: 'high',
      documentId: '202',
      scopeId: '202',
      recovery: {
        rebind: {
          previousIdentity: original.recoveryIdentity,
          nextIdentity: input.hostContext.recoveryIdentity,
          document: { host: 'photoshop', previousDocumentId: '101', nextDocumentId: '202' }
        }
      }
    })
    const details = buildPlanExecutionApprovalDetails(p.preview)
    expect(details).toContain('Previously accepted document ID: 101')
    expect(details).toContain('Currently selected document ID: 202')
    expect(details).toContain('NOT verified file identity')
    expect((await p.claim()).status).toBe('pending')
    await expect(
      m.runtime.approvePlan(p.preview.executionId, p.preview.planSha256)
    ).rejects.toMatchObject({ code: 'DENIED' })
    expect(f.store().find(binding, original)?.value.correctionRoundsUsed).toBe(0)
    expect(f.store().find(binding, input.hostContext)).toBeUndefined()
    expect(m.invoke).not.toHaveBeenCalled()
  })
  it('atomically moves only the document root, preserves TTL/values, consumes once and validates readback', async () => {
    const f = setup(),
      m = f.make(),
      s = await pair(m.runtime),
      input = request(),
      p = await prepare(m.runtime, s, input)
    await m.runtime.approvePlan(p.preview.executionId, p.preview.planSha256, true)
    const claimed = await p.claim()
    expect(await p.claim()).toEqual(claimed)
    if (claimed.status !== 'ready') throw new Error('No intent')
    const persisted = f.store().find(binding, input.hostContext)!
    expect(persisted.value).toMatchObject({
      baselineId: f.saved.value.baselineId,
      documentId: '202',
      scopeId: '202',
      correctionRoundsUsed: 1,
      expiresAt: f.saved.value.expiresAt,
      sourceExecutionId: f.saved.value.sourceExecutionId
    })
    expect(persisted.recoveryScope.anchors).toEqual(f.saved.recoveryScope.anchors)
    expect(persisted.recoveryPlan).toEqual(f.saved.recoveryPlan)
    expect(f.store().find(binding, original)).toBeUndefined()
    const after = structuredClone(input.hostContext)
    after.nodes[0].name = 'Accepted owned name'
    const result = m.runtime.planResult(s.sessionId, s.sessionToken, {
      protocol: 1,
      executionId: p.preview.executionId,
      actionId: claimed.intent.actionId,
      status: 'completed',
      effect: 'applied',
      completed: 1,
      total: 1,
      readback: createHostPlanReadback(input.hostContext, after, claimed.intent.plan),
      visualEvidence: evidence
    })
    expect(result.status).toMatchObject({
      state: 'completed',
      recoveryConsumed: true,
      visualBaselineComparison: { baselineId: f.saved.value.baselineId, exactMatch: true }
    })
    expect(after.nodes[0].opacity).toBe(0.25)
    expect(m.audit.at(-1)?.taskRecovery).toMatchObject({
      reassociationRequested: true,
      documentReassociationRequested: true,
      consumed: true
    })
    expect(JSON.stringify(m.audit)).not.toMatch(
      /Accepted owned name|Later user edit|previousIdentity|nextIdentity/
    )
    m.runtime.dispose()
    const next = f.make(),
      fresh = await pair(next.runtime, { profileRevision: 'f'.repeat(64) })
    const { reopenDocument: _, rebindBaselineId: __, ...ordinary } = request('202', 1)
    expect(
      await next.runtime.prepareTaskRecovery(fresh.sessionId, fresh.sessionToken, ordinary)
    ).toMatchObject({ status: 'prepared', recovery: { round: 2 } })
    expect(next.invoke).not.toHaveBeenCalled()
  })
  it.each(['deny', 'cancel'] as const)(
    '%s before claim leaves the accepted document and budget intact',
    async (action) => {
      const f = setup(),
        m = f.make(),
        s = await pair(m.runtime),
        p = await prepare(m.runtime, s)
      if (action === 'deny') m.runtime.denyPlan(p.preview.executionId)
      else m.runtime.cancelPlan(p.preview.executionId)
      expect((await p.claim()).status).toBe('terminal')
      expect(f.store().find(binding, original)?.value.correctionRoundsUsed).toBe(0)
      expect(f.store().find(binding, request().hostContext)).toBeUndefined()
    }
  )
  it.each([
    'layer',
    'type',
    'parent',
    'ancestor',
    'locked',
    'ancestor-locked',
    'adapter',
    'scope',
    'same-instance',
    'non-numeric-doc'
  ] as const)('refuses %s changes instead of guessing the reopened document', async (kind) => {
    const f = setup(),
      m = f.make(),
      s = await pair(m.runtime),
      input = request()
    if (kind === 'layer') {
      input.hostContext.nodes[0].id = '8'
      input.hostContext.selectedIds = ['8']
    }
    if (kind === 'type') input.hostContext.nodes[0].type = 'textLayer'
    if (kind === 'parent') input.hostContext.nodes[0].parentId = null
    if (kind === 'ancestor') input.hostContext.nodes[0].ancestors = []
    if (kind === 'locked') input.hostContext.nodes[0].locked = true
    if (kind === 'ancestor-locked') {
      input.hostContext.nodes[0].ancestors[0].locked = true
      input.hostContext.nodes[1].locked = true
    }
    if (kind === 'adapter') input.hostContext.execution!.adapterVersion = 'unknown'
    if (kind === 'scope') input.hostContext.scopeId = '303'
    if (kind === 'same-instance') input.hostContext.recoveryIdentity = original.recoveryIdentity!
    if (kind === 'non-numeric-doc') {
      input.hostContext.documentId = 'other'
      input.hostContext.scopeId = 'other'
    }
    await expect(prepare(m.runtime, s, input)).rejects.toThrow()
    expect(m.runtime.listPlanExecutions()).toEqual([])
    expect(f.store().find(binding, original)?.value.correctionRoundsUsed).toBe(0)
  })
  it('leaves an already matching result unmodified and unassociated', async () => {
    const f = setup(),
      m = f.make(),
      s = await pair(m.runtime),
      input = request()
    input.hostContext.nodes[0].name = 'Accepted owned name'
    expect(await m.runtime.prepareTaskRecovery(s.sessionId, s.sessionToken, input)).toMatchObject({
      status: 'unchanged'
    })
    expect(f.store().find(binding, original)?.value.correctionRoundsUsed).toBe(0)
    expect(f.store().find(binding, input.hostContext)).toBeUndefined()
  })
  it('only one independently approved competing document claim can consume the original checkpoint', async () => {
    const f = setup(),
      a = f.make(),
      b = f.make(),
      sa = await pair(a.runtime),
      sb = await pair(b.runtime)
    const pa = await prepare(a.runtime, sa, request()),
      pb = await prepare(b.runtime, sb, request('303', 1, 'f'.repeat(32)))
    await a.runtime.approvePlan(pa.preview.executionId, pa.preview.planSha256, true)
    await b.runtime.approvePlan(pb.preview.executionId, pb.preview.planSha256, true)
    const results = await Promise.allSettled([pa.claim(), pb.claim()])
    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value.status === 'ready')
    ).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(f.store().listSummaries()).toEqual([
      expect.objectContaining({ correctionRoundsUsed: 1 })
    ])
  })
  it('refuses a destination already containing another accepted checkpoint without losing either', async () => {
    const f = setup(),
      other = savedCheckpoint()
    other.value = {
      ...other.value,
      baselineId: 'a'.repeat(32),
      sourceExecutionId: 'b'.repeat(32),
      documentId: '202',
      scopeId: '202'
    }
    other.recoveryScope = {
      ...other.recoveryScope,
      documentId: '202',
      scopeId: '202',
      recoveryIdentity: 'f'.repeat(32)
    }
    f.store().save(other)
    const m = f.make(),
      s = await pair(m.runtime),
      p = await prepare(m.runtime, s)
    await m.runtime.approvePlan(p.preview.executionId, p.preview.planSha256, true)
    await expect(p.claim()).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    expect(f.store().listSummaries()).toHaveLength(2)
    expect(
      f
        .store()
        .listSummaries()
        .every((row) => row.correctionRoundsUsed === 0)
    ).toBe(true)
    expect(m.runtime.listPlanStatuses()[0].recoveryConsumed).toBe(false)
  })
  it('never resets the shared three-round budget on a later document reopen', async () => {
    const f = setup()
    for (let round = 1; round <= 3; round++) {
      const m = f.make(),
        s = await pair(m.runtime),
        p = await prepare(
          m.runtime,
          s,
          request(String(200 + round), 1, String(round + 5).repeat(32))
        )
      expect(p.preview.recovery?.round).toBe(round)
      await m.runtime.approvePlan(p.preview.executionId, p.preview.planSha256, true)
      await p.claim()
      m.runtime.dispose()
      if (round < 3) f.advance(120_001)
    }
    f.advance(120_001)
    const m = f.make(),
      s = await pair(m.runtime)
    await expect(prepare(m.runtime, s, request('404', 1, 'a'.repeat(32)))).rejects.toMatchObject({
      code: 'DENIED'
    })
    expect(f.store().listSummaries()[0].correctionRoundsUsed).toBe(3)
  })
  it('cannot bypass a deleted checkpoint or failed encrypted commit after review', async () => {
    const f = setup(),
      m = f.make(),
      s = await pair(m.runtime),
      p = await prepare(m.runtime, s)
    await m.runtime.approvePlan(p.preview.executionId, p.preview.planSha256, true)
    f.store().removeWhere(() => true)
    await expect(p.claim()).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' })
    expect(m.runtime.listPlanStatuses()[0].recoveryConsumed).toBe(false)
  })
  it('requires a selected checkpoint and Photoshop-only opt-in at the shared schema boundary', () => {
    const input = request()
    for (const changed of [
      { ...input, rebindBaselineId: undefined },
      { ...input, reopenDocument: false },
      { ...input, hostContext: { ...input.hostContext, host: 'figma' } },
      { ...input, document: { previousDocumentId: '101', nextDocumentId: '202' } },
      { ...input, approved: true }
    ])
      expect(figPluginTaskRecoveryPrepareRequestSchema.safeParse(changed).success).toBe(false)
  })
})
