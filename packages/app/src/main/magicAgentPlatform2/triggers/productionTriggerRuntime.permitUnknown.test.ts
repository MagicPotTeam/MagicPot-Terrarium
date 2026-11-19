import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PolicyRequest } from '../../../shared/magicAgentPlatform2/policy'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService, PermitConsumedError } from '../policy'
import type { PersistentTriggerState } from './persistentTriggerStore'
import type {
  TriggerAgentDispatchInput,
  TriggerGraphDispatchInput
} from './productionTriggerExecutor'
import { ProductionTriggerRuntime } from './productionTriggerRuntime'
import {
  TriggerOccurrenceFencingError,
  type TriggerOccurrenceState
} from './triggerOccurrenceStore'

// Scheduler defaults that ProductionTriggerRuntime does not override.
const LEASE_MS = 30_000
const RETRY_DELAY_MS = 5_000
const START = 1_000
const approver = { kind: 'user', id: 'approver-1' } as const
const unknownError = {
  name: 'TriggerOccurrenceOutcomeUnknown',
  message: 'Trigger occurrence outcome is unknown.'
}

const stores: MagicAgentEventStore[] = []
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const openStore = (path = ':memory:') => {
  const store = new MagicAgentEventStore(path)
  stores.push(store)
  return store
}

const tempDatabase = () => {
  const root = mkdtempSync(join(tmpdir(), 'trigger-permit-unknown-'))
  roots.push(root)
  return join(root, 'events.db')
}

// The allow rule of productionTriggerRuntime.test.ts: high risk still needs an explicit grant.
const authorizationFor = (
  store: MagicAgentEventStore,
  effect: 'allow' | 'deny' = 'allow',
  storeId = 'store-1'
) =>
  new MagicAgentPolicyAuthorizationService({
    store,
    rules: [
      {
        ruleId: effect,
        priority: 1,
        effect,
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
    storeId,
    trustedApprovers: [approver]
  })

// Modelled on createGrantProvider, but each grant is issued at the current clock value so a
// retry after the clock moved can be granted again.
const grantAtClock =
  (authorization: MagicAgentPolicyAuthorizationService, now: () => number) =>
  async (request: PolicyRequest) => {
    const grantId = `grant-${request.requestId}`
    const issuedAt = now()
    const grant = authorization.createApprovalGrant({
      grantId,
      request,
      approvedBy: approver,
      issuedAt,
      expiresAt: issuedAt + 1_000,
      maxUses: 1,
      idempotencyKey: grantId
    })
    return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
  }

type Clock = { now: number }
const harness = (
  options: {
    eventStore?: MagicAgentEventStore
    effect?: 'allow' | 'deny'
    grant?: boolean
    storeId?: string
    clock?: Clock
  } = {}
) => {
  const eventStore = options.eventStore ?? openStore()
  const clock = options.clock ?? { now: START }
  const authorization = authorizationFor(eventStore, options.effect, options.storeId)
  const runAgent = vi.fn(async (input: TriggerAgentDispatchInput): Promise<unknown> => input)
  const runGraph = vi.fn(async (input: TriggerGraphDispatchInput): Promise<unknown> => input)
  const runtime = new ProductionTriggerRuntime({
    eventStore,
    authorization,
    service: { runAgent, runGraph },
    grantProvider:
      options.grant === false ? () => undefined : grantAtClock(authorization, () => clock.now),
    routeResolver: () => ({ trusted: true }),
    now: () => clock.now,
    pollInterval: 60_000
  })
  return { eventStore, authorization, runtime, runAgent, runGraph, clock }
}
type Harness = ReturnType<typeof harness>

const agentTarget = { kind: 'agent-run', agentId: 'agent-1', prompt: 'synthetic prompt' }
const enqueue = (h: Harness, target: unknown = agentTarget, id = 'occ-1') => {
  const trigger: PersistentTriggerState = {
    id: `trigger-${id}`,
    type: 'schedule',
    title: 'Synthetic',
    enabled: true,
    config: { target },
    schedule: { type: 'interval', intervalMs: 1_000 },
    nextFireAt: 9_999
  }
  h.runtime.store.create(trigger, 0)
  h.runtime.occurrences.enqueueManual({
    occurrenceId: id,
    triggerId: trigger.id,
    scheduledAt: START,
    requestedAt: START,
    idempotencyKey: id
  })
}
const occurrence = (h: Harness, id = 'occ-1') => h.runtime.occurrences.get(id)?.state
// Moves the clock past both the retry delay and the lease before each poll.
const pollLater = async (h: Harness, polls = 3) => {
  const claimed: boolean[] = []
  for (let poll = 0; poll < polls; poll += 1) {
    h.clock.now += LEASE_MS + RETRY_DELAY_MS
    claimed.push(await h.runtime.occurrenceScheduler.runOnce())
  }
  return claimed
}
const passThroughConsume = (authorization: MagicAgentPolicyAuthorizationService) =>
  vi
    .spyOn(authorization, 'consumeExecutionPermit')
    .mockImplementation((value) =>
      MagicAgentPolicyAuthorizationService.prototype.consumeExecutionPermit.call(
        authorization,
        value
      )
    )

describe('trigger occurrence after its permit step', () => {
  it('ends unknown and is never dispatched again when the dispatch throws', async () => {
    const h = harness()
    enqueue(h)
    h.runAgent.mockRejectedValue(new Error('synthetic dispatch failure'))
    await expect(h.runtime.occurrenceScheduler.runOnce()).resolves.toBe(true)
    const later = await pollLater(h)
    expect(h.runAgent).toHaveBeenCalledTimes(1)
    expect(later).toEqual([false, false, false])
    const state = occurrence(h)
    expect(state).toMatchObject({
      status: 'unknown',
      attempt: 1,
      lastError: unknownError,
      permit: { attempt: 1 }
    })
    expect(state?.nextRetryAt).toBeUndefined()
    expect(h.runtime.outcomes.list().map((item) => item.state.status)).toEqual(['failed'])
  })

  it('ends unknown and is never dispatched again when the success outcome cannot be written', async () => {
    const h = harness()
    enqueue(h)
    vi.spyOn(h.runtime.outcomes, 'complete').mockImplementation(() => {
      throw new Error('synthetic outcome write failure')
    })
    await h.runtime.occurrenceScheduler.runOnce()
    await pollLater(h)
    expect(h.runAgent).toHaveBeenCalledTimes(1)
    expect(occurrence(h)?.status).toBe('unknown')
    expect(h.runtime.outcomes.listUncertain()).toHaveLength(1)
  })

  it('ends unknown without dispatching when the consumed permit cannot be recorded', async () => {
    const h = harness()
    enqueue(h)
    const consume = passThroughConsume(h.authorization)
    vi.spyOn(h.runtime.outcomes, 'recordPermitConsumed').mockImplementation(() => {
      throw new Error('synthetic outcome write failure')
    })
    await h.runtime.occurrenceScheduler.runOnce()
    expect(await pollLater(h)).toEqual([false, false, false])
    expect(consume).toHaveBeenCalledTimes(1)
    expect(h.runAgent).not.toHaveBeenCalled()
    expect(occurrence(h)).toMatchObject({ status: 'unknown', attempt: 1 })
  })

  it('retries without consuming anything when the marker cannot be written', async () => {
    const h = harness()
    enqueue(h)
    const consume = passThroughConsume(h.authorization)
    const mark = vi.spyOn(h.runtime.occurrences, 'markPermit').mockImplementationOnce(() => {
      throw new Error('synthetic marker write failure')
    })
    await h.runtime.occurrenceScheduler.runOnce()
    expect(consume).not.toHaveBeenCalled()
    expect(h.runAgent).not.toHaveBeenCalled()
    expect(h.runtime.outcomes.list()).toHaveLength(0)
    expect(occurrence(h)).toMatchObject({
      status: 'failed',
      attempt: 1,
      nextRetryAt: START + RETRY_DELAY_MS
    })
    expect(occurrence(h)?.permit).toBeUndefined()
    h.clock.now = START + RETRY_DELAY_MS
    await expect(h.runtime.occurrenceScheduler.runOnce()).resolves.toBe(true)
    expect(await pollLater(h)).toEqual([false, false, false])
    expect(mark).toHaveBeenCalledTimes(2)
    expect(consume).toHaveBeenCalledTimes(1)
    expect(h.runAgent).toHaveBeenCalledTimes(1)
    expect(occurrence(h)).toMatchObject({
      status: 'completed',
      attempt: 2,
      permit: { attempt: 2 }
    })
    expect(h.runtime.outcomes.list().map((item) => item.state.status)).toEqual(['succeeded'])
  })

  it.each([
    ['without a grant', { grant: false }],
    ['when denied', { effect: 'deny' as const }]
  ])(
    'keeps an unpermitted occurrence retryable %s and dead-letters it at the third attempt',
    async (_name, options) => {
      const h = harness(options)
      enqueue(h)
      const mark = vi.spyOn(h.runtime.occurrences, 'markPermit')
      await h.runtime.occurrenceScheduler.runOnce()
      expect(occurrence(h)).toMatchObject({
        status: 'failed',
        attempt: 1,
        nextRetryAt: START + RETRY_DELAY_MS
      })
      for (const attempt of [2, 3]) {
        h.clock.now += RETRY_DELAY_MS
        await expect(h.runtime.occurrenceScheduler.runOnce()).resolves.toBe(true)
        expect(occurrence(h)?.attempt).toBe(attempt)
      }
      expect(occurrence(h)?.status).toBe('dead-letter')
      expect(occurrence(h)?.permit).toBeUndefined()
      expect(mark).not.toHaveBeenCalled()
      expect(h.runAgent).not.toHaveBeenCalled()
      expect(h.runtime.outcomes.list()).toHaveLength(0)
    }
  )

  it('ends unknown without dispatching when the permit turns out to be consumed already', async () => {
    const h = harness()
    enqueue(h)
    vi.spyOn(h.authorization, 'consumeExecutionPermit').mockImplementationOnce(() => {
      throw new PermitConsumedError()
    })
    await h.runtime.occurrenceScheduler.runOnce()
    expect(await pollLater(h)).toEqual([false, false, false])
    expect(h.runAgent).not.toHaveBeenCalled()
    expect(occurrence(h)).toMatchObject({ status: 'unknown', permit: { attempt: 1 } })
  })

  it('marks and ends unknown when the policy reports this attempt as consumed', async () => {
    const h = harness()
    enqueue(h)
    const consume = passThroughConsume(h.authorization)
    vi.spyOn(h.authorization, 'authorize').mockImplementationOnce(
      () => ({ status: 'already-consumed', reason: 'already-consumed' }) as never
    )
    await h.runtime.occurrenceScheduler.runOnce()
    expect(await pollLater(h)).toEqual([false, false, false])
    expect(consume).not.toHaveBeenCalled()
    expect(h.runAgent).not.toHaveBeenCalled()
    expect(occurrence(h)).toMatchObject({ status: 'unknown', permit: { attempt: 1 } })
  })

  it('ends unknown and is never dispatched again when a graph dispatch throws', async () => {
    const h = harness()
    enqueue(h, { kind: 'graph-run', graphId: 'graph-1', input: { synthetic: true } })
    h.runGraph.mockRejectedValue(new Error('synthetic graph failure'))
    await h.runtime.occurrenceScheduler.runOnce()
    await pollLater(h)
    expect(h.runGraph).toHaveBeenCalledTimes(1)
    expect(h.runAgent).not.toHaveBeenCalled()
    expect(occurrence(h)?.status).toBe('unknown')
    expect(h.runtime.outcomes.list().map((item) => item.state.status)).toEqual(['failed'])
  })

  it('completes a successful dispatch once and keeps the marker', async () => {
    const h = harness()
    enqueue(h)
    await h.runtime.occurrenceScheduler.runOnce()
    expect(await pollLater(h)).toEqual([false, false, false])
    expect(h.runAgent).toHaveBeenCalledTimes(1)
    const state = occurrence(h)
    expect(state).toMatchObject({ status: 'completed', attempt: 1 })
    expect(state?.permit).toMatchObject({
      attempt: 1,
      authorizationId: expect.stringMatching(/^trigger-authorization:sha256:/),
      requestDigest: expect.stringMatching(/^sha256:/)
    })
    const claimed = h.eventStore.listResourceMutations('trigger-occurrence', 'occ-1', 10)[1]
    expect(state?.permit?.owner).toBe(
      (claimed?.resource.state as TriggerOccurrenceState).claim?.owner
    )
    expect(h.runtime.outcomes.list().map((item) => item.state.status)).toEqual(['succeeded'])
  })
})

describe('trigger occurrence settlement of long runs and restarts', () => {
  it('completes a dispatch that outlasts its lease exactly once', async () => {
    const h = harness()
    enqueue(h)
    h.runAgent.mockImplementation(async (input) => {
      h.clock.now += LEASE_MS + 1
      return input
    })
    await expect(h.runtime.occurrenceScheduler.runOnce()).resolves.toBe(true)
    expect(await h.runtime.occurrenceScheduler.runOnce()).toBe(false)
    expect(await pollLater(h)).toEqual([false, false, false])
    expect(h.runAgent).toHaveBeenCalledTimes(1)
    expect(occurrence(h)).toMatchObject({ status: 'completed', attempt: 1, permit: { attempt: 1 } })
    expect(h.runtime.outcomes.list().map((item) => item.state.status)).toEqual(['succeeded'])
  })

  it('ends unknown when a dispatch that outlasts its lease throws', async () => {
    const h = harness()
    enqueue(h)
    h.runAgent.mockImplementation(async () => {
      h.clock.now += LEASE_MS + 1
      throw new Error('synthetic late dispatch failure')
    })
    await expect(h.runtime.occurrenceScheduler.runOnce()).resolves.toBe(true)
    expect(await pollLater(h)).toEqual([false, false, false])
    expect(h.runAgent).toHaveBeenCalledTimes(1)
    expect(occurrence(h)).toMatchObject({ status: 'unknown', lastError: unknownError })
  })

  it('never dispatches again after a restart during the dispatch', async () => {
    const path = tempDatabase()
    const clock = { now: START }
    const first = harness({ eventStore: openStore(path), clock })
    enqueue(first)
    const dispatched = Promise.withResolvers<void>()
    first.runAgent.mockImplementation(() => {
      dispatched.resolve()
      return new Promise<never>(() => undefined)
    })
    void first.runtime.occurrenceScheduler.runOnce()
    await dispatched.promise
    // The process ends here: the store closes while the dispatch is still running.
    first.eventStore.close()

    clock.now = START + LEASE_MS + 1
    const second = harness({ eventStore: openStore(path), clock })
    const polls: boolean[] = []
    for (let poll = 0; poll < 3; poll += 1)
      polls.push(await second.runtime.occurrenceScheduler.runOnce())
    expect(second.runAgent).not.toHaveBeenCalled()
    expect(polls).toEqual([false, false, false])
    expect(occurrence(second)).toMatchObject({
      status: 'unknown',
      attempt: 1,
      permit: { attempt: 1 }
    })
    expect(second.runtime.outcomes.list().map((item) => item.state.status)).toEqual([
      'permit-consumed'
    ])
    expect(second.runtime.outcomes.listUncertain().map((item) => item.state.status)).toEqual([
      'outcome-unknown'
    ])
    const settled = second.runtime.occurrences.get('occ-1')
    const history = second.eventStore.listResourceMutations('trigger-occurrence', 'occ-1', 100)
    second.eventStore.close()

    clock.now += LEASE_MS + RETRY_DELAY_MS
    const third = harness({ eventStore: openStore(path), clock })
    expect(await third.runtime.occurrenceScheduler.runOnce()).toBe(false)
    expect(third.runAgent).not.toHaveBeenCalled()
    expect(third.runtime.occurrences.get('occ-1')).toEqual(settled)
    expect(third.eventStore.listResourceMutations('trigger-occurrence', 'occ-1', 100)).toEqual(
      history
    )
    expect(third.runtime.outcomes.listUncertain()).toHaveLength(1)
  })

  it('never dispatches either of two occurrences left in flight by exited runtimes', async () => {
    const eventStore = openStore()
    const clock = { now: START }
    const exited = [harness({ eventStore, clock }), harness({ eventStore, clock })]
    enqueue(exited[0], agentTarget, 'occ-1')
    enqueue(exited[0], agentTarget, 'occ-2')
    for (const runtime of exited) {
      const dispatched = Promise.withResolvers<void>()
      runtime.runAgent.mockImplementation(() => {
        dispatched.resolve()
        return new Promise<never>(() => undefined)
      })
      void runtime.runtime.occurrenceScheduler.runOnce()
      await dispatched.promise
    }
    clock.now += LEASE_MS + 1
    const next = harness({ eventStore, clock })
    const polls: boolean[] = []
    for (let poll = 0; poll < 3; poll += 1)
      polls.push(await next.runtime.occurrenceScheduler.runOnce())
    expect(next.runAgent).not.toHaveBeenCalled()
    expect(polls).toEqual([false, false, false])
    for (const id of ['occ-1', 'occ-2'])
      expect(occurrence(next, id)).toMatchObject({ status: 'unknown', attempt: 1 })
  })

  it('lets a second runtime settle, but never dispatch, an occurrence the first is dispatching', async () => {
    const eventStore = openStore()
    const clock = { now: START }
    const a = harness({ eventStore, clock })
    const b = harness({ eventStore, clock })
    enqueue(a)
    const dispatched = Promise.withResolvers<void>()
    const release = Promise.withResolvers<unknown>()
    a.runAgent.mockImplementation(() => {
      dispatched.resolve()
      return release.promise
    })
    const running = a.runtime.occurrenceScheduler.runOnce()
    await dispatched.promise
    clock.now += LEASE_MS + 1
    const claimedByB = await b.runtime.occurrenceScheduler.runOnce()
    expect(b.runAgent).not.toHaveBeenCalled()
    expect(claimedByB).toBe(false)
    expect(occurrence(b)?.status).toBe('unknown')
    release.resolve({ synthetic: true })
    await expect(running).rejects.toBeInstanceOf(TriggerOccurrenceFencingError)
    expect(occurrence(a)?.status).toBe('unknown')
    expect(await pollLater(b)).toEqual([false, false, false])
    expect(a.runAgent).toHaveBeenCalledTimes(1)
    expect(b.runAgent).not.toHaveBeenCalled()
  })
})
