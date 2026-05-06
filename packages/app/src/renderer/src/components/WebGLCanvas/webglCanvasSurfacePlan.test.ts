import { describe, expect, it } from 'vitest'
import { resolveWebGLCanvasScenePlan } from './webglCanvasSurfacePlan'

describe('resolveWebGLCanvasScenePlan', () => {
  it('keeps the viewer path first and exposes editor and mask capabilities separately', () => {
    const plan = resolveWebGLCanvasScenePlan('hybrid', true, true, true)

    expect(plan.layers).toEqual(['viewer', 'editor', 'mask'])
    expect(plan.capabilities).toEqual(['viewer-path', 'editor-path', 'mask-path'])
  })

  it('keeps viewer-only scenes minimal', () => {
    const plan = resolveWebGLCanvasScenePlan('viewer', true, false, false)

    expect(plan.layers).toEqual(['viewer'])
    expect(plan.capabilities).toEqual(['viewer-path'])
  })
})
