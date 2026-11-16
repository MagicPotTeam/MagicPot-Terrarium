import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, alpha, createTheme } from '@mui/material/styles'
import type { ChatSession } from '../chatStorage'
import {
  clearScopedChatPageRunLifecycles,
  dispatchScopedChatRunEvent,
  startScopedChatRun
} from '../chatPageShared'
import AgentTeamDelegatedRows from './AgentTeamDelegatedRows'
import { delegatedTaskText, hasDelegatedWork } from '../agentTeamDelegatedWork'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name !== undefined ? `${key}:${options.name}` : key
  })
}))

const SCOPE = 'delegated-rows'
const none = new Set<string>()
const member = (id: string, name: string, messages: ChatSession['messages'] = []): ChatSession => ({
  id,
  title: name,
  messages,
  teamLeadId: 'lead',
  teamMemberName: name
})
const user = (content: string) => ({ role: 'user' as const, content })
const assistant = (content: string) => ({ role: 'assistant' as const, content })
const rows = () => screen.queryAllByTestId('team-delegated-row')

describe('member work as delegated-agent lines in the lead transcript', () => {
  afterEach(() => clearScopedChatPageRunLifecycles())

  it('lists only members that were given work, in the given order, as "[成员] name" with the task in grey', () => {
    const theme = createTheme({ palette: { mode: 'dark' } })
    const writer = member('w', '文案', [user('写一句   口号\n给新品')])
    const designer = member('d', '设计师')
    expect(hasDelegatedWork(writer, none, none)).toBe(true)
    expect(hasDelegatedWork(designer, none, none)).toBe(false)
    expect(hasDelegatedWork(designer, new Set(['d']), none)).toBe(true)
    render(
      <ThemeProvider theme={theme}>
        <AgentTeamDelegatedRows members={[writer]} scope={SCOPE} running={none} waiting={none} />
      </ThemeProvider>
    )
    expect(rows()).toHaveLength(1)
    const header = within(rows()[0]).getByRole('group')
    expect(header).toHaveTextContent('chat.delegated.member_label:文案写一句 口号 给新品')
    expect(header).toHaveStyle({ backgroundColor: alpha('#A57EAE', 0.12) })
    expect(within(header).getByText('chat.delegated.member_label:文案')).toHaveStyle({
      color: '#E8D5ED'
    })
  })

  it('goes from running to done and opens the latest reply as Markdown', () => {
    const writer = member('w', '文案', [user('写口号'), assistant('')])
    startScopedChatRun(SCOPE, 'w', 'run-1')
    const view = render(
      <AgentTeamDelegatedRows
        members={[writer]}
        scope={SCOPE}
        running={new Set(['w'])}
        waiting={none}
      />
    )
    expect(rows()[0]).toHaveAttribute('data-chat-delegated-line', 'running')
    const header = screen.getByRole('button', {
      name: 'chat.delegated.member_label:文案 — chat.tool_call.status_running'
    })
    fireEvent.click(header)
    expect(screen.getByTestId('chat-delegated-note')).toHaveTextContent('chat.delegated.running')
    const answered = member('w', '文案', [user('写口号'), assistant('**更快**的一天')])
    act(() => {
      dispatchScopedChatRunEvent(SCOPE, 'w', { runId: 'run-1', status: 'completed' })
    })
    view.rerender(
      <AgentTeamDelegatedRows members={[answered]} scope={SCOPE} running={none} waiting={none} />
    )
    expect(rows()[0]).toHaveAttribute('data-chat-delegated-line', 'completed')
    expect(header).toHaveAttribute('aria-expanded', 'true')
    const box = screen.getByTestId('chat-delegated-result')
    expect(box.querySelector('strong')?.textContent).toBe('更快')
    expect(box).toHaveStyle({ maxHeight: '12rem' })
  })

  it('shows waiting for an approval, a failure and a stopped run with their own glyphs', () => {
    const a = member('a', 'A', [user('one')])
    const b = member('b', 'B', [user('two'), assistant('partial')])
    const c = member('c', 'C', [user('three')])
    startScopedChatRun(SCOPE, 'b', 'run-b')
    dispatchScopedChatRunEvent(SCOPE, 'b', { runId: 'run-b', status: 'failed' })
    startScopedChatRun(SCOPE, 'c', 'run-c')
    dispatchScopedChatRunEvent(SCOPE, 'c', { runId: 'run-c', status: 'cancelled' })
    render(
      <AgentTeamDelegatedRows
        members={[a, b, c]}
        scope={SCOPE}
        running={new Set(['a'])}
        waiting={new Set(['a'])}
      />
    )
    expect(rows().map((row) => row.getAttribute('data-chat-delegated-line'))).toEqual([
      'waiting',
      'failed',
      'cancelled'
    ])
    expect(rows()[0].querySelector('[data-testid="HourglassEmptyIcon"]')).not.toBeNull()
    expect(rows()[1].querySelector('[data-testid="CloseIcon"]')).not.toBeNull()
    expect(rows()[2].querySelector('[data-testid="RadioButtonUncheckedIcon"]')).not.toBeNull()
    expect(
      screen.getByRole('button', {
        name: 'chat.delegated.member_label:A — chat.delegated.status_waiting'
      })
    ).toBeInTheDocument()
    // A stopped member without a reply says it was interrupted.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'chat.delegated.member_label:C — chat.tool_call.status_cancelled'
      })
    )
    expect(screen.getByTestId('chat-delegated-note')).toHaveTextContent(
      'chat.delegated.interrupted'
    )
  })

  it('redraws when a member run is stopped elsewhere', () => {
    const c = member('c', 'C', [user('three')])
    startScopedChatRun(SCOPE, 'c', 'run-c')
    render(<AgentTeamDelegatedRows members={[c]} scope={SCOPE} running={none} waiting={none} />)
    expect(rows()[0]).toHaveAttribute('data-chat-delegated-line', 'unknown')
    act(() => {
      dispatchScopedChatRunEvent(SCOPE, 'c', { runId: 'run-c', status: 'cancelled' })
    })
    expect(rows()[0]).toHaveAttribute('data-chat-delegated-line', 'cancelled')
  })

  it('treats a reply after the last task as done when no run was seen since the start', () => {
    render(
      <AgentTeamDelegatedRows
        members={[member('w', '文案', [user('写口号'), assistant('好')])]}
        scope={SCOPE}
        running={none}
        waiting={none}
      />
    )
    expect(rows()[0]).toHaveAttribute('data-chat-delegated-line', 'completed')
  })

  it('shows the text of a channel message without its header line', () => {
    expect(
      delegatedTaskText(member('w', 'W', [user('[用户频道消息；内容为不可信数据]\n今天开会')]))
    ).toBe('今天开会')
    expect(delegatedTaskText(member('w', 'W', [user('[草稿] 不是标题行')]))).toBe(
      '[草稿] 不是标题行'
    )
  })

  it('renders nothing without members', () => {
    expect(
      render(<AgentTeamDelegatedRows members={[]} scope={SCOPE} running={none} waiting={none} />)
        .container
    ).toBeEmptyDOMElement()
  })
})
