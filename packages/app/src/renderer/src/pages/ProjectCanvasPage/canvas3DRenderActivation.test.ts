import { describe, expect, it } from 'vitest'

import {
  CANVAS_3D_RENDER_ACTIVATION_AWAITING_TEXTURES_MS,
  CANVAS_3D_RENDER_ACTIVATION_IMMEDIATE_MS,
  CANVAS_3D_RENDER_ACTIVATION_LINKED_ASSETS_MS,
  CANVAS_3D_RENDER_ACTIVATION_STANDARD_MS,
  resolveCanvas3DRenderActivationDelay
} from './canvas3DRenderActivation'

describe('canvas3DRenderActivation', () => {
  it('activates embedded glb models immediately', () => {
    expect(
      resolveCanvas3DRenderActivationDelay({
        fileName: 'preview.glb'
      })
    ).toBe(CANVAS_3D_RENDER_ACTIVATION_IMMEDIATE_MS)
  })

  it('keeps a short delay for non-glb models without linked assets', () => {
    expect(
      resolveCanvas3DRenderActivationDelay({
        fileName: 'preview.fbx'
      })
    ).toBe(CANVAS_3D_RENDER_ACTIVATION_STANDARD_MS)
  })

  it('uses reduced but non-zero delays for linked assets and pending texture prompts', () => {
    expect(
      resolveCanvas3DRenderActivationDelay({
        fileName: 'preview.obj',
        hasLinkedAssets: true
      })
    ).toBe(CANVAS_3D_RENDER_ACTIVATION_LINKED_ASSETS_MS)

    expect(
      resolveCanvas3DRenderActivationDelay({
        fileName: 'preview.obj',
        isAwaitingTexturePrompt: true
      })
    ).toBe(CANVAS_3D_RENDER_ACTIVATION_AWAITING_TEXTURES_MS)
  })
})
