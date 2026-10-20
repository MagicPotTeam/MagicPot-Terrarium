import { describe, expect, it } from 'vitest'
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
const prepareRequest = (): FigPluginBridgePrepareRequest => ({
  protocol: 1,
  requestId: 'request_1',
  sequence: 1,
  prompt: 'Rename the selected layer.',
  context: {
    selectionRevision: captureId,
    nodes: [{ id: 'node_1', type: 'FRAME', name: 'Old name', locked: false }]
  },
  featureId: 'plan-preview',
  hostContext: context
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

const fixture = (allowNativeWrite = true) => {
  let now = 1_900_000_000_000
  const audit: FigPluginExecutionAuditEvent[] = []
  const runtime = new FigPluginBridgeRuntime({
    validateBinding: async () => true,
    invoke: async () =>
      ({
        content: JSON.stringify(createHostPlanningPreview(JSON.stringify(plan), context))
      }) as never,
    allowNativeWrite: () => allowNativeWrite,
    audit: (event) => audit.push(event),
    now: () => now
  })
  return {
    runtime,
    audit,
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
    prepareRequest()
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

describe('approved native-plan execution runtime', () => {
  it('binds write approval to the exact plan, claims once and verifies readback', async () => {
    const value = fixture()
    try {
      const { session, receipt } = await prepared(value)
      const execution = value.runtime.listPlanExecutions()[0]
      expect(execution).toMatchObject({
        callId: receipt.callId,
        host: 'figma',
        state: 'awaiting-approval',
        planSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
      await expect(
        value.runtime.approvePlan(execution.executionId, 'f'.repeat(64))
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      await value.runtime.approvePlan(execution.executionId, execution.planSha256)
      const claimRequest = { protocol: 1, callId: receipt.callId }
      const claimed = await value.runtime.claimPlan(
        session.sessionId,
        session.sessionToken,
        claimRequest
      )
      expect(claimed.status).toBe('ready')
      if (claimed.status !== 'ready') throw new Error('not claimed')
      expect(
        await value.runtime.claimPlan(session.sessionId, session.sessionToken, claimRequest)
      ).toEqual(claimed)
      value.runtime.planProgress(session.sessionId, session.sessionToken, {
        protocol: 1,
        executionId: execution.executionId,
        actionId: claimed.intent.actionId,
        sequence: 2,
        phase: 'executing',
        index: 0,
        completed: 1,
        total: 1,
        effect: 'applied',
        at: value.audit.at(-1)?.at ?? 0
      })
      const after: HostContext = {
        ...context,
        nodes: context.nodes.map((node) => ({ ...node, name: 'New name' }))
      }
      const result = value.runtime.planResult(session.sessionId, session.sessionToken, {
        protocol: 1,
        executionId: execution.executionId,
        actionId: claimed.intent.actionId,
        status: 'completed',
        effect: 'applied',
        completed: 1,
        total: 1,
        readback: createHostPlanReadback(context, after, plan)
      })
      expect(result.status).toMatchObject({
        state: 'completed',
        effect: 'applied',
        completed: 1
      })
      expect(value.audit.map((event) => event.state)).toEqual(
        expect.arrayContaining([
          'awaiting-approval',
          'approved',
          'claimed',
          'executing',
          'completed'
        ])
      )
      expect(JSON.stringify(value.audit)).not.toMatch(/Old name|New name/)
    } finally {
      value.runtime.dispose()
    }
  })

  it('rejects native execution contexts when the signed package lacks result-transfer', async () => {
    const value = fixture(false)
    try {
      const ticket = await value.runtime.createPairing(binding)
      const session = await value.runtime.redeem({
        ...pairRequest,
        ticketId: ticket.ticketId,
        pairingSecret: ticket.pairingSecret
      })
      await expect(
        value.runtime.prepare(session.sessionId, session.sessionToken, prepareRequest())
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(value.runtime.listPlanExecutions()).toEqual([])
    } finally {
      value.runtime.dispose()
    }
  })

  it('quarantines a false applied readback instead of accepting the host claim', async () => {
    const value = fixture()
    try {
      const { session, receipt } = await prepared(value)
      const execution = value.runtime.listPlanExecutions()[0]
      await value.runtime.approvePlan(execution.executionId, execution.planSha256)
      const claimed = await value.runtime.claimPlan(session.sessionId, session.sessionToken, {
        protocol: 1,
        callId: receipt.callId
      })
      if (claimed.status !== 'ready') throw new Error('not claimed')
      expect(() =>
        value.runtime.planResult(session.sessionId, session.sessionToken, {
          protocol: 1,
          executionId: execution.executionId,
          actionId: claimed.intent.actionId,
          status: 'completed',
          effect: 'applied',
          completed: 1,
          total: 1,
          readback: createHostPlanReadback(context, context, plan)
        })
      ).toThrow()
      expect(value.runtime.listPlanStatuses()[0]).toMatchObject({
        state: 'failed',
        effect: 'unknown',
        errorCode: 'QUARANTINED'
      })
      expect(value.audit.at(-1)).toMatchObject({
        state: 'failed',
        effect: 'unknown',
        errorCode: 'QUARANTINED'
      })
      expect(JSON.stringify(value.audit)).not.toMatch(/Old name|New name/)
    } finally {
      value.runtime.dispose()
    }
  })
})
