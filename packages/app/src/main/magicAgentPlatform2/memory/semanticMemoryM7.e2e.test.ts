import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('fs')
vi.unmock('node:fs')
import type { SemanticEmbeddingProvider } from '@shared/magicAgentPlatform2/memory'
import type { AssistantRuntime } from '../../assistantRuntime/runtime'
import type { AssistantSessionRecord } from '../../assistantRuntime/types'
import {
  EmbeddingProviderRegistry,
  PublicSemanticMemoryService,
  SemanticMemoryService,
  SqliteSemanticMemoryStore
} from './index'

const root = path.resolve(process.cwd(), 'tmp-semantic-memory-m7-e2e')
const dirs: string[] = []
const actor = { kind: 'user' as const, id: 'owner' }
const routeA = { channel: 'alpha', scopeType: 'dm' as const, scopeId: 'owner', senderId: 'owner' }
const routeB = { channel: 'beta', scopeType: 'dm' as const, scopeId: 'owner', senderId: 'owner' }
const scope = (route: typeof routeA) => ({ kind: 'session' as const, route })

const session = (
  sessionKey: string,
  channel: string,
  messages: string[]
): AssistantSessionRecord => ({
  sessionKey,
  route: { channel, scopeType: 'dm', scopeId: 'owner', senderId: 'owner' },
  messages: messages.map((content) => ({ role: 'user' as const, content })),
  messageEntries: messages.map((content, index) => ({
    messageId: `message-${index}`,
    message: { role: 'user' as const, content },
    order: index,
    createdAt: 10 + index,
    attributionQuality: 'legacy-approximate' as const
  })),
  createdAt: 10,
  updatedAt: 20,
  workspace: {
    workspaceId: 'workspace',
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
})

const provider = (fail = false): SemanticEmbeddingProvider => ({
  id: fail ? 'broken' : 'local',
  remote: false,
  model: 'deterministic',
  dimension: 2,
  embed: async ({ texts }) => {
    if (fail) throw new Error('provider unavailable')
    return {
      model: 'deterministic',
      dimension: 2,
      vectors: texts.map((text) =>
        text.includes('meaning-query') || text.includes('nebula') ? [1, 0] : [0, 1]
      )
    }
  }
})

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('M7 §3.9 semantic memory end to end', () => {
  it('persists redacted session memory and exercises public search and administration', async () => {
    fs.mkdirSync(root, { recursive: true })
    const dir = fs.mkdtempSync(path.join(root, 'case-'))
    dirs.push(dir)
    const file = path.join(dir, 'memory.sqlite3')
    const sessions = new Map([
      [
        'alpha:dm:owner',
        session('alpha:dm:owner', 'alpha', ['alpha api_key=supersecret', 'nebula archive'])
      ],
      ['beta:dm:owner', session('beta:dm:owner', 'beta', ['alpha isolated'])]
    ])
    const runtime = {
      listSessions: async () => [
        { sessionKey: 'alpha:dm:owner', route: routeA, workspaceId: 'workspace', updatedAt: 1 },
        { sessionKey: 'beta:dm:other', route: routeB, workspaceId: 'workspace', updatedAt: 1 }
      ],
      getSession: async (route: { channel: string }) => sessions.get(`${route.channel}:dm:owner`)
    } as unknown as AssistantRuntime
    const policy: string[] = []
    const registry = new EmbeddingProviderRegistry()
    registry.register(provider())
    registry.register(provider(true))
    let store = new SqliteSemanticMemoryStore(file)
    let core = new SemanticMemoryService(store, registry)
    let service = new PublicSemanticMemoryService({
      memory: core,
      assistantRuntime: runtime,
      authorize: ({ toolName }) => policy.push(toolName)
    })

    expect(
      await service.ingestSession({ sourceRoute: routeA, providerId: 'local' }, actor)
    ).toEqual({ discovered: 2, upserted: 2 })
    const persisted = store.listAll()
    expect(persisted.some((item) => item.content.includes('supersecret'))).toBe(false)
    expect(persisted.some((item) => item.content.includes('[REDACTED:api-key]'))).toBe(true)
    store.close()

    store = new SqliteSemanticMemoryStore(file)
    core = new SemanticMemoryService(store, registry)
    service = new PublicSemanticMemoryService({
      memory: core,
      assistantRuntime: runtime,
      authorize: ({ toolName }) => policy.push(toolName)
    })
    const lexical = await service.search(
      { query: 'alpha', scopes: [scope(routeA)], mode: 'lexical' },
      actor
    )
    expect(lexical.hits).toHaveLength(1)
    expect(JSON.stringify(lexical)).not.toMatch(
      /"content"\s*:|"vector"\s*:|supersecret|nebula archive/
    )
    const semantic = await service.search(
      { query: 'meaning-query', scopes: [scope(routeA)], mode: 'semantic', providerId: 'local' },
      actor
    )
    expect(semantic.effectiveMode).toBe('semantic')
    expect(semantic.hits[0].memory.id).toBe(
      persisted.find((item) => item.content.includes('nebula'))!.id
    )
    const hybrid = await service.search(
      {
        query: 'alpha',
        scopes: [scope(routeA)],
        mode: 'hybrid',
        providerId: 'local',
        semanticWeight: 0.8,
        lexicalWeight: 0.2
      },
      actor
    )
    expect(hybrid.effectiveMode).toBe('hybrid')
    const degraded = await service.search(
      { query: 'alpha', scopes: [scope(routeA)], mode: 'semantic', providerId: 'broken' },
      actor
    )
    expect(degraded).toMatchObject({
      degraded: true,
      effectiveMode: 'lexical',
      degradationReason: 'provider unavailable'
    })

    await service.ingestSession({ sourceRoute: routeB, providerId: 'local' }, actor)
    expect(
      (await service.search({ query: 'isolated', scopes: [scope(routeA)], mode: 'lexical' }, actor))
        .hits
    ).toHaveLength(0)
    expect(
      (await service.search({ query: 'isolated', scopes: [scope(routeB)], mode: 'lexical' }, actor))
        .hits
    ).toHaveLength(1)

    const id = lexical.hits[0].memory.id
    expect((await service.inspect({ id, sourceRoute: routeA }, actor)).memory).not.toHaveProperty(
      'content'
    )
    expect(
      (await service.setVisibility({ id, sourceRoute: routeA, visibility: 'private' }, actor))
        .affected
    ).toBe(1)
    expect(
      (await service.setDisabled({ id, sourceRoute: routeA, disabled: true }, actor)).affected
    ).toBe(1)
    expect(
      (await service.search({ query: 'alpha', scopes: [scope(routeA)], mode: 'lexical' }, actor))
        .hits
    ).toHaveLength(0)
    expect(
      (await service.setDisabled({ id, sourceRoute: routeA, disabled: false }, actor)).affected
    ).toBe(1)
    expect(
      (
        await service.rebuild(
          { sourceRoute: routeA, providerId: 'local', jobId: 'm7', batchSize: 50 },
          actor
        )
      ).status
    ).toBe('completed')
    expect((await service.delete({ id, sourceRoute: routeA }, actor)).affected).toBe(1)
    expect((await service.clearScope({ scope: scope(routeB) }, actor)).affected).toBe(1)
    expect(policy).toContain('memory.inspect')
    store.close()
  })

  it('runs Policy before storage for denied ingest and mutations', async () => {
    const store = new SqliteSemanticMemoryStore(':memory:')
    const core = new SemanticMemoryService(store)
    const runtime = {
      getSession: async () => session('alpha:dm:owner', 'alpha', ['must not persist'])
    } as unknown as AssistantRuntime
    const service = new PublicSemanticMemoryService({
      memory: core,
      assistantRuntime: runtime,
      authorize: () => {
        throw new Error('policy denied')
      }
    })
    await expect(service.ingestSession({ sourceRoute: routeA }, actor)).rejects.toThrow(
      'policy denied'
    )
    expect(store.listAll()).toEqual([])
    await expect(service.clearScope({ scope: scope(routeA) }, actor)).rejects.toThrow(
      'policy denied'
    )
    expect(store.listAll()).toEqual([])
    store.close()
  })
})
