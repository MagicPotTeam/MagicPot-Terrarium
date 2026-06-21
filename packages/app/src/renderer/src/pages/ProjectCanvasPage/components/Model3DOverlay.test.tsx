import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Model3DOverlay from './Model3DOverlay'
import type { CanvasModel3DItem } from '../types'

vi.mock('./LazyCanvas3DStage', async () => {
  const React = await import('react')

  return {
    default: () => React.createElement('div', { 'data-testid': 'canvas3d-stage' })
  }
})

const baseItem: CanvasModel3DItem = {
  id: 'model-1',
  type: 'model3d',
  x: 0,
  y: 0,
  width: 120,
  height: 120,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  zIndex: 1,
  locked: false,
  src: 'blob:model-source',
  fileName: 'sample.glb'
}

describe('Model3DOverlay', () => {
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  let createdInput: HTMLInputElement | null = null
  let createElementSpy: { mockRestore: () => void } | null = null
  let objectUrlIndex = 0

  beforeEach(() => {
    objectUrlIndex = 0
    createdInput = null

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => `blob:texture-${++objectUrlIndex}`)
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn()
    })

    const originalCreateElement = document.createElement.bind(document)
    const createElementMock = vi.spyOn(document, 'createElement')
    createElementMock.mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options)
      if (tagName.toLowerCase() === 'input') {
        createdInput = element as HTMLInputElement
        vi.spyOn(createdInput, 'click').mockImplementation(() => undefined)
      }
      return element
    }) as typeof document.createElement)
    createElementSpy = createElementMock
  })

  afterEach(() => {
    createElementSpy?.mockRestore()
    createElementSpy = null
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectURL
    })
  })

  it('keeps imported texture object URLs alive across project tab unmounts', async () => {
    function Harness() {
      const [item, setItem] = React.useState<CanvasModel3DItem>(baseItem)

      return (
        <Model3DOverlay
          item={item}
          isSelected={false}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={vi.fn()}
          onUpdateTextures={(_, textures) => {
            setItem((previousItem) => ({ ...previousItem, textures }))
          }}
        />
      )
    }

    const { unmount } = render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: /import textures/i }))
    expect(createdInput).not.toBeNull()
    Object.defineProperty(createdInput, 'files', {
      configurable: true,
      value: [new File(['first'], 'albedo.png', { type: 'image/png' })]
    })
    await act(async () => {
      createdInput?.onchange?.(new Event('change'))
    })

    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    })
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    unmount()

    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('revokes replaced texture object URLs without revoking the current texture on unmount', async () => {
    function Harness() {
      const [item, setItem] = React.useState<CanvasModel3DItem>(baseItem)

      return (
        <Model3DOverlay
          item={item}
          isSelected={false}
          stagePos={{ x: 0, y: 0 }}
          stageScale={1}
          onSelect={vi.fn()}
          onUpdateTextures={(_, textures) => {
            setItem((previousItem) => ({ ...previousItem, textures }))
          }}
        />
      )
    }

    const { unmount } = render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: /import textures/i }))
    expect(createdInput).not.toBeNull()
    Object.defineProperty(createdInput, 'files', {
      configurable: true,
      value: [new File(['first'], 'albedo.png', { type: 'image/png' })]
    })
    await act(async () => {
      createdInput?.onchange?.(new Event('change'))
    })

    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByRole('button', { name: /import textures/i }))
    expect(createdInput).not.toBeNull()
    Object.defineProperty(createdInput, 'files', {
      configurable: true,
      value: [new File(['second'], 'albedo.png', { type: 'image/png' })]
    })
    await act(async () => {
      createdInput?.onchange?.(new Event('change'))
    })

    await waitFor(() => {
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:texture-1')
    })

    unmount()

    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:texture-2')
  })
})
