import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DsnIcon from './DsnIcon'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key
  })
}))

describe('DsnIcon', () => {
  it('falls back to Chinese icon copy when translations are missing', () => {
    render(<DsnIcon value="" setValue={vi.fn()} />)

    expect(screen.getByText('暂无封面图')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上传快应用封面图' })).toBeInTheDocument()
  })

  it('shows the Chinese remove action when an icon exists', () => {
    render(<DsnIcon value="data:image/png;base64,test" setValue={vi.fn()} />)

    expect(screen.getByRole('button', { name: '移除封面图' })).toBeInTheDocument()
  })
})
