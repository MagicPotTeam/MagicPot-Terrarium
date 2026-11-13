import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import AgentTeamMessageActivity, { type TeamMessageActivityEntry } from './AgentTeamMessageActivity'

const activity = (id: string, status: TeamMessageActivityEntry['status']): TeamMessageActivityEntry => ({
  id, sourceName: '设计师', recipientName: '文案', text: `消息 ${id}`, status
})

describe('AgentTeamMessageActivity list semantics', () => {
  it('exposes the current entries as an ordered list without changing status text or unknown guidance', () => {
    render(<AgentTeamMessageActivity entries={[activity('1', 'queued'), activity('2', 'unknown'), activity('3', 'response_received')]} />)
    const list = screen.getByRole('list', { name: '团队消息活动' })
    expect(list.tagName).toBe('OL')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('团队消息 · 设计师 → 文案 · 排队中（非送达） · 消息 1')
    expect(items[1]).toHaveTextContent('结果未知 · 消息 2')
    expect(within(items[1]).getByText('未确认结果，请核对相关会话中的后续记录。')).toBeVisible()
    expect(items[2]).toHaveTextContent('已收到响应（不代表送达） · 消息 3')
    expect(list).not.toHaveAttribute('aria-live')
    expect(within(list).queryByRole('button')).not.toBeInTheDocument()
  })

  it('exposes exactly the last 50 entries in order when the view is truncated', () => {
    const entries = Object.freeze(Array.from({ length: 52 }, (_, index) => Object.freeze(activity(String(index), 'queued'))))
    render(<AgentTeamMessageActivity entries={entries} />)
    expect(screen.getByText('此处仅显示最近 50 条团队消息。')).toBeVisible()
    const items = within(screen.getByRole('list', { name: '团队消息活动' })).getAllByRole('listitem')
    expect(items).toHaveLength(50)
    expect(items[0]).toHaveTextContent('消息 2')
    expect(items[49]).toHaveTextContent('消息 51')
    expect(entries).toHaveLength(52)
  })
})
