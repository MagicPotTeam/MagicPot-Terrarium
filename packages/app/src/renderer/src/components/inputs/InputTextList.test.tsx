import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InputTextList from './InputTextList'

vi.mock('./BaseInputTextField', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <input
      aria-label="text-list-item"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  )
}))

describe('InputTextList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not echo initial or equivalent prop values back to the parent', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <InputTextList label="URLs" value={['https://example.com/node']} onChange={onChange} />
    )

    await waitFor(() => expect(screen.getByLabelText('text-list-item')).toBeTruthy())
    expect(onChange).not.toHaveBeenCalled()

    rerender(
      <InputTextList label="URLs" value={['https://example.com/node']} onChange={onChange} />
    )

    expect(onChange).not.toHaveBeenCalled()
  })

  it('emits changes only after the user edits the list', async () => {
    const onChange = vi.fn()
    render(<InputTextList label="URLs" value={['old']} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('text-list-item'), { target: { value: 'new' } })

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['new']))
  })
})
