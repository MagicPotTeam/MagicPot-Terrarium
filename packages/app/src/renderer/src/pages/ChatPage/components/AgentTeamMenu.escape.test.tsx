import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentTeamMenu from './AgentTeamMenu'
import type { ChatSession } from '../chatStorage'

const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [] }

function renderMenu() {
  const host = document.createElement('div')
  document.body.append(host)
  const onSave = vi.fn(async () => true)
  const onBroadcast = vi.fn()
  const onEnd = vi.fn()
  const view = render(<AgentTeamMenu lead={lead} members={[]} models={[]} onSave={onSave} onBroadcast={onBroadcast} onEnd={onEnd} buttonHost={host} />)
  const trigger = screen.getByRole('button', { name: '团队管理' })
  return { ...view, host, trigger, onSave, onBroadcast, onEnd }
}

describe('AgentTeamMenu Escape interaction', () => {
  it('closes a keyboard-opened dialog on Escape, restores focus, and keeps draft callbacks untouched', () => {
    const { unmount, host, trigger, onSave, onBroadcast, onEnd } = renderMenu()
    try {
      act(() => trigger.focus())
      fireEvent.click(trigger, { detail: 0 })
      const dialog = screen.getByRole('dialog', { name: '团队管理' })
      const draft = screen.getByLabelText('频道消息')
      fireEvent.change(draft, { target: { value: '保留的草稿' } })
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: '团队管理' })).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
      expect(onSave).not.toHaveBeenCalled()
      expect(onBroadcast).not.toHaveBeenCalled()
      expect(onEnd).not.toHaveBeenCalled()
      fireEvent.click(trigger, { detail: 0 })
      expect(screen.getByLabelText('频道消息')).toHaveValue('保留的草稿')
    } finally {
      unmount()
      host.remove()
    }
  })

  it('asks the page to take the focus back when a dialog opened without a trigger closes', async () => {
    const onReturnFocus = vi.fn()
    const view = (openRequest: number) => <AgentTeamMenu lead={lead} members={[]} models={[]} onSave={vi.fn(async () => true)} onEnd={vi.fn()} hideTriggerWithoutHost openRequest={openRequest} onReturnFocus={onReturnFocus} />
    const page = render(view(0))
    try {
      expect(screen.queryByRole('button', { name: '团队管理' })).not.toBeInTheDocument()
      // Opened from the composer menu: the dialog takes the focus, Escape gives it back.
      page.rerender(view(1))
      const close = await screen.findByRole('button', { name: '关闭团队管理' })
      await waitFor(() => expect(close).toHaveFocus())
      fireEvent.keyDown(screen.getByRole('dialog', { name: '团队管理' }), { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: '团队管理' })).not.toBeInTheDocument()
      expect(onReturnFocus).toHaveBeenCalledTimes(1)

      // The close button does the same.
      page.rerender(view(2))
      const closeAgain = await screen.findByRole('button', { name: '关闭团队管理' })
      await waitFor(() => expect(closeAgain).toHaveFocus())
      fireEvent.click(closeAgain)
      expect(screen.queryByRole('dialog', { name: '团队管理' })).not.toBeInTheDocument()
      expect(onReturnFocus).toHaveBeenCalledTimes(2)
    } finally {
      page.unmount()
    }
  })

  it('does not steal the focus when the dialog closes while the focus is elsewhere', async () => {
    const onReturnFocus = vi.fn()
    const outside = document.createElement('button')
    document.body.append(outside)
    const view = (openRequest: number) => <AgentTeamMenu lead={lead} members={[]} models={[]} onSave={vi.fn(async () => true)} onEnd={vi.fn()} hideTriggerWithoutHost openRequest={openRequest} onReturnFocus={onReturnFocus} />
    const page = render(view(0))
    try {
      page.rerender(view(1))
      const close = await screen.findByRole('button', { name: '关闭团队管理' })
      await waitFor(() => expect(close).toHaveFocus())
      act(() => outside.focus())
      fireEvent.click(close)
      expect(screen.queryByRole('dialog', { name: '团队管理' })).not.toBeInTheDocument()
      expect(onReturnFocus).not.toHaveBeenCalled()
      expect(outside).toHaveFocus()
    } finally {
      page.unmount()
      outside.remove()
    }
  })

  it('does not close for Escape from outside the dialog or a composing input', () => {
    const { unmount, host, trigger } = renderMenu()
    try {
      fireEvent.click(trigger, { detail: 1 })
      const dialog = screen.getByRole('dialog', { name: '团队管理' })
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(screen.getByRole('dialog', { name: '团队管理' })).toBe(dialog)
      const draft = screen.getByLabelText('频道消息')
      fireEvent.keyDown(draft, { key: 'Escape', isComposing: true })
      expect(screen.getByRole('dialog', { name: '团队管理' })).toBe(dialog)
    } finally {
      unmount()
      host.remove()
    }
  })

  it('closes only the nested model picker on its first Escape', () => {
    const { unmount, host, trigger } = renderMenu()
    try {
      fireEvent.click(trigger, { detail: 1 })
      const dialog = screen.getByRole('dialog', { name: '团队管理' })
      fireEvent.mouseDown(screen.getByRole('combobox', { name: '成员默认模型' }))
      const listbox = screen.getByRole('listbox')
      fireEvent.keyDown(listbox, { key: 'Escape', code: 'Escape' })
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(screen.getByRole('dialog', { name: '团队管理' })).toBe(dialog)
    } finally {
      unmount()
      host.remove()
    }
  })

  it('does not return focus to a pointer-opened trigger on Escape', () => {
    const { unmount, host, trigger } = renderMenu()
    try {
      act(() => trigger.focus())
      fireEvent.click(trigger, { detail: 1 })
      const close = screen.getByRole('button', { name: '关闭团队管理' })
      act(() => close.focus())
      fireEvent.keyDown(close, { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: '团队管理' })).not.toBeInTheDocument()
      expect(trigger).not.toHaveFocus()
    } finally {
      unmount()
      host.remove()
    }
  })

  it('does not close when a nested control has already prevented Escape', () => {
    const { unmount, host, trigger } = renderMenu()
    try {
      fireEvent.click(trigger, { detail: 1 })
      const dialog = screen.getByRole('dialog', { name: '团队管理' })
      const nested = document.createElement('button')
      dialog.append(nested)
      nested.focus()
      const preventEscape = vi.fn((event: KeyboardEvent) => event.preventDefault())
      nested.addEventListener('keydown', preventEscape)
      fireEvent.keyDown(nested, { key: 'Escape' })
      expect(preventEscape).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('dialog', { name: '团队管理' })).toBe(dialog)
    } finally {
      unmount()
      host.remove()
    }
  })
})
