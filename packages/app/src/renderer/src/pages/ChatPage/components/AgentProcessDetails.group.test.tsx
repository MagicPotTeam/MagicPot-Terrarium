import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProcessJob } from '@shared/api/agentThreadProcessJob'
import { AgentProcessDetails } from './AgentThreadProcessesPanel'

const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), stop: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({
  api: () => ({ svcLLMProxy: { listAgentProcesses: mocks.list, readAgentProcess: mocks.read, stopAgentProcess: mocks.stop } })
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'synthetic-scope', threadId: 'synthetic-thread' } as const
const scope = JSON.stringify({ route, conversationId: 'synthetic-chat' })
const job = (id: string): AgentProcessJob => ({
  id, kind: 'python', status: 'running', createdAt: 1, expiresAt: 60_000,
  outcome: 'unknown', stdoutBytes: 0, stderrBytes: 0, truncated: false,
  operationSettled: false, cancellationRequested: false
})
const groupName = (id: string, status = 'running', exit?: number) =>
  `python · chat.agent_process.status_${status} ${id}${exit === undefined ? '' : ` · exit=${exit}`}`

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset())
  mocks.read.mockResolvedValue({ data: '', nextCursor: 0, eof: true })
  mocks.stop.mockResolvedValue({})
})

describe('background process detail groups', () => {
  it('groups identical process kinds by existing status and ID and retains action targets across reorder', async () => {
    const first = job('first-process')
    const second = job('second-process')
    const rows = (items: AgentProcessJob[]) => items.map(item => <AgentProcessDetails key={item.id} job={item} scope={scope} />)
    const view = render(<>{rows([first, second])}</>)
    try {
      expect(mocks.list).not.toHaveBeenCalled()
      expect(mocks.read).not.toHaveBeenCalled()
      expect(mocks.stop).not.toHaveBeenCalled()
      const firstGroup = screen.getByRole('group', { name: groupName(first.id) })
      const secondGroup = screen.getByRole('group', { name: groupName(second.id) })
      expect(firstGroup).not.toBe(secondGroup)
      expect(screen.getAllByRole('group')).toEqual([firstGroup, secondGroup])
      await act(async () => {
        fireEvent.click(within(firstGroup).getByRole('button', { name: 'chat.agent_process.stdout' }))
        fireEvent.click(within(secondGroup).getByRole('button', { name: 'chat.agent_process.stop' }))
      })
      expect(mocks.read).toHaveBeenCalledWith({ route, conversationId: 'synthetic-chat', jobId: first.id, stream: 'stdout', cursor: 0, maxBytes: 16384 })
      expect(mocks.stop).toHaveBeenCalledWith({ route, conversationId: 'synthetic-chat', jobId: second.id })
      view.rerender(<>{rows([second, first])}</>)
      expect(screen.getAllByRole('group')).toEqual([secondGroup, firstGroup])
      await act(async () => {
        fireEvent.click(within(screen.getByRole('group', { name: groupName(first.id) })).getByRole('button', { name: 'chat.agent_process.stop' }))
        fireEvent.click(within(screen.getByRole('group', { name: groupName(second.id) })).getByRole('button', { name: 'chat.agent_process.stderr' }))
      })
      expect(mocks.stop.mock.calls).toEqual([
        [{ route, conversationId: 'synthetic-chat', jobId: second.id }],
        [{ route, conversationId: 'synthetic-chat', jobId: first.id }]
      ])
      expect(mocks.read.mock.calls).toEqual([
        [{ route, conversationId: 'synthetic-chat', jobId: first.id, stream: 'stdout', cursor: 0, maxBytes: 16384 }],
        [{ route, conversationId: 'synthetic-chat', jobId: second.id, stream: 'stderr', cursor: 0, maxBytes: 16384 }]
      ])
      expect(mocks.list).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('updates the group name with status and exit and keeps settled processes without a stop action', () => {
    const initial = job('stable-process')
    const view = render(<AgentProcessDetails job={initial} scope={scope} />)
    try {
      const group = screen.getByRole('group', { name: groupName(initial.id) })
      expect(within(group).getByRole('button', { name: 'chat.agent_process.stop' })).toBeEnabled()
      view.rerender(<AgentProcessDetails job={{ ...initial, status: 'completed', outcome: 'known', operationSettled: true, exitCode: 0 }} scope={scope} />)
      expect(screen.getByRole('group', { name: groupName(initial.id, 'completed', 0) })).toBe(group)
      expect(within(group).queryByRole('button', { name: 'chat.agent_process.stop' })).not.toBeInTheDocument()
      expect(within(group).getByRole('button', { name: 'chat.agent_process.stdout' })).toBeEnabled()
      expect(within(group).getByRole('button', { name: 'chat.agent_process.stderr' })).toBeEnabled()
      expect(mocks.list).not.toHaveBeenCalled()
      expect(mocks.read).not.toHaveBeenCalled()
      expect(mocks.stop).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
})
