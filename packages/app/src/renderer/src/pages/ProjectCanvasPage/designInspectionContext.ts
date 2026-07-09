import type {
  DesignInspectionArtifact,
  DesignInspectionContextPack,
  DesignInspectionFallbackSignal,
  DesignInspectionItemSummary,
  DesignInspectionReferenceSummary,
  DesignInspectionRuleSource,
  DesignInspectionSelectionBounds
} from '@shared/designInspection'
import { createDesignInspectionId, roundDesignInspectionMetric } from './designInspectionCommon'
import type { CanvasFileItem, CanvasGroup, CanvasItem } from './types'

export type DesignInspectionBoundsResolver = (
  item: CanvasItem
) => DesignInspectionSelectionBounds | null

type BuildDesignInspectionContextPackOptions = {
  task: string
  projectId?: string
  projectName?: string
  targetItems: CanvasItem[]
  groups: CanvasGroup[]
  snapshotDataUrl?: string | null
  getItemBounds?: DesignInspectionBoundsResolver
  now?: Date
}

const DEFAULT_TASK =
  'Inspect the selected canvas items with structure-first checks and propose only MagicPot-internal fixes for typography, spacing, alignment, radius consistency, simple geometry cleanup, and editable file-node content updates when reviewer notes explicitly request copy changes.'

function roundMetric(value: number): number {
  return roundDesignInspectionMetric(value)
}

function toSelectionBounds(item: CanvasItem): DesignInspectionSelectionBounds {
  return {
    x: roundMetric(item.x),
    y: roundMetric(item.y),
    width: roundMetric(Math.max(1, item.width * Math.abs(item.scaleX || 1))),
    height: roundMetric(Math.max(1, item.height * Math.abs(item.scaleY || 1)))
  }
}

function getCanvasItemTextContent(item: CanvasItem): string | undefined {
  if (item.type === 'text') {
    return item.text?.trim() || undefined
  }

  if (item.type === 'annotation') {
    return item.text?.trim() || item.label?.trim() || undefined
  }

  if (item.type === 'file') {
    return item.previewText?.trim() || item.content?.trim() || undefined
  }

  return undefined
}

function summarizeCanvasItemProvenanceForInspection(
  item: CanvasItem
): DesignInspectionItemSummary['provenance'] {
  if (!item.provenance) return undefined

  return {
    kind: item.provenance.kind,
    sourceFileName: item.provenance.sourceFileName,
    sourceDocumentId: item.provenance.sourceDocumentId,
    sourceNodeId: item.provenance.sourceNodeId,
    sourceNodeName: item.provenance.sourceNodeName,
    bridgeTraceId: item.provenance.bridgeTraceId,
    notes: item.provenance.notes?.trim() || undefined
  }
}

export function summarizeCanvasItemForInspection(
  item: CanvasItem,
  getItemBounds?: DesignInspectionBoundsResolver
): DesignInspectionItemSummary {
  const bounds = getItemBounds?.(item) ?? toSelectionBounds(item)
  const textContent = getCanvasItemTextContent(item)
  const provenance = summarizeCanvasItemProvenanceForInspection(item)

  return {
    id: item.id,
    type: item.type,
    x: roundMetric(item.x),
    y: roundMetric(item.y),
    width: roundMetric(item.width),
    height: roundMetric(item.height),
    zIndex: item.zIndex,
    locked: item.locked,
    bounds,
    textContent,
    fontSize:
      item.type === 'text'
        ? item.fontSize
        : item.type === 'annotation' && typeof item.fontSize === 'number'
          ? item.fontSize
          : undefined,
    fontFamily: item.type === 'text' ? item.fontFamily : undefined,
    fontWeight:
      item.type === 'text'
        ? item.fontWeight
        : item.type === 'annotation'
          ? item.fontWeight
          : undefined,
    fill: item.type === 'text' ? item.fill : undefined,
    stroke: item.type === 'annotation' ? item.stroke : undefined,
    label: item.type === 'annotation' ? item.label : undefined,
    shape: item.type === 'annotation' ? item.shape : undefined,
    fileName:
      item.type === 'image' ||
      item.type === 'video' ||
      item.type === 'model3d' ||
      item.type === 'file'
        ? item.fileName
        : undefined,
    mimeType: item.type === 'file' ? item.mimeType : undefined,
    previewText: item.type === 'file' ? item.previewText || item.content || undefined : undefined,
    provenance
  }
}

function buildSelectionBounds(
  selectionItems: DesignInspectionItemSummary[]
): DesignInspectionSelectionBounds | null {
  if (selectionItems.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const item of selectionItems) {
    minX = Math.min(minX, item.bounds.x)
    minY = Math.min(minY, item.bounds.y)
    maxX = Math.max(maxX, item.bounds.x + item.bounds.width)
    maxY = Math.max(maxY, item.bounds.y + item.bounds.height)
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null
  }

  return {
    x: roundMetric(minX),
    y: roundMetric(minY),
    width: roundMetric(maxX - minX),
    height: roundMetric(maxY - minY)
  }
}

function buildContextRules(task: string): DesignInspectionRuleSource[] {
  return [
    {
      source: 'canvas.structure-first',
      content:
        'Use MagicPot canvas geometry, typography, grouping, and provenance fields before relying on fallback snapshots or inferred external source context.'
    },
    {
      source: 'canvas.execution-scope',
      content:
        'Only propose MagicPot-internal actions that can be approved and applied without external bridge side effects.'
    },
    {
      source: 'canvas.user-task',
      content: task || DEFAULT_TASK
    }
  ]
}

function buildFallbackSignals(
  selectionItems: DesignInspectionItemSummary[],
  snapshotDataUrl?: string | null
): DesignInspectionFallbackSignal[] {
  const signals: DesignInspectionFallbackSignal[] = [
    {
      type: 'geometry-measurement',
      label: 'selection-geometry',
      content:
        'Selection bounds and relative positions were computed from the structured canvas items.'
    }
  ]

  if (snapshotDataUrl) {
    signals.push({
      type: 'snapshot',
      label: 'selection-snapshot',
      content: 'A rendered snapshot is attached as a visual fallback for ambiguous geometry.'
    })
  }

  const selectionText = selectionItems
    .map((item) => item.textContent?.trim())
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .trim()

  if (selectionText) {
    signals.push({
      type: 'selection-text',
      label: 'selection-text',
      content: selectionText
    })
  }

  return signals
}

export function buildDesignInspectionContextPack({
  task,
  projectId,
  projectName,
  targetItems,
  groups,
  snapshotDataUrl,
  getItemBounds,
  now = new Date()
}: BuildDesignInspectionContextPackOptions): DesignInspectionContextPack {
  const selectionItems = targetItems.map((item) =>
    summarizeCanvasItemForInspection(item, getItemBounds)
  )
  const selectedItemIds = new Set(selectionItems.map((item) => item.id))
  const relatedGroupIds = groups
    .filter((group) => group.itemIds.some((itemId) => selectedItemIds.has(itemId)))
    .map((group) => group.id)

  const documents = targetItems
    .filter((item): item is CanvasFileItem => item.type === 'file' && Boolean(item.previewText))
    .map((item) => ({
      itemId: item.id,
      fileName: item.fileName || item.id,
      mimeType: item.mimeType || 'application/octet-stream',
      editable: Boolean(item.editable),
      previewText: item.previewText || ''
    }))

  const references: DesignInspectionReferenceSummary[] = [
    ...selectionItems
      .filter(
        (item): item is DesignInspectionItemSummary & { type: 'image' | 'video' | 'model3d' } =>
          item.type === 'image' || item.type === 'video' || item.type === 'model3d'
      )
      .map((item) => ({
        itemId: item.id,
        type: item.type,
        label: item.fileName || item.id,
        detail:
          item.type === 'video'
            ? 'Included this structured media node in the inspection.'
            : undefined
      })),
    ...groups
      .filter((group) => relatedGroupIds.includes(group.id))
      .map((group) => ({
        itemId: group.id,
        type: 'group' as const,
        label: group.name,
        detail: `This group contains ${group.itemIds.filter((itemId) => selectedItemIds.has(itemId)).length} selected item(s).`
      }))
  ]

  const canvasSnapshot: DesignInspectionArtifact | null = snapshotDataUrl
    ? {
        type: 'image',
        label: 'selection-snapshot',
        mimeType: 'image/png',
        url: snapshotDataUrl
      }
    : null

  return {
    id: createDesignInspectionId('design-context'),
    createdAt: now.toISOString(),
    task: task || DEFAULT_TASK,
    projectId,
    projectName,
    structureFirst: true,
    selection: {
      itemIds: selectionItems.map((item) => item.id),
      groupIds: relatedGroupIds,
      bounds: buildSelectionBounds(selectionItems)
    },
    selectionItems,
    canvasSnapshot,
    documents,
    references,
    rules: buildContextRules(task || DEFAULT_TASK),
    fallbackSignals: buildFallbackSignals(selectionItems, snapshotDataUrl)
  }
}
