import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import PanelShell from './PanelShell'

describe('Hunyuan3D panel shell', () => {
  it('renders a top-right icon-only submit button', () => {
    render(
      <PanelShell title="格式转换" submitLabel="开始转换" onSubmit={vi.fn()}>
        <div>Panel Content</div>
      </PanelShell>
    )

    expect(screen.getByText('格式转换')).toBeTruthy()
    expect(screen.getByRole('button', { name: '开始转换' })).toBeTruthy()
    expect(screen.queryByText('开始转换')).toBeNull()
  })
})
