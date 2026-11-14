import React, { useState } from 'react'
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), list: vi.fn(), mutate: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { agentGoalScopeRevision: h.revision, setAgentGoalScope: h.bind, listAgentGoals: h.list, mutateAgentGoal: h.mutate } }) }))
import GoalEntry from './AgentThreadGoalEntry'
type EntryProps = Omit<React.ComponentProps<typeof GoalEntry>, 'open' | 'onClose'>
/** Stands in for ChatPage: "/goal" opens the view, the view asks to be closed. */
function AgentThreadGoalEntry(props: EntryProps) {
  const [open, setOpen] = useState(false)
  return <><button onClick={() => setOpen(true)}>run /goal</button><GoalEntry {...props} open={open} onClose={() => setOpen(false)} /></>
}
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const empty = { revision: 0, goals: [], untrustedData: true, grantsPermission: false }
const props = { route, conversationId: 'first', active: true, remote: false }
beforeEach(() => { vi.clearAllMocks(); h.revision.mockResolvedValue({ revision: 0 }); h.bind.mockResolvedValue({ documentToken: 'token' }); h.list.mockResolvedValue(empty) })
afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 0)) })
describe('thread goal entry', () => {
  it('opens the real host for the current thread, and closes its binding', async () => {
    render(<AgentThreadGoalEntry {...props} />)
    expect(h.revision).not.toHaveBeenCalled()
    expect(screen.queryByTestId('agent-goal-view')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Goals' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'run /goal' }))
    await screen.findByText('No goals yet.')
    expect(h.list).toHaveBeenCalledWith({ route, conversationId: 'first', documentToken: 'token' })
    fireEvent.click(screen.getByRole('button', { name: 'Close goals' }))
    expect(screen.queryByLabelText('Thread goals')).toBeNull()
    await waitFor(() => expect(h.bind).toHaveBeenCalledWith(expect.objectContaining({ route, conversationId: 'first', active: false })))
  })
  it('reports a close by the person (button or Escape) as dismissed, and a stale close as not', async () => {
    const onClose = vi.fn()
    const page = render(<GoalEntry {...props} open onClose={onClose} />)
    await screen.findByText('No goals yet.')
    const view = screen.getByTestId('agent-goal-view')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close goals' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close goals' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenLastCalledWith(true)
    // Other keys, an input method's Escape and an Escape another handler consumed do not close.
    fireEvent.keyDown(view, { key: 'Enter' })
    fireEvent.keyDown(view, { key: 'Escape', isComposing: true })
    const consumed = createEvent.keyDown(view, { key: 'Escape' })
    consumed.preventDefault()
    fireEvent(view, consumed)
    expect(onClose).toHaveBeenCalledTimes(2)
    // The conversation changed under the open view: it asks to be closed, but nobody dismissed it.
    page.rerender(<GoalEntry {...props} conversationId="second" open onClose={onClose} />)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(3))
    expect(onClose).toHaveBeenLastCalledWith()
  })
  it('stays closed for remote, inactive or missing conversation and never binds these', async () => {
    const page = render(<AgentThreadGoalEntry {...props} remote />)
    fireEvent.click(screen.getByRole('button', { name: 'run /goal' }))
    page.rerender(<AgentThreadGoalEntry {...props} active={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'run /goal' }))
    page.rerender(<AgentThreadGoalEntry {...props} conversationId={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'run /goal' }))
    expect(screen.queryByTestId('agent-goal-view')).toBeNull()
    expect(h.revision).not.toHaveBeenCalled()
  })
  it('does not show old thread records after switching conversation', async () => {
    const page = render(<AgentThreadGoalEntry {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'run /goal' }))
    await screen.findByText('No goals yet.')
    page.rerender(<AgentThreadGoalEntry {...props} conversationId="second" />)
    expect(screen.queryByLabelText('Thread goals')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'run /goal' }))
    await waitFor(() => expect(h.list).toHaveBeenCalledWith({ route, conversationId: 'second', documentToken: 'token' }))
  })
})
