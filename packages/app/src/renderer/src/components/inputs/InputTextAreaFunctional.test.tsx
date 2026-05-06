import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import InputTextAreaFunctional from './InputTextAreaFunctional'

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
          'application/x-qapp-image': JSON.stringify({
            objectUrl: 'blob:text-item',
            itemTypes: ['text'],
            textContent: 'Dragged text'
          })
        })
      })
    })

    expect(onChange).toHaveBeenCalledWith('Before Dragged text')
  })

  it('accepts ordinary plain-text drops without forwarding them to parent drop zones', () => {
    const onChange = vi.fn()

    render(
      <InputTextAreaFunctional
        label="Prompt"
        value=""
        onChange={onChange}
        placeholder="Prompt..."
        showTagEditor={false}
      />
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
  })
})
