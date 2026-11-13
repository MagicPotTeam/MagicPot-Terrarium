import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '../chatStorage'
import { AgentTeamMemberForm } from './AgentTeamTree'

vi.mock('./useTeamImagePlacement', () => ({
  useTeamImagePlacement: () => { throw new Error('Unexpected image placement hook') }
}))

const lead: ChatSession = { id: 'synthetic-lead', title: 'Synthetic lead', messages: [] }
const message = '创建结果未确认；请先核对原团队成员列表。没有记录不代表未创建；未确认前请勿重复创建。'

function prepareForm(onCreate: (name: string, role: string, onCommittedEmpty: (memberId: string) => void) => Promise<void>) {
  const onClose = vi.fn()
  const placement = { place: vi.fn(), registerEmptyMember: vi.fn() }
  const view = render(<AgentTeamMemberForm lead={lead} members={[]} creating onClose={onClose} onCreate={onCreate} placement={placement} />)
  const dialog = screen.getByRole('dialog', { name: '创建成员' })
  const name = within(dialog).getByLabelText('成员名')
  const role = within(dialog).getByLabelText('角色 / 当前任务')
  const submit = within(dialog).getByRole('button', { name: '确认创建成员' })
  return { view, dialog, name, role, submit, onClose, placement }
}

describe('member creation uncertain result notice', () => {
  it('does not report definite failure after a fake side effect followed by rejection', async () => {
    const syntheticRecords: string[] = []
    const onCreate = vi.fn(async (name: string, _role: string, _register: (id: string) => void) => {
      syntheticRecords.push(name)
      throw new Error('synthetic rejected response')
    })
    const { view, dialog, name, role, submit, onClose, placement } = prepareForm(onCreate)
    try {
      expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
      expect(onCreate).not.toHaveBeenCalled()
      fireEvent.change(name, { target: { value: '设计师' } })
      fireEvent.change(role, { target: { value: '图片设计' } })
      await act(async () => { fireEvent.click(submit) })
      expect(onCreate).toHaveBeenCalledOnce()
      expect(onCreate).toHaveBeenCalledWith('设计师', '图片设计', placement.registerEmptyMember)
      expect(syntheticRecords).toEqual(['设计师'])
      const alert = within(dialog).getByRole('alert')
      expect(alert).toHaveTextContent(message)
      expect(alert).not.toHaveTextContent('无法创建')
      expect(alert).not.toHaveTextContent('synthetic rejected response')
      expect(name).toHaveValue('设计师')
      expect(role).toHaveValue('图片设计')
      expect(onClose).not.toHaveBeenCalled()
      expect(placement.registerEmptyMember).not.toHaveBeenCalled()
      expect(placement.place).not.toHaveBeenCalled()
      expect(submit).toBeEnabled()
      expect(onCreate).toHaveBeenCalledOnce()
    } finally { view.unmount() }
  })

  it('keeps a successful creation explicit, closes and clears fields without showing an error', async () => {
    const onCreate = vi.fn(async (_name: string, _role: string, register: (id: string) => void) => { register('synthetic-member') })
    const { view, dialog, name, role, submit, onClose, placement } = prepareForm(onCreate)
    try {
      expect(submit).toBeDisabled()
      expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
      expect(onCreate).not.toHaveBeenCalled()
      fireEvent.change(name, { target: { value: '文案' } })
      fireEvent.change(role, { target: { value: '文字任务' } })
      expect(submit).toBeEnabled()
      await act(async () => { fireEvent.click(submit) })
      expect(onCreate).toHaveBeenCalledOnce()
      expect(onCreate).toHaveBeenCalledWith('文案', '文字任务', placement.registerEmptyMember)
      expect(placement.registerEmptyMember).toHaveBeenCalledExactlyOnceWith('synthetic-member')
      expect(placement.place).not.toHaveBeenCalled()
      expect(onClose).toHaveBeenCalledOnce()
      expect(name).toHaveValue('')
      expect(role).toHaveValue('')
      expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    } finally { view.unmount() }
  })
})
