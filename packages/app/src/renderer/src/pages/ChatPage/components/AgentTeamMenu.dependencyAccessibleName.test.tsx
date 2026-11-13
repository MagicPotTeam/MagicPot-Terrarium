import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentTeamMenu from './AgentTeamMenu'
import type { ChatSession } from '../chatStorage'

const base = (tasks: NonNullable<ChatSession['teamTasks']>): ChatSession => ({ id: 'lead', title: 'Lead', messages: [], teamTasks: tasks })
const t = (id: string, title: string) => ({ id, title, ownerId: '', status: 'pending' as const, dependsOn: [] as string[] })

describe('team task dependency accessible names', () => {
  it('distinguishes same-title target tasks and selects the requested prerequisite id after reorder', async () => {
    const tasks = [t('a', '同名'), t('b', '同名'), t('c', '另一个')]
    const onSave = vi.fn<(value: ChatSession) => Promise<boolean>>().mockResolvedValue(true), onDispatch = vi.fn()
    const props = { lead: base(tasks), members: [], models: [], onSave, onDispatch, onEnd: vi.fn() }
    const view = render(<AgentTeamMenu {...props} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      const dialog = screen.getByRole('dialog', { name: '团队管理' })
      const [first, second] = within(dialog).getAllByText('编辑依赖 · 同名', { selector: 'summary' })
      expect(first).toHaveAttribute('aria-label', '当前列表第 1 项（位置随列表变化），编辑依赖 · 同名')
      expect(second).toHaveAttribute('aria-label', '当前列表第 2 项（位置随列表变化），编辑依赖 · 同名')
      fireEvent.click(first)
      fireEvent.click(second)
      const choices = within(dialog).getAllByRole('checkbox', { name: /^第 \d+ 项任务依赖第 \d+ 项（位置随列表变化）：/ })
      expect(choices.length).toBeGreaterThan(1)
      const firstDependsSecond = within(dialog).getByRole('checkbox', { name: '第 1 项任务依赖第 2 项（位置随列表变化）：同名 依赖 同名' })
      expect(firstDependsSecond).toBeEnabled()
      fireEvent.click(firstDependsSecond)
      expect(onSave).toHaveBeenCalledTimes(1)
      const saved = { ...tasks[0], dependsOn: ['b'] }
      expect(onSave.mock.calls[0][0].teamTasks).toEqual([saved, tasks[1], tasks[2]])
      await waitFor(() => expect(firstDependsSecond).toBeEnabled())
      view.rerender(<AgentTeamMenu {...props} lead={base([tasks[1], saved, tasks[2]])} />)
      const afterReorder = within(dialog).getByRole('checkbox', { name: '第 2 项任务依赖第 1 项（位置随列表变化）：同名 依赖 同名' })
      expect(afterReorder).toBeChecked()
      fireEvent.click(afterReorder)
      expect(onSave).toHaveBeenCalledTimes(2)
      expect(onSave.mock.calls[1][0].teamTasks).toEqual([tasks[1], tasks[0], tasks[2]])
      expect(onDispatch).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('disambiguates colliding composite names even when every title is unique', () => {
    const tasks = [t('a', 'A'), t('bc', 'B 依赖 C'), t('ab', 'A 依赖 B'), t('c', 'C'), t('crafted', 'A 依赖 B 依赖 C')]
    const onSave = vi.fn<(value: ChatSession) => Promise<boolean>>().mockResolvedValue(true)
    const view = render(<AgentTeamMenu lead={base(tasks)} members={[]} models={[]} onSave={onSave} onEnd={vi.fn()} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      fireEvent.click(screen.getByText('编辑依赖 · A'))
      fireEvent.click(screen.getByText('编辑依赖 · A 依赖 B'))
      const first = screen.getByRole('checkbox', { name: '第 1 项任务依赖第 2 项（位置随列表变化）：A 依赖 B 依赖 C' })
      const second = screen.getByRole('checkbox', { name: '第 3 项任务依赖第 4 项（位置随列表变化）：A 依赖 B 依赖 C' })
      const third = screen.getByRole('checkbox', { name: '新任务的前置：当前列表第 5 项（位置随列表变化），A 依赖 B 依赖 C' })
      expect(first).not.toBe(second)
      expect(third).not.toBe(second)
      fireEvent.click(second)
      expect(onSave.mock.calls[0][0].teamTasks).toEqual([tasks[0], tasks[1], { ...tasks[2], dependsOn: ['c'] }, tasks[3], tasks[4]])
    } finally { view.unmount() }
  })

  it('keeps a crafted original title separate from a generated position name', () => {
    const crafted = '第 1 项任务依赖第 3 项（位置随列表变化）：A 依赖 B'
    const tasks = [t('a', 'A'), t('b', 'A'), t('c', 'B'), t('d', crafted)]
    const onSave = vi.fn<(value: ChatSession) => Promise<boolean>>().mockResolvedValue(true)
    const onDispatch = vi.fn(), onEnd = vi.fn()
    const view = render(<AgentTeamMenu lead={base(tasks)} members={[]} models={[]} onSave={onSave} onDispatch={onDispatch} onEnd={onEnd} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      const dialog = screen.getByRole('dialog', { name: '团队管理' })
      fireEvent.click(within(dialog).getAllByText('编辑依赖 · A', { selector: 'summary' })[0])
      const existing = within(dialog).getByRole('checkbox', { name: crafted })
      const newTask = within(dialog).getByRole('checkbox', { name: `新任务的前置：当前列表第 4 项（位置随列表变化），${crafted}` })
      expect(existing).not.toBe(newTask)
      fireEvent.click(existing)
      expect(onSave).toHaveBeenCalledTimes(1)
      expect(onSave.mock.calls[0][0].teamTasks).toEqual([{ ...tasks[0], dependsOn: ['c'] }, ...tasks.slice(1)])
      expect(onDispatch).not.toHaveBeenCalled()
      expect(onEnd).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('distinguishes newly created task prerequisites by current position without changing their ids', () => {
    const tasks = [t('a', '同名'), t('b', '同名')]
    const onSave = vi.fn<(value: ChatSession) => Promise<boolean>>().mockResolvedValue(true), onDispatch = vi.fn()
    const view = render(<AgentTeamMenu lead={base(tasks)} members={[]} models={[]} onSave={onSave} onDispatch={onDispatch} onEnd={vi.fn()} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      fireEvent.change(screen.getByLabelText('任务'), { target: { value: '新任务' } })
      fireEvent.click(screen.getByRole('checkbox', { name: '新任务的前置：当前列表第 2 项（位置随列表变化），同名' }))
      fireEvent.click(screen.getByRole('button', { name: '添加任务' }))
      expect(onSave).toHaveBeenCalledTimes(1)
      expect(onSave.mock.calls[0][0].teamTasks).toEqual([...tasks, expect.objectContaining({ title: '新任务', dependsOn: ['b'] })])
      expect(onDispatch).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
})
