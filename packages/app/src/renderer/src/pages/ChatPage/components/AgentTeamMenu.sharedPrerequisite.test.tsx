import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentTeamMenu from './AgentTeamMenu'
import type { ChatSession } from '../chatStorage'

describe('shared prerequisite dependency edits', () => {
  it.each(['pending', 'running', 'done'] as const)(
    'rechecks the remaining %s successor after a confirmed dependency edit',
    async status => {
      let resolveSave!: (value: boolean) => void
      const pendingSave = new Promise<boolean>(resolve => { resolveSave = resolve })
      const onSave = vi.fn<(value: ChatSession) => Promise<boolean>>()
        .mockImplementationOnce(() => pendingSave)
        .mockResolvedValue(true)
      const onDispatch = vi.fn(), onEnd = vi.fn(), onBroadcast = vi.fn()
      const fetchGuard = vi.fn(() => { throw new Error('Unexpected fetch') })
      const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
      const a = { id: 'a', title: '前置A', ownerId: '', status: 'done' as const, dependsOn: [] as string[] }
      const b = { id: 'b', title: '后继B', ownerId: '', status: 'running' as const, dependsOn: ['a'] }
      const c = { id: 'c', title: '后继C', ownerId: '', status, dependsOn: ['a'] }
      const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamTasks: [a, b, c] }
      const props = { lead, members: [], models: [], onSave, onDispatch, onEnd, onBroadcast }
      let view: ReturnType<typeof render> | undefined
      try {
        Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fetchGuard })
        view = render(<AgentTeamMenu {...props} />)
        fireEvent.click(screen.getByRole('button', { name: '团队管理' }), { detail: 1 })
        const reopen = () => within(screen.getByText(/前置A ·/).parentElement!).getByRole('button', { name: '当前列表第 1 项（位置随列表变化），重开：前置A' })
        expect(reopen()).toBeDisabled()
        fireEvent.click(screen.getByText('编辑依赖 · 后继B'))
        const dependency = screen.getByRole('checkbox', { name: '后继B 依赖 前置A' })
        expect(dependency).toBeChecked()
        expect(dependency).toBeEnabled()
        fireEvent.click(dependency)
        const editedLead = { ...lead, teamTasks: [a, { ...b, dependsOn: [] }, c] }
        expect(onSave).toHaveBeenCalledTimes(1)
        expect(onSave.mock.calls[0][0]).toEqual(editedLead)
        expect(dependency).toBeDisabled()
        expect(reopen()).toBeDisabled()
        fireEvent.click(dependency)
        fireEvent.click(reopen())
        expect(onSave).toHaveBeenCalledTimes(1)
        await act(async () => { resolveSave(true); await pendingSave })
        view.rerender(<AgentTeamMenu {...props} lead={editedLead} />)
        await waitFor(() => expect(screen.getByRole('checkbox', { name: '后继B 依赖 前置A' })).toBeEnabled())
        expect(screen.getByRole('checkbox', { name: '后继B 依赖 前置A' })).not.toBeChecked()
        if (status === 'pending') {
          expect(reopen()).toBeEnabled()
          fireEvent.click(reopen())
          await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
          expect(onSave.mock.calls[1][0]).toEqual({ ...editedLead, teamTasks: [{ ...a, status: 'pending' }, { ...b, dependsOn: [] }, c] })
        } else {
          expect(reopen()).toBeDisabled()
          const explanation = within(screen.getByText(/前置A ·/).parentElement!).getByText('有进行中或已完成的后续任务，无法重开。')
          expect(explanation).toBeVisible()
          expect(reopen()).toHaveAttribute('aria-describedby', explanation.id)
          fireEvent.click(reopen())
          expect(onSave).toHaveBeenCalledTimes(1)
        }
        expect(onDispatch).not.toHaveBeenCalled()
        expect(onEnd).not.toHaveBeenCalled()
        expect(onBroadcast).not.toHaveBeenCalled()
        expect(fetchGuard).not.toHaveBeenCalled()
      } finally {
        try {
          await act(async () => { resolveSave(true); await pendingSave })
        } finally {
          try {
            view?.unmount()
          } finally {
            if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor)
            else Reflect.deleteProperty(globalThis, 'fetch')
          }
        }
      }
    }
  )
})
