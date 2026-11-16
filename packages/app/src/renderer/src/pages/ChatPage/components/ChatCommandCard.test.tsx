import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, alpha, createTheme } from '@mui/material/styles'
import { Button } from '@mui/material'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChatCommandResultCard,
  CommandCardActions,
  CommandCardList,
  CommandCardNote,
  CommandCardPanelBody,
  CommandCardText
} from './ChatCommandCard'
import { ChatPromptCard } from './ChatPromptCard'

const theme = createTheme({
  palette: { mode: 'dark', warning: { main: '#ddaa00' }, error: { main: '#ee4444' } }
})
const show = (node: React.ReactElement) =>
  render(<ThemeProvider theme={theme}>{node}</ThemeProvider>)
afterEach(cleanup)

describe('ChatCommandResultCard', () => {
  it('is a left-aligned card of at most 90% with the command in bold monospace and no close button', () => {
    show(
      <ChatCommandResultCard command="/status" title="3 messages">
        <CommandCardText mono>{'{ "messages": 3 }'}</CommandCardText>
      </ChatCommandResultCard>
    )
    const card = screen.getByTestId('chat-command-card')
    expect(card.tagName).toBe('SECTION')
    // The transcript tail is the live region; a card does not announce itself a second time.
    expect(card).not.toHaveAttribute('aria-live')
    expect(card).toHaveAttribute('data-command', '/status')
    expect(card).toHaveStyle({ maxWidth: '90%', alignSelf: 'flex-start', borderRadius: '8px' })
    // A raised surface only: no outline around the card and no rule under its header.
    expect(card).toHaveStyle({ backgroundColor: 'rgba(255,255,255,0.08)' })
    expect(getComputedStyle(card).borderTopWidth).toMatch(/^(0(px)?)?$/)
    expect(getComputedStyle(card.querySelector('header')!).borderBottomWidth).toMatch(/^(0(px)?)?$/)
    expect(card.querySelector('header')).toHaveStyle({ padding: '8px 12px' })
    expect(card).not.toHaveStyle({ width: '90%' })
    const command = within(card).getByTestId('chat-command-card-command')
    expect(command.tagName).toBe('CODE')
    expect(command).toHaveTextContent('/status')
    expect(command).toHaveStyle({ fontSize: '12px', fontWeight: '600' })
    expect(within(card).getByTestId('chat-command-card-title')).toHaveStyle({ fontSize: '11px' })
    expect(within(card).getByTestId('chat-command-card-title')).toHaveTextContent('3 messages')
    expect(card.querySelector('header svg')).toHaveAttribute('aria-hidden', 'true')
    expect(within(card).queryByRole('button')).toBeNull()
  })

  it('caps a text body at 16rem with its own scroll and draws raw output in monospace', () => {
    show(
      <ChatCommandResultCard command="/env">
        <CommandCardText mono>raw output</CommandCardText>
      </ChatCommandResultCard>
    )
    const body = screen.getByTestId('chat-command-card-text')
    expect(body).toHaveStyle({ maxHeight: '16rem', overflowY: 'auto', fontSize: '12px' })
    expect(getComputedStyle(body).fontFamily).toContain('monospace')
    expect(screen.queryByTestId('chat-command-card-title')).toBeNull()
  })

  it('shows a failed command with the error text in the error colour, announced as an alert', () => {
    show(
      <ChatCommandResultCard command="/jobs" error>
        <CommandCardText error>Could not read the jobs.</CommandCardText>
      </ChatCommandResultCard>
    )
    expect(screen.getByTestId('chat-command-card')).toHaveAttribute('data-error', 'true')
    expect(getComputedStyle(screen.getByTestId('chat-command-card')).borderTopWidth).toMatch(
      /^(0(px)?)?$/
    )
    expect(
      getComputedStyle(screen.getByTestId('chat-command-card').querySelector('svg')!).color
    ).toBe('rgb(238, 68, 68)')
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read the jobs.')
    expect(screen.getByRole('alert')).toHaveStyle({ color: '#ee4444' })
  })

  it('lists rows with a muted second line and scrolls the list on its own', () => {
    show(
      <ChatCommandResultCard command="/jobs">
        <CommandCardList
          items={[
            { key: 'a', label: 'explore', description: 'running · a1' },
            { key: 'b', label: 'critic' }
          ]}
        />
        <CommandCardNote>Two jobs</CommandCardNote>
      </ChatCommandResultCard>
    )
    const list = screen.getByRole('list')
    expect(list).toHaveStyle({ maxHeight: '16rem', overflowY: 'auto' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('explorerunning · a1')
    expect(within(rows[0]).getByText('running · a1')).toHaveStyle({ fontSize: '11px' })
    // No rules between the rows.
    expect(getComputedStyle(rows[0]).borderBottomWidth).toMatch(/^(0(px)?)?$/)
    expect(screen.getByTestId('chat-command-card-note')).toHaveStyle({ fontSize: '11px' })
  })

  it('gives a row its own text links under its lines', async () => {
    const stop = vi.fn()
    const read = vi.fn()
    show(
      <ChatCommandResultCard command="/jobs">
        <CommandCardList
          items={[
            {
              key: 'a',
              label: 'explore',
              description: 'running · a1',
              actions: [{ key: 'stop', label: 'Stop', onClick: stop }]
            },
            {
              key: 'b',
              label: 'critic',
              description: 'done · b1\nsecond line',
              actions: [{ key: 'read', label: 'Read result', onClick: read }]
            }
          ]}
        />
      </ChatCommandResultCard>
    )
    const rows = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(within(rows[0]).getByTestId('chat-command-card-item-actions')).toHaveStyle({ flexWrap: 'wrap' })
    expect(within(rows[1]).getByText(/done · b1/)).toHaveStyle({ whiteSpace: 'pre-line' })
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Stop' }))
    expect(stop).toHaveBeenCalledTimes(1)
    within(rows[1]).getByRole('button', { name: 'Read result' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(read).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('offers where a command hands over as text buttons in a wrapping row', async () => {
    const open = vi.fn()
    show(
      <ChatCommandResultCard command="/plugin">
        <CommandCardActions
          actions={[{ key: 'open', label: 'Open plugin center', onClick: open }]}
        />
      </ChatCommandResultCard>
    )
    expect(screen.getByTestId('chat-command-card-actions')).toHaveStyle({ flexWrap: 'wrap' })
    const button = screen.getByRole('button', { name: 'Open plugin center' })
    expect(getComputedStyle(button).borderTopWidth).toMatch(/^0(px)?$/)
    button.focus()
    await userEvent.keyboard('{Enter}')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('takes the full 90% when its body holds a form', () => {
    show(
      <ChatCommandResultCard command="/goal" title="Thread goals" fill>
        <CommandCardPanelBody />
      </ChatCommandResultCard>
    )
    expect(screen.getByTestId('chat-command-card')).toHaveStyle({ width: '90%', maxWidth: '90%' })
  })

  it('gives an embedded view the card sizes and a 16rem scroll box', () => {
    show(
      <ChatCommandResultCard command="/goal">
        <CommandCardPanelBody>
          <span>records</span>
        </CommandCardPanelBody>
      </ChatCommandResultCard>
    )
    expect(screen.getByTestId('chat-command-card-panel')).toHaveStyle({
      maxHeight: '16rem',
      overflowY: 'auto',
      fontSize: '12px'
    })
  })

  it('outlines the buttons of an embedded view with a colour that shows on the card in the light theme', () => {
    const light = createTheme({ palette: { mode: 'light' } })
    render(
      <ThemeProvider theme={light}>
        <ChatCommandResultCard command="/skills">
          <CommandCardPanelBody>
            <Button>Refresh</Button>
          </CommandCardPanelBody>
        </ChatCommandResultCard>
      </ThemeProvider>
    )
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    // jsdom does not weigh the selectors of nested rules: read the rule itself.
    const rules = [...document.querySelectorAll('style')].map((style) => style.textContent).join('')
    const outline = alpha(light.palette.text.primary, 0.3)
    expect(outline).toBe('rgba(0, 0, 0, 0.3)')
    expect(rules).toMatch(/ \.MuiButton-root\{[^}]*border:1px solid rgba\(0, 0, 0, 0\.3\);/)
    expect(outline).not.toBe(light.palette.divider)
  })
})

describe('ChatPromptCard', () => {
  const options = (onConfirm = vi.fn(), onCancel = vi.fn()) => [
    { key: 'confirm', label: 'New conversation', primary: true, onSelect: onConfirm },
    { key: 'cancel', label: 'Cancel', onSelect: onCancel }
  ]

  it('is a bordered card with a title, the prompt, a muted detail and a wrapping row of buttons', () => {
    show(
      <ChatPromptCard
        title="Confirm"
        accent="warning"
        prompt="A new conversation is created."
        detail="The original stays."
        options={options()}
      />
    )
    const card = screen.getByRole('group', { name: 'Confirm' })
    expect(card).toHaveStyle({
      borderStyle: 'solid',
      borderWidth: '1px',
      borderRadius: '8px',
      padding: '10px 12px',
      margin: '8px 0px',
      opacity: '1'
    })
    expect(card).toHaveStyle({ borderColor: alpha('#ddaa00', 0.4) })
    expect(within(card).getByTestId('chat-prompt-card-title')).toHaveStyle({
      fontSize: '12px',
      fontWeight: '500'
    })
    expect(within(card).getByTestId('chat-prompt-card-prompt')).toHaveStyle({ fontSize: '14px' })
    expect(within(card).getByTestId('chat-prompt-card-detail')).toHaveStyle({ fontSize: '12px' })
    expect(within(card).getByTestId('chat-prompt-card-options')).toHaveStyle({ flexWrap: 'wrap' })
    const [confirm, cancel] = within(card).getAllByRole('button')
    expect(confirm).toHaveAttribute('data-primary', 'true')
    expect(getComputedStyle(confirm).backgroundColor).not.toMatch(
      /^(|transparent|rgba\(0, 0, 0, 0\))$/
    )
    expect(getComputedStyle(cancel).backgroundColor).toMatch(/^(|transparent|rgba\(0, 0, 0, 0\))$/)
    expect(within(card).queryByTestId('chat-prompt-card-state')).toBeNull()
  })

  it('answers with the mouse and with the keyboard', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    show(<ChatPromptCard title="Confirm" prompt="Go?" options={options(onConfirm, onCancel)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)

    const user = userEvent.setup()
    await user.tab()
    expect(screen.getByRole('button', { name: 'New conversation' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onConfirm).toHaveBeenCalledTimes(2)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('once answered is dimmed, names the state and shows the reply instead of the controls', () => {
    show(
      <ChatPromptCard
        title="Confirm"
        prompt="Go?"
        options={options()}
        resolution={{ state: 'answered', reply: 'New conversation' }}
      >
        <input aria-label="extra control" />
      </ChatPromptCard>
    )
    const card = screen.getByRole('group', { name: 'Confirm' })
    expect(card).toHaveStyle({ opacity: '0.55' })
    expect(card).toHaveAttribute('data-resolved', 'true')
    expect(within(card).getByTestId('chat-prompt-card-state')).toHaveTextContent('answered')
    expect(within(card).getByTestId('chat-prompt-card-state')).toHaveStyle({ fontSize: '10px' })
    expect(within(card).getByTestId('chat-prompt-card-reply')).toHaveTextContent(
      '→ New conversation'
    )
    expect(within(card).getByTestId('chat-prompt-card-reply')).toHaveStyle({ fontStyle: 'italic' })
    expect(within(card).queryByRole('button')).toBeNull()
    expect(within(card).queryByRole('textbox')).toBeNull()
  })

  it('takes custom controls for cards that ask for more than a choice', () => {
    show(
      <ChatPromptCard title="Input requested" prompt="Name?">
        <input aria-label="reply" />
      </ChatPromptCard>
    )
    expect(screen.getByRole('textbox', { name: 'reply' })).toBeInTheDocument()
    expect(screen.queryByTestId('chat-prompt-card-options')).toBeNull()
  })
})
