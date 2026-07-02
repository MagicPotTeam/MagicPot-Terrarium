import { getCanvasImageAssetSize, isCanvasImagePlaceholderAsset } from './canvasImageAssetUtils'
import { PROJECT_CANVAS_MIN_STAGE_SCALE } from './projectCanvasViewportScale'
import type { CanvasImageAsset, CanvasImageItem } from './types'

export const PROJECT_CANVAS_IMAGE_LOD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE = 0.15
export const PROJECT_CANVAS_IMAGE_LOD_SOURCE_TEXTURE_MIN_GAIN_RATIO = 1.25
export const PROJECT_CANVAS_IMAGE_LOD_SOURCE_TEXTURE_SCREEN_UPGRADE_RATIO = 2

export type CanvasImageSourceSuppressionReason =
  | 'overview-scale'
  | 'not-visible'
  | 'not-needed'
  | 'texture-budget'
  | 'missing-source'
  | 'insufficient-source-gain'

export type CanvasImageLodDecision = {
  safeScale: number
  isOverviewScale: boolean
  hasPreviewImage: boolean
  usesPlaceholderPreview: boolean
  usesThumbnailPreview: boolean
  sourceTextureNeeded: boolean
  shouldUseSourceTexture: boolean
  sourceTextureSuppressed: boolean
  sourceTextureSuppressionReason: CanvasImageSourceSuppressionReason | null
  projectedMaxSide: number
  previewMaxSide: number
  sourceMaxSide: number
}

export type ResolveCanvasImageLodDecisionOptions = {
  item: Pick<
    CanvasImageItem,
    'id' | 'src' | 'width' | 'height' | 'scaleX' | 'scaleY' | 'sourceWidth' | 'sourceHeight'
  >
  image: CanvasImageAsset | null | undefined
  stageScale: number
  selectedIds?: ReadonlySet<string>
  isVisible?: boolean
  forceSource?: boolean
  sourceTextureByteSize?: number
  residentTextureBytes?: number
  existingTextureBytes?: number
  residentTextureBudgetBytes?: number
  deviceScale?: number
}

function hasFinitePositiveSize(width: number, height: number) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
}

function hasResidentTextureBudget({
  sourceTextureByteSize,
  residentTextureBytes,
  existingTextureBytes,
  residentTextureBudgetBytes
}: Pick<
  ResolveCanvasImageLodDecisionOptions,
  | 'sourceTextureByteSize'
  | 'residentTextureBytes'
  | 'existingTextureBytes'
  | 'residentTextureBudgetBytes'
>) {
  if (
    typeof sourceTextureByteSize !== 'number' ||
    typeof residentTextureBudgetBytes !== 'number' ||
    !Number.isFinite(sourceTextureByteSize) ||
    !Number.isFinite(residentTextureBudgetBytes)
  ) {
    return true
  }

  const currentBytes =
    typeof residentTextureBytes === 'number' && Number.isFinite(residentTextureBytes)
      ? residentTextureBytes
      : 0
  const replacedBytes =
    typeof existingTextureBytes === 'number' && Number.isFinite(existingTextureBytes)
      ? existingTextureBytes
      : 0

  return (
    Math.max(0, currentBytes - replacedBytes) + sourceTextureByteSize <= residentTextureBudgetBytes
  )
}

export function isCanvasImageSelectedSourceUpgradeEligible(
  itemId: string,
  selectedIds: ReadonlySet<string> | undefined,
  selectedProtectedLimit: number
) {
  const selectedCount = selectedIds?.size ?? 0
  return (
    selectedCount > 0 &&
    selectedCount <= selectedProtectedLimit &&
    Boolean(selectedIds?.has(itemId))
  )
}

export function resolveCanvasImageLodDecision({
  item,
  image,
  stageScale,
  selectedIds,
  isVisible = true,
  forceSource = false,
  sourceTextureByteSize,
  residentTextureBytes,
  existingTextureBytes,
  residentTextureBudgetBytes,
  deviceScale = 1
}: ResolveCanvasImageLodDecisionOptions): CanvasImageLodDecision {
  const safeScale = Math.max(Math.abs(stageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
  const safeDeviceScale =
    Number.isFinite(deviceScale) && deviceScale > 0 ? Math.max(1, deviceScale) : 1
  const isOverviewScale =
    safeScale <= PROJECT_CANVAS_IMAGE_LOD_OVERVIEW_SOURCE_SUPPRESSION_MAX_SCALE
  const imageSize = getCanvasImageAssetSize(image)
  const hasPreviewImage = Boolean(image && hasFinitePositiveSize(imageSize.width, imageSize.height))
  const sourceWidth =
    typeof item.sourceWidth === 'number' &&
    Number.isFinite(item.sourceWidth) &&
    item.sourceWidth > 0
      ? item.sourceWidth
      : hasPreviewImage
        ? imageSize.width
        : item.width
  const sourceHeight =
    typeof item.sourceHeight === 'number' &&
    Number.isFinite(item.sourceHeight) &&
    item.sourceHeight > 0
      ? item.sourceHeight
      : hasPreviewImage
        ? imageSize.height
        : item.height
  const previewMaxSide = hasPreviewImage ? Math.max(imageSize.width, imageSize.height) : 0
  const sourceMaxSide = Math.max(sourceWidth, sourceHeight)
  const projectedMaxSide =
    Math.max(Math.abs(item.width * item.scaleX), Math.abs(item.height * item.scaleY)) *
    safeScale *
    safeDeviceScale
  const usesPlaceholderPreview = isCanvasImagePlaceholderAsset(image)
  const hasEnoughSourceGain =
    !hasPreviewImage ||
    (Number.isFinite(sourceMaxSide) &&
      sourceMaxSide > previewMaxSide * PROJECT_CANVAS_IMAGE_LOD_SOURCE_TEXTURE_MIN_GAIN_RATIO)
  const shouldBypassSourceGainForForcedSource = Boolean(
    forceSource && hasPreviewImage && !usesPlaceholderPreview
  )
  const canUseThumbnailPreview = hasEnoughSourceGain || shouldBypassSourceGainForForcedSource
  const usesThumbnailPreview = Boolean(
    hasPreviewImage && !usesPlaceholderPreview && canUseThumbnailPreview
  )
  const canConsiderSource = Boolean(item.src) && canUseThumbnailPreview

  let sourceTextureNeeded = false
  let shouldUseSourceTexture = false
  let sourceTextureSuppressed = false
  let sourceTextureSuppressionReason: CanvasImageSourceSuppressionReason | null = null

  if (!item.src) {
    sourceTextureSuppressionReason = 'missing-source'
  } else if (!canConsiderSource) {
    sourceTextureSuppressionReason = 'insufficient-source-gain'
  } else if (isOverviewScale) {
    sourceTextureSuppressed = true
    sourceTextureSuppressionReason = 'overview-scale'
  } else if (!isVisible) {
    sourceTextureSuppressed = true
    sourceTextureSuppressionReason = 'not-visible'
  } else {
    sourceTextureNeeded =
      !hasPreviewImage ||
      forceSource ||
      Boolean(selectedIds?.has(item.id) && forceSource) ||
      projectedMaxSide >
        previewMaxSide * PROJECT_CANVAS_IMAGE_LOD_SOURCE_TEXTURE_SCREEN_UPGRADE_RATIO

    if (!sourceTextureNeeded) {
      sourceTextureSuppressionReason = 'not-needed'
    } else if (
      !hasResidentTextureBudget({
        sourceTextureByteSize,
        residentTextureBytes,
        existingTextureBytes,
        residentTextureBudgetBytes
      })
    ) {
      sourceTextureSuppressed = true
      sourceTextureSuppressionReason = 'texture-budget'
    } else {
      shouldUseSourceTexture = true
    }
  }

  return {
    safeScale,
    isOverviewScale,
    hasPreviewImage,
    usesPlaceholderPreview,
    usesThumbnailPreview,
    sourceTextureNeeded,
    shouldUseSourceTexture,
    sourceTextureSuppressed,
    sourceTextureSuppressionReason,
    projectedMaxSide,
    previewMaxSide,
    sourceMaxSide
  }
}
