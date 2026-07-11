import type { DesignInspectionItemSummary } from '@shared/designInspection'
import type { InspectableTextSummary, PrimaryTextStyle } from './designInspectionStructureTypes'

export function getInspectableTextItems(
  items: DesignInspectionItemSummary[]
): InspectableTextSummary[] {
  return items.filter((item): item is InspectableTextSummary => {
    return Boolean(item.textContent && typeof item.fontSize === 'number' && item.fontSize > 0)
  })
}

export function createStyleKey(item: InspectableTextSummary): string {
  return JSON.stringify({
    fontSize: item.fontSize,
    fontFamily: item.fontFamily || '',
    fontWeight: item.fontWeight || '',
    fill: item.fill || ''
  })
}

export function resolvePrimaryTextStyle(items: InspectableTextSummary[]): PrimaryTextStyle | null {
  if (items.length === 0) return null

  const counts = new Map<string, { count: number; item: InspectableTextSummary }>()
  for (const item of items) {
    const key = createStyleKey(item)
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
    } else {
      counts.set(key, { count: 1, item })
    }
  }

  const dominant = [...counts.values()].sort((left, right) => right.count - left.count)[0]?.item
  if (!dominant) return null

  return {
    fontSize: dominant.fontSize,
    fontFamily: dominant.fontFamily,
    fontWeight: dominant.fontWeight,
    fill: dominant.fill
  }
}

export function itemNeedsTextStyleNormalization(
  item: InspectableTextSummary,
  style: PrimaryTextStyle
): boolean {
  if (typeof style.fontSize === 'number' && item.fontSize !== style.fontSize) return true
  if (item.type === 'text' && style.fontFamily && item.fontFamily !== style.fontFamily) return true
  if (style.fontWeight && item.fontWeight !== style.fontWeight) return true
  if (item.type === 'text' && style.fill && item.fill !== style.fill) return true
  return false
}
