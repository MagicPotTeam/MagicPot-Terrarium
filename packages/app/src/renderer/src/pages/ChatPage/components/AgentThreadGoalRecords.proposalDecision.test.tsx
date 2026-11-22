import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGoalView } from '@shared/api/agentThreadGoal'

const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), list: vi.fn(), mutate: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { agentGoalScopeRevision: h.revision, setAgentGoalScope: h.bind, listAgentGoals: h.list, mutateAgentGoal: h.mutate } }) }))
import Host from './AgentThreadGoalRecordsHost'
import Panel from './AgentThreadGoalRecordsPanel'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'synthetic-proposal-project', threadId: 'synthetic-pane' } as const
const props = { route, active: true, remote: false, conversationId: 'proposal-main' }
const spec = { objective: 'Synthetic objective', successCriteria: [], constraints: [], autonomy: 'manual' as const, completionPolicy: 'user_confirm' as const, budgets: { maxTurns: 1, maxToolCalls: 1, maxWalltimeSeconds: 60 } }
const literal = '<img src=x onerror=alert(1)>'
const evidence = 'https://invalid.example/synthetic-evidence'
const goal = (id: string, status: AgentGoalView['goals'][number]['status'], outcome: 'completed' | 'failed') => ({ id, title: id, status, generation: 3, spec, createdAt: 1, updatedAt: 2, reason: '', proposal: { outcome, summary: literal, evidence: [evidence], proposedAt: 2 } })
const base: AgentGoalView = { revision: 9, goals: [goal('A', 'active', 'completed'), goal('B', 'waiting', 'failed')], untrustedData: true, grantsPermission: false }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let current: AgentGoalView
beforeEach(() => {
  current = structuredClone(base)
  h.revision.mockReset().mockResolvedValue({ revision: 0 })
  h.bind.mockReset().mockResolvedValue({ documentToken: 'synthetic-token' })
  h.list.mockReset().mockImplementation(async () => structuredClone(current))
  h.mutate.mockReset()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error('Unexpected network')))
})
afterEach(async () => { cleanup(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); vi.unstubAllGlobals() })
const ready = async () => { await screen.findByRole('button', { name: 'Confirm completed for A' }) }

describe('explicit proposal decisions via real Host and Panel, synthetic service', () => {
  it('shows untrusted proposals as text without invoking a mutation', async () => {
    const page = render(<Host {...props} conversationId="proposal-display" />)
    try {
      await ready()
      expect(screen.getAllByText(literal).length).toBeGreaterThanOrEqual(2)
      expect(screen.getAllByText(evidence).length).toBeGreaterThanOrEqual(2)
      expect(screen.getByRole('button', { name: 'Confirm failed for B' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Reject proposal for A' })).toBeInTheDocument()
      expect(within(screen.getByRole('group', { name: 'A' })).getByText(/Pausing this goal removes its current proposal/)).toBeVisible()
      expect(page.container.querySelector('img')).toBeNull()
      expect(page.container.querySelector('a')).toBeNull()
      expect(h.mutate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it('binds each rendered decision to an immutable proposal snapshot', () => {
    const original = structuredClone(base)
    const decisions = vi.fn()
    const page = render(<Panel view={original} pending={false} error={null} onCreate={vi.fn()} onControl={vi.fn()} onDecision={decisions} />)
    try {
      const old = structuredClone(original.goals[0].proposal!)
      const button = screen.getByRole('button', { name: 'Confirm completed for A' })
      original.revision = 99
      original.goals[0].id = 'different-goal'
      original.goals[0].generation = 20
      original.goals[0].proposal!.summary = 'mutated after render'
      original.goals[0].proposal!.evidence[0] = 'changed after render'
      fireEvent.click(button)
      expect(decisions).toHaveBeenCalledExactlyOnceWith({ action: 'confirm', goalId: 'A', revision: 9, generation: 3, proposal: old })
    } finally { page.unmount() }
  })

  it('does not dispatch a stale displayed decision when the host view is mutated before rerender', async () => {
    const shared = structuredClone(base)
    h.list.mockImplementation(async () => shared)
    const page = render(<Host {...props} conversationId="proposal-stale-render" />)
    try {
      await ready()
      const button = screen.getByRole('button', { name: 'Confirm completed for A' })
      shared.revision = 10
      shared.goals[0].proposal = { ...shared.goals[0].proposal!, outcome: 'failed', summary: 'different proposal' }
      fireEvent.click(button)
      expect(h.mutate).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it('submits one confirm bound to the displayed revision and generation, locking buttons while pending', async () => {
    const gate = deferred<unknown>(); h.mutate.mockReturnValue(gate.promise)
    const page = render(<Host {...props} conversationId="proposal-confirm" />)
    try {
      await ready()
      const button = screen.getByRole('button', { name: 'Confirm completed for A' })
      fireEvent.click(button); fireEvent.click(button)
      expect(h.mutate).toHaveBeenCalledTimes(1)
      const req = h.mutate.mock.calls[0][0]
      expect(req).toEqual({ route, conversationId: 'proposal-confirm', documentToken: 'synthetic-token', action: 'confirm', outcome: 'completed', goalId: 'A', expectedRevision: 9, expectedGeneration: 3, operationId: expect.any(String) })
      expect(button).toBeDisabled(); expect(screen.getByRole('button', { name: 'Reject proposal for A' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Confirm failed for B' })).toBeDisabled()
      const terminal = { ...base, revision: 10, goals: [goal('A', 'completed', 'completed'), goal('B', 'waiting', 'failed')] }
      await act(async () => { gate.resolve({ ...terminal, status: 'applied', operationId: req.operationId }); await gate.promise })
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm completed for A' })).not.toBeInTheDocument())
      expect(screen.getAllByText(literal).length).toBeGreaterThanOrEqual(2)
      expect(within(screen.getByRole('group', { name: 'A' })).getByText(/This is the proposal retained after confirmation/)).toBeVisible()
      expect(h.mutate).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled()
    } finally { gate.resolve({ status: 'synthetic-cleanup' }); page.unmount(); await act(async () => { await gate.promise }) }
  })

  it('submits an explicit reject without an outcome', async () => {
    h.mutate.mockImplementation(async req => ({ ...base, revision: 10, status: 'applied', operationId: req.operationId, goals: [{ ...goal('A', 'active', 'completed'), proposal: undefined }, goal('B', 'waiting', 'failed')] }))
    const page = render(<Host {...props} conversationId="proposal-reject" />)
    try {
      await ready(); fireEvent.click(screen.getByRole('button', { name: 'Reject proposal for A' }))
      await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1))
      expect(h.mutate.mock.calls[0][0]).toEqual({ route, conversationId: 'proposal-reject', documentToken: 'synthetic-token', action: 'reject-proposal', goalId: 'A', expectedRevision: 9, expectedGeneration: 3, operationId: expect.any(String) })
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Reject proposal for A' })).not.toBeInTheDocument())
      expect(fetch).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it.each(['unknown', 'rejection', 'wrong-operation'] as const)('refreshes and requires review on %s without replay', async mode => {
    h.mutate.mockImplementation(async req => {
      if (mode === 'rejection') throw Error('Synthetic failure')
      if (mode === 'wrong-operation') return { ...base, status: 'applied', operationId: `${req.operationId}-wrong` }
      return { status: 'retry-not-applied', priorOutcome: 'unknown', operationId: req.operationId, reason: 'revision-conflict', currentRevision: 10 }
    })
    const page = render(<Host {...props} conversationId={`proposal-${mode}`} />)
    try {
      await ready(); fireEvent.click(screen.getByRole('button', { name: 'Confirm completed for A' }))
      expect(await screen.findByRole('button', { name: 'I reviewed the goals' })).toBeInTheDocument()
      expect(h.list).toHaveBeenCalledTimes(2); expect(h.mutate).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: 'Confirm completed for A' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'I reviewed the goals' }))
      expect(h.mutate).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it('does not let an old scope response alter the new scope view', async () => {
    const gate = deferred<unknown>(); h.mutate.mockReturnValue(gate.promise)
    const page = render(<Host {...props} conversationId="proposal-scope-old" />)
    try {
      await ready(); fireEvent.click(screen.getByRole('button', { name: 'Confirm completed for A' }))
      const req = h.mutate.mock.calls[0][0]
      current = { ...base, revision: 22, goals: [goal('B', 'waiting', 'failed')] }
      page.rerender(<Host {...props} conversationId="proposal-scope-new" />)
      await screen.findByRole('button', { name: 'Confirm failed for B' })
      await act(async () => { gate.resolve({ ...base, revision: 100, goals: [goal('OLD', 'active', 'completed')], status: 'applied', operationId: req.operationId }); await gate.promise })
      expect(screen.queryByText('OLD')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Confirm failed for B' })).toBeInTheDocument()
      expect(h.mutate).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled()
    } finally { gate.resolve({ status: 'synthetic-cleanup' }); page.unmount(); await act(async () => { await gate.promise }) }
  })
})
