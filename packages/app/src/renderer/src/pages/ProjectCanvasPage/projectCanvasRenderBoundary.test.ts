import { describe, expect, it } from 'vitest'
import type { CanvasHtmlItem, CanvasImageItem, CanvasModel3DItem, CanvasVideoItem } from './types'
import {
  buildProjectCanvasRenderableItem,
  buildProjectCanvasRenderableItems,
  buildProjectCanvasRenderableImage,
  resolveProjectCanvasBudgetedVideoItems,
  resolveProjectCanvasImageInteractionMode,
  getProjectCanvasRenderTextureKey,
  getProjectCanvasRenderTransformKey,
  resolveProjectCanvasImageRuntimeRoute,
  summarizeProjectCanvasVideoBudget,
  summarizeProjectCanvasRuntimeSurfaces
} from './projectCanvasRenderBoundary'

function createImage(width: number, height: number) {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: width })
  Object.defineProperty(image, 'naturalHeight', { value: height })
  return image
}

function createItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'img-1',
    type: 'image',
    x: 12,
    y: 34,
    width: 100,
    height: 80,
    rotation: 15,
    scaleX: 1.5,
    scaleY: 0.75,
    zIndex: 7,
    locked: false,
    src: 'https://example.com/image.png',
    crop: { x: 10, y: 20, width: 30, height: 40 },
    ...overrides
  }
}

function createVideoItem(overrides: Partial<CanvasVideoItem> = {}): CanvasVideoItem {
  return {
    id: 'video-1',
    type: 'video',
    src: 'https://example.com/video.mp4',
    fileName: 'video.mp4',
    x: 40,
    y: 60,
    width: 320,
    height: 180,
    rotation: 5,
    scaleX: 1,
    scaleY: 1.1,
    zIndex: 3,
    locked: false,
    playing: false,
    muted: true,
    volume: 0.5,
    ...overrides
  }
}

function createModel3DItem(overrides: Partial<CanvasModel3DItem> = {}): CanvasModel3DItem {
  return {
    id: 'model-1',
    type: 'model3d',
    src: 'https://example.com/model.glb',
    fileName: 'model.glb',
    x: 50,
    y: 70,
    width: 200,
    height: 160,
    rotation: 0,
    scaleX: 0.9,
    scaleY: 1.2,
    zIndex: 4,
    locked: false,
    ...overrides
  }
}

function createHtmlItem(overrides: Partial<CanvasHtmlItem> = {}): CanvasHtmlItem {
  return {
    id: 'html-1',
    type: 'html',
    htmlData: '<div>hello</div>',
    x: 10,
    y: 20,
    width: 240,
    height: 120,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    ...overrides
  }
}

describe('projectCanvasRenderBoundary', () => {
  it('builds unified media descriptors with explicit surfaces and interaction proxies', () => {
    expect(buildProjectCanvasRenderableItem(createItem())).toMatchObject({
      id: 'img-1',
      kind: 'image',
      surface: 'webgl-image',
      interactionProxy: 'canvas-image-node',
      itemType: 'image'
    })

    expect(buildProjectCanvasRenderableItem(createVideoItem())).toMatchObject({
      id: 'video-1',
      kind: 'video',
      surface: 'html-video-overlay',
      interactionProxy: 'canvas-placeholder',
      itemType: 'video'
    })

    expect(buildProjectCanvasRenderableItem(createModel3DItem())).toMatchObject({
      id: 'model-1',
      kind: 'model3d',
      surface: 'webgl-model3d-stage',
      interactionProxy: 'canvas-placeholder',
      itemType: 'model3d'
    })

    expect(buildProjectCanvasRenderableItem(createHtmlItem())).toMatchObject({
      id: 'html-1',
      kind: 'html',
      surface: 'html-overlay',
      interactionProxy: 'html-overlay',
      itemType: 'html'
    })
  })

  it('builds batched media descriptors while skipping non-media items', () => {
    const renderableItems = buildProjectCanvasRenderableItems([
      createItem(),
      createVideoItem(),
      createModel3DItem(),
      createHtmlItem(),
      {
        id: 'text-1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 30,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 0,
        locked: false,
        text: 'hello',
        fontSize: 16,
        fontFamily: 'sans-serif',
        fill: '#fff'
      }
    ])

    expect(renderableItems.map((item) => `${item.kind}:${item.surface}`)).toEqual([
      'image:webgl-image',
      'video:html-video-overlay',
      'model3d:webgl-model3d-stage',
      'html:html-overlay'
    ])
  })

  it('maps workflow image items into render-only image contracts', () => {
    const item = createItem()
    const image = createImage(200, 100)

    expect(buildProjectCanvasRenderableImage(item, image)).toEqual({
      id: 'img-1',
      item,
      itemType: 'image',
      kind: 'image',
      surface: 'webgl-image',
      interactionProxy: 'canvas-image-node',
      src: 'https://example.com/image.png',
      image,
      x: 12,
      y: 34,
      width: 100,
      height: 80,
      scaleX: 1.5,
      scaleY: 0.75,
      rotation: 15,
      sourceWidth: 200,
      sourceHeight: 100,
      crop: {
        x: 10,
        y: 20,
        width: 30,
        height: 40
      },
      zIndex: 7
    })
  })

  it('keeps transform and texture keys stable for renderer caching', () => {
    const image = createImage(200, 100)
    const renderImage = buildProjectCanvasRenderableImage(createItem(), image)!

    expect(getProjectCanvasRenderTransformKey(renderImage)).toBe('12|34|100|80|1.5|0.75|15')
    expect(getProjectCanvasRenderTextureKey(renderImage)).toBe(
      'https://example.com/image.png|200|100|10|20|30|40'
    )
  })

  it('resolves image runtime routes from crop and WebGL load state', () => {
    const item = createItem()

    expect(
      resolveProjectCanvasImageRuntimeRoute({
        item,
        isCropTarget: false,
        webglReady: true,
        loadedImageIds: new Set([item.id])
      })
    ).toBe('webgl-primary')

    expect(
      resolveProjectCanvasImageRuntimeRoute({
        item,
        isCropTarget: false,
        webglReady: true,
        loadedImageIds: new Set([item.id]),
        residentImageIds: new Set()
      })
    ).toBe('budget-image-proxy')

    expect(
      resolveProjectCanvasImageRuntimeRoute({
        item,
        isCropTarget: false,
        webglReady: false,
        loadedImageIds: new Set([item.id])
      })
    ).toBe('fallback-image-proxy')

    expect(
      resolveProjectCanvasImageRuntimeRoute({
        item,
        isCropTarget: true,
        webglReady: true,
        loadedImageIds: new Set([item.id])
      })
    ).toBe('crop-excluded')
  })

  it('resolves image interaction modes from runtime route, selection, and tool state', () => {
    const item = createItem()

    expect(
      resolveProjectCanvasImageInteractionMode({
        item,
        runtimeRoute: 'webgl-primary',
        tool: 'select',
        isSingleSelected: true
      })
    ).toBe('dom-image-overlay')

    expect(
      resolveProjectCanvasImageInteractionMode({
        item: createItem({ scaleX: -1.2, scaleY: 0.9 }),
        runtimeRoute: 'webgl-primary',
        tool: 'select',
        isSingleSelected: true
      })
    ).toBe('dom-image-overlay')

    expect(
      resolveProjectCanvasImageInteractionMode({
        item,
        runtimeRoute: 'budget-image-proxy',
        tool: 'select',
        isSingleSelected: true
      })
    ).toBe('dom-image-overlay')

    expect(
      resolveProjectCanvasImageInteractionMode({
        item,
        runtimeRoute: 'fallback-image-proxy',
        tool: 'select',
        isSingleSelected: true
      })
    ).toBe('dom-image-overlay')

    expect(
      resolveProjectCanvasImageInteractionMode({
        item,
        runtimeRoute: 'webgl-primary',
        tool: 'annotate',
        isSingleSelected: true
      })
    ).toBe('placeholder-hit-proxy')

    expect(
      resolveProjectCanvasImageInteractionMode({
        item,
        runtimeRoute: 'webgl-primary',
        tool: 'select',
        isSingleSelected: false
      })
    ).toBe('placeholder-hit-proxy')

    expect(
      resolveProjectCanvasImageInteractionMode({
        item,
        runtimeRoute: 'budget-image-proxy',
        tool: 'annotate',
        isSingleSelected: true
      })
    ).toBe('placeholder-hit-proxy')

    expect(
      resolveProjectCanvasImageInteractionMode({
        item,
        runtimeRoute: 'fallback-image-proxy',
        tool: 'annotate',
        isSingleSelected: true
      })
    ).toBe('placeholder-hit-proxy')

    expect(
      resolveProjectCanvasImageInteractionMode({
        item,
        runtimeRoute: 'fallback-image-proxy',
        tool: 'select',
        isSingleSelected: false
      })
    ).toBe('placeholder-hit-proxy')

    expect(
      resolveProjectCanvasImageInteractionMode({
        item,
        runtimeRoute: 'crop-excluded',
        tool: 'select',
        isSingleSelected: true
      })
    ).toBe('crop-excluded')
  })

  it('summarizes runtime surfaces with truthful fallback and crop counts', () => {
    const cropItem = createItem({ id: 'crop-image' })
    const loadedItem = createItem({ id: 'loaded-image' })
    const unloadedItem = createItem({ id: 'unloaded-image' })

    expect(
      summarizeProjectCanvasRuntimeSurfaces({
        items: [
          cropItem,
          loadedItem,
          unloadedItem,
          createVideoItem(),
          createModel3DItem(),
          createHtmlItem()
        ],
        cropTargetId: cropItem.id,
        webglReady: true,
        loadedImageIds: new Set([loadedItem.id, unloadedItem.id]),
        residentImageIds: new Set([loadedItem.id])
      })
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

  it('budgets videos into active, paused, poster, and unmounted modes from viewport state', () => {
    const activeSelected = createVideoItem({ id: 'video-active-selected', playing: true })
    const activeVisible = createVideoItem({
      id: 'video-active-visible',
      x: 360,
      y: 40,
      playing: true
    })
    const pausedVisible = createVideoItem({
      id: 'video-paused-visible',
      x: 120,
      y: 280,
      playing: false
    })
    const posterVisible = createVideoItem({
      id: 'video-poster',
      x: 20,
      y: 420,
      width: 40,
      height: 24,
      playing: false
    })
    const unmountedOffscreen = createVideoItem({
      id: 'video-unmounted',
      x: 2600,
      y: 1600,
      playing: false
    })

    const budgetedItems = resolveProjectCanvasBudgetedVideoItems({
      items: [activeSelected, activeVisible, pausedVisible, posterVisible, unmountedOffscreen],
      selectedIds: new Set([activeSelected.id]),
      stagePos: { x: 0, y: 0 },
      stageScale: 1,
      stageSize: { width: 800, height: 600 }
    })

    expect(
      budgetedItems.map(({ item, mode }) => ({
        id: item.id,
        mode
      }))
    ).toEqual([
      { id: activeSelected.id, mode: 'active-playing' },
      { id: activeVisible.id, mode: 'active-playing' },
      { id: pausedVisible.id, mode: 'visible-paused' },
      { id: posterVisible.id, mode: 'poster-frame' },
      { id: unmountedOffscreen.id, mode: 'unmounted' }
    ])
  })

  it('summarizes truthful video budget counts', () => {
    const budgetedItems = resolveProjectCanvasBudgetedVideoItems({
      items: [
        createVideoItem({ id: 'video-active-1', playing: true }),
        createVideoItem({ id: 'video-active-2', x: 360, y: 40, playing: true }),
        createVideoItem({ id: 'video-paused', x: 120, y: 280, playing: false }),
        createVideoItem({ id: 'video-poster', x: 20, y: 420, width: 40, height: 24 }),
        createVideoItem({ id: 'video-unmounted', x: 2600, y: 1600 })
      ],
      selectedIds: new Set(),
      stagePos: { x: 0, y: 0 },
      stageScale: 1,
      stageSize: { width: 800, height: 600 }
    })

    expect(summarizeProjectCanvasVideoBudget(budgetedItems)).toEqual({
      totalVideos: 5,
      activePlayingCount: 2,
      visiblePausedCount: 1,
      posterFrameCount: 1,
      unmountedCount: 1
    })
  })

  it('keeps large video sets within the active-playing budget while degrading offscreen and tiny videos', () => {
    const activeVisibleVideos = Array.from({ length: 12 }, (_, index) =>
      createVideoItem({
        id: `video-active-${index}`,
        x: (index % 4) * 220,
        y: Math.floor(index / 4) * 160,
        width: 240,
        height: 135,
        zIndex: index,
        playing: true
      })
    )
    const posterVideos = Array.from({ length: 6 }, (_, index) =>
      createVideoItem({
        id: `video-poster-${index}`,
        x: 40 + index * 48,
        y: 520,
        width: 40,
        height: 24,
        zIndex: 50 + index,
        playing: false
      })
    )
    const offscreenVideos = Array.from({ length: 24 }, (_, index) =>
      createVideoItem({
        id: `video-offscreen-${index}`,
        x: 4000 + index * 260,
        y: 3000 + index * 180,
        width: 240,
        height: 135,
        zIndex: 100 + index,
        playing: Boolean(index % 2)
      })
    )
    const selectedPriorityVideo = createVideoItem({
      id: 'video-selected-priority',
      x: 32,
      y: 32,
      width: 300,
      height: 168,
      zIndex: 999,
      playing: true
    })

    const budgetedItems = resolveProjectCanvasBudgetedVideoItems({
      items: [selectedPriorityVideo, ...activeVisibleVideos, ...posterVideos, ...offscreenVideos],
      selectedIds: new Set([selectedPriorityVideo.id]),
      stagePos: { x: 0, y: 0 },
      stageScale: 1,
      stageSize: { width: 1280, height: 720 }
    })
    const summary = summarizeProjectCanvasVideoBudget(budgetedItems)

    expect(summary.totalVideos).toBe(43)
    expect(summary.activePlayingCount).toBe(4)
    expect(summary.posterFrameCount).toBe(7)
    expect(summary.unmountedCount).toBe(24)
    expect(summary.visiblePausedCount).toBe(8)
    expect(budgetedItems.find(({ item }) => item.id === selectedPriorityVideo.id)?.mode).toBe(
      'active-playing'
    )
  })

  it('caps mounted paused video overlays while keeping selected videos mounted', () => {
    const selectedPausedVideo = createVideoItem({
      id: 'video-selected-paused',
      x: 20,
      y: 20,
      zIndex: 100,
      playing: false
    })
    const pausedVideos = Array.from({ length: 5 }, (_, index) =>
      createVideoItem({
        id: `video-paused-${index}`,
        x: 80 + index * 60,
        y: 80,
        zIndex: index,
        playing: false
      })
    )

    const budgetedItems = resolveProjectCanvasBudgetedVideoItems({
      items: [selectedPausedVideo, ...pausedVideos],
      selectedIds: new Set([selectedPausedVideo.id]),
      stagePos: { x: 0, y: 0 },
      stageScale: 1,
      stageSize: { width: 800, height: 600 },
      maxActivePlaying: 1,
      maxVisiblePaused: 2
    })
    const summary = summarizeProjectCanvasVideoBudget(budgetedItems)

    expect(budgetedItems.find(({ item }) => item.id === selectedPausedVideo.id)?.mode).toBe(
      'visible-paused'
    )
    expect(summary.visiblePausedCount).toBe(3)
    expect(summary.posterFrameCount).toBe(3)
  })
})
