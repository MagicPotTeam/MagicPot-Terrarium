import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pixiState = vi.hoisted(() => ({
  applicationCount: 0,
  destroyCount: 0
}))

vi.mock('pixi.js', () => {
  class Container {
    sortableChildren = false
    children: Container[] = []
    addChild(child: Container) {
      this.children.push(child)
      return child
    }
  }

  class Application {
    canvas = document.createElement('canvas')
    stage = new Container()

    constructor() {
      pixiState.applicationCount += 1
    }

    async init() {
      await Promise.resolve()
    }

    destroy() {
      pixiState.destroyCount += 1
    }
  }

  return { Application, Container }
})

import WebGLCanvasHost from './WebGLCanvasHost'

describe('WebGLCanvasHost lifecycle', () => {
  beforeEach(() => {
    pixiState.applicationCount = 0
    pixiState.destroyCount = 0
  })

  it('does not recreate the Pixi runtime when callback props change identity', async () => {
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()
    const view = render(<WebGLCanvasHost onReadyChange={firstCallback} />)

    await waitFor(() => expect(firstCallback).toHaveBeenCalledWith(true))
    view.rerender(<WebGLCanvasHost onReadyChange={secondCallback} />)

    await waitFor(() => expect(pixiState.applicationCount).toBe(1))
    expect(pixiState.applicationCount).toBe(1)
    expect(pixiState.destroyCount).toBe(0)
    expect(secondCallback).not.toHaveBeenCalled()
  })
})
