import {
  canonicalPolicyJson,
  createTriggerPolicyRequest,
  digestPolicyRequest,
  sha256PolicyText,
  type PolicyConstraints,
  type PolicyRequest,
  type TriggerPolicyRequestFactoryInput
} from '../../../shared/magicAgentPlatform2/policy'
import type { AuthorizationResult, MagicAgentPolicyAuthorizationService } from '../policy'

export type TriggerPolicyGrant = Readonly<{
  grantId: string
  expectedGrantUseCount?: number
}>

export type TriggerPolicyGrantProvider = (
  request: PolicyRequest
) => TriggerPolicyGrant | undefined | Promise<TriggerPolicyGrant | undefined>

export type TriggerPolicyExecutor<TResult> = (
  request: PolicyRequest,
  authorization: Readonly<{
    authorizationId: string
    auditRevision: number
    constraints?: PolicyConstraints
  }>
) => TResult | Promise<TResult>

export type TriggerPermitConsumedHook = (
  input: Readonly<{
    request: PolicyRequest
    authorizationId: string
    requestDigest: string
    consumption: Readonly<{ auditRevision: number; authorizationId: string }>
  }>
) => void | Promise<void>

export type TriggerPolicyExecutionResult<TResult> =
  | Readonly<{
      status: 'executed'
      request: PolicyRequest
      authorization: Extract<AuthorizationResult, { status: 'authorized' }>
      result: TResult
    }>
  | Readonly<{
      status: 'denied' | 'awaiting-approval' | 'already-consumed'
      request: PolicyRequest
      authorization: Exclude<AuthorizationResult, { status: 'authorized' }>
    }>

export class TriggerPolicyExecutionError extends Error {
  readonly code = 'MAGIC_AGENT_TRIGGER_POLICY_EXECUTION'

  constructor(
    readonly authorizationId: string,
    readonly requestDigest: string,
    readonly consumption: Readonly<{ authorizationId: string; auditRevision: number }>,
    cause: unknown
  ) {
    super(
      `Trigger execution failed after consuming authorization ${authorizationId} (${requestDigest}).`,
      { cause }
    )
    this.name = 'TriggerPolicyExecutionError'
  }
}

export class TriggerPolicyPostConsumptionError extends Error {
  readonly code = 'MAGIC_AGENT_TRIGGER_POST_CONSUMPTION'
  constructor(
    readonly authorizationId: string,
    readonly requestDigest: string,
    readonly consumption: Readonly<{ authorizationId: string; auditRevision: number }>,
    cause: unknown
  ) {
    super(
      `Trigger permit was consumed but outcome recording failed for ${authorizationId} (${requestDigest}).`,
      { cause }
    )
    this.name = 'TriggerPolicyPostConsumptionError'
  }
}

export class TriggerPolicyExecutionBoundary<TResult = void> {
  constructor(
    private readonly authorizationService: MagicAgentPolicyAuthorizationService,
    private readonly grantProvider: TriggerPolicyGrantProvider,
    private readonly executeTrigger: TriggerPolicyExecutor<TResult>,
    private readonly now: () => number = Date.now,
    private readonly onPermitConsumed?: TriggerPermitConsumedHook
  ) {}

  async execute(
    input: TriggerPolicyRequestFactoryInput
  ): Promise<TriggerPolicyExecutionResult<TResult>> {
    const request = this.stabilizeRequest(createTriggerPolicyRequest(input))
    const requestDigest = digestPolicyRequest(request)
    const authorizationId = `trigger-authorization:${requestDigest}`
    const authorizationKey = `trigger:${requestDigest}`
    let authorization = this.authorizationService.authorize({
      authorizationId,
      request,
      evaluatedAt: this.now(),
      idempotencyKey: `trigger-authorize:${authorizationKey}`
    })
    if (authorization.status === 'awaiting-approval') {
      const grant = await this.grantProvider(request)
      if (grant !== undefined)
        authorization = this.authorizationService.authorize({
          authorizationId,
          request,
          evaluatedAt: this.now(),
          ...grant,
          idempotencyKey: `trigger-authorize:${authorizationKey}:grant`
        })
    }
    if (authorization.status !== 'authorized') {
      return { status: authorization.status, request, authorization }
    }

    let consumed: Readonly<{ authorizationId: string; auditRevision: number }>
    try {
      consumed = this.authorizationService.consumeExecutionPermit({
        permit: authorization.permit,
        request,
        consumedAt: this.now(),
        idempotencyKey: `trigger-consume:${authorizationKey}`
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'PermitConsumedError') {
        if (this.onPermitConsumed) {
          await this.onPermitConsumed({
            request,
            authorizationId,
            requestDigest,
            consumption: { authorizationId, auditRevision: authorization.auditRevision }
          })
        }
        return {
          status: 'already-consumed',
          request,
          authorization: { status: 'already-consumed' } as never
        }
      }
      throw error
    }
    if (this.onPermitConsumed) {
      try {
        await this.onPermitConsumed({
          request,
          authorizationId,
          requestDigest,
          consumption: consumed
        })
      } catch (error) {
        throw new TriggerPolicyPostConsumptionError(authorizationId, requestDigest, consumed, error)
      }
    }
    try {
      const result = await this.executeTrigger(request, consumed)
      return { status: 'executed', request, authorization, result }
    } catch (error) {
      throw new TriggerPolicyExecutionError(
        consumed.authorizationId,
        requestDigest,
        consumed,
        error
      )
    }
  }

  private stabilizeRequest(request: PolicyRequest): PolicyRequest {
    const seedRequest = { ...request, requestId: 'trigger-request:seed' }
    const requestId = `trigger-request:${digestPolicyRequest(seedRequest)}`
    return { ...request, requestId }
  }
}
