import {
  APPROVAL_CONSUMPTION_INTENT_DISCRIMINATOR,
  APPROVAL_CONSUMPTION_RECEIPT_DISCRIMINATOR,
  APPROVAL_CONSUMPTION_VERSION,
  APPROVAL_GRANT_DISCRIMINATOR,
  APPROVAL_GRANT_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  canonicalPolicyJson,
  digestPolicyRequest,
  evaluatePolicy,
  parseApprovalConsumptionReceipt,
  parseApprovalGrant,
  parsePolicyDecision,
  parsePolicyRequest,
  parsePolicyRules,
  sha256PolicyText,
  type ApprovalConsumptionIntent,
  type ApprovalConsumptionReceipt,
  type ApprovalGrant,
  type MagicAgentActorRef,
  type MagicAgentEvent,
  type PolicyConstraints,
  type PolicyDecision,
  type PolicyJsonValue,
  type PolicyRequest,
  type PolicyRule
} from '../../../shared/magicAgentPlatform2'
import {
  EventStoreConflictError,
  MagicAgentEventStore,
  ResourceRevisionConflictError,
  type ResourceMutationInput,
  type StoredResource
} from '../persistence/eventStore'
import { redactPolicyRequestForAudit, type RedactedPolicyRequest } from './redaction'

const AUDIT_KIND = 'policy-audit'
const APPROVAL_KIND = 'approval'
const PERMIT_LIFETIME_MS = 300_000

type AuditStatus = 'authorized' | 'denied' | 'awaiting-approval' | 'consumed'
type AuditState = {
  status: AuditStatus
  consumed: boolean
  requestDigest: string
  redactedRequest: RedactedPolicyRequest
  decision: PolicyDecision
  outcome: string
  reason?: string
  constraints?: PolicyConstraints
  issuedAt: number
  expiresAt: number
  consumedAt?: number
  receipt?: ApprovalConsumptionReceipt
  consumeIdempotencyKey?: string
  consumptionResult?: Readonly<{
    constraints?: PolicyConstraints
    authorizationId: string
    auditRevision: number
  }>
  grantSummary?: unknown
  lastAuthorizationCommandDigest?: string
  createdByService: string
}
type ApprovalState = {
  status: 'active' | 'exhausted'
  grant: ApprovalGrant
  requestDigest: string
  policyVersion: string
  createdByService: string
}

export type TrustedExecutionPermit = Readonly<{
  authorizationId: string
  requestDigest: string
  decisionId: string
  constraints?: PolicyConstraints
  issuedAt: number
  expiresAt: number
  storeId: string
}>
export type AuthorizationResult =
  | Readonly<{
      status: 'authorized'
      permit: TrustedExecutionPermit
      decision: PolicyDecision
      auditRevision: number
    }>
  | Readonly<{
      status: 'denied' | 'awaiting-approval' | 'already-consumed'
      decision: PolicyDecision
      reason: string
    }>

export class ApprovalValidationError extends Error {
  readonly code = 'MAGIC_AGENT_APPROVAL_VALIDATION'
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ApprovalValidationError'
  }
}
export class ApprovalRevisionConflictError extends Error {
  readonly code = 'MAGIC_AGENT_APPROVAL_REVISION_CONFLICT'
  constructor(message = 'Approval revision conflict.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'ApprovalRevisionConflictError'
  }
}
export class PermitInvalidError extends Error {
  readonly code = 'MAGIC_AGENT_PERMIT_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'PermitInvalidError'
  }
}
export class PermitConsumedError extends Error {
  readonly code = 'MAGIC_AGENT_PERMIT_CONSUMED'
  constructor() {
    super('Execution permit has already been consumed.')
    this.name = 'PermitConsumedError'
  }
}
export class AuthorizationConflictError extends Error {
  readonly code = 'MAGIC_AGENT_AUTHORIZATION_CONFLICT'
  constructor(message = 'Authorization id is already bound to a different request.') {
    super(message)
    this.name = 'AuthorizationConflictError'
  }
}

export class MagicAgentPolicyAuthorizationService {
  private readonly store: MagicAgentEventStore
  private readonly rules: readonly PolicyRule[]
  private readonly policyVersion: string
  private readonly storeId: string
  private readonly trustedApprovers: ReadonlySet<string>
  private readonly permitBrands = new WeakSet<object>()

  constructor(input: {
    store: MagicAgentEventStore
    rules: unknown
    policyVersion: string
    storeId: string
    trustedApprovers: readonly MagicAgentActorRef[]
  }) {
    if (!input || typeof input !== 'object') throw new ApprovalValidationError('Options required.')
    const parsedRules = parsePolicyRules(input.rules)
    if (!parsedRules.ok) throw new ApprovalValidationError(parsedRules.error)
    this.policyVersion = text(input.policyVersion, 'policyVersion')
    this.storeId = text(input.storeId, 'storeId')
    if (!Array.isArray(input.trustedApprovers) || input.trustedApprovers.length === 0)
      throw new ApprovalValidationError('trustedApprovers must be non-empty.')
    const approvers = new Set<string>()
    for (const actor of input.trustedApprovers) {
      if (!plain(actor)) throw new ApprovalValidationError('Invalid trusted approver.')
      const key = actorKey(actor)
      if (approvers.has(key)) throw new ApprovalValidationError('Duplicate trusted approver.')
      approvers.add(key)
    }
    this.store = input.store
    this.rules = deepFreeze(parsedRules.value.slice())
    this.trustedApprovers = approvers
  }

  isTrustedPermit(value: unknown): value is TrustedExecutionPermit {
    return typeof value === 'object' && value !== null && this.permitBrands.has(value)
  }

  listAuditResources(options: { limit?: number } = {}) {
    return this.store.listResources({
      kind: AUDIT_KIND,
      includeDeleted: true,
      limit: options.limit ?? 100
    })
  }

  createApprovalGrant(input: {
    grantId: string
    request: unknown
    approvedBy: MagicAgentActorRef
    issuedAt: number
    expiresAt: number
    maxUses: number
    constraints?: PolicyConstraints
    idempotencyKey: string
  }): Readonly<{ grant: ApprovalGrant; inserted: boolean }> {
    const grantId = text(input.grantId, 'grantId')
    const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey')
    const request = requestOf(input.request)
    const issuedAt = time(input.issuedAt, 'issuedAt')
    const expiresAt = time(input.expiresAt, 'expiresAt')
    const decision = this.evaluate(request, issuedAt)
    if (decision.effect !== 'require-approval' || !decision.approvalRequirement)
      throw new ApprovalValidationError('Grant requires a require-approval decision.')
    if (!this.isTrusted(input.approvedBy))
      throw new ApprovalValidationError('Approver is not trusted.')
    const requirement = decision.approvalRequirement
    if (expiresAt <= issuedAt || expiresAt > issuedAt + requirement.expiresInMs)
      throw new ApprovalValidationError('Grant expiry exceeds approval requirement.')
    if (!positive(input.maxUses) || input.maxUses > requirement.maxUses)
      throw new ApprovalValidationError('Grant maxUses exceeds approval requirement.')
    const scope = deriveScope(request, decision)
    const constraints = input.constraints === undefined ? decision.constraints : input.constraints
    if (!sameJson(constraints, decision.constraints))
      throw new ApprovalValidationError('Grant constraints must exactly match the policy decision.')
    const grantCandidate: ApprovalGrant = {
      discriminator: APPROVAL_GRANT_DISCRIMINATOR,
      version: APPROVAL_GRANT_VERSION,
      grantId,
      requestDigest: decision.requestDigest,
      actor: { kind: request.actor.kind, id: request.actor.id },
      scope,
      issuedAt,
      expiresAt,
      maxUses: input.maxUses,
      useCount: 0,
      approvedBy: { kind: input.approvedBy.kind, id: input.approvedBy.id },
      ...(constraints === undefined ? {} : { constraints })
    }
    const parsed = parseApprovalGrant(grantCandidate)
    if (!parsed.ok) throw new ApprovalValidationError(parsed.error)
    const redactedRequest = redactPolicyRequestForAudit(request)
    const grantState: ApprovalState = {
      status: 'active',
      grant: parsed.value,
      requestDigest: decision.requestDigest,
      policyVersion: this.policyVersion,
      createdByService: this.storeId
    }
    const auditState: AuditState = {
      status: 'authorized',
      consumed: true,
      requestDigest: decision.requestDigest,
      redactedRequest,
      decision,
      outcome: 'grant-created',
      issuedAt,
      expiresAt,
      ...(constraints === undefined ? {} : { constraints }),
      grantSummary: {
        grantId,
        actor: parsed.value.actor,
        scope,
        approvedBy: parsed.value.approvedBy,
        issuedAt,
        expiresAt,
        maxUses: input.maxUses
      },
      createdByService: this.storeId
    }
    const results = this.store.mutateResourcesBatch([
      mutation(
        'create',
        APPROVAL_KIND,
        grantId,
        `${idempotencyKey}:grant`,
        0,
        grantState,
        issuedAt,
        this.storeId
      ),
      mutation(
        'create',
        AUDIT_KIND,
        `grant:${grantId}`,
        `${idempotencyKey}:audit`,
        0,
        auditState,
        issuedAt,
        this.storeId
      )
    ])
    const stored = results[0].resource.state as ApprovalState
    this.validateGrantState(stored)
    if (stored.requestDigest !== decision.requestDigest) throw new AuthorizationConflictError()
    return deepFreeze({ grant: stored.grant, inserted: results[0].inserted })
  }

  authorize(input: {
    authorizationId: string
    request: unknown
    evaluatedAt: number
    grantId?: string
    expectedGrantUseCount?: number
    idempotencyKey: string
  }): AuthorizationResult {
    const authorizationId = text(input.authorizationId, 'authorizationId')
    const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey')
    const request = requestOf(input.request)
    const evaluatedAt = time(input.evaluatedAt, 'evaluatedAt')
    const decision = this.evaluate(request, evaluatedAt)
    const grantId = input.grantId === undefined ? undefined : text(input.grantId, 'grantId')
    const commandDigest = authorizationCommandDigest({
      authorizationId,
      requestDigest: decision.requestDigest,
      grantId,
      expectedGrantUseCount: input.expectedGrantUseCount,
      idempotencyKey
    })
    const existing = this.store.getResource<AuditState>(AUDIT_KIND, authorizationId, {
      includeDeleted: true
    })
    if (existing) {
      const state = this.auditState(existing)
      if (
        state.status === 'awaiting-approval' &&
        grantId &&
        decision.effect === 'require-approval'
      ) {
        try {
          return this.consumeGrantForAuthorization(
            authorizationId,
            request,
            decision,
            redactPolicyRequestForAudit(request),
            evaluatedAt,
            grantId,
            input.expectedGrantUseCount,
            idempotencyKey,
            commandDigest,
            existing
          )
        } catch (error) {
          if (
            error instanceof EventStoreConflictError ||
            error instanceof ResourceRevisionConflictError
          ) {
            const current = this.store.getResource<AuditState>(AUDIT_KIND, authorizationId, {
              includeDeleted: true
            })
            if (current)
              return this.replayAuthorizationCommand(
                current,
                request,
                decision,
                evaluatedAt,
                commandDigest,
                grantId,
                input.expectedGrantUseCount,
                error
              )
          }
          if (
            !(error instanceof ApprovalValidationError) &&
            !(error instanceof ApprovalRevisionConflictError)
          )
            throw error
          return this.recordAttemptAudit(
            authorizationId,
            decision,
            redactPolicyRequestForAudit(request),
            evaluatedAt,
            approvalReason(error),
            idempotencyKey,
            commandDigest
          )
        }
      }
      return this.replayAuthorizationCommand(
        existing,
        request,
        decision,
        evaluatedAt,
        commandDigest,
        grantId,
        input.expectedGrantUseCount
      )
    }
    const redactedRequest = redactPolicyRequestForAudit(request)
    if (decision.effect === 'allow' || decision.effect === 'allow-with-constraints')
      return this.createAuthorizedAudit(
        authorizationId,
        decision,
        redactedRequest,
        evaluatedAt,
        'direct-allow',
        idempotencyKey,
        commandDigest
      )
    if (decision.effect === 'deny')
      return this.createNonAuthorizedAudit(
        authorizationId,
        decision,
        redactedRequest,
        evaluatedAt,
        'denied',
        decision.reasonCode,
        idempotencyKey,
        commandDigest
      )
    if (!grantId)
      return this.createNonAuthorizedAudit(
        authorizationId,
        decision,
        redactedRequest,
        evaluatedAt,
        'awaiting-approval',
        decision.approvalRequirement?.reason ?? 'Approval required.',
        idempotencyKey,
        commandDigest
      )
    try {
      return this.consumeGrantForAuthorization(
        authorizationId,
        request,
        decision,
        redactedRequest,
        evaluatedAt,
        grantId,
        input.expectedGrantUseCount,
        idempotencyKey,
        commandDigest
      )
    } catch (error) {
      if (
        !(error instanceof ApprovalValidationError) &&
        !(error instanceof ApprovalRevisionConflictError)
      )
        throw error
      return this.createAwaitingWithDeniedAttempt(
        authorizationId,
        decision,
        redactedRequest,
        evaluatedAt,
        approvalReason(error),
        idempotencyKey,
        baseAuthorizationCommandDigest(authorizationId, decision.requestDigest, idempotencyKey),
        commandDigest,
        request
      )
    }
  }

  resumeAuthorization(
    authorizationIdInput: string,
    requestInput: unknown,
    atInput: number
  ): AuthorizationResult {
    const authorizationId = text(authorizationIdInput, 'authorizationId')
    const request = requestOf(requestInput)
    const at = time(atInput, 'at')
    const currentDecision = this.evaluate(request, at)
    const audit = this.store.getResource<AuditState>(AUDIT_KIND, authorizationId, {
      includeDeleted: true
    })
    if (!audit) throw new PermitInvalidError('Authorization does not exist.')
    return this.replay(audit, request, currentDecision, at, true)
  }

  consumeExecutionPermit(input: {
    permit: TrustedExecutionPermit
    request: unknown
    consumedAt: number
    idempotencyKey: string
  }): Readonly<{
    constraints?: PolicyConstraints
    authorizationId: string
    auditRevision: number
  }> {
    if (!this.isTrustedPermit(input.permit)) throw new PermitInvalidError('Unbranded permit.')
    const request = requestOf(input.request)
    const digest = digestPolicyRequest(request)
    const consumedAt = time(input.consumedAt, 'consumedAt')
    const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey')
    const permit = input.permit
    if (permit.storeId !== this.storeId || permit.requestDigest !== digest)
      throw new PermitInvalidError('Permit does not match store or request.')
    const resource = this.store.getResource<AuditState>(AUDIT_KIND, permit.authorizationId, {
      includeDeleted: true
    })
    if (!resource || resource.deleted) throw new PermitInvalidError('Authorization is unavailable.')
    const state = this.auditState(resource)
    if (state.status === 'consumed' || state.consumed) {
      if (
        state.requestDigest !== permit.requestDigest ||
        state.decision.decisionId !== permit.decisionId ||
        state.issuedAt !== permit.issuedAt ||
        state.expiresAt !== permit.expiresAt ||
        !sameJson(state.constraints, permit.constraints)
      )
        throw new PermitInvalidError('Permit does not match persisted authorization.')
      if (state.consumeIdempotencyKey === idempotencyKey && state.consumptionResult)
        return deepFreeze(cloneJsonValue(state.consumptionResult))
      throw new PermitConsumedError()
    }
    if (consumedAt < permit.issuedAt || consumedAt > permit.expiresAt)
      throw new PermitInvalidError('Permit is outside its validity interval.')
    const currentDecision = this.evaluate(request, consumedAt)
    if (!sameAuthorizationSemantics(state.decision, currentDecision))
      throw new PermitInvalidError('Current policy no longer authorizes this decision.')
    if (state.status !== 'authorized')
      throw new PermitInvalidError('Authorization is not executable.')
    if (
      state.requestDigest !== permit.requestDigest ||
      state.decision.decisionId !== permit.decisionId ||
      state.issuedAt !== permit.issuedAt ||
      state.expiresAt !== permit.expiresAt ||
      !sameJson(state.constraints, permit.constraints)
    )
      throw new PermitInvalidError('Permit does not match persisted authorization.')
    const consumptionResult = deepFreeze({
      ...(state.constraints === undefined ? {} : { constraints: state.constraints }),
      authorizationId: permit.authorizationId,
      auditRevision: resource.revision + 1
    })
    const next: AuditState = {
      ...state,
      status: 'consumed',
      consumed: true,
      consumedAt,
      consumeIdempotencyKey: idempotencyKey,
      consumptionResult
    }
    try {
      const result = this.store.mutateResource(
        mutation(
          'update',
          AUDIT_KIND,
          permit.authorizationId,
          idempotencyKey,
          resource.revision + 1,
          next,
          consumedAt,
          this.storeId,
          resource.revision
        )
      )
      return deepFreeze({ ...consumptionResult, auditRevision: result.resource.revision })
    } catch (error) {
      if (
        error instanceof ResourceRevisionConflictError ||
        error instanceof EventStoreConflictError
      ) {
        const current = this.store.getResource<AuditState>(AUDIT_KIND, permit.authorizationId, {
          includeDeleted: true
        })
        if (current) {
          const currentState = this.auditState(current)
          if (
            currentState.consumeIdempotencyKey === idempotencyKey &&
            currentState.consumptionResult
          )
            return deepFreeze(cloneJsonValue(currentState.consumptionResult))
          if (currentState.status === 'consumed' || currentState.consumed)
            throw new ApprovalRevisionConflictError(undefined, { cause: error })
        }
        throw new ApprovalRevisionConflictError(undefined, { cause: error })
      }
      throw error
    }
  }

  private consumeGrantForAuthorization(
    authorizationId: string,
    request: PolicyRequest,
    decision: PolicyDecision,
    redactedRequest: RedactedPolicyRequest,
    evaluatedAt: number,
    grantId: string,
    expectedUseCount: number | undefined,
    idempotencyKey: string,
    commandDigest: string,
    existingAudit?: StoredResource<AuditState>
  ): AuthorizationResult {
    if (!Number.isSafeInteger(expectedUseCount) || (expectedUseCount as number) < 0)
      throw new ApprovalValidationError('expectedGrantUseCount is required.')
    if (existingAudit) {
      const existingState = this.auditState(existingAudit)
      if (
        existingState.status !== 'awaiting-approval' ||
        existingState.requestDigest !== decision.requestDigest ||
        !sameJson(existingState.redactedRequest, redactedRequest) ||
        existingState.decision.policyVersion !== this.policyVersion ||
        !sameAuthorizationSemantics(existingState.decision, decision)
      )
        throw new AuthorizationConflictError()
    }

    const resource = this.store.getResource<ApprovalState>(APPROVAL_KIND, grantId, {
      includeDeleted: true
    })
    if (!resource || resource.deleted)
      throw new ApprovalValidationError('Approval grant unavailable.')
    const state = this.validateGrantState(resource.state)
    const grant = state.grant
    if (grant.useCount !== expectedUseCount || resource.revision !== expectedUseCount)
      throw new ApprovalRevisionConflictError()
    if (state.policyVersion !== this.policyVersion || state.createdByService !== this.storeId)
      throw new ApprovalValidationError('Approval policy/store identity mismatch.')
    if (evaluatedAt < grant.issuedAt || evaluatedAt >= grant.expiresAt)
      throw new ApprovalValidationError('Approval grant expired or not yet valid.')
    if (grant.useCount >= grant.maxUses || state.status !== 'active')
      throw new ApprovalValidationError('Approval grant exhausted.')
    if (grant.requestDigest !== decision.requestDigest)
      throw new ApprovalValidationError('Approval request digest mismatch.')
    if (actorKey(grant.actor) !== actorKey(request.actor))
      throw new ApprovalValidationError('Approval actor mismatch.')
    if (!this.isTrusted(grant.approvedBy))
      throw new ApprovalValidationError('Approver is no longer trusted.')
    if (!sameJson(grant.scope, deriveScope(request, decision)))
      throw new ApprovalValidationError('Approval scope mismatch.')
    if (!sameJson(grant.constraints, decision.constraints))
      throw new ApprovalValidationError('Approval constraints mismatch.')
    const nextUseCount = grant.useCount + 1
    const intentSeed = {
      discriminator: APPROVAL_CONSUMPTION_INTENT_DISCRIMINATOR,
      version: APPROVAL_CONSUMPTION_VERSION,
      grantId,
      requestDigest: decision.requestDigest,
      expectedUseCount: grant.useCount,
      nextUseCount,
      actor: grant.actor,
      scope: grant.scope,
      evaluatedAt,
      expiresAt: grant.expiresAt,
      authorization: false as const
    }
    const intent: ApprovalConsumptionIntent = {
      ...intentSeed,
      intentId: `approval-intent:${sha256PolicyText(canonicalPolicyJson(intentSeed as unknown as PolicyJsonValue))}`
    }
    const receipt: ApprovalConsumptionReceipt = {
      discriminator: APPROVAL_CONSUMPTION_RECEIPT_DISCRIMINATOR,
      version: APPROVAL_CONSUMPTION_VERSION,
      intentId: intent.intentId,
      grantId,
      requestDigest: decision.requestDigest,
      previousUseCount: grant.useCount,
      nextUseCount,
      consumedAt: evaluatedAt,
      storeRevision: String(resource.revision + 1),
      storeId: this.storeId
    }
    const nextGrant: ApprovalGrant = deepFreeze({ ...grant, useCount: nextUseCount })
    const nextApproval: ApprovalState = {
      ...state,
      status: nextUseCount === grant.maxUses ? 'exhausted' : 'active',
      grant: nextGrant
    }
    const audit: AuditState = {
      status: 'authorized',
      consumed: false,
      requestDigest: decision.requestDigest,
      redactedRequest,
      decision,
      outcome: 'approval-consumed',
      ...(decision.constraints === undefined ? {} : { constraints: decision.constraints }),
      issuedAt: evaluatedAt,
      expiresAt: Math.min(grant.expiresAt, evaluatedAt + PERMIT_LIFETIME_MS),
      receipt,
      lastAuthorizationCommandDigest: commandDigest,
      createdByService: this.storeId
    }
    let results
    try {
      results = this.store.mutateResourcesBatch([
        mutation(
          'update',
          APPROVAL_KIND,
          grantId,
          `${idempotencyKey}:grant`,
          resource.revision + 1,
          nextApproval,
          evaluatedAt,
          this.storeId,
          resource.revision,
          { intent, receipt }
        ),
        mutation(
          existingAudit ? 'update' : 'create',
          AUDIT_KIND,
          authorizationId,
          `${idempotencyKey}:audit`,
          existingAudit ? existingAudit.revision + 1 : 0,
          audit,
          evaluatedAt,
          this.storeId,
          existingAudit?.revision
        )
      ])
    } catch (error) {
      if (error instanceof ResourceRevisionConflictError)
        throw new ApprovalRevisionConflictError(undefined, { cause: error })
      throw error
    }
    return this.authorizedResult(authorizationId, audit, decision, results[1].resource.revision)
  }

  private createAwaitingWithDeniedAttempt(
    authorizationId: string,
    decision: PolicyDecision,
    redactedRequest: RedactedPolicyRequest,
    evaluatedAt: number,
    reason: string,
    idempotencyKey: string,
    baseCommandDigest: string,
    attemptCommandDigest: string,
    request: PolicyRequest
  ): AuthorizationResult {
    const awaiting: AuditState = {
      status: 'awaiting-approval',
      consumed: false,
      requestDigest: decision.requestDigest,
      redactedRequest,
      decision,
      outcome: 'awaiting-approval',
      reason: decision.approvalRequirement?.reason ?? 'Approval required.',
      ...(decision.constraints === undefined ? {} : { constraints: decision.constraints }),
      issuedAt: evaluatedAt,
      expiresAt: evaluatedAt,
      lastAuthorizationCommandDigest: baseCommandDigest,
      createdByService: this.storeId
    }
    const attemptId = `${authorizationId}:attempt:${sha256PolicyText(idempotencyKey)}`
    const attempt: AuditState = {
      ...awaiting,
      status: 'denied',
      outcome: 'denied',
      reason,
      lastAuthorizationCommandDigest: attemptCommandDigest
    }
    try {
      this.store.mutateResourcesBatch([
        mutation(
          'create',
          AUDIT_KIND,
          authorizationId,
          `${idempotencyKey}:awaiting`,
          0,
          awaiting,
          evaluatedAt,
          this.storeId
        ),
        mutation(
          'create',
          AUDIT_KIND,
          attemptId,
          `${idempotencyKey}:attempt`,
          0,
          attempt,
          evaluatedAt,
          this.storeId
        )
      ])
    } catch (error) {
      if (
        error instanceof EventStoreConflictError ||
        error instanceof ResourceRevisionConflictError
      ) {
        const current = this.store.getResource<AuditState>(AUDIT_KIND, authorizationId, {
          includeDeleted: true
        })
        if (current) {
          this.replayAuthorizationCommand(
            current,
            request,
            decision,
            evaluatedAt,
            baseCommandDigest,
            undefined,
            undefined,
            error
          )
          const attemptResource = this.store.getResource<AuditState>(AUDIT_KIND, attemptId, {
            includeDeleted: true
          })
          if (
            attemptResource &&
            this.auditState(attemptResource).lastAuthorizationCommandDigest === attemptCommandDigest
          )
            return deepFreeze({ status: 'denied', decision, reason })
        }
        throw new ApprovalRevisionConflictError(undefined, { cause: error })
      }
      throw error
    }
    return deepFreeze({ status: 'denied', decision, reason })
  }

  private recordAttemptAudit(
    authorizationId: string,
    decision: PolicyDecision,
    redactedRequest: RedactedPolicyRequest,
    evaluatedAt: number,
    reason: string,
    idempotencyKey: string,
    commandDigest: string
  ): AuthorizationResult {
    const attemptId = `${authorizationId}:attempt:${sha256PolicyText(idempotencyKey)}`
    return this.createNonAuthorizedAudit(
      attemptId,
      decision,
      redactedRequest,
      evaluatedAt,
      'denied',
      reason,
      `${idempotencyKey}:attempt`,
      commandDigest
    )
  }

  private createAuthorizedAudit(
    authorizationId: string,
    decision: PolicyDecision,
    redactedRequest: RedactedPolicyRequest,
    evaluatedAt: number,
    outcome: string,
    idempotencyKey: string,
    commandDigest: string
  ): AuthorizationResult {
    const audit: AuditState = {
      status: 'authorized',
      consumed: false,
      requestDigest: decision.requestDigest,
      redactedRequest,
      decision,
      outcome,
      ...(decision.constraints === undefined ? {} : { constraints: decision.constraints }),
      issuedAt: evaluatedAt,
      expiresAt: evaluatedAt + PERMIT_LIFETIME_MS,
      lastAuthorizationCommandDigest: commandDigest,
      createdByService: this.storeId
    }
    const result = this.store.mutateResource(
      mutation(
        'create',
        AUDIT_KIND,
        authorizationId,
        idempotencyKey,
        0,
        audit,
        evaluatedAt,
        this.storeId
      )
    )
    const stored = this.auditState(result.resource as StoredResource<AuditState>)
    if (stored.requestDigest !== decision.requestDigest) throw new AuthorizationConflictError()
    if (stored.lastAuthorizationCommandDigest !== commandDigest)
      throw new ApprovalRevisionConflictError()
    return this.authorizedResult(authorizationId, stored, stored.decision, result.resource.revision)
  }

  private createNonAuthorizedAudit(
    authorizationId: string,
    decision: PolicyDecision,
    redactedRequest: RedactedPolicyRequest,
    evaluatedAt: number,
    status: 'denied' | 'awaiting-approval',
    reason: string,
    idempotencyKey: string,
    commandDigest: string
  ): AuthorizationResult {
    const audit: AuditState = {
      status,
      consumed: false,
      requestDigest: decision.requestDigest,
      redactedRequest,
      decision,
      outcome: status,
      reason,
      ...(decision.constraints === undefined ? {} : { constraints: decision.constraints }),
      issuedAt: evaluatedAt,
      expiresAt: evaluatedAt,
      lastAuthorizationCommandDigest: commandDigest,
      createdByService: this.storeId
    }
    const result = this.store.mutateResource(
      mutation(
        'create',
        AUDIT_KIND,
        authorizationId,
        idempotencyKey,
        0,
        audit,
        evaluatedAt,
        this.storeId
      )
    )
    const stored = this.auditState(result.resource as StoredResource<AuditState>)
    if (stored.requestDigest !== decision.requestDigest) throw new AuthorizationConflictError()
    if (stored.lastAuthorizationCommandDigest !== commandDigest)
      throw new ApprovalRevisionConflictError()
    return deepFreeze({ status, decision: stored.decision, reason: stored.reason ?? reason })
  }

  private replayAuthorizationCommand(
    resource: StoredResource<AuditState>,
    request: PolicyRequest,
    decision: PolicyDecision,
    at: number,
    commandDigest: string,
    grantId?: string,
    expectedUseCount?: number,
    cause?: unknown
  ): AuthorizationResult {
    const state = this.auditState(resource)
    if (state.lastAuthorizationCommandDigest === commandDigest)
      return this.replay(resource, request, decision, at)
    if (
      state.status === 'authorized' &&
      state.receipt &&
      grantId !== undefined &&
      state.receipt.grantId === grantId &&
      state.receipt.previousUseCount === expectedUseCount &&
      state.requestDigest === decision.requestDigest
    )
      return this.replay(resource, request, decision, at)
    if (state.requestDigest !== digestPolicyRequest(request)) throw new AuthorizationConflictError()
    throw new ApprovalRevisionConflictError(undefined, cause === undefined ? undefined : { cause })
  }

  private replay(
    resource: StoredResource<AuditState>,
    request: PolicyRequest,
    currentDecision: PolicyDecision,
    at = currentDecision.evaluatedAt,
    requireCurrentDecision = false
  ): AuthorizationResult {
    if (resource.deleted) throw new PermitInvalidError('Authorization audit is deleted.')
    const state = this.auditState(resource)
    const digest = digestPolicyRequest(request)
    if (state.requestDigest !== digest) throw new AuthorizationConflictError()
    if (requireCurrentDecision || state.status === 'authorized') {
      if (!sameAuthorizationSemantics(state.decision, currentDecision))
        throw new PermitInvalidError('Current policy no longer authorizes this decision.')
    }
    if (state.status === 'authorized' && !state.consumed) {
      if (at > state.expiresAt) throw new PermitInvalidError('Authorization has expired.')
      return this.authorizedResult(resource.id, state, state.decision, resource.revision)
    }
    if (state.status === 'consumed' || state.consumed)
      return deepFreeze({
        status: 'already-consumed',
        decision: state.decision,
        reason: 'already-consumed'
      })
    return deepFreeze({
      status: state.status,
      decision: state.decision,
      reason: state.reason ?? state.outcome
    }) as AuthorizationResult
  }

  private authorizedResult(
    authorizationId: string,
    audit: AuditState,
    decision: PolicyDecision,
    revision: number
  ): AuthorizationResult {
    const permit = deepFreeze({
      authorizationId,
      requestDigest: audit.requestDigest,
      decisionId: decision.decisionId,
      constraints: audit.constraints,
      issuedAt: audit.issuedAt,
      expiresAt: audit.expiresAt,
      storeId: this.storeId
    })
    this.permitBrands.add(permit)
    return deepFreeze({ status: 'authorized', permit, decision, auditRevision: revision })
  }

  private auditState(resource: StoredResource<AuditState>): AuditState {
    let state: unknown
    try {
      state = resource.state
      if (!plain(state)) throw new Error('not a record')
      const status = own(state, 'status')
      const outcome = own(state, 'outcome')
      if (!['authorized', 'denied', 'awaiting-approval', 'consumed'].includes(String(status)))
        throw new Error('invalid status')
      if (
        (status === 'authorized' &&
          !['direct-allow', 'approval-consumed'].includes(String(outcome))) ||
        (status === 'denied' && outcome !== 'denied') ||
        (status === 'awaiting-approval' && outcome !== 'awaiting-approval') ||
        (status === 'consumed' && !['direct-allow', 'approval-consumed'].includes(String(outcome)))
      )
        throw new Error('invalid outcome')
      const parsedDecision = parsePolicyDecision(own(state, 'decision'))
      if (!parsedDecision.ok || parsedDecision.value.policyVersion !== this.policyVersion)
        throw new Error('invalid decision')
      const requestDigest = own(state, 'requestDigest')
      if (requestDigest !== parsedDecision.value.requestDigest) throw new Error('digest mismatch')
      const redacted = own(state, 'redactedRequest')
      if (!plain(redacted)) throw new Error('invalid redacted request')
      const parsedRequest = parsePolicyRequest(own(redacted, 'request'))
      const paths = own(redacted, 'redactedPaths')
      const redactedDigest = own(redacted, 'requestDigest')
      if (
        !parsedRequest.ok ||
        redactedDigest !== requestDigest ||
        !Array.isArray(paths) ||
        !paths.every((path) => typeof path === 'string') ||
        !paths.every((path, index) => index === 0 || String(paths[index - 1]) <= path)
      )
        throw new Error('invalid redacted request')
      if (!sameJson(ownOptional(state, 'constraints'), parsedDecision.value.constraints))
        throw new Error('constraint mismatch')
      const issuedAt = own(state, 'issuedAt')
      const expiresAt = own(state, 'expiresAt')
      if (!safeTime(issuedAt) || !safeTime(expiresAt) || expiresAt < issuedAt)
        throw new Error('invalid times')
      const consumed = own(state, 'consumed')
      if (typeof consumed !== 'boolean' || (status === 'consumed') !== consumed)
        throw new Error('invalid consumed state')
      if (own(state, 'createdByService') !== this.storeId) throw new Error('store mismatch')
      const commandDigest = ownOptional(state, 'lastAuthorizationCommandDigest')
      if (
        commandDigest !== undefined &&
        (typeof commandDigest !== 'string' || !/^[a-f0-9]{64}$/.test(commandDigest))
      )
        throw new Error('invalid authorization command digest')
      const receiptValue = ownOptional(state, 'receipt')
      if (receiptValue !== undefined) {
        const receipt = parseApprovalConsumptionReceipt(receiptValue)
        if (
          !receipt.ok ||
          receipt.value.requestDigest !== requestDigest ||
          receipt.value.storeId !== this.storeId
        )
          throw new Error('invalid receipt')
      }
      return deepFreeze(cloneJsonValue(state as AuditState))
    } catch (error) {
      throw new PermitInvalidError(
        error instanceof Error
          ? `Corrupt authorization audit: ${error.message}`
          : 'Corrupt authorization audit.'
      )
    }
  }

  private validateGrantState(input: ApprovalState): ApprovalState {
    try {
      if (!plain(input)) throw new Error('not a record')
      const parsed = parseApprovalGrant(own(input, 'grant'))
      if (!parsed.ok) throw new Error(parsed.error)
      const status = own(input, 'status')
      if (status !== 'active' && status !== 'exhausted') throw new Error('invalid status')
      if ((status === 'exhausted') !== (parsed.value.useCount === parsed.value.maxUses))
        throw new Error('status/use count mismatch')
      if (
        own(input, 'requestDigest') !== parsed.value.requestDigest ||
        own(input, 'policyVersion') !== this.policyVersion ||
        own(input, 'createdByService') !== this.storeId ||
        !this.isTrusted(parsed.value.approvedBy)
      )
        throw new Error('metadata mismatch')
      return deepFreeze(cloneJsonValue({ ...input, grant: parsed.value }))
    } catch (error) {
      throw new ApprovalValidationError(
        error instanceof Error
          ? `Corrupt approval state: ${error.message}`
          : 'Corrupt approval state.'
      )
    }
  }

  private evaluate(request: PolicyRequest, evaluatedAt: number): PolicyDecision {
    return evaluatePolicy(request, this.rules, { evaluatedAt, policyVersion: this.policyVersion })
  }

  private isTrusted(actor: MagicAgentActorRef): boolean {
    return plain(actor) && this.trustedApprovers.has(actorKey(actor))
  }
}

function mutation(
  operation: 'create' | 'update',
  kind: string,
  id: string,
  idempotencyKey: string,
  sequence: number,
  state: unknown,
  createdAt: number,
  serviceId: string,
  expectedRevision?: number,
  payload: unknown = state
): ResourceMutationInput {
  const event: MagicAgentEvent<unknown> = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION.value,
    envelopeKind: 'event',
    id: `${idempotencyKey}:event`,
    streamId: `policy-resource:${kind}:${encodeURIComponent(id)}`,
    sequence,
    type: `policy.${kind}.${operation}`,
    createdAt,
    actor: { kind: 'system', id: serviceId },
    payload
  }
  return {
    operation,
    kind,
    id,
    idempotencyKey,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    state,
    createdAt,
    event
  }
}

function authorizationCommandDigest(input: {
  authorizationId: string
  requestDigest: string
  grantId?: string
  expectedGrantUseCount?: number
  idempotencyKey: string
}): string {
  return sha256PolicyText(
    canonicalPolicyJson({
      authorizationId: input.authorizationId,
      requestDigest: input.requestDigest,
      grantId: input.grantId ?? null,
      expectedGrantUseCount: input.expectedGrantUseCount ?? null,
      idempotencyKey: input.idempotencyKey
    })
  )
}

function baseAuthorizationCommandDigest(
  authorizationId: string,
  requestDigest: string,
  idempotencyKey: string
): string {
  return authorizationCommandDigest({ authorizationId, requestDigest, idempotencyKey })
}

function approvalReason(error: ApprovalValidationError | ApprovalRevisionConflictError): string {
  return error instanceof ApprovalRevisionConflictError
    ? 'approval-revision-conflict'
    : 'approval-validation-failed'
}

function requestOf(input: unknown): PolicyRequest {
  const parsed = parsePolicyRequest(input)
  if (!parsed.ok) throw new ApprovalValidationError(parsed.error)
  return parsed.value
}
function deriveScope(_request: PolicyRequest, decision: PolicyDecision): ApprovalGrant['scope'] {
  const requirement = decision.approvalRequirement
  if (!requirement) throw new ApprovalValidationError('Missing approval requirement.')
  if (requirement.scopeKind !== 'request')
    throw new ApprovalValidationError('Approval scope is not supported by this store.')
  return { kind: 'request', value: decision.requestDigest }
}
function sameAuthorizationSemantics(a: PolicyDecision, b: PolicyDecision): boolean {
  return (
    a.policyVersion === b.policyVersion &&
    a.requestDigest === b.requestDigest &&
    a.effect === b.effect &&
    sameJson(a.constraints, b.constraints) &&
    sameJson(a.approvalRequirement, b.approvalRequirement) &&
    sameJson(a.matchedRuleIds, b.matchedRuleIds) &&
    sameReasonSafety(a.reasonCode, b.reasonCode)
  )
}

function sameReasonSafety(a: string, b: string): boolean {
  if (a === b) return true
  const safetyReasons = new Set([
    'destructive-safety-floor',
    'insufficient-allow-specificity',
    'constraints-empty',
    'constraints-conflict',
    'approval-requirement-conflict',
    'unknown-effect'
  ])
  return !safetyReasons.has(a) && !safetyReasons.has(b)
}
function actorKey(actor: { kind?: unknown; id?: unknown }): string {
  return `${text(actor.kind, 'actor.kind')}\u0000${text(actor.id, 'actor.id')}`
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim())
    throw new ApprovalValidationError(`${name} must be a non-empty trimmed string.`)
  return value
}
function time(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new ApprovalValidationError(`${name} must be a non-negative safe integer.`)
  return value
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}
function own(record: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`missing ${key}`)
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor || !('value' in descriptor)) throw new Error(`unsafe ${key}`)
  return descriptor.value
}
function ownOptional(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? own(record, key) : undefined
}
function safeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
function sameJson(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b
  return canonicalPolicyJson(a as PolicyJsonValue) === canonicalPolicyJson(b as PolicyJsonValue)
}
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
    Object.freeze(value)
  }
  return value
}
