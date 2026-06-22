import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useCanvasVisualMetrics } from './useCanvasVisualMetrics'
import type { CanvasImageItem, CanvasModel3DItem, CanvasTextItem, CanvasVideoItem } from './types'
import {
  clearCanvasModel3DInspectionMetadataCache,
  writeCanvasModel3DInspectionMetadataCache
} from './components/modelLoaders/modelInspectionMetadataCache'
import {
  DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
  getSceneInstanceCloneCacheKey
} from './components/modelLoaders/sceneInstanceCloneCacheKey'

function createDomRect({
  left,
  top,
  width,
  height
}: {
  left: number
  top: number
  width: number
  height: number
}): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => null
  } as DOMRect
}

function setElementRect(
  element: Element,
  rect: {
    left: number
    top: number
    width: number
    height: number
  }
) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => createDomRect(rect)
  })
}

function createImageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    x: 10,
    y: 20,
    width: 120,
    height: 80,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    src: 'https://example.com/image.png',
    ...overrides
  }
}

function createVideoItem(overrides: Partial<CanvasVideoItem> = {}): CanvasVideoItem {
  return {
    id: 'video-1',
    type: 'video',
    src: 'https://example.com/video.mp4',
    fileName: 'video.mp4',
    x: 20,
    y: 30,
    width: 320,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    playing: false,
    muted: true,
    volume: 0.5,
    ...overrides
  }
}

function createTextItem(overrides: Partial<CanvasTextItem> = {}): CanvasTextItem {
  return {
    id: 'text-1',
    type: 'text',
    x: 30,
    y: 40,
    width: 90,
    height: 30,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 3,
    locked: false,
    text: 'metrics',
    fontSize: 18,
    fontFamily: 'sans-serif',
    fill: '#ffffff',
    ...overrides
  }
}

function createModelItem(overrides: Partial<CanvasModel3DItem> = {}): CanvasModel3DItem {
  return {
    id: 'model-1',
    type: 'model3d',
    src: 'https://example.com/model.glb',
    fileName: 'model.glb',
    x: 50,
    y: 70,
    width: 180,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 4,
    locked: false,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  clearCanvasModel3DInspectionMetadataCache()
})

describe('useCanvasVisualMetrics', () => {
  it('summarizes runtime surfaces from the supplied WebGL state instead of a static item heuristic', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const { result } = renderHook(() =>
      useCanvasVisualMetrics({
        canvasContainerRef: { current: container },
        renderSurfaceRuntime: {
          cropTargetId: 'image-crop',
          webglReady: true,
          loadedImageIds: new Set(['image-loaded', 'image-fallback']),
          residentImageIds: new Set(['image-loaded'])
        },
        stagePos: { x: 0, y: 0 },
        stageRef: { current: null },
        stageScale: 1
      })
    )

    expect(
      result.current.summarizeCanvasRuntimeSurfaces([
        createImageItem({ id: 'image-crop' }),
        createImageItem({ id: 'image-loaded' }),
        createImageItem({ id: 'image-fallback' }),
        createVideoItem(),
        {
          id: 'html-1',
          type: 'html',
          htmlData: '<div>hello</div>',
          x: 0,
          y: 0,
          width: 120,
          height: 80,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 4,
          locked: false
        },
        {
          id: 'model-1',
          type: 'model3d',
          src: 'https://example.com/model.glb',
          fileName: 'model.glb',
          x: 0,
          y: 0,
          width: 120,
          height: 120,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 5,
          locked: false
        }
      ])
    ).toEqual({
      totalItems: 6,
      imageItems: 3,
      webglImageItems: 1,
      webglModel3DItems: 1,
      budgetDowngradedImageItems: 1,
      fallbackImageItems: 0,
      cropExcludedImageItems: 1,
      videoOverlayItems: 1,
      htmlOverlayItems: 1
    })
  })

  it('prefers overlay DOM bounds, then stage nodes, then geometric fallback bounds', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    setElementRect(container, { left: 100, top: 200, width: 800, height: 600 })

    const overlayElement = document.createElement('div')
    overlayElement.setAttribute('data-canvas-item-id', 'image-overlay')
    setElementRect(overlayElement, { left: 140, top: 260, width: 200, height: 100 })
    container.appendChild(overlayElement)

    const stageNodes = new Map([
      [
        '#text-stage',
        {
          getClientRect: () => ({
            x: 60,
            y: 90,
            width: 120,
            height: 80
          })
        }
      ]
    ])

    const { result } = renderHook(() =>
      useCanvasVisualMetrics({
        canvasContainerRef: { current: container },
        stagePos: { x: 20, y: 10 },
        stageRef: {
          current: {
            getStage: () => ({
              findOne: (selector: string) => stageNodes.get(selector) ?? null
            })
          }
        },
        stageScale: 2
      })
    )

    expect(
      result.current.getCanvasItemVisualBounds(createImageItem({ id: 'image-overlay' }))
    ).toEqual({
      x: 10,
      y: 25,
      width: 100,
      height: 50
    })

    expect(result.current.getCanvasItemVisualBounds(createTextItem({ id: 'text-stage' }))).toEqual({
      x: 20,
      y: 40,
      width: 60,
      height: 40
    })

    expect(
      result.current.getCanvasItemVisualBounds(
        createTextItem({
          id: 'text-fallback',
          x: 40,
          y: 60,
          width: 50,
          height: 20,
          scaleX: 1.5,
          scaleY: 2
        })
      )
    ).toEqual({
      x: 40,
      y: 60,
      width: 75,
      height: 40
    })
  })

  it('extracts runtime video metadata from the mounted DOM overlay', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const videoHost = document.createElement('div')
    videoHost.setAttribute('data-canvas-item-id', 'video-1')
    const video = document.createElement('video')
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 })
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1080 })
    Object.defineProperty(video, 'duration', { configurable: true, value: 42.5 })
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 8.25 })
    Object.defineProperty(video, 'loop', { configurable: true, value: true })
    videoHost.appendChild(video)
    container.appendChild(videoHost)

    const { result } = renderHook(() =>
      useCanvasVisualMetrics({
        canvasContainerRef: { current: container },
        stagePos: { x: 0, y: 0 },
        stageRef: { current: null },
        stageScale: 1
      })
    )

    expect(result.current.getCanvasRuntimeAssetMetadataExtra(createVideoItem())).toEqual({
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceAspectRatio: 1.778,
      durationSeconds: 42.5,
      currentTimeSeconds: 8.25,
      loop: true
    })
  })

  it('extracts runtime 3D metadata from the lazy stage metadata cache', () => {
    const modelItem = createModelItem({
      textures: {
        'albedo.png': 'blob:albedo'
      }
    })

    writeCanvasModel3DInspectionMetadataCache(
      getSceneInstanceCloneCacheKey({
        sessionKey: DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
        src: modelItem.src,
        fileName: modelItem.fileName,
        itemId: modelItem.id,
        textures: modelItem.textures
      }),
      {
        vertexCount: 4,
        faceCount: 2,
        materialCount: 1,
        animationCount: 2,
        boneCount: 0,
        uvSetCount: 2,
        normalData: true,
        tangentData: false
      }
    )

    const { result } = renderHook(() =>
      useCanvasVisualMetrics({
        canvasContainerRef: { current: document.createElement('div') },
        sessionKey: DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
        stagePos: { x: 0, y: 0 },
        stageRef: { current: null },
        stageScale: 1
      })
    )

    expect(result.current.getCanvasRuntimeAssetMetadataExtra(modelItem)).toEqual({
      vertexCount: 4,
      faceCount: 2,
      materialCount: 1,
      animationCount: 2,
      boneCount: 0,
      uvSetCount: 2,
      normalData: true,
      tangentData: false
    })
  })
})
