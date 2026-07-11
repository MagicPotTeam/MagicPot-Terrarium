import type { DesignInspectionItemSummary } from '@shared/designInspection'
import {
  ALIGNMENT_TOLERANCE_PX,
  SPACING_TOLERANCE_PX,
  getWidthNormalizableItems,
  median,
  resolveContainingLayoutContainer,
  roundMetric
} from './designInspectionStructureCore'
import {
  resolveGridCandidate,
  resolveHorizontalRowCandidate,
  resolveVerticalStackCandidate
} from './designInspectionGridRules'
import type {
  StructuredContainerTextRoles,
  TitleTextItemSummary,
  WidthNormalizableItemSummary
} from './designInspectionStructureTypes'

export function getTitleTextItems(items: DesignInspectionItemSummary[]): TitleTextItemSummary[] {
  return items.filter((item): item is TitleTextItemSummary => {
    return item.type === 'text' && Boolean(item.textContent && typeof item.fontSize === 'number')
  })
}

export function sortTextItemsByGeometry(textItems: TitleTextItemSummary[]): TitleTextItemSummary[] {
  return [...textItems].sort((left, right) => {
    if (left.bounds.y !== right.bounds.y) return left.bounds.y - right.bounds.y
    if (left.bounds.x !== right.bounds.x) return left.bounds.x - right.bounds.x
    return left.zIndex - right.zIndex
  })
}

export function resolveTextRows(textItems: TitleTextItemSummary[]): TitleTextItemSummary[][] {
  const rows: TitleTextItemSummary[][] = []

  for (const textItem of sortTextItemsByGeometry(textItems)) {
    const currentRow = rows[rows.length - 1]
    if (!currentRow) {
      rows.push([textItem])
      continue
    }

    if (Math.abs(textItem.bounds.y - currentRow[0].bounds.y) <= ALIGNMENT_TOLERANCE_PX) {
      currentRow.push(textItem)
      currentRow.sort((left, right) => {
        if (left.bounds.x !== right.bounds.x) return left.bounds.x - right.bounds.x
        return left.zIndex - right.zIndex
      })
      continue
    }

    rows.push([textItem])
  }

  return rows
}

export function resolveStructuredContainerTextRoles(
  items: DesignInspectionItemSummary[]
): StructuredContainerTextRoles[] {
  const containers = getWidthNormalizableItems(items)

  const textItems = getTitleTextItems(items)

  if (containers.length < 2 || textItems.length < 2) return []

  const textGroups = new Map<
    string,
    {
      container: WidthNormalizableItemSummary
      texts: TitleTextItemSummary[]
    }
  >()

  for (const textItem of textItems) {
    const container = resolveContainingLayoutContainer(textItem, containers)
    if (!container) continue

    const existing = textGroups.get(container.id)
    if (existing) {
      existing.texts.push(textItem)
      continue
    }

    textGroups.set(container.id, {
      container,
      texts: [textItem]
    })
  }

  const roles: StructuredContainerTextRoles[] = []

  for (const { container, texts } of textGroups.values()) {
    const rows = resolveTextRows(texts)
    const headerRow = rows[0]
    const bodyRow = rows[1]
    const footerRow = rows.length >= 3 ? rows[rows.length - 1] : undefined
    const title = headerRow?.[0]

    if (!title) continue

    const role: StructuredContainerTextRoles = {
      container,
      title,
      rows
    }
    const headerMeta = headerRow.length >= 2 ? headerRow[headerRow.length - 1] : undefined
    const body = bodyRow?.[0]
    const footer = footerRow?.[0]

    if (headerMeta) role.headerMeta = headerMeta
    if (body) role.body = body
    if (footer) role.footer = footer
    if (footerRow && footerRow.length > 0) role.footerRow = footerRow

    roles.push(role)
  }

  if (roles.length < 3) return []

  const structuredContainers =
    resolveVerticalStackCandidate(roles.map((role) => role.container)) ||
    resolveGridCandidate(roles.map((role) => role.container)) ||
    resolveHorizontalRowCandidate(roles.map((role) => role.container))

  if (!structuredContainers || structuredContainers.length < 3) return []

  const allowedContainerIds = new Set(structuredContainers.map((item) => item.id))

  return roles.filter((role) => allowedContainerIds.has(role.container.id))
}

export function resolveTrailingSingleColumnStack(
  role: StructuredContainerTextRoles
): { items: TitleTextItemSummary[]; gap: number } | null {
  if (role.rows.length !== 4) return null

  const bodyRow = role.rows[1]
  const trailingRows = role.rows.slice(2)
  if (
    !bodyRow ||
    bodyRow.length !== 1 ||
    trailingRows.length !== 2 ||
    !trailingRows.every((row) => row.length === 1)
  ) {
    return null
  }

  const items = trailingRows.map((row) => row[0])
  const leftInsets = items.map((item) => roundMetric(item.bounds.x - role.container.bounds.x))
  const leftInsetSpread = Math.max(...leftInsets) - Math.min(...leftInsets)
  if (leftInsetSpread > SPACING_TOLERANCE_PX) return null

  const gaps = items
    .slice(1)
    .map((item, index) =>
      roundMetric(item.bounds.y - (items[index].bounds.y + items[index].bounds.height))
    )
  const gapSpread = gaps.length > 0 ? Math.max(...gaps) - Math.min(...gaps) : 0
  if (
    gaps.length < 1 ||
    gaps.some((gap) => gap <= SPACING_TOLERANCE_PX) ||
    gapSpread > SPACING_TOLERANCE_PX
  ) {
    return null
  }

  return {
    items,
    gap: roundMetric(median(gaps))
  }
}
