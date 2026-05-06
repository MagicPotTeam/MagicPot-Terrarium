export type SelectionActionStackPlacement = 'auto' | 'above' | 'below'

export function getSelectionActionStackPosition(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  viewport: { width: number; height: number },
  margin = 16,
  estimatedToolbarHeight = 44,
  preferredPlacement: SelectionActionStackPlacement = 'auto'
) {
  const left = Math.min(Math.max((bounds.minX + bounds.maxX) / 2, margin), viewport.width - margin)
  const gap = 12
  const spaceAbove = bounds.minY - margin
  const spaceBelow = viewport.height - margin - bounds.maxY
  const canPlaceAbove = spaceAbove >= estimatedToolbarHeight + gap || spaceAbove > 0
  const canPlaceBelow = spaceBelow >= estimatedToolbarHeight + gap || spaceBelow > 0

  const placeAbove =
    preferredPlacement === 'below'
      ? !canPlaceBelow && canPlaceAbove
      : preferredPlacement === 'above'
        ? canPlaceAbove || !canPlaceBelow
        : spaceAbove >= estimatedToolbarHeight + gap || (spaceAbove > 0 && spaceAbove >= spaceBelow)

  const top = placeAbove
    ? Math.max(bounds.minY - gap - estimatedToolbarHeight, margin)
    : Math.min(bounds.maxY + gap, viewport.height - margin - estimatedToolbarHeight)

  return { left, top }
}

type SelectionActionToolbarRect = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type ResolveSelectionActionToolbarPositionOptions = {
  margin?: number
  gap?: number
  preferredPlacement?: SelectionActionStackPlacement
  toolbarWidth?: number
  toolbarHeight?: number
  avoidRects?: SelectionActionToolbarRect[]
  collisionPadding?: number
  lockHorizontalAnchor?: boolean
}

function clampSelectionToolbarCenter(value: number, min: number, max: number): number {
  if (min > max) {
    return (min + max) / 2
  }

  return Math.min(Math.max(value, min), max)
}

function buildSelectionToolbarRect(
  left: number,
  top: number,
  width: number,
  height: number
): SelectionActionToolbarRect {
  const halfWidth = width / 2

  return {
    minX: left - halfWidth,
    minY: top,
    maxX: left + halfWidth,
    maxY: top + height
  }
}

function getSelectionToolbarOverlapArea(
  candidateRect: SelectionActionToolbarRect,
  avoidRect: SelectionActionToolbarRect,
  padding: number
): number {
  const overlapWidth =
    Math.min(candidateRect.maxX, avoidRect.maxX + padding) -
    Math.max(candidateRect.minX, avoidRect.minX - padding)
  const overlapHeight =
    Math.min(candidateRect.maxY, avoidRect.maxY + padding) -
    Math.max(candidateRect.minY, avoidRect.minY - padding)

  if (overlapWidth <= 0 || overlapHeight <= 0) {
    return 0
  }

  return overlapWidth * overlapHeight
}

function buildSelectionToolbarHorizontalCandidates(
  preferredLeft: number,
  minCenter: number,
  maxCenter: number,
  step: number
): number[] {
  const clampedPreferred = clampSelectionToolbarCenter(preferredLeft, minCenter, maxCenter)
  const candidates: number[] = [clampedPreferred]
  const maxOffsetSteps = Math.max(
    1,
    Math.ceil(Math.max(clampedPreferred - minCenter, maxCenter - clampedPreferred) / step)
  )

  for (let offsetStep = 1; offsetStep <= maxOffsetSteps; offsetStep += 1) {
    const offset = offsetStep * step
    const rightCandidate = clampSelectionToolbarCenter(
      clampedPreferred + offset,
      minCenter,
      maxCenter
    )
    const leftCandidate = clampSelectionToolbarCenter(
      clampedPreferred - offset,
      minCenter,
      maxCenter
    )

    if (!candidates.includes(rightCandidate)) {
      candidates.push(rightCandidate)
    }
    if (!candidates.includes(leftCandidate)) {
      candidates.push(leftCandidate)
    }
  }

  return candidates
}

export function resolveSelectionActionToolbarPosition(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  viewport: { width: number; height: number },
  options: ResolveSelectionActionToolbarPositionOptions = {}
) {
  const margin = options.margin ?? 16
  const gap = options.gap ?? 12
  const toolbarWidth = Math.max(1, options.toolbarWidth ?? 320)
  const toolbarHeight = Math.max(1, options.toolbarHeight ?? 44)
  const preferredPlacement = options.preferredPlacement ?? 'auto'
  const collisionPadding = Math.max(0, options.collisionPadding ?? 8)
  const avoidRects = options.avoidRects ?? []
  const lockHorizontalAnchor = options.lockHorizontalAnchor ?? false

  const primaryPosition = getSelectionActionStackPosition(
    bounds,
    viewport,
    margin,
    toolbarHeight,
    preferredPlacement
  )
  const primaryPlacement: SelectionActionStackPlacement =
    primaryPosition.top < bounds.minY ? 'above' : 'below'
  const secondaryPlacement: SelectionActionStackPlacement =
    primaryPlacement === 'above' ? 'below' : 'above'
  const secondaryPosition = getSelectionActionStackPosition(
    bounds,
    viewport,
    margin,
    toolbarHeight,
    secondaryPlacement
  )

  const minCenter = margin + toolbarWidth / 2
  const maxCenter = viewport.width - margin - toolbarWidth / 2
  const horizontalStep = Math.max(24, Math.round(toolbarWidth / 5))
  const preferredLeft = (bounds.minX + bounds.maxX) / 2
  const horizontalCandidates = lockHorizontalAnchor
    ? [clampSelectionToolbarCenter(preferredLeft, minCenter, maxCenter)]
    : buildSelectionToolbarHorizontalCandidates(preferredLeft, minCenter, maxCenter, horizontalStep)
  const verticalCandidates = [primaryPosition.top]

  if (secondaryPosition.top !== primaryPosition.top) {
    verticalCandidates.push(secondaryPosition.top)
  }

  let bestPosition = {
    left: clampSelectionToolbarCenter(primaryPosition.left, minCenter, maxCenter),
    top: primaryPosition.top
  }
  let bestScore = Number.POSITIVE_INFINITY

  for (const top of verticalCandidates) {
    for (const left of horizontalCandidates) {
      const candidateRect = buildSelectionToolbarRect(left, top, toolbarWidth, toolbarHeight)
      const overlapScore = avoidRects.reduce(
        (total, rect) =>
          total + getSelectionToolbarOverlapArea(candidateRect, rect, collisionPadding),
        0
      )

      if (overlapScore === 0) {
        return { left, top }
      }

      const preferredDistance =
        Math.abs(left - preferredLeft) + Math.abs(top - primaryPosition.top) * 4
      const candidateScore = overlapScore * 1000 + preferredDistance

      if (candidateScore < bestScore) {
        bestScore = candidateScore
        bestPosition = { left, top }
      }
    }
  }

  return bestPosition
}
