import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
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
  figPluginExecutionClaimResponseSchema,
  figPluginExecutionPreviewSchema,
  figPluginExecutionProgressRequestSchema,
  figPluginExecutionResultRequestSchema,
  figPluginExecutionResultResponseSchema,
  figPluginExecutionStateSchema,
  figPluginExecutionStatusSchema,
  figPluginExecutionClaimRequestSchema,
  figPluginExecutionStatusRequestSchema,
  type FigPluginExecutionClaimResponse,
  type FigPluginExecutionPreview,
  type FigPluginExecutionProgressRequest,
  type FigPluginExecutionResultRequest,
  type FigPluginExecutionResultResponse,
  type FigPluginExecutionState,
  type FigPluginExecutionStatus,
  type FigPluginVisualEvidence
} from '@shared/figplugin/execution'
import {
  createHostPlanningPreview,
  type HostPlanningPreview
} from '@shared/figplugin/hostPlanPreview'
import {
  hostContextSchema,
  validateHostPlanReadback,
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
  intent?: {
    protocol: typeof FIGPLUGIN_EXECUTION_PROTOCOL
    purpose: 'execute-host-plan'
    executionId: string
    callId: string
    pluginId: string
    host: HostContext['host']
    documentId: string
    scopeId: string
    captureId: string
    plan: HostPlan
    planSha256: string
    expiresAt: number
    adapterVersion: string
    actionId: string
  }
  claimedAt?: number
  resultFingerprint?: string
  visualEvidence?: FigPluginVisualEvidence[]
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

/** Memory-only main-process authority. Never expose createPairing/approve/deny to the host.
 * The caller supplies trusted native consent and validates the entire current store binding.
 */
export class FigPluginBridgeRuntime {
  private readonly tickets = new Map<string, Ticket>()
  private readonly sessions = new Map<string, Session>()
  private readonly calls = new Map<string, Call>()
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
    this.validateBinding = options.validateBinding
    this.invoke = options.invoke
    this.clock = options.now ?? Date.now
    this.callTimeout = Number.isFinite(options.callTimeoutMs)
      ? Math.max(1, Math.min(MAX_CALL_TIMEOUT, Math.floor(options.callTimeoutMs!)))
      : MAX_CALL_TIMEOUT
    this.audit = options.audit
    this.allowNativeWrite = options.allowNativeWrite ?? (() => false)
  }

  private executionStatus(execution: PlanExecution): FigPluginExecutionStatus {
    return figPluginExecutionStatusSchema.parse({
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      executionId: execution.executionId,
      callId: execution.call.receipt.response.callId,
      state: execution.state,
      completed: execution.completed,
      total: execution.plan.steps.length,
      effect: execution.effect,
      updatedAt: execution.updatedAt,
      ...(execution.visualEvidence ? { visualEvidence: execution.visualEvidence } : {}),
      ...(execution.errorCode ? { errorCode: execution.errorCode } : {})
    })
  }

  private executionPreview(execution: PlanExecution): FigPluginExecutionPreview {
    return figPluginExecutionPreviewSchema.parse({
      ...execution.preview,
      state: execution.state
    })
  }

  private registerPlanExecution(
    call: Call,
    content: string,
    context: HostContext
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
      risk: checked.risk,
      differences: checked.differences,
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
      visualAudit: checked.execution.visualAudit
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
      updatedAt: createdAt
    }
    call.execution = execution
    this.recordExecutionAudit(execution)
    return execution
  }

  private recordExecutionAudit(execution: PlanExecution): void {
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
    return [...this.calls.values()]
      .flatMap((call) => (call.execution ? [call.execution] : []))
      .map((execution) => this.executionPreview(execution))
  }

  listPlanStatuses(): FigPluginExecutionStatus[] {
    this.enter()
    return [...this.calls.values()]
      .flatMap((call) => (call.execution ? [call.execution] : []))
      .map((execution) => this.executionStatus(execution))
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

  async approvePlan(executionId: string, planSha256: string): Promise<void> {
    this.enter()
    const execution = this.findExecution(executionId)
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
    if (!call?.execution) throw new FigPluginBridgeError('INVALID_REQUEST')
    this.expireExecution(call.execution)
    return this.executionStatus(call.execution)
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
    if (!call?.execution) throw new FigPluginBridgeError('INVALID_REQUEST')
    const execution = call.execution
    this.expireExecution(execution)
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
    const intent = {
      protocol: FIGPLUGIN_EXECUTION_PROTOCOL,
      purpose: 'execute-host-plan' as const,
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
      actionId: execution.actionId
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
    const expectedVisualTargets = new Set(execution.plan.steps.map((step) => step.targetId))
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
    this.recordExecutionAudit(execution)
    this.scheduleCleanup()
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
    this.scheduleCleanup()
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
    this.scheduleCleanup()
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const [id, ticket] of this.tickets) this.removeTicket(id, ticket)
    for (const session of this.sessions.values()) this.removeSession(session, 'CANCELLED')
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

  private removeSession(session: Session, code: TerminalCode): void {
    this.sessions.delete(session.id)
    session.token = ''
    session.requests.clear()
    session.validation = undefined
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
        this.calls.delete(id)
        this.terminate(call, 'EXPIRED')
      } else if (call.deadline !== undefined && call.deadline <= now) {
        this.terminate(call, 'TIMEOUT')
      }
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
