import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
import type { PolicyRequest, PolicyRule } from '../../../shared/magicAgentPlatform2'
import { MagicAgentEventStore } from '../persistence/eventStore'
import {
  ApprovalRevisionConflictError,
  MagicAgentPolicyAuthorizationService,
  PermitConsumedError
} from './approvalStore'

const { mkdtempSync, rmSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
const { tmpdir } = await vi.importActual<typeof import('node:os')>('node:os')
const { join } = await vi.importActual<typeof import('node:path')>('node:path')

const approver = { kind: 'user', id: 'production-policy-approver' } as const
const request: PolicyRequest = {
  discriminator: 'magic-agent.policy-request.v1',
  version: 1,
  requestId: 'persistent-request',
  actor: { kind: 'agent', id: 'persistent-agent' },
  origin: 'assistant',
  action: 'terminal.execute',
  target: { kind: 'tool', id: 'terminal.run' },
  input: { command: 'node', args: ['--version'] },
  effects: [{ kind: 'process.execute', risk: 'high', target: 'node' }]
}
const rules: readonly PolicyRule[] = [
  {
    ruleId: 'terminal-requires-one-shot-approval',
    priority: 1000,
    effect: 'require-approval',
    match: { origins: ['assistant'], actions: ['terminal.execute'] },
    explanation: 'External execution requires approval.',
    approvalRequirement: {
      scopeKind: 'request',
      scopeValue: '*',
      maxUses: 1,
      expiresInMs: 300_000,
      reason: 'External execution requires approval.'
    }
  }
]

let directory: string | undefined
let stores: MagicAgentEventStore[] = []

const open = (databasePath: string) => {
  const store = new MagicAgentEventStore(databasePath)
  stores.push(store)
  return {
    store,
    service: new MagicAgentPolicyAuthorizationService({
      store,
      rules,
      policyVersion: 'persistent-policy-v1',
      storeId: databasePath,
      trustedApprovers: [approver]
    })
  }
}

const close = (store: MagicAgentEventStore) => {
  store.close()
  stores = stores.filter((candidate) => candidate !== store)
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

describe('persistent production policy authorization behavior', () => {
  it('restores a grant and authorization receipt after close and reopen', () => {
    directory = mkdtempSync(join(tmpdir(), 'magic-agent-policy-reopen-'))
    const databasePath = join(directory, 'policy.sqlite')
    const first = open(databasePath)
    const grantInput = {
      grantId: 'persistent-grant',
      request,
      approvedBy: approver,
      issuedAt: 1_000,
      expiresAt: 200_000,
      maxUses: 1,
      idempotencyKey: 'create-persistent-grant'
    } as const
    const grant = first.service.createApprovalGrant(grantInput)
    const authorizationInput = {
      authorizationId: 'persistent-authorization',
      request,
      evaluatedAt: 2_000,
      grantId: grant.grant.grantId,
      expectedGrantUseCount: 0,
      idempotencyKey: 'consume-persistent-grant'
    } as const
    const authorized = first.service.authorize(authorizationInput)
    expect(authorized.status).toBe('authorized')
    close(first.store)

    const reopened = open(databasePath)
    expect(reopened.service.createApprovalGrant(grantInput)).toEqual({
      grant: grant.grant,
      inserted: false
    })
    const replayed = reopened.service.authorize(authorizationInput)
    expect(replayed).toEqual(authorized)
    expect(replayed.status).toBe('authorized')
    if (replayed.status !== 'authorized') throw new Error('Expected restored authorization.')

    const consumptionInput = {
      permit: replayed.permit,
      request,
      consumedAt: 3_000,
      idempotencyKey: 'external-execution-once'
    } as const
    const consumed = reopened.service.consumeExecutionPermit(consumptionInput)
    expect(reopened.service.consumeExecutionPermit(consumptionInput)).toEqual(consumed)
    close(reopened.store)

    const final = open(databasePath)
    expect(
      final.service.authorize({
        ...authorizationInput,
        evaluatedAt: 4_000
      })
    ).toMatchObject({ status: 'already-consumed' })
  })

  it('permits at most one competing external execution consumption', async () => {
    directory = mkdtempSync(join(tmpdir(), 'magic-agent-policy-concurrent-'))
    const { service } = open(join(directory, 'policy.sqlite'))
    const grant = service.createApprovalGrant({
      grantId: 'one-shot-grant',
      request,
      approvedBy: approver,
      issuedAt: 1_000,
      expiresAt: 200_000,
      maxUses: 1,
      idempotencyKey: 'create-one-shot-grant'
    })
    const authorization = service.authorize({
      authorizationId: 'one-shot-authorization',
      request,
      evaluatedAt: 2_000,
      grantId: grant.grant.grantId,
      expectedGrantUseCount: 0,
      idempotencyKey: 'authorize-one-shot'
    })
    expect(authorization.status).toBe('authorized')
    if (authorization.status !== 'authorized') throw new Error('Expected one-shot authorization.')

    const attempts = await Promise.allSettled(
      ['external-execution-a', 'external-execution-b'].map((idempotencyKey) =>
        Promise.resolve().then(() =>
          service.consumeExecutionPermit({
            permit: authorization.permit,
            request,
            consumedAt: 3_000,
            idempotencyKey
          })
        )
      )
    )
    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled')
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(
      rejected[0].reason instanceof PermitConsumedError ||
        rejected[0].reason instanceof ApprovalRevisionConflictError
    ).toBe(true)
  })
})
