import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ProfilePanel from './ProfilePanel'
import { DEFAULT_MEDIA_STATE, DEFAULT_PARAMS } from './types'

describe('Hunyuan3D profile panel', () => {
  it('renders only the official template label and enum value', () => {
    render(
      <ProfilePanel
        params={{
          ...DEFAULT_PARAMS,
          apiAction: 'SubmitProfileTo3DJob',
          profileTemplate: 'basketball'
        }}
        mediaState={DEFAULT_MEDIA_STATE}
        onParamsChange={vi.fn()}
        onMediaStateChange={vi.fn()}
      />
    )

    expect(screen.getAllByText('动感球手').length).toBeGreaterThan(0)
    expect(screen.queryByText('basketball')).toBeNull()
    expect(screen.queryByRole('img', { name: '动感球手 模板预览图' })).toBeNull()

    fireEvent.mouseDown(screen.getByRole('combobox'))

    expect(screen.getAllByText('basketball').length).toBeGreaterThan(0)
    expect(screen.queryByText('热血 / 球场 / 腾跃')).toBeNull()
  })
})
