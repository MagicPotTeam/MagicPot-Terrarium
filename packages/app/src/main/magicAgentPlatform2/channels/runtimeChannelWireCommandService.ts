import {
  digestPolicyRequest,
  POLICY_REQUEST_DISCRIMINATOR,
  POLICY_REQUEST_VERSION,
  type PolicyActorRef,
  type PolicyRequest
} from '../../../shared/magicAgentPlatform2/policy'
import type { RuntimeChannelWireState } from '../../../shared/magicAgentPlatform2/runtimeChannel'
import { MagicAgentPolicyAuthorizationService, PermitConsumedError } from '../policy'
import type { PersistentRuntimeChannelWireStore } from './persistentRuntimeChannelWireStore'

export const createRuntimeChannelWirePolicyRequest = (input: {
  actor: PolicyActorRef
  action: 'wire' | 'unwire'
  wireId: string
  sourceChannelId?: string
  targetChannelId?: string
  revision?: number
}): PolicyRequest => {
  const request = {
    discriminator: POLICY_REQUEST_DISCRIMINATOR,
    version: POLICY_REQUEST_VERSION,
    requestId: 'runtime-channel-wire:seed',
    actor: input.actor,
    origin: 'internal' as const,
    action: `runtime-channel.${input.action}`,
    target: { kind: 'runtime-channel-wire', id: input.wireId, source: 'dynamic-agent-fabric' },
    input: {
      wireId: input.wireId,
      ...(input.sourceChannelId ? { sourceChannelId: input.sourceChannelId } : {}),
      ...(input.targetChannelId ? { targetChannelId: input.targetChannelId } : {}),
      ...(input.revision === undefined ? {} : { revision: input.revision })
    },
    effects: [
      {
        kind: 'external.message' as const,
        risk: 'high' as const,
        target: input.wireId,
        metadata: { topologyAction: input.action }
      }
    ]
  }
  return { ...request, requestId: `runtime-channel-wire:${digestPolicyRequest(request)}` }
}

export class RuntimeChannelWireCommandService {
  constructor(
    private readonly store: PersistentRuntimeChannelWireStore,
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    private readonly now: () => number = Date.now
  ) {}

  wire(input: {
    actor: PolicyActorRef
    wire: RuntimeChannelWireState
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const request = createRuntimeChannelWirePolicyRequest({
      actor: input.actor,
      action: 'wire',
      wireId: input.wire.id,
      sourceChannelId: input.wire.sourceChannelId,
      targetChannelId: input.wire.targetChannelId
    })
    const authorized = this.authorize(request, input)
    if (!authorized) return this.store.get(input.wire.id)
    return this.store.wire({ wire: input.wire, idempotencyKey: input.idempotencyKey })
  }

  unwire(input: {
    actor: PolicyActorRef
    wireId: string
    expectedRevision: number
    removedAt: number
    idempotencyKey: string
    grantId?: string
    expectedGrantUseCount?: number
  }) {
    const request = createRuntimeChannelWirePolicyRequest({
      actor: input.actor,
      action: 'unwire',
      wireId: input.wireId,
      revision: input.expectedRevision
    })
    const authorized = this.authorize(request, input)
    if (!authorized) return this.store.get(input.wireId)
    return this.store.unwire(input)
  }

  private authorize(
    request: PolicyRequest,
    input: { idempotencyKey: string; grantId?: string; expectedGrantUseCount?: number }
  ): boolean {
    const result = this.authorization.authorize({
      authorizationId: `runtime-channel-wire-authorization:${digestPolicyRequest(request)}`,
      request,
      evaluatedAt: this.now(),
      idempotencyKey: `channel-wire:authorize:${input.idempotencyKey}`,
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.expectedGrantUseCount === undefined
        ? {}
        : { expectedGrantUseCount: input.expectedGrantUseCount })
    })
    if (result.status !== 'authorized')
      throw new Error(`Runtime Channel topology ${result.status}.`)
    try {
      this.authorization.consumeExecutionPermit({
        permit: result.permit,
        request,
        consumedAt: this.now(),
        idempotencyKey: `channel-wire:consume:${input.idempotencyKey}`
      })
    } catch (error) {
      if (error instanceof PermitConsumedError) return false
      throw error
    }
    return true
  }
}
