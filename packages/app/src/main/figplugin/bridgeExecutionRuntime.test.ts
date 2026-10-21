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
  const runtime = new FigPluginBridgeRuntime({
    validateBinding: async () => true,
    invoke: async () =>
      ({
        content: JSON.stringify(createHostPlanningPreview(JSON.stringify(plan), hostContext))
      }) as never,
    allowNativeWrite: () => allowNativeWrite,
    audit: (event) => audit.push(event),
    now: () => now
  })
  return {
    runtime,
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
