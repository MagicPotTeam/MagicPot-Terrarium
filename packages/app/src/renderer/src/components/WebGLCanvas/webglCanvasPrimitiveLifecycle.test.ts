import { describe, expect, it, vi } from 'vitest'
import { destroyWebGLCanvasPrimitiveChildren } from './webglCanvasPrimitiveLifecycle'

describe('destroyWebGLCanvasPrimitiveChildren', () => {
  it('destroys every removed primitive instead of only detaching it', () => {
    const first = { destroy: vi.fn() }
    const second = { destroy: vi.fn() }
    const removeChildren = vi.fn(() => [first, second])

    destroyWebGLCanvasPrimitiveChildren({ removeChildren })

    expect(removeChildren).toHaveBeenCalledTimes(1)
    expect(first.destroy).toHaveBeenCalledTimes(1)
    expect(second.destroy).toHaveBeenCalledTimes(1)
  })
})
