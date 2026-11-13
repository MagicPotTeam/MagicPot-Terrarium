import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentTeamMenu from './AgentTeamMenu'
import type { ChatSession } from '../chatStorage'

describe('team task accessible action names', () => {
  it('names current positions and changes only the chosen task', async () => {
    const tasks = [
      { id: 'a', title: '同名', ownerId: '', status: 'pending' as const, dependsOn: [] },
      { id: 'b', title: '同名', ownerId: '', status: 'done' as const, dependsOn: [] },
      { id: 'c', title: '第 1 项\n\u202e伪造', ownerId: '', status: 'pending' as const, dependsOn: [] },
      { id: 'd', title: '阻断', ownerId: '', status: 'done' as const, dependsOn: [] },
      { id: 'e', title: '后续', ownerId: '', status: 'running' as const, dependsOn: ['d'] }
    ]
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: tasks }
    const onSave = vi.fn(async (_value: ChatSession) => true), onDispatch = vi.fn(), onEnd = vi.fn(), onBroadcast = vi.fn()
    const keys = ['fetch', 'indexedDB'] as const
    const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
    const apiOriginal = Object.getOwnPropertyDescriptor(window, 'api')
    let view: ReturnType<typeof render> | undefined
    try {
      for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, get: () => { throw Error(`Unexpected ${key}`) } })
      Object.defineProperty(window, 'api', { configurable: true, get: () => { throw Error('Unexpected IPC') } })
      view = render(<AgentTeamMenu lead={lead} members={[]} models={[]} onSave={onSave} onDispatch={onDispatch} onEnd={onEnd} onBroadcast={onBroadcast} />)
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      const first = screen.getByRole('button', { name: '当前列表第 1 项（位置随列表变化），完成：同名' })
      const second = screen.getByRole('button', { name: '当前列表第 2 项（位置随列表变化），重开：同名' })
      expect(first).toBeEnabled(); expect(second).toBeEnabled()
      const unusual = screen.getByRole('button', { name: /^当前列表第 3 项（位置随列表变化），完成：/ })
      expect(unusual).toBeEnabled()
      expect(unusual.getAttribute('aria-label')).toBe(`当前列表第 3 项（位置随列表变化），完成：${tasks[2].title}`)
      const blocked = screen.getByRole('button', { name: '当前列表第 4 项（位置随列表变化），重开：阻断' })
      expect(blocked).toBeDisabled()
      expect(blocked).toHaveAccessibleDescription('有进行中或已完成的后续任务，无法重开。')
      fireEvent.click(first)
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
      expect(onSave.mock.calls[0][0].teamTasks).toEqual(tasks.map(task => task.id === 'a' ? { ...task, status: 'done' } : task))
      await waitFor(() => expect(second).toBeEnabled())
      fireEvent.click(second)
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
      expect(onSave.mock.calls[1][0].teamTasks).toEqual(tasks.map(task => task.id === 'b' ? { ...task, status: 'pending' } : task))
      await waitFor(() => expect(unusual).toBeEnabled())
      fireEvent.click(unusual)
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(3))
      expect(onSave.mock.calls[2][0].teamTasks).toEqual(tasks.map(task => task.id === 'c' ? { ...task, status: 'done' } : task))
      await waitFor(() => expect(first).toBeEnabled())
      view.rerender(<AgentTeamMenu lead={{ ...lead, teamTasks: [tasks[1], tasks[0], ...tasks.slice(2)] }} members={[]} models={[]} onSave={onSave} onDispatch={onDispatch} onEnd={onEnd} onBroadcast={onBroadcast} />)
      expect(screen.getByRole('button', { name: '当前列表第 1 项（位置随列表变化），重开：同名' })).toBeEnabled()
      expect(within(screen.getByRole('dialog', { name: '团队管理' })).getByRole('button', { name: '当前列表第 2 项（位置随列表变化），完成：同名' })).toBeEnabled()
      const reordered = screen.getByRole('button', { name: '当前列表第 2 项（位置随列表变化），完成：同名' })
      fireEvent.click(reordered)
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(4))
      const reorderedTasks = [tasks[1], tasks[0], ...tasks.slice(2)]
      expect(onSave.mock.calls[3][0].teamTasks).toEqual(reorderedTasks.map(task => task.id === 'a' ? { ...task, status: 'done' } : task))
      await waitFor(() => expect(reordered).toBeEnabled())
      // The fake onSave does not update props: each click starts from this explicit fixture.
      const sameStatusTasks = [{ ...tasks[1], status: 'pending' as const }, tasks[0], ...tasks.slice(2)]
      view.rerender(<AgentTeamMenu lead={{ ...lead, teamTasks: sameStatusTasks }} members={[]} models={[]} onSave={onSave} onDispatch={onDispatch} onEnd={onEnd} onBroadcast={onBroadcast} />)
      const sameFirst = screen.getByRole('button', { name: '当前列表第 1 项（位置随列表变化），完成：同名' })
      const sameSecond = screen.getByRole('button', { name: '当前列表第 2 项（位置随列表变化），完成：同名' })
      fireEvent.click(sameFirst)
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(5))
      expect(onSave.mock.calls[4][0].teamTasks).toEqual(sameStatusTasks.map(task => task.id === 'b' ? { ...task, status: 'done' } : task))
      await waitFor(() => expect(sameSecond).toBeEnabled())
      fireEvent.click(sameSecond)
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(6))
      expect(onSave.mock.calls[5][0].teamTasks).toEqual(sameStatusTasks.map(task => task.id === 'a' ? { ...task, status: 'done' } : task))
      expect(onDispatch).not.toHaveBeenCalled(); expect(onEnd).not.toHaveBeenCalled(); expect(onBroadcast).not.toHaveBeenCalled()
    } finally {
      try { view?.unmount() } finally {
        try { if (originals[0]) Object.defineProperty(globalThis, keys[0], originals[0]); else Reflect.deleteProperty(globalThis, keys[0]) } finally {
          try { if (originals[1]) Object.defineProperty(globalThis, keys[1], originals[1]); else Reflect.deleteProperty(globalThis, keys[1]) } finally {
            if (apiOriginal) Object.defineProperty(window, 'api', apiOriginal); else Reflect.deleteProperty(window, 'api')
          }
        }
      }
    }
  })
})
