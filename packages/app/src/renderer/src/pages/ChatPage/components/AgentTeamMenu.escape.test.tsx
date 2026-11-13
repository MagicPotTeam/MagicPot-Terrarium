import { act, fireEvent, render, screen } from '@testing-library/react'
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
