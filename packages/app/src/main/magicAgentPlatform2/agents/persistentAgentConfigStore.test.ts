import { describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import {
  createMagicAgentConfigContent,
  PersistentAgentConfigStore
} from './persistentAgentConfigStore'

const config = (version = 'v1') =>
  createMagicAgentConfigContent({
    version,
    definitionId: 'agent',
    model: { profileId: 'default' },
    systemPrompt: 'safe',
    inference: {},
    tools: { allowedToolNames: ['read'] },
    memory: { allowHistory: false, contextMessageLimit: 10, scope: 'instance' },
    policy: { policyIds: ['base'], workspaceRoots: ['/workspace'] },
    channels: { channelIds: [] },
    budgets: { maxRuntimeMs: 1000 },
    createdAt: 1,
    createdBy: { kind: 'user', id: 'owner' }
  })

describe('PersistentAgentConfigStore', () => {
  it('persists immutable content and exact-replays by digest', () => {
    const events = new MagicAgentEventStore(':memory:')
    const store = new PersistentAgentConfigStore(events)
    const input = { config: config(), idempotencyKey: 'create' }
    const created = store.create(input)
    expect(store.create(input)).toEqual(created)
    expect(store.get('v1')?.state.systemPrompt).toBe('safe')
    expect(events.getEvent('agent-config:v1:created:create')).toBeDefined()
    events.close()
  })

  it('rejects changed content, digest tampering, and version overwrite', () => {
    const events = new MagicAgentEventStore(':memory:')
    const store = new PersistentAgentConfigStore(events)
    store.create({ config: config(), idempotencyKey: 'create' })
    const changed = createMagicAgentConfigContent({ ...config(), systemPrompt: 'changed' })
    expect(() => store.create({ config: changed, idempotencyKey: 'create' })).toThrow(/conflict/)
    expect(() => store.create({ config: changed, idempotencyKey: 'other' })).toThrow(
      /already exists/
    )
    expect(() =>
      store.create({
        config: { ...config('v2'), contentDigest: '0'.repeat(64) },
        idempotencyKey: 'bad'
      })
    ).toThrow(/digest mismatch/)
    events.close()
  })
})
