import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createAgentInstanceLifecyclePolicyRequest } from '../../magicAgentPlatform2/agents/productionAgentInstanceLifecycle'
import { ProductionAgentInstanceLifecycle } from '../../magicAgentPlatform2/agents/productionAgentInstanceLifecycleOwner'
import { MagicAgentEventStore } from '../../magicAgentPlatform2/persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../../magicAgentPlatform2/policy'
import { canonicalPolicyJson } from '../../../shared/magicAgentPlatform2/policy'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const enabled = process.env['MAGICPOT_M8_ABRUPT_RECOVERY_FIXTURE'] === '1'
const actor = { kind: 'user', id: 'recovery-owner' } as const
const EFFECT_IDEMPOTENCY_KEY = 'm8-abrupt-effect:stable-command-v1'

describe.skipIf(!enabled)('M8 abrupt recovery fixture', () => {
  it('leaves a real production Agent execution running after its effect commits', async () => {
    const databasePath = process.env['MAGICPOT_M8_RECOVERY_DATABASE']!
    const readyPath = process.env['MAGICPOT_M8_RECOVERY_READY']!
    const store = new MagicAgentEventStore(databasePath)
    const authorization = new MagicAgentPolicyAuthorizationService({
      store,
      rules: [
        {
          ruleId: 'fixture-allow',
          priority: 1,
          effect: 'allow',
          explanation: 'Allow bounded abrupt-recovery fixture operations.'
        }
      ],
      policyVersion: 'm8-recovery-v1',
      storeId: 'abrupt-child',
      trustedApprovers: [actor]
    })
    let signalCommitted!: () => void
    const committed = new Promise<void>((resolve) => (signalCommitted = resolve))
    const lifecycle = new ProductionAgentInstanceLifecycle({
      eventStore: store,
      authorization,
      platformService: { runAgent: vi.fn() },
      runAgent: async () => {
        const effect = store.mutateResource<{ count: number }>({
          operation: 'create',
          kind: 'm8-abrupt-side-effect',
          id: 'non-idempotent-once',
          state: { count: 1 },
          createdAt: Date.now(),
          idempotencyKey: EFFECT_IDEMPOTENCY_KEY,
          event: {
            protocolVersion: '2.0.0',
            id: 'm8-abrupt-side-effect-committed',
            type: 'm8.abrupt-side-effect.committed',
            createdAt: Date.now(),
            payload: { count: 1, idempotencyKey: EFFECT_IDEMPOTENCY_KEY },
            envelopeKind: 'event',
            streamId: 'm8-abrupt-recovery',
            sequence: 0
          }
        })
        expect(effect.resource.state.count).toBe(1)
        signalCommitted()
        return new Promise<never>(() => {})
      }
    })
    const instance = {
      id: 'abrupt-agent',
      name: 'Abrupt recovery Agent',
      definitionId: 'abrupt-agent-definition',
      depth: 0,
      configVersion: 'abrupt-v1',
      status: 'created' as const,
      limits: {
        maxChildren: 0,
        maxDepth: 0,
        maxConcurrency: 1,
        maxRuntimeMs: 60_000,
        allowedToolNames: [],
        workspaceRoots: []
      }
    }
    const createdAt = Date.now()
    const createRequest = createAgentInstanceLifecyclePolicyRequest({
      actor,
      action: 'create',
      instance: {
        kind: 'agent-instance',
        id: instance.id,
        revision: 0,
        state: instance,
        deleted: false,
        createdAt,
        updatedAt: createdAt
      }
    })
    expect(createRequest.action).toBe('agent-instance.create')
    const createGrant = authorization.createApprovalGrant({
      grantId: 'create-abrupt-agent-grant',
      request: createRequest,
      approvedBy: actor,
      issuedAt: createdAt,
      expiresAt: createdAt + 60_000,
      maxUses: 1,
      idempotencyKey: 'create-abrupt-agent-grant'
    }).grant
    const created = lifecycle.commands.createRoot({
      actor,
      instance,
      createdAt,
      idempotencyKey: 'create-abrupt-agent',
      grantId: createGrant.grantId,
      expectedGrantUseCount: 0
    })
    const startRequestBody = {
      text: 'commit exactly one durable effect then remain running',
      route: { channel: 'e2e', scopeType: 'dm' as const, scopeId: 'abrupt-recovery' }
    }
    const startRequest = createAgentInstanceLifecyclePolicyRequest({
      actor,
      action: 'start',
      instance: created,
      requestDigest: createHash('sha256')
        .update(canonicalPolicyJson(startRequestBody as never))
        .digest('hex')
    })
    const startGrant = authorization.createApprovalGrant({
      grantId: 'start-abrupt-agent-grant',
      request: startRequest,
      approvedBy: actor,
      issuedAt: createdAt,
      expiresAt: createdAt + 60_000,
      maxUses: 1,
      idempotencyKey: 'start-abrupt-agent-grant'
    }).grant
    await lifecycle.commands.start({
      actor,
      instanceId: created.id,
      expectedRevision: created.revision,
      request: startRequestBody,
      idempotencyKey: 'start-abrupt-agent',
      grantId: startGrant.grantId,
      expectedGrantUseCount: 0
    })
    await committed
    expect(lifecycle.store.get(created.id)?.state.status).toBe('running')
    writeFileSync(readyPath, 'ready', 'utf8')
    await new Promise<never>(() => {})
  }, 60_000)
})
