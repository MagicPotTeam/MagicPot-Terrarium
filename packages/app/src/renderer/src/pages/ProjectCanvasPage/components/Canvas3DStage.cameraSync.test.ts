import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import {
  resolveCanvas3DStageModelVisualMode,
  resolveCanvas3DStageViewportSummary,
  syncCanvas3DStageCamera
} from './Canvas3DStage'
import { PROJECT_CANVAS_MIN_STAGE_SCALE } from '../projectCanvasViewportScale'
import type { CanvasModel3DItem } from '../types'

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

  it('keeps model items renderable during imperative viewport scrolls', () => {
    const offscreenModel: CanvasModel3DItem = {
      id: 'model-offscreen',
      type: 'model3d',
      src: 'model.glb',
      fileName: 'model.glb',
      x: 4000,
      y: 3000,
      width: 240,
      height: 240,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: 1,
      locked: false
    }

    expect(
      resolveCanvas3DStageViewportSummary({
        items: [offscreenModel],
        selectedIds: new Set(),
        stagePos: { x: 0, y: 0 },
        stageScale: 1,
        stageSize: { width: 800, height: 600 }
      }).visibleItemIds.has(offscreenModel.id)
    ).toBe(false)

    expect(
      resolveCanvas3DStageViewportSummary({
        items: [offscreenModel],
        selectedIds: new Set(),
        stagePos: { x: 0, y: 0 },
        stageScale: 1,
        stageSize: { width: 800, height: 600 },
        skipViewportCulling: true
      }).visibleItemIds.has(offscreenModel.id)
    ).toBe(true)
  })
})
