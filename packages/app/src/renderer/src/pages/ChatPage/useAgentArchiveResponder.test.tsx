import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentArchiveQuery, AgentArchiveSearchResult } from '@shared/api/agentThreadMemory'
import type { ChatSession } from './chatStorage'
import { useAgentArchiveResponder } from './useAgentArchiveResponder'

const h = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn(), scan: vi.fn() }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { listAgentArchiveQueries: h.list, resolveAgentArchiveQuery: h.resolve } }) }))
vi.mock('./agentArchiveSearch', () => ({ searchAgentSessionArchive: h.scan }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const session: ChatSession = { id: 'conversation', title: 'Owned', messages: [{ role: 'user', content: 'live text' }], compactedMessages: [{ role: 'assistant', content: 'older retained text' }] }
const query = (): AgentArchiveQuery => ({ id: 'owned-query', expiresAt: Date.now() + 10000, search: { query: 'retained', mode: 'literal' } })
const result = (): AgentArchiveSearchResult => ({ source: 'session_archive', mode: 'literal', matches: [{ messageIndex: 0, role: 'assistant', excerpt: 'older retained text' }], scannedMessages: 2, scannedCharacters: 28, totalMessages: 2, truncated: false, untrustedData: true })
type Props = Parameters<typeof useAgentArchiveResponder>[0]
const props = (): Props => ({ route, session: structuredClone(session), storageScope: 'original-storage', active: true })
function View(input: Props) { useAgentArchiveResponder(input); return <output>Archive responder</output> }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }
beforeEach(() => {
  vi.clearAllMocks(); h.list.mockReset().mockResolvedValue({ queries: [query()] }); h.resolve.mockReset().mockResolvedValue({ ok: true }); h.scan.mockReset().mockResolvedValue(result())
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('selected current-conversation original archive responder', () => {
  it('scans only canonical retained+live objects, publishes one bounded result and changes no source', async () => {
    const input = props(), before = structuredClone(input.session)
    const page = render(<View {...input} />)
    await waitFor(() => expect(h.resolve).toHaveBeenCalledOnce())
    expect(h.list).toHaveBeenCalledWith({ route, conversationId: session.id })
    expect(h.scan).toHaveBeenCalledWith([...(input.session!.compactedMessages || []), ...input.session!.messages], expect.objectContaining({ query: 'retained' }), expect.any(AbortSignal), expect.any(Number))
    expect(h.resolve).toHaveBeenCalledWith({ route, conversationId: session.id, queryId: 'owned-query', result: result() })
    expect(input.session).toEqual(before)
    page.unmount()
  })
  it.each(['inactive', 'ordinary', 'unsafe-conversation', 'missing-session'] as const)('does not request an ineligible %s source', async mode => {
    const input = props()
    if (mode === 'inactive') input.active = false
    if (mode === 'ordinary') input.route = { ...route, channel: 'generic' }
    if (mode === 'unsafe-conversation') input.session = { ...session, id: '../other' }
    if (mode === 'missing-session') input.session = undefined
    render(<View {...input} />); await act(async () => {})
    expect(h.list).not.toHaveBeenCalled(); expect(h.scan).not.toHaveBeenCalled(); expect(h.resolve).not.toHaveBeenCalled()
  })
  it.each(['inactive', 'conversation', 'storage', 'unmount'] as const)('drops a delayed original query after %s without scanning another scope', async change => {
    const pending = deferred<{ queries: AgentArchiveQuery[] }>()
    h.list.mockImplementationOnce(() => pending.promise).mockResolvedValue({ queries: [] })
    const input = props(), page = render(<View {...input} />)
    await waitFor(() => expect(h.list).toHaveBeenCalledOnce())
    if (change === 'unmount') page.unmount()
    else page.rerender(<View {...input} active={change !== 'inactive'} storageScope={change === 'storage' ? 'new-storage' : input.storageScope} session={change === 'conversation' ? { ...session, id: 'sibling' } : input.session} />)
    await act(async () => { pending.resolve({ queries: [query()] }) })
    expect(h.scan).not.toHaveBeenCalled(); expect(h.resolve).not.toHaveBeenCalled()
  })
  it('aborts pending scan on Stop/inactivation and never publishes its late result or unavailable fallback', async () => {
    const pending = deferred<AgentArchiveSearchResult>(); h.scan.mockImplementationOnce(() => pending.promise)
    const input = props(), page = render(<View {...input} />)
    await waitFor(() => expect(h.scan).toHaveBeenCalledOnce())
    const signal: AbortSignal = h.scan.mock.calls[0][2]
    page.rerender(<View {...input} active={false} />)
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(result()) })
    expect(h.resolve).not.toHaveBeenCalled()
  })
  it('never publishes a discarded live suffix if the same conversation is edited while scanning', async () => {
    const pending = deferred<AgentArchiveSearchResult>(); h.scan.mockImplementationOnce(() => pending.promise)
    const input = props(), page = render(<View {...input} />)
    await waitFor(() => expect(h.scan).toHaveBeenCalledOnce())
    page.rerender(<View {...input} session={{ ...session, messages: [{ role: 'user', content: 'edited current branch; old suffix discarded' }] }} />)
    await act(async () => { pending.resolve(result()) })
    await waitFor(() => expect(h.resolve).toHaveBeenCalledWith({ route, conversationId: session.id, queryId: 'owned-query', unavailable: true }))
    expect(h.resolve).toHaveBeenCalledOnce()
  })

  it('marks old discarded compacted history as unavailable without fabricating original messages', async () => {
    const input = props()
    input.session = { ...session, compactedMessages: undefined, contextCompression: { summary: 'Old summary, not original evidence', coveredMessageCount: 9, sourceHash: 'old', estimatedSourceTokens: 100, estimatedSummaryTokens: 10, updatedAt: 1 } }
    h.scan.mockResolvedValue({ ...result(), matches: [], totalMessages: 1 })
    render(<View {...input} />)
    await waitFor(() => expect(h.resolve).toHaveBeenCalledOnce())
    expect(h.scan.mock.calls[0][0]).toEqual(session.messages)
    expect(h.resolve.mock.calls[0][0].result).toMatchObject({ matches: [], priorCompactionUnavailable: true, untrustedData: true })
  })
  it('reports scan failure as unavailable rather than a successful empty match set', async () => {
    h.scan.mockRejectedValueOnce(Error('scan deadline'))
    render(<View {...props()} />)
    await waitFor(() => expect(h.resolve).toHaveBeenCalledWith({ route, conversationId: session.id, queryId: 'owned-query', unavailable: true }))
    expect(h.resolve).toHaveBeenCalledOnce()
  })
  it('does not scan an invalid multi-query response or create a model/history fallback on IPC denial', async () => {
    h.list.mockResolvedValueOnce({ queries: [query(), { ...query(), id: 'other' }] })
    const page = render(<View {...props()} />); await act(async () => {})
    expect(h.scan).not.toHaveBeenCalled(); expect(h.resolve).not.toHaveBeenCalled(); page.unmount()
    h.list.mockRejectedValueOnce(Error('Denied'))
    render(<View {...props()} />); await act(async () => {})
    expect(h.scan).not.toHaveBeenCalled(); expect(h.resolve).not.toHaveBeenCalled()
  })
})
