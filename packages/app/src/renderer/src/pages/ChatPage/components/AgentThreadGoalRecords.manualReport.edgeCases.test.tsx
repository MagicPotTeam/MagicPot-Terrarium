import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGoalView } from '@shared/api/agentThreadGoal'

const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), list: vi.fn(), mutate: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { agentGoalScopeRevision: h.revision, setAgentGoalScope: h.bind, listAgentGoals: h.list, mutateAgentGoal: h.mutate } }) }))
import Host from './AgentThreadGoalRecordsHost'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const spec = { objective: 'Synthetic objective', successCriteria: [], constraints: [], autonomy: 'manual' as const, completionPolicy: 'user_confirm' as const, budgets: { maxTurns: 1, maxToolCalls: 1, maxWalltimeSeconds: 60 } }
const goal = (status: 'active' | 'waiting' | 'blocked') => ({ id: 'goal', title: 'Synthetic', generation: 7, status, spec, createdAt: 1, updatedAt: 1, reason: '' })
const view = (status: 'active' | 'waiting' | 'blocked' = 'active'): AgentGoalView => ({ revision: 9, goals: [goal(status)], untrustedData: true, grantsPermission: false })
const props = { route, conversationId: 'edge-fixture', active: true, remote: false }
const fill = (value: string) => fireEvent.change(screen.getByLabelText('Progress for Synthetic'), { target: { value } })
beforeEach(() => {
  vi.clearAllMocks()
  h.revision.mockReset().mockResolvedValue({ revision: 0 })
  h.bind.mockReset().mockResolvedValue({ documentToken: 'synthetic-token' })
  h.list.mockReset().mockResolvedValue(view())
  h.mutate.mockReset()
})
afterEach(async () => { cleanup(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) })

describe('manual report edge cases using real Host and synthetic service', () => {
  it.each(['waiting', 'blocked'] as const)('submits %s with the current scope, revision and generation', async status => {
    h.list.mockResolvedValue(view(status))
    h.mutate.mockImplementation(async request => ({ ...view(status), revision: 10, status: 'applied', operationId: request.operationId }))
    render(<Host {...props} conversationId={`edge-${status}`} />)
    await screen.findByLabelText('Progress for Synthetic')
    fill('Synthetic progress')
    fireEvent.click(screen.getByRole('button', { name: 'Save progress for Synthetic' }))
    expect(h.mutate).toHaveBeenCalledOnce()
    expect(h.mutate.mock.calls[0][0]).toMatchObject({ route, conversationId: `edge-${status}`, documentToken: 'synthetic-token', action: 'report', goalId: 'goal', expectedRevision: 9, expectedGeneration: 7, summary: 'Synthetic progress', evidence: [], operationId: expect.any(String) })
    await waitFor(() => expect(screen.getByLabelText('Progress for Synthetic')).toHaveValue(''))
  })
  it('retains the report across a failed unknown refresh and successful retry until review, without replay', async () => {
    h.list.mockResolvedValueOnce(view()).mockRejectedValueOnce(new Error('synthetic refresh failure')).mockResolvedValue(view())
    h.mutate.mockResolvedValue({ status: 'retry-not-applied', priorOutcome: 'unknown', reason: 'revision-conflict' })
    render(<Host {...props} conversationId="edge-refresh" />)
    await screen.findByLabelText('Progress for Synthetic')
    fill('Unsent draft')
    fireEvent.click(screen.getByRole('button', { name: 'Save progress for Synthetic' }))
    await screen.findByRole('button', { name: 'Retry loading goals' })
    expect(screen.queryByRole('button', { name: 'I reviewed the goals' })).not.toBeInTheDocument()
    expect(h.mutate).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading goals' }))
    await screen.findByRole('button', { name: 'I reviewed the goals' })
    expect(screen.getByLabelText('Progress for Synthetic')).toHaveValue('Unsent draft')
    expect(screen.getByRole('button', { name: 'Save progress for Synthetic' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the goals' }))
    expect(screen.getByLabelText('Progress for Synthetic')).toHaveValue('Unsent draft')
    expect(h.mutate).toHaveBeenCalledOnce()
  })
  it('accepts 2000 UTF-16 code units and rejects injected longer controlled values before service mutation', async () => {
    h.mutate.mockImplementation(async request => ({ ...view(), revision: 10, status: 'applied', operationId: request.operationId }))
    render(<Host {...props} conversationId="edge-utf16" />)
    await screen.findByLabelText('Progress for Synthetic')
    const input = screen.getByLabelText('Progress for Synthetic') as HTMLTextAreaElement
    const exact = '😀'.repeat(1000)
    fill(exact)
    expect(input.value.length).toBe(2000)
    expect(screen.getByRole('button', { name: 'Save progress for Synthetic' })).not.toBeDisabled()
    fill('😀'.repeat(1001))
    expect(input.value.length).toBe(2002)
    expect(screen.getByRole('button', { name: 'Save progress for Synthetic' })).toBeDisabled()
    fireEvent.submit(input.closest('form')!)
    expect(h.mutate).not.toHaveBeenCalled()
    fill(exact)
    fireEvent.click(screen.getByRole('button', { name: 'Save progress for Synthetic' }))
    expect(h.mutate).toHaveBeenCalledOnce()
    expect(h.mutate.mock.calls[0][0].summary).toBe(exact)
    await waitFor(() => expect(input).toHaveValue(''))
  })
})
