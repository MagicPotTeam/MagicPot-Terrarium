import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGoalView } from '@shared/api/agentThreadGoal'

const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), list: vi.fn(), mutate: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { agentGoalScopeRevision: h.revision, setAgentGoalScope: h.bind, listAgentGoals: h.list, mutateAgentGoal: h.mutate } }) }))
import Entry from './AgentThreadGoalEntry'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'synthetic-project', threadId: 'synthetic-pane' } as const
const otherRoute = { ...route, threadId: 'other-pane' }
const empty: AgentGoalView = { revision: 0, goals: [], untrustedData: true, grantsPermission: false }
const old: AgentGoalView = { ...empty, revision: 1, goals: [{ id: 'old', title: 'Old synthetic goal', generation: 1, status: 'draft', spec: { objective: 'Old objective', successCriteria: [], constraints: [], autonomy: 'manual', completionPolicy: 'user_confirm', budgets: { maxTurns: 1, maxToolCalls: 1, maxWalltimeSeconds: 60 } }, createdAt: 1, updatedAt: 1, reason: '' }] }
const props = { route, conversationId: 'synthetic-a', active: true, remote: false }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

beforeEach(() => {
  vi.clearAllMocks()
  h.revision.mockReset().mockResolvedValue({ revision: 0 })
  h.bind.mockReset().mockResolvedValue({ documentToken: 'synthetic-token' })
  h.list.mockReset().mockResolvedValue(empty)
  h.mutate.mockReset()
})
afterEach(async () => { cleanup(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) })

describe('manual goal entry lifecycle with synthetic service', () => {
  it.each(['inactive', 'remote', 'route', 'conversation'] as const)('closes on %s change and requires explicit reopen', async mode => {
    const page = render(<Entry {...props} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Goals' }))
      await screen.findByText('No goals yet.')
      const changed = mode === 'inactive' ? { ...props, active: false } : mode === 'remote' ? { ...props, remote: true } : mode === 'route' ? { ...props, route: otherRoute } : { ...props, conversationId: 'synthetic-b' }
      page.rerender(<Entry {...changed} />)
      expect(screen.queryByLabelText('Thread goals')).not.toBeInTheDocument()
      if (mode === 'inactive' || mode === 'remote') expect(screen.queryByRole('button', { name: 'Goals' })).not.toBeInTheDocument()
      else expect(screen.getByRole('button', { name: 'Goals' })).toHaveAttribute('aria-expanded', 'false')
      await waitFor(() => expect(h.bind.mock.calls.some(([value]) => value.active === false && value.conversationId === 'synthetic-a')).toBe(true))
      expect(h.list).toHaveBeenCalledTimes(1)
      expect(h.bind.mock.calls.filter(([value]) => value.active)).toHaveLength(1)
      if (mode === 'inactive' || mode === 'remote') page.rerender(<Entry {...props} />)
      expect(screen.getByRole('button', { name: 'Goals' })).toHaveAttribute('aria-expanded', 'false')
      expect(h.list).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole('button', { name: 'Goals' }))
      await screen.findByText('No goals yet.')
      expect(h.list).toHaveBeenCalledTimes(2)
      expect(h.list.mock.calls[1][0]).toMatchObject({ route: changed.route, conversationId: changed.conversationId, documentToken: 'synthetic-token' })
      expect(h.mutate).not.toHaveBeenCalled()
    } finally { page.unmount(); await act(async () => {}) }
  })

  it('waits for old list to settle before serial binding, then ignores its late data', async () => {
    const gate = deferred<AgentGoalView>()
    h.list.mockReturnValueOnce(gate.promise).mockResolvedValue(empty)
    const page = render(<Entry {...props} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Goals' }))
      await waitFor(() => expect(h.list).toHaveBeenCalledOnce())
      page.rerender(<Entry {...props} conversationId="synthetic-b" />)
      expect(screen.queryByLabelText('Thread goals')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Goals' }))
      await act(async () => {})
      expect(h.bind.mock.calls.filter(([value]) => value.active)).toHaveLength(1)
      expect(h.list).toHaveBeenCalledOnce()
      await act(async () => gate.resolve(old))
      await screen.findByText('No goals yet.')
      expect(screen.queryByText('Old synthetic goal')).not.toBeInTheDocument()
      expect(h.list).toHaveBeenCalledTimes(2)
      expect(h.list.mock.calls[1][0]).toMatchObject({ conversationId: 'synthetic-b' })
      expect(h.mutate).not.toHaveBeenCalled()
    } finally { gate.resolve(old); page.unmount(); await act(async () => {}) }
  })
})
