import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import InputTextAreaFunctional from './InputTextAreaFunctional'
import { QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'

const createDataTransfer = (data: Record<string, string>) =>
  ({
    getData: (key: string) => data[key] || '',
    dropEffect: 'none'
  }) as unknown as DataTransfer

describe('InputTextAreaFunctional', () => {
  it('inserts dropped internal canvas text into the textarea', () => {
    const onChange = vi.fn()

    render(
      <InputTextAreaFunctional
        label="Prompt"
        value="Before "
        onChange={onChange}
        placeholder="Prompt..."
        showTagEditor={false}
      />
    )

    const textarea = screen.getByPlaceholderText('Prompt...') as HTMLTextAreaElement
    act(() => {
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      fireEvent.drop(textarea, {
        dataTransfer: createDataTransfer({
          [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
            objectUrl: 'blob:text-item',
            itemTypes: ['text'],
            textContent: 'Dragged text'
          })
        })
      })
    })

    expect(onChange).toHaveBeenCalledWith('Before Dragged text')
  })

  it('prioritizes internal canvas text when the drag payload also includes preview attachments', () => {
    const onChange = vi.fn()
    const parentDrop = vi.fn()

    render(
      <div onDrop={parentDrop}>
        <InputTextAreaFunctional
          label="Prompt"
          value="Before "
          onChange={onChange}
          placeholder="Prompt..."
          showTagEditor={false}
        />
      </div>
    )

    const textarea = screen.getByPlaceholderText('Prompt...') as HTMLTextAreaElement
    act(() => {
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      fireEvent.drop(textarea, {
        dataTransfer: createDataTransfer({
          [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
            objectUrl: 'blob:text-preview',
            previewImageUrl: 'blob:text-preview',
            itemTypes: ['text', 'image'],
            textContent: 'Dragged text',
            attachments: [
              {
                type: 'image',
                url: 'blob:text-preview',
                fileName: 'preview.png'
              }
            ]
          })
        })
      })
    })

    expect(onChange).toHaveBeenCalledWith('Before Dragged text')
    expect(parentDrop).not.toHaveBeenCalled()
  })

  it('allows internal image-only drops to reach parent drop zones', () => {
    const onChange = vi.fn()
    const parentDrop = vi.fn()

    render(
      <div onDrop={parentDrop}>
        <InputTextAreaFunctional
          label="Prompt"
          value=""
          onChange={onChange}
          placeholder="Prompt..."
          showTagEditor={false}
        />
      </div>
    )

    const textarea = screen.getByPlaceholderText('Prompt...') as HTMLTextAreaElement
    act(() => {
      fireEvent.drop(textarea, {
        dataTransfer: createDataTransfer({
          [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
            objectUrl: 'blob:image-preview',
            itemTypes: ['image'],
            attachments: [
              {
                type: 'image',
                url: 'blob:image-preview',
                fileName: 'preview.png'
              }
            ]
          })
        })
      })
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(parentDrop).toHaveBeenCalled()
  })

  it('accepts ordinary plain-text drops without forwarding them to parent drop zones', () => {
    const onChange = vi.fn()
    const parentDrop = vi.fn()

    render(
      <div onDrop={parentDrop}>
        <InputTextAreaFunctional
          label="Prompt"
          value=""
          onChange={onChange}
          placeholder="Prompt..."
          showTagEditor={false}
        />
      </div>
    )

    const textarea = screen.getByPlaceholderText('Prompt...') as HTMLTextAreaElement

    act(() => {
      fireEvent.drop(textarea, {
        dataTransfer: createDataTransfer({
          'text/plain': 'External text'
        })
      })
    })

    expect(onChange).toHaveBeenCalledWith('External text')
    expect(parentDrop).not.toHaveBeenCalled()
  })
})
