import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import { theme } from '@renderer/theme'
import CanvasSelectionActionToolbar from './CanvasSelectionActionToolbar'
import type { CanvasTranslate } from '../canvasTranslation'
import type { CanvasItem } from '../types'

function createTranslate(): CanvasTranslate {
  const translate = (key: string, options?: Record<string, unknown>) => {
    switch (key) {
      case 'canvas.action_send':
        return 'Send'
      case 'canvas.action_send_agent':
        return 'Send selected items to Agent'
      case 'canvas.action_generate_from_selection':
        return 'Generate from selection'
      case 'canvas.group_create_button':
        return 'Group'
      default:
        return key
    }
  }
  return translate as CanvasTranslate
}

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
          t={createTranslate()}
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

    const toolbar = container.querySelector('.group-action-toolbar') as HTMLElement
    const toolbarButtons = within(toolbar).getAllByRole('button')
    const sendButton = within(toolbar).getByRole('button', { name: 'Send' })
    const agentButton = within(toolbar).getByRole('button', {
      name: 'Send selected items to Agent'
    })
    const generateButton = within(toolbar).getByRole('button', { name: 'Generate from selection' })

    expect(toolbarButtons.at(-1)).toBe(agentButton)
    expect(toolbarButtons.at(-2)).toBe(generateButton)
    fireEvent.dragStart(toolbarButtons[0], {
      dataTransfer: {}
    })
    expect(onDragSelectedItems).toHaveBeenCalledWith(selectedItems, expect.any(Object))

    fireEvent.click(sendButton)
    expect(onSendSelectedItems).toHaveBeenCalledWith(sendButton, selectedItems)
    expect(onChatSelectedItems).not.toHaveBeenCalled()
    expect(onGenerateSelectedItems).not.toHaveBeenCalled()

    fireEvent.click(agentButton)
    expect(onChatSelectedItems).toHaveBeenCalledWith(selectedItems)
    expect(onSendSelectedItems).toHaveBeenCalledTimes(1)
    expect(onGenerateSelectedItems).not.toHaveBeenCalled()

    fireEvent.click(generateButton)
    expect(onGenerateSelectedItems).toHaveBeenCalledWith(selectedItems)
    expect(onChatSelectedItems).toHaveBeenCalledTimes(1)
  })

  it('keeps Agent last in the generic selection row without a group action', () => {
    const selectedItems = [createImageItem('image-1'), createImageItem('image-2')]
    const onSendSelectedItems = vi.fn()
    const onChatSelectedItems = vi.fn()
    const onGenerateSelectedItems = vi.fn()

    const { container } = render(
      <ThemeProvider theme={theme}>
        <CanvasSelectionActionToolbar
          exactSelectedGroup={null}
          selectedItems={selectedItems}
          canCreateGroupFromSelection={false}
          selectionActionStackPosition={{ left: 120, top: 240 }}
          stagePos={{ x: 8, y: 16 }}
          stageScale={1}
          t={createTranslate()}
          onDragSelectedItems={vi.fn()}
          onCopySelectedItems={vi.fn()}
          onDownloadSelectedItems={vi.fn()}
          onSendSelectedItems={onSendSelectedItems}
          onChatSelectedItems={onChatSelectedItems}
          onGenerateSelectedItems={onGenerateSelectedItems}
          onCreateGroupFromSelection={vi.fn()}
        />
      </ThemeProvider>
    )

    const toolbar = container.querySelector('.selection-action-stack') as HTMLElement
    expect(toolbar).toBeTruthy()
    expect(container.querySelector('.group-action-toolbar')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(6)
    const toolbarButtons = within(toolbar).getAllByRole('button')
    const agentButton = within(toolbar).getByRole('button', {
      name: 'Send selected items to Agent'
    })
    const generateButton = within(toolbar).getByRole('button', { name: 'Generate from selection' })

    expect(toolbarButtons.at(-1)).toBe(agentButton)
    expect(toolbarButtons.at(-2)).toBe(generateButton)
    fireEvent.click(agentButton)
    expect(onChatSelectedItems).toHaveBeenCalledExactlyOnceWith(selectedItems)
    expect(onSendSelectedItems).not.toHaveBeenCalled()
    expect(onGenerateSelectedItems).not.toHaveBeenCalled()
  })

  it('keeps the group create action before Agent for multi-item generic selections', () => {
    const selectedItems = [createImageItem('image-1'), createImageItem('image-2')]
    const onSendSelectedItems = vi.fn()
    const onChatSelectedItems = vi.fn()
    const onGenerateSelectedItems = vi.fn()
    const onCreateGroupFromSelection = vi.fn()

    const { container } = render(
      <ThemeProvider theme={theme}>
        <CanvasSelectionActionToolbar
          exactSelectedGroup={null}
          selectedItems={selectedItems}
          canCreateGroupFromSelection={true}
          selectionActionStackPosition={{ left: 12, top: 24 }}
          stagePos={{ x: 8, y: 16 }}
          stageScale={1}
          t={createTranslate()}
          onDragSelectedItems={vi.fn()}
          onCopySelectedItems={vi.fn()}
          onDownloadSelectedItems={vi.fn()}
          onSendSelectedItems={onSendSelectedItems}
          onChatSelectedItems={onChatSelectedItems}
          onGenerateSelectedItems={onGenerateSelectedItems}
          onCreateGroupFromSelection={onCreateGroupFromSelection}
        />
      </ThemeProvider>
    )

    expect(container.querySelectorAll('.selection-action-stack > *')).toHaveLength(7)
    expect(container.querySelector('.group-action-button')).toBeTruthy()
    const toolbar = container.querySelector('.selection-action-stack') as HTMLElement
    const toolbarButtons = within(toolbar).getAllByRole('button')
    const agentButton = within(toolbar).getByRole('button', {
      name: 'Send selected items to Agent'
    })
    const groupButton = within(toolbar).getByRole('button', { name: 'Group' })
    const generateButton = within(toolbar).getByRole('button', { name: 'Generate from selection' })

    expect(toolbarButtons.at(-1)).toBe(agentButton)
    expect(toolbarButtons.at(-2)).toBe(groupButton)
    expect(toolbarButtons.at(-3)).toBe(generateButton)
    fireEvent.click(agentButton)
    expect(onChatSelectedItems).toHaveBeenCalledExactlyOnceWith(selectedItems)
    expect(onSendSelectedItems).not.toHaveBeenCalled()
    expect(onGenerateSelectedItems).not.toHaveBeenCalled()
    expect(onCreateGroupFromSelection).not.toHaveBeenCalled()

    fireEvent.click(groupButton)
    expect(onCreateGroupFromSelection).toHaveBeenCalledExactlyOnceWith(groupButton)
    expect(onChatSelectedItems).toHaveBeenCalledTimes(1)
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
          t={createTranslate()}
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
