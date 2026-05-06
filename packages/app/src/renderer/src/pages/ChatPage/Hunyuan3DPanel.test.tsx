import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./hy3d/ConceptPanel', () => ({
  default: () => <div>Concept body</div>
}))

vi.mock('./hy3d/ProfilePanel', () => ({
  default: () => <div>Profile body</div>
}))

vi.mock('./hy3d/SplitPanel', () => ({
  default: () => <div>Split body</div>
}))

vi.mock('./hy3d/TopologyPanel', () => ({
  default: () => <div>Topology body</div>
}))

vi.mock('./hy3d/UVPanel', () => ({
  default: () => <div>UV body</div>
}))

vi.mock('./hy3d/TexturePanel', () => ({
  default: () => <div>Texture body</div>
}))

vi.mock('./hy3d/ConvertPanel', () => ({
  default: () => <div>Convert body</div>
}))

import Hunyuan3DPanel from './Hunyuan3DPanel'
import { DEFAULT_MEDIA_STATE, DEFAULT_PARAMS, WORKFLOW_STEPS } from './hy3d/types'

describe('Hunyuan3DPanel', () => {
  it('expands a workflow row and collapses it when the same row is clicked again', async () => {
    const onParamsChange = vi.fn()

    render(
      <Hunyuan3DPanel
        params={DEFAULT_PARAMS}
        mediaState={DEFAULT_MEDIA_STATE}
        onParamsChange={onParamsChange}
        onMediaStateChange={vi.fn()}
      />
    )

    expect(screen.getByText('Concept body')).toBeTruthy()

    const profileLabel = WORKFLOW_STEPS.find((step) => step.id === 'profile')?.label || ''
    const profileButton = screen.getByRole('button', { name: profileLabel })

    fireEvent.click(profileButton)

    expect(onParamsChange).toHaveBeenCalledWith({ apiAction: 'SubmitProfileTo3DJob' })
    expect(await screen.findByText('Profile body')).toBeTruthy()

    fireEvent.click(profileButton)

    await waitFor(() => {
      expect(screen.queryByText('Profile body')).toBeNull()
    })
  })
})
