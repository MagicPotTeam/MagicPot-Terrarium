import { afterEach, describe, expect, it } from 'vitest'
import type { PolicyRequest, PolicyRule } from '../../../shared/magicAgentPlatform2'
import { MagicAgentEventStore } from '../persistence/eventStore'
import {
  ApprovalValidationError,
  AuthorizationConflictError,
  ApprovalRevisionConflictError,
  MagicAgentPolicyAuthorizationService,
  PermitInvalidError
} from './approvalStore'

const actor = { kind: 'agent', id: 'agent-1' } as const
const approver = { kind: 'user', id: 'approver-1' } as const
const baseRequest = (patch: Partial<PolicyRequest> = {}): PolicyRequest => ({
  discriminator: 'magic-agent.policy-request.v1',
  version: 1,
  requestId: 'request-1',
  actor,
  origin: 'assistant',
  action: 'file.write',
  target: { kind: 'file', id: '/tmp/a' },
  input: {},
  effects: [{ kind: 'filesystem.write', risk: 'write', target: '/tmp/a' }],
  ...patch
})
const allowRequest = (patch: Partial<PolicyRequest> = {}): PolicyRequest =>
  baseRequest({
    action: 'file.read',
    effects: [{ kind: 'filesystem.read', risk: 'read', target: '/tmp/a' }],
    ...patch
  })
const rule = (effect: PolicyRule['effect'], patch: Partial<PolicyRule> = {}): PolicyRule => ({
  ruleId: effect,
  priority: 1,
  effect,
  explanation: effect,
  ...patch
})
const make = (rules: readonly PolicyRule[] = [rule('allow')]) => {
  const store = new MagicAgentEventStore(':memory:')
  const service = new MagicAgentPolicyAuthorizationService({
    store,
    rules,
    policyVersion: 'policy-1',
    storeId: 'store-1',
    trustedApprovers: [approver]
  })
  return { store, service }
}
const approvalRules = [rule('require-approval')]
const grantInput = (service: MagicAgentPolicyAuthorizationService, request = baseRequest()) =>
  service.createApprovalGrant({
    grantId: 'grant-1',
    request,
    approvedBy: approver,
    issuedAt: 1000,
    expiresAt: 2000,
    maxUses: 1,
    idempotencyKey: 'grant-key'
  })

let stores: MagicAgentEventStore[] = []
afterEach(() => {
  for (const store of stores) store.close()
  stores = []
})
const setup = (rules: readonly PolicyRule[] = [rule('allow')]) => {
  const result = make(rules)
  stores.push(result.store)
  return result
}

describe('MagicAgentPolicyAuthorizationService', () => {
  it('constructs with valid SQLite-backed options', () =>
    expect(setup().service).toBeInstanceOf(MagicAgentPolicyAuthorizationService))
  it('rejects an empty trusted approver list', () =>
    expect(
      () =>
        new MagicAgentPolicyAuthorizationService({
          store: new MagicAgentEventStore(':memory:'),
          rules: [rule('allow')],
          policyVersion: 'p',
          storeId: 's',
          trustedApprovers: []
        })
    ).toThrow(ApprovalValidationError))
  it('rejects duplicate trusted approvers', () => {
    const store = new MagicAgentEventStore(':memory:')
    stores.push(store)
    expect(
      () =>
        new MagicAgentPolicyAuthorizationService({
          store,
          rules: [rule('allow')],
          policyVersion: 'p',
          storeId: 's',
          trustedApprovers: [approver, approver]
        })
    ).toThrow(ApprovalValidationError)
  })

  it('creates a grant with request scope, expiry, maxUses, and constraints', () => {
    const { service } = setup([rule('require-approval', { constraints: { readOnly: true } })])
    const result = service.createApprovalGrant({
      grantId: 'g',
      request: baseRequest(),
      approvedBy: approver,
      issuedAt: 1000,
      expiresAt: 2000,
      maxUses: 1,
      constraints: { readOnly: true },
      idempotencyKey: 'k'
    })
    expect(result.inserted).toBe(true)
    expect(result.grant).toMatchObject({
      grantId: 'g',
      scope: { kind: 'request', value: result.grant.requestDigest },
      requestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      issuedAt: 1000,
      expiresAt: 2000,
      maxUses: 1,
      useCount: 0,
      constraints: { readOnly: true },
      approvedBy: approver
    })
  })
  it('replays an idempotent grant creation', () => {
    const { service } = setup(approvalRules)
    const a = grantInput(service)
    const b = grantInput(service)
    expect(b.inserted).toBe(false)
    expect(b.grant).toEqual(a.grant)
  })
  it('rejects a grant for a non-approval request', () => {
    const { service } = setup()
    expect(() => grantInput(service, allowRequest())).toThrow('require-approval')
  })
  it('rejects an untrusted approver', () => {
    const { service } = setup(approvalRules)
    expect(() =>
      service.createApprovalGrant({
        grantId: 'x',
        request: baseRequest(),
        approvedBy: { kind: 'user', id: 'other' },
        issuedAt: 1000,
        expiresAt: 2000,
        maxUses: 1,
        idempotencyKey: 'x'
      })
    ).toThrow('not trusted')
  })
  it('rejects expiry beyond the requirement', () => {
    const { service } = setup(approvalRules)
    expect(() =>
      service.createApprovalGrant({
        grantId: 'x',
        request: baseRequest(),
        approvedBy: approver,
        issuedAt: 1000,
        expiresAt: 301001,
        maxUses: 1,
        idempotencyKey: 'x'
      })
    ).toThrow(ApprovalValidationError)
  })
  it('rejects non-positive or excessive maxUses', () => {
    const { service } = setup(approvalRules)
    for (const maxUses of [0, 2])
      expect(() =>
        service.createApprovalGrant({
          grantId: String(maxUses),
          request: baseRequest(),
          approvedBy: approver,
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses,
          idempotencyKey: String(maxUses)
        })
      ).toThrow(ApprovalValidationError)
  })
  it('rejects constraints that differ from policy', () => {
    const { service } = setup([rule('require-approval', { constraints: { readOnly: true } })])
    expect(() =>
      service.createApprovalGrant({
        grantId: 'x',
        request: baseRequest(),
        approvedBy: approver,
        issuedAt: 1000,
        expiresAt: 2000,
        maxUses: 1,
        constraints: { readOnly: false },
        idempotencyKey: 'x'
      })
    ).toThrow(ApprovalValidationError)
  })
  it('rejects an expiry at or before issuance', () => {
    const { service } = setup(approvalRules)
    expect(() =>
      service.createApprovalGrant({
        grantId: 'x',
        request: baseRequest(),
        approvedBy: approver,
        issuedAt: 1000,
        expiresAt: 1000,
        maxUses: 1,
        idempotencyKey: 'x'
      })
    ).toThrow(ApprovalValidationError)
  })

  it('queries immutable audit resources for policy outcomes', () => {
    const { service } = setup([rule('deny')])
    service.authorize({
      authorizationId: 'audit-deny',
      request: baseRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'audit-deny-key'
    })
    const audits = service.listAuditResources({ limit: 10 })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      kind: 'policy-audit',
      state: {
        status: 'denied'
      }
    })
    expect(audits[0].deleted).toBe(false)
  })

  it('authorizes direct allow', () => {
    const { service } = setup()
    const result = service.authorize({
      authorizationId: 'a',
      request: allowRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'k'
    })
    expect(result.status).toBe('authorized')
    if (result.status === 'authorized') expect(service.isTrustedPermit(result.permit)).toBe(true)
  })
  it('authorizes allow-with-constraints', () => {
    const { service } = setup([rule('allow-with-constraints', { constraints: { readOnly: true } })])
    const result = service.authorize({
      authorizationId: 'a',
      request: allowRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'k'
    })
    expect(result).toMatchObject({
      status: 'authorized',
      permit: { constraints: { readOnly: true } }
    })
  })
  it('denies a deny policy branch', () => {
    const { service } = setup([rule('deny')])
    expect(
      service.authorize({
        authorizationId: 'a',
        request: baseRequest(),
        evaluatedAt: 1000,
        idempotencyKey: 'k'
      })
    ).toMatchObject({ status: 'denied' })
  })
  it('returns awaiting approval without a grant', () => {
    const { service } = setup(approvalRules)
    expect(
      service.authorize({
        authorizationId: 'a',
        request: baseRequest(),
        evaluatedAt: 1000,
        idempotencyKey: 'k'
      })
    ).toMatchObject({ status: 'awaiting-approval' })
  })
  it('consumes a valid grant and authorizes', () => {
    const { service } = setup(approvalRules)
    const grant = grantInput(service)
    const result = service.authorize({
      authorizationId: 'a',
      request: baseRequest(),
      evaluatedAt: 1100,
      grantId: grant.grant.grantId,
      expectedGrantUseCount: 0,
      idempotencyKey: 'auth'
    })
    expect(result.status).toBe('authorized')
  })
  it('rejects a grant for a different request', () => {
    const { service } = setup(approvalRules)
    const grant = grantInput(service)
    expect(
      service.authorize({
        authorizationId: 'a',
        request: baseRequest({ requestId: 'other' }),
        evaluatedAt: 1100,
        grantId: grant.grant.grantId,
        expectedGrantUseCount: 0,
        idempotencyKey: 'auth'
      })
    ).toMatchObject({ status: 'denied' })
  })
  it('replays awaiting authorization by the same authorizationId', () => {
    const { service } = setup(approvalRules)
    const input = {
      authorizationId: 'a',
      request: baseRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'k'
    }
    expect(service.authorize(input)).toMatchObject({ status: 'awaiting-approval' })
    expect(service.authorize(input)).toMatchObject({ status: 'awaiting-approval' })
  })
  it('upgrades awaiting authorization with a grant', () => {
    const { service } = setup(approvalRules)
    service.authorize({
      authorizationId: 'a',
      request: baseRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'wait'
    })
    const grant = grantInput(service)
    expect(
      service.authorize({
        authorizationId: 'a',
        request: baseRequest(),
        evaluatedAt: 1100,
        grantId: grant.grant.grantId,
        expectedGrantUseCount: 0,
        idempotencyKey: 'upgrade'
      }).status
    ).toBe('authorized')
  })
  it('replays an authorized result under the current policy', () => {
    const { service } = setup()
    const input = {
      authorizationId: 'a',
      request: allowRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'k'
    }
    const first = service.authorize(input)
    const second = service.authorize(input)
    expect(second).toMatchObject({
      status: 'authorized',
      permit: first.status === 'authorized' ? first.permit : undefined
    })
  })
  it('conflicts when authorizationId is reused for another request', () => {
    const { service } = setup()
    service.authorize({
      authorizationId: 'a',
      request: baseRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'k'
    })
    expect(() =>
      service.authorize({
        authorizationId: 'a',
        request: baseRequest({ requestId: 'other' }),
        evaluatedAt: 1000,
        idempotencyKey: 'k2'
      })
    ).toThrow(AuthorizationConflictError)
  })
  it('resumeAuthorization replays awaiting state', () => {
    const { service } = setup(approvalRules)
    service.authorize({
      authorizationId: 'a',
      request: baseRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'k'
    })
    expect(service.resumeAuthorization('a', baseRequest(), 1100)).toMatchObject({
      status: 'awaiting-approval'
    })
  })
  it('resumeAuthorization rejects a changed current policy', () => {
    const { service } = setup()
    service.authorize({
      authorizationId: 'a',
      request: baseRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'k'
    })
    const changed = new MagicAgentPolicyAuthorizationService({
      store: stores[0],
      rules: [rule('deny')],
      policyVersion: 'policy-1',
      storeId: 'store-1',
      trustedApprovers: [approver]
    })
    expect(() => changed.resumeAuthorization('a', baseRequest(), 1100)).toThrow(PermitInvalidError)
  })
  it('rejects replaying an authorization after its execution permit is consumed', () => {
    const { service } = setup()
    const first = service.authorize({
      authorizationId: 'a',
      request: allowRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'k'
    })
    if (first.status !== 'authorized') throw new Error('expected permit')
    service.consumeExecutionPermit({
      permit: first.permit,
      request: allowRequest(),
      consumedAt: 1100,
      idempotencyKey: 'consume'
    })
    expect(() =>
      service.authorize({
        authorizationId: 'a',
        request: allowRequest(),
        evaluatedAt: 1100,
        idempotencyKey: 'replay'
      })
    ).toThrow(ApprovalRevisionConflictError)
  })
  it('rejects consuming the same permit twice with a different key', () => {
    const { service } = setup()
    const result = service.authorize({
      authorizationId: 'a',
      request: allowRequest(),
      evaluatedAt: 1000,
      idempotencyKey: 'k'
    })
    if (result.status !== 'authorized') throw new Error('expected permit')
    service.consumeExecutionPermit({
      permit: result.permit,
      request: allowRequest(),
      consumedAt: 1100,
      idempotencyKey: 'one'
    })
    expect(() =>
      service.consumeExecutionPermit({
        permit: result.permit,
        request: allowRequest(),
        consumedAt: 1100,
        idempotencyKey: 'two'
      })
    ).toThrow()
  })
  it('rejects an unbranded execution permit', () => {
    const { service } = setup()
    expect(() =>
      service.consumeExecutionPermit({
        permit: {} as never,
        request: baseRequest(),
        consumedAt: 1000,
        idempotencyKey: 'k'
      })
    ).toThrow(PermitInvalidError)
  })
  it('rejects authorization input with an invalid time', () => {
    const { service } = setup()
    expect(() =>
      service.authorize({
        authorizationId: 'a',
        request: baseRequest(),
        evaluatedAt: NaN,
        idempotencyKey: 'k'
      })
    ).toThrow(ApprovalValidationError)
  })
})
