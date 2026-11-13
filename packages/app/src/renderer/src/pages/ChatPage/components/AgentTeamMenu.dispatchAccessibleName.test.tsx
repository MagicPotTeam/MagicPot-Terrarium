import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentTeamMenu from './AgentTeamMenu'
import type { ChatSession } from '../chatStorage'

describe('team task dispatch accessible names', () => {
  it('distinguishes duplicate names and dispatches the selected id after reorder', () => {
    const member: ChatSession = { id: 'member', title: 'Member', teamMemberName: 'writer', teamLeadId: 'lead', messages: [] }
    const tasks = [
      { id: 'a', title: '同名', ownerId: 'member', status: 'pending' as const, dependsOn: [] },
      { id: 'b', title: '同名', ownerId: 'member', status: 'pending' as const, dependsOn: [] },
      { id: 'c', title: '单项', ownerId: 'member', status: 'pending' as const, dependsOn: [] },
      { id: 'd', title: '等待', ownerId: 'member', status: 'pending' as const, dependsOn: ['c'] }
    ]
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: tasks }
    const onDispatch = vi.fn(), onSave = vi.fn(), onEnd = vi.fn(), onBroadcast = vi.fn()
    const props = { lead, members: [member], models: [], onDispatch, onSave, onEnd, onBroadcast }
    const view = render(<AgentTeamMenu {...props} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      const first = screen.getByRole('button', { name: '执行 同名（当前列表第 1 项，位置随列表变化）' })
      const second = screen.getByRole('button', { name: '执行 同名（当前列表第 2 项，位置随列表变化）' })
      expect(first).toBeEnabled(); expect(second).toBeEnabled()
      expect(screen.getByRole('button', { name: '执行 单项' })).toBeEnabled()
      const blocked = screen.getByRole('button', { name: '执行 等待' })
      expect(blocked).toBeDisabled(); fireEvent.click(blocked)
      expect(onDispatch).not.toHaveBeenCalled()
      fireEvent.click(first); fireEvent.click(second)
      expect(onDispatch.mock.calls).toEqual([['a'], ['b']])
      view.rerender(<AgentTeamMenu {...props} lead={{ ...lead, teamTasks: [tasks[1], tasks[0], ...tasks.slice(2)] }} />)
      fireEvent.click(screen.getByRole('button', { name: '执行 同名（当前列表第 1 项，位置随列表变化）' }))
      fireEvent.click(screen.getByRole('button', { name: '执行 同名（当前列表第 2 项，位置随列表变化）' }))
      expect(onDispatch.mock.calls).toEqual([['a'], ['b'], ['b'], ['a']])
      expect(onSave).not.toHaveBeenCalled(); expect(onEnd).not.toHaveBeenCalled(); expect(onBroadcast).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('avoids a crafted unique title colliding with a disambiguated name', () => {
    const member: ChatSession = { id: 'member', title: 'Member', teamMemberName: 'writer', teamLeadId: 'lead', messages: [] }
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: [
      { id: 'a', title: '同名', ownerId: 'member', status: 'pending', dependsOn: [] },
      { id: 'b', title: '同名', ownerId: 'member', status: 'pending', dependsOn: [] },
      { id: 'c', title: '同名（当前列表第 1 项，位置随列表变化）', ownerId: 'member', status: 'pending', dependsOn: [] }
    ] }
    const onDispatch = vi.fn()
    const view = render(<AgentTeamMenu lead={lead} members={[member]} models={[]} onDispatch={onDispatch} onSave={vi.fn()} onEnd={vi.fn()} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      fireEvent.click(screen.getByRole('button', { name: '当前列表第 1 项（位置随列表变化），执行：同名' }))
      fireEvent.click(screen.getByRole('button', { name: '当前列表第 2 项（位置随列表变化），执行：同名' }))
      fireEvent.click(screen.getByRole('button', { name: '当前列表第 3 项（位置随列表变化），执行：同名（当前列表第 1 项，位置随列表变化）' }))
      expect(onDispatch.mock.calls).toEqual([['a'], ['b'], ['c']])
    } finally { view.unmount() }
  })

  it('uses leading positions when a crafted collision title is itself duplicated', () => {
    const member: ChatSession = { id: 'member', title: 'Member', teamMemberName: 'writer', teamLeadId: 'lead', messages: [] }
    const titles = ['A', 'A', 'A（当前列表第 1 项，位置随列表变化）', 'A（当前列表第 1 项，位置随列表变化）']
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: titles.map((title, i) => ({ id: `t${i}`, title, ownerId: 'member', status: 'pending', dependsOn: [] })) }
    const onDispatch = vi.fn()
    const view = render(<AgentTeamMenu lead={lead} members={[member]} models={[]} onDispatch={onDispatch} onSave={vi.fn()} onEnd={vi.fn()} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      for (let i = 0; i < titles.length; i++) {
        fireEvent.click(screen.getByRole('button', { name: `当前列表第 ${i + 1} 项（位置随列表变化），执行：${titles[i]}` }))
      }
      expect(onDispatch.mock.calls).toEqual([['t0'], ['t1'], ['t2'], ['t3']])
    } finally { view.unmount() }
  })

  it('puts the trusted list position before a title with bidi controls', () => {
    const member: ChatSession = { id: 'member', title: 'Member', teamMemberName: 'writer', teamLeadId: 'lead', messages: [] }
    const title = '审核\u202e'
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: [
      { id: 'a', title, ownerId: 'member', status: 'pending', dependsOn: [] },
      { id: 'b', title, ownerId: 'member', status: 'pending', dependsOn: [] }
    ] }
    const onDispatch = vi.fn()
    const view = render(<AgentTeamMenu lead={lead} members={[member]} models={[]} onDispatch={onDispatch} onSave={vi.fn()} onEnd={vi.fn()} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      for (const [i, id] of ['a', 'b'].entries()) {
        const button = screen.getByRole('button', { name: `当前列表第 ${i + 1} 项（位置随列表变化），执行：${title}` })
        expect(button.getAttribute('aria-label')).toBe(`当前列表第 ${i + 1} 项（位置随列表变化），执行：${title}`)
        fireEvent.click(button)
        expect(onDispatch).toHaveBeenLastCalledWith(id)
      }
    } finally { view.unmount() }
  })

  it('continues to reject an invalid task graph before preparing names', () => {
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: [
      { id: 'a', title: 7 as unknown as string, ownerId: '', status: 'pending', dependsOn: [] }
    ] }
    const onDispatch = vi.fn(), onSave = vi.fn()
    const view = render(<AgentTeamMenu lead={lead} members={[]} models={[]} onDispatch={onDispatch} onSave={onSave} onEnd={vi.fn()} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      expect(screen.getByText('任务依赖无效')).toBeVisible()
      expect(screen.queryByRole('button', { name: /^执行 / })).not.toBeInTheDocument()
      expect(onDispatch).not.toHaveBeenCalled(); expect(onSave).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('distinguishes titles that normalize to the same accessible name', () => {
    const member: ChatSession = { id: 'member', title: 'Member', teamMemberName: 'writer', teamLeadId: 'lead', messages: [] }
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: [
      { id: 'a', title: '检查  项目', ownerId: 'member', status: 'pending', dependsOn: [] },
      { id: 'b', title: '检查 项目', ownerId: 'member', status: 'pending', dependsOn: [] }
    ] }
    const onDispatch = vi.fn()
    const view = render(<AgentTeamMenu lead={lead} members={[member]} models={[]} onDispatch={onDispatch} onSave={vi.fn()} onEnd={vi.fn()} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      fireEvent.click(screen.getByRole('button', { name: '执行 检查 项目（当前列表第 1 项，位置随列表变化）' }))
      fireEvent.click(screen.getByRole('button', { name: '执行 检查 项目（当前列表第 2 项，位置随列表变化）' }))
      expect(onDispatch.mock.calls).toEqual([['a'], ['b']])
    } finally { view.unmount() }
  })
})
