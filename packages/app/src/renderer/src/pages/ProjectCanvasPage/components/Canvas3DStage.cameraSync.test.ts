import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import { resolveCanvas3DStageModelVisualMode, syncCanvas3DStageCamera } from './Canvas3DStage'
import { PROJECT_CANVAS_MIN_STAGE_SCALE } from '../projectCanvasViewportScale'

describe('syncCanvas3DStageCamera', () => {
  it('updates orthographic stage cameras using the current viewport transform', () => {
    const camera = new THREE.OrthographicCamera()

    expect(
      syncCanvas3DStageCamera({
        camera,
        stagePos: { x: 180, y: 140 },
        stageScale: 0.8,
        stageSize: { width: 1280, height: 720 }
      })
    ).toBe(true)

    expect(camera.left).toBe(-640)
    expect(camera.right).toBe(640)
    expect(camera.top).toBe(360)
    expect(camera.bottom).toBe(-360)
    expect(camera.zoom).toBe(0.8)
    expect(camera.position.toArray()).toEqual([575, -275, 1000])
  })

  it('clamps the zoom floor and ignores non-orthographic cameras', () => {
    const orthographicCamera = new THREE.OrthographicCamera()

    expect(
      syncCanvas3DStageCamera({
        camera: orthographicCamera,
        stagePos: { x: 200, y: 160 },
        stageScale: 0,
        stageSize: { width: 800, height: 600 }
      })
    ).toBe(true)
    expect(orthographicCamera.zoom).toBe(PROJECT_CANVAS_MIN_STAGE_SCALE)

    const perspectiveCamera = new THREE.PerspectiveCamera()
    expect(
      syncCanvas3DStageCamera({
        camera: perspectiveCamera,
        stagePos: { x: 0, y: 0 },
        stageScale: 1,
        stageSize: { width: 800, height: 600 }
      })
    ).toBe(false)
  })

  it('keeps cached preview textures on the bitmap path until the live model is mounted', () => {
    expect(
      resolveCanvas3DStageModelVisualMode({
        shouldRenderPlaceholderOnly: true,
        isFullModelActivated: false,
        shouldMountFullModel: false,
        hasPreviewTexture: true
      })
    ).toBe('cached-preview')

    expect(
      resolveCanvas3DStageModelVisualMode({
        shouldRenderPlaceholderOnly: false,
        isFullModelActivated: false,
        shouldMountFullModel: true,
        hasPreviewTexture: true
      })
    ).toBe('cached-preview')

    expect(
      resolveCanvas3DStageModelVisualMode({
        shouldRenderPlaceholderOnly: false,
        isFullModelActivated: true,
        shouldMountFullModel: true,
        hasPreviewTexture: true
      })
    ).toBe('live-model')
  })
})
