import type { DesignInspectionItemSummary } from '@shared/designInspection'
import {
  ALIGNMENT_TOLERANCE_PX,
  HEIGHT_TOLERANCE_PX,
  SPACING_TOLERANCE_PX,
  WIDTH_TOLERANCE_PX,
  getWidthNormalizableItems,
  median,
  roundMetric
} from './designInspectionStructureCore'
import type {
  ThreeColumnMatrixGraphTrackKind,
  ThreeColumnMultiRowMatrixCandidate,
  ThreeColumnMultiRowMatrixGraphCandidate,
  WidthNormalizableItemSummary
} from './designInspectionStructureTypes'

export function getThreeColumnMatrixGraphTrackValue(
  item: WidthNormalizableItemSummary,
  kind: ThreeColumnMatrixGraphTrackKind
): number {
  if (kind === 'left') return roundMetric(item.bounds.x)
  if (kind === 'center') return roundMetric(item.bounds.x + item.bounds.width / 2)
  return roundMetric(item.bounds.x + item.bounds.width)
}

export function formatThreeColumnMatrixGraphTrackKind(
  kind: ThreeColumnMatrixGraphTrackKind
): string {
  if (kind === 'left') return 'left track'
  if (kind === 'center') return 'centerline'
  return 'right track'
}

export function resolveVerticalStackCandidate(
  items: DesignInspectionItemSummary[]
): DesignInspectionItemSummary[] | null {
  if (items.length < 2) return null

  const sorted = [...items].sort((left, right) => left.bounds.y - right.bounds.y)
  const overlapRatios: number[] = []

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index]
    const next = sorted[index + 1]
    const overlapWidth =
      Math.min(current.bounds.x + current.bounds.width, next.bounds.x + next.bounds.width) -
      Math.max(current.bounds.x, next.bounds.x)
    const minWidth = Math.min(current.bounds.width, next.bounds.width)
    overlapRatios.push(minWidth > 0 ? Math.max(0, overlapWidth) / minWidth : 0)
  }

  const averageOverlap =
    overlapRatios.reduce((total, ratio) => total + ratio, 0) / Math.max(1, overlapRatios.length)

  return averageOverlap >= 0.25 ? sorted : null
}

export function resolveHorizontalRowCandidate(
  items: DesignInspectionItemSummary[]
): DesignInspectionItemSummary[] | null {
  if (items.length < 2) return null

  const sorted = [...items].sort((left, right) => left.bounds.x - right.bounds.x)
  const overlapRatios: number[] = []

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index]
    const next = sorted[index + 1]
    const overlapHeight =
      Math.min(current.bounds.y + current.bounds.height, next.bounds.y + next.bounds.height) -
      Math.max(current.bounds.y, next.bounds.y)
    const minHeight = Math.min(current.bounds.height, next.bounds.height)
    overlapRatios.push(minHeight > 0 ? Math.max(0, overlapHeight) / minHeight : 0)
  }

  const averageOverlap =
    overlapRatios.reduce((total, ratio) => total + ratio, 0) / Math.max(1, overlapRatios.length)

  return averageOverlap >= 0.25 ? sorted : null
}

export function resolveGridCandidate(
  items: DesignInspectionItemSummary[]
): DesignInspectionItemSummary[] | null {
  if (items.length !== 4) return null

  const sortedByY = [...items].sort((left, right) => {
    if (left.bounds.y !== right.bounds.y) return left.bounds.y - right.bounds.y
    return left.bounds.x - right.bounds.x
  })
  const topRow = sortedByY.slice(0, 2).sort((left, right) => left.bounds.x - right.bounds.x)
  const bottomRow = sortedByY.slice(2, 4).sort((left, right) => left.bounds.x - right.bounds.x)

  if (
    Math.abs(topRow[0].bounds.y - topRow[1].bounds.y) > ALIGNMENT_TOLERANCE_PX ||
    Math.abs(bottomRow[0].bounds.y - bottomRow[1].bounds.y) > ALIGNMENT_TOLERANCE_PX
  ) {
    return null
  }

  const columnGap = topRow[1].bounds.x - topRow[0].bounds.x
  const sameColumnTolerance = ALIGNMENT_TOLERANCE_PX
  const minRowGap = SPACING_TOLERANCE_PX

  if (columnGap <= minRowGap) return null

  if (
    Math.abs(topRow[0].bounds.x - bottomRow[0].bounds.x) > sameColumnTolerance ||
    Math.abs(topRow[1].bounds.x - bottomRow[1].bounds.x) > sameColumnTolerance
  ) {
    return null
  }

  return [topRow[0], topRow[1], bottomRow[0], bottomRow[1]]
}

export function resolveTwoByThreeGridCandidate(
  items: DesignInspectionItemSummary[]
): [WidthNormalizableItemSummary[], WidthNormalizableItemSummary[]] | null {
  const gridItems = getWidthNormalizableItems(items)
  if (gridItems.length !== 6 || gridItems.length !== items.length) return null

  const sortedByY = [...gridItems].sort((left, right) => {
    if (left.bounds.y !== right.bounds.y) return left.bounds.y - right.bounds.y
    return left.bounds.x - right.bounds.x
  })
  const topRow = sortedByY.slice(0, 3).sort((left, right) => left.bounds.x - right.bounds.x)
  const bottomRow = sortedByY.slice(3, 6).sort((left, right) => left.bounds.x - right.bounds.x)

  const topRowTopSpread = topRow[2].bounds.y - topRow[0].bounds.y
  const bottomRowTopSpread = bottomRow[2].bounds.y - bottomRow[0].bounds.y

  if (topRowTopSpread > ALIGNMENT_TOLERANCE_PX || bottomRowTopSpread > ALIGNMENT_TOLERANCE_PX) {
    return null
  }

  const topColumnGaps = topRow.slice(1).map((item, index) => item.bounds.x - topRow[index].bounds.x)
  const bottomColumnGaps = bottomRow
    .slice(1)
    .map((item, index) => item.bounds.x - bottomRow[index].bounds.x)

  if ([...topColumnGaps, ...bottomColumnGaps].some((gap) => gap <= SPACING_TOLERANCE_PX)) {
    return null
  }

  for (let index = 0; index < 3; index += 1) {
    if (Math.abs(topRow[index].bounds.x - bottomRow[index].bounds.x) > ALIGNMENT_TOLERANCE_PX) {
      return null
    }
  }

  return [topRow, bottomRow]
}

export function resolveThreeColumnMultiRowMatrixCandidate(
  items: DesignInspectionItemSummary[]
): ThreeColumnMultiRowMatrixCandidate | null {
  const matrixItems = getWidthNormalizableItems(items)
  if (
    matrixItems.length < 9 ||
    matrixItems.length % 3 !== 0 ||
    matrixItems.length !== items.length
  ) {
    return null
  }

  const sortedByY = [...matrixItems].sort((left, right) => {
    if (left.bounds.y !== right.bounds.y) return left.bounds.y - right.bounds.y
    return left.bounds.x - right.bounds.x
  })
  const rowCount = sortedByY.length / 3
  const rows: WidthNormalizableItemSummary[][] = []

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = sortedByY.slice(rowIndex * 3, rowIndex * 3 + 3).sort((left, right) => {
      if (left.bounds.x !== right.bounds.x) return left.bounds.x - right.bounds.x
      return left.bounds.y - right.bounds.y
    })

    if (row.length !== 3) return null

    const rowTopSpread = row[2].bounds.y - row[0].bounds.y
    if (rowTopSpread > ALIGNMENT_TOLERANCE_PX) return null

    const rowGaps = row
      .slice(1)
      .map((item, index) =>
        roundMetric(item.bounds.x - (row[index].bounds.x + row[index].bounds.width))
      )
    if (rowGaps.some((gap) => gap <= SPACING_TOLERANCE_PX)) return null

    rows.push(row)
  }

  const widthSpread =
    Math.max(...matrixItems.map((item) => item.bounds.width)) -
    Math.min(...matrixItems.map((item) => item.bounds.width))
  const heightSpread =
    Math.max(...matrixItems.map((item) => item.bounds.height)) -
    Math.min(...matrixItems.map((item) => item.bounds.height))

  if (widthSpread > WIDTH_TOLERANCE_PX || heightSpread > HEIGHT_TOLERANCE_PX) return null

  const columns = [0, 1, 2].map((columnIndex) => rows.map((row) => row[columnIndex]))
  const hasStableTracks = columns.every((column) => {
    const targetCenterX = roundMetric(
      median(column.map((item) => item.bounds.x + item.bounds.width / 2))
    )
    const alignedCount = column.filter((item) => {
      const currentCenterX = roundMetric(item.bounds.x + item.bounds.width / 2)
      return Math.abs(currentCenterX - targetCenterX) <= ALIGNMENT_TOLERANCE_PX
    }).length

    return alignedCount >= 2
  })

  if (!hasStableTracks) return null

  return {
    rows,
    columns
  }
}

export function resolveThreeColumnMultiRowMatrixGraphCandidate(
  items: DesignInspectionItemSummary[]
): ThreeColumnMultiRowMatrixGraphCandidate | null {
  const matrixItems = getWidthNormalizableItems(items)
  if (
    matrixItems.length < 9 ||
    matrixItems.length % 3 !== 0 ||
    matrixItems.length !== items.length
  ) {
    return null
  }

  const sortedByY = [...matrixItems].sort((left, right) => {
    if (left.bounds.y !== right.bounds.y) return left.bounds.y - right.bounds.y
    return left.bounds.x - right.bounds.x
  })
  const rowCount = sortedByY.length / 3
  const rows: WidthNormalizableItemSummary[][] = []

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = sortedByY.slice(rowIndex * 3, rowIndex * 3 + 3).sort((left, right) => {
      if (left.bounds.x !== right.bounds.x) return left.bounds.x - right.bounds.x
      return left.bounds.y - right.bounds.y
    })

    if (row.length !== 3) return null

    const rowTopSpread = row[2].bounds.y - row[0].bounds.y
    if (rowTopSpread > ALIGNMENT_TOLERANCE_PX) return null

    const rowGaps = row
      .slice(1)
      .map((item, index) =>
        roundMetric(item.bounds.x - (row[index].bounds.x + row[index].bounds.width))
      )
    if (rowGaps.some((gap) => gap <= SPACING_TOLERANCE_PX)) return null

    rows.push(row)
  }

  const widthSpread =
    Math.max(...matrixItems.map((item) => item.bounds.width)) -
    Math.min(...matrixItems.map((item) => item.bounds.width))
  const heightSpread =
    Math.max(...matrixItems.map((item) => item.bounds.height)) -
    Math.min(...matrixItems.map((item) => item.bounds.height))

  if (widthSpread <= WIDTH_TOLERANCE_PX || heightSpread > HEIGHT_TOLERANCE_PX) return null

  const columns = [0, 1, 2].map((columnIndex) => rows.map((row) => row[columnIndex]))
  const hasStableLeftTrack = columns.some((column) => {
    const targetX = roundMetric(median(column.map((item) => item.bounds.x)))
    const alignedCount = column.filter(
      (item) => Math.abs(item.bounds.x - targetX) <= ALIGNMENT_TOLERANCE_PX
    ).length

    return alignedCount >= 2
  })

  if (!hasStableLeftTrack) return null

  return {
    rows,
    columns
  }
}
