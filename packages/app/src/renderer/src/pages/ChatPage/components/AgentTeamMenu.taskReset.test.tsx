import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TeamMenuHarness } from './AgentTeamMenu.testHarness'
import type { ChatSession } from '../chatStorage'

type Task = NonNullable<ChatSession['teamTasks']>[number]
const member: ChatSession = { id: 'member', title: 'designer', messages: [], teamLeadId: 'lead', teamMemberName: 'designer' }
const doneTask: Task = { id: 'done', title: '已完成任务', ownerId: 'member', status: 'done', dependsOn: [] }
const leadWith = (tasks: Task[]): ChatSession => ({ id: 'lead', title: 'Lead', messages: [], teamTasks: tasks })

function open(lead: ChatSession, isOwnerBusy?: (id: string) => boolean, onSave = vi.fn(async () => true)) {
  const view = render(<TeamMenuHarness lead={lead} members={[member]} models={[]} onSave={onSave} onEnd={vi.fn()} onDispatch={vi.fn()} isOwnerBusy={isOwnerBusy} />)
  fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
  return { view, onSave }
}

describe('team menu: a running task without a live run', () => {
  it('says the last run was interrupted and resets only that task to pending, without running it', async () => {
    const running: Task = { id: 'task', title: '海报', ownerId: 'member', status: 'running', dependsOn: ['done'] }
    const lead = leadWith([doneTask, running])
    const isOwnerBusy = vi.fn(() => false)
    const { view, onSave } = open(lead, isOwnerBusy)
    try {
      expect(screen.getByText(/海报 · designer · 进行中 · Last run interrupted/)).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Reset: 已完成任务' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Reset: 海报' }))
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
      const saved = (onSave.mock.calls[0] as unknown as [ChatSession])[0]
      expect(saved.teamTasks).toEqual([doneTask, { ...running, status: 'pending', lastOutcome: 'interrupted' }])
      expect(isOwnerBusy).toHaveBeenCalledWith('member')
    } finally { view.unmount() }
  })

  it('asks again at click time and saves nothing when the owner became busy after the last render', async () => {
    const running: Task = { id: 'task', title: '海报', ownerId: 'member', status: 'running', dependsOn: [] }
    let busy = false
    const { view, onSave } = open(leadWith([running]), () => busy)
    try {
      const reset = screen.getByRole('button', { name: 'Reset: 海报' })
      busy = true
      fireEvent.click(reset)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(onSave).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('offers no reset while the owner has a live run, or when the page cannot tell', () => {
    const running: Task = { id: 'task', title: '海报', ownerId: 'member', status: 'running', dependsOn: [] }
    for (const isOwnerBusy of [() => true, undefined]) {
      const { view, onSave } = open(leadWith([running]), isOwnerBusy)
      try {
        expect(screen.queryByRole('button', { name: 'Reset: 海报' })).not.toBeInTheDocument()
        expect(screen.queryByText(/Last run interrupted/)).not.toBeInTheDocument()
        expect(screen.getByText(/海报 · designer · 进行中/)).toBeVisible()
        expect(onSave).not.toHaveBeenCalled()
      } finally { view.unmount() }
    }
  })

  it('shows an outcome this version does not know as none, and keeps execute, reopen and reset working', async () => {
    const later = 'timed_out' as unknown as Task['lastOutcome']
    const tasks: Task[] = [
      { ...doneTask, lastOutcome: later },
      { id: 'next', title: '后续任务', ownerId: 'member', status: 'pending', dependsOn: ['done'], lastOutcome: later },
      { id: 'stuck', title: '卡住任务', ownerId: 'member', status: 'running', dependsOn: [], lastOutcome: later }
    ]
    const { view, onSave } = open(leadWith(tasks), () => false)
    try {
      expect(screen.queryByText('任务依赖无效')).not.toBeInTheDocument()
      expect(screen.getByText(/后续任务 · designer · 待处理 · 依赖/)).toBeVisible()
      expect(screen.getByText(/已完成任务 · designer · 已完成 · 依赖/)).toBeVisible()
      expect(screen.queryByText(/Last run (failed|cancelled)/)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '执行 后续任务' })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'Reset: 卡住任务' }))
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
      const saved = (onSave.mock.calls[0] as unknown as [ChatSession])[0]
      expect(saved.teamTasks).toEqual([tasks[0], tasks[1], { id: 'stuck', title: '卡住任务', ownerId: 'member', status: 'pending', dependsOn: [], lastOutcome: 'interrupted' }])
    } finally { view.unmount() }
  })

  it('shows the outcome of a pending task, offers no reset for pending or done tasks, and keeps execute', () => {
    const tasks: Task[] = [
      doneTask,
      { id: 'failed', title: '失败任务', ownerId: 'member', status: 'pending', dependsOn: [], lastOutcome: 'failed' },
      { id: 'cancelled', title: '取消任务', ownerId: 'member', status: 'pending', dependsOn: [], lastOutcome: 'cancelled' }
    ]
    const { view, onSave } = open(leadWith(tasks), () => false)
    try {
      expect(screen.getByText(/失败任务 · designer · 待处理 · Last run failed/)).toBeVisible()
      expect(screen.getByText(/取消任务 · designer · 待处理 · Last run cancelled/)).toBeVisible()
      expect(screen.getByText(/已完成任务 · designer · 已完成 · 依赖/)).toBeVisible()
      expect(screen.queryByRole('button', { name: /^Reset/ })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '执行 失败任务' })).toBeEnabled()
      expect(onSave).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
})
