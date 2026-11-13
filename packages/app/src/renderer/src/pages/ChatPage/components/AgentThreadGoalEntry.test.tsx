import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), list: vi.fn(), mutate: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { agentGoalScopeRevision: h.revision, setAgentGoalScope: h.bind, listAgentGoals: h.list, mutateAgentGoal: h.mutate } }) }))
import AgentThreadGoalEntry from './AgentThreadGoalEntry'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const empty = { revision: 0, goals: [], untrustedData: true, grantsPermission: false }
const props = { route, conversationId: 'first', active: true, remote: false }
beforeEach(() => { vi.clearAllMocks(); h.revision.mockResolvedValue({ revision: 0 }); h.bind.mockResolvedValue({ documentToken: 'token' }); h.list.mockResolvedValue(empty) })
afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 0)) })
describe('thread goal entry', () => {
  it('opens the real host for the current thread, and closes its binding', async () => {
    render(<AgentThreadGoalEntry {...props} />)
    expect(h.revision).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Goals' }))
    await screen.findByText('No goals yet.')
    expect(h.list).toHaveBeenCalledWith({ route, conversationId: 'first', documentToken: 'token' })
    fireEvent.click(screen.getByRole('button', { name: 'Close goals' }))
    expect(screen.queryByLabelText('Thread goals')).toBeNull()
    await waitFor(() => expect(h.bind).toHaveBeenCalledWith(expect.objectContaining({ route, conversationId: 'first', active: false })))
  })
  it('hides for remote, inactive or missing conversation and never binds these', async () => {
    const page = render(<AgentThreadGoalEntry {...props} remote />)
    page.rerender(<AgentThreadGoalEntry {...props} active={false} />)
    page.rerender(<AgentThreadGoalEntry {...props} conversationId={undefined} />)
    expect(screen.queryByRole('button', { name: 'Goals' })).toBeNull()
    expect(h.revision).not.toHaveBeenCalled()
  })
  it('does not show old thread records after switching conversation', async () => {
    const page = render(<AgentThreadGoalEntry {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Goals' }))
    await screen.findByText('No goals yet.')
    page.rerender(<AgentThreadGoalEntry {...props} conversationId="second" />)
    expect(screen.queryByLabelText('Thread goals')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Goals' }))
    await waitFor(() => expect(h.list).toHaveBeenCalledWith({ route, conversationId: 'second', documentToken: 'token' }))
  })
})
