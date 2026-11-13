import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), list: vi.fn(), mutate: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { agentGoalScopeRevision: h.revision, setAgentGoalScope: h.bind, listAgentGoals: h.list, mutateAgentGoal: h.mutate } }) }))
import AgentThreadGoalRecordsHost from './AgentThreadGoalRecordsHost'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const props = { route, conversationId: 'session', active: true, remote: false }
const empty = { revision: 0, goals: [], untrustedData: true, grantsPermission: false }
beforeEach(() => { vi.clearAllMocks(); h.revision.mockReset().mockResolvedValue({ revision: 1 }); h.bind.mockReset().mockResolvedValue({ documentToken: 'token' }); h.list.mockReset(); h.mutate.mockReset() })
afterEach(async () => { cleanup(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) })
it('recovers a transient list failure without another click or mutation', async () => {
  h.list.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(empty)
  render(<AgentThreadGoalRecordsHost {...props} />)
  await screen.findByText('No goals yet.', {}, { timeout: 2000 })
  expect(h.list).toHaveBeenCalledTimes(2)
  expect(h.mutate).not.toHaveBeenCalled()
})
it('stops after thirteen failed reads and offers an explicit safe retry', async () => {
  h.list.mockRejectedValue(new Error('unavailable'))
  render(<AgentThreadGoalRecordsHost {...props} />)
  const retry = await screen.findByRole('button', { name: 'Retry loading goals' }, { timeout: 14000 })
  expect(screen.getByText('Goals unavailable.')).toBeInTheDocument()
  expect(h.list).toHaveBeenCalledTimes(13)
  expect(screen.queryByText('No goals yet.')).toBeNull()
  h.list.mockResolvedValue(empty)
  fireEvent.click(retry)
  await screen.findByText('No goals yet.')
  expect(h.list).toHaveBeenCalledTimes(14)
  expect(h.mutate).not.toHaveBeenCalled()
}, 16000)
it('cancels pending retry on unmount and switching scopes', async () => {
  h.list.mockImplementation(async ({ conversationId }) => { if (conversationId === 'old') throw Error('unavailable'); return empty })
  const page = render(<AgentThreadGoalRecordsHost {...props} conversationId="old" />)
  await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1))
  page.rerender(<AgentThreadGoalRecordsHost {...props} conversationId="new" />)
  await screen.findByText('No goals yet.')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)) })
  expect(h.list.mock.calls.filter(([req]) => req.conversationId === 'old')).toHaveLength(1)
  page.unmount()
})
it('late old read cannot overwrite new scope', async () => {
  let resolveOld!: (value: unknown) => void
  h.list.mockImplementation(({ conversationId }) => conversationId === 'old' ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(empty))
  const page = render(<AgentThreadGoalRecordsHost {...props} conversationId="old" />)
  await waitFor(() => expect(h.list).toHaveBeenCalledTimes(1))
  page.rerender(<AgentThreadGoalRecordsHost {...props} conversationId="new" />)
  await act(async () => resolveOld({ ...empty, goals: [{ id: 'old', title: 'OLD', status: 'draft', spec: { objective: 'old' } }] }))
  await screen.findByText('No goals yet.')
  expect(screen.queryByText('OLD')).toBeNull()
})
it('failed mutation is not replayed by load retries or explicit reload', async () => {
  h.list.mockResolvedValueOnce(empty).mockRejectedValue(new Error('unavailable'))
  h.mutate.mockRejectedValue(Error('unknown'))
  render(<AgentThreadGoalRecordsHost {...props} />)
  await screen.findByText('No goals yet.')
  fireEvent.change(screen.getByLabelText('Goal title'), { target: { value: 'Title' } })
  fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Objective' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
  const retry = await screen.findByRole('button', { name: 'Retry loading goals' })
  h.list.mockResolvedValue(empty)
  fireEvent.click(retry)
  await screen.findByRole('button', { name: 'I reviewed the goals' })
  expect(h.mutate).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled()
})
