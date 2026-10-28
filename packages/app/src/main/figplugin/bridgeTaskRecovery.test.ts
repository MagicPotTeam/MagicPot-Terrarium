import { describe, expect, it, vi } from 'vitest'
import type {
  FigPluginBridgePrepareRequest,
  FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import { createHostPlanReadback, type HostContext, type HostPlan } from '@shared/figplugin/hostPlan'
import { createHostPlanningPreview } from '@shared/figplugin/hostPlanPreview'
import type { FigPluginExecutionAuditEvent } from './executionAudit'
import { FigPluginBridgeRuntime } from './bridgeRuntime'

const binding: FigPluginRuntimeBinding = {
  pluginId: 'owned.figma',
  host: 'figma',
  generation: 1,
  artifactSha256: 'a'.repeat(64),
  signerFingerprint: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:41234',
  projectId: 'project_1',
  profileId: 'profile_1',
  profileRevision: 'd'.repeat(64)
}
const captureId = 'e'.repeat(32)
const context: HostContext = {
  version: 1,
  recoveryIdentity: 'a'.repeat(32),
  host: 'figma',
  documentId: 'document_1',
  scopeId: 'page_1',
  captureId,
  nodes: [
    {
      id: 'node_1',
      type: 'FRAME',
      name: 'Old name',
      parentId: 'page_1',
      ancestors: [{ id: 'page_1', type: 'PAGE', locked: false }],
      locked: false,
      visible: true,
      opacity: 1,
      commands: ['node.rename', 'node.opacity', 'node.visibility'],
      children: []
    }
  ],
  selectedIds: ['node_1'],
  execution: {
    mode: 'native-write',
    adapterVersion: 'figma-native-1',
    supports: ['node.rename', 'node.opacity', 'node.visibility'],
    rollback: 'verified-in-place',
    visualAudit: 'unavailable'
  }
}
const plan: HostPlan = {
  schemaVersion: 2,
  kind: 'host-plan',
  captureId,
  steps: [{ command: 'node.rename', targetId: 'node_1', name: 'New name' }]
}
const hashOnlyContext: HostContext = {
  ...context,
  execution: {
    ...context.execution!,
    visualAudit: 'hash-only'
  }
}
const visualEvidence = [
  {
    targetId: 'node_1',
    before: { sha256: '1'.repeat(64), width: 64, height: 32 },
    after: { sha256: '2'.repeat(64), width: 64, height: 32 },
    changed: true
  }
]
const prepareRequest = (hostContext: HostContext = context): FigPluginBridgePrepareRequest => ({
  protocol: 1,
  requestId: 'request_1',
  sequence: 1,
  prompt: 'Rename the selected layer.',
  context: {
    selectionRevision: captureId,
    nodes: [{ id: 'node_1', type: 'FRAME', name: 'Old name', locked: false }]
  },
  featureId: 'plan-preview',
  hostContext
})
const pairRequest = {
  protocol: 1 as const,
  ticketId: '1'.repeat(32),
  pairingSecret: '2'.repeat(64),
  pluginId: binding.pluginId,
  host: binding.host,
  artifactSha256: binding.artifactSha256,
  clientNonce: '3'.repeat(32)
}

const fixture = (allowNativeWrite = true, hostContext: HostContext = context) => {
  let now = 1_900_000_000_000
  const audit: FigPluginExecutionAuditEvent[] = []
  const invoke = vi.fn(async () => ({
    content: JSON.stringify(createHostPlanningPreview(JSON.stringify(plan), hostContext))
  }))
  const runtime = new FigPluginBridgeRuntime({
    validateBinding: async () => true,
    invoke,
    allowNativeWrite: () => allowNativeWrite,
    audit: (event) => audit.push(event),
    now: () => now
  })
  return {
    runtime,
    invoke,
    audit,
    hostContext,
    advance: (milliseconds: number) => {
      now += milliseconds
    }
  }
}

async function prepared(value: ReturnType<typeof fixture>) {
  const ticket = await value.runtime.createPairing(binding)
  const session = await value.runtime.redeem({
    ...pairRequest,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret
  })
  const receipt = await value.runtime.prepare(
    session.sessionId,
    session.sessionToken,
    prepareRequest(value.hostContext)
  )
  const preview = value.runtime.listPreviews()[0]
  await value.runtime.approve(receipt.callId, preview.payloadSha256)
  let last: Awaited<ReturnType<FigPluginBridgeRuntime['status']>> | undefined
  for (let index = 0; index < 20; index += 1) {
    last = await value.runtime.status(session.sessionId, session.sessionToken, receipt.callId)
    if (last.status === 'completed') break
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  expect(last?.status).toBe('completed')
  return { session, receipt }
}

async function completedVisualExecution(
  value: ReturnType<typeof fixture>,
  evidence = visualEvidence
) {
  const { session, receipt } = await prepared(value)
  const execution = value.runtime
    .listPlanExecutions()
    .find((item) => item.callId === receipt.callId)
  if (!execution) throw new Error('missing execution')
  await value.runtime.approvePlan(execution.executionId, execution.planSha256)
  const claimed = await value.runtime.claimPlan(session.sessionId, session.sessionToken, {
    protocol: 1,
    callId: receipt.callId
  })
  if (claimed.status !== 'ready') throw new Error('not claimed')
  const before = structuredClone(value.hostContext)
  const after: HostContext = {
    ...structuredClone(before),
    nodes: before.nodes.map((node) => ({ ...node, name: 'New name' }))
  }
  const result = value.runtime.planResult(session.sessionId, session.sessionToken, {
    protocol: 1,
    executionId: execution.executionId,
    actionId: claimed.intent.actionId,
    status: 'completed',
    effect: 'applied',
    completed: 1,
    total: 1,
    readback: createHostPlanReadback(before, after, plan),
    visualEvidence: evidence
  })
  return { session, receipt, execution, result }
}

async function accepted() {
  const f = fixture(true, hashOnlyContext),
    source = await completedVisualExecution(f)
  const baseline = await f.runtime.acceptVisualBaseline(
    source.execution.executionId,
    source.result.status.visualEvidenceSha256!
  )
  const input = (serial = 2, name = 'User changed') => ({
    protocol: 1,
    requestId: serial.toString(16).padStart(32, '0'),
    sequence: serial,
    hostContext: {
      ...structuredClone(hashOnlyContext),
      captureId: serial.toString(16).padStart(32, '0'),
      nodes: hashOnlyContext.nodes.map((node) => ({ ...node, name, opacity: 0.2 }))
    }
  })
  const prepare = (request: unknown = input()) =>
    f.runtime.prepareTaskRecovery(source.session.sessionId, source.session.sessionToken, request)
  return { ...f, source, baseline, input, prepare }
}
const requirePrepared = (
  response: Awaited<ReturnType<FigPluginBridgeRuntime['prepareTaskRecovery']>>
) => {
  if (response.status !== 'prepared') throw new Error('not prepared')
  return response
}
async function claim(
  f: Awaited<ReturnType<typeof accepted>>,
  response: ReturnType<typeof requirePrepared>
) {
  const preview = f.runtime
    .listPlanExecutions()
    .find((item) => item.executionId === response.executionId)!
  await f.runtime.approvePlan(preview.executionId, preview.planSha256)
  return f.runtime.claimPlan(f.source.session.sessionId, f.source.session.sessionToken, {
    protocol: 1,
    callId: response.callId,
    executionId: response.executionId
  })
}
describe('direct task recovery through production runtime', () => {
  it('prepares without a new model response or drift execution, requires fresh write approval, and verifies restored values', async () => {
    const f = await accepted()
    try {
      const response = requirePrepared(await f.prepare()),
        request = f.input()
      expect(f.invoke).toHaveBeenCalledTimes(1)
      expect(f.runtime.listPreviews()).toEqual([])
      const preview = f.runtime
        .listPlanExecutions()
        .find((item) => item.executionId === response.executionId)!
      expect(preview).toMatchObject({
        state: 'awaiting-approval',
        recovery: { baselineId: f.baseline.baselineId, round: 1 }
      })
      expect(preview.differences).toEqual([
        { targetId: 'node_1', command: 'node.rename', before: 'User changed', after: 'New name' }
      ])
      const pending = await f.runtime.claimPlan(
        f.source.session.sessionId,
        f.source.session.sessionToken,
        { protocol: 1, callId: response.callId }
      )
      expect(pending.status).toBe('pending')
      expect(f.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(0)
      const intent = await claim(f, response)
      if (intent.status !== 'ready') throw new Error('missing intent')
      expect(intent.intent.recovery?.baselineId).toBe(f.baseline.baselineId)
      const after = structuredClone(request.hostContext)
      after.nodes[0].name = 'New name'
      const result = f.runtime.planResult(
        f.source.session.sessionId,
        f.source.session.sessionToken,
        {
          protocol: 1,
          executionId: response.executionId,
          actionId: intent.intent.actionId,
          status: 'completed',
          effect: 'applied',
          completed: 1,
          total: 1,
          readback: createHostPlanReadback(request.hostContext, after, intent.intent.plan),
          visualEvidence
        }
      )
      expect(result.status).toMatchObject({
        state: 'completed',
        recoveryConsumed: true,
        visualBaselineComparison: { exactMatch: true }
      })
      expect(f.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(1)
      expect(f.audit.at(-1)?.taskRecovery).toMatchObject({ round: 1, consumed: true })
      expect(JSON.stringify(f.audit.at(-1))).not.toContain('User changed')
      await expect(
        f.runtime.acceptVisualBaseline(response.executionId, result.status.visualEvidenceSha256!)
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    } finally {
      f.runtime.dispose()
    }
  })
  it('coalesces identical prepare and repeated claim without duplicate actions or budget consumption', async () => {
    const f = await accepted()
    try {
      const [a, b] = await Promise.all([f.prepare(), f.prepare()])
      expect(a).toEqual(b)
      const response = requirePrepared(a)
      const first = await claim(f, response)
      const again = await f.runtime.claimPlan(
        f.source.session.sessionId,
        f.source.session.sessionToken,
        { protocol: 1, callId: response.callId }
      )
      expect(again).toEqual(first)
      expect(f.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(1)
      await expect(f.prepare(f.input(2, 'different replay'))).rejects.toMatchObject({
        code: 'INVALID_REQUEST'
      })
      await expect(f.prepare(f.input(3))).rejects.toMatchObject({ code: 'BUSY' })
    } finally {
      f.runtime.dispose()
    }
  })
  it('does not write or consume a round for already-matching task properties', async () => {
    const f = await accepted()
    try {
      const response = await f.prepare(f.input(2, 'New name'))
      expect(response).toEqual({
        protocol: 1,
        status: 'unchanged',
        baselineId: f.baseline.baselineId
      })
      expect(await f.prepare(f.input(2, 'New name'))).toEqual(response)
      expect(f.runtime.listPlanExecutions()).toHaveLength(1)
      expect(f.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(0)
    } finally {
      f.runtime.dispose()
    }
  })
  it('survives original request expiry and explicit re-pairing without restoring the old grant', async () => {
    const f = await accepted()
    try {
      f.runtime.closeSession(f.source.session.sessionId, f.source.session.sessionToken)
      f.advance(180_000)
      const ticket = await f.runtime.createPairing(binding)
      const session = await f.runtime.redeem({
        ...pairRequest,
        ticketId: ticket.ticketId,
        pairingSecret: ticket.pairingSecret
      })
      const request = f.input(1)
      const response = await f.runtime.prepareTaskRecovery(
        session.sessionId,
        session.sessionToken,
        request
      )
      expect(response.status).toBe('prepared')
      expect(f.invoke).toHaveBeenCalledTimes(1)
      expect(f.runtime.listPlanExecutions()[0].state).toBe('awaiting-approval')
    } finally {
      f.runtime.dispose()
    }
  })
  it('does not restore without an accepted checkpoint or across a different binding', async () => {
    const f = await accepted()
    try {
      const ticket = await f.runtime.createPairing({ ...binding, projectId: 'other-project' })
      const session = await f.runtime.redeem({
        ...pairRequest,
        ticketId: ticket.ticketId,
        pairingSecret: ticket.pairingSecret
      })
      await expect(
        f.runtime.prepareTaskRecovery(session.sessionId, session.sessionToken, f.input())
      ).rejects.toMatchObject({ code: 'EXPIRED' })
      f.runtime.revokePlugin(binding.pluginId)
      await expect(f.prepare()).rejects.toThrow()
    } finally {
      f.runtime.dispose()
    }
  })
  it('cancellation before claim spends no round; cancellation after claim cannot refund or exceed three rounds', async () => {
    const f = await accepted()
    try {
      const first = requirePrepared(await f.prepare())
      f.runtime.cancelPlan(first.executionId)
      expect(f.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(0)
      for (let round = 1; round <= 3; round++) {
        const response = requirePrepared(await f.prepare(f.input(round + 2)))
        const result = await claim(f, response)
        expect(result.status).toBe('ready')
        f.runtime.cancelPlan(response.executionId)
        expect(f.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(round)
        if (round < 3) {
          // Desktop cancellation is not a host-settlement receipt. Keep the document
          // excluded until the original grant and drain interval expire, then re-pair.
          f.advance(150_001)
          const ticket = await f.runtime.createPairing(binding)
          f.source.session = await f.runtime.redeem({
            ...pairRequest,
            ticketId: ticket.ticketId,
            pairingSecret: ticket.pairingSecret
          })
          expect(f.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(round)
        }
      }
      await expect(f.prepare(f.input(6))).rejects.toMatchObject({ code: 'DENIED' })
    } finally {
      f.runtime.dispose()
    }
  })
  it.each(['document', 'scope', 'target', 'lock', 'parent', 'adapter'])(
    'refuses changed %s with no write preview',
    async (change) => {
      const f = await accepted()
      try {
        const request = f.input()
        if (change === 'document') request.hostContext.documentId = 'other'
        if (change === 'scope') request.hostContext.scopeId = 'other'
        if (change === 'target') request.hostContext.selectedIds = ['missing']
        if (change === 'lock') request.hostContext.nodes[0].locked = true
        if (change === 'parent') request.hostContext.nodes[0].parentId = 'other'
        if (change === 'adapter') request.hostContext.execution!.adapterVersion = 'other'
        await expect(f.prepare(request)).rejects.toThrow()
        expect(f.runtime.listPlanExecutions()).toHaveLength(1)
        expect(f.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(0)
      } finally {
        f.runtime.dispose()
      }
    }
  )
  it('checkpoint replacement invalidates unclaimed recovery and cannot reset rounds by accepting its own result', async () => {
    const f = await accepted()
    try {
      const response = requirePrepared(await f.prepare())
      const next = await completedVisualExecution(f)
      await f.runtime.acceptVisualBaseline(
        next.execution.executionId,
        next.result.status.visualEvidenceSha256!
      )
      const result = await f.runtime.claimPlan(
        f.source.session.sessionId,
        f.source.session.sessionToken,
        { protocol: 1, callId: response.callId }
      )
      expect(result.status).toBe('terminal')
    } finally {
      f.runtime.dispose()
    }
  })
})

it('never marks recovery complete from an untruthful requested observation or missing restored value', async () => {
  for (const badValue of [undefined, 'Different value']) {
    const f = await accepted()
    try {
      const response = requirePrepared(await f.prepare())
      const claimed = await claim(f, response)
      if (claimed.status !== 'ready') throw new Error('not claimed')
      const request = f.input(),
        after = structuredClone(request.hostContext)
      after.nodes[0].name = 'New name'
      const readback = createHostPlanReadback(request.hostContext, after, claimed.intent.plan)
      if (badValue === undefined) delete readback.steps[0].value
      else readback.steps[0].value = badValue
      expect(() =>
        f.runtime.planResult(f.source.session.sessionId, f.source.session.sessionToken, {
          protocol: 1,
          executionId: response.executionId,
          actionId: claimed.intent.actionId,
          status: 'completed',
          effect: 'applied',
          completed: 1,
          total: 1,
          readback,
          visualEvidence
        })
      ).toThrow()
      expect(
        f.runtime.listPlanStatuses().find((item) => item.executionId === response.executionId)
          ?.state
      ).toBe('failed')
    } finally {
      f.runtime.dispose()
    }
  }
})
