import {
  MemoryNativeWriteCoordinator,
  type NativeWriteCoordinator,
  type NativeWriteReservation
} from './nativeWriteCoordinator'
import type { RecoveryCheckpointStore, SavedCheckpoint } from './checkpointStore'
import {
  captureTaskRecoveryScope,
  createTaskRecoveryRebind,
  applyTaskRecoveryRebind,
  prepareTaskRecoveryPlan,
  figPluginTaskRecoveryPrepareRequestSchema,
  figPluginTaskRecoveryPrepareResponseSchema,
  type TaskRecoveryScope,
  type FigPluginTaskRecovery,
  type FigPluginTaskRecoveryPrepareResponse
} from '@shared/figplugin/taskRecovery'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  figPluginPixelAuditRequestSchema,
  figPluginPixelAuditSchema,
  pixelAuditMatchesComparison,
  summarizePixelTargets,
  type FigPluginPixelAudit
} from '@shared/figplugin/pixelAudit'
import {
  FIGPLUGIN_BRIDGE_PROTOCOL,
  FigPluginBridgeError,
  figPluginBridgePrepareRequestSchema,
  figPluginBridgeStatusResponseSchema,
  figPluginPairRequestSchema,
  figPluginRuntimeBindingSchema,
  parseFigPluginBridgeValue,
  type FigPluginBridgePrepareRequest,
  type FigPluginBridgePrepareResponse,
  type FigPluginBridgePreview,
  type FigPluginBridgeStatusResponse,
  type FigPluginPairRequest,
  type FigPluginPairResponse,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_EXECUTION_MAX_EVENTS,
  FIGPLUGIN_EXECUTION_PROTOCOL,
  FIGPLUGIN_VISUAL_BASELINE_TTL_MS,
  FIGPLUGIN_VISUAL_CORRECTION_AUTHORIZATION_TTL_MS,
  FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS,
  figPluginExecutionClaimResponseSchema,
  figPluginExecutionIntentSchema,
  figPluginExecutionPreviewSchema,
  figPluginExecutionProgressRequestSchema,
  figPluginExecutionResultRequestSchema,
  figPluginExecutionResultResponseSchema,
  figPluginExecutionStateSchema,
  figPluginExecutionStatusSchema,
  figPluginExecutionClaimRequestSchema,
  figPluginExecutionStatusRequestSchema,
  figPluginVisualBaselineComparisonSchema,
  figPluginVisualBaselineSchema,
  figPluginVisualCorrectionAuthorizationSchema,
  figPluginVisualCorrectionPrepareRequestSchema,
  figPluginVisualCorrectionPrepareResponseSchema,
  type FigPluginExecutionClaimResponse,
  type FigPluginExecutionIntent,
  type FigPluginExecutionPreview,
  type FigPluginExecutionProgressRequest,
  type FigPluginExecutionResultRequest,
  type FigPluginExecutionResultResponse,
  type FigPluginExecutionState,
  type FigPluginExecutionStatus,
  type FigPluginVisualBaseline,
  type FigPluginVisualBaselineComparison,
  type FigPluginVisualCorrectionAttempt,
  type FigPluginVisualCorrectionAuthorization,
  type FigPluginVisualCorrectionPrepareResponse,
  type FigPluginVisualEvidence
} from '@shared/figplugin/execution'
import {
  createHostPlanningPreview,
  type HostPlanningPreview
} from '@shared/figplugin/hostPlanPreview'
import {
  validateHostPlanReadback,
  stepValue,
  type HostContext,
  type HostPlan
} from '@shared/figplugin/hostPlan'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import type { FigPluginExecutionAuditEvent } from './executionAudit'

const TICKET_TTL = 120_000
const SESSION_TTL = 600_000
const IDLE_TTL = 120_000
const CALL_TTL = 120_000
const MAX_CALL_TIMEOUT = 90_000
const FAILURE_WINDOW = 60_000
const dummySecret = '0'.repeat(64)
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 32 && /^[a-f0-9]{32}$/.test(value)

// Even missing IDs and malformed credentials perform a fixed-size comparison.
const secretEquals = (value: unknown, expected: string | undefined): boolean => {
  const valid = typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value)
  const equal = timingSafeEqual(
    Buffer.from(valid ? value : dummySecret, 'hex'),
    Buffer.from(expected || dummySecret, 'hex')
  )
  return valid && expected !== undefined && expected !== '' && equal
}
const resultSchema = figPluginBridgeStatusResponseSchema.options[2].pick({
  content: true,
  reportedTotalTokens: true
})

type Options = {
  validateBinding: (binding: FigPluginRuntimeBinding) => Promise<boolean>
  invoke: (
    binding: FigPluginRuntimeBinding,
    preview: FigPluginBridgePreview,
    signal: AbortSignal
  ) => Promise<{ content: string; reportedTotalTokens?: number }>
  now?: () => number
  callTimeoutMs?: number
  audit?: (event: FigPluginExecutionAuditEvent) => void
  allowNativeWrite?: (binding: FigPluginRuntimeBinding) => boolean
  checkpoints?: RecoveryCheckpointStore
  writes?: NativeWriteCoordinator
}
type Ticket = {
  binding: FigPluginRuntimeBinding
  secret: string
  expiresAt: number
  failures: number
  state: 'issuing' | 'ready' | 'redeeming'
}
type Receipt = {
  sequence: number
  requestId: string
  digest: string
  response: FigPluginBridgePrepareResponse
  recoveryResponse?: FigPluginTaskRecoveryPrepareResponse
}
type Session = {
  id: string
  token: string
  binding: FigPluginRuntimeBinding
  expiresAt: number
  idleAt: number
  highWater: number
  requests: Map<string, Receipt>
  preparing: number
  validation?: Promise<boolean>
}
type Call = {
  session: Session
  receipt: Receipt
  status: FigPluginBridgeStatusResponse
  preview?: FigPluginBridgePreview
  hostContext?: HostContext
  controller?: AbortController
  deadline?: number
  execution?: PlanExecution
}
type PlanProgress = {
  sequence: number
  phase: 'claimed' | 'executing' | 'readback'
  index?: number
  completed: number
  effect: 'none' | 'applied' | 'rolled-back' | 'partial' | 'unknown'
  at: number
}
type VisualBaselineRecord = {
  value: FigPluginVisualBaseline
  binding: FigPluginRuntimeBinding
  recoveryPlan: HostPlan
  recoveryScope: TaskRecoveryScope
}
type VisualCorrectionAuthorizationRecord = {
  value: FigPluginVisualCorrectionAuthorization
  binding: FigPluginRuntimeBinding
  preparedExecutionId?: string
}

type PlanExecution = {
  executionId: string
  actionId: string
  call: Call
  plan: HostPlan
  context: HostContext
  preview: FigPluginExecutionPreview
  planSha256: string
  contextSha256: string
  previewSha256: string
  state: FigPluginExecutionState
  completed: number
  effect: PlanProgress['effect']
  cursor: number
  progress: PlanProgress[]
  intent?: FigPluginExecutionIntent
  claimedAt?: number
  writeReservation?: NativeWriteReservation
  resultFingerprint?: string
  visualEvidence?: FigPluginVisualEvidence[]
  visualBaselineComparison?: FigPluginVisualBaselineComparison
  pixelAudit?: FigPluginPixelAudit
  pixelAuditFingerprint?: string
  visualTargetIds?: string[]
  visualCorrection?: FigPluginVisualCorrectionAttempt
  recovery?: FigPluginTaskRecovery
  updatedAt: number
  errorCode?: NonNullable<FigPluginExecutionStatus['errorCode']>
}
type TerminalCode =
  'DENIED' | 'EXPIRED' | 'CONFIGURATION_CHANGED' | 'CANCELLED' | 'TIMEOUT' | 'UPSTREAM_FAILED'
const active = (call: Call): boolean =>
  call.status.status === 'awaiting-approval' || call.status.status === 'running'
const terminalExecution = new Set<FigPluginExecutionState>([
  'completed',
  'cancelled',
  'denied',
  'failed',
  'expired'
])
const digest = (value: unknown): string =>
  createHash('sha256').update(canonicalFigPluginJson(value), 'utf8').digest('hex')
const visualBaselineScopeKey = (
  value: Pick<FigPluginVisualBaseline, 'pluginId' | 'host' | 'projectId' | 'documentId' | 'scopeId'>
): string =>
  JSON.stringify([value.pluginId, value.host, value.projectId, value.documentId, value.scopeId])

/** Memory-only main-process authority. Never expose createPairing/approve/deny to the host.
 * The caller supplies trusted native consent and validates the entire current store binding.
 */
export class FigPluginBridgeRuntime {
  private readonly checkpoints?: RecoveryCheckpointStore
  private readonly writes: NativeWriteCoordinator
  private readonly tickets = new Map<string, Ticket>()
  private readonly sessions = new Map<string, Session>()
  private readonly calls = new Map<string, Call>()
  private readonly visualBaselines = new Map<string, VisualBaselineRecord>()
  private readonly visualCorrectionAuthorizations = new Map<
    string,
    VisualCorrectionAuthorizationRecord
  >()
  private readonly visualCorrectionExecutions = new Map<string, PlanExecution>()
  private readonly validateBinding: Options['validateBinding']
  private readonly invoke: Options['invoke']
  private readonly clock: () => number
  private readonly callTimeout: number
  private readonly audit?: Options['audit']
  private readonly allowNativeWrite: NonNullable<Options['allowNativeWrite']>
  private failures: number[] = []
  private timer?: ReturnType<typeof setTimeout>
  private preparing = 0
  private executing = 0
  private closed = false

  constructor(options: Options) {
    this.checkpoints = options.checkpoints
    this.validateBinding = options.validateBinding
    this.invoke = options.invoke
    this.clock = options.now ?? Date.now
    this.writes = options.writes ?? new MemoryNativeWriteCoordinator(this.clock)
    this.callTimeout = Number.isFinite(options.callTimeoutMs)
      ? Math.max(1, Math.min(MAX_CALL_TIMEOUT, Math.floor(options.callTimeoutMs!)))
      : MAX_CALL_TIMEOUT
    this.audit = options.audit
    this.allowNativeWrite = options.allowNativeWrite ?? (() => false)
  }

  private executionStatus(execution: PlanExecution): FigPluginExecutionStatus {
    const visualEvidenceSha256 = execution.visualEvidence
      ? digest(execution.visualEvidence)
      : undefined
    return figPluginExecutionStatusSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      executionId: execution.executionId,
      callId: execution.call.receipt.response.callId,
      state: execution.state,
      completed: execution.completed,
      total: execution.plan.steps.length,
      effect: execution.effect,
      updatedAt: execution.updatedAt,
      ...(execution.visualEvidence
        ? { visualEvidence: execution.visualEvidence, visualEvidenceSha256 }
        : {}),
      ...(execution.visualBaselineComparison
        ? { visualBaselineComparison: execution.visualBaselineComparison }
        : {}),
      ...(execution.visualCorrection
        ? {
            visualCorrection: execution.visualCorrection,
            visualCorrectionConsumed: execution.claimedAt !== undefined
          }
        : {}),
      ...(execution.pixelAudit ? { pixelAudit: execution.pixelAudit } : {}),
      ...(execution.recovery
        ? { recovery: execution.recovery, recoveryConsumed: execution.claimedAt !== undefined }
        : {}),
      ...(execution.errorCode ? { errorCode: execution.errorCode } : {})
    })
  }

  private compareVisualBaseline(
    execution: PlanExecution,
    visualEvidence: FigPluginVisualEvidence[]
  ): FigPluginVisualBaselineComparison | undefined {
    const scopeKey = visualBaselineScopeKey({
      pluginId: execution.call.session.binding.pluginId,
      host: execution.call.session.binding.host,
      projectId: execution.call.session.binding.projectId,
      documentId: execution.context.documentId,
      scopeId: execution.context.scopeId
    })
    const record = [...this.visualBaselines.values()].find(
      (record) => visualBaselineScopeKey(record.value) === scopeKey
    )
    const baseline = record?.value
    if (
      !baseline ||
      baseline.adapterVersion !== execution.preview.adapterVersion ||
      record?.recoveryScope.recoveryIdentity !== execution.context.recoveryIdentity
    )
      return undefined
    const currentByTarget = new Map(
      visualEvidence.map((item) => [item.targetId, item.after] as const)
    )
    if (
      currentByTarget.size !== baseline.targets.length ||
      baseline.targets.some((target) => !currentByTarget.has(target.targetId))
    )
      return undefined
    const targets = baseline.targets.map((target) => {
      const current = currentByTarget.get(target.targetId)!
      return {
        targetId: target.targetId,
        baseline: target.accepted,
        current,
        changed:
          target.accepted.sha256 !== current.sha256 ||
          target.accepted.width !== current.width ||
          target.accepted.height !== current.height
      }
    })
    const changedCount = targets.filter((target) => target.changed).length
    return figPluginVisualBaselineComparisonSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      baselineId: baseline.baselineId,
      executionId: execution.executionId,
      baselineEvidenceSha256: baseline.visualEvidenceSha256,
      visualEvidenceSha256: digest(visualEvidence),
      comparedAt: execution.updatedAt,
      targets,
      changedCount,
      exactMatch: changedCount === 0
    })
  }

  private executionPreview(execution: PlanExecution): FigPluginExecutionPreview {
    return figPluginExecutionPreviewSchema.parse({
      ...execution.preview,
      state: execution.state
    })
  }

  private allPlanExecutions(): PlanExecution[] {
    return [
      ...[...this.calls.values()].flatMap((call) => (call.execution ? [call.execution] : [])),
      ...this.visualCorrectionExecutions.values()
    ]
  }

  private correctionAttempt(
    authorization: FigPluginVisualCorrectionAuthorization
  ): FigPluginVisualCorrectionAttempt {
    return {
      authorizationId: authorization.authorizationId,
      baselineId: authorization.baselineId,
      sourceExecutionId: authorization.sourceExecutionId,
      round: authorization.round,
      maxCorrectionRounds: authorization.maxCorrectionRounds,
      authorizedTargetIds: [...authorization.authorizedTargetIds]
    }
  }

  private executionForCall(call: Call, executionId?: string): PlanExecution {
    const execution = executionId ? this.findExecution(executionId) : call.execution
    if (!execution || execution.call !== call) throw new FigPluginBridgeError('INVALID_REQUEST')
    return execution
  }

  private correctionAuthority(execution: PlanExecution):
    | {
        authorizationRecord: VisualCorrectionAuthorizationRecord
        baselineRecord: VisualBaselineRecord
      }
    | undefined {
    const attempt = execution.visualCorrection
    if (!attempt) return undefined
    const authorizationRecord = this.visualCorrectionAuthorizations.get(attempt.authorizationId)
    const baselineRecord = this.visualBaselines.get(attempt.baselineId)
    const authorization = authorizationRecord?.value
    if (
      !authorizationRecord ||
      !authorization ||
      authorization.expiresAt <= this.clock() ||
      authorizationRecord.preparedExecutionId !== execution.executionId ||
      authorization.sourceExecutionId !== attempt.sourceExecutionId ||
      authorization.baselineId !== attempt.baselineId ||
      authorization.round !== attempt.round ||
      authorization.maxCorrectionRounds !== attempt.maxCorrectionRounds ||
      canonicalFigPluginJson(authorization.authorizedTargetIds) !==
        canonicalFigPluginJson(attempt.authorizedTargetIds) ||
      !baselineRecord ||
      baselineRecord.value.expiresAt <= this.clock() ||
      baselineRecord.value.correctionRoundsUsed + 1 !== attempt.round
    )
      throw new FigPluginBridgeError('EXPIRED')
    return { authorizationRecord, baselineRecord }
  }

  private registerPlanExecution(
    call: Call,
    content: string,
    context: HostContext,
    recovery?: FigPluginTaskRecovery
  ): PlanExecution | undefined {
    let checked: HostPlanningPreview
    try {
      const parsed = JSON.parse(content) as { plan?: unknown }
      checked = createHostPlanningPreview(JSON.stringify(parsed.plan), context)
    } catch {
      return undefined
    }
    if (
      checked.executable !== true ||
      !checked.execution ||
      !this.allowNativeWrite(call.session.binding)
    )
      return undefined
    const executionId = randomBytes(16).toString('hex')
    const planSha256 = digest(checked.plan)
    const contextSha256 = digest(context)
    const createdAt = this.clock()
    const expiresAt = call.receipt.response.expiresAt
    if (expiresAt <= createdAt) return undefined
    const preview = figPluginExecutionPreviewSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      executionId,
      callId: call.receipt.response.callId,
      pluginId: call.session.binding.pluginId,
      host: call.session.binding.host,
      projectId: call.session.binding.projectId,
      documentId: context.documentId,
      scopeId: context.scopeId,
      captureId: context.captureId,
      plan: checked.plan,
      planSha256,
      contextSha256,
      adapterVersion: checked.execution.adapterVersion,
      rollback: checked.execution.rollback,
      visualAudit: checked.execution.visualAudit,
      risk: recovery?.rebind ? 'high' : checked.risk,
      differences: checked.differences,
      ...(recovery ? { recovery } : {}),
      state: 'awaiting-approval',
      requiresWriteApproval: true,
      createdAt,
      expiresAt
    })
    const previewSha256 = digest({
      plan: checked.plan,
      differences: checked.differences,
      risk: recovery?.rebind ? 'high' : checked.risk,
      planSha256,
      contextSha256,
      adapterVersion: checked.execution.adapterVersion,
      rollback: checked.execution.rollback,
      visualAudit: checked.execution.visualAudit,
      ...(recovery ? { recovery } : {})
    })
    const execution: PlanExecution = {
      executionId,
      actionId: executionId,
      call,
      plan: checked.plan,
      context,
      preview,
      planSha256,
      contextSha256,
      previewSha256,
      state: 'awaiting-approval',
      completed: 0,
      effect: 'none',
      cursor: 0,
      progress: [],
      ...(recovery ? { recovery } : {}),
      updatedAt: createdAt
    }
    call.execution = execution
    this.recordExecutionAudit(execution)
    return execution
  }

  private recordExecutionAudit(
    execution: PlanExecution,
    visualBaseline?: FigPluginVisualBaseline,
    visualCorrectionAuthorization?: FigPluginVisualCorrectionAuthorization
  ): void {
    if (!this.audit) return
    try {
      this.audit({
        schemaVersion: 1,
        at: this.clock(),
        executionId: execution.executionId,
        callId: execution.call.receipt.response.callId,
        requestId: execution.call.receipt.requestId,
        pluginId: execution.call.session.binding.pluginId,
        host: execution.call.session.binding.host,
        projectId: execution.call.session.binding.projectId,
        state: execution.state,
        completed: execution.completed,
        total: execution.plan.steps.length,
        effect: execution.effect,
        risk: execution.preview.risk,
        planSha256: execution.planSha256,
        previewSha256: execution.previewSha256,
        adapterVersion: execution.preview.adapterVersion,
        rollback: execution.preview.rollback,
        visualAudit: execution.preview.visualAudit,
        durationMs: Math.max(0, execution.updatedAt - execution.preview.createdAt),
        ...(execution.visualEvidence
          ? {
              visualEvidenceCount: execution.visualEvidence.length,
              visualEvidenceSha256: digest(execution.visualEvidence)
            }
          : {}),
        ...(execution.pixelAudit
          ? {
              pixelAudit: {
                outcome: execution.pixelAudit.outcome,
                comparedTargets: execution.pixelAudit.comparedTargets,
                changedTargets: execution.pixelAudit.changedTargets,
                unavailableTargets: execution.pixelAudit.unavailableTargets,
                changedPixels: execution.pixelAudit.changedPixels
              }
            }
          : {}),
        ...(visualBaseline
          ? {
              visualBaselineId: visualBaseline.baselineId,
              visualBaselineEvidenceSha256: visualBaseline.visualEvidenceSha256,
              visualBaselineAcceptedAt: visualBaseline.acceptedAt,
              visualBaselineExpiresAt: visualBaseline.expiresAt,
              maxCorrectionRounds: visualBaseline.maxCorrectionRounds
            }
          : {}),
        ...(execution.visualBaselineComparison
          ? {
              visualComparisonBaselineId: execution.visualBaselineComparison.baselineId,
              visualComparisonTargetCount: execution.visualBaselineComparison.targets.length,
              visualComparisonChangedCount: execution.visualBaselineComparison.changedCount,
              visualComparisonSha256: digest(execution.visualBaselineComparison)
            }
          : {}),
        ...(execution.recovery
          ? {
              taskRecovery: {
                baselineId: execution.recovery.baselineId,
                sourceExecutionId: execution.recovery.sourceExecutionId,
                round: execution.recovery.round,
                maxCorrectionRounds: execution.recovery.maxCorrectionRounds,
                targetCount: execution.recovery.targetIds.length,
                consumed: execution.claimedAt !== undefined,
                ...(execution.recovery.rebind ? { reassociationRequested: true as const } : {}),
                ...(execution.recovery.rebind?.document
                  ? { documentReassociationRequested: true as const }
                  : {})
              }
            }
          : {}),
        ...(execution.visualCorrection
          ? {
              correctionAttempt: {
                authorizationId: execution.visualCorrection.authorizationId,
                baselineId: execution.visualCorrection.baselineId,
                sourceExecutionId: execution.visualCorrection.sourceExecutionId,
                round: execution.visualCorrection.round,
                maxCorrectionRounds: execution.visualCorrection.maxCorrectionRounds,
                targetCount: execution.visualCorrection.authorizedTargetIds.length,
                consumed: execution.claimedAt !== undefined
              }
            }
          : {}),
        ...(visualCorrectionAuthorization
          ? {
              visualCorrectionAuthorizationId: visualCorrectionAuthorization.authorizationId,
              visualCorrectionRound: visualCorrectionAuthorization.round,
              visualCorrectionMaxRounds: visualCorrectionAuthorization.maxCorrectionRounds,
              visualCorrectionTargetCount: visualCorrectionAuthorization.authorizedTargetIds.length,
              visualCorrectionComparisonSha256: visualCorrectionAuthorization.comparisonSha256,
              visualCorrectionExpiresAt: visualCorrectionAuthorization.expiresAt
            }
          : {}),
        ...(execution.errorCode ? { errorCode: execution.errorCode } : {})
      })
    } catch {
      // Audit cannot affect document-state transitions or leak host errors.
    }
  }

  async createPairing(binding: FigPluginRuntimeBinding): Promise<{
    ticketId: string
    pairingSecret: string
    expiresAt: number
    bridgeOrigin: string
    pluginId: string
    host: FigPluginRuntimeBinding['host']
    artifactSha256: string
  }> {
    this.enter()
    const snapshot = Object.freeze(
      parseFigPluginBridgeValue(figPluginRuntimeBindingSchema, binding)
    )
    if (this.tickets.size >= 32) throw new FigPluginBridgeError('BUSY')
    const ticketId = randomBytes(16).toString('hex')
    const ticket: Ticket = {
      binding: snapshot,
      secret: randomBytes(32).toString('hex'),
      expiresAt: this.clock() + TICKET_TTL,
      failures: 0,
      state: 'issuing'
    }
    // Reservation identity is a lifetime epoch: revoke/expiry/dispose removes it,
    // so an outstanding validator can never resurrect an old installation.
    this.tickets.set(ticketId, ticket)
    this.scheduleCleanup()
    const valid = await this.validate(snapshot)
    this.prune()
    if (this.closed || this.tickets.get(ticketId) !== ticket) {
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    if (!valid) {
      this.removeTicket(ticketId, ticket)
      this.scheduleCleanup()
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    ticket.state = 'ready'
    return {
      ticketId,
      pairingSecret: ticket.secret,
      expiresAt: ticket.expiresAt,
      bridgeOrigin: snapshot.bridgeOrigin,
      pluginId: snapshot.pluginId,
      host: snapshot.host,
      artifactSha256: snapshot.artifactSha256
    }
  }

  /** Main-only rollback for a ticket whose native-consent operation could not deliver it. */
  discardPairing(ticketId: string): void {
    if (this.closed) return
    const ticket = this.tickets.get(ticketId)
    if (ticket) this.removeTicket(ticketId, ticket)
    this.scheduleCleanup()
  }

  async redeem(input: FigPluginPairRequest): Promise<FigPluginPairResponse> {
    this.enter()
    let request: FigPluginPairRequest | undefined
    let ticket: Ticket | undefined
    try {
      // Count malformed secrets against a known ticket, without revealing its existence.
      if (isId(input?.ticketId)) ticket = this.tickets.get(input.ticketId)
      request = parseFigPluginBridgeValue(figPluginPairRequestSchema, input)
    } catch {
      // Authentication, schema failures and unknown IDs share one public error.
    }
    const matches = secretEquals(request?.pairingSecret, ticket?.secret)
    const authorized =
      request &&
      ticket &&
      ticket.state === 'ready' &&
      matches &&
      request.pluginId === ticket.binding.pluginId &&
      request.host === ticket.binding.host &&
      request.artifactSha256 === ticket.binding.artifactSha256
    if (this.failures.length >= 20 || !authorized || !ticket || !request) {
      if (this.failures.length < 20) this.failures.push(this.clock())
      if (!authorized && ticket?.state === 'ready' && ++ticket.failures >= 5) {
        // Locate by identity even if parsing the untrusted envelope failed.
        for (const [id, current] of this.tickets) {
          if (current === ticket) this.removeTicket(id, ticket)
        }
      }
      this.scheduleCleanup()
      throw new FigPluginBridgeError('UNAUTHORIZED')
    }
    const pending = [...this.tickets.values()].filter((item) => item.state === 'redeeming').length
    if (this.sessions.size + pending >= 16) throw new FigPluginBridgeError('BUSY')
    // Consume and reserve a session slot synchronously, before the first await.
    ticket.state = 'redeeming'
    const valid = await this.validate(ticket.binding)
    this.prune()
    if (this.closed || this.tickets.get(request.ticketId) !== ticket) {
      throw new FigPluginBridgeError('UNAUTHORIZED')
    }
    this.removeTicket(request.ticketId, ticket)
    if (!valid) {
      this.scheduleCleanup()
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    const now = this.clock()
    const session: Session = {
      id: randomBytes(16).toString('hex'),
      token: randomBytes(32).toString('hex'),
      binding: ticket.binding,
      expiresAt: now + SESSION_TTL,
      idleAt: now + IDLE_TTL,
      highWater: 0,
      requests: new Map(),
      preparing: 0
    }
    this.sessions.set(session.id, session)
    this.scheduleCleanup()
    return {
      protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
      sessionId: session.id,
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      idleTimeoutMs: IDLE_TTL
    }
  }

  async prepare(
    sessionId: string,
    sessionToken: string,
    input: FigPluginBridgePrepareRequest
  ): Promise<FigPluginBridgePrepareResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    if (this.preparing >= 16 || session.preparing >= 2) throw new FigPluginBridgeError('BUSY')
    // Bound retained inputs and coalesced validation waiters before parsing/stringifying.
    this.preparing += 1
    session.preparing += 1
    try {
      const request = parseFigPluginBridgeValue(figPluginBridgePrepareRequestSchema, input)
      if (request.hostContext && request.hostContext.host !== session.binding.host)
        throw new FigPluginBridgeError('INVALID_REQUEST')
      if (request.hostContext?.execution && !this.allowNativeWrite(session.binding))
        throw new FigPluginBridgeError('INVALID_REQUEST')
      const planning =
        request.featureId === 'plan-preview'
          ? { featureId: request.featureId, hostContext: request.hostContext! }
          : {}
      let canonical: string
      try {
        canonical = canonicalFigPluginJson({
          binding: session.binding,
          prompt: request.prompt,
          context: request.context,
          ...planning
        })
      } catch {
        throw new FigPluginBridgeError('INVALID_REQUEST')
      }
      const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
      await this.checkSession(session)
      this.requireCurrentSession(session)
      // All replay, ordering and admission decisions are atomic AFTER validation.
      const previous = session.requests.get(request.requestId)
      if (previous) {
        if (previous.sequence !== request.sequence || previous.digest !== digest) {
          throw new FigPluginBridgeError('INVALID_REQUEST')
        }
        // Replay the original prepare receipt; status() owns the current outcome.
        return { ...previous.response }
      }
      if (request.sequence <= session.highWater) throw new FigPluginBridgeError('INVALID_REQUEST')
      const receiptCount = [...this.sessions.values()].reduce(
        (sum, item) => sum + item.requests.size,
        0
      )
      if (
        session.requests.size >= 64 ||
        receiptCount >= 256 ||
        this.calls.size >= 32 ||
        [...this.calls.values()].some((call) => call.session === session && active(call))
      ) {
        throw new FigPluginBridgeError('BUSY')
      }
      const callId = randomBytes(16).toString('hex')
      const expiresAt = Math.min(this.clock() + CALL_TTL, session.expiresAt)
      const response: FigPluginBridgePrepareResponse = {
        protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
        callId,
        status: 'awaiting-approval',
        expiresAt
      }
      const receipt: Receipt = {
        sequence: request.sequence,
        requestId: request.requestId,
        digest,
        response
      }
      const preview: FigPluginBridgePreview = {
        callId,
        pluginId: session.binding.pluginId,
        host: session.binding.host,
        projectId: session.binding.projectId,
        profileId: session.binding.profileId,
        profileRevision: session.binding.profileRevision,
        context: request.context,
        prompt: request.prompt,
        expiresAt,
        payloadSha256: digest,
        estimatedInputTokens: Math.ceil(Buffer.byteLength(canonical, 'utf8') / 4),
        ...planning
      }
      this.calls.set(callId, {
        session,
        receipt,
        preview,
        ...(planning.hostContext ? { hostContext: planning.hostContext } : {}),
        status: { protocol: FIGPLUGIN_BRIDGE_PROTOCOL, callId, status: 'awaiting-approval' }
      })
      session.requests.set(request.requestId, receipt)
      session.highWater = request.sequence
      this.scheduleCleanup()
      return { ...response }
    } finally {
      // Revocation/expiry cannot free capacity while the old validation is still pending.
      session.preparing -= 1
      this.preparing -= 1
    }
  }

  async status(
    sessionId: string,
    sessionToken: string,
    callId: string
  ): Promise<FigPluginBridgeStatusResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    this.ownedReceipt(session, callId)
    await this.checkSession(session)
    this.requireCurrentSession(session)
    this.ownedReceipt(session, callId)
    const call = this.calls.get(callId)
    return call
      ? { ...call.status }
      : { protocol: FIGPLUGIN_BRIDGE_PROTOCOL, callId, status: 'failed', errorCode: 'EXPIRED' }
  }

  async cancel(sessionId: string, sessionToken: string, callId: string): Promise<void> {
    const session = this.authenticate(sessionId, sessionToken)
    this.ownedReceipt(session, callId)
    const call = this.calls.get(callId)
    if (call && active(call)) this.terminate(call, 'CANCELLED')
    else if (call?.execution) this.terminateExecution(call.execution, 'CANCELLED')
    if (call) {
      const children = this.allPlanExecutions().filter((execution) => execution.call === call)
      const ids = new Set(children.map((execution) => execution.executionId))
      for (const execution of children) this.terminateExecution(execution, 'CANCELLED')
      for (const [id, record] of [...this.visualCorrectionAuthorizations])
        if (ids.has(record.value.sourceExecutionId))
          this.removeVisualCorrectionAuthorization(id, 'CANCELLED')
    }
    this.scheduleCleanup()
  }

  closeSession(sessionId: string, sessionToken: string): void {
    const session = this.authenticate(sessionId, sessionToken)
    this.removeSession(session, 'CANCELLED')
    this.scheduleCleanup()
  }

  listPreviews(): FigPluginBridgePreview[] {
    this.enter()
    return [...this.calls.values()]
      .filter((call) => call.status.status === 'awaiting-approval' && call.preview)
      .map((call) => structuredClone(call.preview!))
  }

  listPlanExecutions(): FigPluginExecutionPreview[] {
    this.enter()
    return this.allPlanExecutions().map((execution) => this.executionPreview(execution))
  }

  listPlanStatuses(): FigPluginExecutionStatus[] {
    this.enter()
    return this.allPlanExecutions().map((execution) => this.executionStatus(execution))
  }

  listVisualBaselines(): FigPluginVisualBaseline[] {
    this.enter()
    return [...this.visualBaselines.values()]
      .map((record) => structuredClone(record.value))
      .sort((left, right) => right.acceptedAt - left.acceptedAt)
  }

  listVisualCorrectionAuthorizations(): FigPluginVisualCorrectionAuthorization[] {
    this.enter()
    return [...this.visualCorrectionAuthorizations.values()]
      .map((record) => structuredClone(record.value))
      .sort((left, right) => right.authorizedAt - left.authorizedAt)
  }

  async acceptVisualBaseline(
    executionId: string,
    visualEvidenceSha256: string
  ): Promise<FigPluginVisualBaseline> {
    this.enter()
    const execution = this.findExecution(executionId)
    const check = (): { evidence: FigPluginVisualEvidence[]; sha256: string } => {
      const evidence = execution.visualEvidence
      const sha256 = evidence ? digest(evidence) : undefined
      if (
        this.calls.get(execution.call.receipt.response.callId) !== execution.call ||
        this.sessions.get(execution.call.session.id) !== execution.call.session ||
        execution.state !== 'completed' ||
        execution.effect !== 'applied' ||
        execution.preview.visualAudit !== 'hash-only' ||
        execution.visualCorrection !== undefined ||
        execution.recovery !== undefined ||
        !evidence ||
        !sha256 ||
        !secretEquals(visualEvidenceSha256, sha256)
      )
        throw new FigPluginBridgeError('INVALID_REQUEST')
      return { evidence, sha256 }
    }
    check()
    await this.checkSession(execution.call.session)
    const checked = check()
    const previous = [...this.visualBaselines.values()].find(
      (record) => record.value.sourceExecutionId === execution.executionId
    )
    if (previous) {
      if (!secretEquals(visualEvidenceSha256, previous.value.visualEvidenceSha256))
        throw new FigPluginBridgeError('INVALID_REQUEST')
      return structuredClone(previous.value)
    }
    const recoveryScope = captureTaskRecoveryScope(execution.plan, execution.context)
    const acceptedAt = this.clock()
    const baseline = figPluginVisualBaselineSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      baselineId: randomBytes(16).toString('hex'),
      sourceExecutionId: execution.executionId,
      pluginId: execution.call.session.binding.pluginId,
      host: execution.call.session.binding.host,
      projectId: execution.call.session.binding.projectId,
      documentId: execution.context.documentId,
      scopeId: execution.context.scopeId,
      captureId: execution.context.captureId,
      planSha256: execution.planSha256,
      contextSha256: execution.contextSha256,
      visualEvidenceSha256: checked.sha256,
      adapterVersion: execution.preview.adapterVersion,
      targets: checked.evidence.map((item) => ({
        targetId: item.targetId,
        accepted: item.after
      })),
      ...(this.checkpoints ? { storage: 'encrypted-local' } : {}),
      acceptedAt,
      expiresAt: acceptedAt + FIGPLUGIN_VISUAL_BASELINE_TTL_MS,
      correctionRoundsUsed: 0,
      maxCorrectionRounds: FIGPLUGIN_VISUAL_MAX_CORRECTION_ROUNDS
    })
    const saved: VisualBaselineRecord = {
      value: baseline,
      binding: Object.freeze({ ...execution.call.session.binding }),
      recoveryPlan: structuredClone(execution.plan),
      recoveryScope
    }
    // No await between durable commit and in-memory acceptance. Failure is not success.
    if (this.checkpoints) {
      try {
        this.checkpoints.save(saved as SavedCheckpoint)
      } catch {
        throw new FigPluginBridgeError('UPSTREAM_FAILED')
      }
    }
    const scopeKey = visualBaselineScopeKey(baseline)
    for (const [id, record] of this.visualBaselines) {
      if (visualBaselineScopeKey(record.value) === scopeKey) this.removeVisualBaseline(id)
    }
    while (this.visualBaselines.size >= 16) {
      const oldest = this.visualBaselines.keys().next().value
      if (!oldest) break
      this.removeVisualBaseline(oldest)
    }
    this.visualBaselines.set(baseline.baselineId, saved)
    this.recordExecutionAudit(execution, baseline)
    this.scheduleCleanup()
    return structuredClone(baseline)
  }

  async authorizeVisualCorrection(
    executionId: string,
    baselineId: string,
    visualEvidenceSha256: string
  ): Promise<FigPluginVisualCorrectionAuthorization> {
    this.enter()
    const execution = this.findExecution(executionId)
    const check = (): {
      baseline: FigPluginVisualBaseline
      comparison: FigPluginVisualBaselineComparison
      comparisonSha256: string
    } => {
      const comparison = execution.visualBaselineComparison
      const baselineRecord = isId(baselineId) ? this.visualBaselines.get(baselineId) : undefined
      const baseline = baselineRecord?.value
      const evidenceSha256 = execution.visualEvidence ? digest(execution.visualEvidence) : undefined
      if (
        this.calls.get(execution.call.receipt.response.callId) !== execution.call ||
        this.sessions.get(execution.call.session.id) !== execution.call.session ||
        execution.state !== 'completed' ||
        execution.effect !== 'applied' ||
        execution.preview.visualAudit !== 'hash-only' ||
        !comparison ||
        execution.pixelAudit?.outcome === 'match' ||
        comparison.exactMatch ||
        comparison.changedCount < 1 ||
        comparison.baselineId !== baselineId ||
        comparison.visualEvidenceSha256 !== evidenceSha256 ||
        !secretEquals(visualEvidenceSha256, evidenceSha256) ||
        !baseline ||
        baseline.expiresAt <= this.clock() ||
        baseline.visualEvidenceSha256 !== comparison.baselineEvidenceSha256 ||
        baseline.adapterVersion !== execution.preview.adapterVersion ||
        visualBaselineScopeKey(baseline) !==
          visualBaselineScopeKey({
            pluginId: execution.call.session.binding.pluginId,
            host: execution.call.session.binding.host,
            projectId: execution.call.session.binding.projectId,
            documentId: execution.context.documentId,
            scopeId: execution.context.scopeId
          })
      )
        throw new FigPluginBridgeError('INVALID_REQUEST')
      // A consumed comparison cannot mint another attempt, even after the child ends.
      // A further round must be based on the completed child's new evidence.
      if (
        [...this.visualCorrectionExecutions.values()].some(
          (child) =>
            child.visualCorrection?.sourceExecutionId === execution.executionId &&
            child.claimedAt !== undefined
        )
      )
        throw new FigPluginBridgeError('INVALID_REQUEST')
      return { baseline, comparison, comparisonSha256: digest(comparison) }
    }
    let checked = check()
    await this.checkSession(execution.call.session)
    checked = check()
    if (
      this.allPlanExecutions().some(
        (child) =>
          child.recovery?.baselineId === checked.baseline.baselineId &&
          !terminalExecution.has(child.state)
      )
    )
      throw new FigPluginBridgeError('BUSY')
    const existing = [...this.visualCorrectionAuthorizations.values()].find(
      (record) => record.value.baselineId === checked.baseline.baselineId
    )
    if (existing) {
      if (
        existing.value.sourceExecutionId === execution.executionId &&
        existing.value.visualEvidenceSha256 === visualEvidenceSha256 &&
        existing.value.comparisonSha256 === checked.comparisonSha256
      )
        return structuredClone(existing.value)
      throw new FigPluginBridgeError('BUSY')
    }
    if (
      [...this.visualCorrectionExecutions.values()].some(
        (child) =>
          child.visualCorrection?.baselineId === checked.baseline.baselineId &&
          !terminalExecution.has(child.state)
      )
    )
      throw new FigPluginBridgeError('BUSY')
    const round = checked.baseline.correctionRoundsUsed + 1
    if (round > checked.baseline.maxCorrectionRounds) throw new FigPluginBridgeError('DENIED')
    const authorizedAt = this.clock()
    const expiresAt = Math.min(
      authorizedAt + FIGPLUGIN_VISUAL_CORRECTION_AUTHORIZATION_TTL_MS,
      checked.baseline.expiresAt,
      execution.preview.expiresAt,
      execution.call.session.expiresAt
    )
    if (expiresAt <= authorizedAt) throw new FigPluginBridgeError('EXPIRED')
    const authorization = figPluginVisualCorrectionAuthorizationSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      authorizationId: randomBytes(16).toString('hex'),
      baselineId: checked.baseline.baselineId,
      sourceExecutionId: execution.executionId,
      pluginId: execution.call.session.binding.pluginId,
      host: execution.call.session.binding.host,
      projectId: execution.call.session.binding.projectId,
      documentId: execution.context.documentId,
      scopeId: execution.context.scopeId,
      captureId: execution.context.captureId,
      adapterVersion: execution.preview.adapterVersion,
      baselineEvidenceSha256: checked.comparison.baselineEvidenceSha256,
      visualEvidenceSha256,
      comparisonSha256: checked.comparisonSha256,
      visualTargetIds: checked.baseline.targets.map((target) => target.targetId).sort(),
      authorizedTargetIds: checked.comparison.targets
        .filter((target) => target.changed)
        .map((target) => target.targetId)
        .sort(),
      round,
      maxCorrectionRounds: checked.baseline.maxCorrectionRounds,
      authorizedAt,
      expiresAt,
      state: 'authorized'
    })
    while (this.visualCorrectionAuthorizations.size >= 16) {
      const oldest = this.visualCorrectionAuthorizations.keys().next().value
      if (!oldest) break
      this.visualCorrectionAuthorizations.delete(oldest)
    }
    this.visualCorrectionAuthorizations.set(authorization.authorizationId, {
      value: authorization,
      binding: Object.freeze({ ...execution.call.session.binding })
    })
    this.recordExecutionAudit(execution, undefined, authorization)
    this.scheduleCleanup()
    return structuredClone(authorization)
  }

  private recoveryAuthority(execution: PlanExecution): VisualBaselineRecord | undefined {
    if (!execution.recovery) return undefined
    const record = this.visualBaselines.get(execution.recovery.baselineId)
    if (
      !record ||
      record.value.expiresAt <= this.clock() ||
      record.value.sourceExecutionId !== execution.recovery.sourceExecutionId ||
      record.value.correctionRoundsUsed + 1 !== execution.recovery.round ||
      (execution.recovery.rebind
        ? record.recoveryScope.recoveryIdentity !== execution.recovery.rebind.previousIdentity ||
          execution.context.recoveryIdentity !== execution.recovery.rebind.nextIdentity
        : record.recoveryScope.recoveryIdentity !== execution.context.recoveryIdentity) ||
      canonicalFigPluginJson(record.binding) !==
        canonicalFigPluginJson(execution.call.session.binding)
    )
      throw new FigPluginBridgeError('EXPIRED')
    if (execution.recovery.rebind) {
      try {
        const expected = createTaskRecoveryRebind(
          record.recoveryScope,
          execution.context,
          execution.recovery.rebind.document !== undefined
        )
        if (canonicalFigPluginJson(expected) !== canonicalFigPluginJson(execution.recovery.rebind))
          throw new Error('STALE_RECOVERY_SCOPE')
      } catch {
        throw new FigPluginBridgeError('EXPIRED')
      }
    }
    return record
  }

  async prepareTaskRecovery(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginTaskRecoveryPrepareResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    if (this.preparing >= 16 || session.preparing >= 2) throw new FigPluginBridgeError('BUSY')
    this.preparing++
    session.preparing++
    try {
      const request = parseFigPluginBridgeValue(figPluginTaskRecoveryPrepareRequestSchema, input)
      const fingerprint = digest({ purpose: 'task-recovery', binding: session.binding, request })
      await this.checkSession(session)
      this.requireCurrentSession(session)
      const previous = session.requests.get(request.requestId)
      if (previous) {
        if (
          previous.sequence !== request.sequence ||
          previous.digest !== fingerprint ||
          !previous.recoveryResponse
        )
          throw new FigPluginBridgeError('INVALID_REQUEST')
        return structuredClone(previous.recoveryResponse)
      }
      if (request.sequence <= session.highWater || !this.allowNativeWrite(session.binding))
        throw new FigPluginBridgeError('INVALID_REQUEST')
      const context = request.hostContext
      if (request.rebindBaselineId && !this.checkpoints) throw new FigPluginBridgeError('EXPIRED')
      if (this.checkpoints) {
        let persisted: SavedCheckpoint | undefined
        try {
          persisted = request.rebindBaselineId
            ? this.checkpoints.findForRebind(
                session.binding,
                context,
                request.rebindBaselineId,
                request.reopenDocument
              )
            : this.checkpoints.find(session.binding, context)
        } catch {
          throw new FigPluginBridgeError('UPSTREAM_FAILED')
        }
        if (persisted) {
          // Validate current selection, host identity, locks and capabilities before rehydration.
          try {
            const reassociation = request.rebindBaselineId
              ? createTaskRecoveryRebind(
                  persisted.recoveryScope,
                  context,
                  request.reopenDocument === true
                )
              : undefined
            prepareTaskRecoveryPlan(
              persisted.recoveryPlan,
              reassociation
                ? applyTaskRecoveryRebind(persisted.recoveryScope, reassociation)
                : persisted.recoveryScope,
              context
            )
          } catch {
            throw new FigPluginBridgeError('INVALID_REQUEST')
          }
          const previous = this.visualBaselines.get(persisted.value.baselineId)
          if (
            previous &&
            previous.value.correctionRoundsUsed > persisted.value.correctionRoundsUsed
          )
            throw new FigPluginBridgeError('UPSTREAM_FAILED')
          if (!previous && this.visualBaselines.size >= 16) throw new FigPluginBridgeError('BUSY')
          this.visualBaselines.set(persisted.value.baselineId, persisted)
        } else {
          // An explicit ID must resolve exactly; never fall back to a different checkpoint.
          if (request.rebindBaselineId) throw new FigPluginBridgeError('EXPIRED')
          // Deletion/revocation on disk cannot fall back to a stale in-memory checkpoint.
          for (const [id, item] of this.visualBaselines)
            if (
              item.value.storage === 'encrypted-local' &&
              item.value.pluginId === session.binding.pluginId &&
              item.value.projectId === session.binding.projectId &&
              item.value.documentId === context.documentId &&
              item.value.scopeId === context.scopeId
            )
              this.removeVisualBaseline(id)
        }
      }
      const record = request.rebindBaselineId
        ? this.visualBaselines.get(request.rebindBaselineId)
        : [...this.visualBaselines.values()].find(
            (record) =>
              record.value.host === context.host &&
              record.value.documentId === context.documentId &&
              record.value.scopeId === context.scopeId &&
              record.value.projectId === session.binding.projectId &&
              record.value.pluginId === session.binding.pluginId &&
              canonicalFigPluginJson(record.binding) === canonicalFigPluginJson(session.binding)
          )
      if (!record || record.value.expiresAt <= this.clock())
        throw new FigPluginBridgeError('EXPIRED')
      if (
        session.requests.size >= 64 ||
        [...this.sessions.values()].reduce((sum, item) => sum + item.requests.size, 0) >= 256 ||
        this.calls.size >= 32 ||
        [...this.calls.values()].some((call) => call.session === session && active(call)) ||
        this.allPlanExecutions().some(
          (execution) =>
            !terminalExecution.has(execution.state) &&
            (execution.recovery?.baselineId === record.value.baselineId ||
              execution.visualCorrection?.baselineId === record.value.baselineId)
        ) ||
        [...this.visualCorrectionAuthorizations.values()].some(
          (auth) => auth.value.baselineId === record.value.baselineId
        )
      )
        throw new FigPluginBridgeError('BUSY')
      const rebind = request.rebindBaselineId
        ? createTaskRecoveryRebind(record.recoveryScope, context, request.reopenDocument === true)
        : undefined
      if (request.rebindBaselineId && record.value.baselineId !== request.rebindBaselineId)
        throw new FigPluginBridgeError('INVALID_REQUEST')
      let prepared: ReturnType<typeof prepareTaskRecoveryPlan>
      try {
        prepared = prepareTaskRecoveryPlan(
          record.recoveryPlan,
          rebind ? applyTaskRecoveryRebind(record.recoveryScope, rebind) : record.recoveryScope,
          context
        )
      } catch {
        throw new FigPluginBridgeError('INVALID_REQUEST')
      }
      const callId = randomBytes(16).toString('hex')
      const expiresAt = Math.min(this.clock() + CALL_TTL, session.expiresAt, record.value.expiresAt)
      const receipt: Receipt = {
        sequence: request.sequence,
        requestId: request.requestId,
        digest: fingerprint,
        response: {
          protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
          callId,
          status: 'awaiting-approval',
          expiresAt
        }
      }
      let response: FigPluginTaskRecoveryPrepareResponse
      if (prepared.unchanged) {
        response = { protocol: 1, status: 'unchanged', baselineId: record.value.baselineId }
      } else {
        const round = record.value.correctionRoundsUsed + 1
        if (round > record.value.maxCorrectionRounds) throw new FigPluginBridgeError('DENIED')
        const recovery: FigPluginTaskRecovery = {
          baselineId: record.value.baselineId,
          sourceExecutionId: record.value.sourceExecutionId,
          requestId: request.requestId,
          round,
          maxCorrectionRounds: 3,
          targetIds: [...record.recoveryScope.targetIds],
          ...(rebind ? { rebind } : {})
        }
        const call: Call = {
          session,
          receipt,
          hostContext: structuredClone(context),
          status: { protocol: FIGPLUGIN_BRIDGE_PROTOCOL, callId, status: 'completed', content: '' }
        }
        const execution = this.registerPlanExecution(
          call,
          JSON.stringify({ plan: prepared.plan }),
          context,
          recovery
        )
        if (!execution) throw new FigPluginBridgeError('INVALID_REQUEST')
        response = {
          protocol: 1,
          status: 'prepared',
          callId,
          executionId: execution.executionId,
          expiresAt,
          recovery
        }
        this.calls.set(callId, call)
      }
      receipt.recoveryResponse = figPluginTaskRecoveryPrepareResponseSchema.parse(response)
      session.requests.set(request.requestId, receipt)
      session.highWater = request.sequence
      this.scheduleCleanup()
      return structuredClone(response)
    } finally {
      this.preparing--
      session.preparing--
    }
  }

  async prepareVisualCorrection(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginVisualCorrectionPrepareResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginVisualCorrectionPrepareRequestSchema, input)
    const source = this.ownedExecution(session, request.sourceExecutionId)
    await this.checkSession(session)
    this.requireCurrentSession(session)
    if (
      source.state !== 'completed' ||
      source.effect !== 'applied' ||
      source.preview.visualAudit !== 'hash-only' ||
      !source.visualBaselineComparison ||
      source.visualBaselineComparison.exactMatch ||
      source.visualBaselineComparison.changedCount < 1
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')

    const authorizationRecord = [...this.visualCorrectionAuthorizations.values()].find(
      (record) => record.value.sourceExecutionId === source.executionId
    )
    const prepared = [...this.visualCorrectionExecutions.values()].find(
      (execution) =>
        execution.visualCorrection?.sourceExecutionId === source.executionId &&
        (authorizationRecord
          ? execution.visualCorrection.authorizationId === authorizationRecord.value.authorizationId
          : execution.claimedAt !== undefined)
    )
    if (prepared) {
      if (request.hostContext && digest(request.hostContext) !== prepared.contextSha256)
        throw new FigPluginBridgeError('INVALID_REQUEST')
      this.expireExecution(prepared)
      return figPluginVisualCorrectionPrepareResponseSchema.parse(
        terminalExecution.has(prepared.state)
          ? {
              protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
              status: 'terminal',
              state: prepared.state,
              ...(prepared.errorCode ? { errorCode: prepared.errorCode } : {})
            }
          : {
              protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
              status: 'prepared',
              executionId: prepared.executionId,
              callId: prepared.call.receipt.response.callId,
              state: prepared.state,
              expiresAt: prepared.preview.expiresAt
            }
      )
    }

    if (!authorizationRecord) {
      const baseline = this.visualBaselines.get(source.visualBaselineComparison.baselineId)?.value
      if (!baseline || baseline.expiresAt <= this.clock())
        return figPluginVisualCorrectionPrepareResponseSchema.parse({
          protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
          status: 'terminal',
          state: 'expired',
          errorCode: 'EXPIRED'
        })
      if (baseline.correctionRoundsUsed >= baseline.maxCorrectionRounds)
        return figPluginVisualCorrectionPrepareResponseSchema.parse({
          protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
          status: 'terminal',
          state: 'denied',
          errorCode: 'DENIED'
        })
      return figPluginVisualCorrectionPrepareResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: source.preview.expiresAt > this.clock() ? 'pending' : 'terminal',
        ...(source.preview.expiresAt > this.clock()
          ? { expiresAt: source.preview.expiresAt }
          : { state: 'expired', errorCode: 'EXPIRED' })
      })
    }
    const authorization = authorizationRecord.value
    const baselineRecord = this.visualBaselines.get(authorization.baselineId)
    if (
      authorization.expiresAt <= this.clock() ||
      authorization.sourceExecutionId !== source.executionId ||
      authorization.visualEvidenceSha256 !== source.visualBaselineComparison.visualEvidenceSha256 ||
      authorization.comparisonSha256 !== digest(source.visualBaselineComparison) ||
      authorization.baselineEvidenceSha256 !==
        source.visualBaselineComparison.baselineEvidenceSha256 ||
      !baselineRecord ||
      baselineRecord.value.expiresAt <= this.clock() ||
      baselineRecord.value.visualEvidenceSha256 !== authorization.baselineEvidenceSha256 ||
      canonicalFigPluginJson(authorization.visualTargetIds) !==
        canonicalFigPluginJson(
          baselineRecord.value.targets.map((target) => target.targetId).sort()
        ) ||
      baselineRecord.value.correctionRoundsUsed + 1 !== authorization.round ||
      canonicalFigPluginJson(authorizationRecord.binding) !==
        canonicalFigPluginJson(session.binding)
    ) {
      this.removeVisualCorrectionAuthorization(authorization.authorizationId, 'EXPIRED')
      return figPluginVisualCorrectionPrepareResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: 'terminal',
        state: 'expired',
        errorCode: 'EXPIRED'
      })
    }
    if (!request.hostContext)
      return figPluginVisualCorrectionPrepareResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: 'authorized',
        authorization: structuredClone(authorization)
      })

    const context = request.hostContext
    const baselineTargetIds = baselineRecord.value.targets.map((target) => target.targetId).sort()
    const selectedIds = [...(context.selectedIds ?? [])].sort()
    if (
      context.host !== session.binding.host ||
      context.documentId !== authorization.documentId ||
      context.scopeId !== authorization.scopeId ||
      context.captureId !== authorization.authorizationId ||
      context.recoveryIdentity !== baselineRecord.recoveryScope.recoveryIdentity ||
      context.execution?.mode !== 'native-write' ||
      context.execution.adapterVersion !== authorization.adapterVersion ||
      context.execution.visualAudit !== 'hash-only' ||
      !this.allowNativeWrite(session.binding) ||
      canonicalFigPluginJson(selectedIds) !== canonicalFigPluginJson(baselineTargetIds)
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')

    const authorizedTargets = new Set(authorization.authorizedTargetIds)
    const correctionPlan: HostPlan = {
      ...structuredClone(baselineRecord.recoveryPlan),
      captureId: context.captureId,
      steps: baselineRecord.recoveryPlan.steps
        .filter((step) => authorizedTargets.has(step.targetId))
        .map((step) => structuredClone(step))
    }
    const planTargets = [...new Set(correctionPlan.steps.map((step) => step.targetId))].sort()
    if (
      correctionPlan.steps.length < 1 ||
      canonicalFigPluginJson(planTargets) !==
        canonicalFigPluginJson(authorization.authorizedTargetIds)
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')

    let checked: HostPlanningPreview
    try {
      checked = createHostPlanningPreview(JSON.stringify(correctionPlan), context)
    } catch {
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    if (
      checked.executable !== true ||
      !checked.execution ||
      checked.execution.visualAudit !== 'hash-only' ||
      checked.execution.adapterVersion !== authorization.adapterVersion
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    if (this.visualCorrectionExecutions.size >= 16) throw new FigPluginBridgeError('BUSY')

    const createdAt = this.clock()
    const expiresAt = Math.min(authorization.expiresAt, source.preview.expiresAt, session.expiresAt)
    if (expiresAt <= createdAt) {
      this.removeVisualCorrectionAuthorization(authorization.authorizationId, 'EXPIRED')
      throw new FigPluginBridgeError('EXPIRED')
    }
    const visualCorrection = this.correctionAttempt(authorization)
    const executionId = randomBytes(16).toString('hex')
    const planSha256 = digest(checked.plan)
    const contextSha256 = digest(context)
    const preview = figPluginExecutionPreviewSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      executionId,
      callId: source.call.receipt.response.callId,
      pluginId: session.binding.pluginId,
      host: session.binding.host,
      projectId: session.binding.projectId,
      documentId: context.documentId,
      scopeId: context.scopeId,
      captureId: context.captureId,
      plan: checked.plan,
      planSha256,
      contextSha256,
      adapterVersion: checked.execution.adapterVersion,
      rollback: checked.execution.rollback,
      visualAudit: checked.execution.visualAudit,
      risk: checked.risk,
      differences: checked.differences,
      visualCorrection,
      state: 'awaiting-approval',
      requiresWriteApproval: true,
      createdAt,
      expiresAt
    })
    const previewSha256 = digest({
      plan: checked.plan,
      differences: checked.differences,
      risk: checked.risk,
      planSha256,
      contextSha256,
      adapterVersion: checked.execution.adapterVersion,
      rollback: checked.execution.rollback,
      visualAudit: checked.execution.visualAudit,
      visualCorrection
    })
    const execution: PlanExecution = {
      executionId,
      actionId: executionId,
      call: source.call,
      plan: checked.plan,
      context: structuredClone(context),
      preview,
      planSha256,
      contextSha256,
      previewSha256,
      state: 'awaiting-approval',
      completed: 0,
      effect: 'none',
      cursor: 0,
      progress: [],
      visualTargetIds: baselineTargetIds,
      visualCorrection,
      updatedAt: createdAt
    }
    authorizationRecord.preparedExecutionId = executionId
    this.visualCorrectionExecutions.set(executionId, execution)
    this.recordExecutionAudit(execution)
    this.scheduleCleanup()
    return figPluginVisualCorrectionPrepareResponseSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      status: 'prepared',
      executionId,
      callId: source.call.receipt.response.callId,
      state: execution.state,
      expiresAt
    })
  }

  cancelVisualCorrectionAuthorization(authorizationId: string): void {
    this.enter()
    if (!isId(authorizationId)) throw new FigPluginBridgeError('INVALID_REQUEST')
    this.removeVisualCorrectionAuthorization(authorizationId, 'CANCELLED')
    this.scheduleCleanup()
  }

  async approve(callId: string, payloadSha256: string): Promise<void> {
    this.enter()
    const call = this.mainCall(callId)
    this.checkApproval(call, payloadSha256)
    await this.checkSession(call.session)
    this.requireCurrentSession(call.session)
    this.checkApproval(call, payloadSha256)
    if (this.executing >= 8) throw new FigPluginBridgeError('BUSY')
    const preview = structuredClone(call.preview!)
    const controller = new AbortController()
    call.controller = controller
    call.deadline = this.clock() + this.callTimeout
    call.status = { protocol: FIGPLUGIN_BRIDGE_PROTOCOL, callId, status: 'running' }
    this.executing += 1
    this.scheduleCleanup()
    // No await between the last lifetime/state check, single-use transition and invoke.
    void this.execute(call, preview, controller)
  }

  async approvePlan(
    executionId: string,
    planSha256: string,
    acknowledgeRecoveryRebind = false
  ): Promise<void> {
    this.enter()
    const execution = this.findExecution(executionId)
    if (execution.recovery?.rebind && !acknowledgeRecoveryRebind)
      throw new FigPluginBridgeError('DENIED')
    const check = (): void => {
      if (
        this.calls.get(execution.call.receipt.response.callId) !== execution.call ||
        this.sessions.get(execution.call.session.id) !== execution.call.session ||
        execution.state !== 'awaiting-approval' ||
        execution.call.status.status !== 'completed' ||
        execution.preview.expiresAt <= this.clock() ||
        !secretEquals(planSha256, execution.planSha256)
      )
        throw new FigPluginBridgeError(
          execution.preview.expiresAt <= this.clock() ? 'EXPIRED' : 'INVALID_REQUEST'
        )
      if (execution.visualCorrection) this.correctionAuthority(execution)
      if (execution.recovery) this.recoveryAuthority(execution)
    }
    check()
    await this.checkSession(execution.call.session)
    check()
    execution.state = 'approved'
    execution.updatedAt = this.clock()
    this.recordExecutionAudit(execution)
    this.scheduleCleanup()
  }

  denyPlan(executionId: string): void {
    this.enter()
    const execution = this.findExecution(executionId)
    if (terminalExecution.has(execution.state)) return
    execution.state = 'denied'
    execution.errorCode = 'DENIED'
    execution.updatedAt = this.clock()
    this.recordExecutionAudit(execution)
    if (execution.visualCorrection)
      this.removeVisualCorrectionAuthorization(
        execution.visualCorrection.authorizationId,
        'CANCELLED'
      )
    this.scheduleCleanup()
  }

  cancelPlan(executionId: string): void {
    this.enter()
    const execution = this.findExecution(executionId)
    if (terminalExecution.has(execution.state)) return
    execution.state = 'cancelled'
    execution.errorCode = 'CANCELLED'
    execution.updatedAt = this.clock()
    this.recordExecutionAudit(execution)
    if (execution.visualCorrection)
      this.removeVisualCorrectionAuthorization(
        execution.visualCorrection.authorizationId,
        'CANCELLED'
      )
    this.scheduleCleanup()
  }

  async planStatus(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginExecutionStatus> {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginExecutionStatusRequestSchema, input)
    this.ownedReceipt(session, request.callId)
    await this.checkSession(session)
    const call = this.calls.get(request.callId)
    if (!call) throw new FigPluginBridgeError('INVALID_REQUEST')
    const execution = this.executionForCall(call, request.executionId)
    this.expireExecution(execution)
    this.checkDocumentWrite(execution)
    return this.executionStatus(execution)
  }

  async claimPlan(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginExecutionClaimResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginExecutionClaimRequestSchema, input)
    this.ownedReceipt(session, request.callId)
    await this.checkSession(session)
    const call = this.calls.get(request.callId)
    if (!call) throw new FigPluginBridgeError('INVALID_REQUEST')
    const execution = this.executionForCall(call, request.executionId)
    this.expireExecution(execution)
    this.checkDocumentWrite(execution)
    if (
      execution.state === 'claimed' ||
      execution.state === 'executing' ||
      execution.state === 'readback'
    ) {
      if (!execution.intent) throw new FigPluginBridgeError('UPSTREAM_FAILED')
      return figPluginExecutionClaimResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: 'ready',
        intent: execution.intent
      })
    }
    if (execution.state !== 'approved')
      return figPluginExecutionClaimResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: terminalExecution.has(execution.state) ? 'terminal' : 'pending',
        state: execution.state,
        ...(execution.errorCode ? { errorCode: execution.errorCode } : {})
      })

    let recoveryAuthority: VisualBaselineRecord | undefined
    let correctionAuthority:
      | {
          authorizationRecord: VisualCorrectionAuthorizationRecord
          baselineRecord: VisualBaselineRecord
        }
      | undefined
    try {
      correctionAuthority = this.correctionAuthority(execution)
      recoveryAuthority = this.recoveryAuthority(execution)
    } catch (error) {
      if (
        (!execution.visualCorrection && !execution.recovery) ||
        !(error instanceof FigPluginBridgeError)
      )
        throw error
      execution.state = 'expired'
      execution.errorCode = 'EXPIRED'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
      return figPluginExecutionClaimResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: 'terminal',
        state: execution.state,
        errorCode: execution.errorCode
      })
    }

    const intent = figPluginExecutionIntentSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      purpose: 'execute-host-plan',
      executionId: execution.executionId,
      callId: call.receipt.response.callId,
      pluginId: session.binding.pluginId,
      host: session.binding.host,
      documentId: execution.context.documentId,
      scopeId: execution.context.scopeId,
      captureId: execution.context.captureId,
      plan: execution.plan,
      planSha256: execution.planSha256,
      expiresAt: execution.preview.expiresAt,
      adapterVersion: execution.preview.adapterVersion,
      actionId: execution.actionId,
      ...(execution.recovery ? { recovery: structuredClone(execution.recovery) } : {}),
      ...(execution.visualTargetIds ? { visualTargetIds: [...execution.visualTargetIds] } : {}),
      ...(execution.visualCorrection
        ? { visualCorrection: structuredClone(execution.visualCorrection) }
        : {})
    })

    // Deliberately omit plugin/project/session/scope/instance from the exclusion key:
    // those can differ while the same native document is being changed. A collision
    // conservatively serializes (Figma root IDs are not globally unique file IDs).
    const reservation: NativeWriteReservation = {
      resourceKey: digest(['native-document-write-v1', intent.host, intent.documentId]),
      actionId: intent.actionId,
      fingerprint: digest(intent),
      expiresAt: intent.expiresAt
    }
    let acquired: boolean
    try {
      acquired = this.writes.reserve(reservation)
    } catch {
      throw new FigPluginBridgeError('UPSTREAM_FAILED')
    }
    if (!acquired)
      return figPluginExecutionClaimResponseSchema.parse({
        protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
        status: 'pending',
        state: 'approved'
      })
    execution.writeReservation = reservation

    const durableRecord = recoveryAuthority ?? correctionAuthority?.baselineRecord
    const durableRound = execution.recovery?.round ?? execution.visualCorrection?.round
    if (durableRecord?.value.storage === 'encrypted-local') {
      // Consume before returning an executable intent. A crash can waste a round, never refund it.
      try {
        if (!this.checkpoints || durableRound === undefined) throw new Error('NO_STORE')
        this.checkpoints.consume(
          durableRecord as SavedCheckpoint,
          durableRound,
          execution.recovery?.rebind
        )
      } catch {
        // No executable intent escaped. Release only this exact reservation, never
        // another action's reservation. Failed persistence never consumes authority.
        this.releaseDocumentWrite(execution)
        throw new FigPluginBridgeError('UPSTREAM_FAILED')
      }
    }
    if (correctionAuthority && execution.visualCorrection) {
      correctionAuthority.baselineRecord.value = figPluginVisualBaselineSchema.parse({
        ...correctionAuthority.baselineRecord.value,
        correctionRoundsUsed: execution.visualCorrection.round
      })
      this.visualCorrectionAuthorizations.delete(
        correctionAuthority.authorizationRecord.value.authorizationId
      )
    }
    if (recoveryAuthority && execution.recovery) {
      recoveryAuthority.value = figPluginVisualBaselineSchema.parse({
        ...recoveryAuthority.value,
        correctionRoundsUsed: execution.recovery.round
      })
      if (execution.recovery.rebind) {
        recoveryAuthority.recoveryScope = applyTaskRecoveryRebind(
          recoveryAuthority.recoveryScope,
          execution.recovery.rebind
        )
        recoveryAuthority.value = figPluginVisualBaselineSchema.parse({
          ...recoveryAuthority.value,
          documentId: recoveryAuthority.recoveryScope.documentId,
          scopeId: recoveryAuthority.recoveryScope.scopeId
        })
      }
    }
    execution.intent = Object.freeze(intent)
    execution.state = 'claimed'
    execution.claimedAt = this.clock()
    execution.updatedAt = this.clock()
    this.appendPlanProgress(execution, {
      sequence: execution.cursor + 1,
      phase: 'claimed',
      completed: 0,
      effect: 'none',
      at: execution.updatedAt
    })
    this.recordExecutionAudit(execution)
    this.scheduleCleanup()
    return figPluginExecutionClaimResponseSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      status: 'ready',
      intent
    })
  }

  planProgress(sessionId: string, sessionToken: string, input: unknown): FigPluginExecutionStatus {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginExecutionProgressRequestSchema, input)
    const execution = this.ownedExecution(session, request.executionId)
    this.expireExecution(execution)
    this.checkDocumentWrite(execution)
    if (
      !execution.intent ||
      execution.intent.actionId !== request.actionId ||
      !['claimed', 'executing', 'readback'].includes(execution.state)
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    if (request.sequence <= execution.cursor || request.total !== execution.plan.steps.length)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    execution.state = request.phase
    execution.completed = request.completed
    execution.effect = request.effect
    execution.updatedAt = this.clock()
    this.appendPlanProgress(execution, {
      sequence: request.sequence,
      phase: request.phase,
      ...(request.index === undefined ? {} : { index: request.index }),
      completed: request.completed,
      effect: request.effect,
      at: request.at
    })
    this.recordExecutionAudit(execution)
    this.scheduleCleanup()
    return this.executionStatus(execution)
  }

  planResult(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): FigPluginExecutionResultResponse {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginExecutionResultRequestSchema, input)
    const execution = this.ownedExecution(session, request.executionId)
    const fingerprint = digest(request)
    this.expireExecution(execution)
    this.checkDocumentWrite(execution)
    if (terminalExecution.has(execution.state)) {
      if (
        execution.resultFingerprint === fingerprint &&
        execution.intent?.actionId === request.actionId
      )
        return figPluginExecutionResultResponseSchema.parse({
          protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
          executionId: execution.executionId,
          status: this.executionStatus(execution)
        })
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    if (
      !execution.intent ||
      execution.intent.actionId !== request.actionId ||
      !['claimed', 'executing', 'readback'].includes(execution.state) ||
      request.total !== execution.plan.steps.length
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    try {
      validateHostPlanReadback(execution.plan, execution.context, request.readback)
      if (execution.recovery && request.effect === 'applied') {
        for (const step of execution.plan.steps) {
          const observed = request.readback.steps.find(
            (item) => item.targetId === step.targetId && item.command === step.command
          )
          if (
            !observed ||
            observed.observation !== 'requested' ||
            !Object.hasOwn(observed, 'value') ||
            canonicalFigPluginJson(observed.value) !== canonicalFigPluginJson(stepValue(step))
          )
            throw new Error('INVALID_RECOVERY_READBACK')
        }
      }
    } catch {
      execution.state = 'failed'
      execution.errorCode = 'STALE_CONTEXT'
      execution.effect = 'unknown'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
      this.scheduleCleanup()
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    const observations = request.readback.steps.map((step) => step.observation)
    if (request.effect === 'applied' && observations.some((value) => value !== 'requested')) {
      execution.state = 'failed'
      execution.errorCode = 'QUARANTINED'
      execution.effect = 'unknown'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
      this.scheduleCleanup()
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    if (request.effect === 'rolled-back' && observations.some((value) => value !== 'original')) {
      execution.state = 'failed'
      execution.errorCode = 'QUARANTINED'
      execution.effect = 'unknown'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
      this.scheduleCleanup()
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    const expectedVisualTargets = new Set(
      execution.visualTargetIds ?? execution.plan.steps.map((step) => step.targetId)
    )
    const suppliedVisualTargets = new Set(
      (request.visualEvidence ?? []).map((item) => item.targetId)
    )
    const hasCompleteVisualEvidence = Boolean(
      request.visualEvidence &&
      request.visualEvidence.length === expectedVisualTargets.size &&
      suppliedVisualTargets.size === expectedVisualTargets.size &&
      [...expectedVisualTargets].every((targetId) => suppliedVisualTargets.has(targetId))
    )
    const successfulAppliedResult = request.status === 'completed' && request.effect === 'applied'
    const visualEvidenceInvalid =
      execution.preview.visualAudit === 'hash-only'
        ? successfulAppliedResult && !hasCompleteVisualEvidence
        : request.visualEvidence !== undefined
    if (visualEvidenceInvalid) {
      execution.state = 'failed'
      execution.errorCode = 'QUARANTINED'
      execution.effect = 'unknown'
      execution.visualEvidence = undefined
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
      this.scheduleCleanup()
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
    execution.completed = request.completed
    execution.effect = request.effect
    execution.errorCode = request.errorCode
    execution.resultFingerprint = fingerprint
    execution.visualEvidence = request.visualEvidence
      ? structuredClone(request.visualEvidence)
      : undefined
    execution.updatedAt = this.clock()
    execution.state =
      request.status === 'completed' && request.effect === 'applied'
        ? 'completed'
        : request.status === 'cancelled'
          ? 'cancelled'
          : 'failed'
    if (request.effect === 'unknown') execution.errorCode = 'QUARANTINED'
    if (request.effect === 'rolled-back') execution.errorCode = 'ROLLED_BACK'
    execution.visualBaselineComparison =
      execution.state === 'completed' && execution.visualEvidence
        ? this.compareVisualBaseline(execution, execution.visualEvidence)
        : undefined
    if (
      successfulAppliedResult ||
      ((request.effect === 'none' || request.effect === 'rolled-back') &&
        observations.every((value) => value === 'original'))
    )
      this.releaseDocumentWrite(execution)
    this.recordExecutionAudit(execution)
    this.scheduleCleanup()
    return figPluginExecutionResultResponseSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      executionId: execution.executionId,
      status: this.executionStatus(execution)
    })
  }

  /** A read-only report about a completed result. It cannot mint a write grant. */
  async planPixelAudit(
    sessionId: string,
    sessionToken: string,
    input: unknown
  ): Promise<FigPluginExecutionResultResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    const request = parseFigPluginBridgeValue(figPluginPixelAuditRequestSchema, input)
    const execution = this.ownedExecution(session, request.executionId)
    await this.checkSession(session)
    this.requireCurrentSession(session)
    const comparison = execution.visualBaselineComparison
    const baseline = this.visualBaselines.get(request.baselineId)
    if (
      this.ownedExecution(session, request.executionId) !== execution ||
      execution.state !== 'completed' ||
      execution.effect !== 'applied' ||
      execution.intent?.actionId !== request.actionId ||
      execution.preview.expiresAt <= this.clock() ||
      !comparison ||
      !baseline ||
      baseline.value.expiresAt <= this.clock() ||
      baseline.value.visualEvidenceSha256 !== request.baselineEvidenceSha256 ||
      canonicalFigPluginJson(baseline.binding) !== canonicalFigPluginJson(session.binding) ||
      !pixelAuditMatchesComparison(request, comparison)
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    const fingerprint = digest(request)
    if (execution.pixelAuditFingerprint && execution.pixelAuditFingerprint !== fingerprint)
      throw new FigPluginBridgeError('INVALID_REQUEST')
    if (!execution.pixelAuditFingerprint) {
      execution.pixelAudit = figPluginPixelAuditSchema.parse({
        policy: request.policy,
        baselineId: request.baselineId,
        baselineEvidenceSha256: request.baselineEvidenceSha256,
        visualEvidenceSha256: request.visualEvidenceSha256,
        targets: request.targets,
        checkedAt: this.clock(),
        ...summarizePixelTargets(request.targets)
      })
      execution.pixelAuditFingerprint = fingerprint
      if (execution.pixelAudit.outcome === 'match') {
        for (const [id, record] of [...this.visualCorrectionAuthorizations]) {
          if (record.value.sourceExecutionId === execution.executionId)
            this.removeVisualCorrectionAuthorization(id, 'CANCELLED')
        }
      }
      this.recordExecutionAudit(execution)
    }
    return figPluginExecutionResultResponseSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      executionId: execution.executionId,
      status: this.executionStatus(execution)
    })
  }

  deny(callId: string): void {
    this.enter()
    const call = this.mainCall(callId)
    if (active(call)) this.terminate(call, 'DENIED')
    this.scheduleCleanup()
  }

  revokePlugin(pluginId: string): void {
    this.enter()
    for (const [id, ticket] of this.tickets) {
      if (ticket.binding.pluginId === pluginId) this.removeTicket(id, ticket)
    }
    for (const session of this.sessions.values()) {
      if (session.binding.pluginId === pluginId)
        this.removeSession(session, 'CONFIGURATION_CHANGED')
    }
    for (const [id, record] of this.visualBaselines) {
      if (record.binding.pluginId === pluginId) this.removeVisualBaseline(id)
    }
    for (const [id, record] of [...this.visualCorrectionAuthorizations]) {
      if (record.binding.pluginId === pluginId)
        this.removeVisualCorrectionAuthorization(id, 'CONFIGURATION_CHANGED')
    }
    this.scheduleCleanup()
    try {
      this.checkpoints?.removeWhere((record) => record.binding.pluginId === pluginId)
    } catch {
      throw new FigPluginBridgeError('UPSTREAM_FAILED')
    }
  }

  /** Synchronous authority notification: no polling, metadata discovery or provider await. */
  revokeInvalidBindings(isCurrent: (binding: FigPluginRuntimeBinding) => boolean): void {
    this.enter()
    const valid = (binding: FigPluginRuntimeBinding): boolean => {
      try {
        return isCurrent(Object.freeze({ ...binding })) === true
      } catch {
        return false
      }
    }
    for (const [id, ticket] of this.tickets) {
      if (!valid(ticket.binding)) this.removeTicket(id, ticket)
    }
    for (const session of this.sessions.values()) {
      if (!valid(session.binding)) this.removeSession(session, 'CONFIGURATION_CHANGED')
    }
    for (const [id, record] of this.visualBaselines) {
      if (!valid(record.binding)) this.removeVisualBaseline(id)
    }
    for (const [id, record] of [...this.visualCorrectionAuthorizations]) {
      if (!valid(record.binding))
        this.removeVisualCorrectionAuthorization(id, 'CONFIGURATION_CHANGED')
    }
    this.scheduleCleanup()
    try {
      this.checkpoints?.removeWhere((record) => !valid(record.binding))
    } catch {
      throw new FigPluginBridgeError('UPSTREAM_FAILED')
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const [id, ticket] of this.tickets) this.removeTicket(id, ticket)
    for (const session of this.sessions.values()) this.removeSession(session, 'CANCELLED')
    this.visualBaselines.clear()
    this.visualCorrectionAuthorizations.clear()
    this.visualCorrectionExecutions.clear()
    this.failures = []
  }

  listSessions(): Array<{
    sessionId: string
    pluginId: string
    host: FigPluginRuntimeBinding['host']
    projectId: string
    expiresAt: number
    activeCalls: number
  }> {
    this.enter()
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      pluginId: session.binding.pluginId,
      host: session.binding.host,
      projectId: session.binding.projectId,
      expiresAt: session.expiresAt,
      activeCalls: [...this.calls.values()].filter(
        (call) => call.session === session && active(call)
      ).length
    }))
  }

  private enter(): void {
    if (this.closed) throw new FigPluginBridgeError('UNAUTHORIZED')
    this.prune()
  }

  private findExecution(executionId: string): PlanExecution {
    if (!isId(executionId)) throw new FigPluginBridgeError('INVALID_REQUEST')
    const correction = this.visualCorrectionExecutions.get(executionId)
    if (correction) {
      this.expireExecution(correction)
      return correction
    }
    for (const call of this.calls.values()) {
      if (call.execution?.executionId === executionId) {
        this.expireExecution(call.execution)
        return call.execution
      }
    }
    throw new FigPluginBridgeError('EXPIRED')
  }

  private ownedExecution(session: Session, executionId: string): PlanExecution {
    const execution = this.findExecution(executionId)
    if (
      execution.call.session !== session ||
      this.sessions.get(session.id) !== session ||
      this.calls.get(execution.call.receipt.response.callId) !== execution.call
    )
      throw new FigPluginBridgeError('UNAUTHORIZED')
    return execution
  }

  private appendPlanProgress(execution: PlanExecution, event: PlanProgress): void {
    if (event.sequence <= execution.cursor) return
    execution.cursor = event.sequence
    execution.progress.push(event)
    if (execution.progress.length > FIGPLUGIN_EXECUTION_MAX_EVENTS) execution.progress.shift()
  }

  private releaseDocumentWrite(execution: PlanExecution): void {
    if (!execution.writeReservation) return
    try {
      this.writes.release(execution.writeReservation)
      execution.writeReservation = undefined
    } catch {
      // Keep exclusion until its original deadline plus drain, never pretend a failed
      // cleanup permits another writer. The verified host result remains truthful.
    }
  }

  private checkDocumentWrite(execution: PlanExecution): void {
    if (!['claimed', 'executing', 'readback'].includes(execution.state)) return
    let owned = false
    try {
      owned = !!execution.writeReservation && this.writes.owns(execution.writeReservation)
    } catch {
      /* Missing/corrupt/busy coordination state cannot grant further host steps. */
    }
    if (!owned) {
      execution.state = 'failed'
      execution.errorCode = 'QUARANTINED'
      execution.effect = 'unknown'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
    }
  }

  private expireExecution(execution: PlanExecution): void {
    if (terminalExecution.has(execution.state)) return
    if (execution.preview.expiresAt > this.clock()) return
    execution.state = 'expired'
    execution.errorCode = 'EXPIRED'
    execution.updatedAt = this.clock()
    this.recordExecutionAudit(execution)
  }

  private terminateExecution(
    execution: PlanExecution,
    code: 'CANCELLED' | 'CONFIGURATION_CHANGED'
  ): void {
    if (terminalExecution.has(execution.state)) return
    execution.state = 'cancelled'
    execution.errorCode = code === 'CANCELLED' ? 'CANCELLED' : 'HOST_UNAVAILABLE'
    execution.updatedAt = this.clock()
    this.recordExecutionAudit(execution)
  }

  private authenticate(id: string, token: string): Session {
    this.enter()
    const session = isId(id) ? this.sessions.get(id) : undefined
    const matches = secretEquals(token, session?.token)
    if (!session || !matches) throw new FigPluginBridgeError('UNAUTHORIZED')
    session.idleAt = this.clock() + IDLE_TTL
    this.scheduleCleanup()
    return session
  }

  private requireCurrentSession(session: Session): void {
    this.enter()
    if (this.sessions.get(session.id) !== session) throw new FigPluginBridgeError('UNAUTHORIZED')
  }

  private async validate(binding: FigPluginRuntimeBinding): Promise<boolean> {
    try {
      return (await this.validateBinding(Object.freeze({ ...binding }))) === true
    } catch {
      return false
    }
  }

  private async checkSession(session: Session): Promise<void> {
    // Coalesce concurrent checks without allowing a result to outlive its session epoch.
    const validation = session.validation ?? this.validate(session.binding)
    session.validation = validation
    const valid = await validation
    if (session.validation === validation) session.validation = undefined
    this.requireCurrentSession(session)
    if (!valid) {
      this.removeSession(session, 'CONFIGURATION_CHANGED')
      this.scheduleCleanup()
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
  }

  private ownedReceipt(session: Session, callId: string): Receipt {
    if (isId(callId)) {
      for (const receipt of session.requests.values()) {
        if (receipt.response.callId === callId) return receipt
      }
    }
    throw new FigPluginBridgeError('UNAUTHORIZED')
  }

  private mainCall(callId: string): Call {
    const call = isId(callId) ? this.calls.get(callId) : undefined
    if (call) return call
    for (const session of this.sessions.values()) {
      for (const receipt of session.requests.values()) {
        if (receipt.response.callId === callId) throw new FigPluginBridgeError('EXPIRED')
      }
    }
    throw new FigPluginBridgeError('INVALID_REQUEST')
  }

  private checkApproval(call: Call, digest: string): void {
    const matches = secretEquals(digest, call.receipt.digest)
    if (this.calls.get(call.receipt.response.callId) !== call)
      throw new FigPluginBridgeError('EXPIRED')
    if (call.status.status !== 'awaiting-approval' || !call.preview || !matches) {
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
  }

  private running(call: Call): boolean {
    this.prune()
    return (
      !this.closed &&
      this.sessions.get(call.session.id) === call.session &&
      this.calls.get(call.receipt.response.callId) === call &&
      call.status.status === 'running'
    )
  }

  private async execute(
    call: Call,
    preview: FigPluginBridgePreview,
    controller: AbortController
  ): Promise<void> {
    try {
      const value = await this.invoke(
        Object.freeze({ ...call.session.binding }),
        preview,
        controller.signal
      )
      if (!this.running(call)) return
      const result = parseFigPluginBridgeValue(resultSchema, value)
      // A provider/profile change while invoking also invalidates an otherwise good result.
      await this.checkSession(call.session)
      if (!this.running(call)) return
      if (call.preview?.featureId === 'plan-preview' && call.hostContext) {
        this.registerPlanExecution(call, result.content, call.hostContext)
      }
      call.status = {
        protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
        callId: call.receipt.response.callId,
        status: 'completed',
        ...result
      }
      call.preview = undefined
      call.hostContext = undefined
      call.controller = undefined
      call.deadline = undefined
      this.scheduleCleanup()
    } catch (error) {
      const reason =
        error instanceof FigPluginBridgeError &&
        ['TIMEOUT', 'CANCELLED', 'CONFIGURATION_CHANGED'].includes(error.code)
          ? (error.code as 'TIMEOUT' | 'CANCELLED' | 'CONFIGURATION_CHANGED')
          : 'UPSTREAM_FAILED'
      if (this.running(call)) this.terminate(call, reason)
      this.scheduleCleanup()
    } finally {
      // An invoker ignoring abort still occupies a slot until it settles. Releasing
      // on cancellation/timeout would permit unbounded outstanding provider work.
      this.executing -= 1
    }
  }

  private terminate(call: Call, code: TerminalCode): void {
    const controller = call.controller
    call.status = {
      protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
      callId: call.receipt.response.callId,
      status: code === 'CANCELLED' || code === 'DENIED' ? 'cancelled' : 'failed',
      errorCode: code
    }
    call.preview = undefined
    call.controller = undefined
    call.deadline = undefined
    controller?.abort()
  }

  private removeTicket(id: string, ticket: Ticket): void {
    this.tickets.delete(id)
    ticket.secret = ''
  }

  private removeVisualCorrectionAuthorization(
    authorizationId: string,
    reason: 'CANCELLED' | 'EXPIRED' | 'CONFIGURATION_CHANGED'
  ): void {
    const record = this.visualCorrectionAuthorizations.get(authorizationId)
    if (!record) return
    this.visualCorrectionAuthorizations.delete(authorizationId)
    const execution = record.preparedExecutionId
      ? this.visualCorrectionExecutions.get(record.preparedExecutionId)
      : undefined
    if (execution && !terminalExecution.has(execution.state)) {
      execution.state = reason === 'EXPIRED' ? 'expired' : 'cancelled'
      execution.errorCode =
        reason === 'EXPIRED'
          ? 'EXPIRED'
          : reason === 'CONFIGURATION_CHANGED'
            ? 'HOST_UNAVAILABLE'
            : 'CANCELLED'
      execution.updatedAt = this.clock()
      this.recordExecutionAudit(execution)
    }
  }

  private removeVisualBaseline(baselineId: string): void {
    this.visualBaselines.delete(baselineId)
    for (const execution of this.allPlanExecutions())
      if (execution.recovery?.baselineId === baselineId)
        this.terminateExecution(execution, 'CONFIGURATION_CHANGED')
    for (const [id, record] of [...this.visualCorrectionAuthorizations]) {
      if (record.value.baselineId === baselineId)
        this.removeVisualCorrectionAuthorization(id, 'CONFIGURATION_CHANGED')
    }
    for (const [id, execution] of [...this.visualCorrectionExecutions]) {
      if (execution.visualCorrection?.baselineId === baselineId) {
        this.terminateExecution(execution, 'CONFIGURATION_CHANGED')
        this.visualCorrectionExecutions.delete(id)
      }
    }
  }

  private removeSession(session: Session, code: TerminalCode): void {
    this.sessions.delete(session.id)
    session.token = ''
    session.requests.clear()
    session.validation = undefined
    for (const [id, execution] of [...this.visualCorrectionExecutions]) {
      if (execution.call.session === session) {
        this.terminateExecution(
          execution,
          code === 'CANCELLED' ? 'CANCELLED' : 'CONFIGURATION_CHANGED'
        )
        this.visualCorrectionExecutions.delete(id)
      }
    }
    for (const [id, call] of this.calls) {
      if (call.session === session) {
        this.calls.delete(id)
        this.terminate(call, code)
      }
    }
  }

  private prune(): void {
    if (this.closed) return
    const now = this.clock()
    this.failures = this.failures.filter((time) => time + FAILURE_WINDOW > now)
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.removeTicket(id, ticket)
    }
    for (const session of this.sessions.values()) {
      if (Math.min(session.expiresAt, session.idleAt) <= now) this.removeSession(session, 'EXPIRED')
    }
    for (const [id, call] of this.calls) {
      if (call.receipt.response.expiresAt <= now) {
        for (const [executionId, execution] of [...this.visualCorrectionExecutions]) {
          if (execution.call === call) {
            this.expireExecution(execution)
            this.visualCorrectionExecutions.delete(executionId)
          }
        }
        this.calls.delete(id)
        this.terminate(call, 'EXPIRED')
      } else if (call.deadline !== undefined && call.deadline <= now) {
        this.terminate(call, 'TIMEOUT')
      }
    }
    for (const [id, record] of this.visualBaselines) {
      if (record.value.expiresAt <= now) this.removeVisualBaseline(id)
    }
    for (const execution of this.visualCorrectionExecutions.values())
      this.expireExecution(execution)
    for (const [id, record] of [...this.visualCorrectionAuthorizations]) {
      if (record.value.expiresAt <= now || !this.visualBaselines.has(record.value.baselineId))
        this.removeVisualCorrectionAuthorization(id, 'EXPIRED')
    }
    this.scheduleCleanup()
  }

  private scheduleCleanup(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.closed) return
    let next = Infinity
    for (const ticket of this.tickets.values()) next = Math.min(next, ticket.expiresAt)
    for (const session of this.sessions.values())
      next = Math.min(next, session.expiresAt, session.idleAt)
    for (const call of this.calls.values())
      next = Math.min(next, call.receipt.response.expiresAt, call.deadline ?? Infinity)
    for (const record of this.visualBaselines.values())
      next = Math.min(next, record.value.expiresAt)
    for (const record of this.visualCorrectionAuthorizations.values())
      next = Math.min(next, record.value.expiresAt)
    for (const execution of this.visualCorrectionExecutions.values())
      if (!terminalExecution.has(execution.state))
        next = Math.min(next, execution.preview.expiresAt)
    if (this.failures.length) next = Math.min(next, this.failures[0] + FAILURE_WINDOW)
    if (next === Infinity) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.prune()
      },
      Math.max(1, next - this.clock())
    )
    this.timer.unref()
  }
}
