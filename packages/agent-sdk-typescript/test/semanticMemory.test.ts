import { describe, expect, it, vi } from 'vitest'
import { MagicAgentClient } from '../src/client.js'
import { MemoryAgentTransport } from '../src/testing.js'

describe('semantic memory SDK methods', () => {
  const route = { channel: 'generic', scopeType: 'dm', scopeId: 'owner' } as const
  const cases: Array<[string, string, Record<string, unknown>, unknown]> = [
    [
      'searchSemanticMemory',
      'memory.search',
      {
        query: 'alpha',
        scopes: [{ kind: 'session', route }],
        visibility: ['private'],
        mode: 'hybrid',
        limit: 4,
        lexicalWeight: 0.2,
        semanticWeight: 0.8,
        providerId: 'local',
        now: 12
      },
      { hits: [], requestedMode: 'hybrid', effectiveMode: 'lexical', degraded: true }
    ],
    [
      'inspectSemanticMemory',
      'memory.inspect',
      { id: 'm1', sourceRoute: route },
      { memory: { id: 'm1' } }
    ],
    ['deleteSemanticMemory', 'memory.delete', { id: 'm1', sourceRoute: route }, { affected: 1 }],
    [
      'setSemanticMemoryDisabled',
      'memory.setDisabled',
      { id: 'm1', sourceRoute: route, disabled: true },
      { affected: 1 }
    ],
    [
      'setSemanticMemoryVisibility',
      'memory.setVisibility',
      { id: 'm1', sourceRoute: route, visibility: 'workspace' },
      { affected: 1 }
    ],
    [
      'clearSemanticMemoryScope',
      'memory.clearScope',
      { scope: { kind: 'session', route } },
      { affected: 2 }
    ],
    [
      'rebuildSemanticMemory',
      'memory.rebuild',
      { sourceRoute: route, providerId: 'local', jobId: 'j', batchSize: 2 },
      {
        id: 'j',
        providerId: 'local',
        status: 'completed',
        processed: 2,
        createdAt: 1,
        updatedAt: 2
      }
    ],
    [
      'ingestSessionMemory',
      'memory.ingestSession',
      { sourceRoute: route, providerId: 'local' },
      { discovered: 2, upserted: 2 }
    ],
    [
      'ingestSemanticMemoryScope',
      'memory.ingestScope',
      { scope: { kind: 'workspace', id: 'workspace-1', sourceRoute: route }, providerId: 'local' },
      { discovered: 2, upserted: 2 }
    ],
    [
      'linkSemanticMemoryAgentSession',
      'memory.linkAgentSession',
      { agentId: 'agent-1', sourceRoute: route },
      [{ agentId: 'agent-1', sessionId: 'generic:dm:owner', createdAt: 1 }]
    ],
    [
      'unlinkSemanticMemoryAgentSession',
      'memory.unlinkAgentSession',
      { agentId: 'agent-1', sourceRoute: route },
      []
    ]
  ]

  it.each(cases)(
    '%s serializes exactly and returns the transport result',
    async (method, wireMethod, payload, result) => {
      const handler = vi.fn(async () => result as never)
      const transport = new MemoryAgentTransport(handler)
      const client = new MagicAgentClient(transport)
      await expect(
        (client[method as keyof MagicAgentClient] as (value: unknown) => Promise<unknown>)(payload)
      ).resolves.toEqual(result)
      expect(transport.requests).toEqual([{ method: wireMethod, payload }])
      expect(payload).not.toHaveProperty('actor')
    }
  )

  it('lists Agent session links with an exact actor-free payload', async () => {
    const transport = new MemoryAgentTransport(async () => [])
    await new MagicAgentClient(transport).listSemanticMemoryAgentSessions('agent-1')
    expect(transport.requests).toEqual([
      { method: 'memory.listAgentSessions', payload: { agentId: 'agent-1' } }
    ])
    expect(transport.requests[0].payload).not.toHaveProperty('actor')
  })
})
