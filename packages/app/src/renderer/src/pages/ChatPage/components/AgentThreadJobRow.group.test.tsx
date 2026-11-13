import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentThreadJob } from '@shared/api/agentThreadJob'
import { AgentThreadJobRow, type AgentThreadJobsController } from './AgentThreadJobsPanel'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const job = (id: string, status: AgentThreadJob['status'] = 'running'): AgentThreadJob => ({
  id, kind: 'explore', task: 'Inspect example', status, createdAt: 1, expiresAt: 60_000
})

function controller(): AgentThreadJobsController {
  return {
    jobs: [], error: false, scopeKey: 'synthetic',
    read: vi.fn(async () => undefined), stop: vi.fn(async () => false)
  }
}

const groupName = (id: string, status = 'running') => `explore: Inspect example chat.agent_jobs.status_${status} · ${id}`

describe('background helper detail groups', () => {
  it('groups each identical task by its existing visible task, status and ID and preserves action targets after reorder', async () => {
    const actions = controller()
    const first = job('first-id')
    const second = job('second-id')
    const rows = (items: AgentThreadJob[]) => items.map(item => <AgentThreadJobRow key={item.id} job={item} controller={actions} />)
    const view = render(<>{rows([first, second])}</>)
    try {
      expect(actions.read).not.toHaveBeenCalled()
      expect(actions.stop).not.toHaveBeenCalled()
      const firstGroup = screen.getByRole('group', { name: groupName('first-id') })
      const secondGroup = screen.getByRole('group', { name: groupName('second-id') })
      expect(firstGroup).not.toBe(secondGroup)
      expect(screen.getAllByRole('group')).toEqual([firstGroup, secondGroup])
      await act(async () => {
        fireEvent.click(within(firstGroup).getByRole('button', { name: 'chat.agent_jobs.read' }))
        fireEvent.click(within(secondGroup).getByRole('button', { name: 'chat.agent_jobs.stop' }))
      })
      expect(actions.read).toHaveBeenCalledWith('first-id', 0)
      expect(actions.stop).toHaveBeenCalledWith('second-id')
      view.rerender(<>{rows([second, first])}</>)
      expect(screen.getAllByRole('group')).toEqual([secondGroup, firstGroup])
      await act(async () => {
        fireEvent.click(within(screen.getByRole('group', { name: groupName('first-id') })).getByRole('button', { name: 'chat.agent_jobs.stop' }))
        fireEvent.click(within(screen.getByRole('group', { name: groupName('second-id') })).getByRole('button', { name: 'chat.agent_jobs.read' }))
      })
      expect(vi.mocked(actions.stop).mock.calls).toEqual([['second-id'], ['first-id']])
      expect(vi.mocked(actions.read).mock.calls).toEqual([['first-id', 0], ['second-id', 0]])
    } finally { view.unmount() }
  })

  it('updates the group name with status and keeps completed jobs without a stop button', () => {
    const actions = controller()
    const view = render(<AgentThreadJobRow job={job('job-id')} controller={actions} />)
    try {
      const group = screen.getByRole('group', { name: groupName('job-id') })
      expect(within(group).getByRole('button', { name: 'chat.agent_jobs.stop' })).toBeEnabled()
      view.rerender(<AgentThreadJobRow job={job('job-id', 'completed')} controller={actions} />)
      expect(screen.getByRole('group', { name: groupName('job-id', 'completed') })).toBe(group)
      expect(within(group).queryByRole('button', { name: 'chat.agent_jobs.stop' })).not.toBeInTheDocument()
      expect(within(group).getByRole('button', { name: 'chat.agent_jobs.read' })).toBeEnabled()
      expect(actions.read).not.toHaveBeenCalled()
      expect(actions.stop).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
})
