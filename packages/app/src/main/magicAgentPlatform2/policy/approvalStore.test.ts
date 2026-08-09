import { describe, expect, it } from 'vitest'
import type { PolicyRequest } from '../../../shared/magicAgentPlatform2'
import { redactPolicyRequestForAudit } from './redaction'

const request = (input: Record<string, unknown>): PolicyRequest =>
  ({
    discriminator: 'magic-agent.policy-request.v1',
    version: 1,
    requestId: 'request-1',
    actor: { kind: 'user', id: 'user-1' },
    origin: 'internal',
    action: 'filesystem.read',
    target: { kind: 'file', id: 'one' },
    input,
    effects: [{ kind: 'filesystem.read', risk: 'read' }]
  }) as PolicyRequest

describe('redactPolicyRequestForAudit', () => {
  it('redacts nested sensitive keys while preserving ordinary message content', () => {
    const result = redactPolicyRequestForAudit(
      request({
        password: 'alpha',
        nested: [{ apiKey: 'beta', message: 'token appears in ordinary text' }],
        COOKIE: 'gamma'
      })
    )
    expect(result.request.input).toEqual({
      password: '[REDACTED]',
      nested: [{ apiKey: '[REDACTED]', message: 'token appears in ordinary text' }],
      COOKIE: '[REDACTED]'
    })
    expect(result.redactedPaths).toEqual([
      'input.COOKIE',
      'input.nested[0].apiKey',
      'input.password'
    ])
    expect(Object.isFrozen(result.request.input)).toBe(true)
  })
})

import { afterEach } from 'vitest'
import type { PolicyRule } from '../../../shared/magicAgentPlatform2'
import { MagicAgentEventStore } from '../persistence/eventStore'
import {
  ApprovalRevisionConflictError,
  MagicAgentPolicyAuthorizationService
} from './approvalStore'

const stores: MagicAgentEventStore[] = []
afterEach(() => {
  while (stores.length) stores.pop()?.close()
})

const approvalService = () => {
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  const rules: PolicyRule[] = [
    {
      ruleId: 'approval',
      priority: 1,
      effect: 'require-approval',
      explanation: 'approval'
    }
  ]
  return {
    store,
    service: new MagicAgentPolicyAuthorizationService({
      store,
      rules,
      policyVersion: 'policy-1',
      storeId: 'store-1',
      trustedApprovers: [{ kind: 'user', id: 'approver-1' }]
    })
  }
}

const approvalRequest = (): PolicyRequest => request({}) as PolicyRequest

describe('authorization command persistence', () => {
  it('keeps the primary authorization awaiting when the first grant is invalid', () => {
    const { store, service } = approvalService()
    const result = service.authorize({
      authorizationId: 'authorization-1',
      request: approvalRequest(),
      evaluatedAt: 1000,
      grantId: 'missing-grant',
      expectedGrantUseCount: 0,
      idempotencyKey: 'invalid-attempt'
    })

    expect(result).toMatchObject({ status: 'denied' })
    expect(store.getResource('policy-audit', 'authorization-1')?.state).toMatchObject({
      status: 'awaiting-approval'
    })
  })

  it('does not replay the same authorization id for a different command', () => {
    const { service } = approvalService()
    service.authorize({
      authorizationId: 'authorization-1',
      request: approvalRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'first-command'
    })

    expect(() =>
      service.authorize({
        authorizationId: 'authorization-1',
        request: approvalRequest(),
        evaluatedAt: 1100,
        idempotencyKey: 'different-command'
      })
    ).toThrow(ApprovalRevisionConflictError)
  })
})
