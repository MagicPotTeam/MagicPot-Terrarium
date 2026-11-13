import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentTeamMenu from './AgentTeamMenu'
import type { ChatSession } from '../chatStorage'

describe('team task dispatch generated-name invisible collision', () => {
  it.each([
    ['zero-width space', '\u200b'],
    ['word joiner', '\u2060']
  ])('distinguishes a generated suffix from a crafted title containing %s', (_, invisible) => {
    const member: ChatSession = { id: 'member', title: 'Member', teamMemberName: 'writer', teamLeadId: 'lead', messages: [] }
    const crafted = `A${invisible}（当前列表第 1 项，位置随列表变化）`
    const titles = ['A', 'A', crafted]
    const tasks = titles.map((title, index) => ({ id: `task-${index}`, title, ownerId: member.id, status: 'pending' as const, dependsOn: [] as string[] }))
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: tasks }
    const onDispatch = vi.fn()
    const onSave = vi.fn<(value: ChatSession) => Promise<boolean>>().mockResolvedValue(true)
    const onEnd = vi.fn(), onBroadcast = vi.fn()
    const props = { lead, members: [member], models: [], onDispatch, onSave, onEnd, onBroadcast }
    const view = render(<AgentTeamMenu {...props} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      for (const [index, title] of titles.entries()) {
        const button = screen.getByRole('button', { name: `当前列表第 ${index + 1} 项（位置随列表变化），执行：${title}` })
        expect(button).toBeEnabled()
        expect(button.textContent).toBe('执行')
        fireEvent.click(button)
      }
      expect(onDispatch.mock.calls).toEqual([['task-0'], ['task-1'], ['task-2']])
      view.rerender(<AgentTeamMenu {...props} lead={{ ...lead, teamTasks: [tasks[1], tasks[0], tasks[2]] }} />)
      fireEvent.click(screen.getByRole('button', { name: '当前列表第 1 项（位置随列表变化），执行：A' }))
      expect(onDispatch).toHaveBeenLastCalledWith('task-1')
      expect(onSave).not.toHaveBeenCalled()
      expect(onEnd).not.toHaveBeenCalled()
      expect(onBroadcast).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
})
