import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentThreadArchive } from './agentThreadArchive'
import { AgentThreadInteractions } from './agentThreadInteractions'
import type { AgentArchiveSearchResult } from '@shared/api/agentThreadMemory'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const electron = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ webContents: { fromId: electron.fromId }, BrowserWindow: { fromWebContents: electron.parent } }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const scope = { route, conversationId: 'conversation' }
const url = 'file:///D:/app/index.html#/canvas?id=project'
const invocation = (method = 'chat') => ({ methodName: `svcLLMProxy.${method}`, senderId: 71, isMainFrame: true, senderUrl: url, frameUrl: url })
let archive: AgentThreadArchive
let lease: NonNullable<ReturnType<AgentThreadInteractions['create']>>
let sender: EventEmitter & { id: number; isDestroyed: () => boolean; getURL: () => string }
const result = (): AgentArchiveSearchResult => ({ source: 'session_archive', mode: 'literal', matches: [{ messageIndex: 0, role: 'user', excerpt: 'Old visible note' }], scannedMessages: 2, scannedCharacters: 20, totalMessages: 2, truncated: false, untrustedData: true })
const list = () => archive.list(scope, invocation('listAgentArchiveQueries'))
const resolve = (id: string, value = result()) => archive.resolve({ ...scope, queryId: id, result: value }, invocation('resolveAgentArchiveQuery'))
beforeEach(() => {
  vi.useFakeTimers(); archive = new AgentThreadArchive()
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url })
  electron.fromId.mockReturnValue(sender); electron.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender })
  lease = new AgentThreadInteractions().create({ ...scope, messages: [] }, invocation())!
})
afterEach(() => { lease.dispose(); clearMagicAgentTrustedRouteBindingsForTest(); vi.useRealTimers(); vi.clearAllMocks() })
describe('current-conversation archive query bridge', () => {
  it('returns only bounded text excerpts and discards duplicate replies', async () => {
    const pending = archive.search(scope, 71, lease, { query: 'old' })
    const [query] = list(); expect(query.search).toEqual({ query: 'old' })
    resolve(query.id)
    expect(await pending).toEqual(result())
    expect(list()).toEqual([])
    expect(() => resolve(query.id)).toThrow('not active')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cannot deliver across conversation/pane/project/sender or without main-frame IPC', async () => {
    const pending = archive.search(scope, 71, lease, { query: 'old' })
    const [query] = list()
    for (const other of [{ ...scope, conversationId: 'other' }, { ...scope, route: { ...route, threadId: 'other' } }]) {
      expect(archive.list(other, invocation('listAgentArchiveQueries'))).toEqual([])
      expect(() => archive.resolve({ ...other, queryId: query.id, result: result() }, invocation('resolveAgentArchiveQuery'))).toThrow('not active')
    }
    expect(() => archive.list(scope)).toThrow()
    expect(() => archive.list(scope, { ...invocation('listAgentArchiveQueries'), isMainFrame: false })).toThrow()
    expect(() => archive.list({ ...scope, route: { ...route, scopeId: 'other' } }, invocation('listAgentArchiveQueries'))).toThrow()
    expect(() => archive.list(scope, { ...invocation('listAgentArchiveQueries'), senderId: 72 })).toThrow()
    resolve(query.id); await pending
  })
  it.each(['abort', 'navigation', 'dispose'])('revokes pending search on %s and refuses late results', async (reason) => {
    const controller = new AbortController()
    const pending = archive.search(scope, 71, lease, { query: 'old' }, controller.signal).catch((e) => e)
    const [query] = list()
    if (reason === 'abort') controller.abort(); else if (reason === 'navigation') sender.emit('did-start-navigation', { isMainFrame: true }); else lease.dispose()
    expect(await pending).toBeInstanceOf(Error)
    expect(() => resolve(query.id)).toThrow('not active')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('explicit unavailable and timeout permit labeled request-only fallback', async () => {
    const first = archive.search(scope, 71, lease, { query: 'old' })
    archive.resolve({ ...scope, queryId: list()[0].id, unavailable: true }, invocation('resolveAgentArchiveQuery'))
    expect(await first).toBeUndefined()
    const second = archive.search(scope, 71, lease, { query: 'old' })
    await vi.advanceTimersByTimeAsync(10000)
    expect(await second).toBeUndefined()
    expect(list()).toEqual([])
  })
  it('keeps event provenance and lexically ranked results bound to the original query', async () => {
    const value: AgentArchiveSearchResult = { source: 'session_archive', mode: 'lexical', searchSource: 'tools', ranking: 'page-local-token-coverage', engine: 'unicode-token-scan', matches: [{ messageIndex: 1, role: 'assistant', kind: 'tool_result', eventIndex: 1, toolIndex: 0, toolName: 'files.read', toolStatus: 'unknown', score: 1, excerpt: 'older result' }], scannedMessages: 1, scannedEvents: 1, scannedCharacters: 20, totalMessages: 2, truncated: true, nextBeforeMessage: 2, nextBeforeEvent: 1, untrustedData: true }
    const pending = archive.search(scope, 71, lease, { query: 'older result', mode: 'lexical', source: 'tools', toolName: 'files.read' })
    const [query] = list()
    for (const invalid of [
      { ...value, mode: 'literal' }, { ...value, searchSource: 'all' },
      { ...value, matches: [{ ...value.matches[0], kind: 'message' }] },
      { ...value, matches: [{ ...value.matches[0], toolName: 'private' }] },
      { ...value, matches: [{ ...value.matches[0], eventIndex: 2 }] },
      { ...value, matches: [{ ...value.matches[0], args: { secret: 'must not pass' } }] },
      { ...value, matches: [{ ...value.matches[0], score: 1.1 }] }
    ]) expect(() => resolve(query.id, invalid as AgentArchiveSearchResult)).toThrow('Invalid')
    resolve(query.id, value); expect(await pending).toEqual(value)
    const next = archive.search(scope, 71, lease, { query: 'older result', mode: 'lexical', source: 'tools', beforeMessage: 2, beforeEvent: 1 })
    expect(() => resolve(list()[0].id, value)).toThrow('cursor')
    resolve(list()[0].id, { ...value, matches: [], truncated: false, nextBeforeMessage: undefined, nextBeforeEvent: undefined })
    await next
  })
  it('accepts advancing event/body cursors but rejects a same-event nonprogressing position', async () => {
    const pending = archive.search(scope, 71, lease, { query: 'old', source: 'all', beforeMessage: 2, beforeEvent: 2, beforeCharacter: 1000 })
    const value: AgentArchiveSearchResult = { ...result(), searchSource: 'all', matches: [], truncated: true, nextBeforeMessage: 2, nextBeforeEvent: 2, nextBeforeCharacter: 500 }
    expect(() => resolve(list()[0].id, { ...value, nextBeforeCharacter: 1000 })).toThrow('cursor')
    expect(() => resolve(list()[0].id, { ...value, nextBeforeEvent: undefined })).toThrow('cursor')
    resolve(list()[0].id, value); expect(await pending).toEqual(value)
  })
  it('requires BM25 corpus/ranking/provenance and refuses old or forged result shapes without accepting a text fallback', async () => {
    const { searchAgentSessionArchive } = await import('../../renderer/src/pages/ChatPage/agentArchiveSearch')
    const search = { query: 'blue red', mode: 'bm25' as const, source: 'all' as const, limit: 2 }
    const ranking = searchAgentSessionArchive([{ role: 'user', content: 'blue red blue' }, { role: 'assistant', content: 'blue', toolHistory: [{ runId: 'r', toolCallId: 'c', toolName: 'files.read', args: { secret: 'SECRET' }, status: 'completed', content: 'red historical evidence' }] }], search)
    await vi.advanceTimersByTimeAsync(1)
    const value = await ranking
    const pending = archive.search(scope, 71, lease, search), [query] = list()
    expect(value.matches).toHaveLength(2)
    expect(value.corpus).toMatchObject({ documents: 3, matchingDocuments: 3, omittedMatches: 1, scanComplete: true })
    for (const invalid of [
      { ...value, mode: 'lexical' }, { ...value, engine: 'unicode-token-scan' }, { ...value, ranking: 'page-local-token-coverage' }, { ...value, corpus: undefined },
      { ...value, corpus: { ...value.corpus!, scanComplete: false } }, { ...value, corpus: { ...value.corpus!, matchingDocuments: 1 } }, { ...value, corpus: { ...value.corpus!, tokens: 0 } },
      { ...value, matches: [{ ...value.matches[0], chunkStart: undefined }, value.matches[1]] }, { ...value, matches: [{ ...value.matches[0], score: 0 }, value.matches[1]] },
      { ...value, matches: [{ ...value.matches[0], score: 0.01 }, { ...value.matches[1], score: 10 }] }, { ...value, matches: [{ ...value.matches[0], args: { token: 'SECRET' } }, value.matches[1]] }
    ]) expect(() => resolve(query.id, invalid as AgentArchiveSearchResult)).toThrow('Invalid')
    resolve(query.id, value); expect(await pending).toEqual(value)
    const old = archive.search(scope, 71, lease, search)
    expect(() => resolve(list()[0].id, result())).toThrow('mode/source')
    archive.resolve({ ...scope, queryId: list()[0].id, unavailable: true }, invocation('resolveAgentArchiveQuery')); expect(await old).toBeUndefined()
  })
  it('accepts bounded BM25 partial source cursors while rejecting a non-advancing or falsely complete window', async () => {
    const pending = archive.search(scope, 71, lease, { query: 'blue', mode: 'bm25', source: 'tools', beforeMessage: 2, beforeEvent: 2, beforeCharacter: 10000 })
    const value: AgentArchiveSearchResult = { source: 'session_archive', mode: 'bm25', searchSource: 'tools', ranking: 'scan-window-bm25', engine: 'unicode-bm25-scan', matches: [], scannedMessages: 0, scannedEvents: 0, scannedCharacters: 8192, totalMessages: 2, truncated: true, nextBeforeMessage: 2, nextBeforeEvent: 2, nextBeforeCharacter: 1808, untrustedData: true, corpus: { documents: 1, tokens: 1, matchingDocuments: 0, omittedMatches: 0, scanComplete: false, documentUnit: '8192-character-chunks', k1: 1.2, b: 0.75 } }
    expect(() => resolve(list()[0].id, { ...value, nextBeforeCharacter: 10000 })).toThrow('cursor')
    expect(() => resolve(list()[0].id, { ...value, corpus: { ...value.corpus!, scanComplete: true } })).toThrow('corpus')
    resolve(list()[0].id, value); expect(await pending).toEqual(value)
  })
  it.each(['messages', 'tools'] as const)('refuses BM25 same-event chunks outside the requested %s character cursor', async source => {
    const search = { query: 'blue', mode: 'bm25' as const, source, beforeMessage: 1, beforeCharacter: 10, ...(source === 'tools' ? { beforeEvent: 2 } : {}) }
    const pending = archive.search(scope, 71, lease, search)
    const match = source === 'tools' ? { messageIndex: 0, role: 'assistant' as const, eventIndex: 1, kind: 'tool_result' as const, toolIndex: 0, toolName: 'files.read', toolStatus: 'completed' as const, chunkStart: 100, score: 1, excerpt: 'blue' } : { messageIndex: 0, role: 'user' as const, eventIndex: 0, kind: 'message' as const, chunkStart: 100, score: 1, excerpt: 'blue' }
    const value: AgentArchiveSearchResult = { source: 'session_archive', mode: 'bm25', searchSource: source, ranking: 'scan-window-bm25', engine: 'unicode-bm25-scan', matches: [match], scannedMessages: 1, scannedEvents: 1, scannedCharacters: 10, totalMessages: 1, truncated: false, untrustedData: true, corpus: { documents: 1, tokens: 1, matchingDocuments: 1, omittedMatches: 0, scanComplete: true, documentUnit: '8192-character-chunks', k1: 1.2, b: 0.75 } }
    expect(() => resolve(list()[0].id, value)).toThrow('chunk cursor')
    expect(() => resolve(list()[0].id, { ...value, matches: [{ ...match, chunkStart: 10 }] })).toThrow('chunk cursor')
    resolve(list()[0].id, { ...value, matches: [{ ...match, chunkStart: 0 }] }); await pending
  })
  it('does not transfer BM25 event/character bounds onto a different message after message cursor clamping', async () => {
    const search = { query: 'blue', mode: 'bm25' as const, source: 'all' as const, beforeMessage: 10, beforeEvent: 1, beforeCharacter: 1 }
    const pending = archive.search(scope, 71, lease, search)
    const value: AgentArchiveSearchResult = { source: 'session_archive', mode: 'bm25', searchSource: 'all', ranking: 'scan-window-bm25', engine: 'unicode-bm25-scan', matches: [{ messageIndex: 0, role: 'assistant', kind: 'tool_result', eventIndex: 1, toolIndex: 0, toolName: 'files.read', toolStatus: 'failed', chunkStart: 50, score: 1, excerpt: 'blue' }], scannedMessages: 1, scannedEvents: 2, scannedCharacters: 100, totalMessages: 1, truncated: false, untrustedData: true, corpus: { documents: 1, tokens: 1, matchingDocuments: 1, omittedMatches: 0, scanComplete: true, documentUnit: '8192-character-chunks', k1: 1.2, b: 0.75 } }
    resolve(list()[0].id, value); expect(await pending).toEqual(value)
  })
  it.each(['messages', 'tools'] as const)('accepts actual partial BM25 %s scans when a stale message cursor discards its subordinate bounds', async source => {
    const { searchAgentSessionArchive } = await import('../../renderer/src/pages/ChatPage/agentArchiveSearch')
    const text = 'blue '.repeat(600000), messages: import('@shared/api/svcLLMProxy').ChatMessage[] = source === 'messages' ? [{ role: 'user', content: text }] : [{ role: 'assistant', content: '', toolHistory: [{ runId: 'r', toolCallId: 'c', toolName: 'files.read', args: {}, status: 'failed', content: text }] }]
    const search = { query: 'blue', mode: 'bm25' as const, source, beforeMessage: 10, beforeCharacter: 1, ...(source === 'tools' ? { beforeEvent: 1 } : {}) }
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { queueMicrotask(callback); return 1 }) as typeof setTimeout)
    let value!: AgentArchiveSearchResult
    try { value = await searchAgentSessionArchive(messages, search) } finally { timer.mockRestore() }
    expect(value.truncated).toBe(true); expect(value.nextBeforeMessage).toBe(1); expect(value.nextBeforeCharacter).toBeGreaterThan(1)
    const pending = archive.search(scope, 71, lease, search)
    resolve(list()[0].id, value); expect(await pending).toEqual(value)
    const continued = { ...search, beforeMessage: value.nextBeforeMessage, beforeCharacter: value.nextBeforeCharacter, ...(source === 'tools' ? { beforeEvent: value.nextBeforeEvent } : {}) }
    const next = archive.search(scope, 71, lease, continued)
    expect(() => resolve(list()[0].id, value)).toThrow('cursor')
    archive.resolve({ ...scope, queryId: list()[0].id, unavailable: true }, invocation('resolveAgentArchiveQuery')); await next
  })
  it('refuses event results for a default text-only request, including an old renderer mode mismatch', async () => {
    const pending = archive.search(scope, 71, lease, { query: 'old' })
    expect(() => resolve(list()[0].id, { ...result(), searchSource: 'tools', matches: [] })).toThrow('mode/source')
    resolve(list()[0].id); await pending
    const lexical = archive.search(scope, 71, lease, { query: 'old', mode: 'lexical' })
    expect(() => resolve(list()[0].id)).toThrow('mode/source')
    archive.resolve({ ...scope, queryId: list()[0].id, unavailable: true }, invocation('resolveAgentArchiveQuery'))
    expect(await lexical).toBeUndefined()
  })
  it('accepts a partial renderer event scan within the remaining lifetime after delayed delivery, then continues', async () => {
    const { searchAgentSessionArchive } = await import('../../renderer/src/pages/ChatPage/agentArchiveSearch')
    const messages: import('@shared/api/svcLLMProxy').ChatMessage[] = [{ role: 'assistant', content: '', toolHistory: Array.from({ length: 30000 }, (_, i) => ({ runId: 'r', toolCallId: String(i), toolName: 'files.read', args: {}, status: 'completed', content: '' })) }]
    const search = { query: 'missing', source: 'tools' as const }
    const pending = archive.search(scope, 71, lease, search), [query] = list()
    await vi.advanceTimersByTimeAsync(9400)
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { vi.setSystemTime(Date.now() + 4); queueMicrotask(callback); return 1 }) as typeof setTimeout)
    let first!: AgentArchiveSearchResult
    try { first = await searchAgentSessionArchive(messages, search, undefined, query.expiresAt) }
    finally { timer.mockRestore() }
    expect(first.truncated).toBe(true); expect(Date.now()).toBeLessThan(query.expiresAt)
    resolve(query.id, first); expect(await pending).toEqual(first)
    const continuation = { ...search, beforeMessage: first.nextBeforeMessage, beforeEvent: first.nextBeforeEvent, beforeCharacter: first.nextBeforeCharacter }
    const next = archive.search(scope, 71, lease, continuation), [nextQuery] = list()
    const fastTimer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { queueMicrotask(callback); return 1 }) as typeof setTimeout)
    try {
      const second = await searchAgentSessionArchive(messages, continuation, undefined, nextQuery.expiresAt)
      resolve(nextQuery.id, second); expect(await next).toEqual(second)
      expect(second.scannedEvents).toBeGreaterThan(0)
    } finally { fastTimer.mockRestore() }
  })
  it('rejects oversized/hidden/forged cursor fields and does not consume a valid query', async () => {
    const pending = archive.search(scope, 71, lease, { query: 'old', limit: 1, beforeMessage: 2 })
    const [query] = list()
    for (const value of [{ ...result(), hiddenContext: 'must not pass' }, { ...result(), matches: [{ messageIndex: 0, role: 'system', excerpt: 'hidden' }] }, { ...result(), matches: [{ messageIndex: 2, role: 'user', excerpt: 'wrong range' }] }, { ...result(), nextBeforeMessage: 2 }, { ...result(), matches: [{ messageIndex: 0, role: 'user', excerpt: 'x'.repeat(501) }] }]) expect(() => resolve(query.id, value as AgentArchiveSearchResult)).toThrow('Invalid')
    resolve(query.id); expect(await pending).toEqual(result())
  })
})
