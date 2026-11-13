import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGoalView } from '@shared/api/agentThreadGoal'

// Only the goal service is faked; no Electron, storage, scheduler or provider is used.
const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), list: vi.fn(), mutate: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { agentGoalScopeRevision: h.revision, setAgentGoalScope: h.bind, listAgentGoals: h.list, mutateAgentGoal: h.mutate } }) }))
import Host from './AgentThreadGoalRecordsHost'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'synthetic-project', threadId: 'synthetic-pane' } as const
const spec = { objective: 'Synthetic objective', successCriteria: [], constraints: [], autonomy: 'manual' as const, completionPolicy: 'user_confirm' as const, budgets: { maxTurns: 1, maxToolCalls: 1, maxWalltimeSeconds: 60 } }
const view: AgentGoalView = { revision: 4, goals: [{ id: 'goal', title: 'Synthetic goal', generation: 2, status: 'active', spec, createdAt: 1, updatedAt: 1, reason: '' }], untrustedData: true, grantsPermission: false }
const props = { route, active: true, remote: false }
const deferred = () => {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>(done => { resolve = done })
  return { promise, resolve }
}
const activeBindings = (conversationId: string) => h.bind.mock.calls.filter(([input]) => input.active && input.conversationId === conversationId).length
const lists = (conversationId: string) => h.list.mock.calls.filter(([input]) => input.conversationId === conversationId).length
const revisions = (conversationId: string) => h.revision.mock.calls.filter(([input]) => input.conversationId === conversationId).length

beforeEach(() => {
  h.revision.mockReset().mockResolvedValue({ revision: 0 })
  h.bind.mockReset().mockResolvedValue({ documentToken: 'synthetic-token' })
  h.list.mockReset().mockResolvedValue(view)
  h.mutate.mockReset()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network call')))
})
afterEach(async () => {
  cleanup()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  vi.unstubAllGlobals()
})

async function startReport() {
  await screen.findByLabelText('Progress for Synthetic goal')
  fireEvent.change(screen.getByLabelText('Progress for Synthetic goal'), { target: { value: 'Synthetic progress' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save progress for Synthetic goal' }))
  expect(h.mutate).toHaveBeenCalledOnce()
}

describe('goal binding serialization with a synthetic service', () => {
  it('loads a different scope while an earlier mutation is unresolved, if that scope was not remounted', async () => {
    const pending = deferred()
    h.mutate.mockReturnValue(pending.promise)
    const page = render(<Host {...props} conversationId="control-a" />)
    try {
      await startReport()
      page.rerender(<Host {...props} conversationId="control-c" />)
      await waitFor(() => expect(lists('control-c')).toBe(1))
      expect(lists('control-a')).toBe(1)
      expect(h.mutate).toHaveBeenCalledTimes(1)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await act(async () => { pending.resolve({ status: 'synthetic-settled' }); await pending.promise })
      page.unmount()
    }
  })

  it('delays C while remounted A waits for its unresolved mutation, then loads C without replay', async () => {
    const pending = deferred()
    h.mutate.mockReturnValue(pending.promise)
    const page = render(<Host {...props} conversationId="queue-a" />)
    try {
      await startReport()
      page.rerender(<Host {...props} conversationId="queue-b" />)
      await waitFor(() => expect(lists('queue-b')).toBe(1))
      page.rerender(<Host {...props} conversationId="queue-a" />)
      await waitFor(() => expect(activeBindings('queue-a')).toBe(2))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(lists('queue-a')).toBe(1)
      page.rerender(<Host {...props} conversationId="queue-c" />)
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
      expect(revisions('queue-c')).toBe(0)
      expect(lists('queue-c')).toBe(0)
      expect(h.mutate).toHaveBeenCalledTimes(1)
      await act(async () => { pending.resolve({ status: 'synthetic-settled' }); await pending.promise })
      await waitFor(() => expect(lists('queue-c')).toBe(1))
      expect(lists('queue-a')).toBe(1)
      expect(h.mutate).toHaveBeenCalledTimes(1)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await act(async () => { pending.resolve({ status: 'synthetic-settled' }); await pending.promise })
      page.unmount()
    }
  })
})
