import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RootErrorFallback } from './RootErrorFallback'

describe('RootErrorFallback', () => {
  it('preserves error details and reloads only when clicked', async () => {
    const reload = vi.fn()
    const error = new Error('fixture failure')
    render(<RootErrorFallback error={error} onReload={reload} />)
    expect(screen.getByRole('heading', { name: 'Renderer crashed' })).toBeInTheDocument()
    expect(document.querySelector('pre')?.textContent).toBe(error.stack)
    expect(screen.getByText('Reloading may cause unsaved changes to be lost.')).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Reload app' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('exposes a focusable native button activated by keyboard', async () => {
    const reload = vi.fn()
    const user = userEvent.setup()
    render(<RootErrorFallback error={new Error('fixture')} onReload={reload} />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Reload app' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(reload).toHaveBeenCalledTimes(1)
    await user.keyboard(' ')
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
