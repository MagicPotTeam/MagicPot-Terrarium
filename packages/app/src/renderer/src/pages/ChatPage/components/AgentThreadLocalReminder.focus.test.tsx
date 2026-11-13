import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentThreadLocalReminder from './AgentThreadLocalReminder'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const props = { route, conversationId: 'one', active: true }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T12:00:00Z')) })
afterEach(() => { cleanup(); vi.useRealTimers() })

function schedule() {
  fireEvent.click(screen.getByRole('button', { name: 'Local reminder' }))
  fireEvent.change(screen.getByLabelText('Reminder note'), { target: { value: 'Review answer' } })
  fireEvent.change(screen.getByLabelText('Minutes from now'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm local reminder' }))
}

describe('local reminder due focus', () => {
  it('moves focus from the removed cancel button to the manual dismissal when due', () => {
    render(<AgentThreadLocalReminder {...props} />)
    schedule()
    const cancel = screen.getByRole('button', { name: 'Cancel reminder' })
    act(() => cancel.focus())
    expect(cancel).toHaveFocus()
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.queryByRole('button', { name: 'Cancel reminder' })).not.toBeInTheDocument()
    const dismiss = screen.getByRole('button', { name: 'Dismiss and continue manually' })
    expect(dismiss).toBe(cancel)
    expect(dismiss).toHaveFocus()
    expect(screen.getByRole('alert')).toHaveTextContent('Review answer')
  })

  it('does not move focus when another control is focused at the due time', () => {
    render(<><button>Outside</button><AgentThreadLocalReminder {...props} /></>)
    schedule()
    const outside = screen.getByRole('button', { name: 'Outside' })
    act(() => outside.focus())
    act(() => vi.advanceTimersByTime(60_000))
    expect(outside).toHaveFocus()
    expect(screen.getByRole('alert')).toHaveTextContent('Review answer')
  })

  it('does not steal focus if it moves elsewhere between the timer callback and the render commit', () => {
    render(<><button>Outside</button><AgentThreadLocalReminder {...props} /></>)
    schedule()
    const cancel = screen.getByRole('button', { name: 'Cancel reminder' })
    const outside = screen.getByRole('button', { name: 'Outside' })
    act(() => cancel.focus())
    act(() => { vi.advanceTimersByTime(60_000); outside.focus() })
    expect(outside).toHaveFocus()
    expect(screen.getByRole('alert')).toHaveTextContent('Review answer')
  })
})
