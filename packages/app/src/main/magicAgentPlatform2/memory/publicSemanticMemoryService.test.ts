import { afterEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import { SqliteSemanticMemoryStore } from './sqliteSemanticMemoryStore'
import { SemanticMemoryService } from './semanticMemoryService'
import { PublicSemanticMemoryService } from './publicSemanticMemoryService'

const route = { channel: 'test', scopeType: 'dm' as const, scopeId: 'user-1', senderId: 'user-1' }
const actor = { kind: 'user' as const, id: 'user-1' }
const stores: SqliteSemanticMemoryStore[] = []

const createMemoryCore = () => {
  const store = new SqliteSemanticMemoryStore(':memory:')
  stores.push(store)
  return { store, core: new SemanticMemoryService(store) }
}

describe('PublicSemanticMemoryService', () => {
  afterEach(() => {
    while (stores.length) stores.pop()!.close()
  })
  it('authorizes before searching, isolates session scope, and projects no content or provenance', async () => {
    const { core } = createMemoryCore()
    const sessionId = 'test:dm:user-1'
    const content = 'private launch phrase'
    await core.upsert({
      id: 'm1',
      scope: { kind: 'session', id: sessionId },
      content,
      summary: 'secret summary',
      importance: 0.8,
      lifetime: 'durable',
      visibility: 'private',
      provenance: {
        source: 'x',
        sourceId: 'x',
        sessionId,
        createdAt: 1,
        contentHash: crypto.createHash('sha256').update(content).digest('hex')
      },
      sensitive: { sensitive: true, redacted: true },
      createdAt: 1,
      updatedAt: 1
    })
    const order: string[] = []
    const service = new PublicSemanticMemoryService({
      memory: core,
      authorize: ({ toolName }) => order.push(toolName)
    })
    const result = await service.search(
      { query: 'launch', scopes: [{ kind: 'session', route }], mode: 'lexical' },
      actor
    )
    expect(order).toEqual(['memory.search'])
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].memory.preview).toBe('secret summary')
    expect(result.hits[0].memory.redacted).toBe(true)
    expect(result.hits[0].memory.provenance).toEqual({
      sourceKind: 'x',
      sourceId: 'x',
      sourceSessionKey: sessionId,
      contentHash: crypto.createHash('sha256').update(content).digest('hex'),
      recordedAt: 1
    })
    expect(result.hits[0].memory).not.toHaveProperty('content')
    expect(result.hits[0].memory).not.toHaveProperty('summary')
  })

  it('exposes only a bounded always-redacted preview and allowlisted provenance after authorization', async () => {
    const { core } = createMemoryCore()
    const sessionId = 'test:dm:user-1'
    const content = `prefix password=hunter123 https://alice:secret@example.com/?token=urlsecret ${'x'.repeat(700)}`
    const hash = crypto.createHash('sha256').update(content).digest('hex')
    await core.upsert({
      id: 'preview',
      scope: { kind: 'session', id: sessionId },
      content,
      importance: 0.5,
      lifetime: 'durable',
      visibility: 'private',
      provenance: {
        source: 'assistant-session',
        sourceId: 'message:2',
        sessionId,
        runId: 'run-2',
        eventId: 'event-2',
        artifactId: 'artifact-2',
        createdAt: 2,
        contentHash: hash
      },
      sensitive: { sensitive: true, redacted: false, redactionKinds: ['internal-only'] },
      createdAt: 2,
      updatedAt: 2
    })
    const service = new PublicSemanticMemoryService({ memory: core, authorize: vi.fn() })
    const result = await service.search(
      { query: 'prefix', scopes: [{ kind: 'session', route }] },
      actor
    )
    const record = result.hits[0].memory
    expect(record.preview.length).toBeLessThanOrEqual(500)
    expect(record.preview).not.toContain('hunter123')
    expect(record.preview).not.toContain('urlsecret')
    expect(record.redacted).toBe(true)
    expect(record.provenance).toEqual({
      sourceKind: 'assistant-session',
      sourceId: 'message:2',
      sourceSessionKey: sessionId,
      sourceEventId: 'event-2',
      sourceRunId: 'run-2',
      sourceArtifactId: 'artifact-2',
      contentHash: hash,
      recordedAt: 2
    })
    expect(record.provenance).not.toHaveProperty('redactionKinds')
  })

  it('returns no record or preview when inspect route does not own the memory', async () => {
    const { core } = createMemoryCore()
    const content = 'private'
    await core.upsert({
      id: 'other',
      scope: { kind: 'session', id: 'test:dm:other' },
      content,
      importance: 0.5,
      lifetime: 'durable',
      visibility: 'private',
      provenance: {
        source: 'x',
        sourceId: 'x',
        createdAt: 1,
        contentHash: crypto.createHash('sha256').update(content).digest('hex')
      },
      sensitive: { sensitive: false, redacted: false },
      createdAt: 1,
      updatedAt: 1
    })
    const service = new PublicSemanticMemoryService({ memory: core, authorize: vi.fn() })
    await expect(service.inspect({ id: 'other', sourceRoute: route }, actor)).rejects.toThrow(
      'not owned'
    )
  })

  it('rejects non-user-owned routes and validates every session-set route', async () => {
    const { core } = createMemoryCore()
    const service = new PublicSemanticMemoryService({
      memory: core,
      authorize: vi.fn()
    })
    await expect(
      service.search(
        {
          query: 'x',
          scopes: [
            {
              kind: 'session-set',
              routes: [route, { ...route, scopeId: 'user-2', senderId: 'user-2' }]
            }
          ]
        },
        actor
      )
    ).rejects.toThrow('not owned')
  })

  it('authorizes a mutation before touching storage', async () => {
    const { store, core } = createMemoryCore()
    const service = new PublicSemanticMemoryService({
      memory: core,
      authorize: () => {
        throw new Error('denied')
      }
    })
    await expect(service.delete({ id: 'missing', sourceRoute: route }, actor)).rejects.toThrow(
      'denied'
    )
    expect(store.listAll()).toEqual([])
  })
})
