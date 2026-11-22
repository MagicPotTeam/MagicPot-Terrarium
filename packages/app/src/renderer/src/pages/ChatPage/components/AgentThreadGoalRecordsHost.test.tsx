import React, { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), list: vi.fn(), mutate: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { agentGoalScopeRevision: h.revision, setAgentGoalScope: h.bind, listAgentGoals: h.list, mutateAgentGoal: h.mutate } }) }))
import AgentThreadGoalRecordsHost from './AgentThreadGoalRecordsHost'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const empty = { revision: 4, goals: [], untrustedData: true as const, grantsPermission: false as const }
const props = { route, conversationId: 'session', active: true, remote: false }
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => { vi.clearAllMocks(); h.revision.mockReset().mockResolvedValue({ revision: 20 }); h.bind.mockReset().mockResolvedValue({ documentToken: 'token' }); h.list.mockReset().mockResolvedValue(empty); h.mutate.mockReset() })
afterEach(async () => { cleanup(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) })
async function ready() { await waitFor(() => expect(screen.getByLabelText('Goal title')).not.toBeDisabled()) }
function fill() { fireEvent.change(screen.getByLabelText('Goal title'), { target: { value: 'Title' } }); fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Objective' } }) }
describe('manual thread goal binding host', () => {
  it('does not call service when remote or session missing', async () => {
    const page = render(<AgentThreadGoalRecordsHost {...props} remote />)
    page.rerender(<AgentThreadGoalRecordsHost {...props} conversationId={undefined} />)
    await act(async () => {}); expect(h.revision).not.toHaveBeenCalled()
  })
  it('binds, emits one create and clears only after matched applied response', async () => {
    const result = deferred<unknown>(); h.mutate.mockReturnValue(result.promise)
    render(<AgentThreadGoalRecordsHost {...props} />); await ready(); fill()
    const button = screen.getByRole('button', { name: 'Create draft' }); fireEvent.click(button); fireEvent.click(button)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    const req = h.mutate.mock.calls[0][0]
    expect(req).toMatchObject({ route, conversationId: 'session', documentToken: 'token', action: 'create', expectedRevision: 4, spec: { autonomy: 'manual', completionPolicy: 'user_confirm' } })
    expect(req.goalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(req.operationId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(screen.getByLabelText('Goal title')).toHaveValue('Title')
    await act(async () => { result.resolve({ ...empty, revision: 5, status: 'applied', operationId: req.operationId }) })
    await waitFor(() => expect(screen.getByLabelText('Goal title')).toHaveValue(''))
    expect(h.bind.mock.calls.filter(([r]) => r.active)).toHaveLength(1)
  })
  it('unknown result refreshes without replay and preserves draft until acknowledged', async () => {
    h.mutate.mockResolvedValue({ status: 'retry-not-applied', priorOutcome: 'unknown', operationId: 'unknown', reason: 'revision-conflict', currentRevision: 5 })
    render(<AgentThreadGoalRecordsHost {...props} conversationId="unknown" />); await ready(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
    await screen.findByText(/Result unknown/); expect(h.list).toHaveBeenCalledTimes(2); expect(h.mutate).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Goal title')).toHaveValue('Title'); expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the goals' })); expect(screen.getByRole('button', { name: 'Create draft' })).not.toBeDisabled()
  })
  it('ignores late old binding, scopes are serialized, and StrictMode works', async () => {
    const query = deferred<{ revision: number }>(); h.revision.mockReturnValueOnce(query.promise)
    const page = render(<StrictMode><AgentThreadGoalRecordsHost {...props} conversationId="old" /></StrictMode>)
    await waitFor(() => expect(h.revision).toHaveBeenCalled())
    page.rerender(<StrictMode><AgentThreadGoalRecordsHost {...props} conversationId="new" /></StrictMode>)
    await act(async () => { query.resolve({ revision: 20 }) }); await ready()
    expect(h.bind.mock.calls.some(([r]) => r.active && r.conversationId === 'old')).toBe(false)
    expect(h.bind).toHaveBeenCalledWith(expect.objectContaining({ active: true, conversationId: 'new' }))
  })
  it('uses latest view generation, revision and nonempty reason for control', async () => {
    const goal = { id: 'goal', generation: 7, title: 'goal', status: 'draft', spec: { objective: 'objective', successCriteria: [], constraints: [], autonomy: 'manual', completionPolicy: 'user_confirm', budgets: { maxTurns: 1, maxToolCalls: 1, maxWalltimeSeconds: 60 } }, createdAt: 1, updatedAt: 1, reason: '' }
    h.list.mockResolvedValue({ ...empty, revision: 9, goals: [goal] })
    h.mutate.mockImplementation(async req => ({ ...empty, revision: 10, status: 'applied', operationId: req.operationId }))
    render(<AgentThreadGoalRecordsHost {...props} conversationId="control" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Activate goal' }))
    await waitFor(() => expect(h.mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'control', goalId: 'goal', expectedGeneration: 7, expectedRevision: 9, status: 'active', reason: expect.stringMatching(/\S/), operationId: expect.any(String) })))
  })
  it('same scope remount waits for unresolved mutation before refresh and remains unknown', async () => {
    const result = deferred<unknown>(); h.mutate.mockReturnValue(result.promise)
    const page = render(<AgentThreadGoalRecordsHost {...props} conversationId="remount" />); await ready(); fill(); fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
    page.rerender(<AgentThreadGoalRecordsHost {...props} active={false} conversationId="remount" />)
    page.rerender(<AgentThreadGoalRecordsHost {...props} conversationId="remount" />)
    await waitFor(() => expect(h.bind.mock.calls.filter(([r]) => r.active)).toHaveLength(2))
    expect(h.list).toHaveBeenCalledTimes(1)
    await act(async () => { result.resolve({ status: 'retry-not-applied', priorOutcome: 'unknown' }) })
    await screen.findByText(/Result unknown/); await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2))
    expect(screen.getByLabelText('Goal title')).toHaveValue(''); expect(h.mutate).toHaveBeenCalledTimes(1)
  })
  it('prevents competing hosts from stealing the owner', async () => {
    const page = render(<><AgentThreadGoalRecordsHost {...props} conversationId="one" /><AgentThreadGoalRecordsHost {...props} conversationId="two" /></>)
    await screen.findByText('Another goal panel is active.')
    await waitFor(() => expect(h.bind).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'one', active: true })))
    expect(h.bind.mock.calls.some(([r]) => r.conversationId === 'two')).toBe(false); page.unmount()
  })
})
