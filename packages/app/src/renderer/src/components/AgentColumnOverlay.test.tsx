import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import zhLocale from '@shared/locales/zh-CN/renderer.json'
import AgentColumnOverlay, { type AgentColumnOverlayProps } from './AgentColumnOverlay'

const translate = (key: string) => {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      zhLocale
    )
  return typeof value === 'string' ? value : key
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))

function Harness(props: Partial<AgentColumnOverlayProps> & { host?: HTMLElement | null }) {
  const [open, setOpen] = useState(false)
  const { host, ...rest } = props
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <AgentColumnOverlay
        open={open}
        container={host}
        label="Model switcher"
        top={<input aria-label="search" />}
        onClose={() => setOpen(false)}
        primary={{ label: 'Switch', onClick: vi.fn() }}
        {...rest}
      >
        <p>content</p>
      </AgentColumnOverlay>
    </>
  )
}

describe('AgentColumnOverlay', () => {
  it('opens a sheet with its top row, content and a Cancel + primary footer', () => {
    render(<Harness />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    const dialog = screen.getByRole('dialog', { name: 'Model switcher' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByRole('textbox', { name: 'search' })).toBeInTheDocument()
    expect(within(dialog).getByText('content')).toBeInTheDocument()
    const footer = within(dialog).getByTestId('agent-column-overlay-footer')
    expect(
      within(footer)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['取消', 'Switch'])
  })

  it('moves the focus in, and Escape returns it to the opener', async () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'open' })
    act(() => opener.focus())
    fireEvent.click(opener)
    const search = screen.getByRole('textbox', { name: 'search' })
    await waitFor(() => expect(search).toHaveFocus())
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('Cancel closes and returns the focus; the page callback replaces the opener', async () => {
    const onReturnFocus = vi.fn()
    render(<Harness onReturnFocus={onReturnFocus} initialFocus="cancel" />)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    const cancel = screen.getByRole('button', { name: '取消' })
    await waitFor(() => expect(cancel).toHaveFocus())
    fireEvent.click(cancel)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onReturnFocus).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape while composing, after a nested control handled it, or from elsewhere', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'search' }), {
      key: 'Escape',
      isComposing: true
    })
    const nested = document.createElement('button')
    dialog.append(nested)
    nested.addEventListener('keydown', (event) => event.preventDefault())
    fireEvent.keyDown(nested, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBe(dialog)
  })

  it('closes on a click on the dimmed column but not on the sheet', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByTestId('agent-column-overlay-scrim'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps Tab inside the sheet and disables the primary button on request', () => {
    render(<Harness primary={{ label: 'Switch', disabled: true, onClick: vi.fn() }} />)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(screen.getByRole('button', { name: 'Switch' })).toBeDisabled()
    const cancel = screen.getByRole('button', { name: '取消' })
    act(() => cancel.focus())
    fireEvent.keyDown(cancel, { key: 'Tab' })
    expect(screen.getByRole('textbox', { name: 'search' })).toHaveFocus()
  })

  it('draws into the column host when one is given', () => {
    const host = document.createElement('div')
    host.setAttribute('data-testid', 'host')
    document.body.append(host)
    try {
      render(<Harness host={host} />)
      fireEvent.click(screen.getByRole('button', { name: 'open' }))
      expect(host).toContainElement(screen.getByRole('dialog'))
    } finally {
      host.remove()
    }
  })

  it('does not take the focus back when it already moved elsewhere', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    try {
      render(<Harness />)
      const opener = screen.getByRole('button', { name: 'open' })
      act(() => opener.focus())
      fireEvent.click(opener)
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'search' })).toHaveFocus())
      act(() => outside.focus())
      fireEvent.click(screen.getByRole('button', { name: '取消' }))
      expect(outside).toHaveFocus()
    } finally {
      outside.remove()
    }
  })

  it('gives the focus back when its owner closes or drops it while it holds the focus', async () => {
    const composer = document.createElement('textarea')
    document.body.append(composer)
    const onReturnFocus = vi.fn(() => composer.focus())
    const view = (open: boolean, mounted = true) =>
      mounted ? (
        <AgentColumnOverlay
          open={open}
          label="Form"
          onClose={vi.fn()}
          onReturnFocus={onReturnFocus}
        >
          <input aria-label="name" />
        </AgentColumnOverlay>
      ) : (
        <p>gone</p>
      )
    const page = render(view(true))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'name' })).toHaveFocus())
    // Closed by its owner (a finished creation): the focused field goes away with it.
    page.rerender(view(false))
    expect(onReturnFocus).toHaveBeenCalledTimes(1)
    page.rerender(view(true))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'name' })).toHaveFocus())
    // Dropped while open (the owner is re-keyed or unmounted).
    vi.useFakeTimers()
    try {
      page.rerender(view(true, false))
      act(() => {
        vi.runOnlyPendingTimers()
      })
    } finally {
      vi.useRealTimers()
    }
    expect(onReturnFocus).toHaveBeenCalledTimes(2)
    expect(composer).toHaveFocus()
    composer.remove()
  })
})
