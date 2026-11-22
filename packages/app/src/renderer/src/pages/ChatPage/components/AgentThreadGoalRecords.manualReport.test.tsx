import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGoalView } from '@shared/api/agentThreadGoal'
const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), list: vi.fn(), mutate: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { agentGoalScopeRevision: h.revision, setAgentGoalScope: h.bind, listAgentGoals: h.list, mutateAgentGoal: h.mutate } }) }))
import Host from './AgentThreadGoalRecordsHost'
import Panel from './AgentThreadGoalRecordsPanel'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const spec = { objective: 'Objective', successCriteria: [], constraints: [], autonomy: 'manual' as const, completionPolicy: 'user_confirm' as const, budgets: { maxTurns: 1, maxToolCalls: 1, maxWalltimeSeconds: 60 } }
const goal = (id: string, status: AgentGoalView['goals'][number]['status'] = 'active') => ({ id, title: id, generation: 2, status, spec, createdAt: 1, updatedAt: 1, reason: '' })
const view: AgentGoalView = { revision: 4, goals: [goal('A'), goal('B')], untrustedData: true, grantsPermission: false }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const props = { route, conversationId: 'fixture', active: true, remote: false }
beforeEach(() => { vi.clearAllMocks(); h.revision.mockReset().mockResolvedValue({ revision: 0 }); h.bind.mockReset().mockResolvedValue({ documentToken: 'token' }); h.list.mockReset().mockResolvedValue(view); h.mutate.mockReset() })
afterEach(async () => { cleanup(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) })
const fill = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } })
async function ready() { await screen.findByLabelText('Progress for A') }

describe('manual report candidate with fake service', () => {
  it('validates text and limits reportable statuses; old panel props remain usable', () => {
    const original = { view: { ...view, goals: [goal('A'), goal('B', 'waiting'), goal('C', 'blocked'), goal('D', 'paused')] }, pending: false, error: null, onCreate: vi.fn(), onControl: vi.fn() }
    const page = render(<Panel {...original} />)
    expect(screen.getByLabelText('Goal title')).toBeInTheDocument()
    page.rerender(<Panel {...original} onReport={vi.fn()} />)
    for (const id of ['A', 'B', 'C']) expect(screen.getByLabelText(`Progress for ${id}`)).toBeInTheDocument()
    expect(screen.queryByLabelText('Progress for D')).not.toBeInTheDocument()
    expect(screen.getAllByText(/replaces the current/)).toHaveLength(3)
    fill('Progress for A', '   '); expect(screen.getByRole('button', { name: 'Save progress for A' })).toBeDisabled()
    fill('Progress for A', 'a\0b'); expect(screen.getByRole('button', { name: 'Save progress for A' })).toBeDisabled()
  })
  it('uses scope and one operation, clears only acknowledged report and preserves create and other goal', async () => {
    const pending = deferred<unknown>(); h.mutate.mockReturnValue(pending.promise)
    render(<Host {...props} />); await ready(); fill('Progress for A', '  first  '); fill('Progress for B', 'other'); fill('Goal title', 'draft'); fill('Objective', 'draft objective')
    const button = screen.getByRole('button', { name: 'Save progress for A' }); fireEvent.click(button); fireEvent.click(button)
    expect(h.mutate).toHaveBeenCalledOnce(); expect(screen.getByLabelText('Progress for A')).toBeDisabled()
    const req = h.mutate.mock.calls[0][0]
    expect(req).toMatchObject({ route, conversationId: 'fixture', documentToken: 'token', action: 'report', goalId: 'A', summary: '  first  ', evidence: [], expectedRevision: 4, expectedGeneration: 2, operationId: expect.any(String) })
    await act(async () => pending.resolve({ ...view, revision: 5, status: 'applied', operationId: req.operationId }))
    await waitFor(() => expect(screen.getByLabelText('Progress for A')).toHaveValue(''))
    expect(screen.getByLabelText('Progress for B')).toHaveValue('other'); expect(screen.getByLabelText('Goal title')).toHaveValue('draft')
  })
  it('preserves report drafts on create success and preserves create on report and control', async () => {
    h.mutate.mockImplementation(async req => ({ ...view, revision: 5, status: 'applied', operationId: req.operationId }))
    render(<Host {...props} conversationId="create" />); await ready(); fill('Progress for A', 'keep'); fill('Goal title', 'title'); fill('Objective', 'text')
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
    await waitFor(() => expect(screen.getByLabelText('Goal title')).toHaveValue(''))
    expect(screen.getByLabelText('Progress for A')).toHaveValue('keep')
    fill('Goal title', 'next'); fireEvent.click(screen.getByRole('button', { name: 'Pause B' }))
    await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(2)); expect(screen.getByLabelText('Goal title')).toHaveValue('next'); expect(screen.getByLabelText('Progress for A')).toHaveValue('keep')
  })
  it('retains draft on unknown conflict until review without replay', async () => {
    h.mutate.mockResolvedValue({ status: 'retry-not-applied', priorOutcome: 'unknown', reason: 'revision-conflict' })
    render(<Host {...props} conversationId="unknown-report" />); await ready(); fill('Progress for A', 'preserve'); fireEvent.click(screen.getByRole('button', { name: 'Save progress for A' }))
    await screen.findByText(/Result unknown/); expect(screen.getByLabelText('Progress for A')).toHaveValue('preserve'); expect(h.list).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the goals' })); expect(h.mutate).toHaveBeenCalledOnce(); expect(screen.getByLabelText('Progress for A')).toHaveValue('preserve')
  })
  it('keeps B drafts when an old A report resolves applied after switching scope', async () => {
    const pending = deferred<unknown>(); h.mutate.mockReturnValue(pending.promise)
    const page = render(<Host {...props} conversationId="switch-a" />); await ready(); fill('Progress for A', 'old'); fireEvent.click(screen.getByRole('button', { name: 'Save progress for A' }))
    const req = h.mutate.mock.calls[0][0]
    page.rerender(<Host {...props} conversationId="switch-b" />); await ready(); fill('Progress for A', 'B report'); fill('Goal title', 'B create'); fill('Objective', 'B objective')
    const listCalls = h.list.mock.calls.length
    await act(async () => pending.resolve({ ...view, revision: 99, status: 'applied', operationId: req.operationId, goals: [goal('old result')] }))
    expect(screen.getByLabelText('Progress for A')).toHaveValue('B report'); expect(screen.getByLabelText('Goal title')).toHaveValue('B create'); expect(screen.getByLabelText('Objective')).toHaveValue('B objective')
    expect(screen.queryByText('old result')).not.toBeInTheDocument(); expect(h.mutate).toHaveBeenCalledOnce(); expect(h.list).toHaveBeenCalledTimes(listCalls)
  })
  it('waits for unresolved A mutation before listing a remounted A and requires review', async () => {
    const pending = deferred<unknown>(); h.mutate.mockReturnValue(pending.promise)
    const page = render(<Host {...props} conversationId="again-a" />); await ready(); fill('Progress for A', 'old scope draft'); fireEvent.click(screen.getByRole('button', { name: 'Save progress for A' }))
    const req = h.mutate.mock.calls[0][0]
    page.rerender(<Host {...props} conversationId="again-b" />); await ready()
    page.rerender(<Host {...props} conversationId="again-a" />)
    await waitFor(() => expect(h.bind.mock.calls.filter(([item]) => item.active && item.conversationId === 'again-a')).toHaveLength(2))
    expect(h.list).toHaveBeenCalledTimes(2)
    await act(async () => pending.resolve({ ...view, revision: 5, status: 'applied', operationId: req.operationId }))
    await screen.findByText(/Result unknown/); expect(h.list).toHaveBeenCalledTimes(3); expect(screen.getByLabelText('Progress for A')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'I reviewed the goals' })).toBeInTheDocument(); expect(h.mutate).toHaveBeenCalledOnce()
  })
  it('accepts two distinct applied reports for one goal and clears each matching draft', async () => {
    h.mutate.mockImplementation(async req => ({ ...view, revision: req.expectedRevision + 1, status: 'applied', operationId: req.operationId }))
    render(<Host {...props} conversationId="twice" />); await ready()
    for (const text of ['first', 'second']) { fill('Progress for A', text); fireEvent.click(screen.getByRole('button', { name: 'Save progress for A' })); await waitFor(() => expect(screen.getByLabelText('Progress for A')).toHaveValue('')) }
    expect(h.mutate).toHaveBeenCalledTimes(2); const [first, second] = h.mutate.mock.calls.map(call => call[0])
    expect(first).toMatchObject({ action: 'report', summary: 'first', expectedRevision: 4 }); expect(second).toMatchObject({ action: 'report', summary: 'second', expectedRevision: 5 }); expect(first.operationId).not.toBe(second.operationId)
  })
  it.each(['wrong-id', 'rejection'] as const)('keeps the report on %s, refreshes and waits for review', async mode => {
    if (mode === 'wrong-id') h.mutate.mockResolvedValue({ ...view, status: 'applied', operationId: 'wrong' })
    else h.mutate.mockRejectedValue(new Error('synthetic failure'))
    render(<Host {...props} conversationId={`failure-${mode}`} />); await ready(); fill('Progress for A', 'kept'); fireEvent.click(screen.getByRole('button', { name: 'Save progress for A' }))
    await screen.findByText(/Result unknown/); expect(h.list).toHaveBeenCalledTimes(2); expect(screen.getByLabelText('Progress for A')).toHaveValue('kept')
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the goals' })); expect(h.mutate).toHaveBeenCalledOnce(); expect(screen.getByLabelText('Progress for A')).toHaveValue('kept')
  })
  it('retains create and report drafts while create is pending and after unknown', async () => {
    const pending = deferred<unknown>(); h.mutate.mockReturnValue(pending.promise)
    render(<Host {...props} conversationId="create-unknown-report" />); await ready(); fill('Progress for A', 'report draft'); fill('Goal title', 'title'); fill('Objective', 'objective')
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
    expect(screen.getByLabelText('Goal title')).toBeDisabled(); expect(screen.getByLabelText('Objective')).toBeDisabled(); expect(screen.getByLabelText('Progress for A')).toBeDisabled()
    await act(async () => pending.resolve({ status: 'retry-not-applied', priorOutcome: 'unknown' }))
    await screen.findByText(/Result unknown/); expect(screen.getByLabelText('Goal title')).toHaveValue('title'); expect(screen.getByLabelText('Objective')).toHaveValue('objective'); expect(screen.getByLabelText('Progress for A')).toHaveValue('report draft')
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the goals' })); expect(h.mutate).toHaveBeenCalledOnce(); expect(screen.getByLabelText('Goal title')).toHaveValue('title'); expect(screen.getByLabelText('Progress for A')).toHaveValue('report draft')
  })
  it('consumes successive ack sequences and does not clear a changed draft', async () => {
    const base = { view, pending: false, error: null, onCreate: vi.fn(), onControl: vi.fn(), onReport: vi.fn() }
    const page = render(<Panel {...base} />); fill('Progress for A', 'newer')
    page.rerender(<Panel {...base} reportAck={{ sequence: 1, goalId: 'A', summary: 'older' }} />)
    await act(async () => {}); expect(screen.getByLabelText('Progress for A')).toHaveValue('newer')
    page.rerender(<Panel {...base} reportAck={{ sequence: 2, goalId: 'A', summary: 'newer' }} />)
    await waitFor(() => expect(screen.getByLabelText('Progress for A')).toHaveValue(''))
    fill('Progress for A', 'newer'); page.rerender(<Panel {...base} reportAck={{ sequence: 2, goalId: 'A', summary: 'newer' }} />)
    await act(async () => {}); expect(screen.getByLabelText('Progress for A')).toHaveValue('newer')
    page.rerender(<Panel {...base} reportAck={{ sequence: 3, goalId: 'A', summary: 'newer' }} />)
    await waitFor(() => expect(screen.getByLabelText('Progress for A')).toHaveValue(''))
  })
})
