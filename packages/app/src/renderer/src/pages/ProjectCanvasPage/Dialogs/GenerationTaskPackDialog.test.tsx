import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import GenerationTaskPackDialog from './GenerationTaskPackDialog'

describe('GenerationTaskPackDialog', () => {
  it('renders document full content and the default 默认 Agent route note', () => {
    render(
      <GenerationTaskPackDialog
        open
        taskPack={{
          projectId: 'canvas-1',
          projectName: 'MagicPot Demo',
          selectedItemIds: ['doc-1'],
          summary: {
            totalItems: 1,
            requirementDocs: 1,
            referenceDocs: 0,
            referenceImages: 0,
            styleReferenceImages: 0,
            taskNotes: 0,
            existingAssets: 0
          },
          requirementDocs: [
            {
              id: 'doc-1',
              title: 'brief.docx',
              excerpt: 'short preview',
              contentText: 'Full document body from opened canvas doc.'
            }
          ],
          referenceDocs: [],
          referenceImages: [],
          styleReferenceImages: [],
          taskNotes: [],
          existingAssets: []
        }}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByText('brief.docx')).toBeInTheDocument()
    expect(screen.getByText('Full document body from opened canvas doc.')).toBeInTheDocument()
    expect(screen.getByText(/默认直接发送给默认 Agent/)).toBeInTheDocument()
  })

  it('surfaces the confirm action', () => {
    const onConfirm = vi.fn()

    render(
      <GenerationTaskPackDialog
        open
        taskPack={{
          projectId: 'canvas-1',
          projectName: 'MagicPot Demo',
          selectedItemIds: [],
          summary: {
            totalItems: 0,
            requirementDocs: 0,
            referenceDocs: 0,
            referenceImages: 0,
            styleReferenceImages: 0,
            taskNotes: 0,
            existingAssets: 0
          },
          requirementDocs: [],
          referenceDocs: [],
          referenceImages: [],
          styleReferenceImages: [],
          taskNotes: [],
          existingAssets: []
        }}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /默认 Agent/ }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
