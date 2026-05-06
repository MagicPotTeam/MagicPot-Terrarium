import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import WorkflowNavBar from './WorkflowNavBar'
import { WORKFLOW_STEPS } from './types'

describe('Hunyuan3D workflow nav bar', () => {
  it('renders full-width workflow rows and emits clicks for enabled steps', () => {
    const handleStepClick = vi.fn()

    render(<WorkflowNavBar activeStep="concept" onStepClick={handleStepClick} />)

    expect(screen.getByRole('button', { name: WORKFLOW_STEPS[0].label })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: WORKFLOW_STEPS[1].label }))

    expect(handleStepClick).toHaveBeenCalledWith('profile')
  })
})
