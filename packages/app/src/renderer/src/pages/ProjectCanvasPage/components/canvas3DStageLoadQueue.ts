import type { CanvasModel3DItem } from '../types'
import { PROJECT_CANVAS_MIN_STAGE_SCALE } from '../projectCanvasViewportScale'

export const MIN_MODEL_RENDER_SIZE_PX = 0
export const INITIAL_MODEL_LOAD_LIMIT = 4
export const MODEL_LOAD_BATCH_SIZE = 2
export const MODEL_LOAD_BATCH_DELAY_MS = 90
const MODEL_LOAD_LIMIT_WINDOW = 4
const MODEL_LOAD_BATCH_POLICY_WINDOW = 3
const MIN_MODEL_LOAD_BATCH_DELAY_MS = 60
const MAX_MODEL_LOAD_BATCH_DELAY_MS = 180
const MAX_MODEL_LOAD_BATCH_SIZE = 3

const MODEL_FORMAT_LOAD_COMPLEXITY: Record<string, number> = {
  glb: 1,
  gltf: 2,
  stl: 3,
  obj: 4,
  fbx: 5
}

export type Canvas3DStageItemDisplayMetrics = {
  canvasWidth: number
  canvasHeight: number
  displayWidth: number
  displayHeight: number
  displayArea: number
}

type Canvas3DStageLoadCandidate = {
  id: string
  displayArea: number
  isSelected: boolean
  zIndex: number
  shouldRenderPlaceholderOnly: boolean
  loadComplexity: number
}

export type Canvas3DStagePrioritizedLoadItem = Pick<
  Canvas3DStageLoadCandidate,
  'id' | 'loadComplexity'
>

const getCanvas3DStageModelExtension = (fileName: string) =>
  fileName.toLowerCase().split('.').pop() || ''

export const getCanvas3DStageModelLoadComplexity = (item: CanvasModel3DItem) =>
  (MODEL_FORMAT_LOAD_COMPLEXITY[getCanvas3DStageModelExtension(item.fileName)] ?? 4) +
  Math.min(Object.keys(item.textures ?? {}).length, 3)

export const resolveCanvas3DStageImmediateLoadLimit = ({
  prioritizedItems,
  maxImmediateLoadLimit = INITIAL_MODEL_LOAD_LIMIT
}: {
  prioritizedItems: readonly Pick<Canvas3DStageLoadCandidate, 'loadComplexity'>[]
  maxImmediateLoadLimit?: number
}) => {
  if (prioritizedItems.length === 0) {
    return 0
  }

  const leadingItems = prioritizedItems.slice(0, MODEL_LOAD_LIMIT_WINDOW)
  const averageLoadComplexity =
    leadingItems.reduce((sum, item) => sum + item.loadComplexity, 0) / leadingItems.length

  if (averageLoadComplexity >= 5) {
    return Math.min(maxImmediateLoadLimit, 1)
  }
  if (averageLoadComplexity >= 4) {
    return Math.min(maxImmediateLoadLimit, 2)
  }
  if (averageLoadComplexity >= 3) {
    return Math.min(maxImmediateLoadLimit, 3)
  }

  return Math.min(maxImmediateLoadLimit, prioritizedItems.length)
}

export const resolveCanvas3DStageActivationBatchPolicy = ({
  prioritizedItems,
  activatedIds,
  defaultBatchSize = MODEL_LOAD_BATCH_SIZE,
  defaultDelayMs = MODEL_LOAD_BATCH_DELAY_MS
}: {
  prioritizedItems: readonly Canvas3DStagePrioritizedLoadItem[]
  activatedIds: ReadonlySet<string>
  defaultBatchSize?: number
  defaultDelayMs?: number
}) => {
  const pendingItems = prioritizedItems.filter((item) => !activatedIds.has(item.id))
  if (pendingItems.length === 0) {
    return {
      batchSize: 0,
      delayMs: defaultDelayMs
    }
  }

  const leadingItems = pendingItems.slice(0, MODEL_LOAD_BATCH_POLICY_WINDOW)
  const averageLoadComplexity =
    leadingItems.reduce((sum, item) => sum + item.loadComplexity, 0) / leadingItems.length

  if (averageLoadComplexity >= 5) {
    return {
      batchSize: 1,
      delayMs: MAX_MODEL_LOAD_BATCH_DELAY_MS
    }
  }

  if (averageLoadComplexity >= 4) {
    return {
      batchSize: 1,
      delayMs: Math.max(defaultDelayMs, 140)
    }
  }

  if (averageLoadComplexity >= 3) {
    return {
      batchSize: Math.min(defaultBatchSize, pendingItems.length),
      delayMs: Math.max(defaultDelayMs, 110)
    }
  }

  return {
    batchSize: Math.min(MAX_MODEL_LOAD_BATCH_SIZE, pendingItems.length),
    delayMs: MIN_MODEL_LOAD_BATCH_DELAY_MS
  }
}

export const getCanvas3DStageItemDisplayMetrics = (
  item: CanvasModel3DItem,
  stageScale: number
): Canvas3DStageItemDisplayMetrics => {
  const safeStageScale = Math.max(Math.abs(stageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
  const canvasWidth = Math.max(1, item.width * Math.abs(item.scaleX || 1))
  const canvasHeight = Math.max(1, item.height * Math.abs(item.scaleY || 1))
  const displayWidth = canvasWidth * safeStageScale
  const displayHeight = canvasHeight * safeStageScale

  return {
    canvasWidth,
    canvasHeight,
    displayWidth,
    displayHeight,
    displayArea: displayWidth * displayHeight
  }
}

export const resolveCanvas3DStageLoadQueue = ({
  items,
  selectedIds,
  stageScale,
  minModelRenderSizePx = MIN_MODEL_RENDER_SIZE_PX
}: {
  items: CanvasModel3DItem[]
  selectedIds: ReadonlySet<string>
  stageScale: number
  minModelRenderSizePx?: number
}) => {
  const candidates: Canvas3DStageLoadCandidate[] = items.map((item) => {
    const metrics = getCanvas3DStageItemDisplayMetrics(item, stageScale)
    return {
      id: item.id,
      displayArea: metrics.displayArea,
      isSelected: selectedIds.has(item.id),
      zIndex: item.zIndex,
      loadComplexity: getCanvas3DStageModelLoadComplexity(item),
      shouldRenderPlaceholderOnly:
        metrics.displayWidth < minModelRenderSizePx || metrics.displayHeight < minModelRenderSizePx
    }
  })

  candidates.sort((left, right) => {
    if (left.isSelected !== right.isSelected) {
      return left.isSelected ? -1 : 1
    }
    if (left.loadComplexity !== right.loadComplexity) {
      return left.loadComplexity - right.loadComplexity
    }
    if (left.displayArea !== right.displayArea) {
      return right.displayArea - left.displayArea
    }
    if (left.zIndex !== right.zIndex) {
      return right.zIndex - left.zIndex
    }
    return left.id.localeCompare(right.id)
  })

  const prioritizedCandidates = candidates.filter(
    (candidate) => !candidate.shouldRenderPlaceholderOnly
  )

  return {
    prioritizedLoadIds: prioritizedCandidates.map((candidate) => candidate.id),
    prioritizedLoadItems: prioritizedCandidates.map((candidate) => ({
      id: candidate.id,
      loadComplexity: candidate.loadComplexity
    })),
    placeholderOnlyIds: new Set(
      candidates
        .filter((candidate) => candidate.shouldRenderPlaceholderOnly)
        .map((candidate) => candidate.id)
    ),
    immediateLoadLimit: resolveCanvas3DStageImmediateLoadLimit({
      prioritizedItems: prioritizedCandidates
    })
  }
}

export const resolveCanvas3DStageActivatedIds = ({
  prioritizedLoadIds,
  previousActivatedIds,
  immediateLoadLimit = INITIAL_MODEL_LOAD_LIMIT
}: {
  prioritizedLoadIds: readonly string[]
  previousActivatedIds: ReadonlySet<string>
  immediateLoadLimit?: number
}) => {
  const visibleLoadIdSet = new Set(prioritizedLoadIds)
  const nextActivatedIds = new Set(
    [...previousActivatedIds].filter((itemId) => visibleLoadIdSet.has(itemId))
  )

  for (const itemId of prioritizedLoadIds.slice(0, immediateLoadLimit)) {
    nextActivatedIds.add(itemId)
  }

  return nextActivatedIds
}

export const resolveCanvas3DStageNextActivationBatch = ({
  prioritizedLoadIds,
  activatedIds,
  batchSize = MODEL_LOAD_BATCH_SIZE
}: {
  prioritizedLoadIds: readonly string[]
  activatedIds: ReadonlySet<string>
  batchSize?: number
}) => prioritizedLoadIds.filter((itemId) => !activatedIds.has(itemId)).slice(0, batchSize)

export const areCanvas3DStageIdSetsEqual = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
) => {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}
