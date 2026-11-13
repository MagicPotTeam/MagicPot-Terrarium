import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import AgentTeamMenu from './AgentTeamMenu'
import type { ChatSession } from '../chatStorage'

const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [] }
const designer: ChatSession = { id: 'designer-id', title: '设计师', teamMemberName: '设计师', teamLeadId: 'lead', messages: [] }
const writer: ChatSession = { id: 'writer-id', title: '文案', teamMemberName: '文案', teamLeadId: 'lead', messages: [] }

function props() {
  return {
    lead,
    members: [designer, writer],
    models: [],
    subscriptions: ['designer-id'],
    onSubscriptionChange: vi.fn(),
    onSave: vi.fn<(value: ChatSession) => Promise<boolean>>().mockResolvedValue(true),
    onBroadcast: vi.fn(async () => ({ queued: 0 })),
    onEnd: vi.fn()
  }
}

describe('team channel subscription group semantics', () => {
  it('associates the existing heading with the controlled checkboxes and preserves their id callbacks after reorder', () => {
    const input = props()
    const view = render(<AgentTeamMenu {...input} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      const group = screen.getByRole('group', { name: '成员频道订阅（本次会话）' })
      const designerBox = within(group).getByRole('checkbox', { name: '设计师' })
      const writerBox = within(group).getByRole('checkbox', { name: '文案' })
      expect(within(group).getAllByRole('checkbox')).toEqual([designerBox, writerBox])
      expect(designerBox).toBeChecked()
      expect(writerBox).not.toBeChecked()
      fireEvent.click(writerBox)
      fireEvent.click(designerBox)
      expect(input.onSubscriptionChange.mock.calls).toEqual([['writer-id', true], ['designer-id', false]])
      view.rerender(<AgentTeamMenu {...input} members={[writer, designer]} subscriptions={['writer-id']} />)
      expect(within(group).getAllByRole('checkbox')).toEqual([writerBox, designerBox])
      expect(writerBox).toBeChecked()
      expect(designerBox).not.toBeChecked()
      fireEvent.click(designerBox)
      expect(input.onSubscriptionChange).toHaveBeenLastCalledWith('designer-id', true)
      expect(input.onSave).not.toHaveBeenCalled()
      expect(input.onBroadcast).not.toHaveBeenCalled()
      expect(input.onEnd).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('keeps subscriptions disabled after the team ends and omits the group when the callback is absent', async () => {
    const input = props()
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
    const view = render(<AgentTeamMenu {...input} lead={{ ...lead, teamEnded: true }} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      const group = screen.getByRole('group', { name: '成员频道订阅（本次会话）' })
      for (const checkbox of within(group).getAllByRole('checkbox')) {
        expect(checkbox).toBeDisabled()
        await user.click(checkbox)
      }
      expect(input.onSubscriptionChange).not.toHaveBeenCalled()
      view.rerender(<AgentTeamMenu {...input} onSubscriptionChange={undefined} />)
      expect(screen.queryByRole('group', { name: '成员频道订阅（本次会话）' })).not.toBeInTheDocument()
      expect(input.onSave).not.toHaveBeenCalled()
      expect(input.onBroadcast).not.toHaveBeenCalled()
      expect(input.onEnd).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
})
