import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PolicyRule,
  TriggerPolicyRequestFactoryInput,
  PolicyEffect
} from '../../../shared/magicAgentPlatform2/policy'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService, PermitConsumedError } from '../policy'
import {
  TriggerPolicyExecutionBoundary,
  TriggerPolicyPostConsumptionError
} from './policyExecution'
import { TriggerExecutionOutcomeStore } from './executionOutcomeStore'

const approver = { kind: 'user', id: 'approver-1' } as const
const input = (): TriggerPolicyRequestFactoryInput => ({
  requestId: 'request-1',
  actor: { kind: 'scheduler', id: 'scheduler-1' },
  triggerId: 'trigger-1',
  occurrence: {
    occurrenceAt: 100,
    windowStart: 100,
    windowEnd: 100,
    missedCount: 0,
    nextFireAtAfter: 200
  },
  trigger: { type: 'schedule', title: 'Nightly', config: { intervalMs: 100 } },
  effects: [{ kind: 'filesystem.read', risk: 'read', target: '/workspace' }]
})
const rule = (effect: PolicyRule['effect']): PolicyRule => ({
  ruleId: effect,
  priority: 1,
  effect,
  match: {
    origins: ['trigger'],
    actions: ['trigger.execute'],
    targetKinds: ['trigger'],
    actorKinds: ['scheduler'],
    effectKinds: ['filesystem.read']
  },
  explanation: effect
})

let stores: MagicAgentEventStore[] = []
afterEach(() => {
  for (const store of stores) store.close()
  stores = []
})
const setup = (effect: PolicyRule['effect']) => {
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  const service = new MagicAgentPolicyAuthorizationService({
    store,
    rules: [rule(effect)],
    policyVersion: 'policy-1',
    storeId: 'store-1',
    trustedApprovers: [approver]
  })
  return { store, service }
}

describe('TriggerPolicyExecutionBoundary', () => {
  it('consumes immediately before one-shot execution and records audit', async () => {
    const { service } = setup('allow')
    const order: string[] = []
    const consume = vi.spyOn(service, 'consumeExecutionPermit').mockImplementation((value) => {
      order.push('consume')
      return MagicAgentPolicyAuthorizationService.prototype.consumeExecutionPermit.call(
        service,
        value
      )
    })
    const execute = vi.fn(async () => {
      order.push('execute')
      return 'ok'
    })
    const boundary = new TriggerPolicyExecutionBoundary(
      service,
      () => undefined,
      execute,
      () => 1000
    )

    await expect(boundary.execute(input())).resolves.toMatchObject({
      status: 'executed',
      result: 'ok'
    })
    expect(order).toEqual(['consume', 'execute'])
    expect(consume).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
    expect(service.listAuditResources()).toHaveLength(1)
  })

  it('defers grant lookup until the first awaiting-approval authorization', async () => {
    const { service } = setup('deny')
    const grantProvider = vi.fn()
    const execute = vi.fn()
    const boundary = new TriggerPolicyExecutionBoundary(service, grantProvider, execute, () => 1000)

    await boundary.execute(input())

    expect(grantProvider).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('uses a stable request identity when the caller request id changes', async () => {
    const { service } = setup('allow')
    const execute = vi.fn(async () => 'ok')
    const boundary = new TriggerPolicyExecutionBoundary(service, vi.fn(), execute, () => 1000)

    const first = await boundary.execute(input())
    const replay = await boundary.execute({ ...input(), requestId: 'new-after-restart' })

    expect(first.status).toBe('executed')
    expect(replay.status).toBe('already-consumed')
    expect(first.request.requestId).toBe(replay.request.requestId)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('wraps post-consumption execution failures and does not retry the side effect', async () => {
    const { service } = setup('allow')
    const execute = vi.fn(async () => {
      throw new Error('delivery failed')
    })
    const boundary = new TriggerPolicyExecutionBoundary(service, vi.fn(), execute, () => 1000)

    await expect(boundary.execute(input())).rejects.toMatchObject({
      name: 'TriggerPolicyExecutionError',
      code: 'MAGIC_AGENT_TRIGGER_POLICY_EXECUTION',
      authorizationId: expect.stringContaining('trigger-authorization:'),
      requestDigest: expect.stringMatching(/^sha256:/)
    })
    await expect(boundary.execute(input())).resolves.toMatchObject({ status: 'already-consumed' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('calls grantProvider only for awaiting approval and executes after grant authorization', async () => {
    const { service } = setup('require-approval')
    const execute = vi.fn(async () => 'approved')
    const grantProvider = vi.fn(async (request) => {
      const created = service.createApprovalGrant({
        grantId: 'grant-1',
        request,
        approvedBy: approver,
        issuedAt: 1000,
        expiresAt: 2000,
        maxUses: 1,
        idempotencyKey: 'grant-1'
      })
      return {
        grantId: created.grant.grantId,
        expectedGrantUseCount: created.grant.useCount
      }
    })
    const boundary = new TriggerPolicyExecutionBoundary(service, grantProvider, execute, () => 1000)

    await expect(boundary.execute(input())).resolves.toMatchObject({
      status: 'executed',
      result: 'approved'
    })
    expect(grantProvider).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'effects',
      {
        effects: [{ kind: 'filesystem.read', risk: 'read', target: '/other' }] as PolicyEffect[]
      }
    ],
    ['config', { trigger: { ...input().trigger, config: { intervalMs: 200 } } }],
    ['actor', { actor: { kind: 'scheduler', id: 'scheduler-2' } }],
    ['route', { route: { kind: 'retry' } }]
  ] as const)('does not reuse authorization identity when %s changes', async (_name, patch) => {
    const { service } = setup('allow')
    const execute = vi.fn(async () => 'ok')
    const boundary = new TriggerPolicyExecutionBoundary(service, vi.fn(), execute, () => 1000)

    const first = await boundary.execute(input())
    const changed = await boundary.execute({ ...input(), requestId: 'restart-id', ...patch })

    expect(first.status).toBe('executed')
    expect(changed.request.requestId).not.toBe(first.request.requestId)
    expect(changed.status).toBe('executed')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it.each(['deny', 'require-approval'] as const)('does not execute for %s', async (effect) => {
    const { service } = setup(effect)
    const execute = vi.fn()
    const grantProvider = vi.fn()
    const boundary = new TriggerPolicyExecutionBoundary(service, grantProvider, execute, () => 1000)
    const result = await boundary.execute(input())
    expect(result.status).toBe(effect === 'deny' ? 'denied' : 'awaiting-approval')
    expect(execute).not.toHaveBeenCalled()
    expect(grantProvider).toHaveBeenCalledTimes(effect === 'deny' ? 0 : 1)
    expect(service.listAuditResources()).toHaveLength(1)
  })

  it('does not execute when permit consumption fails', async () => {
    const { service } = setup('allow')
    const execute = vi.fn()
    vi.spyOn(service, 'consumeExecutionPermit').mockImplementation(() => {
      throw new Error('consume failed')
    })
    const boundary = new TriggerPolicyExecutionBoundary(
      service,
      () => undefined,
      execute,
      () => 1000
    )
    await expect(boundary.execute(input())).rejects.toThrow('consume failed')
    expect(execute).not.toHaveBeenCalled()
  })

  it('binds idempotency to trigger and occurrence while allowing a new occurrence', async () => {
    const { service } = setup('allow')
    const execute = vi.fn()
    const boundary = new TriggerPolicyExecutionBoundary(
      service,
      () => undefined,
      execute,
      () => 1000
    )
    await boundary.execute(input())
    await boundary.execute({
      ...input(),
      requestId: 'request-2',
      occurrence: { ...input().occurrence, occurrenceAt: 200, nextFireAtAfter: 300 }
    })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(service.listAuditResources()).toHaveLength(2)
  })
})

describe('TriggerPolicyExecutionBoundary outcome hook', () => {
  it('awaits permit-consumed hook before execution', async () => {
    const { service } = setup('allow')
    const order: string[] = []
    const boundary = new TriggerPolicyExecutionBoundary(
      service,
      () => undefined,
      async () => {
        order.push('execute')
      },
      () => 1000,
      async () => {
        order.push('outcome')
      }
    )
    await boundary.execute(input())
    expect(order).toEqual(['outcome', 'execute'])
  })

  it('does not execute when permit-consumed hook fails', async () => {
    const { service } = setup('allow')
    const execute = vi.fn()
    const boundary = new TriggerPolicyExecutionBoundary(
      service,
      () => undefined,
      execute,
      () => 1000,
      async () => {
        throw new Error('outcome store unavailable')
      }
    )
    await expect(boundary.execute(input())).rejects.toMatchObject({
      name: 'TriggerPolicyPostConsumptionError',
      authorizationId: expect.stringContaining('trigger-authorization:'),
      requestDigest: expect.stringMatching(/^sha256:/)
    })
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('TriggerPolicyExecutionBoundary outcome recovery', () => {
  it('recovers a missing permit-consumed record on already-consumed replay without executing', async () => {
    const { service, store } = setup('allow')
    const outcomes = new TriggerExecutionOutcomeStore(store)
    const execute = vi.fn()
    let captured: { authorizationId: string; auditRevision: number } | undefined
    const authorizeSpy = vi.spyOn(service, 'authorize')
    const first = new TriggerPolicyExecutionBoundary(
      service,
      () => undefined,
      execute,
      () => 1000,
      async ({ request, authorizationId, requestDigest, consumption }) => {
        captured = consumption
        throw new Error('response lost after permit consumption')
      }
    )
    await expect(first.execute(input())).rejects.toMatchObject({
      name: 'TriggerPolicyPostConsumptionError',
      consumption: {
        authorizationId: expect.stringContaining('trigger-authorization:'),
        auditRevision: expect.any(Number)
      }
    })
    expect(captured).toBeDefined()
    const authorized = authorizeSpy.mock.results[0]?.value
    if (!authorized || authorized.status !== 'authorized')
      throw new Error('expected authorized replay fixture')
    authorizeSpy.mockReturnValue(authorized)
    vi.spyOn(service, 'consumeExecutionPermit').mockImplementation(() => {
      throw new PermitConsumedError()
    })

    const second = new TriggerPolicyExecutionBoundary(
      service,
      () => undefined,
      execute,
      () => 1000,
      async ({ request, authorizationId, requestDigest, consumption }) => {
        outcomes.recoverFromConsumption({
          triggerId: request.target.id,
          occurrenceAt: 100,
          authorizationId,
          requestDigest,
          consumedAt: 1000
        })
        expect(consumption.authorizationId).toBe(captured?.authorizationId)
        expect(consumption.auditRevision).toBeTypeOf('number')
      }
    )
    await expect(second.execute(input())).resolves.toMatchObject({ status: 'already-consumed' })
    expect(outcomes.list()).toHaveLength(1)
    expect(outcomes.list()[0].state.status).toBe('permit-consumed')
    expect(execute).not.toHaveBeenCalled()
  })
})
