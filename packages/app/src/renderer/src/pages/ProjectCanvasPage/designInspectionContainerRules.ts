import type { DesignInspectionItemSummary } from '@shared/designInspection'
import {
  ALIGNMENT_TOLERANCE_PX,
  SPACING_TOLERANCE_PX,
  median,
  roundMetric
} from './designInspectionStructureCore'
import {
  resolveStructuredContainerTextRoles,
  resolveTrailingSingleColumnStack
} from './designInspectionContainerTextRoles'
import type {
  ContainerBadgeStackFooterActionSpacingPair,
  ContainerBadgeStackSpacingPair,
  ContainerBodyInsetPair,
  ContainerBodyMetaFooterActionValueColumnPair,
  ContainerBodyMetaValueColumnPair,
  ContainerChipGroupFooterActionRowSpacingPair,
  ContainerChipGroupRowSpacingPair,
  ContainerFooterInsetPair,
  ContainerFooterRowSpacingPair,
  ContainerHeaderMetaInsetPair,
  ContainerMetaBlockValueColumnPair,
  ContainerTailBadgeStackSpacingPair,
  ContainerTitleInsetPair,
  ContainerTrailingBadgeStackSpacingPair,
  InspectableRectangularAnnotationSummary,
  RectangularCornerShape,
  StructuredContainerTextRoles,
  TitleTextItemSummary,
  WidthNormalizableItemSummary
} from './designInspectionStructureTypes'

export function resolveContainerTitleInsetPairs(
  items: DesignInspectionItemSummary[]
): ContainerTitleInsetPair[] {
  return resolveStructuredContainerTextRoles(items).map((role) => ({
    container: role.container,
    title: role.title,
    leftInset: roundMetric(role.title.bounds.x - role.container.bounds.x),
    rightInset: roundMetric(
      role.container.bounds.x +
        role.container.bounds.width -
        (role.title.bounds.x + role.title.bounds.width)
    ),
    topInset: roundMetric(role.title.bounds.y - role.container.bounds.y),
    centerOffset: roundMetric(
      role.title.bounds.x +
        role.title.bounds.width / 2 -
        (role.container.bounds.x + role.container.bounds.width / 2)
    )
  }))
}

export function resolveContainerHeaderMetaInsetPairs(
  items: DesignInspectionItemSummary[]
): ContainerHeaderMetaInsetPair[] {
  return resolveStructuredContainerTextRoles(items)
    .filter((role): role is StructuredContainerTextRoles & { headerMeta: TitleTextItemSummary } =>
      Boolean(role.headerMeta)
    )
    .map((role) => ({
      container: role.container,
      meta: role.headerMeta,
      rightInset: roundMetric(
        role.container.bounds.x +
          role.container.bounds.width -
          (role.headerMeta.bounds.x + role.headerMeta.bounds.width)
      )
    }))
}

export function resolveContainerMetaBlockValueColumnPairs(
  items: DesignInspectionItemSummary[]
): ContainerMetaBlockValueColumnPair[] {
  const rolesWithMetaBlocks = resolveStructuredContainerTextRoles(items).flatMap((role) => {
    const nonHeaderRows = role.rows.slice(1)
    if (nonHeaderRows.length < 2) return []

    const lastRow = nonHeaderRows[nonHeaderRows.length - 1]
    const candidateRows = lastRow?.length === 1 ? nonHeaderRows.slice(0, -1) : nonHeaderRows
    if (candidateRows.length < 2 || !candidateRows.every((row) => row.length === 2)) return []

    const labelItems = candidateRows.map((row) => row[0])
    const valueItems = candidateRows.map((row) => row[row.length - 1])
    const columnGaps = candidateRows.map(([labelItem, valueItem]) =>
      roundMetric(valueItem.bounds.x - (labelItem.bounds.x + labelItem.bounds.width))
    )
    if (columnGaps.some((gap) => gap <= SPACING_TOLERANCE_PX)) return []

    const labelLeftInsets = labelItems.map((item) =>
      roundMetric(item.bounds.x - role.container.bounds.x)
    )
    const valueRightInsets = valueItems.map((item) =>
      roundMetric(
        role.container.bounds.x + role.container.bounds.width - (item.bounds.x + item.bounds.width)
      )
    )
    const labelLeftInsetSpread = Math.max(...labelLeftInsets) - Math.min(...labelLeftInsets)
    const valueRightInsetSpread = Math.max(...valueRightInsets) - Math.min(...valueRightInsets)

    if (
      labelLeftInsetSpread > SPACING_TOLERANCE_PX ||
      valueRightInsetSpread > SPACING_TOLERANCE_PX
    ) {
      return []
    }

    return [
      {
        container: role.container,
        valueItems,
        rightInset: roundMetric(median(valueRightInsets)),
        rowCount: candidateRows.length
      }
    ]
  })

  if (rolesWithMetaBlocks.length < 3) return []

  const metaRowCountEntries = [...rolesWithMetaBlocks].reduce((counts, pair, index) => {
    const key = pair.rowCount
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      return counts
    }
    counts.set(key, {
      count: 1,
      firstIndex: index
    })
    return counts
  }, new Map<number, { count: number; firstIndex: number }>())
  const dominantMetaRowCount =
    [...metaRowCountEntries.entries()].sort((left, right) => {
      const [, leftMeta] = left
      const [, rightMeta] = right
      if (rightMeta.count !== leftMeta.count) {
        return rightMeta.count - leftMeta.count
      }
      return leftMeta.firstIndex - rightMeta.firstIndex
    })[0]?.[0] ?? null

  if (typeof dominantMetaRowCount !== 'number') return []

  const comparableMetaBlocks = rolesWithMetaBlocks.filter(
    (pair) => pair.rowCount === dominantMetaRowCount
  )

  if (comparableMetaBlocks.length < 3) return []

  return comparableMetaBlocks
}

export function resolveContainerBodyMetaValueColumnPairs(
  items: DesignInspectionItemSummary[]
): ContainerBodyMetaValueColumnPair[] {
  const rolesWithBodyMetaBlocks = resolveStructuredContainerTextRoles(items).flatMap((role) => {
    if (role.rows.length < 4) return []

    const bodyRow = role.rows[1]
    const trailingRows = role.rows.slice(2)
    const lastTrailingRow = trailingRows[trailingRows.length - 1]

    if (
      !bodyRow ||
      bodyRow.length !== 1 ||
      trailingRows.length < 2 ||
      lastTrailingRow?.length !== 1
    ) {
      return []
    }

    const candidateRows = trailingRows.slice(0, -1)
    if (candidateRows.length < 1 || !candidateRows.every((row) => row.length === 2)) return []

    const labelItems = candidateRows.map((row) => row[0])
    const valueItems = candidateRows.map((row) => row[row.length - 1])
    const columnGaps = candidateRows.map(([labelItem, valueItem]) =>
      roundMetric(valueItem.bounds.x - (labelItem.bounds.x + labelItem.bounds.width))
    )
    if (columnGaps.some((gap) => gap <= SPACING_TOLERANCE_PX)) return []

    const labelLeftInsets = labelItems.map((item) =>
      roundMetric(item.bounds.x - role.container.bounds.x)
    )
    const valueRightInsets = valueItems.map((item) =>
      roundMetric(
        role.container.bounds.x + role.container.bounds.width - (item.bounds.x + item.bounds.width)
      )
    )
    const labelLeftInsetSpread = Math.max(...labelLeftInsets) - Math.min(...labelLeftInsets)
    const valueRightInsetSpread = Math.max(...valueRightInsets) - Math.min(...valueRightInsets)

    if (
      labelLeftInsetSpread > SPACING_TOLERANCE_PX ||
      valueRightInsetSpread > SPACING_TOLERANCE_PX
    ) {
      return []
    }

    return [
      {
        container: role.container,
        valueItems,
        rightInset: roundMetric(median(valueRightInsets)),
        rowCount: candidateRows.length
      }
    ]
  })

  if (rolesWithBodyMetaBlocks.length < 3) return []

  const metaRowCountEntries = [...rolesWithBodyMetaBlocks].reduce((counts, pair, index) => {
    const key = pair.rowCount
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      return counts
    }
    counts.set(key, {
      count: 1,
      firstIndex: index
    })
    return counts
  }, new Map<number, { count: number; firstIndex: number }>())
  const dominantMetaRowCount =
    [...metaRowCountEntries.entries()].sort((left, right) => {
      const [, leftMeta] = left
      const [, rightMeta] = right
      if (rightMeta.count !== leftMeta.count) {
        return rightMeta.count - leftMeta.count
      }
      return leftMeta.firstIndex - rightMeta.firstIndex
    })[0]?.[0] ?? null

  if (typeof dominantMetaRowCount !== 'number') return []

  const comparableBodyMetaBlocks = rolesWithBodyMetaBlocks.filter(
    (pair) => pair.rowCount === dominantMetaRowCount
  )

  if (comparableBodyMetaBlocks.length < 3) return []

  return comparableBodyMetaBlocks
}

export function resolveContainerBodyMetaFooterActionValueColumnPairs(
  items: DesignInspectionItemSummary[]
): ContainerBodyMetaFooterActionValueColumnPair[] {
  const rolesWithBodyMetaFooterActions = resolveStructuredContainerTextRoles(items).flatMap(
    (role) => {
      if (role.rows.length < 4) return []

      const bodyRow = role.rows[1]
      const trailingRows = role.rows.slice(2)
      const footerActionRow = trailingRows[trailingRows.length - 1]

      if (
        !bodyRow ||
        bodyRow.length !== 1 ||
        trailingRows.length < 2 ||
        !footerActionRow ||
        footerActionRow.length < 2
      ) {
        return []
      }

      const candidateRows = trailingRows.slice(0, -1)
      if (candidateRows.length < 1 || !candidateRows.every((row) => row.length === 2)) return []

      const labelItems = candidateRows.map((row) => row[0])
      const valueItems = candidateRows.map((row) => row[row.length - 1])
      const columnGaps = candidateRows.map(([labelItem, valueItem]) =>
        roundMetric(valueItem.bounds.x - (labelItem.bounds.x + labelItem.bounds.width))
      )
      if (columnGaps.some((gap) => gap <= SPACING_TOLERANCE_PX)) return []

      const labelLeftInsets = labelItems.map((item) =>
        roundMetric(item.bounds.x - role.container.bounds.x)
      )
      const valueRightInsets = valueItems.map((item) =>
        roundMetric(
          role.container.bounds.x +
            role.container.bounds.width -
            (item.bounds.x + item.bounds.width)
        )
      )
      const labelLeftInsetSpread = Math.max(...labelLeftInsets) - Math.min(...labelLeftInsets)
      const valueRightInsetSpread = Math.max(...valueRightInsets) - Math.min(...valueRightInsets)

      if (
        labelLeftInsetSpread > SPACING_TOLERANCE_PX ||
        valueRightInsetSpread > SPACING_TOLERANCE_PX
      ) {
        return []
      }

      return [
        {
          container: role.container,
          valueItems,
          rightInset: roundMetric(median(valueRightInsets)),
          rowCount: candidateRows.length
        }
      ]
    }
  )

  if (rolesWithBodyMetaFooterActions.length < 3) return []

  const metaRowCountEntries = [...rolesWithBodyMetaFooterActions].reduce((counts, pair, index) => {
    const key = pair.rowCount
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      return counts
    }
    counts.set(key, {
      count: 1,
      firstIndex: index
    })
    return counts
  }, new Map<number, { count: number; firstIndex: number }>())
  const dominantMetaRowCount =
    [...metaRowCountEntries.entries()].sort((left, right) => {
      const [, leftMeta] = left
      const [, rightMeta] = right
      if (rightMeta.count !== leftMeta.count) {
        return rightMeta.count - leftMeta.count
      }
      return leftMeta.firstIndex - rightMeta.firstIndex
    })[0]?.[0] ?? null

  if (typeof dominantMetaRowCount !== 'number') return []

  const comparableBodyMetaFooterActions = rolesWithBodyMetaFooterActions.filter(
    (pair) => pair.rowCount === dominantMetaRowCount
  )

  if (comparableBodyMetaFooterActions.length < 3) return []

  return comparableBodyMetaFooterActions
}

export function resolveContainerBadgeStackSpacingPairs(
  items: DesignInspectionItemSummary[]
): ContainerBadgeStackSpacingPair[] {
  const rolesWithBadgeStacks = resolveStructuredContainerTextRoles(items).flatMap((role) => {
    const nonHeaderRows = role.rows.slice(1)
    if (nonHeaderRows.length < 4) return []

    const bodyRow = nonHeaderRows[0]
    const footerRow = nonHeaderRows[nonHeaderRows.length - 1]
    const badgeRows = nonHeaderRows.slice(1, -1)
    if (
      bodyRow.length !== 1 ||
      footerRow.length !== 1 ||
      badgeRows.length < 2 ||
      !badgeRows.every((row) => row.length === 1)
    ) {
      return []
    }

    const badgeItems = badgeRows.map((row) => row[0])
    const badgeLeftInsets = badgeItems.map((item) =>
      roundMetric(item.bounds.x - role.container.bounds.x)
    )
    const badgeLeftInsetSpread = Math.max(...badgeLeftInsets) - Math.min(...badgeLeftInsets)
    if (badgeLeftInsetSpread > SPACING_TOLERANCE_PX) return []

    const gaps = badgeItems
      .slice(1)
      .map((item, index) =>
        roundMetric(item.bounds.y - (badgeItems[index].bounds.y + badgeItems[index].bounds.height))
      )
    const gapSpread = gaps.length > 0 ? Math.max(...gaps) - Math.min(...gaps) : 0
    if (gaps.length < 1 || gapSpread > SPACING_TOLERANCE_PX) return []

    const footerItem = footerRow[0]
    const badgeGap = roundMetric(median(gaps))
    const footerGap = roundMetric(
      footerItem.bounds.y -
        (badgeItems[badgeItems.length - 1].bounds.y +
          badgeItems[badgeItems.length - 1].bounds.height)
    )
    if (footerGap <= SPACING_TOLERANCE_PX) return []

    return [
      {
        container: role.container,
        items: badgeItems,
        gap: badgeGap,
        footerGap,
        rowCount: badgeItems.length
      }
    ]
  })

  if (rolesWithBadgeStacks.length < 3) return []

  const badgeRowCountEntries = [...rolesWithBadgeStacks].reduce((counts, pair, index) => {
    const key = pair.rowCount
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      return counts
    }
    counts.set(key, {
      count: 1,
      firstIndex: index
    })
    return counts
  }, new Map<number, { count: number; firstIndex: number }>())
  const dominantBadgeRowCount =
    [...badgeRowCountEntries.entries()].sort((left, right) => {
      const [, leftMeta] = left
      const [, rightMeta] = right
      if (rightMeta.count !== leftMeta.count) {
        return rightMeta.count - leftMeta.count
      }
      return leftMeta.firstIndex - rightMeta.firstIndex
    })[0]?.[0] ?? null

  if (typeof dominantBadgeRowCount !== 'number') return []

  const comparableBadgeStacks = rolesWithBadgeStacks.filter(
    (pair) => pair.rowCount === dominantBadgeRowCount
  )

  if (comparableBadgeStacks.length < 3) return []

  const targetBadgeGap = roundMetric(median(comparableBadgeStacks.map((pair) => pair.gap)))
  const targetFooterGap = roundMetric(median(comparableBadgeStacks.map((pair) => pair.footerGap)))
  if (Math.abs(targetFooterGap - targetBadgeGap) <= SPACING_TOLERANCE_PX) return []

  return comparableBadgeStacks
}

export function resolveContainerTailBadgeStackSpacingPairs(
  items: DesignInspectionItemSummary[]
): ContainerTailBadgeStackSpacingPair[] {
  const rolesWithTailBadgeStacks = resolveStructuredContainerTextRoles(items).flatMap((role) => {
    const stack = resolveTrailingSingleColumnStack(role)
    if (!stack) return []

    return [
      {
        container: role.container,
        items: stack.items,
        gap: stack.gap,
        rowCount: stack.items.length
      }
    ]
  })

  if (rolesWithTailBadgeStacks.length < 3) return []

  const badgeRowCountEntries = [...rolesWithTailBadgeStacks].reduce((counts, pair, index) => {
    const key = pair.rowCount
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      return counts
    }
    counts.set(key, {
      count: 1,
      firstIndex: index
    })
    return counts
  }, new Map<number, { count: number; firstIndex: number }>())
  const dominantBadgeRowCount =
    [...badgeRowCountEntries.entries()].sort((left, right) => {
      const [, leftMeta] = left
      const [, rightMeta] = right
      if (rightMeta.count !== leftMeta.count) {
        return rightMeta.count - leftMeta.count
      }
      return leftMeta.firstIndex - rightMeta.firstIndex
    })[0]?.[0] ?? null

  if (typeof dominantBadgeRowCount !== 'number') return []

  const comparableBadgeStacks = rolesWithTailBadgeStacks.filter(
    (pair) => pair.rowCount === dominantBadgeRowCount
  )

  if (comparableBadgeStacks.length < 3) return []

  return comparableBadgeStacks
}

export function resolveContainerBadgeStackFooterActionSpacingPairs(
  items: DesignInspectionItemSummary[]
): ContainerBadgeStackFooterActionSpacingPair[] {
  const rolesWithBadgeStacks = resolveStructuredContainerTextRoles(items).flatMap((role) => {
    const nonHeaderRows = role.rows.slice(1)
    if (nonHeaderRows.length < 4) return []

    const bodyRow = nonHeaderRows[0]
    const footerActionRow = nonHeaderRows[nonHeaderRows.length - 1]
    const badgeRows = nonHeaderRows.slice(1, -1)
    if (
      bodyRow.length !== 1 ||
      footerActionRow.length < 2 ||
      badgeRows.length < 2 ||
      !badgeRows.every((row) => row.length === 1)
    ) {
      return []
    }

    const badgeItems = badgeRows.map((row) => row[0])
    const badgeLeftInsets = badgeItems.map((item) =>
      roundMetric(item.bounds.x - role.container.bounds.x)
    )
    const badgeLeftInsetSpread = Math.max(...badgeLeftInsets) - Math.min(...badgeLeftInsets)
    if (badgeLeftInsetSpread > SPACING_TOLERANCE_PX) return []

    const gaps = badgeItems
      .slice(1)
      .map((item, index) =>
        roundMetric(item.bounds.y - (badgeItems[index].bounds.y + badgeItems[index].bounds.height))
      )
    const gapSpread = gaps.length > 0 ? Math.max(...gaps) - Math.min(...gaps) : 0
    if (gaps.length < 1 || gapSpread > SPACING_TOLERANCE_PX) return []

    return [
      {
        container: role.container,
        items: badgeItems,
        gap: roundMetric(median(gaps)),
        rowCount: badgeItems.length,
        footerRowCount: footerActionRow.length
      }
    ]
  })

  if (rolesWithBadgeStacks.length < 3) return []

  const badgeShapeEntries = [...rolesWithBadgeStacks].reduce((counts, pair, index) => {
    const key = `${pair.rowCount}:${pair.footerRowCount}`
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      return counts
    }
    counts.set(key, {
      count: 1,
      firstIndex: index
    })
    return counts
  }, new Map<string, { count: number; firstIndex: number }>())
  const dominantBadgeShape =
    [...badgeShapeEntries.entries()].sort((left, right) => {
      const [, leftMeta] = left
      const [, rightMeta] = right
      if (rightMeta.count !== leftMeta.count) {
        return rightMeta.count - leftMeta.count
      }
      return leftMeta.firstIndex - rightMeta.firstIndex
    })[0]?.[0] ?? null

  if (!dominantBadgeShape) return []

  const comparableBadgeStacks = rolesWithBadgeStacks.filter(
    (pair) => `${pair.rowCount}:${pair.footerRowCount}` === dominantBadgeShape
  )

  if (comparableBadgeStacks.length < 3) return []

  return comparableBadgeStacks
}

export function resolveContainerChipGroupRowSpacingPairs(
  items: DesignInspectionItemSummary[]
): ContainerChipGroupRowSpacingPair[] {
  const rolesWithChipGroups = resolveStructuredContainerTextRoles(items).flatMap((role) => {
    if (role.rows.length < 5) return []

    const bodyRow = role.rows[1]
    const trailingRows = role.rows.slice(2)
    const footerRow = trailingRows[trailingRows.length - 1]

    if (!bodyRow || bodyRow.length !== 1 || trailingRows.length < 3 || footerRow?.length !== 1) {
      return []
    }

    const chipRows = trailingRows.slice(0, -1)
    if (chipRows.length < 2 || !chipRows.every((row) => row.length === 3)) return []

    const leftInsets = chipRows.map((row) => roundMetric(row[0].bounds.x - role.container.bounds.x))
    const leftInsetSpread = Math.max(...leftInsets) - Math.min(...leftInsets)
    if (leftInsetSpread > SPACING_TOLERANCE_PX) return []

    const rowGaps = chipRows.map((row) =>
      row
        .slice(1)
        .map((item, index) =>
          roundMetric(item.bounds.x - (row[index].bounds.x + row[index].bounds.width))
        )
    )
    if (rowGaps.some((gaps) => gaps.some((gap) => gap <= SPACING_TOLERANCE_PX))) return []

    const rowGapSpreads = rowGaps.map((gaps) => roundMetric(Math.max(...gaps) - Math.min(...gaps)))
    if (rowGapSpreads.some((spread) => spread > SPACING_TOLERANCE_PX)) return []

    const rowMedianGaps = rowGaps.map((gaps) => roundMetric(median(gaps)))
    const rowMedianGapSpread = Math.max(...rowMedianGaps) - Math.min(...rowMedianGaps)
    if (rowMedianGapSpread > SPACING_TOLERANCE_PX) return []

    return [
      {
        container: role.container,
        rows: chipRows,
        gap: roundMetric(median(rowMedianGaps)),
        rowCount: chipRows.length,
        columnCount: 3
      }
    ]
  })

  if (rolesWithChipGroups.length < 3) return []

  const chipShapeEntries = [...rolesWithChipGroups].reduce((counts, pair, index) => {
    const key = `${pair.rowCount}:${pair.columnCount}`
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      return counts
    }
    counts.set(key, {
      count: 1,
      firstIndex: index
    })
    return counts
  }, new Map<string, { count: number; firstIndex: number }>())
  const dominantChipShape =
    [...chipShapeEntries.entries()].sort((left, right) => {
      const [, leftMeta] = left
      const [, rightMeta] = right
      if (rightMeta.count !== leftMeta.count) {
        return rightMeta.count - leftMeta.count
      }
      return leftMeta.firstIndex - rightMeta.firstIndex
    })[0]?.[0] ?? null

  if (!dominantChipShape) return []

  const comparableChipGroups = rolesWithChipGroups.filter(
    (pair) => `${pair.rowCount}:${pair.columnCount}` === dominantChipShape
  )

  if (comparableChipGroups.length < 3) return []

  return comparableChipGroups
}

export function resolveContainerChipGroupFooterActionRowSpacingPairs(
  items: DesignInspectionItemSummary[]
): ContainerChipGroupFooterActionRowSpacingPair[] {
  const rolesWithChipGroups = resolveStructuredContainerTextRoles(items).flatMap((role) => {
    if (role.rows.length < 5) return []

    const bodyRow = role.rows[1]
    const trailingRows = role.rows.slice(2)
    const footerActionRow = trailingRows[trailingRows.length - 1]

    if (
      !bodyRow ||
      bodyRow.length !== 1 ||
      trailingRows.length < 3 ||
      !footerActionRow ||
      footerActionRow.length < 2
    ) {
      return []
    }

    const chipRows = trailingRows.slice(0, -1)
    if (chipRows.length < 2 || !chipRows.every((row) => row.length === 3)) return []

    const leftInsets = chipRows.map((row) => roundMetric(row[0].bounds.x - role.container.bounds.x))
    const leftInsetSpread = Math.max(...leftInsets) - Math.min(...leftInsets)
    if (leftInsetSpread > SPACING_TOLERANCE_PX) return []

    const rowGaps = chipRows.map((row) =>
      row
        .slice(1)
        .map((item, index) =>
          roundMetric(item.bounds.x - (row[index].bounds.x + row[index].bounds.width))
        )
    )
    if (rowGaps.some((gaps) => gaps.some((gap) => gap <= SPACING_TOLERANCE_PX))) return []

    const rowGapSpreads = rowGaps.map((gaps) => roundMetric(Math.max(...gaps) - Math.min(...gaps)))
    if (rowGapSpreads.some((spread) => spread > SPACING_TOLERANCE_PX)) return []

    const rowMedianGaps = rowGaps.map((gaps) => roundMetric(median(gaps)))
    const rowMedianGapSpread = Math.max(...rowMedianGaps) - Math.min(...rowMedianGaps)
    if (rowMedianGapSpread > SPACING_TOLERANCE_PX) return []

    return [
      {
        container: role.container,
        rows: chipRows,
        gap: roundMetric(median(rowMedianGaps)),
        rowCount: chipRows.length,
        columnCount: 3,
        footerRowCount: footerActionRow.length
      }
    ]
  })

  if (rolesWithChipGroups.length < 3) return []

  const chipShapeEntries = [...rolesWithChipGroups].reduce((counts, pair, index) => {
    const key = `${pair.rowCount}:${pair.columnCount}:${pair.footerRowCount}`
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      return counts
    }
    counts.set(key, {
      count: 1,
      firstIndex: index
    })
    return counts
  }, new Map<string, { count: number; firstIndex: number }>())
  const dominantChipShape =
    [...chipShapeEntries.entries()].sort((left, right) => {
      const [, leftMeta] = left
      const [, rightMeta] = right
      if (rightMeta.count !== leftMeta.count) {
        return rightMeta.count - leftMeta.count
      }
      return leftMeta.firstIndex - rightMeta.firstIndex
    })[0]?.[0] ?? null

  if (!dominantChipShape) return []

  const comparableChipGroups = rolesWithChipGroups.filter(
    (pair) => `${pair.rowCount}:${pair.columnCount}:${pair.footerRowCount}` === dominantChipShape
  )

  if (comparableChipGroups.length < 3) return []

  return comparableChipGroups
}

export function resolveContainerTrailingBadgeStackSpacingPairs(
  items: DesignInspectionItemSummary[]
): ContainerTrailingBadgeStackSpacingPair[] {
  return resolveStructuredContainerTextRoles(items)
    .flatMap((role) => {
      if (role.rows.length !== 4) return []

      const bodyRow = role.rows[1]
      const trailingRows = role.rows.slice(2)

      if (
        !bodyRow ||
        bodyRow.length !== 1 ||
        trailingRows.length !== 2 ||
        !trailingRows.every((row) => row.length === 1)
      ) {
        return []
      }

      const badgeItems = trailingRows.map((row) => row[0])
      const badgeLeftInsets = badgeItems.map((item) =>
        roundMetric(item.bounds.x - role.container.bounds.x)
      )
      const badgeLeftInsetSpread = Math.max(...badgeLeftInsets) - Math.min(...badgeLeftInsets)
      if (badgeLeftInsetSpread > SPACING_TOLERANCE_PX) return []

      const gap = roundMetric(
        badgeItems[1].bounds.y - (badgeItems[0].bounds.y + badgeItems[0].bounds.height)
      )
      if (gap <= SPACING_TOLERANCE_PX) return []

      return [
        {
          container: role.container,
          items: badgeItems,
          gap
        }
      ]
    })
    .filter((pair, index, pairs) => pairs.length >= 3)
}

export function resolveContainerBodyInsetPairs(
  items: DesignInspectionItemSummary[]
): ContainerBodyInsetPair[] {
  return resolveStructuredContainerTextRoles(items)
    .filter((role): role is StructuredContainerTextRoles & { body: TitleTextItemSummary } =>
      Boolean(role.body)
    )
    .map((role) => ({
      container: role.container,
      title: role.title,
      body: role.body,
      leftInset: roundMetric(role.body.bounds.x - role.container.bounds.x),
      verticalGap: roundMetric(
        role.body.bounds.y - (role.title.bounds.y + role.title.bounds.height)
      )
    }))
}

export function resolveContainerFooterInsetPairs(
  items: DesignInspectionItemSummary[]
): ContainerFooterInsetPair[] {
  return resolveStructuredContainerTextRoles(items).flatMap((role) => {
    if (
      !role.footer ||
      !role.footerRow ||
      role.footerRow.length !== 1 ||
      resolveTrailingSingleColumnStack(role)
    ) {
      return []
    }

    return [
      {
        container: role.container,
        footer: role.footer,
        bottomInset: roundMetric(
          role.container.bounds.y +
            role.container.bounds.height -
            (role.footer.bounds.y + role.footer.bounds.height)
        )
      }
    ]
  })
}

export function resolveContainerFooterRowSpacingPairs(
  items: DesignInspectionItemSummary[]
): ContainerFooterRowSpacingPair[] {
  const rolesWithFooterRows = resolveStructuredContainerTextRoles(items).filter(
    (role): role is StructuredContainerTextRoles & { footerRow: TitleTextItemSummary[] } =>
      Boolean(role.rows.length === 3 && role.footerRow && role.footerRow.length >= 2)
  )

  if (rolesWithFooterRows.length < 3) return []

  const footerRowCountEntries = [...rolesWithFooterRows].reduce((counts, role, index) => {
    const key = role.footerRow.length
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      return counts
    }
    counts.set(key, {
      count: 1,
      firstIndex: index
    })
    return counts
  }, new Map<number, { count: number; firstIndex: number }>())
  const dominantFooterRowCount =
    [...footerRowCountEntries.entries()].sort((left, right) => {
      const [, leftMeta] = left
      const [, rightMeta] = right
      if (rightMeta.count !== leftMeta.count) {
        return rightMeta.count - leftMeta.count
      }
      return leftMeta.firstIndex - rightMeta.firstIndex
    })[0]?.[0] ?? null

  if (typeof dominantFooterRowCount !== 'number') return []

  const comparableRows = rolesWithFooterRows.filter(
    (role) => role.footerRow.length === dominantFooterRowCount
  )

  if (comparableRows.length < 3) return []

  return comparableRows.map((role) => {
    const gaps = role.footerRow
      .slice(1)
      .map((item, index) =>
        roundMetric(
          item.bounds.x - (role.footerRow[index].bounds.x + role.footerRow[index].bounds.width)
        )
      )

    return {
      container: role.container,
      items: role.footerRow,
      gap: roundMetric(median(gaps))
    }
  })
}

export function resolveDominantCornerShape(
  items: InspectableRectangularAnnotationSummary[]
): RectangularCornerShape | null {
  if (items.length === 0) return null

  const counts = new Map<RectangularCornerShape, { count: number; firstIndex: number }>()
  items.forEach((item, index) => {
    const existing = counts.get(item.shape)
    if (existing) {
      existing.count += 1
      return
    }
    counts.set(item.shape, {
      count: 1,
      firstIndex: index
    })
  })

  const dominantEntry = [...counts.entries()].sort((left, right) => {
    const [, leftMeta] = left
    const [, rightMeta] = right
    if (rightMeta.count !== leftMeta.count) {
      return rightMeta.count - leftMeta.count
    }
    return leftMeta.firstIndex - rightMeta.firstIndex
  })[0]

  return dominantEntry?.[0] ?? null
}
