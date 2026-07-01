import type {
  CanvasImageAsset,
  CanvasHtmlItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasVideoItem
} from './types'
import { resolveCanvasImageDisplayCrop } from './canvasImageDisplayUtils'
import { getCanvasImageAssetSize } from './canvasImageAssetUtils'
import { getCanvasViewportBounds } from './canvasViewportPlacementUtils'
import { PROJECT_CANVAS_MIN_STAGE_SCALE } from './projectCanvasViewportScale'

export type ProjectCanvasRenderableMediaKind = 'image' | 'video' | 'model3d' | 'html'
export type ProjectCanvasRenderableSurface =
  | 'webgl-image'
  | 'webgl-model3d-stage'
  | 'html-video-overlay'
  | 'html-overlay'
export type ProjectCanvasImageRuntimeRoute =
  | 'webgl-primary'
  | 'budget-image-proxy'
  | 'fallback-image-proxy'
  | 'crop-excluded'
export type ProjectCanvasImageInteractionMode =
  | 'dom-image-overlay'
  | 'placeholder-hit-proxy'
  | 'crop-excluded'
export type ProjectCanvasVideoBudgetMode =
  | 'active-playing'
  | 'visible-paused'
  | 'poster-frame'
  | 'unmounted'
export type ProjectCanvasInteractionProxy =
  | 'canvas-image-node'
  | 'canvas-placeholder'
  | 'html-overlay'

export type ProjectCanvasBudgetedVideoItem = {
  item: CanvasVideoItem
  mode: ProjectCanvasVideoBudgetMode
  isVisible: boolean
}

export type ProjectCanvasVideoBudgetSummary = {
  totalVideos: number
  activePlayingCount: number
  visiblePausedCount: number
  posterFrameCount: number
  unmountedCount: number
}

export type ProjectCanvasResolvedRenderSurface = ProjectCanvasRenderableSurface | 'fallback-image'

export type ProjectCanvasImageFallbackReason =
  | 'unloaded'
  | 'failed'
  | 'unsupported'
  | 'webgl-unavailable'
  | 'generated-cooldown'

export type ProjectCanvasResolvedRenderItem = ProjectCanvasRenderableItem & {
  runtimeSurface: ProjectCanvasResolvedRenderSurface
  imageRuntimeRoute?: ProjectCanvasImageRuntimeRoute
  imageFallbackReason?: ProjectCanvasImageFallbackReason | null
  videoBudgetMode?: ProjectCanvasVideoBudgetMode
  isVisible: boolean
}

export type ProjectCanvasImageFallbackSummary = {
  fallbackImageItems: number
  unloadedImageItems: number
  failedImageItems: number
  unsupportedImageItems: number
  webglUnavailableImageItems: number
  generatedCooldownImageItems: number
}

export const PROJECT_CANVAS_RENDERABLE_MEDIA_KINDS = ['image', 'video', 'model3d', 'html'] as const

export const PROJECT_CANVAS_RENDERABLE_SURFACES = [
  'webgl-image',
  'webgl-model3d-stage',
  'html-video-overlay',
  'html-overlay'
] as const

export const PROJECT_CANVAS_RENDERABLE_INTERACTION_PROXIES = [
  'canvas-image-node',
  'canvas-placeholder',
  'html-overlay'
] as const

const PROJECT_CANVAS_RENDERABLE_MEDIA_KIND_BY_ITEM_TYPE: Partial<
  Record<CanvasItem['type'], ProjectCanvasRenderableMediaKind>
> = {
  image: 'image',
  video: 'video',
  model3d: 'model3d',
  html: 'html'
}

const PROJECT_CANVAS_RENDERABLE_DESCRIPTOR_BY_KIND = {
  image: {
    surface: 'webgl-image',
    interactionProxy: 'canvas-image-node'
  },
  video: {
    surface: 'html-video-overlay',
    interactionProxy: 'canvas-placeholder'
  },
  model3d: {
    surface: 'webgl-model3d-stage',
    interactionProxy: 'canvas-placeholder'
  },
  html: {
    surface: 'html-overlay',
    interactionProxy: 'html-overlay'
  }
} as const satisfies Record<
  ProjectCanvasRenderableMediaKind,
  {
    surface: ProjectCanvasRenderableSurface
    interactionProxy: ProjectCanvasInteractionProxy
  }
>

export type ProjectCanvasRenderableTransform = {
  x: number
  y: number
  width: number
  height: number
  scaleX: number
  scaleY: number
  rotation: number
}

export type ProjectCanvasImagePreview = ProjectCanvasRenderableTransform

export type ProjectCanvasRenderableBase<TItem extends CanvasItem> =
  ProjectCanvasRenderableTransform & {
    id: string
    item: TItem
    itemType: TItem['type']
    kind: ProjectCanvasRenderableMediaKind
    surface: ProjectCanvasRenderableSurface
    interactionProxy: ProjectCanvasInteractionProxy
    zIndex: number
  }

export type ProjectCanvasRenderableImageItem = ProjectCanvasRenderableBase<CanvasImageItem> & {
  kind: 'image'
  surface: 'webgl-image'
  interactionProxy: 'canvas-image-node'
  src: string
}

export type ProjectCanvasRenderableVideoItem = ProjectCanvasRenderableBase<CanvasVideoItem> & {
  kind: 'video'
  surface: 'html-video-overlay'
  interactionProxy: 'canvas-placeholder'
  src: string
}

export type ProjectCanvasRenderableModel3DItem = ProjectCanvasRenderableBase<CanvasModel3DItem> & {
  kind: 'model3d'
  surface: 'webgl-model3d-stage'
  interactionProxy: 'canvas-placeholder'
  src: string
}

export type ProjectCanvasRenderableHtmlItem = ProjectCanvasRenderableBase<CanvasHtmlItem> & {
  kind: 'html'
  surface: 'html-overlay'
  interactionProxy: 'html-overlay'
}

export type ProjectCanvasRenderableItem =
  | ProjectCanvasRenderableImageItem
  | ProjectCanvasRenderableVideoItem
  | ProjectCanvasRenderableModel3DItem
  | ProjectCanvasRenderableHtmlItem

export type ProjectCanvasRenderableImage = ProjectCanvasRenderableImageItem & {
  image: CanvasImageAsset
  sourceWidth: number
  sourceHeight: number
  crop?: {
    x: number
    y: number
    width: number
    height: number
  }
}

export type ProjectCanvasRenderSurfaceSummary = {
  totalItems: number
  imageItems: number
  webglImageItems: number
  webglModel3DItems: number
  fallbackImageItems: number
  videoOverlayItems: number
  htmlOverlayItems: number
}

export type ProjectCanvasRuntimeSurfaceSummary = ProjectCanvasRenderSurfaceSummary & {
  budgetDowngradedImageItems: number
  cropExcludedImageItems: number
}

export type ResolveProjectCanvasRenderBoundaryParams = {
  items: CanvasItem[]
  cropTargetId?: string | null
  webglReady: boolean
  loadedImageIds: ReadonlySet<string>
  residentImageIds?: ReadonlySet<string>
  failedImageIds?: ReadonlySet<string>
  unsupportedImageIds?: ReadonlySet<string>
  generatedCooldownImageIds?: ReadonlySet<string>
  selectedIds?: ReadonlySet<string>
  stagePos?: { x: number; y: number }
  stageScale?: number
  stageSize?: { width: number; height: number }
  forceRenderAllItemsForExport?: boolean
}

const PROJECT_CANVAS_VIDEO_VISIBLE_OVERSCAN_PX = 320
const PROJECT_CANVAS_VIDEO_ACTIVE_MIN_EDGE_PX = 96
const PROJECT_CANVAS_VIDEO_POSTER_FRAME_MAX_EDGE_PX = 72
const PROJECT_CANVAS_VIDEO_MAX_ACTIVE_PLAYING = 4
const PROJECT_CANVAS_VIDEO_MAX_VISIBLE_PAUSED = 8

function buildRenderableTransform(
  item: Pick<CanvasItem, 'x' | 'y' | 'width' | 'height' | 'scaleX' | 'scaleY' | 'rotation'>
): ProjectCanvasRenderableTransform {
  return {
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    scaleX: item.scaleX,
    scaleY: item.scaleY,
    rotation: item.rotation
  }
}

function getProjectCanvasVideoBounds(item: CanvasVideoItem) {
  const scaledWidth = item.width * (item.scaleX || 1)
  const scaledHeight = item.height * (item.scaleY || 1)

  return {
    x: Math.min(item.x, item.x + scaledWidth),
    y: Math.min(item.y, item.y + scaledHeight),
    width: Math.abs(scaledWidth),
    height: Math.abs(scaledHeight)
  }
}

export function getProjectCanvasRenderableMediaKind(
  itemType: CanvasItem['type']
): ProjectCanvasRenderableMediaKind | null {
  return PROJECT_CANVAS_RENDERABLE_MEDIA_KIND_BY_ITEM_TYPE[itemType] ?? null
}

export function isProjectCanvasRenderableMediaKind(
  value: string
): value is ProjectCanvasRenderableMediaKind {
  return PROJECT_CANVAS_RENDERABLE_MEDIA_KINDS.includes(value as ProjectCanvasRenderableMediaKind)
}

export function getProjectCanvasRenderableSurfaceForKind(
  kind: ProjectCanvasRenderableMediaKind
): ProjectCanvasRenderableSurface {
  return PROJECT_CANVAS_RENDERABLE_DESCRIPTOR_BY_KIND[kind].surface
}

export function getProjectCanvasInteractionProxyForKind(
  kind: ProjectCanvasRenderableMediaKind
): ProjectCanvasInteractionProxy {
  return PROJECT_CANVAS_RENDERABLE_DESCRIPTOR_BY_KIND[kind].interactionProxy
}

export function isProjectCanvasRenderableSurface(
  value: string
): value is ProjectCanvasRenderableSurface {
  return PROJECT_CANVAS_RENDERABLE_SURFACES.includes(value as ProjectCanvasRenderableSurface)
}

export function isProjectCanvasRenderableInteractionProxy(
  value: string
): value is ProjectCanvasInteractionProxy {
  return PROJECT_CANVAS_RENDERABLE_INTERACTION_PROXIES.includes(
    value as ProjectCanvasInteractionProxy
  )
}

export function buildProjectCanvasRenderableItem(
  item: CanvasItem
): ProjectCanvasRenderableItem | null {
  const transform = buildRenderableTransform(item)
  switch (item.type) {
    case 'image':
      return {
        ...transform,
        id: item.id,
        item,
        itemType: item.type,
        kind: 'image',
        surface: PROJECT_CANVAS_RENDERABLE_DESCRIPTOR_BY_KIND.image.surface,
        interactionProxy: PROJECT_CANVAS_RENDERABLE_DESCRIPTOR_BY_KIND.image.interactionProxy,
        src: item.src,
        zIndex: item.zIndex
      }
    case 'video':
      return {
        ...transform,
        id: item.id,
        item,
        itemType: item.type,
        kind: 'video',
        surface: PROJECT_CANVAS_RENDERABLE_DESCRIPTOR_BY_KIND.video.surface,
        interactionProxy: PROJECT_CANVAS_RENDERABLE_DESCRIPTOR_BY_KIND.video.interactionProxy,
        src: item.src,
        zIndex: item.zIndex
      }
    case 'model3d':
      return {
        ...transform,
        id: item.id,
        item,
        itemType: item.type,
        kind: 'model3d',
        surface: PROJECT_CANVAS_RENDERABLE_DESCRIPTOR_BY_KIND.model3d.surface,
        interactionProxy: PROJECT_CANVAS_RENDERABLE_DESCRIPTOR_BY_KIND.model3d.interactionProxy,
        src: item.src,
        zIndex: item.zIndex
      }
    case 'html':
      return {
        ...transform,
        id: item.id,
        item,
        itemType: item.type,
        kind: 'html',
        surface: PROJECT_CANVAS_RENDERABLE_DESCRIPTOR_BY_KIND.html.surface,
        interactionProxy: PROJECT_CANVAS_RENDERABLE_DESCRIPTOR_BY_KIND.html.interactionProxy,
        zIndex: item.zIndex
      }
    default:
      return null
  }
}

export function buildProjectCanvasRenderableItems(
  items: CanvasItem[]
): ProjectCanvasRenderableItem[] {
  return items
    .map((item) => buildProjectCanvasRenderableItem(item))
    .filter((item): item is ProjectCanvasRenderableItem => item !== null)
}

export function summarizeProjectCanvasRenderSurfaces(
  items: CanvasItem[]
): ProjectCanvasRenderSurfaceSummary {
  const renderables = buildProjectCanvasRenderableItems(items)

  return renderables.reduce<ProjectCanvasRenderSurfaceSummary>(
    (summary, item) => {
      summary.totalItems += 1

      if (item.kind === 'image') {
        summary.imageItems += 1
        if (item.surface === 'webgl-image') {
          summary.webglImageItems += 1
        } else {
          summary.fallbackImageItems += 1
        }
        return summary
      }

      if (item.kind === 'video') {
        summary.videoOverlayItems += 1
        return summary
      }

      if (item.kind === 'model3d') {
        summary.webglModel3DItems += 1
        return summary
      }

      summary.htmlOverlayItems += 1
      return summary
    },
    {
      totalItems: 0,
      imageItems: 0,
      webglImageItems: 0,
      webglModel3DItems: 0,
      fallbackImageItems: 0,
      videoOverlayItems: 0,
      htmlOverlayItems: 0
    }
  )
}

export function resolveProjectCanvasImageRuntimeRoute({
  item,
  isCropTarget,
  webglReady,
  loadedImageIds,
  residentImageIds,
  generatedCooldownImageIds
}: {
  item: Pick<CanvasImageItem, 'id'>
  isCropTarget: boolean
  webglReady: boolean
  loadedImageIds: ReadonlySet<string>
  residentImageIds?: ReadonlySet<string>
  generatedCooldownImageIds?: ReadonlySet<string>
}): ProjectCanvasImageRuntimeRoute {
  if (isCropTarget) {
    return 'crop-excluded'
  }

  if (!webglReady || generatedCooldownImageIds?.has(item.id)) {
    return 'fallback-image-proxy'
  }

  const activeResidentImageIds = residentImageIds ?? loadedImageIds
  if (activeResidentImageIds.has(item.id)) {
    return 'webgl-primary'
  }

  if (loadedImageIds.has(item.id)) {
    return 'budget-image-proxy'
  }

  return 'fallback-image-proxy'
}

export function resolveProjectCanvasImageInteractionMode({
  item: _item,
  runtimeRoute,
  tool,
  isSingleSelected
}: {
  item?: Pick<CanvasImageItem, 'scaleX' | 'scaleY'>
  runtimeRoute: ProjectCanvasImageRuntimeRoute
  tool: string
  isSingleSelected: boolean
}): ProjectCanvasImageInteractionMode {
  if (runtimeRoute === 'crop-excluded') {
    return 'crop-excluded'
  }

  if (tool === 'select' && isSingleSelected) {
    return 'dom-image-overlay'
  }

  return 'placeholder-hit-proxy'
}

export function resolveProjectCanvasImageFallbackReason({
  item,
  runtimeRoute,
  failedImageIds,
  unsupportedImageIds,
  generatedCooldownImageIds,
  webglReady
}: {
  item: Pick<CanvasImageItem, 'id'>
  runtimeRoute: ProjectCanvasImageRuntimeRoute
  failedImageIds?: ReadonlySet<string>
  unsupportedImageIds?: ReadonlySet<string>
  generatedCooldownImageIds?: ReadonlySet<string>
  webglReady?: boolean
}): ProjectCanvasImageFallbackReason | null {
  if (runtimeRoute !== 'fallback-image-proxy') {
    return null
  }

  if (unsupportedImageIds?.has(item.id)) {
    return 'unsupported'
  }

  if (failedImageIds?.has(item.id)) {
    return 'failed'
  }

  if (generatedCooldownImageIds?.has(item.id)) {
    return 'generated-cooldown'
  }

  if (webglReady === false) {
    return 'webgl-unavailable'
  }

  return 'unloaded'
}

export function summarizeProjectCanvasImageFallbacks(
  items: ProjectCanvasResolvedRenderItem[]
): ProjectCanvasImageFallbackSummary {
  return items.reduce<ProjectCanvasImageFallbackSummary>(
    (summary, item) => {
      if (item.kind !== 'image' || item.runtimeSurface !== 'fallback-image') {
        return summary
      }

      summary.fallbackImageItems += 1
      if (item.imageFallbackReason === 'failed') {
        summary.failedImageItems += 1
      } else if (item.imageFallbackReason === 'unsupported') {
        summary.unsupportedImageItems += 1
      } else if (item.imageFallbackReason === 'webgl-unavailable') {
        summary.webglUnavailableImageItems += 1
      } else if (item.imageFallbackReason === 'generated-cooldown') {
        summary.generatedCooldownImageItems += 1
      } else {
        summary.unloadedImageItems += 1
      }

      return summary
    },
    {
      fallbackImageItems: 0,
      unloadedImageItems: 0,
      failedImageItems: 0,
      unsupportedImageItems: 0,
      webglUnavailableImageItems: 0,
      generatedCooldownImageItems: 0
    }
  )
}

export function resolveProjectCanvasRenderBoundary({
  items,
  cropTargetId,
  webglReady,
  loadedImageIds,
  residentImageIds,
  failedImageIds,
  unsupportedImageIds,
  generatedCooldownImageIds,
  selectedIds = new Set<string>(),
  stagePos,
  stageScale,
  stageSize,
  forceRenderAllItemsForExport = false
}: ResolveProjectCanvasRenderBoundaryParams): ProjectCanvasResolvedRenderItem[] {
  const renderables = buildProjectCanvasRenderableItems(items)
  const videoItems = renderables.filter(
    (item): item is ProjectCanvasRenderableVideoItem => item.kind === 'video'
  )
  const videoBudgetById = new Map<string, ProjectCanvasBudgetedVideoItem>()

  if (videoItems.length > 0 && stagePos && stageScale != null && stageSize) {
    resolveProjectCanvasBudgetedVideoItems({
      items: videoItems.map((item) => item.item),
      selectedIds,
      stagePos,
      stageScale,
      stageSize,
      forceRenderAllItemsForExport
    }).forEach((budgetedItem) => {
      videoBudgetById.set(budgetedItem.item.id, budgetedItem)
    })
  }

  return renderables.map((item) => {
    if (item.kind === 'image') {
      const imageRuntimeRoute = resolveProjectCanvasImageRuntimeRoute({
        item: item.item,
        isCropTarget: cropTargetId === item.id,
        webglReady,
        loadedImageIds,
        residentImageIds,
        generatedCooldownImageIds
      })
      const imageFallbackReason = resolveProjectCanvasImageFallbackReason({
        item: item.item,
        runtimeRoute: imageRuntimeRoute,
        failedImageIds,
        unsupportedImageIds,
        generatedCooldownImageIds,
        webglReady
      })

      return {
        ...item,
        runtimeSurface:
          imageRuntimeRoute === 'fallback-image-proxy' ? 'fallback-image' : item.surface,
        imageRuntimeRoute,
        imageFallbackReason,
        isVisible: imageRuntimeRoute !== 'crop-excluded'
      }
    }

    if (item.kind === 'video') {
      const budgetedItem = videoBudgetById.get(item.id)
      return {
        ...item,
        runtimeSurface: item.surface,
        videoBudgetMode: budgetedItem?.mode,
        isVisible: budgetedItem ? budgetedItem.mode !== 'unmounted' : true
      }
    }

    return {
      ...item,
      runtimeSurface: item.surface,
      isVisible: true
    }
  })
}

export function summarizeProjectCanvasRuntimeSurfaces({
  items,
  cropTargetId,
  webglReady,
  loadedImageIds,
  residentImageIds,
  failedImageIds,
  unsupportedImageIds,
  generatedCooldownImageIds,
  selectedIds,
  stagePos,
  stageScale,
  stageSize,
  forceRenderAllItemsForExport
}: ResolveProjectCanvasRenderBoundaryParams): ProjectCanvasRuntimeSurfaceSummary {
  const renderables = resolveProjectCanvasRenderBoundary({
    items,
    cropTargetId,
    webglReady,
    loadedImageIds,
    residentImageIds,
    failedImageIds,
    unsupportedImageIds,
    generatedCooldownImageIds,
    selectedIds,
    stagePos,
    stageScale,
    stageSize,
    forceRenderAllItemsForExport
  })

  return renderables.reduce<ProjectCanvasRuntimeSurfaceSummary>(
    (summary, item) => {
      summary.totalItems += 1

      if (item.kind === 'image') {
        summary.imageItems += 1

        if (item.imageRuntimeRoute === 'webgl-primary') {
          summary.webglImageItems += 1
        } else if (item.imageRuntimeRoute === 'budget-image-proxy') {
          summary.budgetDowngradedImageItems += 1
        } else if (item.imageRuntimeRoute === 'crop-excluded') {
          summary.cropExcludedImageItems += 1
        } else if (item.runtimeSurface === 'fallback-image') {
          summary.fallbackImageItems += 1
        }
        return summary
      }

      if (item.kind === 'video') {
        summary.videoOverlayItems += 1
        return summary
      }

      if (item.kind === 'model3d') {
        summary.webglModel3DItems += 1
        return summary
      }

      summary.htmlOverlayItems += 1
      return summary
    },
    {
      totalItems: 0,
      imageItems: 0,
      webglImageItems: 0,
      webglModel3DItems: 0,
      budgetDowngradedImageItems: 0,
      fallbackImageItems: 0,
      cropExcludedImageItems: 0,
      videoOverlayItems: 0,
      htmlOverlayItems: 0
    }
  )
}

export function resolveProjectCanvasBudgetedVideoItems({
  items,
  selectedIds,
  stagePos,
  stageScale,
  stageSize,
  forceRenderAllItemsForExport = false,
  maxActivePlaying = PROJECT_CANVAS_VIDEO_MAX_ACTIVE_PLAYING,
  maxVisiblePaused = PROJECT_CANVAS_VIDEO_MAX_VISIBLE_PAUSED
}: {
  items: CanvasVideoItem[]
  selectedIds: ReadonlySet<string>
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize: { width: number; height: number }
  forceRenderAllItemsForExport?: boolean
  maxActivePlaying?: number
  maxVisiblePaused?: number
}): ProjectCanvasBudgetedVideoItem[] {
  if (items.length === 0) {
    return []
  }

  if (forceRenderAllItemsForExport) {
    return items.map((item) => ({
      item,
      isVisible: true,
      mode: item.playing ? 'active-playing' : 'visible-paused'
    }))
  }

  const safeScale = Math.max(Math.abs(stageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
  const overscan = PROJECT_CANVAS_VIDEO_VISIBLE_OVERSCAN_PX / safeScale
  const viewport = getCanvasViewportBounds(stagePos, stageSize, safeScale)
  const expandedViewport = {
    x: viewport.x - overscan,
    y: viewport.y - overscan,
    width: viewport.width + overscan * 2,
    height: viewport.height + overscan * 2
  }

  const candidates = items.map((item) => {
    const bounds = getProjectCanvasVideoBounds(item)
    const isSelected = selectedIds.has(item.id)
    const isVisible =
      isSelected ||
      (bounds.x + bounds.width > expandedViewport.x &&
        bounds.x < expandedViewport.x + expandedViewport.width &&
        bounds.y + bounds.height > expandedViewport.y &&
        bounds.y < expandedViewport.y + expandedViewport.height)
    const screenWidth = bounds.width * safeScale
    const screenHeight = bounds.height * safeScale
    const screenArea = screenWidth * screenHeight
    const screenMaxEdge = Math.max(screenWidth, screenHeight)

    return {
      item,
      bounds,
      isSelected,
      isVisible,
      screenArea,
      screenMaxEdge
    }
  })

  const activePlayingIds = new Set(
    candidates
      .filter(
        (candidate) =>
          candidate.item.playing &&
          candidate.isVisible &&
          candidate.screenMaxEdge >= PROJECT_CANVAS_VIDEO_ACTIVE_MIN_EDGE_PX
      )
      .sort((left, right) => {
        if (left.isSelected !== right.isSelected) {
          return left.isSelected ? -1 : 1
        }
        if (left.screenArea !== right.screenArea) {
          return right.screenArea - left.screenArea
        }
        return right.item.zIndex - left.item.zIndex
      })
      .slice(0, Math.max(1, maxActivePlaying))
      .map((candidate) => candidate.item.id)
  )

  const visiblePausedIds = new Set(
    candidates
      .filter(
        (candidate) =>
          !activePlayingIds.has(candidate.item.id) &&
          candidate.isVisible &&
          !candidate.isSelected &&
          (candidate.item.playing ||
            candidate.screenMaxEdge > PROJECT_CANVAS_VIDEO_POSTER_FRAME_MAX_EDGE_PX)
      )
      .sort((left, right) => {
        if (left.item.playing !== right.item.playing) {
          return left.item.playing ? -1 : 1
        }
        if (left.screenArea !== right.screenArea) {
          return right.screenArea - left.screenArea
        }
        return right.item.zIndex - left.item.zIndex
      })
      .slice(0, Math.max(0, maxVisiblePaused))
      .map((candidate) => candidate.item.id)
  )

  return candidates.map((candidate) => {
    if (activePlayingIds.has(candidate.item.id)) {
      return {
        item: candidate.item,
        isVisible: true,
        mode: 'active-playing'
      }
    }

    if (candidate.isVisible || candidate.isSelected) {
      return {
        item: candidate.item,
        isVisible: true,
        mode:
          candidate.isSelected || visiblePausedIds.has(candidate.item.id)
            ? 'visible-paused'
            : 'poster-frame'
      }
    }

    return {
      item: candidate.item,
      isVisible: false,
      mode: 'unmounted'
    }
  })
}

export function summarizeProjectCanvasVideoBudget(
  items: ProjectCanvasBudgetedVideoItem[]
): ProjectCanvasVideoBudgetSummary {
  return items.reduce<ProjectCanvasVideoBudgetSummary>(
    (summary, item) => {
      summary.totalVideos += 1

      if (item.mode === 'active-playing') {
        summary.activePlayingCount += 1
        return summary
      }

      if (item.mode === 'visible-paused') {
        summary.visiblePausedCount += 1
        return summary
      }

      if (item.mode === 'poster-frame') {
        summary.posterFrameCount += 1
        return summary
      }

      summary.unmountedCount += 1
      return summary
    },
    {
      totalVideos: 0,
      activePlayingCount: 0,
      visiblePausedCount: 0,
      posterFrameCount: 0,
      unmountedCount: 0
    }
  )
}

export function isProjectCanvasRenderableImageItem(
  item: ProjectCanvasRenderableItem
): item is ProjectCanvasRenderableImageItem {
  return item.kind === 'image'
}

export function isProjectCanvasRenderableVideoItem(
  item: ProjectCanvasRenderableItem
): item is ProjectCanvasRenderableVideoItem {
  return item.kind === 'video'
}

export function isProjectCanvasRenderableModel3DItem(
  item: ProjectCanvasRenderableItem
): item is ProjectCanvasRenderableModel3DItem {
  return item.kind === 'model3d'
}

export function isProjectCanvasRenderableHtmlItem(
  item: ProjectCanvasRenderableItem
): item is ProjectCanvasRenderableHtmlItem {
  return item.kind === 'html'
}

export function buildProjectCanvasRenderableImage(
  item: CanvasImageItem,
  image: CanvasImageAsset | null | undefined
): ProjectCanvasRenderableImage | null {
  if (!image) {
    return null
  }

  const crop = resolveCanvasImageDisplayCrop(item, image)
  const renderableItem = buildProjectCanvasRenderableItem(item)

  if (!renderableItem || !isProjectCanvasRenderableImageItem(renderableItem)) {
    return null
  }

  const { width: imageWidth, height: imageHeight } = getCanvasImageAssetSize(image)

  return {
    ...renderableItem,
    image,
    sourceWidth: imageWidth,
    sourceHeight: imageHeight,
    crop
  }
}

export function getProjectCanvasRenderTransformKey(renderState: ProjectCanvasImagePreview): string {
  return [
    renderState.x,
    renderState.y,
    renderState.width,
    renderState.height,
    renderState.scaleX,
    renderState.scaleY,
    renderState.rotation
  ].join('|')
}

export function getProjectCanvasRenderTextureKey(
  item: Pick<ProjectCanvasRenderableImage, 'src' | 'image' | 'crop'>
): string {
  const { width: imageWidth, height: imageHeight } = getCanvasImageAssetSize(item.image)

  return [
    item.src,
    imageWidth,
    imageHeight,
    item.crop?.x ?? 0,
    item.crop?.y ?? 0,
    item.crop?.width ?? imageWidth,
    item.crop?.height ?? imageHeight
  ].join('|')
}
