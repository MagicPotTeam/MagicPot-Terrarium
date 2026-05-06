import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import { theme } from '@renderer/theme'
import CanvasSelectionActionToolbar from './CanvasSelectionActionToolbar'
import type { CanvasItem } from '../types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

function createImageItem(id: string): CanvasItem {
  return {
    id,
    type: 'image',
    src: `${id}.png`,
    x: 10,
    y: 20,
    width: 120,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false
  }
}

describe('CanvasSelectionActionToolbar', () => {
  it('keeps the exact-group toolbar and suppresses the generic selection stack', () => {
    const selectedItems = [createImageItem('image-1'), createImageItem('image-2')]
    const onDragSelectedItems = vi.fn()
    const onSendSelectedItems = vi.fn()
    const onChatSelectedItems = vi.fn()
    const onGenerateSelectedItems = vi.fn()

    const { container } = render(
      <ThemeProvider theme={theme}>
        <CanvasSelectionActionToolbar
          exactSelectedGroup={{
            id: 'group-1',
            name: 'Exact Group',
            bounds: { x: 40, y: 60, width: 320, height: 180 },
            validItems: selectedItems
          }}
          selectedItems={selectedItems}
          canCreateGroupFromSelection={false}
          selectionActionStackPosition={{ left: 12, top: 24 }}
          stagePos={{ x: 8, y: 16 }}
          stageScale={1}
          onDragSelectedItems={onDragSelectedItems}
          onCopySelectedItems={vi.fn()}
          onDownloadSelectedItems={vi.fn()}
          onSendSelectedItems={onSendSelectedItems}
          onChatSelectedItems={onChatSelectedItems}
          onGenerateSelectedItems={onGenerateSelectedItems}
          onCreateGroupFromSelection={vi.fn()}
        />
      </ThemeProvider>
    )

    expect(container.querySelector('.group-action-toolbar')).toBeTruthy()
    expect(container.querySelector('.selection-action-stack')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(6)

    const toolbarButtons = container.querySelectorAll('.group-action-toolbar button')
    fireEvent.dragStart(toolbarButtons.item(0) as HTMLElement, {
      dataTransfer: {}
    })
    fireEvent.click(toolbarButtons.item(3) as HTMLElement)
    fireEvent.click(toolbarButtons.item(4) as HTMLElement)
    fireEvent.click(toolbarButtons.item(5) as HTMLElement)

    expect(onDragSelectedItems).toHaveBeenCalledWith(selectedItems, expect.any(Object))
    expect(onSendSelectedItems).toHaveBeenCalledWith(expect.any(HTMLElement), selectedItems)
    expect(onChatSelectedItems).toHaveBeenCalledWith(selectedItems)
    expect(onGenerateSelectedItems).toHaveBeenCalledWith(selectedItems)
  })

  it('renders the generic multi-selection toolbar as a bottom action row', () => {
    const selectedItems = [createImageItem('image-1')]

    const { container } = render(
      <ThemeProvider theme={theme}>
        <CanvasSelectionActionToolbar
          exactSelectedGroup={null}
          selectedItems={selectedItems}
          canCreateGroupFromSelection={false}
          selectionActionStackPosition={{ left: 120, top: 240 }}
          stagePos={{ x: 8, y: 16 }}
          stageScale={1}
          onDragSelectedItems={vi.fn()}
          onCopySelectedItems={vi.fn()}
          onDownloadSelectedItems={vi.fn()}
          onSendSelectedItems={vi.fn()}
          onChatSelectedItems={vi.fn()}
          onGenerateSelectedItems={vi.fn()}
          onCreateGroupFromSelection={vi.fn()}
        />
      </ThemeProvider>
    )

    const toolbar = container.querySelector('.selection-action-stack') as HTMLElement | null
    expect(toolbar).toBeTruthy()
    expect(container.querySelector('.group-action-toolbar')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(6)
    expect(toolbar?.querySelectorAll('button')).toHaveLength(6)
  })

  it('keeps the group create action for multi-item generic selections', () => {
    const selectedItems = [createImageItem('image-1'), createImageItem('image-2')]

    const { container } = render(
      <ThemeProvider theme={theme}>
        <CanvasSelectionActionToolbar
          exactSelectedGroup={null}
          selectedItems={selectedItems}
          canCreateGroupFromSelection={true}
          selectionActionStackPosition={{ left: 12, top: 24 }}
          stagePos={{ x: 8, y: 16 }}
          stageScale={1}
          onDragSelectedItems={vi.fn()}
          onCopySelectedItems={vi.fn()}
          onDownloadSelectedItems={vi.fn()}
          onSendSelectedItems={vi.fn()}
          onChatSelectedItems={vi.fn()}
          onGenerateSelectedItems={vi.fn()}
          onCreateGroupFromSelection={vi.fn()}
        />
      </ThemeProvider>
    )

    expect(container.querySelectorAll('.selection-action-stack > *')).toHaveLength(7)
    expect(container.querySelector('.group-action-button')).toBeTruthy()
  })

  it('hides create-group when the selection overlaps an existing group', () => {
    const selectedItems = [createImageItem('image-1'), createImageItem('image-2')]

    const { container } = render(
      <ThemeProvider theme={theme}>
        <CanvasSelectionActionToolbar
          exactSelectedGroup={null}
          selectedItems={selectedItems}
          canCreateGroupFromSelection={false}
          selectionActionStackPosition={{ left: 12, top: 24 }}
          stagePos={{ x: 8, y: 16 }}
          stageScale={1}
          onDragSelectedItems={vi.fn()}
          onCopySelectedItems={vi.fn()}
          onDownloadSelectedItems={vi.fn()}
          onSendSelectedItems={vi.fn()}
          onChatSelectedItems={vi.fn()}
          onGenerateSelectedItems={vi.fn()}
          onCreateGroupFromSelection={vi.fn()}
        />
      </ThemeProvider>
    )

    expect(container.querySelector('.group-action-button')).toBeNull()
    expect(container.querySelectorAll('.selection-action-stack > *')).toHaveLength(6)
  })
})
