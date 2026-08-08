import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import { PersistentRuntimeChannelStore } from './persistentRuntimeChannelStore'
import { PersistentRuntimeChannelWireStore } from './persistentRuntimeChannelWireStore'
import {
  createRuntimeChannelWirePolicyRequest,
  RuntimeChannelWireCommandService
} from './runtimeChannelWireCommandService'

describe('RuntimeChannelWireCommandService', () => {
  it('requires approval before durable topology mutation', () => {
    const events = new MagicAgentEventStore(':memory:')
    const channels = new PersistentRuntimeChannelStore(events)
    channels.createChannel({
      channel: { id: 'source', name: 'S', mode: 'queue', capacity: 1, members: [] },
      createdAt: 1,
      idempotencyKey: 's'
    })
    let target = channels.createChannel({
      channel: { id: 'target', name: 'T', mode: 'queue', capacity: 1, members: [] },
      createdAt: 1,
      idempotencyKey: 't'
    })
    target = channels.join({
      channelId: target.id,
      expectedRevision: 0,
      member: { memberId: 'publisher', agentInstanceId: 'agent', role: 'producer', joinedAt: 2 },
      joinedAt: 2,
      idempotencyKey: 'p'
    })
    const wires = new PersistentRuntimeChannelWireStore(events, channels)
    const authorization = new MagicAgentPolicyAuthorizationService({
      store: events,
      policyVersion: 'm6',
      storeId: 'wire',
      trustedApprovers: [{ kind: 'user', id: 'approver' }],
      rules: [
        {
          ruleId: 'wire',
          priority: 1,
          effect: 'require-approval',
          match: { actions: ['runtime-channel.wire'] },
          explanation: 'approve',
          approvalRequirement: {
            scopeKind: 'request',
            scopeValue: 'wire',
            maxUses: 1,
            expiresInMs: 1000,
            reason: 'wire'
          }
        }
      ]
    })
    const commands = new RuntimeChannelWireCommandService(wires, authorization, () => 10)
    const input = {
      actor: { kind: 'user', id: 'user' } as const,
      wire: {
        id: 'wire',
        sourceChannelId: 'source',
        targetChannelId: 'target',
        targetPublisherMemberId: 'publisher',
        enabled: true,
        createdAt: 3,
        maxHops: 8
      },
      idempotencyKey: 'wire'
    }
    expect(() => commands.wire(input)).toThrow(/awaiting-approval/)
    expect(wires.get('wire')).toBeUndefined()
    const request = createRuntimeChannelWirePolicyRequest({
      actor: input.actor,
      action: 'wire',
      wireId: input.wire.id,
      sourceChannelId: input.wire.sourceChannelId,
      targetChannelId: input.wire.targetChannelId
    })
    const grant = authorization.createApprovalGrant({
      grantId: 'grant',
      request,
      approvedBy: { kind: 'user', id: 'approver' },
      issuedAt: 10,
      expiresAt: 1000,
      maxUses: 1,
      idempotencyKey: 'grant'
    }).grant
    expect(commands.wire({ ...input, grantId: grant.grantId, expectedGrantUseCount: 0 })?.id).toBe(
      'wire'
    )
    events.close()
  })
})
