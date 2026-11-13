import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TeamMessageDispatcher } from '../teamMessageDispatcher'
import AgentTeamMessageActivity from './AgentTeamMessageActivity'

// Renderer-local dispatcher and a synthetic delivery callback only: no ChatPage,
// IPC, network, durable receipt, or proof that a real external effect occurred.
describe('ambiguous unavailable activity', () => {
  it('does not claim no send when a claimed delivery settles without a stage', async () => {
    const team = { scope: 'synthetic', thread: 'thread', lead: 'lead' }
    const effects: string[] = []
    const deliver = vi.fn(async (delivery: { id: string }) => { effects.push(delivery.id) })
    const dispatcher = new TeamMessageDispatcher(team, () => true, id => id === 'a' || id === 'b', ['a', 'b'], deliver)
    dispatcher.enqueue({ id: 'message', source: { ...team, kind: 'member', member: 'a' }, kind: 'message', hop: 1, recipient: 'b', text: 'synthetic body' })
    try {
      await dispatcher.pump('b')
      expect(effects).toEqual(['message'])
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(dispatcher.entries()[0].status).toBe('unavailable')
      const entry = { id: 'message', sourceName: 'A', recipientName: 'B', text: 'synthetic body', status: dispatcher.entries()[0].status }
      render(<AgentTeamMessageActivity entries={[entry]} />)
      const activity = screen.getByTestId('team-message-activity')
      expect(within(activity).getByText(/状态未确认 · synthetic body/)).toBeVisible()
      expect(activity).not.toHaveTextContent('未送出')
      expect(within(activity).getByText('未确认结果，请核对相关会话中的后续记录。')).toBeVisible()
      expect(within(activity).queryByRole('button')).not.toBeInTheDocument()
      expect(dispatcher.pump('b')).toBeUndefined()
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally { dispatcher.end() }
  })

  it('preserves started, response and unknown labels without a new action', () => {
    const entries = (['request_started', 'response_received', 'unknown'] as const).map(status => ({ id: status, sourceName: 'A', recipientName: 'B', text: status, status }))
    render(<AgentTeamMessageActivity entries={entries} />)
    const activity = screen.getByTestId('team-message-activity')
    expect(within(activity).getByText(/请求已发起 · request_started/)).toBeVisible()
    expect(within(activity).getByText(/已收到响应（不代表送达） · response_received/)).toBeVisible()
    expect(within(activity).getByText(/结果未知 · unknown/)).toBeVisible()
    expect(within(activity).queryByRole('button')).not.toBeInTheDocument()
  })
})
