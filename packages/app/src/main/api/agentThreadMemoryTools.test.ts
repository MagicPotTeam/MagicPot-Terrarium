import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentArchiveSearchResult } from '@shared/api/agentThreadMemory'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { agentThreadArchive } from './agentThreadArchive'
import { AgentThreadInteractions } from './agentThreadInteractions'
import { createAgentThreadMemoryTools } from './agentThreadMemoryTools'
import { clearMagicAgentTrustedRouteBindingsForTest, registerMagicAgentTrustedRouteBinding } from '../magicAgentRuntime/trustedRouteBinding'

const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: electron.fromId }, BrowserWindow: { fromWebContents: electron.parent } }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'conversation' }
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invoke = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 95, isMainFrame: true, senderUrl: url, frameUrl: url })
const context = { route, runId: 'owned', toolCallId: 'search' }
let sender: EventEmitter, lease: NonNullable<ReturnType<AgentThreadInteractions['create']>>, provider: AssistantRunToolProvider
const admission = vi.fn()
const list = () => agentThreadArchive.list(scope, invoke('listAgentArchiveQueries'))
const value = (): AgentArchiveSearchResult => ({ source: 'session_archive', mode: 'literal', matches: [], scannedMessages: 1, scannedCharacters: 3, totalMessages: 1, truncated: false, untrustedData: true })
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); admission.mockReset()
  sender = Object.assign(new EventEmitter(), { id: 95, isDestroyed: () => false, getURL: () => url })
  electron.fromId.mockReturnValue(sender); electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(95, route, { trustedUrl: url, trustedWebContents: sender as never })
  lease = new AgentThreadInteractions().create({ ...scope, messages: [] }, invoke('chat'))!
  provider = createAgentThreadMemoryTools({ scope, senderId: 95, lease, assertInvocation: admission })
})
afterEach(() => { lease.dispose(); clearMagicAgentTrustedRouteBindingsForTest(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('bounded original-conversation memory tool', () => {
  it('returns detached definitions and exposes current-conversation/local-mode limitations', () => {
    const first = provider.listTools()
    expect(first.map(tool => tool.name)).toEqual(['search_memory'])
    expect(first[0].description).toContain('not embedding/semantic')
    expect(first[0].description).toContain('priorCompactionUnavailable')
    first[0].inputSchema.extra = 'mutated'; first[0].description = 'changed'
    expect(provider.listTools()[0].inputSchema).not.toHaveProperty('extra')
    expect(provider.listTools()[0].description).not.toBe('changed')
    expect(list()).toEqual([]); expect(admission).not.toHaveBeenCalled()
  })
  it.each([
    {}, { query: '' }, { query: '   ' }, { query: 'x'.repeat(257) }, { query: 'x', k: 0 }, { query: 'x', k: 21 },
    { query: 'x', limit: 1.5 }, { query: 'x', k: 1, limit: 1 }, { query: 'x', mode: 'unknown' },
    { query: 'x', mode: 'semantic' }, { query: 'x', mode: 'hybrid' }, { query: 'x', agent: 'other' },
    { query: 'x', conversationId: 'sibling' }, { query: 'x', route: { ...route, scopeId: 'other' } },
    { query: 'x', source: 'hidden' }, { query: 'x', toolName: 'files.read' },
    { query: 'x', beforeCharacter: 1 }, { query: 'x', beforeEvent: 1, beforeMessage: 1 },
    { query: 'x', beforeMessage: -1 }, { query: 'x', source: 'tools', beforeMessage: 1, beforeCharacter: 1 },
    { query: 'x', source: 'tools', toolName: '../bad' }
  ])('rejects invalid/unsupported or cross-owner parameters without a query: %j', async args => {
    await expect(provider.callTool('search_memory', args, context)).rejects.toThrow()
    expect(list()).toEqual([])
  })
  it.each([
    { requested: undefined, effective: 'bm25', k: 5 }, { requested: 'auto', effective: 'bm25', k: 5 },
    { requested: 'fts', effective: 'lexical', k: 2 }, { requested: 'literal', effective: 'literal', k: 1 },
    { requested: 'lexical', effective: 'lexical', k: 5 }, { requested: 'bm25', effective: 'bm25', k: 3 }
  ])('labels requested $requested as effective $effective without pretending embedding parity', async ({ requested, effective, k }) => {
    const pending = provider.callTool('search_memory', { query: 'older', k, ...(requested ? { mode: requested } : {}) }, context)
    const [query] = list()
    expect(query.search).toEqual({ query: 'older', source: 'messages', mode: effective, limit: k })
    agentThreadArchive.resolve({ ...scope, queryId: query.id, unavailable: true }, invoke('resolveAgentArchiveQuery'))
    expect(JSON.parse((await pending).content)).toEqual({ source: 'session_archive', status: 'unavailable', requestedMode: requested ?? 'auto', effectiveMode: effective, untrustedData: true, grantsPermission: false })
    expect(list()).toEqual([])
  })
  it('distinguishes real empty results from unavailable and preserves missing-original warnings', async () => {
    const pending = provider.callTool('search_memory', { query: 'older', mode: 'literal' }, context), [query] = list()
    const result = { ...value(), priorCompactionUnavailable: true }
    agentThreadArchive.resolve({ ...scope, queryId: query.id, result }, invoke('resolveAgentArchiveQuery'))
    expect(JSON.parse((await pending).content)).toEqual({ ...result, status: 'available', requestedMode: 'literal', effectiveMode: 'literal', grantsPermission: false })
  })
  it('returns explicit unavailable on timeout without request-window fallback', async () => {
    const pending = provider.callTool('search_memory', { query: 'older', mode: 'literal' }, context)
    expect(list()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(JSON.parse((await pending).content)).toMatchObject({ status: 'unavailable' })
    expect(list()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['caller', 'navigation', 'dispose'] as const)('revokes original-history query on %s and refuses late replies', async change => {
    const controller = new AbortController()
    const pending = provider.callTool('search_memory', { query: 'older', mode: 'literal' }, { ...context, signal: controller.signal }).catch(error => error)
    const [query] = list()
    if (change === 'caller') controller.abort()
    if (change === 'navigation') sender.emit('did-start-navigation', { isMainFrame: true })
    if (change === 'dispose') lease.dispose()
    expect(await pending).toBeInstanceOf(Error)
    expect(() => agentThreadArchive.resolve({ ...scope, queryId: query.id, result: value() }, invoke('resolveAgentArchiveQuery'))).toThrow('not active')
    expect(list()).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })
  it('refuses stale/foreign context and invocations outside existing admission before any query', async () => {
    await expect(provider.callTool('scratchpad', { query: 'older' }, context)).rejects.toThrow('outside')
    await expect(provider.callTool('search_memory', { query: 'older' }, { ...context, route: { ...route, threadId: 'other' } })).rejects.toThrow('outside')
    admission.mockImplementationOnce(() => { throw Error('No original admission owner') })
    await expect(provider.callTool('search_memory', { query: 'older' }, context)).rejects.toThrow('No original admission owner')
    expect(list()).toEqual([])
  })
})
