import { afterEach, describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import type { PersistentTriggerState } from './persistentTriggerStore'
import {
  ProductionTriggerExecutor,
  TriggerOutcomePersistenceError
} from './productionTriggerExecutor'
import { TriggerExecutionOutcomeStore } from './executionOutcomeStore'

const stores: MagicAgentEventStore[] = []
afterEach(() => {
  for (const store of stores) store.close()
  stores.length = 0
})

const trigger = (target: unknown): PersistentTriggerState => ({
  id: 'trigger-1',
  type: 'schedule',
  title: 'Nightly',
  enabled: true,
  config: { target, route: { injected: true } },
  schedule: { type: 'interval', intervalMs: 1000 },
  nextFireAt: 200,
  claim: {
    claimId: 'claim-1',
    claimedAt: 100,
    expiresAt: 1000,
    occurrenceAt: 100,
    windowStart: 100,
    windowEnd: 100,
    missedCount: 0,
    nextFireAtAfter: 1100
  }
})

const setup = (effect: 'allow' | 'deny') => {
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  const service = new MagicAgentPolicyAuthorizationService({
    store,
    rules: [
      {
        ruleId: effect,
        priority: 1,
        effect: effect === 'allow' ? 'allow-with-constraints' : 'deny',
        ...(effect === 'allow'
          ? { constraints: { allowedToolNames: ['agent.run', 'graph.run'] } }
          : {}),
        match: {
          origins: ['trigger'],
          actions: ['trigger.execute'],
          targetKinds: ['trigger'],
          actorKinds: ['system'],
          effectKinds: ['tool.invoke'],
          risks: ['high']
        },
        explanation: effect
      }
    ],
    policyVersion: 'policy-1',
    storeId: 'store-1',
    trustedApprovers: [{ kind: 'user', id: 'approver-1' }]
  })
  return service
}

describe('production trigger executor', () => {
  it('maps agent target and uses only the trusted route resolver', async () => {
    const service = setup('allow')
    const runAgent = vi.fn(async (input) => input)
    const resolveTrustedRoute = vi.fn(() => ({ trusted: true }))
    const executor = new ProductionTriggerExecutor({
      authorizationService: service,
      grantProvider: vi.fn(async (request) => {
        const grant = service.createApprovalGrant({
          grantId: 'grant-1',
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses: 1,
          idempotencyKey: 'grant-1'
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      }),
      resolveTrustedRoute,
      dispatch: { runAgent, runGraph: vi.fn() },
      now: () => 1000
    })
    const result = await executor.execute(
      trigger({
        kind: 'agent-run',
        agentId: 'agent-1',
        prompt: 'secret prompt',
        sessionId: 'session-1'
      })
    )
    expect(result).toMatchObject({
      agentId: 'agent-1',
      prompt: 'secret prompt',
      route: { trusted: true }
    })
    expect(runAgent).toHaveBeenCalledOnce()
    expect(runAgent.mock.calls[0][0].route).toEqual({ trusted: true })
    expect(resolveTrustedRoute).toHaveBeenCalledOnce()
  })

  it('maps graph target and preserves input only for dispatch', async () => {
    const service = setup('allow')
    const runGraph = vi.fn(async (input) => input)
    const executor = new ProductionTriggerExecutor({
      authorizationService: service,
      grantProvider: vi.fn(async (request) => {
        const grant = service.createApprovalGrant({
          grantId: 'grant-1',
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses: 1,
          idempotencyKey: 'grant-1'
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      }),
      resolveTrustedRoute: () => ({ route: 'trusted' }),
      dispatch: { runAgent: vi.fn(), runGraph },
      now: () => 1000
    })
    const result = await executor.execute(
      trigger({ kind: 'graph-run', graphId: 'graph-1', input: { secret: 'payload' } })
    )
    expect(result).toMatchObject({ graphId: 'graph-1', input: { secret: 'payload' } })
    expect(runGraph).toHaveBeenCalledOnce()
    const audit = service.listAuditResources().map((resource) => JSON.stringify(resource.state))
    expect(audit.join(String.fromCharCode(10))).not.toContain('"secret":"payload"')
  })

  it('does not dispatch when policy denies', async () => {
    const service = setup('deny')
    const runAgent = vi.fn()
    const executor = new ProductionTriggerExecutor({
      authorizationService: service,
      grantProvider: vi.fn(),
      resolveTrustedRoute: () => ({ trusted: true }),
      dispatch: { runAgent, runGraph: vi.fn() },
      now: () => 1000
    })
    const result = await executor.execute(
      trigger({ kind: 'agent-run', agentId: 'agent-1', prompt: 'blocked' })
    )
    expect(result).toMatchObject({ status: 'denied' })
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('records failed outcome and rethrows the original dispatch error without raw evidence', async () => {
    const service = setup('allow')
    const eventStore = (service as unknown as { store: MagicAgentEventStore }).store
    const outcomes = new TriggerExecutionOutcomeStore(eventStore)
    const dispatchError = new Error('dispatch secret output')
    const executor = new ProductionTriggerExecutor({
      authorizationService: service,
      grantProvider: async (request) => {
        const grant = service.createApprovalGrant({
          grantId: 'fail-grant',
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses: 1,
          idempotencyKey: 'fail-grant'
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      },
      resolveTrustedRoute: () => ({}),
      dispatch: {
        runAgent: vi.fn(async () => {
          throw dispatchError
        }),
        runGraph: vi.fn()
      },
      outcomes,
      now: () => 1000
    })
    await expect(
      executor.execute(trigger({ kind: 'agent-run', agentId: 'a', prompt: 'raw prompt' }))
    ).rejects.toBe(dispatchError)
    expect(outcomes.list()[0].state.status).toBe('failed')
    expect(JSON.stringify(outcomes.list()[0].state)).not.toContain('raw prompt')
    expect(JSON.stringify(outcomes.list()[0].state)).not.toContain('dispatch secret output')
  })

  it('raises persistence error when succeeded terminal write fails', async () => {
    const service = setup('allow')
    const eventStore = (service as unknown as { store: MagicAgentEventStore }).store
    const outcomes = new TriggerExecutionOutcomeStore(eventStore)
    vi.spyOn(outcomes, 'complete').mockImplementation(() => {
      throw new Error('success store failed')
    })
    const executor = new ProductionTriggerExecutor({
      authorizationService: service,
      grantProvider: vi.fn(async (request) => {
        const grant = service.createApprovalGrant({
          grantId: 'success-grant',
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses: 1,
          idempotencyKey: 'success-grant'
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      }),
      resolveTrustedRoute: () => ({}),
      dispatch: { runAgent: vi.fn(async () => 'raw result'), runGraph: vi.fn() },
      outcomes,
      now: () => 1000
    })
    await expect(
      executor.execute(trigger({ kind: 'agent-run', agentId: 'a', prompt: 'p' }))
    ).rejects.toBeInstanceOf(TriggerOutcomePersistenceError)
  })

  it('raises persistence error when failed terminal write fails', async () => {
    const service = setup('allow')
    const eventStore = (service as unknown as { store: MagicAgentEventStore }).store
    const outcomes = new TriggerExecutionOutcomeStore(eventStore)
    vi.spyOn(outcomes, 'complete').mockImplementation(() => {
      throw new Error('failed store secret')
    })
    const executor = new ProductionTriggerExecutor({
      authorizationService: service,
      grantProvider: vi.fn(async (request) => {
        const grant = service.createApprovalGrant({
          grantId: 'terminal-fail-grant',
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses: 1,
          idempotencyKey: 'terminal-fail-grant'
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      }),
      resolveTrustedRoute: () => ({}),
      dispatch: {
        runAgent: vi.fn(async () => {
          throw new Error('raw dispatch secret')
        }),
        runGraph: vi.fn()
      },
      outcomes,
      now: () => 1000
    })
    const error = await executor
      .execute(trigger({ kind: 'agent-run', agentId: 'a', prompt: 'p' }))
      .catch((value) => value)
    expect(error).toBeInstanceOf(TriggerOutcomePersistenceError)
    expect(error.message).not.toContain('raw dispatch secret')
  })

  it('keeps concurrent outcome records separate', async () => {
    const service = setup('allow')
    const eventStore = (service as unknown as { store: MagicAgentEventStore }).store
    const outcomes = new TriggerExecutionOutcomeStore(eventStore)
    const executor = new ProductionTriggerExecutor({
      authorizationService: service,
      grantProvider: vi.fn(async (request) => {
        const grant = service.createApprovalGrant({
          grantId: `grant-${Math.random()}`,
          request,
          approvedBy: { kind: 'user', id: 'approver-1' },
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses: 1,
          idempotencyKey: `grant-${Math.random()}`
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      }),
      resolveTrustedRoute: () => ({}),
      dispatch: { runAgent: vi.fn(async () => 'ok'), runGraph: vi.fn() },
      outcomes,
      now: () => 1000
    })
    await Promise.all([
      executor.execute({
        ...trigger({ kind: 'agent-run', agentId: 'a', prompt: 'a' }),
        id: 'trigger-a'
      }),
      executor.execute({
        ...trigger({ kind: 'agent-run', agentId: 'b', prompt: 'b' }),
        id: 'trigger-b'
      })
    ])
    expect(outcomes.list()).toHaveLength(2)
    expect(new Set(outcomes.list().map((item) => item.state.triggerId)).size).toBe(2)
  })

  it('fails closed for missing or malformed targets', async () => {
    const service = setup('allow')
    const executor = new ProductionTriggerExecutor({
      authorizationService: service,
      grantProvider: vi.fn(),
      resolveTrustedRoute: () => ({ trusted: true }),
      dispatch: { runAgent: vi.fn(), runGraph: vi.fn() },
      now: () => 1000
    })
    await expect(executor.execute(trigger(undefined))).rejects.toThrow()
    await expect(
      executor.execute(
        trigger({ kind: 'agent-run', agentId: 'agent-1', prompt: 'p', route: { injected: true } })
      )
    ).rejects.toThrow()
  })
})
