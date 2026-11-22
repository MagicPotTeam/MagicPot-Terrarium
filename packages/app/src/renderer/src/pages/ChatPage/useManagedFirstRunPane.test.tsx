import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRouteLike } from '@shared/agent'
import type { ManagedFirstRunPaneScope } from '@shared/api/agentThreadManagedFirstRun'

const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), chat: vi.fn(), start: vi.fn() }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { managedFirstRunPaneRevision: h.revision, setManagedFirstRunPaneScope: h.bind, chat: h.chat, startManagedFirstRun: h.start } }) }))
type Props = { route?: AgentRouteLike; conversationId?: string; active: boolean; boundaryKey?: string }
let usePane: (props: Props) => ManagedFirstRunPaneScope | undefined
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'thread' }
function View(props: Props) {
  const pane = usePane(props)
  return <output data-testid="pane">{pane ? JSON.stringify(pane) : 'unbound'}</output>
}
const props = (conversationId = 'conversation'): Props => ({ route, conversationId, active: true, boundaryKey: 'storage-a' })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }
const bound = async () => waitFor(() => expect(screen.getByTestId('pane')).not.toHaveTextContent('unbound'))
beforeEach(async () => {
  vi.clearAllMocks(); h.revision.mockReset().mockResolvedValue({ revision: 200 }); h.bind.mockReset().mockImplementation(async request => request.active ? { documentToken: `token-${request.lifecycleRevision}` } : {})
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const modulePath = './useManagedFirstRunPane'
  usePane = (await import(/* @vite-ignore */ modulePath)).useManagedFirstRunPane
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); expect(h.chat).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled() })

describe('dedicated original-pane identity lifecycle, no managed execution', () => {
  it('refreshes MAIN high water, binds only minimal identity DATA, and retires the exact revision on unmount', async () => {
    const view = render(<View {...props()} />); await bound()
    const active = h.bind.mock.calls[0][0]
    expect(active).toEqual({ route, conversationId: 'conversation', active: true, lifecycleRevision: expect.any(Number) })
    expect(active.lifecycleRevision).toBeGreaterThan(200)
    expect(h.revision).toHaveBeenCalledWith({ route, conversationId: 'conversation' })
    view.unmount(); expect(h.bind).toHaveBeenLastCalledWith({ ...active, active: false })
  })
  it.each(['inactive', 'missing-conversation', 'ordinary', 'unsafe-id'] as const)('never binds an ineligible %s pane', async mode => {
    const input = props()
    if (mode === 'inactive') input.active = false
    if (mode === 'missing-conversation') input.conversationId = undefined
    if (mode === 'ordinary') input.route = { ...route, channel: 'generic' }
    if (mode === 'unsafe-id') input.conversationId = 'unsafe/path'
    render(<View {...input} />); await act(async () => {})
    expect(h.revision).not.toHaveBeenCalled(); expect(h.bind).not.toHaveBeenCalled()
  })
  it('retires old conversation and storage-boundary identity before a fresh activation, with no catalog or history input', async () => {
    const view = render(<View {...props('a')} />); await bound()
    const original = h.bind.mock.calls.find(([req]) => req.active)![0]
    view.rerender(<View {...props('b')} />); await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('"conversationId":"b"'))
    expect(h.bind).toHaveBeenCalledWith({ ...original, active: false })
    const second = h.bind.mock.calls.find(([req]) => req.active && req.conversationId === 'b')![0]
    view.rerender(<View {...props('b')} boundaryKey="storage-b" />)
    await waitFor(() => expect(h.bind.mock.calls.filter(([req]) => req.active)).toHaveLength(3))
    expect(h.bind).toHaveBeenCalledWith({ ...second, active: false })
  })
  it('cannot activate an old conversation after a delayed revision response, including StrictMode cleanup', async () => {
    const pending = deferred<{ revision: number }>(); h.revision.mockImplementationOnce(() => pending.promise)
    const view = render(<View {...props('old')} />)
    view.rerender(<View {...props('new')} />); await bound()
    await act(async () => { pending.resolve({ revision: 900 }) })
    expect(h.bind.mock.calls.some(([req]) => req.active && req.conversationId === 'old')).toBe(false)
    view.unmount()
    render(<React.StrictMode><View {...props('strict')} /></React.StrictMode>); await bound()
    expect(h.bind.mock.calls.filter(([req]) => req.active && req.conversationId === 'strict')).toHaveLength(1)
  })
  it('re-retires a late activation acknowledgement without publishing or clearing the replacement pane', async () => {
    const pending = deferred<{ documentToken: string }>(); h.bind.mockImplementationOnce(() => pending.promise)
    const view = render(<View {...props('old')} />); await waitFor(() => expect(h.bind).toHaveBeenCalledOnce())
    const old = h.bind.mock.calls[0][0]
    view.rerender(<View {...props('new')} />); await bound()
    await act(async () => { pending.resolve({ documentToken: 'old-late-token' }) })
    expect(screen.getByTestId('pane')).not.toHaveTextContent('old-late-token')
    expect(screen.getByTestId('pane')).toHaveTextContent('"conversationId":"new"')
    expect(h.bind.mock.calls.filter(([req]) => req.lifecycleRevision === old.lifecycleRevision && !req.active)).toHaveLength(2)
  })
  it('synchronously retires on hidden/pagehide and creates a fresh identity only after visible/pageshow', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    const view = render(<View {...props()} />); await bound()
    const original = h.bind.mock.calls[0][0]
    act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
    expect(h.bind).toHaveBeenCalledWith({ ...original, active: false }); expect(screen.getByTestId('pane')).toHaveTextContent('unbound')
    act(() => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) }); await bound()
    const fresh = h.bind.mock.calls.findLast(([req]) => req.active)![0]
    expect(fresh.lifecycleRevision).toBeGreaterThan(original.lifecycleRevision)
    act(() => window.dispatchEvent(new Event('pagehide'))); expect(h.bind).toHaveBeenCalledWith({ ...fresh, active: false })
    act(() => window.dispatchEvent(new Event('pageshow'))); await bound()
    view.unmount()
  })
  it.each(['query', 'activation', 'missing-token', 'overflow'] as const)('fails closed on %s without retrying, falling back, or leaving acknowledged eligibility', async failure => {
    if (failure === 'query') h.revision.mockRejectedValueOnce(Error('unavailable'))
    if (failure === 'activation') h.bind.mockRejectedValueOnce(Error('uncertain'))
    if (failure === 'missing-token') h.bind.mockResolvedValueOnce({})
    if (failure === 'overflow') h.revision.mockResolvedValueOnce({ revision: Number.MAX_SAFE_INTEGER - 1 })
    render(<View {...props()} />)
    await waitFor(() => expect(h.revision).toHaveBeenCalledOnce()); await act(async () => {})
    expect(screen.getByTestId('pane')).toHaveTextContent('unbound')
    expect(h.bind.mock.calls.filter(([req]) => req.active)).toHaveLength(failure === 'query' || failure === 'overflow' ? 0 : 1)
    if (failure === 'activation' || failure === 'missing-token') expect(h.bind.mock.calls.some(([req]) => !req.active)).toBe(true)
    expect(h.revision).toHaveBeenCalledOnce()
  })
})
