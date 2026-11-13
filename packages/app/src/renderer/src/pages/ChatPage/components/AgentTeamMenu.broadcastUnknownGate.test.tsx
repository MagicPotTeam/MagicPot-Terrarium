import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentTeamMenu from './AgentTeamMenu'
import type { ChatSession } from '../chatStorage'

const lead: ChatSession = { id: 'lead', title: 'Lead', messages: [] }
const unknown = '广播结果未确认，请先核对相关会话，避免重复发送。'
const confirm = '我已了解风险，允许再次广播'

describe('broadcast unknown gate', () => {
  it.each(['reject', 'invalid'] as const)('holds %s until explicit acknowledgement without sending', async mode => {
    const onBroadcast = vi.fn().mockImplementationOnce(mode === 'reject' ? async () => { throw Error('unknown') } : async () => ({ queued: -1 })).mockResolvedValue({ queued: 1 })
    const onSave = vi.fn()
    const view = render(<AgentTeamMenu lead={lead} members={[]} models={[]} onSave={onSave} onEnd={vi.fn()} onBroadcast={onBroadcast} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      const input = screen.getByLabelText('频道消息')
      fireEvent.change(input, { target: { value: '初始草稿' } })
      fireEvent.click(screen.getByRole('button', { name: '广播给订阅成员' }))
      expect(await screen.findByText(unknown)).toBeVisible()
      expect(input).toHaveValue('初始草稿')
      expect(screen.getByRole('button', { name: '广播给订阅成员' })).toBeDisabled()
      fireEvent.change(input, { target: { value: '编辑草稿' } })
      expect(screen.getByRole('button', { name: '广播给订阅成员' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '关闭团队管理' }))
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      expect(screen.getByRole('button', { name: '广播给订阅成员' })).toBeDisabled()
      expect(screen.getByText(/再次广播可能重复/)).toBeVisible()
      const confirmation = screen.getByRole('button', { name: confirm })
      expect(confirmation).toHaveAccessibleDescription(/再次广播可能重复/)
      fireEvent.click(confirmation)
      expect(onBroadcast).toHaveBeenCalledTimes(1)
      expect(screen.getByLabelText('频道消息')).toHaveValue('编辑草稿')
      fireEvent.click(screen.getByRole('button', { name: '广播给订阅成员' }))
      await waitFor(() => expect(onBroadcast).toHaveBeenCalledTimes(2))
      expect(onBroadcast.mock.calls[1][0].id).not.toBe(onBroadcast.mock.calls[0][0].id)
      expect(await screen.findByText('已排队，非送达')).toBeVisible()
      expect(onSave).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it.each([0, 1])('does not gate a known queued count %s', async queued => {
    const onBroadcast = vi.fn().mockResolvedValue({ queued })
    const view = render(<AgentTeamMenu lead={lead} members={[]} models={[]} onSave={vi.fn()} onEnd={vi.fn()} onBroadcast={onBroadcast} />)
    try {
      fireEvent.click(screen.getByRole('button', { name: '团队管理' }))
      fireEvent.change(screen.getByLabelText('频道消息'), { target: { value: '内容' } })
      fireEvent.click(screen.getByRole('button', { name: '广播给订阅成员' }))
      expect(await screen.findByText(queued ? '已排队，非送达' : '未送出，请检查订阅')).toBeVisible()
      expect(screen.queryByRole('button', { name: confirm })).not.toBeInTheDocument()
    } finally { view.unmount() }
  })
})
