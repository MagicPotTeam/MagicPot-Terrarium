import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import AgentTeamMessageActivity, { type TeamMessageActivityEntry } from './AgentTeamMessageActivity'

const entry = (status: TeamMessageActivityEntry['status'], id: string = status): TeamMessageActivityEntry => ({ id, sourceName: '设计师', recipientName: '文案', text: '合成消息', status })

describe('AgentTeamMessageActivity', () => {
  it.each([
    ['queued', '排队中（非送达）'], ['request_started', '请求已发起'], ['response_received', '已收到响应（不代表送达）'],
    ['failed', '失败'], ['unavailable', '状态未确认'], ['unknown', '结果未知']
  ] as const)('renders %s accurately as %s', (status, label) => {
    render(<AgentTeamMessageActivity entries={[entry(status)]} />)
    const activity = screen.getByTestId('team-message-activity')
    expect(within(activity).getByText(`团队消息 · 设计师 → 文案 · ${label} · 合成消息`)).toBeVisible()
    expect(activity.textContent).not.toMatch(/已送达|已处理/)
  })

  it('renders nothing when empty and keeps only the last 50 without mutating input', () => {
    const entries = Object.freeze(Array.from({ length: 52 }, (_, index) => Object.freeze(entry('queued', `id-${index}`))))
    const view = render(<AgentTeamMessageActivity entries={[]} />)
    expect(screen.queryByTestId('team-message-activity')).not.toBeInTheDocument()
    view.rerender(<AgentTeamMessageActivity entries={entries} />)
    expect(screen.getByTestId('team-message-activity').children).toHaveLength(50)
    expect(entries).toHaveLength(52)
  })

  it('indicates truncation only when the current view receives more than 50 entries', () => {
    const entries = Object.freeze(Array.from({ length: 52 }, (_, index) => Object.freeze({ ...entry('queued', `id-${index}`), text: `消息${index}` })))
    const view = render(<AgentTeamMessageActivity entries={entries.slice(0, 49)} />)
    expect(screen.queryByText('此处仅显示最近 50 条团队消息。')).not.toBeInTheDocument()
    view.rerender(<AgentTeamMessageActivity entries={entries.slice(0, 50)} />)
    expect(screen.queryByText('此处仅显示最近 50 条团队消息。')).not.toBeInTheDocument()
    view.rerender(<AgentTeamMessageActivity entries={entries} />)
    expect(screen.getByText('此处仅显示最近 50 条团队消息。')).toBeVisible()
    expect(screen.queryByText(/· 消息0$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/· 消息1$/)).not.toBeInTheDocument()
    const rows = within(screen.getByTestId('team-message-activity')).getAllByText(/^团队消息 ·/)
    expect(rows).toHaveLength(50)
    expect(rows[0]).toHaveTextContent('消息2')
    expect(rows[49]).toHaveTextContent('消息51')
    expect(entries).toHaveLength(52)
    view.rerender(<AgentTeamMessageActivity entries={entries.slice(0, 50)} />)
    expect(screen.queryByText('此处仅显示最近 50 条团队消息。')).not.toBeInTheDocument()
  })

  it('offers a neutral check for unknown results without adding actions or changing other statuses', () => {
    const entries = [
      { ...entry('unknown'), text: '未知消息' },
      { ...entry('queued'), text: '排队消息' },
      { ...entry('response_received'), text: '回复消息' }
    ]
    render(<AgentTeamMessageActivity entries={entries} />)
    const activity = screen.getByTestId('team-message-activity')
    const unknown = within(activity).getByText(/结果未知 · 未知消息/)
    const queued = within(activity).getByText(/排队中（非送达） · 排队消息/)
    const received = within(activity).getByText(/已收到响应（不代表送达） · 回复消息/)
    const hint = '未确认结果，请核对相关会话中的后续记录。'
    expect(within(unknown).getByText(hint)).toBeVisible()
    expect(within(queued).queryByText(hint)).not.toBeInTheDocument()
    expect(within(received).queryByText(hint)).not.toBeInTheDocument()
    expect(within(activity).queryByRole('button')).not.toBeInTheDocument()
    expect(entries.map(item => item.text)).toEqual(['未知消息', '排队消息', '回复消息'])
  })

  it('shows dangerous content as text and enables wrapping long unbroken content', () => {
    const text = '<img src=x onerror="alert(1)">' + '长'.repeat(1000)
    const { container } = render(<AgentTeamMessageActivity entries={[{ ...entry('unknown'), text }]} />)
    const row = screen.getByTestId('team-message-activity').firstElementChild
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent(text)
    expect(container.querySelector('img')).toBeNull()
    expect(row).toHaveStyle({ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: '1.6' })
  })
})
