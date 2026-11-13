// Synthetic narrow container only: jsdom does not measure real layout or overflow.
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentTeamMenu from './AgentTeamMenu'
import type { ChatSession } from '../chatStorage'

describe('team menu accessibility in a synthetic narrow container', () => {
  it('keeps named controls and subscription/broadcast arguments with long content', async () => {
    const name = '合成成员长名称'.repeat(12)
    const history = '合成频道历史文本'.repeat(40)
    const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [], teamChannel: [{ id: 'history', senderId: 'user', text: history, createdAt: 1 }] }
    const member: ChatSession = { id: 'member-1', title: name, teamMemberName: name, teamLeadId: 'lead', messages: [] }
    const onSubscriptionChange = vi.fn()
    const onBroadcast = vi.fn(async (_input: { id: string; text: string }) => ({ queued: 1 }))
    const onSave = vi.fn()
    const view = render(<div style={{ width: 240 }}><AgentTeamMenu lead={lead} members={[member]} models={[]} onEnd={vi.fn()} onSave={onSave} subscriptions={[]} onSubscriptionChange={onSubscriptionChange} onBroadcast={onBroadcast} /></div>)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      const dialog = screen.getByRole('dialog', { name: '团队管理' })
      expect(within(dialog).getByText(`用户 · ${history}`)).toBeVisible()
      const checkbox = within(dialog).getByRole('checkbox', { name })
      expect(checkbox).not.toBeChecked()
      fireEvent.click(checkbox)
      expect(onSubscriptionChange).toHaveBeenCalledOnce()
      expect(onSubscriptionChange).toHaveBeenCalledWith('member-1', true)
      const text = `  ${'合成消息'.repeat(20)}  `
      fireEvent.change(within(dialog).getByRole('textbox', { name: '频道消息' }), { target: { value: text } })
      fireEvent.click(within(dialog).getByRole('button', { name: '广播给订阅成员' }))
      expect(await within(dialog).findByText('已排队，非送达')).toBeVisible()
      expect(onBroadcast).toHaveBeenCalledOnce()
      expect(onBroadcast).toHaveBeenCalledWith({ id: expect.any(String), text: text.trim() })
      expect(onSave).not.toHaveBeenCalled()
      expect(within(dialog).getByRole('button', { name: '关闭团队管理' })).toBeVisible()
    } finally { view.unmount() }
  })
})
