import { describe, expect, it, vi } from 'vitest'

import { configureCanvas3DStageRenderer } from './Canvas3DStage'

describe('configureCanvas3DStageRenderer', () => {
  it('forces transparent clears for the 3D stage renderer', () => {
    const gl = {
      autoClear: false,
      setClearColor: vi.fn()
    } as const

    configureCanvas3DStageRenderer(gl as never)

    expect(gl.autoClear).toBe(true)
    expect(gl.setClearColor).toHaveBeenCalledWith(0x000000, 0)
  })
})
