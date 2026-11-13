import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentThreadLocalReminder from './AgentThreadLocalReminder'

const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project',
  threadId: 'pane'
} as const
const props = { route, conversationId: 'one', active: true }
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function createReminder() {
  fireEvent.click(screen.getByRole('button', { name: 'Local reminder' }))
  fireEvent.change(screen.getByLabelText('Reminder note'), {
    target: { value: 'Review the answer' }
  })
  fireEvent.change(screen.getByLabelText('Minutes from now'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm local reminder' }))
}

describe('local in-memory thread reminder', () => {
  it('connects the reminder toggle to its panel for assistive navigation', () => {
    render(<AgentThreadLocalReminder {...props} />)
    const toggle = screen.getByRole('button', { name: 'Local reminder' })
    const panelId = toggle.getAttribute('aria-controls')
    expect(panelId).toBeTruthy()
    expect(document.getElementById(panelId!)).not.toBeInTheDocument()

    fireEvent.click(toggle)

    const panel = screen.getByRole('region')
    expect(panel).toHaveAttribute('id', panelId)
    expect(panel).toHaveAttribute('aria-labelledby', toggle.id)
  })

  it('requires explicit confirmation and shows an in-page reminder once without automatic execution', () => {
    render(<AgentThreadLocalReminder {...props} />)
    createReminder()
    expect(screen.getByText(/Only while this conversation stays open/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('alert')).toHaveTextContent('Review the answer')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss and continue manually' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(120_000))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('does not silently replace a pending or due reminder', () => {
    render(<AgentThreadLocalReminder {...props} />)
    createReminder()
    expect(screen.getByRole('button', { name: 'Confirm local reminder' })).toBeDisabled()
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('button', { name: 'Confirm local reminder' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Review the answer')
  })
  it('keeps confirmed fields read-only and displays the scheduled snapshot and deadline', () => {
    render(<AgentThreadLocalReminder {...props} />)
    createReminder()
    expect(screen.getByLabelText('Reminder note')).toBeDisabled()
    expect(screen.getByLabelText('Minutes from now')).toBeDisabled()
    const scheduled = screen.getByRole('status')
    expect(scheduled).toHaveTextContent('Review the answer')
    expect(scheduled.querySelector('time')).toHaveAttribute('dateTime', '2026-01-01T12:01:00.000Z')
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('alert')).toHaveTextContent('Review the answer')
  })
  it('keeps an existing reminder on a temporary creation guard and prevents a new one until recovery', () => {
    const page = render(<AgentThreadLocalReminder {...props} allowCreate={true} />)
    createReminder()
    page.rerender(<AgentThreadLocalReminder {...props} allowCreate={false} />)
    expect(screen.getByRole('status')).toHaveTextContent('Review the answer')
    expect(screen.getByRole('button', { name: 'Confirm local reminder' })).toBeDisabled()
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('alert')).toHaveTextContent('Review the answer')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss and continue manually' }))
    expect(screen.getByLabelText('Reminder note')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Confirm local reminder' })).toBeDisabled()
    page.rerender(<AgentThreadLocalReminder {...props} allowCreate={true} />)
    expect(screen.getByLabelText('Reminder note')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Confirm local reminder' })).toBeEnabled()
  })
  it('returns focus to the stable reminder button after cancel or dismissal', () => {
    render(<AgentThreadLocalReminder {...props} />)
    createReminder()
    const toggle = screen.getByRole('button', { name: 'Local reminder' })
    const cancel = screen.getByRole('button', { name: 'Cancel reminder' })
    act(() => cancel.focus())
    fireEvent.click(cancel)
    expect(toggle).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm local reminder' }))
    act(() => vi.advanceTimersByTime(60_000))
    const dismiss = screen.getByRole('button', { name: 'Dismiss and continue manually' })
    act(() => dismiss.focus())
    fireEvent.click(dismiss)
    expect(toggle).toHaveFocus()
  })
  it('discloses page-only delivery, no system notification and possible delay before confirmation', () => {
    render(<AgentThreadLocalReminder {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Local reminder' }))
    expect(screen.getByText(/in-page only/i)).toBeInTheDocument()
    expect(screen.getByText(/no system notification or background wake/i)).toBeInTheDocument()
    expect(screen.getByText(/delivery may be delayed/i)).toBeInTheDocument()
  })
  it('clears a cancelled timer before scheduling the next reminder', () => {
    render(<AgentThreadLocalReminder {...props} />)
    createReminder()
    act(() => vi.advanceTimersByTime(30_000))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel reminder' }))
    fireEvent.change(screen.getByLabelText('Reminder note'), {
      target: { value: 'Second reminder' }
    })
    fireEvent.change(screen.getByLabelText('Minutes from now'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm local reminder' }))
    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Second reminder')
    act(() => vi.advanceTimersByTime(90_000))
    expect(screen.getByRole('alert')).toHaveTextContent('Second reminder')
  })
  it('shows a due reminder while collapsed and returns focus to the toggle after dismissal', () => {
    render(<AgentThreadLocalReminder {...props} />)
    createReminder()
    const toggle = screen.getByRole('button', { name: 'Local reminder' })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByLabelText('Reminder note')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('alert')).toHaveTextContent('Review the answer')
    const dismiss = screen.getByRole('button', { name: 'Dismiss and continue manually' })
    act(() => dismiss.focus())
    fireEvent.click(dismiss)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(toggle).toHaveFocus()
  })
  it('rejects invalid notes and delays', () => {
    render(<AgentThreadLocalReminder {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Local reminder' }))
    expect(screen.getByRole('button', { name: 'Confirm local reminder' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Reminder note'), { target: { value: 'note' } })
    fireEvent.change(screen.getByLabelText('Minutes from now'), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'Confirm local reminder' })).toBeDisabled()
  })
  it('cancels on conversation, pane or active state change and never appears in another scope', () => {
    const page = render(<AgentThreadLocalReminder {...props} />)
    createReminder()
    page.rerender(<AgentThreadLocalReminder {...props} conversationId="two" />)
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    createReminder()
    page.rerender(<AgentThreadLocalReminder {...props} route={{ ...route, threadId: 'other' }} />)
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    createReminder()
    page.rerender(<AgentThreadLocalReminder {...props} active={false} />)
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
