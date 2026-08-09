import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import PanelAbout from './PanelAbout'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@renderer/components/ExternalLInk', () => ({
  default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

describe('PanelAbout', () => {
  it('renders pure about content without the updater card', () => {
    render(
      <PanelAbout settingsValue={DEFAULT_CONFIG} saveSettings={vi.fn()} onSelectTab={vi.fn()} />
    )

    expect(screen.getByText('about.version_label')).toBeInTheDocument()
    expect(screen.getByText('about.developer_label')).toBeInTheDocument()
    expect(screen.queryByText('about.update.title')).not.toBeInTheDocument()
  })
})
