import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentTeamMenu from './AgentTeamMenu'
import type { ChatSession } from '../chatStorage'

describe('team task invisible name collisions', () => {
  it.each([
    ['zero-width space', '\u200b'],
    ['word joiner', '\u2060']
  ])('distinguishes visually similar titles containing %s without changing their dispatch ids', (_, invisible) => {
    const member: ChatSession = { id: 'member', title: 'Member', teamMemberName: 'writer', teamLeadId: 'lead', messages: [] }
    const titles = ['AB', `A${invisible}B`, '单项']
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
      fireEvent.click(screen.getByRole('button', { name: `当前列表第 1 项（位置随列表变化），执行：${titles[1]}` }))
      expect(onDispatch).toHaveBeenLastCalledWith('task-1')
      expect(onSave).not.toHaveBeenCalled()
      expect(onEnd).not.toHaveBeenCalled()
      expect(onBroadcast).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('uses the existing dependency position names and saves the selected prerequisite id', () => {
    const titles = ['AB', 'A\u200bB']
    const tasks = titles.map((title, index) => ({ id: `task-${index}`, title, ownerId: '', status: 'pending' as const, dependsOn: [] as string[] }))
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: tasks }
    const onSave = vi.fn<(value: ChatSession) => Promise<boolean>>().mockResolvedValue(true)
    const onDispatch = vi.fn(), onEnd = vi.fn()
    const view = render(<AgentTeamMenu lead={lead} members={[]} models={[]} onDispatch={onDispatch} onSave={onSave} onEnd={onEnd} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      const summary = screen.getByText('编辑依赖 · AB', { selector: 'summary' })
      expect(summary).toHaveAttribute('aria-label', '当前列表第 1 项（位置随列表变化），编辑依赖 · AB')
      fireEvent.click(summary)
      expect(screen.getByRole('checkbox', { name: '第 1 项任务依赖第 2 项（位置随列表变化）：AB 依赖 A\u200bB' })).toBeEnabled()
      fireEvent.change(screen.getByLabelText('任务'), { target: { value: '新任务' } })
      fireEvent.click(screen.getByRole('checkbox', { name: '新任务的前置：当前列表第 2 项（位置随列表变化），A\u200bB' }))
      fireEvent.click(screen.getByRole('button', { name: '添加任务' }))
      expect(onSave).toHaveBeenCalledTimes(1)
      expect(onSave.mock.calls[0][0].teamTasks).toEqual([...tasks, expect.objectContaining({ title: '新任务', dependsOn: ['task-1'] })])
      expect(onDispatch).not.toHaveBeenCalled()
      expect(onEnd).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it.each([
    ['zero-width space', '\u200b'],
    ['word joiner', '\u2060']
  ])('distinguishes an existing dependency from a similar new prerequisite containing %s', (_, invisible) => {
    const titles = ['A', 'B', `A${invisible} 依赖 B`]
    const tasks = titles.map((title, index) => ({ id: `task-${index}`, title, ownerId: '', status: 'pending' as const, dependsOn: [] as string[] }))
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: tasks }
    const onSave = vi.fn<(value: ChatSession) => Promise<boolean>>().mockResolvedValue(true)
    const onDispatch = vi.fn(), onEnd = vi.fn()
    const view = render(<AgentTeamMenu lead={lead} members={[]} models={[]} onDispatch={onDispatch} onSave={onSave} onEnd={onEnd} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      fireEvent.click(screen.getByText('编辑依赖 · A', { selector: 'summary' }))
      const existing = screen.getByRole('checkbox', { name: '第 1 项任务依赖第 2 项（位置随列表变化）：A 依赖 B' })
      const prerequisite = screen.getByRole('checkbox', { name: `新任务的前置：当前列表第 3 项（位置随列表变化），${titles[2]}` })
      expect(existing).toBeEnabled()
      expect(prerequisite).toBeEnabled()
      expect(existing).not.toBe(prerequisite)
      expect(screen.getByRole('button', { name: '执行 A' })).toBeDisabled()
      fireEvent.click(existing)
      expect(onSave).toHaveBeenCalledTimes(1)
      expect(onSave.mock.calls[0][0].teamTasks).toEqual([{ ...tasks[0], dependsOn: ['task-1'] }, tasks[1], tasks[2]])
      expect(onDispatch).not.toHaveBeenCalled()
      expect(onEnd).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('distinguishes two composite dependency names whose titles only differ after combination', () => {
    const titles = ['A\u200b', 'B 依赖 C', 'A 依赖 B', 'C']
    const tasks = titles.map((title, index) => ({ id: `task-${index}`, title, ownerId: '', status: 'pending' as const, dependsOn: [] as string[] }))
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: tasks }
    const onSave = vi.fn<(value: ChatSession) => Promise<boolean>>().mockResolvedValue(true)
    const view = render(<AgentTeamMenu lead={lead} members={[]} models={[]} onSave={onSave} onEnd={vi.fn()} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      fireEvent.click(screen.getByText('编辑依赖 · A\u200b', { selector: 'summary' }))
      fireEvent.click(screen.getByText('编辑依赖 · A 依赖 B', { selector: 'summary' }))
      const first = screen.getByRole('checkbox', { name: '第 1 项任务依赖第 2 项（位置随列表变化）：A\u200b 依赖 B 依赖 C' })
      const second = screen.getByRole('checkbox', { name: '第 3 项任务依赖第 4 项（位置随列表变化）：A 依赖 B 依赖 C' })
      expect(first).not.toBe(second)
      fireEvent.click(second)
      expect(onSave).toHaveBeenCalledTimes(1)
      expect(onSave.mock.calls[0][0].teamTasks).toEqual([tasks[0], tasks[1], { ...tasks[2], dependsOn: ['task-3'] }, tasks[3]])
    } finally { view.unmount() }
  })

  it('keeps unique titles containing an invisible character on the existing name path', () => {
    const member: ChatSession = { id: 'member', title: 'Member', teamMemberName: 'writer', teamLeadId: 'lead', messages: [] }
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: [
      { id: 'unique', title: 'only\u200bname', ownerId: member.id, status: 'pending', dependsOn: [] },
      { id: 'other', title: 'other', ownerId: member.id, status: 'pending', dependsOn: [] }
    ] }
    const onDispatch = vi.fn()
    const view = render(<AgentTeamMenu lead={lead} members={[member]} models={[]} onDispatch={onDispatch} onSave={vi.fn<(value: ChatSession) => Promise<boolean>>().mockResolvedValue(true)} onEnd={vi.fn()} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      fireEvent.click(screen.getByRole('button', { name: '执行 only\u200bname' }))
      fireEvent.click(screen.getByRole('button', { name: '执行 other' }))
      expect(onDispatch.mock.calls).toEqual([['unique'], ['other']])
    } finally { view.unmount() }
  })
})
