import { randomUUID } from 'node:crypto'
import type { PolicyRequest } from '../../shared/magicAgentPlatform2'
import type { MagicAgentPolicyAuthorizationService } from './policy/approvalStore'
import { redactPolicyRequestForAudit } from './policy/redaction'

export type TerminalApprovalReference = Readonly<{
  authorizationId?: string
  grantId: string
  expectedGrantUseCount: number
}>

export type PendingTerminalApproval = Readonly<{
  approvalId: string
  revision: number
  createdAt: number
  expiresAt: number
  status?: 'pending' | 'approved' | 'denied'
  updatedAt?: number
  request: ReturnType<typeof redactPolicyRequestForAudit>
  graphContext?: Readonly<{
    runId: string
    nodeId: string
    toolName: string
    requestDigest: string
  }>
}>

export type TerminalApprovalRequest = Readonly<{
  pending: PendingTerminalApproval
  decision: Promise<TerminalApprovalReference>
}>

type PendingApproval = Readonly<{
  approval: PendingTerminalApproval
  request: PolicyRequest
  resolve: (reference: TerminalApprovalReference) => void
  reject: (reason: Error) => void
}>

export class TerminalApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(
    private readonly authorization: MagicAgentPolicyAuthorizationService,
    private readonly createGrant: (
      request: PolicyRequest
    ) => Omit<TerminalApprovalReference, 'authorizationId'>
  ) {}

  request(
    request: PolicyRequest,
    graphContext?: PendingTerminalApproval['graphContext']
  ): Promise<TerminalApprovalReference> {
    return this.requestWithSnapshot(request, graphContext).decision
  }

  requestWithSnapshot(
    request: PolicyRequest,
    graphContext?: PendingTerminalApproval['graphContext']
  ): TerminalApprovalRequest {
    const approvalId = randomUUID()
    const authorization = this.authorization.authorize({
      authorizationId: approvalId,
      request,
      evaluatedAt: Date.now(),
      idempotencyKey: `assistant-terminal-await:${approvalId}`
    })
    if (authorization.status !== 'awaiting-approval') {
      const createdAt = Date.now()
      return {
        pending: {
          approvalId,
          revision: 0,
          createdAt,
          expiresAt: createdAt,
          request: redactPolicyRequestForAudit(request),
          ...(graphContext ? { graphContext } : {})
        },
        decision: Promise.reject(new Error('Terminal request did not enter awaiting approval.'))
      }
    }

    const createdAt = Date.now()
    const approval: PendingTerminalApproval = {
      approvalId,
      revision: 0,
      createdAt,
      expiresAt: createdAt + 5 * 60_000,
      request: redactPolicyRequestForAudit(request),
      ...(graphContext ? { graphContext } : {})
    }
    const decision = new Promise<TerminalApprovalReference>((resolve, reject) => {
      this.pending.set(approvalId, { approval, request, resolve, reject })
    })
    return { pending: approval, decision }
  }

  list(): readonly PendingTerminalApproval[] {
    return [...this.pending.values()].map((item) => item.approval)
  }

  resolve(input: {
    approvalId: string
    expectedRevision: number
    approved: boolean
  }): PendingTerminalApproval {
    const pending = this.pending.get(input.approvalId)
    if (!pending || pending.approval.revision !== input.expectedRevision)
      throw new Error('Pending terminal approval was not found or has changed.')
    const resolvedApproval: PendingTerminalApproval = {
      ...pending.approval,
      status: input.approved ? 'approved' : 'denied',
      revision: pending.approval.revision + 1,
      updatedAt: Date.now()
    }

    if (!input.approved) {
      this.pending.delete(input.approvalId)
      pending.reject(new Error('Terminal execution was denied by the user.'))
      return resolvedApproval
    }

    const grant = this.createGrant(pending.request)
    queueMicrotask(() => {
      this.pending.delete(input.approvalId)
      pending.resolve({
        authorizationId: input.approvalId,
        grantId: grant.grantId,
        expectedGrantUseCount: grant.expectedGrantUseCount
      })
    })
    return resolvedApproval
  }

  shutdown(): void {
    for (const item of this.pending.values())
      item.reject(new Error('Terminal approval service is shutting down.'))
    this.pending.clear()
  }
}
