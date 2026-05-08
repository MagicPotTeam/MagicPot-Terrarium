import { describe, expect, it, vi } from 'vitest'

import { CANVAS_3D_STAGE_GL_OPTIONS, configureCanvas3DStageRenderer } from './Canvas3DStage'

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

  it('uses the live WebGL canvas path during viewport scroll', () => {
    expect(CANVAS_3D_STAGE_GL_OPTIONS.preserveDrawingBuffer).toBe(false)
  })
})
