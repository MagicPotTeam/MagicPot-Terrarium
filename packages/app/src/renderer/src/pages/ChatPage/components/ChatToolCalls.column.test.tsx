import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider, alpha, createTheme } from '@mui/material/styles'
import type { ToolHistoryEntry } from '@shared/llm/types'
import ChatToolCalls from './ChatToolCalls'

// Keys stand in for the text; a count is appended so the batch title can be checked.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`
  })
}))

const call = (
  id: string,
  toolName: string,
  status: ToolHistoryEntry['status'] = 'completed',
  patch: Partial<ToolHistoryEntry> = {}
): ToolHistoryEntry => ({
  runId: 'run',
  toolCallId: id,
  toolName,
  args: { path: `src/${id}.ts` },
  status,
  content: `RESULT_${id}`,
  ...patch
})
const cardContent = (card: Record<string, unknown>) =>
  JSON.stringify({
    contract: 'agent-thread-card-display/v1',
    status: 'provided',
    mode: 'display-only',
    card,
    untrustedData: true,
    grantsPermission: false
  })
const lines = (container: HTMLElement) => [...container.querySelectorAll('[data-chat-tool-line]')]
const batches = (container: HTMLElement) => [
  ...container.querySelectorAll('[data-chat-tool-batch]')
]
const five = [
  call('a', 'read'),
  call('b', 'grep'),
  call('c', 'read'),
  call('d', 'edit'),
  call('e', 'bash', 'failed', { error: 'exit code 1' })
]

describe('tool lines in the Agent column', () => {
  it('shows two calls as two one-line rows with key=value arguments and no status word', () => {
    const { container } = render(
      <ChatToolCalls
        history={[
          call('a', 'grep', 'completed', { args: { pattern: 'parse\\(', path: 'src' } }),
          call('b', 'bash', 'failed')
        ]}
        live={false}
        columnStyle
      />
    )
    expect(lines(container)).toHaveLength(2)
    expect(batches(container)).toHaveLength(0)
    const [first, second] = screen.getAllByRole('button')
    expect(first).toHaveAccessibleName('grep — chat.tool_call.status_completed')
    expect(first).toHaveTextContent('greppattern=parse\\( path=src')
    expect(first).not.toHaveTextContent('chat.tool_call.status_completed')
    expect(second).toHaveAccessibleName('bash — chat.tool_call.status_failed')
    expect(second).not.toHaveTextContent('chat.tool_call.status_failed')
    // Status changes the glyph only.
    expect(first.querySelector('[data-testid="CheckIcon"]')).not.toBeNull()
    expect(second.querySelector('[data-testid="CloseIcon"]')).not.toBeNull()
    expect(first.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('keeps the key=value line for a call whose arguments exceed the display text limit', () => {
    const content = Array.from(
      { length: 1500 },
      (_, index) => `line ${index}: value ${index}`
    ).join('\n')
    render(
      <ChatToolCalls
        history={[
          call('a', 'write', 'completed', { args: { path: 'src/big.ts', content } }),
          call('b', 'edit', 'completed', {
            args: {
              file_path: '/a/b.ts',
              old_string: 'o'.repeat(9000),
              new_string: 'n'.repeat(9000)
            }
          })
        ]}
        live={false}
        columnStyle
      />
    )
    const [write, edit] = screen.getAllByRole('button')
    expect(write).toHaveTextContent(
      `writepath=src/big.ts content=${content.replace(/\s+/g, ' ').slice(0, 50)}…`
    )
    expect(edit).toHaveTextContent(
      `editfile_path=/a/b.ts old_string=${'o'.repeat(50)}… new_string=${'n'.repeat(50)}…`
    )
    expect(write.textContent).not.toContain('{')
    // The expanded detail still shows the arguments as capped JSON with its truncation note.
    fireEvent.click(write)
    expect(screen.getByText('chat.tool_call.truncated')).toBeInTheDocument()
  })

  // jsdom resolves `font: inherit` over the later font-size, so the 12px text is checked in the real app.
  it('draws the header with the fixed tool tint at 28px with 8px corners', () => {
    const theme = createTheme({ palette: { mode: 'dark' } })
    const { container } = render(
      <ThemeProvider theme={theme}>
        <ChatToolCalls history={[call('a', 'read')]} live={false} columnStyle />
      </ThemeProvider>
    )
    const header = screen.getByRole('button')
    expect(header).toHaveStyle({
      backgroundColor: alpha('#0F52BA', 0.12),
      minHeight: '28px',
      padding: '6px 12px'
    })
    expect(lines(container)[0]).toHaveStyle({ borderRadius: '8px', overflow: 'hidden' })
    fireEvent.click(header)
    expect(screen.getByText('chat.tool_call.result').parentElement?.parentElement).toHaveStyle({
      backgroundColor: alpha('#0F52BA', 0.06)
    })
  })

  it('uses the lighter fixed tint on a light theme', () => {
    render(
      <ThemeProvider theme={createTheme({ palette: { mode: 'light' } })}>
        <ChatToolCalls history={[call('a', 'read')]} live={false} columnStyle />
      </ThemeProvider>
    )
    expect(screen.getByRole('button')).toHaveStyle({ backgroundColor: alpha('#0F52BA', 0.08) })
  })

  it('toggles from the whole header with click, Enter and Space and caps every section at 16rem', async () => {
    const user = userEvent.setup()
    render(<ChatToolCalls history={[call('a', 'read')]} live={false} columnStyle />)
    const header = screen.getByRole('button')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('RESULT_a')).not.toBeInTheDocument()
    await user.tab()
    expect(header).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('RESULT_a')).toHaveStyle({ maxHeight: '16rem', overflowY: 'auto' })
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'chat.tool_call.arguments',
      'chat.tool_call.result'
    ])
    await user.keyboard(' ')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('keeps a failed call collapsed and shows its error only on demand', () => {
    render(
      <ChatToolCalls
        history={[
          call('a', 'bash', 'failed', {
            content: '<img src="https://external.invalid/x">',
            error: 'exit code 1'
          })
        ]}
        live={false}
        columnStyle
      />
    )
    const header = screen.getByRole('button')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('exit code 1')).not.toBeInTheDocument()
    fireEvent.click(header)
    expect(screen.getByText('exit code 1')).toBeInTheDocument()
    expect(screen.getByText('chat.tool_call.error')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  it('masks credentials in the one-line summary and in the detail without changing the receipt', () => {
    const entry = call('a', 'web_fetch', 'completed', {
      args: {
        url: 'https://example.invalid',
        token: 'PRIVATE_TOKEN',
        db_password: 'PRIVATE_JOINED'
      },
      content: '{"password":"PRIVATE_PASS"}'
    })
    render(<ChatToolCalls history={[entry]} live={false} columnStyle />)
    expect(screen.getByRole('button')).toHaveTextContent('token=[redacted]')
    expect(document.body.textContent).not.toMatch(/PRIVATE_(?:TOKEN|JOINED)/)
    fireEvent.click(screen.getByRole('button'))
    expect(document.body.textContent).not.toContain('PRIVATE_TOKEN')
    expect(document.body.textContent).not.toContain('PRIVATE_PASS')
    expect(entry.args.token).toBe('PRIVATE_TOKEN')
  })

  it('shows a saved unfinished call with a neutral glyph and explains it only when expanded', () => {
    render(
      <ChatToolCalls
        history={[call('a', 'web_fetch', 'running', { content: undefined })]}
        live={false}
        columnStyle
      />
    )
    const header = screen.getByRole('button', { name: /chat.tool_call.status_unknown/ })
    expect(header.querySelector('[data-testid="RemoveIcon"]')).not.toBeNull()
    expect(header).not.toHaveTextContent('chat.tool_call.status_unknown')
    fireEvent.click(header)
    expect(screen.getByText('chat.tool_call.no_result')).toBeInTheDocument()
    expect(screen.getByText('chat.tool_call.unknown_notice')).toBeInTheDocument()
  })

  it('shows a running call with the working glyph while live and a cancelled one with a hollow circle', () => {
    render(
      <ChatToolCalls
        history={[
          call('a', 'bash', 'running', { content: undefined }),
          call('b', 'edit', 'cancelled')
        ]}
        live
        columnStyle
      />
    )
    const [running, cancelled] = screen.getAllByRole('button')
    expect(running.querySelector('[data-testid="SettingsIcon"]')).not.toBeNull()
    expect(cancelled.querySelector('[data-testid="RadioButtonUncheckedIcon"]')).not.toBeNull()
    fireEvent.click(running)
    expect(screen.getByText('chat.tool_call.waiting')).toBeInTheDocument()
  })

  it('folds five calls into one batch line with a name summary and a failure badge', () => {
    const { container } = render(<ChatToolCalls history={five} live={false} columnStyle />)
    expect(batches(container)).toHaveLength(1)
    expect(lines(container)).toHaveLength(0)
    const header = screen.getByRole('button')
    expect(header).toHaveAccessibleName('chat.tool_call.batch_expand:5')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(header).toHaveTextContent('chat.tool_call.batch_title:5read ×2, grep, edit, bash1')
    // The failure decides the aggregate glyph and is counted in a badge.
    expect(batches(container)[0]).toHaveAttribute('data-chat-tool-batch', 'failed')
    const badges = [...header.querySelectorAll('[data-tool-batch-badge]')]
    expect(
      badges.map((badge) => [badge.getAttribute('data-tool-batch-badge'), badge.textContent])
    ).toEqual([['failed', '1']])
  })

  it('lists more than four tool names as a remainder', () => {
    const many = ['read', 'grep', 'edit', 'bash', 'glob', 'write'].map((name, index) =>
      call(String(index), name)
    )
    render(<ChatToolCalls history={many} live={false} columnStyle />)
    expect(screen.getByRole('button')).toHaveTextContent(
      'chat.tool_call.batch_title:6read, grep, edit, bash, chat.tool_call.batch_more:2'
    )
  })

  it('expands a batch into its own capped list where every line keeps its own state', () => {
    const { container } = render(<ChatToolCalls history={five} live={false} columnStyle />)
    fireEvent.click(screen.getByRole('button'))
    const header = screen.getByRole('button', { name: 'chat.tool_call.batch_collapse:5' })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    const list = container.querySelector('[data-chat-tool-batch-list]') as HTMLElement
    expect(list).toHaveStyle({
      maxHeight: '18rem',
      overflowY: 'auto',
      gap: '4px',
      padding: '6px 8px'
    })
    expect(lines(list)).toHaveLength(5)
    const inner = within(list).getAllByRole('button')
    expect(inner.map((button) => button.getAttribute('aria-expanded'))).toEqual(
      Array(5).fill('false')
    )
    fireEvent.click(inner[1])
    expect(screen.getByText('RESULT_b')).toBeInTheDocument()
    expect(screen.queryByText('RESULT_a')).not.toBeInTheDocument()
    expect(
      within(list)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-expanded'))
    ).toEqual(['false', 'true', 'false', 'false', 'false'])
    // Collapsing and reopening the batch keeps the inner line open.
    fireEvent.click(header)
    expect(screen.queryByText('RESULT_b')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('RESULT_b')).toBeInTheDocument()
  })

  it('keeps an expanded batch and an expanded line open while more calls stream in', () => {
    const view = render(<ChatToolCalls history={five.slice(0, 2)} live columnStyle />)
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(screen.getByText('RESULT_a')).toBeInTheDocument()
    // The third call turns the two lines into a batch; the open line stays open inside it.
    view.rerender(<ChatToolCalls history={five.slice(0, 3)} live columnStyle />)
    expect(batches(view.container)).toHaveLength(1)
    expect(screen.queryByText('RESULT_a')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('RESULT_a')).toBeInTheDocument()
    view.rerender(<ChatToolCalls history={five} live columnStyle />)
    expect(screen.getByRole('button', { name: 'chat.tool_call.batch_collapse:5' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(lines(view.container)).toHaveLength(5)
    expect(screen.getByText('RESULT_a')).toBeInTheDocument()
  })

  it('counts running and cancelled calls in badges and lets the running one decide the glyph', () => {
    const history = [
      call('a', 'read'),
      call('b', 'bash', 'running'),
      call('c', 'edit', 'cancelled'),
      call('d', 'bash', 'failed')
    ]
    const { container } = render(<ChatToolCalls history={history} live columnStyle />)
    expect(batches(container)[0]).toHaveAttribute('data-chat-tool-batch', 'running')
    expect(
      [...container.querySelectorAll('[data-tool-batch-badge]')].map((badge) =>
        badge.getAttribute('data-tool-batch-badge')
      )
    ).toEqual(['running', 'failed', 'cancelled'])
  })

  it('keeps a display card visible under its own line, outside any batch and without an explanatory paragraph', () => {
    const card = {
      title: 'Provided status card',
      body: 'Read only body',
      accent: 'success',
      footer: 'Closing'
    }
    const history = [
      call('a', 'read'),
      call('b', 'grep'),
      call('card', 'show_card', 'completed', {
        args: { title: 'ignored' },
        content: cardContent(card)
      }),
      call('c', 'read'),
      call('d', 'edit'),
      call('e', 'bash')
    ]
    const theme = createTheme({ palette: { mode: 'dark', success: { main: '#3579bd' } } })
    const { container } = render(
      <ThemeProvider theme={theme}>
        <ChatToolCalls history={history} live={false} columnStyle />
      </ThemeProvider>
    )
    // Two lines, the card line, then one batch of three.
    expect(lines(container)).toHaveLength(3)
    expect(batches(container)).toHaveLength(1)
    const title = screen.getByRole('heading', { name: card.title })
    expect(screen.getByText('Read only body')).toBeInTheDocument()
    expect(title.parentElement).toHaveStyle({
      padding: '10px 12px',
      borderColor: alpha('#3579bd', 0.4)
    })
    expect(screen.queryByText('chat.tool_call.card_display_notice')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /show_card — chat.tool_call.status_completed/ })
    ).toHaveAttribute('aria-expanded', 'false')
    // Display only: header toggles are the only controls.
    expect(screen.getAllByRole('button')).toHaveLength(4)
    expect(container.querySelector('a,img,input,textarea,script,iframe')).toBeNull()
  })

  it('does not treat an unsettled or invalid card receipt as pinned content', () => {
    const history = [
      call('a', 'show_card', 'failed', { content: cardContent({ title: 'Not shown' }) }),
      call('b', 'show_card', 'completed', { content: '{invalid json' }),
      call('c', 'read')
    ]
    const { container } = render(<ChatToolCalls history={history} live={false} columnStyle />)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(batches(container)).toHaveLength(1)
    expect(screen.getByRole('button')).toHaveTextContent('chat.tool_call.batch_title:3')
  })

  it('leaves the full-page chat as it was: separate rows with a status word and no batch', () => {
    const { container } = render(<ChatToolCalls history={five} live={false} />)
    expect(batches(container)).toHaveLength(0)
    expect(lines(container)).toHaveLength(0)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(5)
    expect(buttons[0]).toHaveTextContent('chat.tool_call.status_completed')
    expect(buttons[4]).toHaveTextContent('chat.tool_call.status_failed')
  })

  it('renders nothing without tool records', () => {
    expect(render(<ChatToolCalls live={false} columnStyle />).container).toBeEmptyDOMElement()
  })
})
