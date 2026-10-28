import { render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import WorkshopModelsPage from './WorkshopModelsPage'

vi.mock('./components/CustomWorkshopTabs', () => ({
  default: () => <div data-testid="custom-workshop-tabs" />
}))

vi.mock('../FileBrowserPage/ModelPage', () => ({
  default: () => <div data-testid="model-page" />
}))

const LocationDisplay = () => {
  const location = useLocation()
  return (
    <div data-testid="location-display">
      {location.pathname}
      {location.search}
      {location.hash}
    </div>
  )
}

describe('WorkshopModelsPage', () => {
  it('redirects the legacy model route to the canonical workshop route', () => {
    render(
      <MemoryRouter initialEntries={['/model']}>
        <WorkshopModelsPage />
        <LocationDisplay />
      </MemoryRouter>
    )

    expect(screen.getByTestId('location-display')).toHaveTextContent('/workshop/models')
  })

  it('preserves the legacy route query and hash during canonical redirect', () => {
    render(
      <MemoryRouter initialEntries={['/model?tab=loras#library']}>
        <WorkshopModelsPage />
        <LocationDisplay />
      </MemoryRouter>
    )

    expect(screen.getByTestId('location-display')).toHaveTextContent(
      '/workshop/models?tab=loras#library'
    )
  })

  it('composes the workshop tabs with the existing model page', () => {
    render(
      <MemoryRouter initialEntries={['/workshop/models']}>
        <WorkshopModelsPage />
      </MemoryRouter>
    )

    expect(screen.getByTestId('custom-workshop-tabs')).toBeInTheDocument()
    expect(screen.getByTestId('model-page')).toBeInTheDocument()
  })
})
