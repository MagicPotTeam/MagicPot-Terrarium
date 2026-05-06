import { loadImageFromSrc, type LoadedCanvasImage } from './canvasAssetIntakeHelpers'
import type { CanvasImageItem } from './types'

type ImageExtractRegion = {
  x: number
  y: number
  width: number
  height: number
}

type ExtractImageLocallyOptions = {
  item: CanvasImageItem
  region: ImageExtractRegion
  loadImage?: (src: string) => Promise<LoadedCanvasImage>
  loadedImage?: LoadedCanvasImage
}

type RgbColor = {
  r: number
  g: number
  b: number
}

type PaletteEntry = RgbColor & {
  count: number
}

type ForegroundComponent = {
  pixelCount: number
  pixels: number[]
  minX: number
  minY: number
  maxX: number
  maxY: number
  centroidX: number
  centroidY: number
}

export type PrimaryForegroundSelectionResult = {
  data: Uint8ClampedArray
  totalComponentCount: number
  keptComponentCount: number
  removedComponentCount: number
  keptForegroundRatio: number
}

export type LocalExtractedRegion = {
  blob: Blob
  sizeBytes: number
  sourceWidth: number
  sourceHeight: number
  backgroundRemoved: boolean
  confidence: number
}

const MIN_REGION_SIZE = 4
const BORDER_DEPTH_MAX = 10
const BORDER_DEPTH_RATIO = 0.06
const BORDER_CLUSTER_MIN_COVERAGE = 0.04
const BACKGROUND_REMOVAL_MIN_RATIO = 0.015
const BACKGROUND_REMOVAL_MAX_RATIO = 0.97
const FOREGROUND_ALPHA_THRESHOLD = 12
const FEATHER_NEIGHBOR_DISTANCE = 1.7
const TRIM_PADDING = 4
const PRIMARY_FOREGROUND_MIN_AREA_RATIO = 0.015
const PRIMARY_FOREGROUND_DOMINANT_LINK_RATIO = 0.08
const PRIMARY_FOREGROUND_KEEP_SCORE = 0.34
const PRIMARY_FOREGROUND_FALLBACK_SCORE = 0.22

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function clampRegion(region: ImageExtractRegion, sourceWidth: number, sourceHeight: number) {
  const width = clamp(region.width, MIN_REGION_SIZE, sourceWidth)
  const height = clamp(region.height, MIN_REGION_SIZE, sourceHeight)
  const x = clamp(region.x, 0, Math.max(sourceWidth - width, 0))
  const y = clamp(region.y, 0, Math.max(sourceHeight - height, 0))

  return {
    x,
    y,
    width: clamp(width, MIN_REGION_SIZE, sourceWidth - x),
    height: clamp(height, MIN_REGION_SIZE, sourceHeight - y)
  }
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to serialize extracted image.'))
        return
      }
      resolve(blob)
    }, 'image/png')
  })
}

function colorDistance(data: Uint8ClampedArray, offset: number, color: RgbColor): number {
  const dr = data[offset] - color.r
  const dg = data[offset + 1] - color.g
  const db = data[offset + 2] - color.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

function colorDistanceBetweenOffsets(
  data: Uint8ClampedArray,
  leftOffset: number,
  rightOffset: number
): number {
  const dr = data[leftOffset] - data[rightOffset]
  const dg = data[leftOffset + 1] - data[rightOffset + 1]
  const db = data[leftOffset + 2] - data[rightOffset + 2]
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

function getEightNeighborPixelIndices(pixelIndex: number, width: number, height: number) {
  const x = pixelIndex % width
  const y = Math.floor(pixelIndex / width)
  const neighbors: number[] = []

  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) {
        continue
      }

      const nextX = x + offsetX
      const nextY = y + offsetY
      if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
        continue
      }

      neighbors.push(nextY * width + nextX)
    }
  }

  return neighbors
}

function getBorderOffsets(width: number, height: number) {
  const depth = Math.max(
    1,
    Math.min(BORDER_DEPTH_MAX, Math.round(Math.min(width, height) * BORDER_DEPTH_RATIO))
  )
  const seen = new Set<number>()
  const offsets: number[] = []

  const pushIndex = (x: number, y: number) => {
    const index = y * width + x
    if (seen.has(index)) {
      return
    }
    seen.add(index)
    offsets.push(index)
  }

  for (let layer = 0; layer < depth; layer += 1) {
    const maxX = width - 1 - layer
    const maxY = height - 1 - layer

    for (let x = layer; x <= maxX; x += 1) {
      pushIndex(x, layer)
      pushIndex(x, maxY)
    }

    for (let y = layer + 1; y < maxY; y += 1) {
      pushIndex(layer, y)
      pushIndex(maxX, y)
    }
  }

  return offsets
}

function resolveBackgroundPalette(
  data: Uint8ClampedArray,
  width: number,
  height: number
): {
  palette: PaletteEntry[]
  threshold: number
  linkThreshold: number
  coverage: number
} | null {
  const borderOffsets = getBorderOffsets(width, height)
  if (borderOffsets.length === 0) {
    return null
  }

  const bins = new Map<
    string,
    {
      count: number
      sumR: number
      sumG: number
      sumB: number
    }
  >()

  for (const pixelIndex of borderOffsets) {
    const offset = pixelIndex * 4
    const alpha = data[offset + 3]
    if (alpha <= 8) {
      continue
    }

    const key = `${data[offset] >> 4}-${data[offset + 1] >> 4}-${data[offset + 2] >> 4}`
    const current = bins.get(key) ?? { count: 0, sumR: 0, sumG: 0, sumB: 0 }
    current.count += 1
    current.sumR += data[offset]
    current.sumG += data[offset + 1]
    current.sumB += data[offset + 2]
    bins.set(key, current)
  }

  const sortedBins = [...bins.values()].sort((left, right) => right.count - left.count)
  if (sortedBins.length === 0) {
    return null
  }

  const palette: PaletteEntry[] = []
  let covered = 0

  for (const entry of sortedBins) {
    const coverage = entry.count / borderOffsets.length
    if (coverage < BORDER_CLUSTER_MIN_COVERAGE && palette.length > 0) {
      continue
    }

    palette.push({
      r: Math.round(entry.sumR / entry.count),
      g: Math.round(entry.sumG / entry.count),
      b: Math.round(entry.sumB / entry.count),
      count: entry.count
    })
    covered += entry.count

    if (covered / borderOffsets.length >= 0.72 || palette.length >= 3) {
      break
    }
  }

  let deviationSum = 0
  let deviationCount = 0

  for (const pixelIndex of borderOffsets) {
    const offset = pixelIndex * 4
    const alpha = data[offset + 3]
    if (alpha <= 8) {
      continue
    }

    const minDistance = palette.reduce(
      (best, color) => Math.min(best, colorDistance(data, offset, color)),
      Number.POSITIVE_INFINITY
    )
    deviationSum += minDistance
    deviationCount += 1
  }

  const averageDeviation = deviationCount > 0 ? deviationSum / deviationCount : 24
  const threshold = clamp(averageDeviation * 1.8 + 14, 18, 76)
  const linkThreshold = clamp(threshold * 0.75, 16, 48)

  return {
    palette,
    threshold,
    linkThreshold,
    coverage: covered / borderOffsets.length
  }
}

function shouldTreatAsBackground(options: {
  data: Uint8ClampedArray
  offset: number
  palette: readonly PaletteEntry[]
  threshold: number
  linkThreshold: number
  currentOffset: number
}): boolean {
  const { data, offset, palette, threshold, linkThreshold, currentOffset } = options
  const alpha = data[offset + 3]
  if (alpha <= 8) {
    return true
  }

  const backgroundDistance = palette.reduce(
    (best, color) => Math.min(best, colorDistance(data, offset, color)),
    Number.POSITIVE_INFINITY
  )
  if (backgroundDistance <= threshold) {
    return true
  }

  const linkDistance = colorDistanceBetweenOffsets(data, offset, currentOffset)
  return backgroundDistance <= threshold * 1.85 && linkDistance <= linkThreshold
}

function buildBackgroundMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  palette: readonly PaletteEntry[],
  threshold: number,
  linkThreshold: number
) {
  const totalPixels = width * height
  const backgroundMask = new Uint8Array(totalPixels)
  const queue = new Uint32Array(totalPixels)
  let head = 0
  let tail = 0

  const borderOffsets = getBorderOffsets(width, height)
  for (const pixelIndex of borderOffsets) {
    if (backgroundMask[pixelIndex]) {
      continue
    }

    const offset = pixelIndex * 4
    if (
      !shouldTreatAsBackground({
        data,
        offset,
        palette,
        threshold,
        linkThreshold,
        currentOffset: offset
      })
    ) {
      continue
    }

    backgroundMask[pixelIndex] = 1
    queue[tail] = pixelIndex
    tail += 1
  }

  while (head < tail) {
    const pixelIndex = queue[head]
    head += 1

    const currentOffset = pixelIndex * 4

    for (const neighbor of getEightNeighborPixelIndices(pixelIndex, width, height)) {
      if (backgroundMask[neighbor]) {
        continue
      }

      const offset = neighbor * 4
      if (
        shouldTreatAsBackground({
          data,
          offset,
          palette,
          threshold,
          linkThreshold,
          currentOffset
        })
      ) {
        backgroundMask[neighbor] = 1
        queue[tail] = neighbor
        tail += 1
      }
    }
  }

  return backgroundMask
}

function hasBackgroundNeighbor(
  backgroundMask: Uint8Array,
  width: number,
  height: number,
  pixelIndex: number
) {
  return getEightNeighborPixelIndices(pixelIndex, width, height).some(
    (neighbor) => backgroundMask[neighbor]
  )
}

function applyBackgroundRemoval(options: {
  sourceData: Uint8ClampedArray
  width: number
  height: number
  palette: readonly PaletteEntry[]
  backgroundMask: Uint8Array
  threshold: number
}) {
  const { sourceData, width, height, palette, backgroundMask, threshold } = options
  const outputData = new Uint8ClampedArray(sourceData)
  let removedPixels = 0

  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
    const offset = pixelIndex * 4
    if (backgroundMask[pixelIndex]) {
      outputData[offset + 3] = 0
      removedPixels += 1
      continue
    }

    if (!hasBackgroundNeighbor(backgroundMask, width, height, pixelIndex)) {
      continue
    }

    const distance = palette.reduce(
      (best, color) => Math.min(best, colorDistance(outputData, offset, color)),
      Number.POSITIVE_INFINITY
    )

    if (distance > threshold * FEATHER_NEIGHBOR_DISTANCE) {
      continue
    }

    const softness = clamp((distance - threshold * 0.45) / Math.max(threshold * 0.9, 1), 0.18, 1)
    outputData[offset + 3] = Math.round(outputData[offset + 3] * softness)
  }

  return {
    outputData,
    removedRatio: removedPixels / Math.max(width * height, 1)
  }
}

function collectForegroundComponents(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold: number
) {
  const totalPixels = width * height
  const visited = new Uint8Array(totalPixels)
  const components: ForegroundComponent[] = []

  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
    if (visited[pixelIndex] || data[pixelIndex * 4 + 3] < alphaThreshold) {
      continue
    }

    const queue = [pixelIndex]
    visited[pixelIndex] = 1
    const pixels: number[] = []
    let sumX = 0
    let sumY = 0
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1

    while (queue.length > 0) {
      const currentIndex = queue.pop()!
      const x = currentIndex % width
      const y = Math.floor(currentIndex / width)

      pixels.push(currentIndex)
      sumX += x
      sumY += y
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)

      for (const neighbor of getEightNeighborPixelIndices(currentIndex, width, height)) {
        if (visited[neighbor] || data[neighbor * 4 + 3] < alphaThreshold) {
          continue
        }

        visited[neighbor] = 1
        queue.push(neighbor)
      }
    }

    components.push({
      pixelCount: pixels.length,
      pixels,
      minX,
      minY,
      maxX,
      maxY,
      centroidX: sumX / Math.max(pixels.length, 1),
      centroidY: sumY / Math.max(pixels.length, 1)
    })
  }

  return components
}

function rectsIntersect(
  left: { minX: number; minY: number; maxX: number; maxY: number },
  right: { minX: number; minY: number; maxX: number; maxY: number }
) {
  return (
    left.minX <= right.maxX &&
    left.maxX >= right.minX &&
    left.minY <= right.maxY &&
    left.maxY >= right.minY
  )
}

export function filterToPrimaryForegroundComponents(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = FOREGROUND_ALPHA_THRESHOLD
): PrimaryForegroundSelectionResult {
  const components = collectForegroundComponents(data, width, height, alphaThreshold)
  if (components.length <= 1) {
    return {
      data: new Uint8ClampedArray(data),
      totalComponentCount: components.length,
      keptComponentCount: components.length,
      removedComponentCount: 0,
      keptForegroundRatio: components.length === 0 ? 0 : 1
    }
  }

  const centerX = (width - 1) / 2
  const centerY = (height - 1) / 2
  const maxCenterDistance = Math.max(
    Math.hypot(Math.max(centerX, width - 1 - centerX), Math.max(centerY, height - 1 - centerY)),
    1
  )
  const totalForegroundPixels = components.reduce(
    (total, component) => total + component.pixelCount,
    0
  )

  const dominantComponent =
    components.reduce<ForegroundComponent | null>((bestComponent, component) => {
      const centerDistance = Math.hypot(
        component.centroidX - centerX,
        component.centroidY - centerY
      )
      const centerScore = 1 - Math.min(centerDistance / maxCenterDistance, 1)
      const score = component.pixelCount * (0.72 + centerScore * 0.28)
      if (!bestComponent) {
        return component
      }

      const bestCenterDistance = Math.hypot(
        bestComponent.centroidX - centerX,
        bestComponent.centroidY - centerY
      )
      const bestCenterScore = 1 - Math.min(bestCenterDistance / maxCenterDistance, 1)
      const bestScore = bestComponent.pixelCount * (0.72 + bestCenterScore * 0.28)
      return score > bestScore ? component : bestComponent
    }, null) ?? components[0]

  const dominantBounds = {
    minX: dominantComponent.minX,
    minY: dominantComponent.minY,
    maxX: dominantComponent.maxX,
    maxY: dominantComponent.maxY
  }
  const expandedDominantBounds = {
    minX: Math.max(0, dominantBounds.minX - Math.round(width * 0.16)),
    minY: Math.max(0, dominantBounds.minY - Math.round(height * 0.16)),
    maxX: Math.min(width - 1, dominantBounds.maxX + Math.round(width * 0.16)),
    maxY: Math.min(height - 1, dominantBounds.maxY + Math.round(height * 0.16))
  }
  const dominantPixelCount = Math.max(dominantComponent.pixelCount, 1)
  const minimumComponentArea = Math.max(
    18,
    Math.round(totalForegroundPixels * PRIMARY_FOREGROUND_MIN_AREA_RATIO)
  )

  const componentScores = components.map((component) => {
    const centerDistance = Math.hypot(component.centroidX - centerX, component.centroidY - centerY)
    const dominantDistance = Math.hypot(
      component.centroidX - dominantComponent.centroidX,
      component.centroidY - dominantComponent.centroidY
    )
    const centerScore = 1 - Math.min(centerDistance / maxCenterDistance, 1)
    const dominantScore = 1 - Math.min(dominantDistance / maxCenterDistance, 1)
    const areaRatio = component.pixelCount / dominantPixelCount
    const overlapsDominant = rectsIntersect(
      {
        minX: component.minX,
        minY: component.minY,
        maxX: component.maxX,
        maxY: component.maxY
      },
      expandedDominantBounds
    )
    const score = areaRatio * 0.5 + centerScore * 0.32 + dominantScore * 0.18

    return {
      component,
      score,
      areaRatio,
      centerScore,
      overlapsDominant
    }
  })

  const keptComponents = new Set<ForegroundComponent>([dominantComponent])

  componentScores.forEach(({ component, score, areaRatio, centerScore, overlapsDominant }) => {
    if (component === dominantComponent || component.pixelCount < minimumComponentArea) {
      return
    }

    if (
      score >= PRIMARY_FOREGROUND_KEEP_SCORE ||
      (overlapsDominant && areaRatio >= PRIMARY_FOREGROUND_DOMINANT_LINK_RATIO) ||
      (centerScore >= 0.6 && areaRatio >= 0.12)
    ) {
      keptComponents.add(component)
    }
  })

  if (keptComponents.size === 1) {
    const fallbackComponent = componentScores
      .filter(({ component }) => component !== dominantComponent)
      .sort((left, right) => right.score - left.score)
      .find(
        ({ component, score, overlapsDominant }) =>
          component.pixelCount >= Math.max(12, Math.round(totalForegroundPixels * 0.008)) &&
          (score >= PRIMARY_FOREGROUND_FALLBACK_SCORE || overlapsDominant)
      )

    if (fallbackComponent) {
      keptComponents.add(fallbackComponent.component)
    }
  }

  const nextData = new Uint8ClampedArray(data)
  let keptPixels = 0

  components.forEach((component) => {
    if (keptComponents.has(component)) {
      keptPixels += component.pixelCount
      return
    }

    component.pixels.forEach((pixelIndex) => {
      nextData[pixelIndex * 4 + 3] = 0
    })
  })

  return {
    data: nextData,
    totalComponentCount: components.length,
    keptComponentCount: keptComponents.size,
    removedComponentCount: components.length - keptComponents.size,
    keptForegroundRatio: keptPixels / Math.max(totalForegroundPixels, 1)
  }
}

function resolveForegroundBounds(data: Uint8ClampedArray, width: number, height: number) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      if (data[offset + 3] < FOREGROUND_ALPHA_THRESHOLD) {
        continue
      }

      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (maxX < minX || maxY < minY) {
    return null
  }

  return {
    minX,
    minY,
    maxX,
    maxY
  }
}

function buildTrimmedCanvas(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  fallbackFullRegion = false
) {
  const bounds =
    resolveForegroundBounds(imageData, width, height) ??
    (fallbackFullRegion
      ? {
          minX: 0,
          minY: 0,
          maxX: width - 1,
          maxY: height - 1
        }
      : null)

  if (!bounds) {
    return null
  }

  const left = clamp(bounds.minX - TRIM_PADDING, 0, width - 1)
  const top = clamp(bounds.minY - TRIM_PADDING, 0, height - 1)
  const right = clamp(bounds.maxX + TRIM_PADDING, left, width - 1)
  const bottom = clamp(bounds.maxY + TRIM_PADDING, top, height - 1)
  const trimmedWidth = right - left + 1
  const trimmedHeight = bottom - top + 1

  const output = createCanvas(trimmedWidth, trimmedHeight)
  const context = output.getContext('2d')
  if (!context) {
    throw new Error('Failed to create extraction canvas context.')
  }

  const nextImageData = context.createImageData(trimmedWidth, trimmedHeight)
  for (let y = 0; y < trimmedHeight; y += 1) {
    for (let x = 0; x < trimmedWidth; x += 1) {
      const sourceOffset = ((top + y) * width + (left + x)) * 4
      const targetOffset = (y * trimmedWidth + x) * 4
      nextImageData.data[targetOffset] = imageData[sourceOffset]
      nextImageData.data[targetOffset + 1] = imageData[sourceOffset + 1]
      nextImageData.data[targetOffset + 2] = imageData[sourceOffset + 2]
      nextImageData.data[targetOffset + 3] = imageData[sourceOffset + 3]
    }
  }

  context.putImageData(nextImageData, 0, 0)
  return output
}

export async function extractImageRegionLocally({
  item,
  region,
  loadImage = loadImageFromSrc,
  loadedImage
}: ExtractImageLocallyOptions): Promise<LocalExtractedRegion | null> {
  if (!item.src) {
    return null
  }

  const sourceImage = loadedImage ?? (await loadImage(item.src))
  const safeRegion = clampRegion(region, sourceImage.width, sourceImage.height)
  const workCanvas = createCanvas(safeRegion.width, safeRegion.height)
  const workContext = workCanvas.getContext('2d', { willReadFrequently: true })
  if (!workContext) {
    throw new Error('Failed to create extraction work context.')
  }

  workContext.drawImage(
    sourceImage.img,
    safeRegion.x,
    safeRegion.y,
    safeRegion.width,
    safeRegion.height,
    0,
    0,
    workCanvas.width,
    workCanvas.height
  )

  const originalImageData = workContext.getImageData(0, 0, workCanvas.width, workCanvas.height)
  const backgroundPalette = resolveBackgroundPalette(
    originalImageData.data,
    workCanvas.width,
    workCanvas.height
  )

  let outputData: Uint8ClampedArray<ArrayBufferLike> = new Uint8ClampedArray(originalImageData.data)
  let backgroundRemoved = false
  let confidence = 0

  if (backgroundPalette) {
    const backgroundMask = buildBackgroundMask(
      originalImageData.data,
      workCanvas.width,
      workCanvas.height,
      backgroundPalette.palette,
      backgroundPalette.threshold,
      backgroundPalette.linkThreshold
    )
    const removalResult = applyBackgroundRemoval({
      sourceData: originalImageData.data,
      width: workCanvas.width,
      height: workCanvas.height,
      palette: backgroundPalette.palette,
      backgroundMask,
      threshold: backgroundPalette.threshold
    })

    if (
      removalResult.removedRatio >= BACKGROUND_REMOVAL_MIN_RATIO &&
      removalResult.removedRatio <= BACKGROUND_REMOVAL_MAX_RATIO
    ) {
      outputData = removalResult.outputData
      backgroundRemoved = true
      confidence = clamp(
        backgroundPalette.coverage * 0.55 +
          (1 - Math.abs(removalResult.removedRatio - 0.34)) * 0.45,
        0.18,
        0.96
      )
    }
  }

  const primaryForegroundSelection = filterToPrimaryForegroundComponents(
    outputData,
    workCanvas.width,
    workCanvas.height
  )
  if (primaryForegroundSelection.removedComponentCount > 0) {
    outputData = primaryForegroundSelection.data
    confidence = clamp(
      Math.max(confidence, 0.22) +
        Math.min(primaryForegroundSelection.removedComponentCount * 0.035, 0.14),
      0.18,
      0.98
    )
  }

  const outputCanvas = buildTrimmedCanvas(outputData, workCanvas.width, workCanvas.height, true)
  if (!outputCanvas) {
    return null
  }

  const blob = await canvasToBlob(outputCanvas)

  return {
    blob,
    sizeBytes: blob.size,
    sourceWidth: outputCanvas.width,
    sourceHeight: outputCanvas.height,
    backgroundRemoved,
    confidence
  }
}
