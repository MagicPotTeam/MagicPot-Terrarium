import { describe, expect, it } from 'vitest'
import type {
  FigPluginBridgePrepareRequest,
  FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_VISUAL_BASELINE_TTL_MS,
  FIGPLUGIN_VISUAL_CORRECTION_AUTHORIZATION_TTL_MS,
  FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS
} from '../../shared/figplugin/execution'
import { createHostPlanReadback, type HostContext, type HostPlan } from '@shared/figplugin/hostPlan'
import { createHostPlanningPreview } from '@shared/figplugin/hostPlanPreview'
import { figPluginExecutionAuditEventSchema } from '@shared/figplugin/executionAudit'
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
const twoStepPlan: HostPlan = {
  ...plan,
  steps: [...plan.steps, { command: 'node.opacity', targetId: 'node_1', opacity: 0.5 }]
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

const fixture = (
  allowNativeWrite = true,
  hostContext: HostContext = context,
  validateBinding = async () => true,
  hostPlan: HostPlan = plan
) => {
  let now = 1_900_000_000_000
  let nativeWriteAllowed = allowNativeWrite
  const audit: FigPluginExecutionAuditEvent[] = []
  const runtime = new FigPluginBridgeRuntime({
    validateBinding,
    invoke: async () =>
      ({
        content: JSON.stringify(createHostPlanningPreview(JSON.stringify(hostPlan), hostContext))
      }) as never,
    allowNativeWrite: () => nativeWriteAllowed,
    audit: (event) => audit.push(event),
    now: () => now
  })
  return {
    runtime,
    audit,
    hostContext,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    setNativeWriteAllowed: (allowed: boolean) => {
      nativeWriteAllowed = allowed
    }
  }
}

async function paired(value: ReturnType<typeof fixture>) {
  const ticket = await value.runtime.createPairing(binding)
  return value.runtime.redeem({
    ...pairRequest,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret
  })
}

async function prepared(value: ReturnType<typeof fixture>) {
  const session = await paired(value)
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

describe.each(['awaiting-approval', 'claimed', 'readback'] as const)(
  'ordinary %s plan lifetime audit',
  (phase) => {
    it.each(['close', 'revoke', 'configuration', 'expiry', 'call-expiry', 'dispose'] as const)(
      'records one terminal event before parent cleanup (%s)',
      async (ending) => {
        const value = fixture()
        try {
          const { session, receipt } = await prepared(value)
          const execution = value.runtime.listPlanExecutions()[0]
          if (phase !== 'awaiting-approval') {
            await value.runtime.approvePlan(execution.executionId, execution.planSha256)
            const claimed = await value.runtime.claimPlan(session.sessionId, session.sessionToken, {
              protocol: 1,
              callId: receipt.callId
            })
            expect(claimed.status).toBe('ready')
          }
          if (phase === 'readback')
            value.runtime.planProgress(session.sessionId, session.sessionToken, {
              protocol: 1,
              executionId: execution.executionId,
              actionId: execution.executionId,
              sequence: 2,
              phase: 'readback',
              index: 0,
              completed: 0,
              total: 1,
              effect: 'partial',
              at: value.audit.at(-1)!.at
            })
          const before = value.audit.length
          if (ending === 'close')
            value.runtime.closeSession(session.sessionId, session.sessionToken)
          if (ending === 'revoke') value.runtime.revokePlugin(binding.pluginId)
          if (ending === 'configuration') value.runtime.revokeInvalidBindings(() => false)
          if (ending === 'call-expiry') {
            value.advance(119_000)
            await value.runtime.status(session.sessionId, session.sessionToken, receipt.callId)
            value.advance(1_001)
            expect(value.runtime.listSessions()).toHaveLength(1)
          }
          if (ending === 'expiry') value.advance(120_001)
          if (ending === 'dispose') value.runtime.dispose()
          else expect(value.runtime.listPlanExecutions()).toEqual([])
          const terminal = value.audit.slice(before)
          expect(terminal).toHaveLength(1)
          const expired = ending === 'expiry' || ending === 'call-expiry'
          expect(terminal[0]).toMatchObject({
            executionId: execution.executionId,
            state: expired ? 'expired' : 'cancelled',
            errorCode: expired
              ? 'EXPIRED'
              : ending === 'revoke' || ending === 'configuration'
                ? 'HOST_UNAVAILABLE'
                : 'CANCELLED',
            effect: phase === 'readback' ? 'partial' : 'none'
          })
          expect(figPluginExecutionAuditEventSchema.safeParse(terminal[0]).success).toBe(true)
          expect(JSON.stringify(terminal)).not.toMatch(/Old name|New name/)
          value.runtime.dispose()
          expect(value.audit.slice(before)).toEqual(terminal)
        } finally {
          value.runtime.dispose()
        }
      }
    )
  }
)

it('emits bounded audit lineage for an execution', async () => {
  const value = fixture()
  try {
    const { receipt } = await prepared(value)
    const executionId = value.audit[0].executionId
    const events = value.audit.filter((event) => event.executionId === executionId)
    expect(events.length).toBeGreaterThan(0)
    const correlationIds = new Set(events.map((event) => event.correlationId))
    expect(correlationIds).toHaveLength(1)
    const correlationId = [...correlationIds][0]
    expect(correlationId).toMatch(/^[a-f0-9]{32}$/)
    expect(correlationId).not.toBe(receipt.callId)
    expect(new Set(events.map((event) => event.runId))).toEqual(new Set([executionId]))
    expect(events.map((event) => event.sequence)).toEqual([1])
    expect(
      events.every((event) => figPluginExecutionAuditEventSchema.safeParse(event).success)
    ).toBe(true)
  } finally {
    value.runtime.dispose()
  }
})

it('audits idle-session expiry even before the ordinary plan preview expires', async () => {
  let validate = () => {}
  const value = fixture(true, context, async () => {
    validate()
    return true
  })
  try {
    const session = await paired(value)
    // A pending binding check can outlive the last host activity without refreshing idle TTL.
    validate = () => value.advance(10_000)
    const receipt = await value.runtime.prepare(
      session.sessionId,
      session.sessionToken,
      prepareRequest()
    )
    validate = () => {}
    const preview = value.runtime.listPreviews()[0]
    await value.runtime.approve(receipt.callId, preview.payloadSha256)
    for (let index = 0; index < 20 && !value.runtime.listPlanExecutions().length; index++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const execution = value.runtime.listPlanExecutions()[0]
    expect(execution).toBeDefined()
    const before = value.audit.length
    value.advance(110_001)
    expect(value.runtime.listPlanExecutions()).toEqual([])
    const terminal = value.audit.slice(before)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({
      executionId: execution.executionId,
      state: 'expired',
      errorCode: 'EXPIRED'
    })
    expect(terminal[0].at).toBeLessThan(execution.expiresAt)
  } finally {
    value.runtime.dispose()
  }
})

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

it('does not rewrite or duplicate a verified terminal audit during parent teardown', async () => {
  const value = fixture(true, hashOnlyContext)
  try {
    const { session } = await completedVisualExecution(value)
    const before = [...value.audit]
    expect(before.at(-1)).toMatchObject({ state: 'completed', effect: 'applied' })
    value.runtime.closeSession(session.sessionId, session.sessionToken)
    value.runtime.dispose()
    expect(value.audit).toEqual(before)
  } finally {
    value.runtime.dispose()
  }
})

// Use the production runtime throughout; only the model and native host observations are fixtures.
async function correctionFixture() {
  const value = fixture(true, hashOnlyContext)
  const first = await completedVisualExecution(value)
  const baseline = await value.runtime.acceptVisualBaseline(
    first.execution.executionId,
    first.result.status.visualEvidenceSha256!
  )
  const drift = [
    { ...visualEvidence[0], after: { ...visualEvidence[0].after, sha256: '3'.repeat(64) } }
  ]
  const changed = await completedVisualExecution(value, drift)
  return { ...value, baseline, changed, drift }
}
async function prepareCorrectionFixture(
  value: Awaited<ReturnType<typeof correctionFixture>>,
  source = value.changed.result.status
) {
  const authorization = await value.runtime.authorizeVisualCorrection(
    source.executionId,
    value.baseline.baselineId,
    source.visualEvidenceSha256!
  )
  const context: HostContext = {
    ...structuredClone(hashOnlyContext),
    captureId: authorization.authorizationId,
    nodes: hashOnlyContext.nodes.map((node) => ({ ...node, name: 'Drifted name' }))
  }
  const input = { protocol: 1, sourceExecutionId: source.executionId, hostContext: context }
  const { session } = value.changed
  const prepare = () =>
    value.runtime.prepareVisualCorrection(session.sessionId, session.sessionToken, input)
  const result = await prepare()
  if (result.status !== 'prepared') throw new Error('missing correction execution')
  const preview = value.runtime
    .listPlanExecutions()
    .find((item) => item.executionId === result.executionId)!
  const selector = {
    protocol: 1,
    callId: value.changed.receipt.callId,
    executionId: result.executionId
  }
  const claim = () => value.runtime.claimPlan(session.sessionId, session.sessionToken, selector)
  return { authorization, context, input, prepare, result, preview, selector, claim }
}
function finishCorrectionFixture(
  value: Awaited<ReturnType<typeof correctionFixture>>,
  correction: Awaited<ReturnType<typeof prepareCorrectionFixture>>,
  intent: import('@shared/figplugin/execution').FigPluginExecutionIntent,
  hash = '3'.repeat(64)
) {
  const after = {
    ...structuredClone(correction.context),
    nodes: correction.context.nodes.map((node) => ({ ...node, name: 'New name' }))
  }
  const evidence = [
    {
      targetId: 'node_1',
      before: value.drift[0].after,
      after: { ...visualEvidence[0].after, sha256: hash },
      changed: hash !== value.drift[0].after.sha256
    }
  ]
  return value.runtime.planResult(
    value.changed.session.sessionId,
    value.changed.session.sessionToken,
    {
      protocol: 1,
      executionId: correction.preview.executionId,
      actionId: intent.actionId,
      status: 'completed',
      effect: 'applied',
      completed: 1,
      total: 1,
      readback: createHostPlanReadback(correction.context, after, intent.plan),
      visualEvidence: evidence
    }
  ).status
}

describe('approved native-plan execution runtime', () => {
  it('returns a terminal denied claim when native write authority is revoked before claim', async () => {
    const value = fixture()
    try {
      const { session, receipt } = await prepared(value)
      const execution = value.runtime.listPlanExecutions()[0]
      await value.runtime.approvePlan(execution.executionId, execution.planSha256)
      value.setNativeWriteAllowed(false)

      const claim = await value.runtime.claimPlan(session.sessionId, session.sessionToken, {
        protocol: 1,
        callId: receipt.callId
      })
      expect(claim).toMatchObject({
        status: 'terminal',
        state: 'denied',
        errorCode: 'DENIED'
      })
      expect(value.runtime.listPlanStatuses()[0]).toMatchObject({
        state: 'denied',
        errorCode: 'DENIED'
      })
    } finally {
      value.runtime.dispose()
    }
  })

  it.each(['status', 'progress', 'result'] as const)(
    'blocks %s after an ordinary plan has been claimed when native write authority is revoked',
    async (operation) => {
      const value = fixture()
      try {
        const { session, receipt } = await prepared(value)
        const execution = value.runtime.listPlanExecutions()[0]
        await value.runtime.approvePlan(execution.executionId, execution.planSha256)
        const claim = await value.runtime.claimPlan(session.sessionId, session.sessionToken, {
          protocol: 1,
          callId: receipt.callId
        })
        if (claim.status !== 'ready') throw new Error('not claimed')
        value.setNativeWriteAllowed(false)
        const lineage = {
          requestId: claim.intent.requestId,
          runId: claim.intent.runId,
          correlationId: claim.intent.correlationId
        }

        if (operation === 'status') {
          await expect(
            value.runtime.planStatus(session.sessionId, session.sessionToken, {
              protocol: 1,
              callId: receipt.callId,
              executionId: execution.executionId,
              ...lineage
            })
          ).resolves.toMatchObject({ state: 'denied', errorCode: 'DENIED' })
        } else if (operation === 'progress') {
          expect(() =>
            value.runtime.planProgress(session.sessionId, session.sessionToken, {
              protocol: 1,
              executionId: execution.executionId,
              actionId: claim.intent.actionId,
              ...lineage,
              sequence: 2,
              phase: 'executing',
              index: 0,
              completed: 1,
              total: 1,
              effect: 'applied',
              at: value.audit.at(-1)?.at ?? 0
            })
          ).toThrowError(expect.objectContaining({ code: 'DENIED' }))
        } else {
          expect(() =>
            value.runtime.planResult(session.sessionId, session.sessionToken, {
              protocol: 1,
              executionId: execution.executionId,
              actionId: claim.intent.actionId,
              ...lineage,
              status: 'completed',
              effect: 'applied',
              completed: 1,
              total: 1,
              readback: createHostPlanReadback(
                context,
                { ...context, nodes: context.nodes.map((node) => ({ ...node, name: 'New name' })) },
                plan
              )
            })
          ).toThrowError(expect.objectContaining({ code: 'DENIED' }))
        }

        expect(value.runtime.listPlanStatuses()[0]).toMatchObject({
          state: 'denied',
          errorCode: 'DENIED',
          completed: 0,
          effect: 'none'
        })
      } finally {
        value.runtime.dispose()
      }
    }
  )

  it('rejects impossible result status/effect pairs before changing execution state', async () => {
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
      const readback = createHostPlanReadback(value.hostContext, value.hostContext, plan)
      const beforeStatus = value.runtime.listPlanStatuses()[0]
      const beforeAuditLength = value.audit.length
      const invalidResults = [
        { status: 'failed' as const, effect: 'applied' as const, completed: 1 },
        { status: 'cancelled' as const, effect: 'applied' as const, completed: 1 },
        { status: 'completed' as const, effect: 'partial' as const, completed: 0 }
      ]
      for (const invalid of invalidResults)
        expect(() =>
          value.runtime.planResult(session.sessionId, session.sessionToken, {
            protocol: 1,
            executionId: execution.executionId,
            actionId: claimed.intent.actionId,
            ...invalid,
            total: 1,
            readback
          })
        ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
      expect(value.runtime.listPlanStatuses()[0]).toEqual(beforeStatus)
      expect(value.audit).toHaveLength(beforeAuditLength)

      // The reservation is still held after rejected receipts: a valid no-op
      // terminal result can settle the same claimed execution exactly once.
      const settled = value.runtime.planResult(session.sessionId, session.sessionToken, {
        protocol: 1,
        executionId: execution.executionId,
        actionId: claimed.intent.actionId,
        status: 'failed',
        effect: 'none',
        completed: 0,
        total: 1,
        readback
      })
      expect(settled.status).toMatchObject({
        state: 'failed',
        effect: 'none',
        completed: 0,
        errorCode: 'EXECUTION_FAILED'
      })
    } finally {
      value.runtime.dispose()
    }
  })

  it('normalizes omitted cancellation errors at the terminal receipt boundary', async () => {
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

      const settled = value.runtime.planResult(session.sessionId, session.sessionToken, {
        protocol: 1,
        executionId: execution.executionId,
        actionId: claimed.intent.actionId,
        status: 'cancelled',
        effect: 'none',
        completed: 0,
        total: 1,
        readback: createHostPlanReadback(value.hostContext, value.hostContext, plan)
      })
      expect(settled.status).toMatchObject({
        state: 'cancelled',
        effect: 'none',
        errorCode: 'CANCELLED'
      })
      expect(value.audit.at(-1)).toMatchObject({
        state: 'cancelled',
        effect: 'none',
        errorCode: 'CANCELLED'
      })
    } finally {
      value.runtime.dispose()
    }
  })

  it('rejects progress phase regression and inconsistent executing indexes without mutating state', async () => {
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
      const base = {
        protocol: 1 as const,
        executionId: execution.executionId,
        actionId: claimed.intent.actionId,
        total: 1,
        effect: 'applied' as const,
        at: value.audit.at(-1)?.at ?? 0
      }
      expect(() =>
        value.runtime.planProgress(session.sessionId, session.sessionToken, {
          ...base,
          sequence: 3,
          phase: 'executing',
          index: 0,
          completed: 1
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
      expect(value.runtime.listPlanStatuses()[0]).toMatchObject({
        state: 'claimed',
        completed: 0
      })
      expect(() =>
        value.runtime.planProgress(session.sessionId, session.sessionToken, {
          ...base,
          sequence: 2,
          phase: 'executing',
          index: 1,
          completed: 1
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
      expect(value.runtime.listPlanStatuses()[0]).toMatchObject({
        state: 'claimed',
        completed: 0
      })
      const executing = {
        ...base,
        sequence: 2,
        phase: 'executing',
        index: 0,
        completed: 1
      } as const
      value.runtime.planProgress(session.sessionId, session.sessionToken, executing)
      expect(
        value.runtime.planProgress(session.sessionId, session.sessionToken, executing)
      ).toMatchObject({ state: 'executing', completed: 1 })
      expect(() =>
        value.runtime.planProgress(session.sessionId, session.sessionToken, {
          ...executing,
          sequence: 3,
          effect: 'partial'
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
      expect(() =>
        value.runtime.planProgress(session.sessionId, session.sessionToken, {
          ...base,
          sequence: 2,
          phase: 'claimed',
          completed: 0,
          effect: 'none'
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
      expect(value.runtime.listPlanStatuses()[0]).toMatchObject({
        state: 'executing',
        completed: 1
      })
    } finally {
      value.runtime.dispose()
    }
  })

  it('does not downgrade an executing effect at the same completion count', async () => {
    const value = fixture(true, context, async () => true, twoStepPlan)
    try {
      const { session, receipt } = await prepared(value)
      const execution = value.runtime.listPlanExecutions()[0]
      await value.runtime.approvePlan(execution.executionId, execution.planSha256)
      const claim = await value.runtime.claimPlan(session.sessionId, session.sessionToken, {
        protocol: 1,
        callId: receipt.callId
      })
      if (claim.status !== 'ready') throw new Error('not claimed')
      const first = {
        protocol: 1 as const,
        executionId: execution.executionId,
        actionId: claim.intent.actionId,
        sequence: 2,
        phase: 'executing' as const,
        index: 0,
        completed: 1,
        total: 2,
        effect: 'partial' as const,
        at: value.audit.at(-1)?.at ?? 0
      }
      value.runtime.planProgress(session.sessionId, session.sessionToken, first)
      expect(() =>
        value.runtime.planProgress(session.sessionId, session.sessionToken, {
          ...first,
          sequence: 3,
          effect: 'unknown'
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
      expect(value.runtime.listPlanStatuses()[0]).toMatchObject({
        state: 'executing',
        completed: 1,
        effect: 'partial'
      })
    } finally {
      value.runtime.dispose()
    }
  })

  it('binds progress and result retries to the claimed request lineage', async () => {
    const value = fixture()
    try {
      const { session, receipt } = await prepared(value)
      const execution = value.runtime.listPlanExecutions()[0]
      await value.runtime.approvePlan(execution.executionId, execution.planSha256)
      const claim = await value.runtime.claimPlan(session.sessionId, session.sessionToken, {
        protocol: 1,
        callId: receipt.callId
      })
      if (claim.status !== 'ready') throw new Error('not claimed')
      expect(claim.intent).toMatchObject({
        requestId: 'request_1',
        runId: execution.executionId,
        correlationId: expect.stringMatching(/^[a-f0-9]{32}$/)
      })
      const progress = {
        protocol: 1 as const,
        executionId: execution.executionId,
        actionId: claim.intent.actionId,
        requestId: claim.intent.requestId,
        runId: claim.intent.runId,
        correlationId: claim.intent.correlationId,
        sequence: 2,
        phase: 'executing' as const,
        index: 0,
        completed: 1,
        total: 1,
        effect: 'applied' as const,
        at: value.audit.at(-1)?.at ?? 0
      }
      expect(() =>
        value.runtime.planProgress(session.sessionId, session.sessionToken, {
          ...progress,
          correlationId: 'f'.repeat(32)
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
      expect(value.runtime.listPlanStatuses()[0]).toMatchObject({ state: 'claimed', completed: 0 })
      expect(value.runtime.listPlanStatuses()[0]).toMatchObject({
        requestId: claim.intent.requestId,
        runId: claim.intent.runId,
        correlationId: claim.intent.correlationId
      })
      value.runtime.planProgress(session.sessionId, session.sessionToken, progress)
      expect(
        value.runtime.planProgress(session.sessionId, session.sessionToken, progress)
      ).toMatchObject({
        state: 'executing',
        completed: 1
      })
      const result = {
        protocol: 1 as const,
        executionId: execution.executionId,
        actionId: claim.intent.actionId,
        requestId: claim.intent.requestId,
        runId: claim.intent.runId,
        correlationId: claim.intent.correlationId,
        status: 'completed' as const,
        effect: 'applied' as const,
        completed: 1,
        total: 1,
        readback: createHostPlanReadback(
          context,
          { ...context, nodes: context.nodes.map((node) => ({ ...node, name: 'New name' })) },
          plan
        )
      }
      expect(() =>
        value.runtime.planResult(session.sessionId, session.sessionToken, {
          ...result,
          runId: 'e'.repeat(32)
        })
      ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
      expect(value.runtime.listPlanStatuses()[0]).toMatchObject({ state: 'executing' })
      expect(
        value.runtime.planResult(session.sessionId, session.sessionToken, result).status
      ).toMatchObject({
        state: 'completed',
        effect: 'applied'
      })
    } finally {
      value.runtime.dispose()
    }
  })

  it('binds status polling to the claimed request lineage', async () => {
    const value = fixture()
    try {
      const { session, receipt } = await prepared(value)
      const execution = value.runtime.listPlanExecutions()[0]
      await value.runtime.approvePlan(execution.executionId, execution.planSha256)
      const claim = await value.runtime.claimPlan(session.sessionId, session.sessionToken, {
        protocol: 1,
        callId: receipt.callId
      })
      if (claim.status !== 'ready') throw new Error('not claimed')
      const lineage = {
        requestId: claim.intent.requestId,
        runId: claim.intent.runId,
        correlationId: claim.intent.correlationId
      }
      expect(
        await value.runtime.planStatus(session.sessionId, session.sessionToken, {
          protocol: 1,
          callId: receipt.callId,
          executionId: execution.executionId,
          ...lineage
        })
      ).toMatchObject({ state: 'claimed', ...lineage })
      await expect(
        value.runtime.planStatus(session.sessionId, session.sessionToken, {
          protocol: 1,
          callId: receipt.callId,
          executionId: execution.executionId,
          ...lineage,
          correlationId: 'f'.repeat(32)
        })
      ).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
      expect(value.runtime.listPlanStatuses()[0]).toMatchObject({ state: 'claimed', ...lineage })
    } finally {
      value.runtime.dispose()
    }
  })

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

  it('requires exact bounded visual checkpoints when the approved preview advertises hash-only audit', async () => {
    const missing = fixture(true, hashOnlyContext)
    try {
      const { session, receipt } = await prepared(missing)
      const execution = missing.runtime.listPlanExecutions()[0]
      await missing.runtime.approvePlan(execution.executionId, execution.planSha256)
      const claimed = await missing.runtime.claimPlan(session.sessionId, session.sessionToken, {
        protocol: 1,
        callId: receipt.callId
      })
      if (claimed.status !== 'ready') throw new Error('not claimed')
      const after: HostContext = {
        ...hashOnlyContext,
        nodes: hashOnlyContext.nodes.map((node) => ({ ...node, name: 'New name' }))
      }
      expect(() =>
        missing.runtime.planResult(session.sessionId, session.sessionToken, {
          protocol: 1,
          executionId: execution.executionId,
          actionId: claimed.intent.actionId,
          status: 'completed',
          effect: 'applied',
          completed: 1,
          total: 1,
          readback: createHostPlanReadback(hashOnlyContext, after, plan)
        })
      ).toThrow()
      expect(missing.runtime.listPlanStatuses()[0]).toMatchObject({
        state: 'failed',
        effect: 'unknown',
        errorCode: 'QUARANTINED'
      })
    } finally {
      missing.runtime.dispose()
    }

    const wrongTarget = fixture(true, hashOnlyContext)
    try {
      const { session, receipt } = await prepared(wrongTarget)
      const execution = wrongTarget.runtime.listPlanExecutions()[0]
      await wrongTarget.runtime.approvePlan(execution.executionId, execution.planSha256)
      const claimed = await wrongTarget.runtime.claimPlan(session.sessionId, session.sessionToken, {
        protocol: 1,
        callId: receipt.callId
      })
      if (claimed.status !== 'ready') throw new Error('not claimed')
      const after: HostContext = {
        ...hashOnlyContext,
        nodes: hashOnlyContext.nodes.map((node) => ({ ...node, name: 'New name' }))
      }
      expect(() =>
        wrongTarget.runtime.planResult(session.sessionId, session.sessionToken, {
          protocol: 1,
          executionId: execution.executionId,
          actionId: claimed.intent.actionId,
          status: 'completed',
          effect: 'applied',
          completed: 1,
          total: 1,
          readback: createHostPlanReadback(hashOnlyContext, after, plan),
          visualEvidence: [{ ...visualEvidence[0], targetId: 'node_foreign' }]
        })
      ).toThrow()
      expect(wrongTarget.runtime.listPlanStatuses()[0]).toMatchObject({
        state: 'failed',
        errorCode: 'QUARANTINED'
      })
    } finally {
      wrongTarget.runtime.dispose()
    }
  })

  it('stores and audits an exact bounded visual checkpoint set', async () => {
    const value = fixture(true, hashOnlyContext)
    try {
      const { result } = await completedVisualExecution(value)
      expect(result.status.visualEvidence).toEqual(visualEvidence)
      expect(result.status.visualEvidenceSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(value.runtime.listPlanStatuses()[0]).toMatchObject({
        visualEvidence,
        visualEvidenceSha256: result.status.visualEvidenceSha256
      })
      expect(value.audit.at(-1)).toMatchObject({
        state: 'completed',
        visualAudit: 'hash-only',
        visualEvidenceCount: 1,
        visualEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
      expect(JSON.stringify(value.audit)).not.toMatch(/Old name|New name/)
    } finally {
      value.runtime.dispose()
    }
  })

  it('accepts one exact user visual baseline, audits only hashes and enforces its bounded lifetime', async () => {
    const value = fixture(true, hashOnlyContext)
    try {
      const { execution, result } = await completedVisualExecution(value)
      const visualEvidenceSha256 = result.status.visualEvidenceSha256!
      await expect(
        value.runtime.acceptVisualBaseline(execution.executionId, 'f'.repeat(64))
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(value.runtime.listVisualBaselines()).toEqual([])

      const baseline = await value.runtime.acceptVisualBaseline(
        execution.executionId,
        visualEvidenceSha256
      )
      expect(baseline).toMatchObject({
        sourceExecutionId: execution.executionId,
        pluginId: binding.pluginId,
        host: binding.host,
        projectId: binding.projectId,
        documentId: hashOnlyContext.documentId,
        scopeId: hashOnlyContext.scopeId,
        captureId: hashOnlyContext.captureId,
        visualEvidenceSha256,
        targets: [{ targetId: 'node_1', accepted: visualEvidence[0].after }],
        correctionRoundsUsed: 0,
        maxCorrectionRounds: FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS,
        expiresAt: baseline.acceptedAt + FIGPLUGIN_VISUAL_BASELINE_TTL_MS
      })
      expect(
        await value.runtime.acceptVisualBaseline(execution.executionId, visualEvidenceSha256)
      ).toEqual(baseline)
      expect(value.runtime.listVisualBaselines()).toEqual([baseline])
      expect(value.audit.at(-1)).toMatchObject({
        state: 'completed',
        effect: 'applied',
        visualBaselineId: baseline.baselineId,
        visualBaselineEvidenceSha256: visualEvidenceSha256,
        visualBaselineAcceptedAt: baseline.acceptedAt,
        visualBaselineExpiresAt: baseline.expiresAt,
        maxCorrectionRounds: FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS
      })
      expect(JSON.stringify(value.audit)).not.toMatch(/Old name|New name/)
      value.advance(FIGPLUGIN_VISUAL_BASELINE_TTL_MS)
      expect(value.runtime.listVisualBaselines()).toEqual([])
    } finally {
      value.runtime.dispose()
    }
  })

  it('compares later exact and changed results against an active accepted checkpoint', async () => {
    const value = fixture(true, hashOnlyContext)
    try {
      const first = await completedVisualExecution(value)
      const baseline = await value.runtime.acceptVisualBaseline(
        first.execution.executionId,
        first.result.status.visualEvidenceSha256!
      )

      const exact = await completedVisualExecution(value)
      expect(exact.result.status.visualBaselineComparison).toEqual({
        protocol: 1,
        baselineId: baseline.baselineId,
        executionId: exact.execution.executionId,
        baselineEvidenceSha256: baseline.visualEvidenceSha256,
        visualEvidenceSha256: exact.result.status.visualEvidenceSha256,
        comparedAt: exact.result.status.updatedAt,
        targets: [
          {
            targetId: 'node_1',
            baseline: visualEvidence[0].after,
            current: visualEvidence[0].after,
            changed: false
          }
        ],
        changedCount: 0,
        exactMatch: true
      })
      expect(value.audit.at(-1)).toMatchObject({
        state: 'completed',
        visualComparisonBaselineId: baseline.baselineId,
        visualComparisonTargetCount: 1,
        visualComparisonChangedCount: 0,
        visualComparisonSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })

      const changedEvidence = [
        {
          ...visualEvidence[0],
          after: { ...visualEvidence[0].after, sha256: '3'.repeat(64) }
        }
      ]
      const changed = await completedVisualExecution(value, changedEvidence)
      expect(changed.result.status.visualBaselineComparison).toMatchObject({
        baselineId: baseline.baselineId,
        executionId: changed.execution.executionId,
        baselineEvidenceSha256: baseline.visualEvidenceSha256,
        visualEvidenceSha256: changed.result.status.visualEvidenceSha256,
        changedCount: 1,
        exactMatch: false,
        targets: [
          {
            targetId: 'node_1',
            baseline: visualEvidence[0].after,
            current: changedEvidence[0].after,
            changed: true
          }
        ]
      })
      expect(value.audit.at(-1)).toMatchObject({
        state: 'completed',
        visualComparisonBaselineId: baseline.baselineId,
        visualComparisonTargetCount: 1,
        visualComparisonChangedCount: 1,
        visualComparisonSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
      expect(JSON.stringify(value.audit)).not.toMatch(/Old name|New name/)
    } finally {
      value.runtime.dispose()
    }
  })

  it('authorizes one bounded future correction round for exact changed targets', async () => {
    const value = fixture(true, hashOnlyContext)
    try {
      const first = await completedVisualExecution(value)
      const baseline = await value.runtime.acceptVisualBaseline(
        first.execution.executionId,
        first.result.status.visualEvidenceSha256!
      )
      const changedEvidence = [
        {
          ...visualEvidence[0],
          after: { ...visualEvidence[0].after, sha256: '3'.repeat(64) }
        }
      ]
      const changed = await completedVisualExecution(value, changedEvidence)
      const changedEvidenceSha256 = changed.result.status.visualEvidenceSha256!

      await expect(
        value.runtime.authorizeVisualCorrection(
          changed.execution.executionId,
          baseline.baselineId,
          'f'.repeat(64)
        )
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([])

      const authorization = await value.runtime.authorizeVisualCorrection(
        changed.execution.executionId,
        baseline.baselineId,
        changedEvidenceSha256
      )
      expect(authorization).toMatchObject({
        baselineId: baseline.baselineId,
        sourceExecutionId: changed.execution.executionId,
        pluginId: binding.pluginId,
        host: binding.host,
        projectId: binding.projectId,
        documentId: hashOnlyContext.documentId,
        scopeId: hashOnlyContext.scopeId,
        captureId: hashOnlyContext.captureId,
        adapterVersion: hashOnlyContext.execution!.adapterVersion,
        baselineEvidenceSha256: baseline.visualEvidenceSha256,
        visualEvidenceSha256: changedEvidenceSha256,
        visualTargetIds: ['node_1'],
        authorizedTargetIds: ['node_1'],
        round: 1,
        maxCorrectionRounds: FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS,
        expiresAt: changed.execution.expiresAt,
        state: 'authorized'
      })
      expect(
        await value.runtime.authorizeVisualCorrection(
          changed.execution.executionId,
          baseline.baselineId,
          changedEvidenceSha256
        )
      ).toEqual(authorization)
      expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([authorization])
      expect(value.audit.at(-1)).toMatchObject({
        state: 'completed',
        effect: 'applied',
        visualCorrectionAuthorizationId: authorization.authorizationId,
        visualCorrectionRound: 1,
        visualCorrectionMaxRounds: FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS,
        visualCorrectionTargetCount: 1,
        visualCorrectionComparisonSha256: authorization.comparisonSha256,
        visualCorrectionExpiresAt: authorization.expiresAt
      })
      expect(JSON.stringify(value.audit.at(-1))).not.toMatch(/Old name|New name/)

      const competingEvidence = [
        {
          ...visualEvidence[0],
          after: { ...visualEvidence[0].after, sha256: '4'.repeat(64) }
        }
      ]
      const competing = await completedVisualExecution(value, competingEvidence)
      await expect(
        value.runtime.authorizeVisualCorrection(
          competing.execution.executionId,
          baseline.baselineId,
          competing.result.status.visualEvidenceSha256!
        )
      ).rejects.toMatchObject({ code: 'BUSY' })

      const exact = await completedVisualExecution(value)
      await expect(
        value.runtime.authorizeVisualCorrection(
          exact.execution.executionId,
          baseline.baselineId,
          exact.result.status.visualEvidenceSha256!
        )
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

      value.runtime.cancelVisualCorrectionAuthorization(authorization.authorizationId)
      expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([])
      const replacement = await value.runtime.authorizeVisualCorrection(
        competing.execution.executionId,
        baseline.baselineId,
        competing.result.status.visualEvidenceSha256!
      )
      expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([replacement])
      value.advance(FIGPLUGIN_VISUAL_CORRECTION_AUTHORIZATION_TTL_MS)
      expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([])
    } finally {
      value.runtime.dispose()
    }
  })

  it('terminalizes a prepared correction when authorization capacity evicts its ticket', async () => {
    const value = await correctionFixture()
    try {
      const preparedCorrection = await prepareCorrectionFixture(value)
      const internal = value.runtime as unknown as {
        visualCorrectionAuthorizations: Map<
          string,
          {
            value: typeof preparedCorrection.authorization
            binding: FigPluginRuntimeBinding
            preparedExecutionId?: string
          }
        >
      }
      // Fill the remaining slots with inert records so the next real
      // authorization exercises the bounded-capacity eviction path.
      for (let index = 0; index < 15; index += 1) {
        const id = index.toString(16).padStart(32, '0')
        internal.visualCorrectionAuthorizations.set(id, {
          value: {
            ...structuredClone(preparedCorrection.authorization),
            authorizationId: id,
            // Keep the synthetic entry attached to a live baseline so prune()
            // does not discard it before the capacity path runs.
            baselineId: preparedCorrection.authorization.baselineId,
            sourceExecutionId: (index + 100).toString(16).padStart(32, '0')
          },
          binding
        })
      }
      expect(value.runtime.listVisualCorrectionAuthorizations()).toHaveLength(16)

      value.hostContext = {
        ...structuredClone(value.hostContext),
        documentId: 'document_2'
      }
      const first = await completedVisualExecution(value)
      const baseline = await value.runtime.acceptVisualBaseline(
        first.execution.executionId,
        first.result.status.visualEvidenceSha256!
      )
      const changed = await completedVisualExecution(value, [
        { ...visualEvidence[0], after: { ...visualEvidence[0].after, sha256: '4'.repeat(64) } }
      ])
      const authorization = await value.runtime.authorizeVisualCorrection(
        changed.execution.executionId,
        baseline.baselineId,
        changed.result.status.visualEvidenceSha256!
      )

      expect(authorization.round).toBe(1)
      expect(value.runtime.listVisualCorrectionAuthorizations()).toHaveLength(16)
      expect(value.runtime.listPlanStatuses()).toContainEqual(
        expect.objectContaining({
          executionId: preparedCorrection.preview.executionId,
          state: 'cancelled',
          errorCode: 'CANCELLED'
        })
      )
      expect(value.audit).toContainEqual(
        expect.objectContaining({
          executionId: preparedCorrection.preview.executionId,
          state: 'cancelled',
          errorCode: 'CANCELLED'
        })
      )
    } finally {
      value.runtime.dispose()
    }
  })

  it('prepares, separately approves and consumes one correction round before verified execution', async () => {
    const value = fixture(true, hashOnlyContext)
    try {
      const first = await completedVisualExecution(value)
      const baseline = await value.runtime.acceptVisualBaseline(
        first.execution.executionId,
        first.result.status.visualEvidenceSha256!
      )
      const driftEvidence = [
        {
          ...visualEvidence[0],
          after: { ...visualEvidence[0].after, sha256: '3'.repeat(64) }
        }
      ]
      const changed = await completedVisualExecution(value, driftEvidence)
      expect(
        await value.runtime.prepareVisualCorrection(
          changed.session.sessionId,
          changed.session.sessionToken,
          { protocol: 1, sourceExecutionId: changed.execution.executionId }
        )
      ).toMatchObject({ status: 'pending' })

      const authorization = await value.runtime.authorizeVisualCorrection(
        changed.execution.executionId,
        baseline.baselineId,
        changed.result.status.visualEvidenceSha256!
      )
      expect(
        await value.runtime.prepareVisualCorrection(
          changed.session.sessionId,
          changed.session.sessionToken,
          { protocol: 1, sourceExecutionId: changed.execution.executionId }
        )
      ).toEqual({ protocol: 1, status: 'authorized', authorization })

      const correctionContext: HostContext = {
        ...structuredClone(hashOnlyContext),
        captureId: authorization.authorizationId,
        nodes: hashOnlyContext.nodes.map((node) => ({ ...node, name: 'Drifted name' }))
      }
      const preparedCorrection = await value.runtime.prepareVisualCorrection(
        changed.session.sessionId,
        changed.session.sessionToken,
        {
          protocol: 1,
          sourceExecutionId: changed.execution.executionId,
          hostContext: correctionContext
        }
      )
      expect(preparedCorrection).toMatchObject({
        protocol: 1,
        status: 'prepared',
        callId: changed.receipt.callId,
        state: 'awaiting-approval'
      })
      if (preparedCorrection.status !== 'prepared') throw new Error('correction was not prepared')
      const correction = value.runtime
        .listPlanExecutions()
        .find((item) => item.executionId === preparedCorrection.executionId)
      expect(correction).toMatchObject({
        captureId: authorization.authorizationId,
        visualCorrection: {
          authorizationId: authorization.authorizationId,
          baselineId: baseline.baselineId,
          sourceExecutionId: changed.execution.executionId,
          round: 1,
          maxCorrectionRounds: FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS,
          authorizedTargetIds: ['node_1']
        },
        plan: {
          captureId: authorization.authorizationId,
          steps: [{ command: 'node.rename', targetId: 'node_1', name: 'New name' }]
        }
      })
      if (!correction) throw new Error('missing correction preview')
      expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([authorization])
      expect(value.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(0)

      await value.runtime.approvePlan(correction.executionId, correction.planSha256)
      const claimed = await value.runtime.claimPlan(
        changed.session.sessionId,
        changed.session.sessionToken,
        {
          protocol: 1,
          callId: changed.receipt.callId,
          executionId: correction.executionId
        }
      )
      expect(claimed.status).toBe('ready')
      if (claimed.status !== 'ready') throw new Error('correction was not claimed')
      expect(claimed.intent).toMatchObject({
        executionId: correction.executionId,
        callId: changed.receipt.callId,
        captureId: authorization.authorizationId,
        visualTargetIds: ['node_1'],
        visualCorrection: correction.visualCorrection
      })
      expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([])
      expect(value.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(1)
      expect(
        await value.runtime.claimPlan(changed.session.sessionId, changed.session.sessionToken, {
          protocol: 1,
          callId: changed.receipt.callId,
          executionId: correction.executionId
        })
      ).toEqual(claimed)

      const correctedContext: HostContext = {
        ...structuredClone(correctionContext),
        nodes: correctionContext.nodes.map((node) => ({ ...node, name: 'New name' }))
      }
      const correctionEvidence = [
        {
          targetId: 'node_1',
          before: driftEvidence[0].after,
          after: visualEvidence[0].after,
          changed: true
        }
      ]
      const result = value.runtime.planResult(
        changed.session.sessionId,
        changed.session.sessionToken,
        {
          protocol: 1,
          executionId: correction.executionId,
          actionId: claimed.intent.actionId,
          status: 'completed',
          effect: 'applied',
          completed: 1,
          total: 1,
          readback: createHostPlanReadback(
            correctionContext,
            correctedContext,
            claimed.intent.plan
          ),
          visualEvidence: correctionEvidence
        }
      )
      expect(result.status).toMatchObject({
        state: 'completed',
        effect: 'applied',
        visualBaselineComparison: {
          baselineId: baseline.baselineId,
          changedCount: 0,
          exactMatch: true
        }
      })
      expect(
        await value.runtime.prepareVisualCorrection(
          changed.session.sessionId,
          changed.session.sessionToken,
          { protocol: 1, sourceExecutionId: changed.execution.executionId }
        )
      ).toMatchObject({ status: 'terminal', state: 'completed' })
      await expect(
        value.runtime.acceptVisualBaseline(
          correction.executionId,
          result.status.visualEvidenceSha256!
        )
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    } finally {
      value.runtime.dispose()
    }
  })

  it('does not spend a correction round when a prepared correction is denied', async () => {
    const value = fixture(true, hashOnlyContext)
    try {
      const first = await completedVisualExecution(value)
      const baseline = await value.runtime.acceptVisualBaseline(
        first.execution.executionId,
        first.result.status.visualEvidenceSha256!
      )
      const changed = await completedVisualExecution(value, [
        {
          ...visualEvidence[0],
          after: { ...visualEvidence[0].after, sha256: '3'.repeat(64) }
        }
      ])
      const authorization = await value.runtime.authorizeVisualCorrection(
        changed.execution.executionId,
        baseline.baselineId,
        changed.result.status.visualEvidenceSha256!
      )
      const correctionContext: HostContext = {
        ...structuredClone(hashOnlyContext),
        captureId: authorization.authorizationId,
        nodes: hashOnlyContext.nodes.map((node) => ({ ...node, name: 'Drifted name' }))
      }
      const preparedCorrection = await value.runtime.prepareVisualCorrection(
        changed.session.sessionId,
        changed.session.sessionToken,
        {
          protocol: 1,
          sourceExecutionId: changed.execution.executionId,
          hostContext: correctionContext
        }
      )
      if (preparedCorrection.status !== 'prepared') throw new Error('correction was not prepared')
      value.runtime.denyPlan(preparedCorrection.executionId)
      expect(value.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(0)
      expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([])
      expect(
        await value.runtime.prepareVisualCorrection(
          changed.session.sessionId,
          changed.session.sessionToken,
          { protocol: 1, sourceExecutionId: changed.execution.executionId }
        )
      ).toMatchObject({ status: 'pending' })
      const replacement = await value.runtime.authorizeVisualCorrection(
        changed.execution.executionId,
        baseline.baselineId,
        changed.result.status.visualEvidenceSha256!
      )
      expect(replacement.authorizationId).not.toBe(authorization.authorizationId)
      expect(replacement.round).toBe(1)
    } finally {
      value.runtime.dispose()
    }
  })

  it.each(['scope', 'adapter'] as const)(
    'does not compare an accepted checkpoint across a changed %s boundary',
    async (boundary) => {
      const ownedContext = structuredClone(hashOnlyContext)
      const value = fixture(true, ownedContext)
      try {
        const first = await completedVisualExecution(value)
        await value.runtime.acceptVisualBaseline(
          first.execution.executionId,
          first.result.status.visualEvidenceSha256!
        )
        if (boundary === 'scope') ownedContext.scopeId = 'page_2'
        else ownedContext.execution!.adapterVersion = 'figma-native-2'

        const next = await completedVisualExecution(value)
        expect(next.result.status.visualBaselineComparison).toBeUndefined()
        expect(value.audit.at(-1)).not.toHaveProperty('visualComparisonBaselineId')
        expect(value.audit.at(-1)).not.toHaveProperty('visualComparisonSha256')
        expect(value.runtime.listVisualBaselines()).toHaveLength(1)
      } finally {
        value.runtime.dispose()
      }
    }
  )

  it('invalidates an accepted visual baseline when the package binding is revoked', async () => {
    const value = fixture(true, hashOnlyContext)
    try {
      const { execution, result } = await completedVisualExecution(value)
      await value.runtime.acceptVisualBaseline(
        execution.executionId,
        result.status.visualEvidenceSha256!
      )
      expect(value.runtime.listVisualBaselines()).toHaveLength(1)
      value.runtime.revokePlugin(binding.pluginId)
      expect(value.runtime.listVisualBaselines()).toEqual([])
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

  it('rejects a spoofed requested value instead of completing the write', async () => {
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
      const after: HostContext = {
        ...structuredClone(context),
        nodes: context.nodes.map((node) => ({ ...node, name: 'New name' }))
      }
      const readback = createHostPlanReadback(context, after, plan)
      readback.steps[0].value = 'forged value'
      expect(() =>
        value.runtime.planResult(session.sessionId, session.sessionToken, {
          protocol: 1,
          executionId: execution.executionId,
          actionId: claimed.intent.actionId,
          status: 'completed',
          effect: 'applied',
          completed: 1,
          total: 1,
          readback
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
    } finally {
      value.runtime.dispose()
    }
  })
})

it('cannot mint a new correction from the same consumed comparison, before or after completion', async () => {
  const value = await correctionFixture()
  try {
    const c = await prepareCorrectionFixture(value)
    await value.runtime.approvePlan(c.preview.executionId, c.preview.planSha256)
    const claimed = await c.claim()
    if (claimed.status !== 'ready') throw new Error('not ready')
    const repeat = () =>
      value.runtime.authorizeVisualCorrection(
        value.changed.execution.executionId,
        value.baseline.baselineId,
        value.changed.result.status.visualEvidenceSha256!
      )
    await expect(repeat()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    finishCorrectionFixture(value, c, claimed.intent)
    await expect(repeat()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(value.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(1)
    expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([])
  } finally {
    value.runtime.dispose()
  }
})

it('spends exactly three rounds despite concurrent duplicate claims, and rejects round four', async () => {
  const value = await correctionFixture()
  try {
    let source = value.changed.result.status
    for (let round = 1; round <= 3; round++) {
      const c = await prepareCorrectionFixture(value, source)
      expect(c.authorization.round).toBe(round)
      expect(await c.prepare()).toEqual(c.result)
      expect((await c.claim()).status).toBe('pending')
      expect(value.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(round - 1)
      await value.runtime.approvePlan(c.preview.executionId, c.preview.planSha256)
      const claims = await Promise.all([c.claim(), c.claim(), c.claim()])
      expect(claims[0]).toEqual(claims[1])
      expect(claims[1]).toEqual(claims[2])
      const claim = claims[0]
      if (claim.status !== 'ready') throw new Error('not ready')
      expect(value.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(round)
      source = finishCorrectionFixture(value, c, claim.intent)
      expect(source.visualBaselineComparison?.exactMatch).toBe(false)
      expect(source.visualCorrection).toEqual(c.preview.visualCorrection)
      expect(
        value.audit.filter(
          (event) => event.executionId === c.preview.executionId && event.state === 'claimed'
        )
      ).toHaveLength(1)
      expect(value.audit.at(-1)?.correctionAttempt).toMatchObject({
        authorizationId: c.authorization.authorizationId,
        baselineId: value.baseline.baselineId,
        round,
        maxCorrectionRounds: 3,
        targetCount: 1,
        consumed: true
      })
    }
    await expect(
      value.runtime.authorizeVisualCorrection(
        source.executionId,
        value.baseline.baselineId,
        source.visualEvidenceSha256!
      )
    ).rejects.toMatchObject({ code: 'DENIED' })
    expect(
      await value.runtime.prepareVisualCorrection(
        value.changed.session.sessionId,
        value.changed.session.sessionToken,
        { protocol: 1, sourceExecutionId: source.executionId }
      )
    ).toMatchObject({ status: 'terminal', state: 'denied', errorCode: 'DENIED' })
    expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([])
    expect(JSON.stringify(value.audit)).not.toMatch(/Drifted name|New name|authorizedTargetIds/)
  } finally {
    value.runtime.dispose()
  }
})

it.each(['document', 'scope', 'capture', 'adapter', 'targets', 'lock'] as const)(
  'rejects a recaptured correction context with a changed %s boundary',
  async (boundary) => {
    const value = await correctionFixture()
    try {
      const a = await value.runtime.authorizeVisualCorrection(
        value.changed.execution.executionId,
        value.baseline.baselineId,
        value.changed.result.status.visualEvidenceSha256!
      )
      const context = structuredClone(hashOnlyContext)
      context.captureId = a.authorizationId
      if (boundary === 'document') context.documentId = 'foreign-document'
      if (boundary === 'scope') context.scopeId = 'foreign-scope'
      if (boundary === 'capture') context.captureId = 'f'.repeat(32)
      if (boundary === 'adapter') context.execution!.adapterVersion = 'other-adapter'
      if (boundary === 'targets') context.selectedIds = ['foreign-node']
      if (boundary === 'lock') context.nodes[0].locked = true
      await expect(
        value.runtime.prepareVisualCorrection(
          value.changed.session.sessionId,
          value.changed.session.sessionToken,
          {
            protocol: 1,
            sourceExecutionId: value.changed.execution.executionId,
            hostContext: context
          }
        )
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(value.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(0)
    } finally {
      value.runtime.dispose()
    }
  }
)

it.each(['cancel', 'deny', 'revoke', 'expire'] as const)(
  '%s before claim does not consume a round or release a correction intent',
  async (action) => {
    const value = await correctionFixture()
    try {
      const c = await prepareCorrectionFixture(value)
      await value.runtime.approvePlan(c.preview.executionId, c.preview.planSha256)
      if (action === 'cancel')
        value.runtime.cancelVisualCorrectionAuthorization(c.authorization.authorizationId)
      if (action === 'deny') value.runtime.denyPlan(c.preview.executionId)
      if (action === 'revoke') value.runtime.revokePlugin(binding.pluginId)
      if (action === 'expire') value.advance(c.preview.expiresAt - c.preview.createdAt + 1)
      const result = await c.claim().catch(() => null)
      expect(result?.status).not.toBe('ready')
      expect(
        value.runtime.listVisualBaselines().every((item) => item.correctionRoundsUsed === 0)
      ).toBe(true)
      expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([])
    } finally {
      value.runtime.dispose()
    }
  }
)

it('rejects another session attempting to prepare or claim a correction', async () => {
  const value = await correctionFixture()
  try {
    const c = await prepareCorrectionFixture(value)
    const other = await prepared(value)
    await expect(
      value.runtime.prepareVisualCorrection(
        other.session.sessionId,
        other.session.sessionToken,
        c.input
      )
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await value.runtime.approvePlan(c.preview.executionId, c.preview.planSha256)
    await expect(
      value.runtime.claimPlan(other.session.sessionId, other.session.sessionToken, c.selector)
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(value.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(0)
  } finally {
    value.runtime.dispose()
  }
})

it.each([false, true])(
  'host cancellation stops correction descendants after claim=%s, preserving spent rounds',
  async (claimFirst) => {
    const value = await correctionFixture()
    try {
      const c = await prepareCorrectionFixture(value)
      await value.runtime.approvePlan(c.preview.executionId, c.preview.planSha256)
      if (claimFirst) expect((await c.claim()).status).toBe('ready')
      await value.runtime.cancel(
        value.changed.session.sessionId,
        value.changed.session.sessionToken,
        value.changed.receipt.callId
      )
      expect(await c.claim()).toMatchObject({ status: 'terminal', state: 'cancelled' })
      expect(value.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(claimFirst ? 1 : 0)
      expect(value.runtime.listVisualCorrectionAuthorizations()).toEqual([])
    } finally {
      value.runtime.dispose()
    }
  }
)
it('cannot change a prepared correction context via a replay', async () => {
  const value = await correctionFixture()
  try {
    const c = await prepareCorrectionFixture(value)
    await expect(
      value.runtime.prepareVisualCorrection(
        value.changed.session.sessionId,
        value.changed.session.sessionToken,
        { ...c.input, hostContext: { ...c.context, documentId: 'other-document' } }
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await c.prepare()).toEqual(c.result)
  } finally {
    value.runtime.dispose()
  }
})

describe('host-local pixel audit reporting', () => {
  async function setup() {
    const value = fixture(true, hashOnlyContext)
    const first = await completedVisualExecution(value)
    const baseline = await value.runtime.acceptVisualBaseline(
      first.execution.executionId,
      first.result.status.visualEvidenceSha256!
    )
    const current = await completedVisualExecution(value, [
      { ...visualEvidence[0], after: { ...visualEvidence[0].after, sha256: '3'.repeat(64) } }
    ])
    const comparison = current.result.status.visualBaselineComparison!
    const target = {
      targetId: 'node_1',
      status: 'compared',
      pixelCount: 64 * 32,
      changedPixels: 1,
      maxChannelDelta: 10,
      absoluteDelta: 10,
      changedBounds: { x: 2, y: 1, width: 1, height: 1 }
    }
    const request = {
      protocol: 1,
      executionId: current.execution.executionId,
      actionId: current.execution.executionId,
      policy: 'rgba8-exact-v1',
      baselineId: baseline.baselineId,
      baselineEvidenceSha256: comparison.baselineEvidenceSha256,
      visualEvidenceSha256: comparison.visualEvidenceSha256,
      targets: [target]
    }
    const send = (input: unknown = request) =>
      value.runtime.planPixelAudit(current.session.sessionId, current.session.sessionToken, input)
    return { ...value, baseline, current, request, send }
  }
  it('records exact metrics once and exposes them without changing write authority or round budgets', async () => {
    const f = await setup()
    try {
      const before = f.runtime.listVisualBaselines(),
        auditBefore = f.audit.length
      const result = await f.send()
      expect(result.status.pixelAudit).toMatchObject({
        outcome: 'different',
        changedTargets: 1,
        changedPixels: 1,
        comparedTargets: 1,
        unavailableTargets: 0
      })
      expect(await f.send()).toEqual(result)
      expect(f.audit.length).toBe(auditBefore + 1)
      expect(f.audit.at(-1)?.pixelAudit).toMatchObject({ outcome: 'different', changedPixels: 1 })
      expect(JSON.stringify(f.audit.at(-1))).not.toMatch(
        /changedBounds|node_1|pixels|Old name|New name/
      )
      expect(f.runtime.listVisualBaselines()).toEqual(before)
      expect(f.runtime.listVisualCorrectionAuthorizations()).toEqual([])
      await expect(
        f.send({ ...f.request, targets: [{ ...f.request.targets[0], absoluteDelta: 11 }] })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    } finally {
      f.runtime.dispose()
    }
  })
  it('does not correct a mere encoding/hash change after an exact pixel match', async () => {
    const f = await setup()
    try {
      const result = await f.send({
        ...f.request,
        targets: [
          {
            ...f.request.targets[0],
            changedPixels: 0,
            maxChannelDelta: 0,
            absoluteDelta: 0,
            changedBounds: null
          }
        ]
      })
      expect(result.status.pixelAudit?.outcome).toBe('match')
      await expect(
        f.runtime.authorizeVisualCorrection(
          f.current.execution.executionId,
          f.baseline.baselineId,
          f.current.result.status.visualEvidenceSha256!
        )
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    } finally {
      f.runtime.dispose()
    }
  })
  it('a late exact report cancels only an unconsumed correction, without spending a round', async () => {
    const f = await setup()
    try {
      const authorization = await f.runtime.authorizeVisualCorrection(
        f.current.execution.executionId,
        f.baseline.baselineId,
        f.current.result.status.visualEvidenceSha256!
      )
      const prepared = await f.runtime.prepareVisualCorrection(
        f.current.session.sessionId,
        f.current.session.sessionToken,
        {
          protocol: 1,
          sourceExecutionId: f.current.execution.executionId,
          hostContext: {
            ...structuredClone(hashOnlyContext),
            captureId: authorization.authorizationId,
            nodes: hashOnlyContext.nodes.map((node) => ({ ...node, name: 'Drifted name' }))
          }
        }
      )
      if (prepared.status !== 'prepared') throw new Error('Expected prepared correction')
      const child = f.runtime
        .listPlanExecutions()
        .find((value) => value.executionId === prepared.executionId)!
      await f.runtime.approvePlan(child.executionId, child.planSha256)
      await f.send({
        ...f.request,
        targets: [
          {
            ...f.request.targets[0],
            changedPixels: 0,
            maxChannelDelta: 0,
            absoluteDelta: 0,
            changedBounds: null
          }
        ]
      })
      expect(f.runtime.listVisualCorrectionAuthorizations()).toEqual([])
      expect(f.runtime.listVisualBaselines()[0].correctionRoundsUsed).toBe(0)
      expect(
        await f.runtime.claimPlan(f.current.session.sessionId, f.current.session.sessionToken, {
          protocol: 1,
          callId: f.current.receipt.callId,
          executionId: child.executionId
        })
      ).toMatchObject({ status: 'terminal', state: 'cancelled' })
    } finally {
      f.runtime.dispose()
    }
  })
  it('never turns missing pixels into a passed audit', async () => {
    const f = await setup()
    try {
      expect(
        (await f.send({ ...f.request, targets: [{ targetId: 'node_1', status: 'unavailable' }] }))
          .status.pixelAudit?.outcome
      ).toBe('incomplete')
    } finally {
      f.runtime.dispose()
    }
  })
  it('rejects mismatched actions, bindings, targets, invalid metrics and pixels before recording anything', async () => {
    const f = await setup()
    try {
      const count = f.audit.length
      for (const change of [
        { actionId: 'f'.repeat(32) },
        { baselineId: 'f'.repeat(32) },
        { baselineEvidenceSha256: 'f'.repeat(64) },
        { visualEvidenceSha256: 'f'.repeat(64) },
        { targets: [{ ...f.request.targets[0], targetId: 'foreign' }] },
        {
          targets: [
            { ...f.request.targets[0], changedBounds: { x: 64, y: 0, width: 1, height: 1 } }
          ]
        },
        { targets: [{ ...f.request.targets[0], pixelCount: 1 }] },
        { pixels: 'PRIVATE' }
      ])
        await expect(f.send({ ...f.request, ...change })).rejects.toMatchObject({
          code: 'INVALID_REQUEST'
        })
      const other = await prepared(f)
      await expect(
        f.runtime.planPixelAudit(other.session.sessionId, other.session.sessionToken, f.request)
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(
        f.runtime
          .listPlanStatuses()
          .find((status) => status.executionId === f.current.execution.executionId)?.pixelAudit
      ).toBeUndefined()
      expect(f.audit.slice(0, count).every((event) => event.pixelAudit === undefined)).toBe(true)
    } finally {
      f.runtime.dispose()
    }
  })
  it('does not retain a late report after plugin revocation', async () => {
    const f = await setup()
    try {
      f.runtime.revokePlugin(binding.pluginId)
      await expect(f.send()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    } finally {
      f.runtime.dispose()
    }
  })
})
