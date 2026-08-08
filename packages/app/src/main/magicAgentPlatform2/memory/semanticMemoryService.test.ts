import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('fs')
vi.unmock('node:fs')
import type {
  SemanticEmbeddingProvider,
  SemanticMemoryChunk
} from '@shared/magicAgentPlatform2/memory'
import {
  AssistantSessionMemorySource,
  EmbeddingProviderRegistry,
  SemanticMemoryService,
  SqliteSemanticMemoryStore
} from '.'

const dirs: string[] = []
const baseDir = path.resolve('.tmp-semantic-memory-tests')
const openStore = () => {
  fs.mkdirSync(baseDir, { recursive: true })
  const dir = fs.mkdtempSync(path.join(baseDir, 'case-'))
  dirs.push(dir)
  return new SqliteSemanticMemoryStore(path.join(dir, 'nested', 'memory.sqlite3'))
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const chunk = (
  id: string,
  content: string,
  scopeId = 's1',
  extra: Partial<SemanticMemoryChunk> = {}
): SemanticMemoryChunk => {
  const now = 1000
  return {
    id,
    scope: { kind: 'session', id: scopeId },
    content,
    importance: 0.5,
    lifetime: 'durable',
    visibility: 'private',
    provenance: {
      source: 'test',
      sourceId: id,
      sessionId: scopeId,
      createdAt: now,
      contentHash: crypto.createHash('sha256').update(content).digest('hex')
    },
    sensitive: { sensitive: false, redacted: false },
    createdAt: now,
    updatedAt: now,
    ...extra
  }
}
const provider = (
  overrides: Partial<SemanticEmbeddingProvider> = {}
): SemanticEmbeddingProvider => ({
  id: 'local',
  remote: false,
  model: 'm1',
  dimension: 2,
  embed: async ({ texts }) => ({
    model: 'm1',
    dimension: 2,
    vectors: texts.map((text) => (text.includes('alpha') ? [1, 0] : [0, 1]))
  }),
  ...overrides
})

describe('semantic memory slice', () => {
  it('is durable across reopen and keeps lexical search without a provider', async () => {
    const store = openStore(),
      file = path.join((store as never as { db: {} }) ? dirs[0] : '', 'nested', 'memory.sqlite3')
    const service = new SemanticMemoryService(store)
    await service.upsert(chunk('a', 'alpha durable'))
    store.close()
    const reopened = new SqliteSemanticMemoryStore(file)
    const result = await new SemanticMemoryService(reopened).search({
      query: 'alpha',
      scopes: [{ kind: 'session', id: 's1' }],
      mode: 'hybrid'
    })
    expect(result.hits.map((h) => h.memory.id)).toEqual(['a'])
    expect(result.degraded).toBe(true)
    reopened.close()
  })
  it('isolates scopes and supports session sets', async () => {
    const store = openStore(),
      service = new SemanticMemoryService(store)
    await service.upsert(chunk('a', 'alpha', 's1'))
    await service.upsert(chunk('b', 'alpha', 's2'))
    expect(
      (
        await service.search({
          query: 'alpha',
          scopes: [{ kind: 'session', id: 's1' }],
          mode: 'lexical'
        })
      ).hits.map((h) => h.memory.id)
    ).toEqual(['a'])
    expect(
      (
        await service.search({
          query: 'alpha',
          scopes: [{ kind: 'session-set', id: 'set', sessionIds: ['s2'] }],
          mode: 'lexical'
        })
      ).hits.map((h) => h.memory.id)
    ).toEqual(['b'])
    store.close()
  })
  it('orders hybrid results and degrades on provider failure or mismatch', async () => {
    const store = openStore(),
      registry = new EmbeddingProviderRegistry()
    registry.register(provider())
    const service = new SemanticMemoryService(store, registry)
    await service.upsert(chunk('semantic', 'beta'), 'local')
    await service.upsert(chunk('lexical', 'alpha alpha'), 'local')
    const result = await service.search({
      query: 'alpha',
      scopes: [{ kind: 'session', id: 's1' }],
      providerId: 'local',
      mode: 'hybrid',
      semanticWeight: 0.9,
      lexicalWeight: 0.1
    })
    expect(result.hits[0].memory.id).toBe('lexical')
    const broken = new EmbeddingProviderRegistry()
    broken.register(
      provider({
        id: 'bad',
        embed: async () => ({ model: 'wrong', dimension: 3, vectors: [[1, 2, 3]] })
      })
    )
    const degraded = await new SemanticMemoryService(store, broken).search({
      query: 'alpha',
      scopes: [{ kind: 'session', id: 's1' }],
      providerId: 'bad'
    })
    expect(degraded.degraded).toBe(true)
    store.close()
  })
  it('filters expiry visibility disabled, and supports updates delete and clear', async () => {
    const store = openStore(),
      service = new SemanticMemoryService(store)
    await service.upsert(chunk('a', 'alpha'))
    await service.upsert(chunk('b', 'alpha', 's1', { visibility: 'shared' }))
    await service.upsert(chunk('expired', 'alpha', 's1', { expiresAt: 5 }))
    service.setDisabled('a', true)
    expect(
      (
        await service.search({
          query: 'alpha',
          scopes: [{ kind: 'session', id: 's1' }],
          visibility: ['private'],
          mode: 'lexical',
          now: 10
        })
      ).hits
    ).toHaveLength(0)
    service.setDisabled('a', false)
    service.setVisibility('a', 'workspace')
    expect(service.delete('b').affected).toBe(1)
    expect(service.clearScope({ kind: 'session', id: 's1' }).affected).toBe(2)
    store.close()
  })
  it('redacts secrets, is deterministic, and fails closed attribution and remote sensitive embedding', async () => {
    const source = new AssistantSessionMemorySource()
    const session = {
      sessionKey: 's',
      route: { channel: 'generic', scopeType: 'dm' as const, scopeId: 'x' },
      messages: [{ role: 'user' as const, content: 'api_key=supersecret alpha' }],
      createdAt: 1,
      updatedAt: 2,
      workspace: {
        workspaceId: 'w',
        workspaceRootDir: '',
        workspaceMetaFile: '',
        rootDir: '',
        memoryDir: '',
        memoryFile: '',
        contextFile: '',
        taskContextFile: '',
        pinnedContextFile: ''
      },
      runs: [],
      artifacts: [],
      eventLog: []
    }
    const chunks = source.createChunks(session)
    expect(chunks[0].content).not.toContain('supersecret')
    expect(source.createChunks(session)[0].id).toBe(chunks[0].id)
    expect(() => source.createChunks(session, { scopes: ['agent'] })).toThrow(/attribution/)
    const store = openStore(),
      registry = new EmbeddingProviderRegistry()
    registry.register(provider({ id: 'remote', remote: true }))
    await expect(
      new SemanticMemoryService(store, registry).upsert(chunks[0], 'remote')
    ).rejects.toThrow(/Sensitive/)
    expect(store.get(chunks[0].id)?.content).not.toContain('supersecret')
    store.close()
  })
  it('resumes rebuild jobs idempotently', async () => {
    const store = openStore(),
      registry = new EmbeddingProviderRegistry()
    registry.register(provider())
    const service = new SemanticMemoryService(store, registry)
    await service.upsert(chunk('a', 'alpha'))
    await service.upsert(chunk('b', 'beta'))
    expect((await service.rebuild('local', 'job', 1)).status).toBe('pending')
    const done = await service.rebuild('local', 'job', 1)
    expect(done.status).toBe('completed')
    expect(done.processed).toBe(2)
    expect((await service.rebuild('local', 'job', 1)).processed).toBe(2)
    store.close()
  })
})
