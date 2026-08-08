import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearWorkflowCompletionListenersForTest,
  publishWorkflowCompletion
} from './workflowCompletionEvents'
import {
  clearTrustedChannelMessageListenersForTest,
  publishTrustedChannelMessage
} from './channelMessageEvents'
import type { PersistentTriggerState } from './persistentTriggerStore'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import type { AssistantTerminalPolicyRuntime } from '../productionRuntime'
import {
  TRIGGER_ROUTE,
  ProductionTriggerLifecycle,
  closeProductionTriggerLifecycle,
  startProductionTriggerLifecycle
} from './productionTriggerLifecycle'

afterEach(async () => {
  await closeProductionTriggerLifecycle()
  clearTrustedChannelMessageListenersForTest()
  clearWorkflowCompletionListenersForTest()
})

const policy = (eventStore: MagicAgentEventStore): AssistantTerminalPolicyRuntime =>
  ({
    eventStore,
    authorization: new MagicAgentPolicyAuthorizationService({
      store: eventStore,
      rules: [
        {
          ruleId: 'allow',
          priority: 1,
          effect: 'allow',
          match: {
            origins: ['trigger'],
            actions: ['trigger.execute'],
            targetKinds: ['trigger'],
            actorKinds: ['system'],
            effectKinds: ['tool.invoke'],
            risks: ['high']
          },
          explanation: 'allow'
        }
      ],
      policyVersion: 'test',
      storeId: 'test',
      trustedApprovers: [{ kind: 'system', id: 'trigger-test-approver' }]
    }),
    createTrustedApproval: vi.fn(),
    requestTerminalApproval: vi.fn(),
    listPendingTerminalApprovals: vi.fn(() => []),
    resolvePendingTerminalApproval: vi.fn(),
    shutdownTerminalApprovals: vi.fn(),
    authorizeAssistantMutation: vi.fn()
  }) as unknown as AssistantTerminalPolicyRuntime

describe('production trigger lifecycle adapter', () => {
  it('runs a workflow completion through policy, permit, dispatch, and durable outcome', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const policyRuntime = policy(eventStore)
    const runAgent = vi.fn(async (input) => input)
    const lifecycle = new ProductionTriggerLifecycle({
      policyRuntime,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: async (request) => {
        const grant = policyRuntime.authorization.createApprovalGrant({
          grantId: `workflow-grant:${request.requestId}`,
          request,
          approvedBy: { kind: 'system', id: 'trigger-test-approver' },
          issuedAt: 100,
          expiresAt: 200,
          maxUses: 1,
          idempotencyKey: `workflow-grant:${request.requestId}`
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      },
      routeResolver: () => ({ trusted: true }),
      now: () => 100,
      pollInterval: 60_000
    })
    lifecycle.runtime.store.create(
      {
        id: 'workflow-production',
        type: 'event',
        title: 'Workflow production',
        enabled: true,
        config: {
          graphId: 'graph-production',
          target: { kind: 'agent-run', agentId: 'workflow-agent', prompt: 'metadata only' }
        }
      },
      0,
      'workflow-production-create'
    )
    lifecycle.start()
    publishWorkflowCompletion({
      runId: 'run-production',
      graphId: 'graph-production',
      status: 'completed',
      completedAt: 100,
      outputDigest: 'b'.repeat(64)
    })
    await lifecycle.close()
    await lifecycle.runtime.occurrenceScheduler.runOnce()
    expect(runAgent).toHaveBeenCalledOnce()
    expect(lifecycle.runtime.occurrences.list()[0]?.state).toMatchObject({
      source: 'workflow-completion',
      status: 'completed',
      payloadDigest: 'b'.repeat(64)
    })
    expect(lifecycle.runtime.outcomes.list()).toEqual([
      expect.objectContaining({ state: expect.objectContaining({ status: 'succeeded' }) })
    ])
  })

  it('runs a published Channel event through policy, permit, dispatch, and durable outcome', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const policyRuntime = policy(eventStore)
    const runAgent = vi.fn(async (input) => input)
    const lifecycle = new ProductionTriggerLifecycle({
      policyRuntime,
      service: { runAgent, runGraph: vi.fn() },
      grantProvider: async (request) => {
        const grant = policyRuntime.authorization.createApprovalGrant({
          grantId: `channel-grant:${request.requestId}`,
          request,
          approvedBy: { kind: 'system', id: 'trigger-test-approver' },
          issuedAt: 100,
          expiresAt: 200,
          maxUses: 1,
          idempotencyKey: `channel-grant:${request.requestId}`
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      },
      routeResolver: () => ({ trusted: true }),
      now: () => 100,
      pollInterval: 60_000
    })
    lifecycle.runtime.store.create(
      {
        id: 'channel-production',
        type: 'message',
        title: 'Channel production',
        enabled: true,
        config: {
          channelId: 'channel-production-id',
          target: { kind: 'agent-run', agentId: 'channel-agent', prompt: 'metadata only' }
        }
      },
      0,
      'channel-production-create'
    )
    lifecycle.start()
    await lifecycle.close()
    publishTrustedChannelMessage({
      eventId: 'channel-production-event',
      channelId: 'channel-production-id',
      messageId: 'channel-production-message',
      receivedAt: 100,
      payloadDigest: 'a'.repeat(64)
    })
    expect(lifecycle.runtime.occurrences.list()).toHaveLength(0)

    lifecycle.start()
    publishTrustedChannelMessage({
      eventId: 'channel-production-event',
      channelId: 'channel-production-id',
      messageId: 'channel-production-message',
      receivedAt: 100,
      payloadDigest: 'a'.repeat(64)
    })
    await lifecycle.close()
    await lifecycle.runtime.occurrenceScheduler.runOnce()
    expect(runAgent).toHaveBeenCalledOnce()
    expect(lifecycle.runtime.occurrences.list()[0]?.state).toMatchObject({
      source: 'channel-message',
      status: 'completed',
      payloadDigest: 'a'.repeat(64)
    })
    expect(lifecycle.runtime.outcomes.list()).toEqual([
      expect.objectContaining({ state: expect.objectContaining({ status: 'succeeded' }) })
    ])
  })

  it('subscribes trusted Channel messages while started and unsubscribes on stop', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const lifecycle = new ProductionTriggerLifecycle({
      policyRuntime: policy(eventStore),
      service: { runAgent: vi.fn(), runGraph: vi.fn() },
      pollInterval: 60_000
    })
    lifecycle.runtime.store.create(
      {
        id: 'channel-lifecycle',
        type: 'message',
        title: 'Channel lifecycle',
        enabled: true,
        config: {
          channelId: 'channel-1',
          target: { kind: 'agent-run', agentId: 'agent-1' }
        }
      },
      0,
      'channel-lifecycle-create'
    )
    lifecycle.start()
    publishTrustedChannelMessage({
      eventId: 'event-one',
      channelId: 'channel-1',
      messageId: 'message-one',
      receivedAt: 1
    })
    expect(lifecycle.runtime.occurrences.list()).toHaveLength(1)
    await lifecycle.close()
    publishTrustedChannelMessage({
      eventId: 'event-two',
      channelId: 'channel-1',
      messageId: 'message-two',
      receivedAt: 2
    })
    expect(lifecycle.runtime.occurrences.list()).toHaveLength(1)
  })

  it('starts idempotently and maps trusted invocation shape', () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const service = { runAgent: vi.fn(), runGraph: vi.fn() }
    const lifecycle = startProductionTriggerLifecycle({
      policyRuntime: policy(eventStore),
      service
    })
    expect(startProductionTriggerLifecycle({ policyRuntime: policy(eventStore), service })).toBe(
      lifecycle
    )
    expect(lifecycle.runtime).toBeDefined()
  })

  it('dispatches agent and graph with explicit grant and invocation context', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const runAgent = vi.fn(async (input) => input)
    const runGraph = vi.fn(async (input) => input)
    const policyRuntime = policy(eventStore)
    const lifecycle = startProductionTriggerLifecycle({
      policyRuntime,
      service: { runAgent, runGraph },
      now: () => 1000,
      pollInterval: 60_000,
      grantProvider: async (request) => {
        const grant = policyRuntime.authorization.createApprovalGrant({
          grantId: `grant-${request.requestId}`,
          request,
          approvedBy: { kind: 'system', id: 'trigger-test-approver' },
          issuedAt: 1000,
          expiresAt: 2000,
          maxUses: 1,
          idempotencyKey: `grant-${request.requestId}`
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      }
    })
    const makeTrigger = (id: string, target: unknown): PersistentTriggerState => ({
      id,
      type: 'schedule',
      title: id,
      enabled: true,
      config: { target },
      schedule: { type: 'interval', intervalMs: 1000 },
      nextFireAt: 0
    })
    lifecycle.runtime.store.create(
      makeTrigger('agent-trigger', {
        kind: 'agent-run',
        agentId: 'a',
        prompt: 'p',
        sessionId: 's'
      }),
      0
    )
    await lifecycle.runtime.scheduler.runOnce()
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'a',
        text: 'p',
        route: {
          channel: 'magic-agent-trigger',
          scopeType: 'agent',
          scopeId: 'a',
          threadId: 'trigger-runtime'
        }
      }),
      expect.objectContaining({ methodName: 'magic-agent.trigger.run' })
    )
    lifecycle.runtime.store.create(
      makeTrigger('graph-trigger', { kind: 'graph-run', graphId: 'g', input: { x: 1 } }),
      1000
    )
    await lifecycle.runtime.scheduler.runOnce()
    expect(runGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: 'g',
        route: {
          channel: 'magic-agent-trigger',
          scopeType: 'agent',
          scopeId: 'g',
          threadId: 'trigger-runtime'
        }
      }),
      expect.objectContaining({ methodName: 'magic-agent.trigger.run' })
    )
    await lifecycle.close()
    eventStore.close()
  })

  it('does not dispatch high-risk trigger without a grant provider', async () => {
    const eventStore = new MagicAgentEventStore(':memory:')
    const runAgent = vi.fn()
    const lifecycle = startProductionTriggerLifecycle({
      policyRuntime: policy(eventStore),
      service: { runAgent, runGraph: vi.fn() }
    })
    lifecycle.runtime.store.create(
      {
        id: 'blocked',
        type: 'schedule',
        title: 'blocked',
        enabled: true,
        config: { target: { kind: 'agent-run', agentId: 'a', prompt: 'p' } },
        schedule: { type: 'interval', intervalMs: 1000 },
        nextFireAt: 0
      },
      0
    )
    await lifecycle.runtime.scheduler.runOnce()
    expect(runAgent).not.toHaveBeenCalled()
    await lifecycle.close()
    eventStore.close()
  })
})
