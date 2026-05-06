import type { DesignInspectionItemSummary } from '@shared/designInspection'

const ITEM_LABEL_LIMIT = 32

export type DesignInspectionProvenanceOverview = {
  kindLabels: string[]
  detailLines: string[]
  totalItemCount: number
  hiddenDetailCount: number
}

function truncateLabel(value: string): string {
  if (value.length <= ITEM_LABEL_LIMIT) return value
  return `${value.slice(0, ITEM_LABEL_LIMIT)}...`
}

function getSelectionItemLabel(item: DesignInspectionItemSummary): string {
  const rawLabel =
    item.fileName?.trim() ||
    item.label?.trim() ||
    item.textContent?.trim() ||
    item.previewText?.trim() ||
    item.id

  return truncateLabel(rawLabel)
}

export function formatDesignInspectionProvenanceKind(
  kind: NonNullable<DesignInspectionItemSummary['provenance']>['kind']
): string {
  switch (kind) {
    case 'magicpot-native':
      return 'MagicPot 原生'
    case 'figma':
      return 'Figma'
    case 'psd':
      return 'PSD'
    case 'psb':
      return 'PSB'
    case 'svg':
      return 'SVG'
    case 'imported-file':
      return '导入文件'
    case 'external':
      return '外部入口'
    default:
      return kind
  }
}

function formatDesignInspectionProvenanceTarget(item: DesignInspectionItemSummary): string | null {
  const provenance = item.provenance
  if (!provenance) return null

  return (
    provenance.sourceNodeName?.trim() ||
    provenance.sourceFileName?.trim() ||
    provenance.sourceDocumentId?.trim() ||
    provenance.sourceNodeId?.trim() ||
    provenance.bridgeTraceId?.trim() ||
    null
  )
}

export function formatDesignInspectionProvenanceDetail(
  item: DesignInspectionItemSummary
): string | null {
  const provenance = item.provenance
  if (!provenance) return null

  const kindLabel = formatDesignInspectionProvenanceKind(provenance.kind)
  const target = formatDesignInspectionProvenanceTarget(item)
  const itemLabel = getSelectionItemLabel(item)

  if (target) {
    return `来源明细：元素“${itemLabel}”当前以 ${kindLabel} 元素参与检查（来源标识：${truncateLabel(target)}）`
  }

  return `来源明细：元素“${itemLabel}”当前以 ${kindLabel} 元素参与检查`
}

export function summarizeDesignInspectionSelectionProvenance(
  items: DesignInspectionItemSummary[],
  maxDetailLines = 3
): DesignInspectionProvenanceOverview | null {
  const itemsWithProvenance = items.filter(
    (
      item
    ): item is DesignInspectionItemSummary & {
      provenance: NonNullable<DesignInspectionItemSummary['provenance']>
    } => Boolean(item.provenance)
  )

  if (itemsWithProvenance.length === 0) return null

  const kindCounts = new Map<string, number>()
  for (const item of itemsWithProvenance) {
    const kindLabel = formatDesignInspectionProvenanceKind(item.provenance.kind)
    kindCounts.set(kindLabel, (kindCounts.get(kindLabel) || 0) + 1)
  }

  const detailLines = itemsWithProvenance
    .map((item) => formatDesignInspectionProvenanceDetail(item))
    .filter((value): value is string => Boolean(value))

  return {
    kindLabels: [...kindCounts.entries()].map(([label, count]) => `${label} ${count}`),
    detailLines: detailLines.slice(0, maxDetailLines),
    totalItemCount: itemsWithProvenance.length,
    hiddenDetailCount: Math.max(0, detailLines.length - maxDetailLines)
  }
}
