import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import QAppWorkshopPage from './QAppWorkshopPage'

vi.mock('react-router-dom', () => ({
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
    <div data-testid="workshop-redirect" data-to={to} data-replace={String(replace ?? false)} />
  )
}))

describe('QAppWorkshopPage', () => {
  it('redirects the workshop route straight to the custom app designer', () => {
    render(<QAppWorkshopPage />)

    expect(screen.getByTestId('workshop-redirect')).toHaveAttribute('data-to', '/qappdesign')
    expect(screen.getByTestId('workshop-redirect')).toHaveAttribute('data-replace', 'true')
  })
})
