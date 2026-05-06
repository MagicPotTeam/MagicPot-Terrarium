import type { ChatAttachment, LLMProxySvc } from '@shared/api/svcLLMProxy'
import type {
  DesignInspectionAction,
  DesignInspectionApproval,
  DesignInspectionArtifact,
  DesignInspectionContextPack,
  DesignInspectionExecutionPlanStep,
  DesignInspectionExecutionResult,
  DesignInspectionFallbackSignal,
  DesignInspectionIssue,
  DesignInspectionItemSummary,
  DesignInspectionProposal,
  DesignInspectionReferenceSummary,
  DesignInspectionRuleSource,
  DesignInspectionSelectionBounds,
  DesignInspectionTraceEntry
} from '@shared/designInspection'
import { buildCanvasFileContentUpdate } from './canvasAgentAttachmentUtils'
import { summarizeDesignInspectionSelectionProvenance } from './designInspectionProvenancePresentation'
import type { CanvasFileItem, CanvasGroup, CanvasItem } from './types'

type BoundsResolver = (item: CanvasItem) => DesignInspectionSelectionBounds | null

type BuildDesignInspectionContextPackOptions = {
  task: string
  projectId?: string
  projectName?: string
  targetItems: CanvasItem[]
  groups: CanvasGroup[]
  snapshotDataUrl?: string | null
  getItemBounds?: BoundsResolver
  now?: Date
}

type RequestDesignInspectionProposalOptions = {
  contextPack: DesignInspectionContextPack
  draftProposal: DesignInspectionProposal
  llmProxy?: Pick<LLMProxySvc, 'chat' | 'listProfiles'> | null
  attachments?: ChatAttachment[]
  userNotes?: string
}

type ApplyDesignInspectionProposalResult = {
  items: CanvasItem[]
  result: DesignInspectionExecutionResult
}

type DesignInspectionAgentContentSuggestion = {
  itemId: string
  title?: string
  summary?: string
  description?: string
  expectedImpact?: string
  evidence?: string[]
  content: string
}

type DesignInspectionAgentResponse = Partial<DesignInspectionProposal> & {
  contentActionSuggestions?: DesignInspectionAgentContentSuggestion[]
}

type InspectableTextSummary = DesignInspectionItemSummary & {
  fontSize: number
  textContent: string
}

type PrimaryTextStyle = {
  fontSize?: number
  fontFamily?: string
  fontWeight?: 'normal' | 'bold'
  fill?: string
}

type RectangularCornerShape = 'rect' | 'rounded-rect'

type InspectableRectangularAnnotationSummary = DesignInspectionItemSummary & {
  type: 'annotation'
  shape: RectangularCornerShape
}

type WidthNormalizableItemSummary =
  | (DesignInspectionItemSummary & {
      type: 'annotation'
      shape: RectangularCornerShape | 'document' | 'double-line-rect'
    })
  | (DesignInspectionItemSummary & {
      type: 'file'
    })

type TitleTextItemSummary = InspectableTextSummary & {
  type: 'text'
}

type ContainerTitleInsetPair = {
  container: WidthNormalizableItemSummary
  title: TitleTextItemSummary
  leftInset: number
  rightInset: number
  topInset: number
  centerOffset: number
}

type ContainerHeaderMetaInsetPair = {
  container: WidthNormalizableItemSummary
  meta: TitleTextItemSummary
  rightInset: number
}

type ContainerMetaBlockValueColumnPair = {
  container: WidthNormalizableItemSummary
  valueItems: TitleTextItemSummary[]
  rightInset: number
  rowCount: number
}

type ContainerBodyMetaValueColumnPair = {
  container: WidthNormalizableItemSummary
  valueItems: TitleTextItemSummary[]
  rightInset: number
  rowCount: number
}

type ContainerBodyMetaFooterActionValueColumnPair = {
  container: WidthNormalizableItemSummary
  valueItems: TitleTextItemSummary[]
  rightInset: number
  rowCount: number
}

type ContainerBadgeStackSpacingPair = {
  container: WidthNormalizableItemSummary
  items: TitleTextItemSummary[]
  gap: number
  footerGap: number
  rowCount: number
}

type ContainerTailBadgeStackSpacingPair = {
  container: WidthNormalizableItemSummary
  items: TitleTextItemSummary[]
  gap: number
  rowCount: number
}

type ContainerBadgeStackFooterActionSpacingPair = {
  container: WidthNormalizableItemSummary
  items: TitleTextItemSummary[]
  gap: number
  rowCount: number
  footerRowCount: number
}

type ContainerChipGroupRowSpacingPair = {
  container: WidthNormalizableItemSummary
  rows: TitleTextItemSummary[][]
  gap: number
  rowCount: number
  columnCount: number
}

type ContainerChipGroupFooterActionRowSpacingPair = {
  container: WidthNormalizableItemSummary
  rows: TitleTextItemSummary[][]
  gap: number
  rowCount: number
  columnCount: number
  footerRowCount: number
}

type ContainerTrailingBadgeStackSpacingPair = {
  container: WidthNormalizableItemSummary
  items: TitleTextItemSummary[]
  gap: number
}

type ContainerBodyInsetPair = {
  container: WidthNormalizableItemSummary
  title: TitleTextItemSummary
  body: TitleTextItemSummary
  leftInset: number
  verticalGap: number
}

type ContainerFooterInsetPair = {
  container: WidthNormalizableItemSummary
  footer: TitleTextItemSummary
  bottomInset: number
}

type ContainerFooterRowSpacingPair = {
  container: WidthNormalizableItemSummary
  items: TitleTextItemSummary[]
  gap: number
}

type GridTwoByThreeRowSpacingPair = {
  label: string
  items: WidthNormalizableItemSummary[]
  gap: number
  gapSpread: number
  gaps: number[]
  index: number
}

type ThreeColumnMultiRowMatrixCandidate = {
  rows: WidthNormalizableItemSummary[][]
  columns: WidthNormalizableItemSummary[][]
}

type ThreeColumnMultiRowMatrixGraphCandidate = {
  rows: WidthNormalizableItemSummary[][]
  columns: WidthNormalizableItemSummary[][]
}

type ThreeColumnMatrixGraphTrackKind = 'left' | 'center' | 'right'

type ThreeColumnMatrixGraphResolvedTrack = {
  kind: ThreeColumnMatrixGraphTrackKind
  target: number
}

type ThreeColumnMatrixRowSpacingPair = {
  label: string
  items: WidthNormalizableItemSummary[]
  top: number
  gap: number
  gapSpread: number
  gaps: number[]
  index: number
  anchorAligned: boolean
}

type ThreeColumnMatrixRowRhythmTransition = {
  label: string
  items: WidthNormalizableItemSummary[]
  top: number
  topGap: number
  gap: number
  gapSpread: number
  gaps: number[]
  index: number
}

type StructuredContainerTextRoles = {
  container: WidthNormalizableItemSummary
  title: TitleTextItemSummary
  rows: TitleTextItemSummary[][]
  headerMeta?: TitleTextItemSummary
  body?: TitleTextItemSummary
  footer?: TitleTextItemSummary
  footerRow?: TitleTextItemSummary[]
}

const DEFAULT_TASK =
  'Inspect the selected canvas items with structure-first checks and propose only MagicPot-internal fixes for typography, spacing, alignment, radius consistency, simple geometry cleanup, and editable file-node content updates when reviewer notes explicitly request copy changes.'

const ALIGNMENT_TOLERANCE_PX = 4
const SPACING_TOLERANCE_PX = 6
const HEIGHT_TOLERANCE_PX = 6
const WIDTH_TOLERANCE_PX = 6

function createDesignInspectionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function roundMetric(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

function getThreeColumnMatrixGraphTrackValue(
  item: WidthNormalizableItemSummary,
  kind: ThreeColumnMatrixGraphTrackKind
): number {
  if (kind === 'left') return roundMetric(item.bounds.x)
  if (kind === 'center') return roundMetric(item.bounds.x + item.bounds.width / 2)
  return roundMetric(item.bounds.x + item.bounds.width)
}

function formatThreeColumnMatrixGraphTrackKind(kind: ThreeColumnMatrixGraphTrackKind): string {
  if (kind === 'left') return '\u5de6\u8f68\u9053'
  if (kind === 'center') return '\u4e2d\u5fc3\u7ebf'
  return '\u53f3\u8f68\u9053'
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
  getItemBounds?: BoundsResolver
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

function buildSelectionProvenanceNarrative(selectionItems: DesignInspectionItemSummary[]): {
  summarySuffix: string
  rationaleSuffix: string
  promptOverview: NonNullable<ReturnType<typeof summarizeDesignInspectionSelectionProvenance>>
} | null {
  const provenanceOverview = summarizeDesignInspectionSelectionProvenance(selectionItems, 2)
  if (!provenanceOverview) return null

  const kindSummary = provenanceOverview.kindLabels.join('\u3001')
  const detailSummary =
    provenanceOverview.detailLines.length > 0
      ? ` \u5173\u952e\u6765\u6e90\uff1a${provenanceOverview.detailLines.join('\uff1b')}\u3002`
      : ''

  return {
    summarySuffix: ` \u6765\u6e90\uff1a${kindSummary}\u3002`,
    rationaleSuffix:
      ` \u5f53\u524d\u6765\u6e90\u4e0a\u4e0b\u6587\uff1a${kindSummary}\uff1b` +
      `\u4ecd\u4ee5 MagicPot \u753b\u5e03\u5143\u7d20\u4e0e\u51e0\u4f55\u6570\u636e\u4e3a\u8fd0\u884c\u65f6\u68c0\u67e5\u771f\u76f8\u3002${detailSummary}`,
    promptOverview: provenanceOverview
  }
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
        detail: item.type === 'video' ? '已将结构化媒体节点加入本次检查。' : undefined
      })),
    ...groups
      .filter((group) => relatedGroupIds.includes(group.id))
      .map((group) => ({
        itemId: group.id,
        type: 'group' as const,
        label: group.name,
        detail: `该分组包含${group.itemIds.filter((itemId) => selectedItemIds.has(itemId)).length} 个已选元素。`
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

function getInspectableTextItems(items: DesignInspectionItemSummary[]): InspectableTextSummary[] {
  return items.filter((item): item is InspectableTextSummary => {
    return Boolean(item.textContent && typeof item.fontSize === 'number' && item.fontSize > 0)
  })
}

function createStyleKey(item: InspectableTextSummary): string {
  return JSON.stringify({
    fontSize: item.fontSize,
    fontFamily: item.fontFamily || '',
    fontWeight: item.fontWeight || '',
    fill: item.fill || ''
  })
}

function resolvePrimaryTextStyle(items: InspectableTextSummary[]): PrimaryTextStyle | null {
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

function getRectangularAnnotationItems(
  items: DesignInspectionItemSummary[]
): InspectableRectangularAnnotationSummary[] {
  return items.filter((item): item is InspectableRectangularAnnotationSummary => {
    return item.type === 'annotation' && (item.shape === 'rect' || item.shape === 'rounded-rect')
  })
}

function getWidthNormalizableItems(
  items: DesignInspectionItemSummary[]
): WidthNormalizableItemSummary[] {
  return items.filter((item): item is WidthNormalizableItemSummary => {
    if (item.type === 'file') return true

    return (
      item.type === 'annotation' &&
      (item.shape === 'rect' ||
        item.shape === 'rounded-rect' ||
        item.shape === 'document' ||
        item.shape === 'double-line-rect')
    )
  })
}

function getHeightNormalizableItems(
  items: DesignInspectionItemSummary[]
): WidthNormalizableItemSummary[] {
  return getWidthNormalizableItems(items)
}

function getLayoutHeuristicItems(
  items: DesignInspectionItemSummary[]
): DesignInspectionItemSummary[] {
  const blockItems = getWidthNormalizableItems(items)

  if (blockItems.length > 0 && blockItems.length < items.length) {
    return blockItems
  }

  return items
}

function getTitleTextItems(items: DesignInspectionItemSummary[]): TitleTextItemSummary[] {
  return items.filter((item): item is TitleTextItemSummary => {
    return item.type === 'text' && Boolean(item.textContent && typeof item.fontSize === 'number')
  })
}

function getItemArea(item: DesignInspectionItemSummary): number {
  return roundMetric(item.bounds.width * item.bounds.height)
}

function itemIsContainedWithin(
  item: DesignInspectionItemSummary,
  container: WidthNormalizableItemSummary
): boolean {
  return (
    item.bounds.x >= container.bounds.x - ALIGNMENT_TOLERANCE_PX &&
    item.bounds.y >= container.bounds.y - ALIGNMENT_TOLERANCE_PX &&
    item.bounds.x + item.bounds.width <=
      container.bounds.x + container.bounds.width + ALIGNMENT_TOLERANCE_PX &&
    item.bounds.y + item.bounds.height <=
      container.bounds.y + container.bounds.height + ALIGNMENT_TOLERANCE_PX
  )
}

function resolveContainingLayoutContainer(
  item: DesignInspectionItemSummary,
  containers: WidthNormalizableItemSummary[]
): WidthNormalizableItemSummary | null {
  const candidates = containers
    .filter((container) => item.id !== container.id && itemIsContainedWithin(item, container))
    .sort((left, right) => {
      const areaDelta = getItemArea(left) - getItemArea(right)
      if (areaDelta !== 0) return areaDelta
      return left.zIndex - right.zIndex
    })

  return candidates[0] ?? null
}

function sortTextItemsByGeometry(textItems: TitleTextItemSummary[]): TitleTextItemSummary[] {
  return [...textItems].sort((left, right) => {
    if (left.bounds.y !== right.bounds.y) return left.bounds.y - right.bounds.y
    if (left.bounds.x !== right.bounds.x) return left.bounds.x - right.bounds.x
    return left.zIndex - right.zIndex
  })
}

function resolveTextRows(textItems: TitleTextItemSummary[]): TitleTextItemSummary[][] {
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

function resolveStructuredContainerTextRoles(
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

function resolveTrailingSingleColumnStack(
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

function resolveContainerTitleInsetPairs(
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

function resolveContainerHeaderMetaInsetPairs(
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

function resolveContainerMetaBlockValueColumnPairs(
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

function resolveContainerBodyMetaValueColumnPairs(
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

function resolveContainerBodyMetaFooterActionValueColumnPairs(
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

function resolveContainerBadgeStackSpacingPairs(
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

function resolveContainerTailBadgeStackSpacingPairs(
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

function resolveContainerBadgeStackFooterActionSpacingPairs(
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

function resolveContainerChipGroupRowSpacingPairs(
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

function resolveContainerChipGroupFooterActionRowSpacingPairs(
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

function resolveContainerTrailingBadgeStackSpacingPairs(
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

function resolveContainerBodyInsetPairs(
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

function resolveContainerFooterInsetPairs(
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

function resolveContainerFooterRowSpacingPairs(
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

function resolveDominantCornerShape(
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

function itemNeedsTextStyleNormalization(
  item: InspectableTextSummary,
  style: PrimaryTextStyle
): boolean {
  if (typeof style.fontSize === 'number' && item.fontSize !== style.fontSize) return true
  if (item.type === 'text' && style.fontFamily && item.fontFamily !== style.fontFamily) return true
  if (style.fontWeight && item.fontWeight !== style.fontWeight) return true
  if (item.type === 'text' && style.fill && item.fill !== style.fill) return true
  return false
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

function resolveVerticalStackCandidate(
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

function resolveHorizontalRowCandidate(
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

function resolveGridCandidate(
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

function resolveTwoByThreeGridCandidate(
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

function resolveThreeColumnMultiRowMatrixCandidate(
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

function resolveThreeColumnMultiRowMatrixGraphCandidate(
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

function createTraceEntry(
  stage: DesignInspectionTraceEntry['stage'],
  message: string
): DesignInspectionTraceEntry {
  return {
    at: new Date().toISOString(),
    stage,
    message
  }
}

function shouldAllowChineseContentSuggestions(userNotes?: string): boolean {
  const normalizedNotes = userNotes?.trim().toLowerCase()
  if (!normalizedNotes) return false

  return (
    /(文件|文档|文案|内容|文本)/.test(normalizedNotes) &&
    /(修改|更新|重写|改写|替换|润色)/.test(normalizedNotes)
  )
}

function formatApprovalStatusForTrace(status: DesignInspectionApproval['status']): string {
  switch (status) {
    case 'approved':
      return '已批准'
    case 'rejected':
      return '已拒绝'
    case 'retry_requested':
      return '已请求重试'
    case 'pending':
    default:
      return '待确认'
  }
}

function createExecutionAppliedTrace(action: DesignInspectionAction): DesignInspectionTraceEntry {
  return createTraceEntry('execution_applied', `已应用动作：${action.title}。`)
}

export function buildStructureFirstDesignInspectionProposal(
  contextPack: DesignInspectionContextPack
): DesignInspectionProposal {
  const issues: DesignInspectionIssue[] = []
  const actions: DesignInspectionAction[] = []
  const executionPlan: DesignInspectionExecutionPlanStep[] = []
  const selectionItems = contextPack.selectionItems
  const provenanceNarrative = buildSelectionProvenanceNarrative(selectionItems)
  const layoutItems = getLayoutHeuristicItems(selectionItems)
  const textItems = getInspectableTextItems(selectionItems)
  const rectangularAnnotationItems = getRectangularAnnotationItems(selectionItems)
  const containerTitleInsetPairs = resolveContainerTitleInsetPairs(selectionItems)
  const containerHeaderMetaInsetPairs = resolveContainerHeaderMetaInsetPairs(selectionItems)
  const containerMetaBlockValueColumnPairs =
    resolveContainerMetaBlockValueColumnPairs(selectionItems)
  const containerBodyMetaValueColumnPairs = resolveContainerBodyMetaValueColumnPairs(selectionItems)
  const containerBodyMetaFooterActionValueColumnPairs =
    resolveContainerBodyMetaFooterActionValueColumnPairs(selectionItems)
  const containerBodyInsetPairs = resolveContainerBodyInsetPairs(selectionItems)
  const containerBadgeStackSpacingPairs = resolveContainerBadgeStackSpacingPairs(selectionItems)
  const containerTailBadgeStackSpacingPairs =
    resolveContainerTailBadgeStackSpacingPairs(selectionItems)
  const containerBadgeStackFooterActionSpacingPairs =
    resolveContainerBadgeStackFooterActionSpacingPairs(selectionItems)
  const containerChipGroupRowSpacingPairs = resolveContainerChipGroupRowSpacingPairs(selectionItems)
  const containerChipGroupFooterActionRowSpacingPairs =
    resolveContainerChipGroupFooterActionRowSpacingPairs(selectionItems)
  const containerTrailingBadgeStackSpacingPairs =
    resolveContainerTrailingBadgeStackSpacingPairs(selectionItems)
  const containerFooterInsetPairs = resolveContainerFooterInsetPairs(selectionItems)
  const containerFooterRowSpacingPairs = resolveContainerFooterRowSpacingPairs(selectionItems)

  if (textItems.length >= 2) {
    const primaryStyle = resolvePrimaryTextStyle(textItems)
    const targetItems = primaryStyle
      ? textItems.filter((item) => itemNeedsTextStyleNormalization(item, primaryStyle))
      : []

    if (primaryStyle && targetItems.length > 0) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'normalize-text-style',
        title: '将文本样式统一到选区主样式',
        description: '把偏离主样式的文本节点恢复到当前选区中已经占主导的字号与字体样式。',
        executor: 'magicpot-internal',
        targetItemIds: targetItems.map((item) => item.id),
        payload: {
          fontSize: primaryStyle.fontSize,
          fontFamily: primaryStyle.fontFamily,
          fontWeight: primaryStyle.fontWeight,
          fill: primaryStyle.fill
        },
        expectedImpact: '文本样式会回到同一套系统，而不是混入零散的局部覆写。'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'typography',
        severity: 'warning',
        title: '所选文本节点的字体样式不一致',
        summary: '结构优先检查发现，同一选区内存在字号或字体样式不一致的文本节点。',
        itemIds: targetItems.map((item) => item.id),
        evidence: targetItems.map(
          (item) =>
            `${item.id}：字号 ${item.fontSize}，字体 ${item.fontFamily || '未提供'}，字重 ${item.fontWeight || 'normal'}`
        ),
        actionIds: [actionId]
      })
    }
  }

  if (rectangularAnnotationItems.length >= 2) {
    const dominantCornerShape = resolveDominantCornerShape(rectangularAnnotationItems)
    const targetItems = dominantCornerShape
      ? rectangularAnnotationItems.filter((item) => item.shape !== dominantCornerShape)
      : []

    if (dominantCornerShape && targetItems.length > 0) {
      const actionId = createDesignInspectionId('design-action')
      const normalizedShapeLabel = dominantCornerShape === 'rounded-rect' ? '圆角' : '直角'
      actions.push({
        id: actionId,
        type: 'normalize-annotation-corner-style',
        title: '统一所选卡片的圆角风格',
        description: '把偏离风格的注释矩形恢复到当前选区中已经占主导的圆角处理。',
        executor: 'magicpot-internal',
        targetItemIds: targetItems.map((item) => item.id),
        payload: {
          shape: dominantCornerShape
        },
        expectedImpact: '这些矩形注释会更像同一套有意图的卡片系统，而不是混用直角与圆角。'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'radius',
        severity: 'warning',
        title: '矩形注释卡片混用了不同的圆角风格',
        summary: '结构优先检查发现，同一选区内同时存在直角和圆角的注释矩形。',
        itemIds: targetItems.map((item) => item.id),
        evidence: targetItems.map(
          (item) => `${item.id}：当前形状 ${item.shape}，标准为 ${normalizedShapeLabel}`
        ),
        actionIds: [actionId]
      })
    }
  }

  if (containerTitleInsetPairs.length >= 3) {
    const titleLeftInsets = containerTitleInsetPairs.map((pair) => pair.leftInset)
    const titleRightInsets = containerTitleInsetPairs.map((pair) =>
      roundMetric(
        pair.container.bounds.x +
          pair.container.bounds.width -
          (pair.title.bounds.x + pair.title.bounds.width)
      )
    )
    const titleCenterOffsets = containerTitleInsetPairs.map((pair) => pair.centerOffset)
    const leftSpread = Math.max(...titleLeftInsets) - Math.min(...titleLeftInsets)
    const rightSpread = Math.max(...titleRightInsets) - Math.min(...titleRightInsets)
    const centerSpread = Math.max(...titleCenterOffsets) - Math.min(...titleCenterOffsets)
    const targetCenterOffset = roundMetric(median(titleCenterOffsets))
    const offPatternCenterPairs = containerTitleInsetPairs.filter(
      (pair) => Math.abs(pair.centerOffset - targetCenterOffset) > ALIGNMENT_TOLERANCE_PX
    )
    const preferTitleCenterAlignment =
      offPatternCenterPairs.length > 0 &&
      centerSpread + ALIGNMENT_TOLERANCE_PX < Math.min(leftSpread, rightSpread)

    if (preferTitleCenterAlignment) {
      const actionIds: string[] = []
      const actionGroups = new Map<number, ContainerTitleInsetPair[]>()

      for (const pair of offPatternCenterPairs) {
        const targetCenterX = roundMetric(
          pair.container.bounds.x + pair.container.bounds.width / 2 + targetCenterOffset
        )
        const existing = actionGroups.get(targetCenterX)
        if (existing) {
          existing.push(pair)
        } else {
          actionGroups.set(targetCenterX, [pair])
        }
      }

      for (const [targetCenterX, pairs] of actionGroups.entries()) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-center',
          title: '将卡片标题统一到同一中心线',
          description:
            '调整各张同级卡片中的标题文本，使它们优先回到结构化几何里更稳定的共同中心线上。',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.title.id),
          payload: { centerX: targetCenterX },
          expectedImpact: '卡片标题会围绕同一条中心线组织，不再在共享轴线附近左右漂移。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: '卡片标题未对齐到同一中心线',
        summary:
          '结构优先的关系检查发现，这组同级卡片的标题更像围绕共同中心线组织，而不是使用稳定的左内边距或右内边距。',
        itemIds: offPatternCenterPairs.map((pair) => pair.title.id),
        evidence: offPatternCenterPairs.map(
          (pair) =>
            `${pair.title.id} 位于 ${pair.container.id}：标题中心偏移 ${pair.centerOffset}px，目标 ${targetCenterOffset}px`
        ),
        actionIds
      })
    }

    const targetLeftInset = roundMetric(median(titleLeftInsets))
    const offPatternLeftInsetPairs = containerTitleInsetPairs.filter(
      (pair) => Math.abs(pair.leftInset - targetLeftInset) > SPACING_TOLERANCE_PX
    )

    if (!preferTitleCenterAlignment && offPatternLeftInsetPairs.length > 0) {
      const actionIds: string[] = []
      const actionGroups = new Map<number, ContainerTitleInsetPair[]>()

      for (const pair of offPatternLeftInsetPairs) {
        const targetX = roundMetric(pair.container.bounds.x + targetLeftInset)
        const existing = actionGroups.get(targetX)
        if (existing) {
          existing.push(pair)
        } else {
          actionGroups.set(targetX, [pair])
        }
      }

      for (const [targetX, pairs] of actionGroups.entries()) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-left',
          title: '将卡片标题统一到一致的左内边距',
          description:
            '调整各张同级卡片中的顶部文本，使它们的左内边距回到结构化几何里最常见的数值。',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.title.id),
          payload: { x: targetX },
          expectedImpact: '卡片标题会回到同一条内部文本列，不再在相关卡片内左右漂移。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: '卡片标题左内边距不一致',
        summary: '结构优先的关系检查发现，同级卡片顶部文本的左内边距并不一致。',
        itemIds: offPatternLeftInsetPairs.map((pair) => pair.title.id),
        evidence: offPatternLeftInsetPairs.map(
          (pair) =>
            `${pair.title.id} 位于 ${pair.container.id}：左内边距 ${pair.leftInset}px，目标 ${targetLeftInset}px`
        ),
        actionIds
      })
    }

    const targetTopInset = roundMetric(
      median(containerTitleInsetPairs.map((pair) => pair.topInset))
    )
    const offPatternTopInsetPairs = containerTitleInsetPairs.filter(
      (pair) => Math.abs(pair.topInset - targetTopInset) > SPACING_TOLERANCE_PX
    )

    if (offPatternTopInsetPairs.length > 0) {
      const actionIds: string[] = []
      const actionGroups = new Map<number, ContainerTitleInsetPair[]>()

      for (const pair of offPatternTopInsetPairs) {
        const targetY = roundMetric(pair.container.bounds.y + targetTopInset)
        const existing = actionGroups.get(targetY)
        if (existing) {
          existing.push(pair)
        } else {
          actionGroups.set(targetY, [pair])
        }
      }

      for (const [targetY, pairs] of actionGroups.entries()) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-top',
          title: '将卡片标题统一到一致的上内边距',
          description:
            '调整各张同级卡片中的顶部文本，使它们的上内边距回到结构化几何里最常见的数值。',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.title.id),
          payload: { y: targetY },
          expectedImpact: '卡片标题会回到同一条内部上边距节奏，不再在相关卡片里上下漂移。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: '卡片标题上内边距不一致',
        summary: '结构优先的关系检查发现，同级卡片顶部文本的上内边距并不一致。',
        itemIds: offPatternTopInsetPairs.map((pair) => pair.title.id),
        evidence: offPatternTopInsetPairs.map(
          (pair) =>
            `${pair.title.id} 位于 ${pair.container.id}：上内边距 ${pair.topInset}px，目标 ${targetTopInset}px`
        ),
        actionIds
      })
    }
  }

  if (containerHeaderMetaInsetPairs.length >= 3) {
    const targetRightInset = roundMetric(
      median(containerHeaderMetaInsetPairs.map((pair) => pair.rightInset))
    )
    const offPatternRightInsetPairs = containerHeaderMetaInsetPairs.filter(
      (pair) => Math.abs(pair.rightInset - targetRightInset) > SPACING_TOLERANCE_PX
    )

    if (offPatternRightInsetPairs.length > 0) {
      const actionIds: string[] = []
      const actionGroups = new Map<number, ContainerHeaderMetaInsetPair[]>()

      for (const pair of offPatternRightInsetPairs) {
        const targetRightX = roundMetric(
          pair.container.bounds.x + pair.container.bounds.width - targetRightInset
        )
        const existing = actionGroups.get(targetRightX)
        if (existing) {
          existing.push(pair)
        } else {
          actionGroups.set(targetRightX, [pair])
        }
      }

      for (const [targetRightX, pairs] of actionGroups.entries()) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-right',
          title: '将卡片头部右侧文本统一到一致的右内边距',
          description:
            '调整各张同级卡片头部右侧的文本节点，使它们的右内边距回到结构化几何里最常见的数值。',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.meta.id),
          payload: { x: targetRightX },
          expectedImpact:
            '卡片头部右侧的状态、日期或标签文本会回到一致的右侧留白，不再在相关卡片里忽左忽右。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: '卡片头部右侧文本右内边距不一致',
        summary: '结构优先的关系检查发现，同级卡片头部右侧的文本节点没有保持一致的右侧内边距。',
        itemIds: offPatternRightInsetPairs.map((pair) => pair.meta.id),
        evidence: offPatternRightInsetPairs.map(
          (pair) =>
            `${pair.meta.id} 位于 ${pair.container.id}：右内边距 ${pair.rightInset}px，目标 ${targetRightInset}px`
        ),
        actionIds
      })
    }
  }

  if (containerMetaBlockValueColumnPairs.length >= 3) {
    const targetRightInset = roundMetric(
      median(containerMetaBlockValueColumnPairs.map((pair) => pair.rightInset))
    )
    const offPatternMetaBlocks = containerMetaBlockValueColumnPairs.filter(
      (pair) => Math.abs(pair.rightInset - targetRightInset) > SPACING_TOLERANCE_PX
    )

    if (offPatternMetaBlocks.length > 0) {
      const actionIds: string[] = []
      const actionGroups = new Map<number, ContainerMetaBlockValueColumnPair[]>()

      for (const pair of offPatternMetaBlocks) {
        const targetRightX = roundMetric(
          pair.container.bounds.x + pair.container.bounds.width - targetRightInset
        )
        const existing = actionGroups.get(targetRightX)
        if (existing) {
          existing.push(pair)
        } else {
          actionGroups.set(targetRightX, [pair])
        }
      }

      for (const [targetRightX, pairs] of actionGroups.entries()) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-right',
          title: '将卡片信息值列统一到一致的右内边距',
          description:
            '调整同级卡片信息块中的右侧取值文本，使它们的右内边距回到结构化几何里最常见的数值。',
          executor: 'magicpot-internal',
          targetItemIds: pairs.flatMap((pair) => pair.valueItems.map((item) => item.id)),
          payload: { x: targetRightX },
          expectedImpact: '卡片信息块里的数值列会回到一致的右侧留白，不再在相关卡片里忽左忽右。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: '卡片信息块的值列右内边距不一致',
        summary: '结构优先的关系检查发现，同级卡片信息块中的右侧取值文本没有保持一致的右侧内边距。',
        itemIds: offPatternMetaBlocks.flatMap((pair) => pair.valueItems.map((item) => item.id)),
        evidence: offPatternMetaBlocks.map(
          (pair) =>
            `${pair.valueItems.map((item) => item.id).join(', ')} 位于 ${pair.container.id}：值列右内边距 ${pair.rightInset}px，目标 ${targetRightInset}px`
        ),
        actionIds
      })
    }
  }

  if (containerBodyMetaValueColumnPairs.length >= 3) {
    const targetRightInset = roundMetric(
      median(containerBodyMetaValueColumnPairs.map((pair) => pair.rightInset))
    )
    const offPatternBodyMetaBlocks = containerBodyMetaValueColumnPairs.filter(
      (pair) => Math.abs(pair.rightInset - targetRightInset) > SPACING_TOLERANCE_PX
    )

    if (offPatternBodyMetaBlocks.length > 0) {
      const actionIds: string[] = []
      const actionGroups = new Map<number, ContainerBodyMetaValueColumnPair[]>()

      for (const pair of offPatternBodyMetaBlocks) {
        const targetRightX = roundMetric(
          pair.container.bounds.x + pair.container.bounds.width - targetRightInset
        )
        const existing = actionGroups.get(targetRightX)
        if (existing) {
          existing.push(pair)
        } else {
          actionGroups.set(targetRightX, [pair])
        }
      }

      for (const [targetRightX, pairs] of actionGroups.entries()) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-right',
          title: '将卡片正文后的信息值列统一到一致的右内边距',
          description:
            '调整同级卡片正文后方的信息取值文本，使它们的右内边距回到结构化几何里最常见的数值。',
          executor: 'magicpot-internal',
          targetItemIds: pairs.flatMap((pair) => pair.valueItems.map((item) => item.id)),
          payload: { x: targetRightX },
          expectedImpact: '卡片正文后方的信息值列会回到一致的右侧留白，不再在相关卡片里忽左忽右。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: '卡片正文后的信息值列右内边距不一致',
        summary: '结构优先的关系检查发现，同级卡片正文后的信息取值文本没有保持一致的右侧内边距。',
        itemIds: offPatternBodyMetaBlocks.flatMap((pair) => pair.valueItems.map((item) => item.id)),
        evidence: offPatternBodyMetaBlocks.map(
          (pair) =>
            `${pair.valueItems.map((item) => item.id).join(', ')} 位于 ${pair.container.id}：值列右内边距 ${pair.rightInset}px，目标 ${targetRightInset}px`
        ),
        actionIds
      })
    }
  }

  if (containerBodyMetaFooterActionValueColumnPairs.length >= 3) {
    const targetRightInset = roundMetric(
      median(containerBodyMetaFooterActionValueColumnPairs.map((pair) => pair.rightInset))
    )
    const offPatternBodyMetaFooterActions = containerBodyMetaFooterActionValueColumnPairs.filter(
      (pair) => Math.abs(pair.rightInset - targetRightInset) > SPACING_TOLERANCE_PX
    )

    if (offPatternBodyMetaFooterActions.length > 0) {
      const actionIds: string[] = []
      const actionGroups = new Map<number, ContainerBodyMetaFooterActionValueColumnPair[]>()

      for (const pair of offPatternBodyMetaFooterActions) {
        const targetRightX = roundMetric(
          pair.container.bounds.x + pair.container.bounds.width - targetRightInset
        )
        const existing = actionGroups.get(targetRightX)
        if (existing) {
          existing.push(pair)
        } else {
          actionGroups.set(targetRightX, [pair])
        }
      }

      for (const [targetRightX, pairs] of actionGroups.entries()) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-right',
          title: '将卡片底部操作行前的信息值列统一到一致的右内边距',
          description:
            '调整同级卡片正文后、底部操作行前的两列信息文本，让值列回到结构化几何里最常见的右侧留白。',
          executor: 'magicpot-internal',
          targetItemIds: pairs.flatMap((pair) => pair.valueItems.map((item) => item.id)),
          payload: { x: targetRightX },
          expectedImpact: '卡片底部操作行前的值列会回到一致的右侧留白，不再在相关卡片里忽左忽右。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: '卡片底部操作行前的信息值列右内边距不一致',
        summary:
          '结构优先的关系检查发现，同级卡片正文后、底部操作行前的信息值列没有保持一致的右侧内边距。',
        itemIds: offPatternBodyMetaFooterActions.flatMap((pair) =>
          pair.valueItems.map((item) => item.id)
        ),
        evidence: offPatternBodyMetaFooterActions.map(
          (pair) =>
            `${pair.valueItems.map((item) => item.id).join(', ')} 位于 ${pair.container.id}：值列右内边距 ${pair.rightInset}px，目标 ${targetRightInset}px`
        ),
        actionIds
      })
    }
  }

  if (containerBadgeStackSpacingPairs.length >= 3) {
    const targetGap = roundMetric(median(containerBadgeStackSpacingPairs.map((pair) => pair.gap)))
    const offPatternBadgeStacks = containerBadgeStackSpacingPairs.filter(
      (pair) => Math.abs(pair.gap - targetGap) > SPACING_TOLERANCE_PX
    )

    if (offPatternBadgeStacks.length > 0) {
      const actionIds: string[] = []

      for (const pair of offPatternBadgeStacks) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'distribute-vertical-spacing',
          title: '将卡片标签堆叠统一到一致的垂直间距',
          description:
            '调整同级卡片正文与页脚之间的标签文本，使它们的垂直间距回到结构化几何里最常见的节奏。',
          executor: 'magicpot-internal',
          targetItemIds: pair.items.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: pair.items[0].id
          },
          expectedImpact: '卡片内部的标签堆叠会回到一致的纵向节奏，不再在相关卡片里忽疏忽密。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: '卡片标签堆叠的垂直间距不一致',
        summary: '结构优先的关系检查发现，同级卡片正文与页脚之间的标签堆叠没有保持一致的垂直间距。',
        itemIds: offPatternBadgeStacks.flatMap((pair) => pair.items.map((item) => item.id)),
        evidence: offPatternBadgeStacks.map(
          (pair) =>
            `${pair.items.map((item) => item.id).join(', ')} 位于 ${pair.container.id}：标签间距 ${pair.gap}px，目标 ${targetGap}px`
        ),
        actionIds
      })
    }
  }

  if (containerTailBadgeStackSpacingPairs.length >= 3) {
    const targetGap = roundMetric(
      median(containerTailBadgeStackSpacingPairs.map((pair) => pair.gap))
    )
    const offPatternBadgeStacks = containerTailBadgeStackSpacingPairs.filter(
      (pair) => Math.abs(pair.gap - targetGap) > SPACING_TOLERANCE_PX
    )

    if (offPatternBadgeStacks.length > 0) {
      const actionIds: string[] = []

      for (const pair of offPatternBadgeStacks) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'distribute-vertical-spacing',
          title:
            '\u5c06\u5361\u7247\u5c3e\u90e8\u6807\u7b7e\u5806\u53e0\u7edf\u4e00\u5230\u4e00\u81f4\u7684\u5782\u76f4\u95f4\u8ddd',
          description:
            '\u8c03\u6574\u540c\u7ea7\u5361\u7247\u6b63\u6587\u540e\u7684\u5c3e\u90e8\u6807\u7b7e\u6587\u672c\uff0c\u4f7f\u5b83\u4eec\u7684\u5782\u76f4\u95f4\u8ddd\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u5e38\u89c1\u7684\u8282\u594f\u3002',
          executor: 'magicpot-internal',
          targetItemIds: pair.items.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: pair.items[0].id
          },
          expectedImpact:
            '\u5361\u7247\u5c3e\u90e8\u7684\u6807\u7b7e\u5806\u53e0\u4f1a\u56de\u5230\u4e00\u81f4\u7684\u7eb5\u5411\u8282\u594f\uff0c\u4e0d\u518d\u5728\u76f8\u5173\u5361\u7247\u91cc\u5ffd\u758f\u5ffd\u5bc6\u3002'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title:
          '\u5361\u7247\u5c3e\u90e8\u6807\u7b7e\u5806\u53e0\u7684\u5782\u76f4\u95f4\u8ddd\u4e0d\u4e00\u81f4',
        summary:
          '\u7ed3\u6784\u4f18\u5148\u7684\u5173\u7cfb\u68c0\u67e5\u53d1\u73b0\uff0c\u540c\u7ea7\u5361\u7247\u6b63\u6587\u540e\u7684\u5c3e\u90e8\u6807\u7b7e\u5806\u53e0\u6ca1\u6709\u4fdd\u6301\u4e00\u81f4\u7684\u5782\u76f4\u95f4\u8ddd\u3002',
        itemIds: offPatternBadgeStacks.flatMap((pair) => pair.items.map((item) => item.id)),
        evidence: offPatternBadgeStacks.map(
          (pair) =>
            `${pair.items.map((item) => item.id).join(', ')} \u4f4d\u4e8e ${pair.container.id}\uff1a\u6807\u7b7e\u95f4\u8ddd ${pair.gap}px\uff0c\u76ee\u6807 ${targetGap}px`
        ),
        actionIds
      })
    }
  }

  if (containerBadgeStackFooterActionSpacingPairs.length >= 3) {
    const targetGap = roundMetric(
      median(containerBadgeStackFooterActionSpacingPairs.map((pair) => pair.gap))
    )
    const offPatternBadgeStacks = containerBadgeStackFooterActionSpacingPairs.filter(
      (pair) => Math.abs(pair.gap - targetGap) > SPACING_TOLERANCE_PX
    )

    if (offPatternBadgeStacks.length > 0) {
      const actionIds: string[] = []

      for (const pair of offPatternBadgeStacks) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'distribute-vertical-spacing',
          title:
            '\u5c06\u5361\u7247\u6309\u94ae\u884c\u4e0a\u65b9\u7684\u6807\u7b7e\u5806\u53e0\u7edf\u4e00\u5230\u4e00\u81f4\u7684\u5782\u76f4\u95f4\u8ddd',
          description:
            '\u8c03\u6574\u540c\u7ea7\u5361\u7247\u6b63\u6587\u4e0e\u5e95\u90e8\u6309\u94ae\u884c\u4e4b\u95f4\u7684\u6807\u7b7e\u6587\u672c\uff0c\u4f7f\u5b83\u4eec\u7684\u5782\u76f4\u95f4\u8ddd\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u5e38\u89c1\u7684\u8282\u594f\u3002',
          executor: 'magicpot-internal',
          targetItemIds: pair.items.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: pair.items[0].id
          },
          expectedImpact:
            '\u5361\u7247\u6309\u94ae\u884c\u4e0a\u65b9\u7684\u6807\u7b7e\u5806\u53e0\u4f1a\u56de\u5230\u4e00\u81f4\u7684\u7eb5\u5411\u8282\u594f\uff0c\u4e0d\u518d\u5728\u76f8\u5173\u5361\u7247\u91cc\u5ffd\u758f\u5ffd\u5bc6\u3002'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title:
          '\u5361\u7247\u6309\u94ae\u884c\u4e0a\u65b9\u7684\u6807\u7b7e\u5806\u53e0\u5782\u76f4\u95f4\u8ddd\u4e0d\u4e00\u81f4',
        summary:
          '\u7ed3\u6784\u4f18\u5148\u7684\u5173\u7cfb\u68c0\u67e5\u53d1\u73b0\uff0c\u540c\u7ea7\u5361\u7247\u6b63\u6587\u4e0e\u5e95\u90e8\u6309\u94ae\u884c\u4e4b\u95f4\u7684\u6807\u7b7e\u5806\u53e0\u6ca1\u6709\u4fdd\u6301\u4e00\u81f4\u7684\u5782\u76f4\u95f4\u8ddd\u3002',
        itemIds: offPatternBadgeStacks.flatMap((pair) => pair.items.map((item) => item.id)),
        evidence: offPatternBadgeStacks.map(
          (pair) =>
            `${pair.items.map((item) => item.id).join(', ')} \u4f4d\u4e8e ${pair.container.id}\uff1a\u6807\u7b7e\u95f4\u8ddd ${pair.gap}px\uff0c\u76ee\u6807 ${targetGap}px`
        ),
        actionIds
      })
    }
  }

  if (containerChipGroupRowSpacingPairs.length >= 3) {
    const targetGap = roundMetric(median(containerChipGroupRowSpacingPairs.map((pair) => pair.gap)))
    const offPatternChipGroups = containerChipGroupRowSpacingPairs.filter(
      (pair) => Math.abs(pair.gap - targetGap) > SPACING_TOLERANCE_PX
    )

    if (offPatternChipGroups.length > 0) {
      const actionIds: string[] = []
      const itemIds = new Set<string>()
      const evidence: string[] = []

      for (const pair of offPatternChipGroups) {
        for (const row of pair.rows) {
          const actionId = createDesignInspectionId('design-action')
          actions.push({
            id: actionId,
            type: 'distribute-horizontal-spacing',
            title:
              '\u5c06\u5361\u7247\u591a\u5217\u6807\u7b7e\u7ec4\u7edf\u4e00\u5230\u4e00\u81f4\u7684\u6c34\u5e73\u95f4\u8ddd',
            description:
              '\u8c03\u6574\u540c\u7ea7\u5361\u7247\u6b63\u6587\u540e\u7684\u591a\u5217\u6807\u7b7e\u6587\u672c\uff0c\u4f7f\u6bcf\u4e00\u884c\u5185\u90e8\u7684\u76f8\u90bb\u95f4\u8ddd\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u5e38\u89c1\u7684\u6c34\u5e73\u8282\u594f\u3002',
            executor: 'magicpot-internal',
            targetItemIds: row.map((item) => item.id),
            payload: {
              gap: targetGap,
              anchorItemId: row[0].id
            },
            expectedImpact:
              '\u5361\u7247\u5185\u90e8\u7684\u591a\u5217\u6807\u7b7e\u7ec4\u4f1a\u56de\u5230\u4e00\u81f4\u7684\u6a2a\u5411\u8282\u594f\uff0c\u4e0d\u518d\u5728\u76f8\u5173\u5361\u7247\u91cc\u5ffd\u758f\u5ffd\u5bc6\u3002'
          })
          actionIds.push(actionId)

          for (const item of row) {
            itemIds.add(item.id)
          }
        }

        evidence.push(
          `${pair.rows
            .map((row) => row.map((item) => item.id).join(', '))
            .join(
              ' / '
            )} \u4f4d\u4e8e ${pair.container.id}\uff1a\u6807\u7b7e\u95f4\u8ddd ${pair.gap}px\uff0c\u76ee\u6807 ${targetGap}px`
        )
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title:
          '\u5361\u7247\u591a\u5217\u6807\u7b7e\u7ec4\u7684\u6c34\u5e73\u95f4\u8ddd\u4e0d\u4e00\u81f4',
        summary:
          '\u7ed3\u6784\u4f18\u5148\u7684\u5173\u7cfb\u68c0\u67e5\u53d1\u73b0\uff0c\u540c\u7ea7\u5361\u7247\u6b63\u6587\u540e\u7684\u591a\u5217\u6807\u7b7e\u7ec4\u6ca1\u6709\u4fdd\u6301\u4e00\u81f4\u7684\u6c34\u5e73\u95f4\u8ddd\u3002',
        itemIds: [...itemIds],
        evidence,
        actionIds
      })
    }
  }

  if (containerChipGroupFooterActionRowSpacingPairs.length >= 3) {
    const targetGap = roundMetric(
      median(containerChipGroupFooterActionRowSpacingPairs.map((pair) => pair.gap))
    )
    const offPatternChipGroups = containerChipGroupFooterActionRowSpacingPairs.filter(
      (pair) => Math.abs(pair.gap - targetGap) > SPACING_TOLERANCE_PX
    )

    if (offPatternChipGroups.length > 0) {
      const actionIds: string[] = []
      const itemIds = new Set<string>()
      const evidence: string[] = []

      for (const pair of offPatternChipGroups) {
        for (const row of pair.rows) {
          const actionId = createDesignInspectionId('design-action')
          actions.push({
            id: actionId,
            type: 'distribute-horizontal-spacing',
            title:
              '\u5c06\u5361\u7247\u6309\u94ae\u884c\u4e0a\u65b9\u7684\u591a\u5217\u6807\u7b7e\u7ec4\u7edf\u4e00\u5230\u4e00\u81f4\u7684\u6c34\u5e73\u95f4\u8ddd',
            description:
              '\u8c03\u6574\u540c\u7ea7\u5361\u7247\u6b63\u6587\u540e\u4e14\u5e95\u90e8\u6309\u94ae\u884c\u4e0a\u65b9\u7684\u591a\u5217\u6807\u7b7e\u6587\u672c\uff0c\u4f7f\u6bcf\u4e00\u884c\u5185\u90e8\u7684\u76f8\u90bb\u95f4\u8ddd\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u5e38\u89c1\u7684\u6c34\u5e73\u8282\u594f\u3002',
            executor: 'magicpot-internal',
            targetItemIds: row.map((item) => item.id),
            payload: {
              gap: targetGap,
              anchorItemId: row[0].id
            },
            expectedImpact:
              '\u6309\u94ae\u884c\u4e0a\u65b9\u7684\u591a\u5217\u6807\u7b7e\u7ec4\u4f1a\u56de\u5230\u4e00\u81f4\u7684\u6a2a\u5411\u8282\u594f\uff0c\u4e0d\u518d\u5728\u76f8\u5173\u5361\u7247\u91cc\u5ffd\u758f\u5ffd\u5bc6\u3002'
          })
          actionIds.push(actionId)

          for (const item of row) {
            itemIds.add(item.id)
          }
        }

        evidence.push(
          `${pair.rows
            .map((row) => row.map((item) => item.id).join(', '))
            .join(' / ')} 位于 ${pair.container.id}：标签间距 ${pair.gap}px，目标 ${targetGap}px`
        )
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title:
          '\u5361\u7247\u6309\u94ae\u884c\u4e0a\u65b9\u7684\u591a\u5217\u6807\u7b7e\u7ec4\u6c34\u5e73\u95f4\u8ddd\u4e0d\u4e00\u81f4',
        summary:
          '\u7ed3\u6784\u4f18\u5148\u7684\u5173\u7cfb\u68c0\u67e5\u53d1\u73b0\uff0c\u540c\u7ea7\u5361\u7247\u5728\u5e95\u90e8\u6309\u94ae\u884c\u4e0a\u65b9\u7684\u591a\u5217\u6807\u7b7e\u7ec4\u6ca1\u6709\u4fdd\u6301\u4e00\u81f4\u7684\u6c34\u5e73\u95f4\u8ddd\u3002',
        itemIds: [...itemIds],
        evidence,
        actionIds
      })
    }
  }

  if (containerTrailingBadgeStackSpacingPairs.length >= 3) {
    const targetGap = roundMetric(
      median(containerTrailingBadgeStackSpacingPairs.map((pair) => pair.gap))
    )
    const offPatternTrailingBadgeStacks = containerTrailingBadgeStackSpacingPairs.filter(
      (pair) => Math.abs(pair.gap - targetGap) > SPACING_TOLERANCE_PX
    )

    if (offPatternTrailingBadgeStacks.length > 0) {
      const actionIds: string[] = []

      for (const pair of offPatternTrailingBadgeStacks) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'distribute-vertical-spacing',
          title:
            '\u5c06\u65e0\u9875\u811a\u951a\u70b9\u7684\u5361\u7247\u672b\u5c3e\u6807\u7b7e\u5806\u53e0\u7edf\u4e00\u5230\u4e00\u81f4\u7684\u5782\u76f4\u95f4\u8ddd',
          description:
            '\u8c03\u6574\u6ca1\u6709\u7a33\u5b9a\u9875\u811a\u951a\u70b9\u7684\u5361\u7247\u5c3e\u90e8\u6807\u7b7e\u6587\u672c\uff0c\u4f7f\u5b83\u4eec\u7684\u5782\u76f4\u95f4\u8ddd\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u5e38\u89c1\u7684\u8282\u594f\u3002',
          executor: 'magicpot-internal',
          targetItemIds: pair.items.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: pair.items[0].id
          },
          expectedImpact:
            '\u6ca1\u6709\u9875\u811a\u951a\u70b9\u7684\u5361\u7247\u5c3e\u90e8\u6807\u7b7e\u5806\u53e0\u4f1a\u56de\u5230\u4e00\u81f4\u7684\u7eb5\u5411\u8282\u594f\uff0c\u4e0d\u518d\u5728\u76f8\u5173\u5361\u7247\u91cc\u5ffd\u758f\u5ffd\u5bc6\u3002'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title:
          '\u65e0\u9875\u811a\u951a\u70b9\u7684\u5361\u7247\u672b\u5c3e\u6807\u7b7e\u5806\u53e0\u5782\u76f4\u95f4\u8ddd\u4e0d\u4e00\u81f4',
        summary:
          '\u7ed3\u6784\u4f18\u5148\u7684\u5173\u7cfb\u68c0\u67e5\u53d1\u73b0\uff0c\u540c\u7ea7\u5361\u7247\u5728\u6ca1\u6709\u7a33\u5b9a\u9875\u811a\u951a\u70b9\u65f6\uff0c\u672b\u5c3e\u6807\u7b7e\u5806\u53e0\u6ca1\u6709\u4fdd\u6301\u4e00\u81f4\u7684\u5782\u76f4\u95f4\u8ddd\u3002',
        itemIds: offPatternTrailingBadgeStacks.flatMap((pair) => pair.items.map((item) => item.id)),
        evidence: offPatternTrailingBadgeStacks.map(
          (pair) =>
            `${pair.items.map((item) => item.id).join(', ')} \u4f4d\u4e8e ${pair.container.id}\uff1a\u6807\u7b7e\u95f4\u8ddd ${pair.gap}px\uff0c\u76ee\u6807 ${targetGap}px`
        ),
        actionIds
      })
    }
  }

  if (containerBodyInsetPairs.length >= 3) {
    const targetLeftInset = roundMetric(
      median(containerBodyInsetPairs.map((pair) => pair.leftInset))
    )
    const offPatternLeftInsetPairs = containerBodyInsetPairs.filter(
      (pair) => Math.abs(pair.leftInset - targetLeftInset) > SPACING_TOLERANCE_PX
    )

    if (offPatternLeftInsetPairs.length > 0) {
      const actionIds: string[] = []
      const actionGroups = new Map<number, ContainerBodyInsetPair[]>()

      for (const pair of offPatternLeftInsetPairs) {
        const targetX = roundMetric(pair.container.bounds.x + targetLeftInset)
        const existing = actionGroups.get(targetX)
        if (existing) {
          existing.push(pair)
        } else {
          actionGroups.set(targetX, [pair])
        }
      }

      for (const [targetX, pairs] of actionGroups.entries()) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-left',
          title: '将卡片正文统一到一致的左内边距',
          description:
            '调整各张同级卡片中的正文文本，使它们的左内边距回到结构化几何里最常见的数值。',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.body.id),
          payload: { x: targetX },
          expectedImpact: '卡片正文会回到同一条内部文本列，不再在相关卡片内左右漂移。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: '卡片正文左内边距不一致',
        summary: '结构优先的关系检查发现，同级卡片中的正文文本使用了不同的左内边距。',
        itemIds: offPatternLeftInsetPairs.map((pair) => pair.body.id),
        evidence: offPatternLeftInsetPairs.map(
          (pair) =>
            `${pair.body.id} 位于 ${pair.container.id}：左内边距 ${pair.leftInset}px，目标 ${targetLeftInset}px`
        ),
        actionIds
      })
    }

    const targetVerticalGap = roundMetric(
      median(containerBodyInsetPairs.map((pair) => pair.verticalGap))
    )
    const offPatternVerticalGapPairs = containerBodyInsetPairs.filter(
      (pair) => Math.abs(pair.verticalGap - targetVerticalGap) > SPACING_TOLERANCE_PX
    )

    if (offPatternVerticalGapPairs.length > 0) {
      const actionIds: string[] = []
      const actionGroups = new Map<number, ContainerBodyInsetPair[]>()

      for (const pair of offPatternVerticalGapPairs) {
        const targetY = roundMetric(
          pair.title.bounds.y + pair.title.bounds.height + targetVerticalGap
        )
        const existing = actionGroups.get(targetY)
        if (existing) {
          existing.push(pair)
        } else {
          actionGroups.set(targetY, [pair])
        }
      }

      for (const [targetY, pairs] of actionGroups.entries()) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-top',
          title: '将卡片正文与标题的垂直间距统一',
          description: '调整各张同级卡片中的正文文本，使标题与正文之间的垂直间距回到最常见的节奏。',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.body.id),
          payload: { y: targetY },
          expectedImpact: '卡片内部的标题与正文会回到一致的纵向层级节奏，不再忽远忽近。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: '卡片正文与标题的垂直间距不一致',
        summary: '结构优先的关系检查发现，同级卡片里的标题与正文之间没有保持一致的纵向间距。',
        itemIds: offPatternVerticalGapPairs.map((pair) => pair.body.id),
        evidence: offPatternVerticalGapPairs.map(
          (pair) =>
            `${pair.body.id} 位于 ${pair.container.id}：标题到正文间距 ${pair.verticalGap}px，目标 ${targetVerticalGap}px`
        ),
        actionIds
      })
    }
  }

  if (containerFooterInsetPairs.length >= 3) {
    const targetBottomInset = roundMetric(
      median(containerFooterInsetPairs.map((pair) => pair.bottomInset))
    )
    const offPatternBottomInsetPairs = containerFooterInsetPairs.filter(
      (pair) => Math.abs(pair.bottomInset - targetBottomInset) > SPACING_TOLERANCE_PX
    )

    if (offPatternBottomInsetPairs.length > 0) {
      const actionIds: string[] = []
      const actionGroups = new Map<number, ContainerFooterInsetPair[]>()

      for (const pair of offPatternBottomInsetPairs) {
        const targetBottomY = roundMetric(
          pair.container.bounds.y + pair.container.bounds.height - targetBottomInset
        )
        const existing = actionGroups.get(targetBottomY)
        if (existing) {
          existing.push(pair)
        } else {
          actionGroups.set(targetBottomY, [pair])
        }
      }

      for (const [targetBottomY, pairs] of actionGroups.entries()) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-bottom',
          title: '将卡片页脚统一到一致的下内边距',
          description:
            '调整各张同级卡片中的末尾文本，使它们的下内边距回到结构化几何里最常见的数值。',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.footer.id),
          payload: { y: targetBottomY },
          expectedImpact: '卡片页脚会回到一致的底部留白，不再在相关卡片里忽高忽低。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: '卡片页脚下内边距不一致',
        summary: '结构优先的关系检查发现，同级卡片中的末尾文本使用了不同的下内边距。',
        itemIds: offPatternBottomInsetPairs.map((pair) => pair.footer.id),
        evidence: offPatternBottomInsetPairs.map(
          (pair) =>
            `${pair.footer.id} 位于 ${pair.container.id}：下内边距 ${pair.bottomInset}px，目标 ${targetBottomInset}px`
        ),
        actionIds
      })
    }
  }

  if (containerFooterRowSpacingPairs.length >= 3) {
    const targetGap = roundMetric(median(containerFooterRowSpacingPairs.map((pair) => pair.gap)))
    const offPatternFooterRows = containerFooterRowSpacingPairs.filter(
      (pair) => Math.abs(pair.gap - targetGap) > SPACING_TOLERANCE_PX
    )

    if (offPatternFooterRows.length > 0) {
      const actionIds: string[] = []

      for (const pair of offPatternFooterRows) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'distribute-horizontal-spacing',
          title: '将卡片页脚操作行统一到一致的水平间距',
          description:
            '调整同级卡片页脚操作行中的相邻文本节点，使它们的水平间距回到结构化几何里最常见的节奏。',
          executor: 'magicpot-internal',
          targetItemIds: pair.items.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: pair.items[0].id
          },
          expectedImpact:
            '卡片页脚里的操作文本会回到一致的横向节奏，不再出现某一张卡片按钮过散或过挤的情况。'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: '卡片页脚操作行间距不一致',
        summary:
          '结构优先的关系检查发现，同级卡片页脚操作行中的相邻文本节点没有保持一致的水平间距。',
        itemIds: offPatternFooterRows.flatMap((pair) => pair.items.map((item) => item.id)),
        evidence: offPatternFooterRows.map(
          (pair) =>
            `${pair.container.id}：${pair.items.map((item) => item.id).join(' / ')} 当前间距 ${pair.gap}px，目标 ${targetGap}px`
        ),
        actionIds
      })
    }
  }

  const verticalStack = resolveVerticalStackCandidate(layoutItems)

  if (verticalStack && verticalStack.length >= 2) {
    const anchorLeft = roundMetric(median(verticalStack.map((item) => item.bounds.x)))
    const misalignedItems = verticalStack.filter(
      (item) => Math.abs(item.bounds.x - anchorLeft) > ALIGNMENT_TOLERANCE_PX
    )
    const leftSpread =
      Math.max(...verticalStack.map((item) => item.bounds.x)) -
      Math.min(...verticalStack.map((item) => item.bounds.x))
    const widthCandidates = getWidthNormalizableItems(verticalStack)
    const heightCandidates = getHeightNormalizableItems(verticalStack)
    const targetWidth =
      widthCandidates.length >= 2
        ? roundMetric(median(widthCandidates.map((item) => item.bounds.width)))
        : null
    const offPatternWidthItems =
      typeof targetWidth === 'number'
        ? widthCandidates.filter(
            (item) => Math.abs(item.bounds.width - targetWidth) > WIDTH_TOLERANCE_PX
          )
        : []
    const currentRightEdges = verticalStack.map((item) =>
      roundMetric(item.bounds.x + item.bounds.width)
    )
    const effectiveRightEdges = verticalStack.map((item) =>
      roundMetric(
        item.bounds.x +
          (offPatternWidthItems.some((candidate) => candidate.id === item.id)
            ? (targetWidth ?? item.bounds.width)
            : item.bounds.width)
      )
    )
    const anchorRight = roundMetric(median(effectiveRightEdges))
    const rightAlignedItems = verticalStack.filter((item) => {
      const effectiveRight = roundMetric(
        item.bounds.x +
          (offPatternWidthItems.some((candidate) => candidate.id === item.id)
            ? (targetWidth ?? item.bounds.width)
            : item.bounds.width)
      )
      return Math.abs(effectiveRight - anchorRight) > ALIGNMENT_TOLERANCE_PX
    })
    const rightSpread = Math.max(...currentRightEdges) - Math.min(...currentRightEdges)
    const effectiveCenterXs = verticalStack.map((item) =>
      roundMetric(
        item.bounds.x +
          (offPatternWidthItems.some((candidate) => candidate.id === item.id)
            ? (targetWidth ?? item.bounds.width)
            : item.bounds.width) /
            2
      )
    )
    const anchorCenterX = roundMetric(median(effectiveCenterXs))
    const centerAlignedItems = verticalStack.filter((item) => {
      const effectiveCenterX = roundMetric(
        item.bounds.x +
          (offPatternWidthItems.some((candidate) => candidate.id === item.id)
            ? (targetWidth ?? item.bounds.width)
            : item.bounds.width) /
            2
      )
      return Math.abs(effectiveCenterX - anchorCenterX) > ALIGNMENT_TOLERANCE_PX
    })
    const centerSpread = Math.max(...effectiveCenterXs) - Math.min(...effectiveCenterXs)
    const preferRightAlignment =
      rightAlignedItems.length > 0 && rightSpread + ALIGNMENT_TOLERANCE_PX < leftSpread
    const preferCenterAlignment =
      centerAlignedItems.length > 0 &&
      centerSpread + ALIGNMENT_TOLERANCE_PX < Math.min(leftSpread, rightSpread)

    if (preferCenterAlignment) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'align-center',
        title: '将纵向堆叠统一到同一中心线',
        description: '将所选纵向堆叠吸附到结构化边界已经隐含出的共同中心线上。',
        executor: 'magicpot-internal',
        targetItemIds: centerAlignedItems.map((item) => item.id),
        payload: { centerX: anchorCenterX },
        expectedImpact: '这一列会更像围绕同一轴线组织的编排，而不是在共享中心线附近左右漂移。'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: '所选纵向堆叠未按中心线对齐',
        summary: '结构化几何显示，看起来属于同一纵向组的元素偏离了共同中心线。',
        itemIds: centerAlignedItems.map((item) => item.id),
        evidence: centerAlignedItems.map((item) => {
          const effectiveWidth = offPatternWidthItems.some((candidate) => candidate.id === item.id)
            ? (targetWidth ?? item.bounds.width)
            : item.bounds.width
          return `${item.id}：中心线 ${roundMetric(item.bounds.x + effectiveWidth / 2)}px，目标 ${anchorCenterX}px`
        }),
        actionIds: [actionId]
      })
    } else if (!preferRightAlignment && misalignedItems.length > 0) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'align-left',
        title: '将纵向堆叠统一到同一左边缘',
        description: '将所选纵向堆叠吸附到结构化边界已经隐含出的共同左边缘。',
        executor: 'magicpot-internal',
        targetItemIds: misalignedItems.map((item) => item.id),
        payload: { x: anchorLeft },
        expectedImpact: '这一列会更像清晰的纵向编排，而不是左右漂移的一组块。'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: '所选纵向堆叠左边缘不一致',
        summary: '结构化几何显示，看起来属于同一纵向组的元素拥有不同的左边缘。',
        itemIds: misalignedItems.map((item) => item.id),
        evidence: misalignedItems.map(
          (item) => `${item.id}：左边缘 ${roundMetric(item.bounds.x)}px，目标 ${anchorLeft}px`
        ),
        actionIds: [actionId]
      })
    }

    if (typeof targetWidth === 'number' && offPatternWidthItems.length > 0) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'normalize-item-width',
        title: '统一纵向堆叠中的卡片宽度',
        description: '调整偏离主样式的块级元素宽度，使这组纵向堆叠回到结构化几何里最常见的宽度。',
        executor: 'magicpot-internal',
        targetItemIds: offPatternWidthItems.map((item) => item.id),
        payload: {
          width: targetWidth
        },
        expectedImpact: '这一列会更像统一的卡片列，而不是混用不同块宽。'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'geometry',
        severity: 'warning',
        title: '所选纵向堆叠中的块宽度不一致',
        summary: '结构优先几何自动化发现，同一纵向堆叠中的块级元素使用了明显不同的宽度。',
        itemIds: offPatternWidthItems.map((item) => item.id),
        evidence: offPatternWidthItems.map(
          (item) => `${item.id}：宽度 ${roundMetric(item.bounds.width)}px，目标 ${targetWidth}px`
        ),
        actionIds: [actionId]
      })
    }

    if (heightCandidates.length >= 2) {
      const targetHeight = roundMetric(median(heightCandidates.map((item) => item.bounds.height)))
      const offPatternHeightItems = heightCandidates.filter(
        (item) => Math.abs(item.bounds.height - targetHeight) > HEIGHT_TOLERANCE_PX
      )

      if (offPatternHeightItems.length > 0) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'normalize-item-height',
          title: '统一纵向堆叠中的卡片高度',
          description: '调整偏离主样式的块级元素高度，使这组纵向堆叠回到结构化几何里最常见的高度。',
          executor: 'magicpot-internal',
          targetItemIds: offPatternHeightItems.map((item) => item.id),
          payload: {
            height: targetHeight
          },
          expectedImpact: '这一列会更像统一的卡片列，而不是混用不同块高。'
        })
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'geometry',
          severity: 'warning',
          title: '所选纵向堆叠中的块高度不一致',
          summary: '结构优先几何自动化发现，同一纵向堆叠中的块级元素使用了明显不同的高度。',
          itemIds: offPatternHeightItems.map((item) => item.id),
          evidence: offPatternHeightItems.map(
            (item) =>
              `${item.id}：高度 ${roundMetric(item.bounds.height)}px，目标 ${targetHeight}px`
          ),
          actionIds: [actionId]
        })
      }
    }

    if (!preferCenterAlignment && preferRightAlignment) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'align-right',
        title: '将纵向堆叠统一到同一右边缘',
        description: '将所选纵向堆叠吸附到结构化边界已经隐含出的共同右边缘。',
        executor: 'magicpot-internal',
        targetItemIds: rightAlignedItems.map((item) => item.id),
        payload: { x: anchorRight },
        expectedImpact: '这一列会更像明确的右对齐编排，而不是在右边缘附近漂移。'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: '所选纵向堆叠右边缘不一致',
        summary: '结构化几何显示，看起来属于同一纵向组的元素拥有不同的右边缘。',
        itemIds: rightAlignedItems.map((item) => item.id),
        evidence: rightAlignedItems.map(
          (item) =>
            `${item.id}：右边缘 ${roundMetric(item.bounds.x + item.bounds.width)}px，目标 ${anchorRight}px`
        ),
        actionIds: [actionId]
      })
    }

    if (verticalStack.length >= 3) {
      const gaps = verticalStack.slice(0, -1).map((item, index) => {
        const next = verticalStack[index + 1]
        return roundMetric(next.bounds.y - (item.bounds.y + item.bounds.height))
      })
      const gapDelta = gaps.length > 0 ? Math.max(...gaps) - Math.min(...gaps) : 0

      if (gaps.length >= 2 && gapDelta > SPACING_TOLERANCE_PX) {
        const targetGap = roundMetric(median(gaps))
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'distribute-vertical-spacing',
          title: '统一纵向堆叠的垂直间距',
          description: '重新分配所选纵向堆叠，使相邻元素间距回到这一列里最常见的节奏。',
          executor: 'magicpot-internal',
          targetItemIds: verticalStack.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: verticalStack[0].id
          },
          expectedImpact: '纵向间距会更有节奏，也更容易快速扫读。'
        })
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'spacing',
          severity: 'warning',
          title: '纵向间距不一致',
          summary: '结构化几何显示，同一纵向堆叠内相邻元素之间的垂直间距并不均匀。',
          itemIds: verticalStack.map((item) => item.id),
          evidence: gaps.map(
            (gap, index) => `${verticalStack[index].id} -> ${verticalStack[index + 1].id}：${gap}px`
          ),
          actionIds: [actionId]
        })
      }
    }
  }

  const grid = verticalStack ? null : resolveGridCandidate(layoutItems)

  if (grid && grid.length === 4) {
    const sizeCandidates = getWidthNormalizableItems(grid)
    const targetWidth = roundMetric(median(sizeCandidates.map((item) => item.bounds.width)))
    const targetHeight = roundMetric(median(sizeCandidates.map((item) => item.bounds.height)))
    const offPatternSizeItems = sizeCandidates.filter(
      (item) =>
        Math.abs(item.bounds.width - targetWidth) > WIDTH_TOLERANCE_PX ||
        Math.abs(item.bounds.height - targetHeight) > HEIGHT_TOLERANCE_PX
    )

    if (sizeCandidates.length >= 4 && offPatternSizeItems.length > 0) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'normalize-item-size',
        title: '统一所选网格中的卡片尺寸',
        description: '调整偏离主样式的网格项尺寸，使整个选区回到结构化几何里最常见的卡片大小。',
        executor: 'magicpot-internal',
        targetItemIds: offPatternSizeItems.map((item) => item.id),
        payload: {
          width: targetWidth,
          height: targetHeight
        },
        expectedImpact: '网格会更像一个有意图的等尺寸卡片矩阵，而不是混用多种规格。'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'geometry',
        severity: 'warning',
        title: '网格项尺寸不一致',
        summary: '结构优先几何自动化发现，这个 2x2 卡片网格里存在明显不同的宽度或高度。',
        itemIds: offPatternSizeItems.map((item) => item.id),
        evidence: offPatternSizeItems.map(
          (item) =>
            `${item.id}：${roundMetric(item.bounds.width)}x${roundMetric(item.bounds.height)}，目标 ${targetWidth}x${targetHeight}`
        ),
        actionIds: [actionId]
      })
    }

    if (sizeCandidates.length >= 4) {
      const [topLeft, topRight, bottomLeft, bottomRight] = grid
      const gridColumns = [
        { label: '左侧网格列', items: [topLeft, bottomLeft] },
        { label: '右侧网格列', items: [topRight, bottomRight] }
      ]
      const gridRows = [
        { label: '顶部网格行', items: [topLeft, topRight] },
        { label: '底部网格行', items: [bottomLeft, bottomRight] }
      ]
      const offPatternSizeItemIds = new Set(offPatternSizeItems.map((item) => item.id))
      const resolveEffectiveGridWidth = (item: DesignInspectionItemSummary): number =>
        offPatternSizeItemIds.has(item.id) ? targetWidth : item.bounds.width
      const resolveEffectiveGridHeight = (item: DesignInspectionItemSummary): number =>
        offPatternSizeItemIds.has(item.id) ? targetHeight : item.bounds.height

      const centerAlignedActionIds: string[] = []
      const centerAlignedItemIds = new Set<string>()
      const centerAlignedEvidence: string[] = []

      for (const column of gridColumns) {
        const targetCenterX = roundMetric(
          median(column.items.map((item) => item.bounds.x)) + targetWidth / 2
        )
        const misalignedItems = column.items.filter((item) => {
          const currentCenterX = roundMetric(item.bounds.x + resolveEffectiveGridWidth(item) / 2)
          return Math.abs(currentCenterX - targetCenterX) > ALIGNMENT_TOLERANCE_PX
        })

        if (misalignedItems.length === 0) continue

        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-center',
          title: `将${column.label}统一到同一中心线`,
          description:
            '重新居中偏离主样式的网格项，使这一列基于隐含的网格 x 位置和主导卡片宽度共享同一中心线。',
          executor: 'magicpot-internal',
          targetItemIds: misalignedItems.map((item) => item.id),
          payload: {
            centerX: targetCenterX
          },
          expectedImpact: '网格列会更像明确的垂直轨道，而不是中心线彼此漂移。'
        })
        centerAlignedActionIds.push(actionId)
        for (const item of misalignedItems) {
          centerAlignedItemIds.add(item.id)
          centerAlignedEvidence.push(
            `${item.id}：中心线 ${roundMetric(item.bounds.x + resolveEffectiveGridWidth(item) / 2)}px，目标 ${targetCenterX}px`
          )
        }
      }

      if (centerAlignedActionIds.length > 0) {
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'alignment',
          severity: 'warning',
          title: '网格列未按中心线对齐',
          summary: '结构优先几何自动化发现，这个 2x2 网格的列中心线偏离了隐含的网格轨道。',
          itemIds: [...centerAlignedItemIds],
          evidence: centerAlignedEvidence,
          actionIds: centerAlignedActionIds
        })
      }

      const middleAlignedActionIds: string[] = []
      const middleAlignedItemIds = new Set<string>()
      const middleAlignedEvidence: string[] = []

      for (const row of gridRows) {
        const targetCenterY = roundMetric(
          median(row.items.map((item) => item.bounds.y)) + targetHeight / 2
        )
        const misalignedItems = row.items.filter((item) => {
          const currentCenterY = roundMetric(item.bounds.y + resolveEffectiveGridHeight(item) / 2)
          return Math.abs(currentCenterY - targetCenterY) > ALIGNMENT_TOLERANCE_PX
        })

        if (misalignedItems.length === 0) continue

        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-middle',
          title: `将${row.label}统一到同一中线`,
          description:
            '重新居中偏离主样式的网格项，使这一行基于隐含的网格 y 位置和主导卡片高度共享同一中线。',
          executor: 'magicpot-internal',
          targetItemIds: misalignedItems.map((item) => item.id),
          payload: {
            centerY: targetCenterY
          },
          expectedImpact: '网格行会更像明确的水平轨道，而不是中线彼此漂移。'
        })
        middleAlignedActionIds.push(actionId)
        for (const item of misalignedItems) {
          middleAlignedItemIds.add(item.id)
          middleAlignedEvidence.push(
            `${item.id}：中线 ${roundMetric(item.bounds.y + resolveEffectiveGridHeight(item) / 2)}px，目标 ${targetCenterY}px`
          )
        }
      }

      if (middleAlignedActionIds.length > 0) {
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'alignment',
          severity: 'warning',
          title: '网格行未按中线对齐',
          summary: '结构优先几何自动化发现，这个 2x2 网格的行中线偏离了隐含的网格轨道。',
          itemIds: [...middleAlignedItemIds],
          evidence: middleAlignedEvidence,
          actionIds: middleAlignedActionIds
        })
      }
    }
  }

  const twoByThreeGrid = verticalStack || grid ? null : resolveTwoByThreeGridCandidate(layoutItems)

  if (twoByThreeGrid) {
    const gridItems = twoByThreeGrid.flat()
    const widthSpread =
      Math.max(...gridItems.map((item) => item.bounds.width)) -
      Math.min(...gridItems.map((item) => item.bounds.width))
    const heightSpread =
      Math.max(...gridItems.map((item) => item.bounds.height)) -
      Math.min(...gridItems.map((item) => item.bounds.height))

    if (widthSpread <= WIDTH_TOLERANCE_PX && heightSpread <= HEIGHT_TOLERANCE_PX) {
      const gridRows: GridTwoByThreeRowSpacingPair[] = twoByThreeGrid.map((row, index) => {
        const gaps = row
          .slice(1)
          .map((item, gapIndex) =>
            roundMetric(
              row[gapIndex + 1].bounds.x - (row[gapIndex].bounds.x + row[gapIndex].bounds.width)
            )
          )

        return {
          label:
            index === 0
              ? '\u9876\u90e8 2x3 \u7f51\u683c\u884c'
              : '\u5e95\u90e8 2x3 \u7f51\u683c\u884c',
          items: row,
          gap: roundMetric(median(gaps)),
          gapSpread: roundMetric(Math.max(...gaps) - Math.min(...gaps)),
          gaps,
          index
        }
      })

      const dominantRow = [...gridRows].sort((left, right) => {
        if (left.gapSpread !== right.gapSpread) {
          return left.gapSpread - right.gapSpread
        }
        return left.index - right.index
      })[0]

      if (dominantRow && dominantRow.gapSpread <= SPACING_TOLERANCE_PX) {
        const targetGap = dominantRow.gap
        const offPatternRows = gridRows.filter(
          (row) =>
            row.index !== dominantRow.index &&
            (row.gapSpread > SPACING_TOLERANCE_PX ||
              row.gaps.some((gap) => Math.abs(gap - targetGap) > SPACING_TOLERANCE_PX))
        )

        if (offPatternRows.length > 0) {
          const actionIds: string[] = []
          const itemIds = new Set<string>()
          const evidence: string[] = []

          for (const row of offPatternRows) {
            const actionId = createDesignInspectionId('design-action')
            actions.push({
              id: actionId,
              type: 'distribute-horizontal-spacing',
              title:
                '\u5c06 2x3 \u7f51\u683c\u7edf\u4e00\u5230\u4e00\u81f4\u7684\u6c34\u5e73\u95f4\u8ddd',
              description:
                '\u8c03\u6574\u504f\u79bb\u4e3b\u8282\u594f\u7684 2x3 \u7f51\u683c\u884c\uff0c\u4f7f\u8fd9\u4e00\u884c\u5185\u90e8\u7684\u5217\u95f4\u8ddd\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u5e38\u89c1\u7684\u6c34\u5e73\u8282\u594f\u3002',
              executor: 'magicpot-internal',
              targetItemIds: row.items.map((item) => item.id),
              payload: {
                gap: targetGap,
                anchorItemId: row.items[0].id
              },
              expectedImpact:
                '\u8fd9\u7ec4 2x3 \u7f51\u683c\u4f1a\u56de\u5230\u66f4\u7a33\u5b9a\u7684\u5217\u95f4\u8ddd\u8282\u594f\uff0c\u800c\u4e0d\u662f\u67d0\u4e00\u884c\u88ab\u538b\u7f29\u6216\u62c9\u4f38\u3002'
            })
            actionIds.push(actionId)

            for (const item of row.items) {
              itemIds.add(item.id)
            }

            evidence.push(
              `${row.label}\uff1a\u76f8\u90bb\u95f4\u8ddd ${row.gaps.join(' / ')}px\uff0c\u76ee\u6807 ${targetGap}px`
            )
          }

          issues.push({
            id: createDesignInspectionId('design-issue'),
            category: 'spacing',
            severity: 'warning',
            title: '2x3 \u7f51\u683c\u884c\u5185\u5217\u95f4\u8ddd\u4e0d\u4e00\u81f4',
            summary:
              '\u7ed3\u6784\u4f18\u5148\u7684\u51e0\u4f55\u68c0\u67e5\u53d1\u73b0\uff0c\u8fd9\u4e2a 2x3 \u7f51\u683c\u4e2d\u81f3\u5c11\u6709\u4e00\u884c\u7684\u5185\u90e8\u5217\u95f4\u8ddd\u504f\u79bb\u4e86\u53e6\u4e00\u884c\u5df2\u7ecf\u5efa\u7acb\u7684\u4e3b\u8282\u594f\u3002',
            itemIds: [...itemIds],
            evidence,
            actionIds
          })
        }
      }
    }
  }

  const threeColumnMatrix =
    verticalStack || grid || twoByThreeGrid
      ? null
      : resolveThreeColumnMultiRowMatrixCandidate(layoutItems)

  if (threeColumnMatrix) {
    const columnLabels = [
      '\u5de6\u4fa7\u77e9\u9635\u5217',
      '\u4e2d\u95f4\u77e9\u9635\u5217',
      '\u53f3\u4fa7\u77e9\u9635\u5217'
    ]
    const columnCenterTargets = threeColumnMatrix.columns.map((column) =>
      roundMetric(median(column.map((item) => item.bounds.x + item.bounds.width / 2)))
    )
    const matrixRows: ThreeColumnMatrixRowSpacingPair[] = threeColumnMatrix.rows.map(
      (row, index) => {
        const gaps = row
          .slice(1)
          .map((item, gapIndex) =>
            roundMetric(
              row[gapIndex + 1].bounds.x - (row[gapIndex].bounds.x + row[gapIndex].bounds.width)
            )
          )
        const anchorCenterX = roundMetric(row[0].bounds.x + row[0].bounds.width / 2)

        return {
          label: `\u7b2c ${index + 1} \u884c\u4e09\u5217\u77e9\u9635`,
          items: row,
          top: roundMetric(median(row.map((item) => item.bounds.y))),
          gap: roundMetric(median(gaps)),
          gapSpread: roundMetric(Math.max(...gaps) - Math.min(...gaps)),
          gaps,
          index,
          anchorAligned: Math.abs(anchorCenterX - columnCenterTargets[0]) <= ALIGNMENT_TOLERANCE_PX
        }
      }
    )
    const stableMatrixRows = matrixRows.filter(
      (row) => row.anchorAligned && row.gapSpread <= SPACING_TOLERANCE_PX
    )
    const suppressedCenterlineItemIds = new Set<string>()
    const matrixRowRhythmTransitions: ThreeColumnMatrixRowRhythmTransition[] = matrixRows
      .slice(1)
      .map((row, index) => {
        const previousRow = matrixRows[index]
        const gaps = row.items.map((item, columnIndex) =>
          roundMetric(
            item.bounds.y -
              (previousRow.items[columnIndex].bounds.y +
                previousRow.items[columnIndex].bounds.height)
          )
        )

        return {
          label: row.label,
          items: row.items,
          top: row.top,
          topGap: roundMetric(row.top - previousRow.top),
          gap: roundMetric(median(gaps)),
          gapSpread: roundMetric(Math.max(...gaps) - Math.min(...gaps)),
          gaps,
          index: row.index
        }
      })

    const dominantMatrixRowRhythm = matrixRowRhythmTransitions
      .filter((transition) => transition.gapSpread <= SPACING_TOLERANCE_PX)
      .map((transition) => ({
        transition,
        matchingTransitions: matrixRowRhythmTransitions.filter(
          (candidate) =>
            candidate.gapSpread <= SPACING_TOLERANCE_PX &&
            Math.abs(candidate.topGap - transition.topGap) <= ALIGNMENT_TOLERANCE_PX &&
            Math.abs(candidate.gap - transition.gap) <= SPACING_TOLERANCE_PX
        )
      }))
      .sort((left, right) => {
        if (right.matchingTransitions.length !== left.matchingTransitions.length) {
          return right.matchingTransitions.length - left.matchingTransitions.length
        }
        if (left.transition.gapSpread !== right.transition.gapSpread) {
          return left.transition.gapSpread - right.transition.gapSpread
        }
        return left.transition.index - right.transition.index
      })[0]

    if (dominantMatrixRowRhythm && dominantMatrixRowRhythm.matchingTransitions.length >= 2) {
      const targetTopGap = roundMetric(
        median(dominantMatrixRowRhythm.matchingTransitions.map((transition) => transition.topGap))
      )
      const dominantAnchor = matrixRows
        .map((row) => {
          const anchorTop = roundMetric(row.top - row.index * targetTopGap)
          const matchingRows = matrixRows.filter(
            (candidate) =>
              Math.abs(candidate.top - (anchorTop + candidate.index * targetTopGap)) <=
              ALIGNMENT_TOLERANCE_PX
          )
          const totalError = roundMetric(
            matrixRows.reduce(
              (sum, candidate) =>
                sum + Math.abs(candidate.top - (anchorTop + candidate.index * targetTopGap)),
              0
            )
          )

          return {
            anchorTop,
            matchingRows,
            totalError,
            index: row.index
          }
        })
        .sort((left, right) => {
          if (right.matchingRows.length !== left.matchingRows.length) {
            return right.matchingRows.length - left.matchingRows.length
          }
          if (left.totalError !== right.totalError) {
            return left.totalError - right.totalError
          }
          return left.index - right.index
        })[0]

      if (dominantAnchor && dominantAnchor.matchingRows.length >= 3) {
        const offPatternRows = matrixRows.filter(
          (row) =>
            !dominantAnchor.matchingRows.some((candidate) => candidate.index === row.index) &&
            Math.abs(row.top - (dominantAnchor.anchorTop + row.index * targetTopGap)) >
              ALIGNMENT_TOLERANCE_PX
        )

        if (offPatternRows.length > 0) {
          const actionIds: string[] = []
          const itemIds = new Set<string>()
          const evidence: string[] = []

          for (const row of offPatternRows) {
            const targetY = roundMetric(dominantAnchor.anchorTop + row.index * targetTopGap)
            const transition = matrixRowRhythmTransitions.find(
              (candidate) => candidate.index === row.index
            )
            const actionId = createDesignInspectionId('design-action')
            actions.push({
              id: actionId,
              type: 'align-top',
              title:
                '\u5c06\u4e09\u5217\u591a\u884c\u77e9\u9635\u7edf\u4e00\u5230\u4e00\u81f4\u7684\u7eb5\u5411\u8282\u594f',
              description:
                '\u8c03\u6574\u504f\u79bb\u4e3b\u8282\u594f\u7684\u4e09\u5217\u591a\u884c\u77e9\u9635\u884c\uff0c\u4f7f\u8fd9\u4e00\u884c\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u5e38\u89c1\u7684\u7eb5\u5411\u8282\u594f\u3002',
              executor: 'magicpot-internal',
              targetItemIds: row.items.map((item) => item.id),
              payload: { y: targetY },
              expectedImpact:
                '\u8fd9\u4e2a\u4e09\u5217\u77e9\u9635\u4f1a\u56de\u5230\u66f4\u7a33\u5b9a\u7684\u884c\u95f4\u8282\u594f\uff0c\u800c\u4e0d\u662f\u5c11\u6570\u6574\u884c\u5728\u7eb5\u5411\u4e0a\u6f02\u79fb\u3002'
            })
            actionIds.push(actionId)

            for (const item of row.items) {
              itemIds.add(item.id)
            }

            evidence.push(
              `${row.label}\uff1a\u9876\u90e8 y=${row.top}px\uff0c\u76ee\u6807 ${targetY}px\uff0c` +
                ` \u5f53\u524d\u884c\u95f4\u8ddd ${transition?.gaps.join(' / ') || '\u2014'}px\uff0c` +
                ` \u76ee\u6807\u8282\u594f ${dominantMatrixRowRhythm.transition.gap}px`
            )
          }

          issues.push({
            id: createDesignInspectionId('design-issue'),
            category: 'spacing',
            severity: 'warning',
            title:
              '\u4e09\u5217\u591a\u884c\u77e9\u9635\u7684\u7eb5\u5411\u8282\u594f\u4e0d\u4e00\u81f4',
            summary:
              '\u7ed3\u6784\u4f18\u5148\u7684\u51e0\u4f55\u68c0\u67e5\u53d1\u73b0\uff0c\u8fd9\u4e2a\u4e09\u5217\u591a\u884c\u5757\u77e9\u9635\u91cc\u5c11\u6570\u6574\u884c\u504f\u79bb\u4e86\u5176\u4ed6\u884c\u5df2\u7ecf\u5efa\u7acb\u7684\u4e3b\u7eb5\u5411\u8282\u594f\u3002',
            itemIds: [...itemIds],
            evidence,
            actionIds
          })
        }
      }
    }

    const dominantMatrixRow = stableMatrixRows
      .map((row) => ({
        row,
        matchingRows: stableMatrixRows.filter(
          (candidate) => Math.abs(candidate.gap - row.gap) <= SPACING_TOLERANCE_PX
        )
      }))
      .sort((left, right) => {
        if (right.matchingRows.length !== left.matchingRows.length) {
          return right.matchingRows.length - left.matchingRows.length
        }
        if (left.row.gapSpread !== right.row.gapSpread) {
          return left.row.gapSpread - right.row.gapSpread
        }
        return left.row.index - right.row.index
      })[0]

    if (dominantMatrixRow && dominantMatrixRow.matchingRows.length >= 2) {
      const targetGap = roundMetric(median(dominantMatrixRow.matchingRows.map((row) => row.gap)))
      const offPatternRows = matrixRows.filter((row) => {
        if (!row.anchorAligned) return false
        if (dominantMatrixRow.matchingRows.some((candidate) => candidate.index === row.index)) {
          return false
        }
        return (
          row.gapSpread > SPACING_TOLERANCE_PX ||
          row.gaps.some((gap) => Math.abs(gap - targetGap) > SPACING_TOLERANCE_PX)
        )
      })

      if (offPatternRows.length > 0) {
        const actionIds: string[] = []
        const itemIds = new Set<string>()
        const evidence: string[] = []

        for (const row of offPatternRows) {
          const actionId = createDesignInspectionId('design-action')
          actions.push({
            id: actionId,
            type: 'distribute-horizontal-spacing',
            title:
              '\u5c06\u4e09\u5217\u591a\u884c\u77e9\u9635\u7edf\u4e00\u5230\u4e00\u81f4\u7684\u6c34\u5e73\u95f4\u8ddd',
            description:
              '\u8c03\u6574\u504f\u79bb\u4e3b\u8282\u594f\u7684\u4e09\u5217\u591a\u884c\u77e9\u9635\u884c\uff0c\u4f7f\u8fd9\u4e00\u884c\u5185\u90e8\u7684\u5217\u95f4\u8ddd\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u5e38\u89c1\u7684\u6c34\u5e73\u8282\u594f\u3002',
            executor: 'magicpot-internal',
            targetItemIds: row.items.map((item) => item.id),
            payload: {
              gap: targetGap,
              anchorItemId: row.items[0].id
            },
            expectedImpact:
              '\u8fd9\u4e2a\u4e09\u5217\u77e9\u9635\u4f1a\u56de\u5230\u66f4\u7a33\u5b9a\u7684\u5217\u95f4\u8ddd\u8282\u594f\uff0c\u800c\u4e0d\u662f\u67d0\u4e00\u884c\u88ab\u538b\u7f29\u6216\u62c9\u4f38\u3002'
          })
          actionIds.push(actionId)

          for (const item of row.items) {
            itemIds.add(item.id)
            suppressedCenterlineItemIds.add(item.id)
          }

          evidence.push(
            `${row.label}\uff1a\u76f8\u90bb\u95f4\u8ddd ${row.gaps.join(' / ')}px\uff0c\u76ee\u6807 ${targetGap}px`
          )
        }

        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'spacing',
          severity: 'warning',
          title:
            '\u4e09\u5217\u591a\u884c\u77e9\u9635\u7684\u884c\u5185\u5217\u95f4\u8ddd\u4e0d\u4e00\u81f4',
          summary:
            '\u7ed3\u6784\u4f18\u5148\u7684\u51e0\u4f55\u68c0\u67e5\u53d1\u73b0\uff0c\u8fd9\u4e2a\u4e09\u5217\u591a\u884c\u5757\u77e9\u9635\u4e2d\u81f3\u5c11\u6709\u4e00\u884c\u7684\u5185\u90e8\u5217\u95f4\u8ddd\u504f\u79bb\u4e86\u5176\u4ed6\u884c\u5df2\u7ecf\u5efa\u7acb\u7684\u4e3b\u8282\u594f\u3002',
          itemIds: [...itemIds],
          evidence,
          actionIds
        })
      }
    }

    const centerlineActionIds: string[] = []
    const centerlineItemIds = new Set<string>()
    const centerlineEvidence: string[] = []

    for (const [columnIndex, column] of threeColumnMatrix.columns.entries()) {
      const targetCenterX = columnCenterTargets[columnIndex]
      const misalignedItems = column.filter((item) => {
        if (suppressedCenterlineItemIds.has(item.id)) return false
        const currentCenterX = roundMetric(item.bounds.x + item.bounds.width / 2)
        return Math.abs(currentCenterX - targetCenterX) > ALIGNMENT_TOLERANCE_PX
      })

      if (misalignedItems.length === 0 || column.length - misalignedItems.length < 2) continue

      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'align-center',
        title: `${columnLabels[columnIndex]}\u7edf\u4e00\u5230\u540c\u4e00\u4e2d\u5fc3\u7ebf`,
        description:
          '\u91cd\u65b0\u5c45\u4e2d\u4e09\u5217\u591a\u884c\u77e9\u9635\u4e2d\u504f\u79bb\u5217\u8f68\u9053\u7684\u5757\u5143\u7d20\uff0c\u4f7f\u6bcf\u4e00\u5217\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u5e38\u89c1\u7684 x \u5411\u4e2d\u5fc3\u7ebf\u3002',
        executor: 'magicpot-internal',
        targetItemIds: misalignedItems.map((item) => item.id),
        payload: {
          centerX: targetCenterX
        },
        expectedImpact:
          '\u8fd9\u4e2a\u4e09\u5217\u77e9\u9635\u4f1a\u56de\u5230\u66f4\u660e\u786e\u7684\u5217\u8f68\u9053\uff0c\u800c\u4e0d\u662f\u67d0\u4e9b\u5355\u5143\u683c\u5728\u6a2a\u5411\u4e0a\u60c5\u6027\u6f02\u79fb\u3002'
      })
      centerlineActionIds.push(actionId)

      for (const item of misalignedItems) {
        centerlineItemIds.add(item.id)
        centerlineEvidence.push(
          `${item.id} \u4f4d\u4e8e ${columnLabels[columnIndex]}\uff1a\u4e2d\u5fc3\u7ebf ${roundMetric(
            item.bounds.x + item.bounds.width / 2
          )}px\uff0c\u76ee\u6807 ${targetCenterX}px`
        )
      }
    }

    if (centerlineActionIds.length > 0) {
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: '\u4e09\u5217\u77e9\u9635\u7684\u5217\u4e2d\u5fc3\u7ebf\u4e0d\u4e00\u81f4',
        summary:
          '\u7ed3\u6784\u4f18\u5148\u7684\u51e0\u4f55\u68c0\u67e5\u53d1\u73b0\uff0c\u8fd9\u4e2a\u4e09\u5217\u591a\u884c\u5757\u77e9\u9635\u91cc\u7684\u67d0\u4e9b\u5355\u5143\u683c\u504f\u79bb\u4e86\u5404\u81ea\u6240\u5c5e\u7684\u5217\u4e2d\u5fc3\u7ebf\u3002',
        itemIds: [...centerlineItemIds],
        evidence: centerlineEvidence,
        actionIds: centerlineActionIds
      })
    }
  }

  const threeColumnMatrixGraph =
    verticalStack || grid || twoByThreeGrid || threeColumnMatrix
      ? null
      : resolveThreeColumnMultiRowMatrixGraphCandidate(layoutItems)

  if (threeColumnMatrixGraph) {
    const columnLabels = [
      '\u5de6\u4fa7\u53d8\u5bbd\u77e9\u9635\u5217',
      '\u4e2d\u95f4\u53d8\u5bbd\u77e9\u9635\u5217',
      '\u53f3\u4fa7\u53d8\u5bbd\u77e9\u9635\u5217'
    ]
    const rowShiftActionIds: string[] = []
    const rowShiftItemIds = new Set<string>()
    const rowShiftEvidence: string[] = []
    const suppressedGraphItemIds = new Set<string>()
    const leftActionIds: string[] = []
    const leftItemIds = new Set<string>()
    const leftEvidence: string[] = []
    const centerActionIds: string[] = []
    const centerItemIds = new Set<string>()
    const centerEvidence: string[] = []
    const rightActionIds: string[] = []
    const rightItemIds = new Set<string>()
    const rightEvidence: string[] = []

    const columnStats = threeColumnMatrixGraph.columns.map((column, columnIndex) => {
      const targetLeftX = roundMetric(median(column.map((item) => item.bounds.x)))
      const targetCenterX = roundMetric(
        median(column.map((item) => item.bounds.x + item.bounds.width / 2))
      )
      const targetRightX = roundMetric(
        median(column.map((item) => item.bounds.x + item.bounds.width))
      )
      const leftError = roundMetric(
        column.reduce((sum, item) => sum + Math.abs(item.bounds.x - targetLeftX), 0)
      )
      const centerError = roundMetric(
        column.reduce(
          (sum, item) => sum + Math.abs(item.bounds.x + item.bounds.width / 2 - targetCenterX),
          0
        )
      )
      const rightError = roundMetric(
        column.reduce(
          (sum, item) => sum + Math.abs(item.bounds.x + item.bounds.width - targetRightX),
          0
        )
      )
      const leftMisalignedItems = column.filter(
        (item) => Math.abs(item.bounds.x - targetLeftX) > ALIGNMENT_TOLERANCE_PX
      )
      const rightMisalignedItems = column.filter(
        (item) =>
          Math.abs(item.bounds.x + item.bounds.width - targetRightX) > ALIGNMENT_TOLERANCE_PX
      )
      const centerMisalignedItems = column.filter((item) => {
        const currentCenterX = roundMetric(item.bounds.x + item.bounds.width / 2)
        return Math.abs(currentCenterX - targetCenterX) > ALIGNMENT_TOLERANCE_PX
      })
      const leftAlignedCount = column.length - leftMisalignedItems.length
      const centerAlignedCount = column.length - centerMisalignedItems.length
      const rightAlignedCount = column.length - rightMisalignedItems.length
      const leftTrackClearlyBest =
        leftError + ALIGNMENT_TOLERANCE_PX < centerError &&
        leftError + ALIGNMENT_TOLERANCE_PX < rightError
      const centerTrackClearlyBest =
        centerError + ALIGNMENT_TOLERANCE_PX < leftError &&
        centerError + ALIGNMENT_TOLERANCE_PX < rightError
      const rightTrackClearlyBest =
        rightError + ALIGNMENT_TOLERANCE_PX < leftError &&
        rightError + ALIGNMENT_TOLERANCE_PX < centerError
      const dominantTrack: ThreeColumnMatrixGraphResolvedTrack | null =
        leftTrackClearlyBest && leftAlignedCount >= 2
          ? {
              kind: 'left',
              target: targetLeftX
            }
          : centerTrackClearlyBest && centerAlignedCount >= 2
            ? {
                kind: 'center',
                target: targetCenterX
              }
            : rightTrackClearlyBest && rightAlignedCount >= 2
              ? {
                  kind: 'right',
                  target: targetRightX
                }
              : null

      return {
        column,
        columnIndex,
        label: columnLabels[columnIndex],
        targetLeftX,
        targetCenterX,
        targetRightX,
        leftMisalignedItems,
        centerMisalignedItems,
        rightMisalignedItems,
        leftAlignedCount,
        centerAlignedCount,
        rightAlignedCount,
        leftTrackClearlyBest,
        centerTrackClearlyBest,
        rightTrackClearlyBest,
        dominantTrack
      }
    })

    const dominantTracks = columnStats.map((stat) => stat.dominantTrack)
    const hasMixedDominantTracks =
      dominantTracks.every(
        (track): track is ThreeColumnMatrixGraphResolvedTrack => track !== null
      ) && new Set(dominantTracks.map((track) => track.kind)).size >= 2

    if (hasMixedDominantTracks) {
      const stableRows = threeColumnMatrixGraph.rows.filter((row) =>
        row.every((item, columnIndex) => {
          const track = dominantTracks[columnIndex]
          return (
            Math.abs(getThreeColumnMatrixGraphTrackValue(item, track.kind) - track.target) <=
            ALIGNMENT_TOLERANCE_PX
          )
        })
      )

      if (stableRows.length >= 2) {
        for (const [rowIndex, row] of threeColumnMatrixGraph.rows.entries()) {
          const deltas = row.map((item, columnIndex) => {
            const track = dominantTracks[columnIndex]
            return roundMetric(getThreeColumnMatrixGraphTrackValue(item, track.kind) - track.target)
          })
          const misalignedItems = row.filter(
            (_item, columnIndex) => Math.abs(deltas[columnIndex]) > ALIGNMENT_TOLERANCE_PX
          )

          if (misalignedItems.length !== row.length) continue

          const dominantDelta = roundMetric(median(deltas))
          const deltaSpread = roundMetric(Math.max(...deltas) - Math.min(...deltas))

          if (
            Math.abs(dominantDelta) <= ALIGNMENT_TOLERANCE_PX ||
            deltaSpread > ALIGNMENT_TOLERANCE_PX
          ) {
            continue
          }

          const rowLabel = `\u7b2c ${rowIndex + 1} \u884c\u53d8\u5bbd\u4e09\u5217\u77e9\u9635`
          const actionId = createDesignInspectionId('design-action')
          actions.push({
            id: actionId,
            type: 'shift-horizontal',
            title: `${rowLabel}\u56de\u5230\u5df2\u5efa\u7acb\u7684\u6df7\u5408\u5217\u951a\u70b9`,
            description:
              '\u6cbf\u7740\u5df2\u7ecf\u7531\u5176\u4ed6\u884c\u5efa\u7acb\u8d77\u6765\u7684\u5de6\u8f68\u9053\u3001\u4e2d\u5fc3\u7ebf\u4e0e\u53f3\u8f68\u9053\u7ec4\u5408\uff0c\u5c06\u8fd9\u4e00\u884c\u6574\u4f53\u6c34\u5e73\u79fb\u56de\u66f4\u7a33\u5b9a\u7684\u7ed3\u6784\u4f4d\u7f6e\uff0c\u800c\u4e0d\u6253\u4e71\u884c\u5185\u7684\u76f8\u5bf9\u987a\u5e8f\u3002',
            executor: 'magicpot-internal',
            targetItemIds: row.map((item) => item.id),
            payload: {
              deltaX: roundMetric(-dominantDelta)
            },
            expectedImpact:
              '\u8fd9\u4e00\u884c\u4f1a\u6574\u4f53\u56de\u5230\u5df2\u5efa\u7acb\u7684\u6df7\u5408\u5217\u951a\u70b9\uff0c\u4e0d\u518d\u5728\u4e0d\u540c\u5217\u8f68\u9053\u4e4b\u95f4\u6ed1\u51fa\u4e00\u4e2a\u6574\u884c\u504f\u79fb\u3002'
          })
          rowShiftActionIds.push(actionId)

          for (const item of row) {
            rowShiftItemIds.add(item.id)
            suppressedGraphItemIds.add(item.id)
          }

          rowShiftEvidence.push(
            `${rowLabel}\uff1a\u76f8\u5bf9\u6df7\u5408\u5217\u951a\u70b9\u6574\u4f53\u504f\u79fb ${dominantDelta}px\uff08${deltas.join(
              ' / '
            )}px\uff1b\u8f68\u9053 ${dominantTracks
              .map((track) => formatThreeColumnMatrixGraphTrackKind(track.kind))
              .join(' / ')}\uff09`
          )
        }
      }
    }

    for (const stat of columnStats) {
      const leftMisalignedItems = stat.leftMisalignedItems.filter(
        (item) => !suppressedGraphItemIds.has(item.id)
      )
      const centerMisalignedItems = stat.centerMisalignedItems.filter(
        (item) => !suppressedGraphItemIds.has(item.id)
      )
      const rightMisalignedItems = stat.rightMisalignedItems.filter(
        (item) => !suppressedGraphItemIds.has(item.id)
      )

      if (
        stat.leftTrackClearlyBest &&
        leftMisalignedItems.length > 0 &&
        stat.leftAlignedCount >= 2
      ) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-left',
          title: `${stat.label}\u7edf\u4e00\u5230\u540c\u4e00\u5de6\u8f68\u9053`,
          description:
            '\u8c03\u6574\u5bbd\u5ea6\u4e0d\u540c\u4f46\u5173\u7cfb\u4ecd\u7136\u660e\u786e\u7684\u4e09\u5217\u591a\u884c\u77e9\u9635\uff0c\u4f7f\u504f\u79bb\u5de6\u4fa7\u8f68\u9053\u7684\u5757\u5143\u7d20\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u7a33\u5b9a\u7684\u5de6\u951a\u70b9\u3002',
          executor: 'magicpot-internal',
          targetItemIds: leftMisalignedItems.map((item) => item.id),
          payload: {
            x: stat.targetLeftX
          },
          expectedImpact:
            '\u8fd9\u4e2a\u53d8\u5bbd\u4e09\u5217\u77e9\u9635\u4f1a\u56de\u5230\u66f4\u6e05\u6670\u7684\u5217\u5de6\u8f68\u9053\uff0c\u800c\u4e0d\u662f\u5c11\u6570\u5757\u5143\u7d20\u5355\u72ec\u6ed1\u51fa\u5217\u5173\u7cfb\u3002'
        })
        leftActionIds.push(actionId)

        for (const item of leftMisalignedItems) {
          leftItemIds.add(item.id)
          leftEvidence.push(
            `${item.id} \u4f4d\u4e8e ${stat.label}\uff1a\u5de6\u8fb9 x=${roundMetric(
              item.bounds.x
            )}px\uff0c\u76ee\u6807 ${stat.targetLeftX}px`
          )
        }
        continue
      }

      if (
        stat.centerTrackClearlyBest &&
        centerMisalignedItems.length > 0 &&
        stat.centerAlignedCount >= 2
      ) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'align-center',
          title: `${stat.label}\u7edf\u4e00\u5230\u540c\u4e00\u4e2d\u5fc3\u7ebf`,
          description:
            '\u8c03\u6574\u5bbd\u5ea6\u4e0d\u540c\u4f46\u5173\u7cfb\u4ecd\u7136\u660e\u786e\u7684\u4e09\u5217\u591a\u884c\u77e9\u9635\uff0c\u4f7f\u504f\u79bb\u4e2d\u5fc3\u7ebf\u8f68\u9053\u7684\u5757\u5143\u7d20\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u7a33\u5b9a\u7684\u5217\u4e2d\u5fc3\u7ebf\u3002',
          executor: 'magicpot-internal',
          targetItemIds: centerMisalignedItems.map((item) => item.id),
          payload: {
            centerX: stat.targetCenterX
          },
          expectedImpact:
            '\u8fd9\u4e2a\u53d8\u5bbd\u4e09\u5217\u77e9\u9635\u4f1a\u56de\u5230\u66f4\u6e05\u6670\u7684\u5217\u4e2d\u5fc3\u7ebf\uff0c\u800c\u4e0d\u662f\u5c11\u6570\u5757\u5143\u7d20\u5355\u72ec\u6ed1\u51fa\u5171\u540c\u7684\u5217\u8f68\u9053\u3002'
        })
        centerActionIds.push(actionId)

        for (const item of centerMisalignedItems) {
          centerItemIds.add(item.id)
          centerEvidence.push(
            `${item.id} \u4f4d\u4e8e ${stat.label}\uff1a\u4e2d\u5fc3\u7ebf ${roundMetric(
              item.bounds.x + item.bounds.width / 2
            )}px\uff0c\u76ee\u6807 ${stat.targetCenterX}px`
          )
        }
        continue
      }

      if (
        !stat.rightTrackClearlyBest ||
        rightMisalignedItems.length === 0 ||
        stat.rightAlignedCount < 2
      ) {
        continue
      }

      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'align-right',
        title: `${stat.label}\u7edf\u4e00\u5230\u540c\u4e00\u53f3\u8f68\u9053`,
        description:
          '\u8c03\u6574\u5bbd\u5ea6\u4e0d\u540c\u4f46\u5173\u7cfb\u4ecd\u7136\u660e\u786e\u7684\u4e09\u5217\u591a\u884c\u77e9\u9635\uff0c\u4f7f\u504f\u79bb\u53f3\u4fa7\u8f68\u9053\u7684\u5757\u5143\u7d20\u56de\u5230\u7ed3\u6784\u5316\u51e0\u4f55\u91cc\u6700\u7a33\u5b9a\u7684\u53f3\u951a\u70b9\u3002',
        executor: 'magicpot-internal',
        targetItemIds: rightMisalignedItems.map((item) => item.id),
        payload: {
          x: stat.targetRightX
        },
        expectedImpact:
          '\u8fd9\u4e2a\u53d8\u5bbd\u4e09\u5217\u77e9\u9635\u4f1a\u56de\u5230\u66f4\u6e05\u6670\u7684\u5217\u53f3\u8f68\u9053\uff0c\u800c\u4e0d\u662f\u5c11\u6570\u5757\u5143\u7d20\u5355\u72ec\u6ed1\u51fa\u5217\u5173\u7cfb\u3002'
      })
      rightActionIds.push(actionId)

      for (const item of rightMisalignedItems) {
        rightItemIds.add(item.id)
        rightEvidence.push(
          `${item.id} \u4f4d\u4e8e ${stat.label}\uff1a\u53f3\u8fb9 x=${roundMetric(
            item.bounds.x + item.bounds.width
          )}px\uff0c\u76ee\u6807 ${stat.targetRightX}px`
        )
      }
    }

    if (rowShiftActionIds.length > 0) {
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title:
          '\u53d8\u5bbd\u4e09\u5217\u77e9\u9635\u7684\u6df7\u5408\u951a\u70b9\u6574\u884c\u6a2a\u5411\u6f02\u79fb',
        summary:
          '\u66f4\u5bbd\u677e\u7684\u7ed3\u6784\u5173\u7cfb\u68c0\u67e5\u53d1\u73b0\uff0c\u8fd9\u4e2a\u5bbd\u5ea6\u4e0d\u4e00\u7684\u4e09\u5217\u591a\u884c\u5757\u77e9\u9635\u91cc\uff0c\u81f3\u5c11\u6709\u4e00\u6574\u884c\u76f8\u5bf9\u5df2\u5efa\u7acb\u7684\u5de6\u8f68\u9053\u3001\u4e2d\u5fc3\u7ebf\u4e0e\u53f3\u8f68\u9053\u7ec4\u5408\u53d1\u751f\u4e86\u6574\u4f53\u6c34\u5e73\u6ed1\u79fb\u3002',
        itemIds: [...rowShiftItemIds],
        evidence: rowShiftEvidence,
        actionIds: rowShiftActionIds
      })
    }

    if (leftActionIds.length > 0) {
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title:
          '\u53d8\u5bbd\u4e09\u5217\u77e9\u9635\u7684\u5217\u5de6\u8f68\u9053\u4e0d\u4e00\u81f4',
        summary:
          '\u66f4\u5bbd\u677e\u7684\u7ed3\u6784\u5173\u7cfb\u68c0\u67e5\u53d1\u73b0\uff0c\u8fd9\u4e2a\u5bbd\u5ea6\u4e0d\u4e00\u7684\u4e09\u5217\u591a\u884c\u5757\u77e9\u9635\u91cc\uff0c\u81f3\u5c11\u6709\u4e00\u5217\u7684\u5de6\u8fb9\u951a\u70b9\u6ca1\u6709\u56de\u5230\u5176\u4ed6\u884c\u5df2\u7ecf\u5efa\u7acb\u7684\u4e3b\u8f68\u9053\u3002',
        itemIds: [...leftItemIds],
        evidence: leftEvidence,
        actionIds: leftActionIds
      })
    }

    if (centerActionIds.length > 0) {
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title:
          '\u53d8\u5bbd\u4e09\u5217\u77e9\u9635\u7684\u5217\u4e2d\u5fc3\u7ebf\u4e0d\u4e00\u81f4',
        summary:
          '\u66f4\u5bbd\u677e\u7684\u7ed3\u6784\u5173\u7cfb\u68c0\u67e5\u53d1\u73b0\uff0c\u8fd9\u4e2a\u5bbd\u5ea6\u4e0d\u4e00\u7684\u4e09\u5217\u591a\u884c\u5757\u77e9\u9635\u91cc\uff0c\u81f3\u5c11\u6709\u4e00\u5217\u7684\u4e2d\u5fc3\u7ebf\u6ca1\u6709\u56de\u5230\u5176\u4ed6\u884c\u5df2\u7ecf\u5efa\u7acb\u7684\u4e3b\u8f68\u9053\u3002',
        itemIds: [...centerItemIds],
        evidence: centerEvidence,
        actionIds: centerActionIds
      })
    }

    if (rightActionIds.length > 0) {
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title:
          '\u53d8\u5bbd\u4e09\u5217\u77e9\u9635\u7684\u5217\u53f3\u8f68\u9053\u4e0d\u4e00\u81f4',
        summary:
          '\u66f4\u5bbd\u677e\u7684\u7ed3\u6784\u5173\u7cfb\u68c0\u67e5\u53d1\u73b0\uff0c\u8fd9\u4e2a\u5bbd\u5ea6\u4e0d\u4e00\u7684\u4e09\u5217\u591a\u884c\u5757\u77e9\u9635\u91cc\uff0c\u81f3\u5c11\u6709\u4e00\u5217\u7684\u53f3\u8fb9\u951a\u70b9\u6ca1\u6709\u56de\u5230\u5176\u4ed6\u884c\u5df2\u7ecf\u5efa\u7acb\u7684\u4e3b\u8f68\u9053\u3002',
        itemIds: [...rightItemIds],
        evidence: rightEvidence,
        actionIds: rightActionIds
      })
    }
  }

  const horizontalRow =
    verticalStack || grid || twoByThreeGrid || threeColumnMatrix || threeColumnMatrixGraph
      ? null
      : resolveHorizontalRowCandidate(layoutItems)

  if (horizontalRow && horizontalRow.length >= 2) {
    const anchorTop = roundMetric(median(horizontalRow.map((item) => item.bounds.y)))
    const misalignedItems = horizontalRow.filter(
      (item) => Math.abs(item.bounds.y - anchorTop) > ALIGNMENT_TOLERANCE_PX
    )
    const topSpread =
      Math.max(...horizontalRow.map((item) => item.bounds.y)) -
      Math.min(...horizontalRow.map((item) => item.bounds.y))
    const widthCandidates = getWidthNormalizableItems(horizontalRow)
    const heightCandidates = getHeightNormalizableItems(horizontalRow)
    const targetHeight =
      heightCandidates.length >= 2
        ? roundMetric(median(heightCandidates.map((item) => item.bounds.height)))
        : null
    const offPatternHeightItems =
      typeof targetHeight === 'number'
        ? heightCandidates.filter(
            (item) => Math.abs(item.bounds.height - targetHeight) > HEIGHT_TOLERANCE_PX
          )
        : []
    const currentBottomEdges = horizontalRow.map((item) =>
      roundMetric(item.bounds.y + item.bounds.height)
    )
    const effectiveBottomEdges = horizontalRow.map((item) =>
      roundMetric(
        item.bounds.y +
          (offPatternHeightItems.some((candidate) => candidate.id === item.id)
            ? (targetHeight ?? item.bounds.height)
            : item.bounds.height)
      )
    )
    const anchorBottom = roundMetric(median(effectiveBottomEdges))
    const bottomAlignedItems = horizontalRow.filter((item) => {
      const effectiveBottom = roundMetric(
        item.bounds.y +
          (offPatternHeightItems.some((candidate) => candidate.id === item.id)
            ? (targetHeight ?? item.bounds.height)
            : item.bounds.height)
      )
      return Math.abs(effectiveBottom - anchorBottom) > ALIGNMENT_TOLERANCE_PX
    })
    const bottomSpread = Math.max(...currentBottomEdges) - Math.min(...currentBottomEdges)
    const effectiveMiddleYs = horizontalRow.map((item) =>
      roundMetric(
        item.bounds.y +
          (offPatternHeightItems.some((candidate) => candidate.id === item.id)
            ? (targetHeight ?? item.bounds.height)
            : item.bounds.height) /
            2
      )
    )
    const anchorMiddleY = roundMetric(median(effectiveMiddleYs))
    const middleAlignedItems = horizontalRow.filter((item) => {
      const effectiveMiddleY = roundMetric(
        item.bounds.y +
          (offPatternHeightItems.some((candidate) => candidate.id === item.id)
            ? (targetHeight ?? item.bounds.height)
            : item.bounds.height) /
            2
      )
      return Math.abs(effectiveMiddleY - anchorMiddleY) > ALIGNMENT_TOLERANCE_PX
    })
    const middleSpread = Math.max(...effectiveMiddleYs) - Math.min(...effectiveMiddleYs)
    const preferBottomAlignment =
      bottomAlignedItems.length > 0 && bottomSpread + ALIGNMENT_TOLERANCE_PX < topSpread
    const preferMiddleAlignment =
      middleAlignedItems.length > 0 &&
      middleSpread + ALIGNMENT_TOLERANCE_PX < Math.min(topSpread, bottomSpread)

    if (preferMiddleAlignment) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'align-middle',
        title: '将横向排列统一到同一中线',
        description: '将所选横向排列吸附到结构化边界已经隐含出的共同中线上。',
        executor: 'magicpot-internal',
        targetItemIds: middleAlignedItems.map((item) => item.id),
        payload: { centerY: anchorMiddleY },
        expectedImpact: '这一排会更像围绕同一中线组织的带状编排，而不是在共享轴线上下漂移。'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: '所选横向排列未按中线对齐',
        summary: '结构化几何显示，看起来属于同一横向组的元素偏离了共同中线。',
        itemIds: middleAlignedItems.map((item) => item.id),
        evidence: middleAlignedItems.map((item) => {
          const effectiveHeight = offPatternHeightItems.some(
            (candidate) => candidate.id === item.id
          )
            ? (targetHeight ?? item.bounds.height)
            : item.bounds.height
          return `${item.id}：中线 ${roundMetric(item.bounds.y + effectiveHeight / 2)}px，目标 ${anchorMiddleY}px`
        }),
        actionIds: [actionId]
      })
    } else if (!preferBottomAlignment && misalignedItems.length > 0) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'align-top',
        title: '将横向排列统一到同一上边缘',
        description: '将所选横向排列吸附到结构化边界已经隐含出的共同上边缘。',
        executor: 'magicpot-internal',
        targetItemIds: misalignedItems.map((item) => item.id),
        payload: { y: anchorTop },
        expectedImpact: '这一排会更像明确的横向带状编排，而不是上下漂移的一组卡片。'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: '所选横向排列上边缘不一致',
        summary: '结构化几何显示，看起来属于同一横向组的元素拥有不同的上边缘。',
        itemIds: misalignedItems.map((item) => item.id),
        evidence: misalignedItems.map(
          (item) => `${item.id}：上边缘 ${roundMetric(item.bounds.y)}px，目标 ${anchorTop}px`
        ),
        actionIds: [actionId]
      })
    }

    if (horizontalRow.length >= 3) {
      const gaps = horizontalRow.slice(0, -1).map((item, index) => {
        const next = horizontalRow[index + 1]
        return roundMetric(next.bounds.x - (item.bounds.x + item.bounds.width))
      })
      const gapDelta = gaps.length > 0 ? Math.max(...gaps) - Math.min(...gaps) : 0

      if (gaps.length >= 2 && gapDelta > SPACING_TOLERANCE_PX) {
        const targetGap = roundMetric(median(gaps))
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'distribute-horizontal-spacing',
          title: '统一横向排列的水平间距',
          description: '重新分配所选横向排列，使相邻元素间距回到这一排里最常见的节奏。',
          executor: 'magicpot-internal',
          targetItemIds: horizontalRow.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: horizontalRow[0].id
          },
          expectedImpact: '横向间距会更有节奏，也更容易快速扫读。'
        })
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'spacing',
          severity: 'warning',
          title: '水平间距不一致',
          summary: '结构化几何显示，同一横向排列内相邻元素之间的水平间距并不均匀。',
          itemIds: horizontalRow.map((item) => item.id),
          evidence: gaps.map(
            (gap, index) => `${horizontalRow[index].id} -> ${horizontalRow[index + 1].id}：${gap}px`
          ),
          actionIds: [actionId]
        })
      }
    }

    if (widthCandidates.length >= 2) {
      const targetWidth = roundMetric(median(widthCandidates.map((item) => item.bounds.width)))
      const offPatternWidthItems = widthCandidates.filter(
        (item) => Math.abs(item.bounds.width - targetWidth) > WIDTH_TOLERANCE_PX
      )

      if (offPatternWidthItems.length > 0) {
        const actionId = createDesignInspectionId('design-action')
        actions.push({
          id: actionId,
          type: 'normalize-item-width',
          title: '统一横向排列中的卡片宽度',
          description: '调整偏离主样式的块级元素宽度，使这组横向排列回到结构化几何里最常见的宽度。',
          executor: 'magicpot-internal',
          targetItemIds: offPatternWidthItems.map((item) => item.id),
          payload: {
            width: targetWidth
          },
          expectedImpact: '这一排会更像统一的卡片带，而不是混用不同块宽。'
        })
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'geometry',
          severity: 'warning',
          title: '所选横向排列中的块宽度不一致',
          summary: '结构优先几何自动化发现，同一横向排列中的块级元素使用了明显不同的宽度。',
          itemIds: offPatternWidthItems.map((item) => item.id),
          evidence: offPatternWidthItems.map(
            (item) => `${item.id}：宽度 ${roundMetric(item.bounds.width)}px，目标 ${targetWidth}px`
          ),
          actionIds: [actionId]
        })
      }
    }

    if (typeof targetHeight === 'number' && offPatternHeightItems.length > 0) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'normalize-item-height',
        title: '统一横向排列中的卡片高度',
        description: '调整偏离主样式的块级元素高度，使这组横向排列回到结构化几何里最常见的高度。',
        executor: 'magicpot-internal',
        targetItemIds: offPatternHeightItems.map((item) => item.id),
        payload: {
          height: targetHeight
        },
        expectedImpact: '这一排会更像统一的卡片带，而不是混用不同块高。'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'geometry',
        severity: 'warning',
        title: '所选横向排列中的块高度不一致',
        summary: '结构优先几何自动化发现，同一横向排列中的块级元素使用了明显不同的高度。',
        itemIds: offPatternHeightItems.map((item) => item.id),
        evidence: offPatternHeightItems.map(
          (item) => `${item.id}：高度 ${roundMetric(item.bounds.height)}px，目标 ${targetHeight}px`
        ),
        actionIds: [actionId]
      })
    }

    if (!preferMiddleAlignment && preferBottomAlignment) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'align-bottom',
        title: '将横向排列统一到同一下边缘',
        description: '将所选横向排列吸附到结构化边界已经隐含出的共同下边缘。',
        executor: 'magicpot-internal',
        targetItemIds: bottomAlignedItems.map((item) => item.id),
        payload: { y: anchorBottom },
        expectedImpact: '这一排会更像明确的下对齐编排，而不是在下边缘附近漂移。'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: '所选横向排列下边缘不一致',
        summary: '结构化几何显示，看起来属于同一横向组的元素拥有不同的下边缘。',
        itemIds: bottomAlignedItems.map((item) => item.id),
        evidence: bottomAlignedItems.map(
          (item) =>
            `${item.id}：下边缘 ${roundMetric(item.bounds.y + item.bounds.height)}px，目标 ${anchorBottom}px`
        ),
        actionIds: [actionId]
      })
    }
  }

  if (actions.length > 0) {
    executionPlan.push(
      ...actions.map((action, index) => ({
        step: index + 1,
        executor: action.executor,
        actionIds: [action.id],
        description: action.description
      }))
    )
  }

  const proposal: DesignInspectionProposal = {
    id: createDesignInspectionId('design-proposal'),
    contextPackId: contextPack.id,
    generatedAt: new Date().toISOString(),
    summary:
      issues.length > 0
        ? `已发现 ${issues.length} 个结构优先问题，并准备了 ${actions.length} 个需审批的站内动作。`
        : '当前选区没有发现需要处理的字体、间距、对齐、圆角或几何问题。',
    issues,
    actions,
    rationale:
      issues.length > 0
        ? '该方案基于明确的画布几何和文本属性生成，并且只包含可在 MagicPot 内部执行、且必须经过用户审批的动作。'
        : '结构化画布数据没有显示出值得自动应用的字体、间距、对齐、圆角或几何偏差。',
    expectedResult:
      issues.length > 0
        ? '批准后，当前选区应呈现为一套更统一的系统，拥有更一致的对齐、间距、文本样式、圆角处理与块级几何。'
        : '当前选区无需进行结构优先修正，可以保持现状。',
    executionPlan
  }

  if (provenanceNarrative) {
    proposal.summary = `${proposal.summary}${provenanceNarrative.summarySuffix}`
    proposal.rationale = `${proposal.rationale}${provenanceNarrative.rationaleSuffix}`
  }

  return proposal
}

function buildDesignInspectionAgentPrompt(
  contextPack: DesignInspectionContextPack,
  draftProposal: DesignInspectionProposal,
  userNotes?: string
): string {
  const provenanceNarrative = buildSelectionProvenanceNarrative(contextPack.selectionItems)

  return [
    'You are MagicPot’s design-inspection planner.',
    'Improve the human-facing wording of the draft proposal, but do not change any existing action id, type, executor, targetItemIds, payload, or execution step ordering.',
    'Preserve every existing issue id and its actionIds. You may only refine summary, rationale, expectedResult, issue titles, issue summaries, evidence phrasing, action titles, action descriptions, and expectedImpact for the draft proposal.',
    'If reviewer notes explicitly ask for document or file-copy changes, you may also return contentActionSuggestions for editable file nodes from contextPack.documents.',
    'Each contentActionSuggestion must target exactly one editable file node, provide a full replacement content string, and stay within MagicPot-internal execution. Do not suggest content changes for non-editable files.',
    'When provenance is present, treat it only as upstream origin context. MagicPot canvas geometry, text, grouping, and coordinates remain the runtime inspection truth.',
    'You may mention provenance in reviewer-facing narrative when it clarifies whether a node came from native canvas work, imported files, or external bridge payloads, but do not replace MagicPot-internal actions with external execution.',
    'Return JSON only.',
    JSON.stringify(
      {
        contextPack,
        draftProposal,
        provenanceOverview: provenanceNarrative?.promptOverview,
        userNotes: userNotes?.trim() || undefined
      },
      null,
      2
    )
  ].join('\n\n')
}

function stripCodeFences(value: string): string {
  return value
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
}

function normalizeMultilineContent(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function shouldAllowAgentContentSuggestions(userNotes?: string): boolean {
  const normalizedNotes = userNotes?.trim().toLowerCase()
  if (!normalizedNotes) return false

  const mentionsEditableFileTarget =
    /(file|files|document|documents|markdown|md|txt|copy|content|wording|text content|文件|文档|文案|内容|文本)/.test(
      normalizedNotes
    )
  const mentionsEditIntent =
    /(update|rewrite|revise|edit|change|replace|refresh|modify|修改|更新|重写|改写|替换|润色)/.test(
      normalizedNotes
    )

  return mentionsEditableFileTarget && mentionsEditIntent
}

function buildAgentSuggestedContentActions(
  contextPack: DesignInspectionContextPack,
  suggestions: DesignInspectionAgentContentSuggestion[] | undefined,
  allowContentSuggestions: boolean
): Pick<DesignInspectionProposal, 'issues' | 'actions' | 'executionPlan'> {
  if (!allowContentSuggestions || !Array.isArray(suggestions) || suggestions.length === 0) {
    return {
      issues: [],
      actions: [],
      executionPlan: []
    }
  }

  const editableDocuments = new Map(
    contextPack.documents
      .filter((document) => document.editable)
      .map((document) => [document.itemId, document] as const)
  )

  const issues: DesignInspectionProposal['issues'] = []
  const actions: DesignInspectionProposal['actions'] = []
  const executionPlan: DesignInspectionProposal['executionPlan'] = []

  for (const suggestion of suggestions) {
    if (
      !suggestion ||
      typeof suggestion.itemId !== 'string' ||
      typeof suggestion.content !== 'string'
    ) {
      continue
    }

    const targetDocument = editableDocuments.get(suggestion.itemId)
    if (!targetDocument) continue

    const nextContent = normalizeMultilineContent(suggestion.content)
    const currentContent = normalizeMultilineContent(targetDocument.previewText || '')
    if (!nextContent.trim() || nextContent === currentContent) continue

    const actionId = createDesignInspectionId('design-action')
    const issueId = createDesignInspectionId('design-issue')
    const fileLabel = targetDocument.fileName || suggestion.itemId

    actions.push({
      id: actionId,
      type: 'update-file-content',
      title:
        typeof suggestion.title === 'string' && suggestion.title.trim()
          ? suggestion.title.trim()
          : `更新 ${fileLabel} 的可编辑文件内容`,
      description:
        typeof suggestion.description === 'string' && suggestion.description.trim()
          ? suggestion.description.trim()
          : '将已批准的内容修订直接应用到 MagicPot 内的可编辑文件节点。',
      executor: 'magicpot-internal',
      targetItemIds: [suggestion.itemId],
      payload: {
        content: nextContent
      },
      expectedImpact:
        typeof suggestion.expectedImpact === 'string' && suggestion.expectedImpact.trim()
          ? suggestion.expectedImpact.trim()
          : '可编辑文件节点会在不离开 MagicPot 的前提下匹配已批准的文案修订。'
    })

    issues.push({
      id: issueId,
      category: 'content',
      severity: 'warning',
      title:
        typeof suggestion.title === 'string' && suggestion.title.trim()
          ? suggestion.title.trim()
          : `应更新 ${fileLabel} 的可编辑文件内容`,
      summary:
        typeof suggestion.summary === 'string' && suggestion.summary.trim()
          ? suggestion.summary.trim()
          : '智能体为当前选区中的可编辑文件节点给出了明确的内容修订建议。',
      itemIds: [suggestion.itemId],
      evidence:
        Array.isArray(suggestion.evidence) &&
        suggestion.evidence.every((entry) => typeof entry === 'string' && entry.trim())
          ? suggestion.evidence
          : [
              `${fileLabel}：可编辑 ${targetDocument.editable ? '是' : '否'}`,
              `当前预览长度 ${currentContent.length}，建议内容长度 ${nextContent.length}`
            ],
      actionIds: [actionId]
    })
  }

  executionPlan.push(
    ...actions.map((action, index) => ({
      step: index + 1,
      executor: action.executor,
      actionIds: [action.id],
      description: action.description
    }))
  )

  return {
    issues,
    actions,
    executionPlan
  }
}

function mergeDesignInspectionAgentResponse(
  contextPack: DesignInspectionContextPack,
  draftProposal: DesignInspectionProposal,
  rawResponse: string,
  userNotes?: string
): DesignInspectionProposal {
  const parsed = JSON.parse(stripCodeFences(rawResponse)) as DesignInspectionAgentResponse
  const mergedIssues = draftProposal.issues.map((issue) => {
    const candidate = parsed.issues?.find((entry) => entry.id === issue.id)
    return {
      ...issue,
      title: typeof candidate?.title === 'string' ? candidate.title : issue.title,
      summary: typeof candidate?.summary === 'string' ? candidate.summary : issue.summary,
      evidence:
        Array.isArray(candidate?.evidence) &&
        candidate.evidence.every((entry) => typeof entry === 'string')
          ? candidate.evidence
          : issue.evidence
    }
  })

  const mergedActions = draftProposal.actions.map((action) => {
    const candidate = parsed.actions?.find((entry) => entry.id === action.id)
    return {
      ...action,
      title: typeof candidate?.title === 'string' ? candidate.title : action.title,
      description:
        typeof candidate?.description === 'string' ? candidate.description : action.description,
      expectedImpact:
        typeof candidate?.expectedImpact === 'string'
          ? candidate.expectedImpact
          : action.expectedImpact
    }
  })

  const mergedExecutionPlan = draftProposal.executionPlan.map((step) => {
    const candidate = parsed.executionPlan?.find((entry) => entry.step === step.step)
    return {
      ...step,
      description:
        typeof candidate?.description === 'string' ? candidate.description : step.description
    }
  })

  const contentActionAdditions = buildAgentSuggestedContentActions(
    contextPack,
    parsed.contentActionSuggestions,
    shouldAllowAgentContentSuggestions(userNotes) || shouldAllowChineseContentSuggestions(userNotes)
  )
  const mergedIssueList = [...mergedIssues, ...contentActionAdditions.issues]
  const mergedActionList = [...mergedActions, ...contentActionAdditions.actions]
  const mergedExecutionPlanList = [
    ...mergedExecutionPlan,
    ...contentActionAdditions.executionPlan.map((step, index) => ({
      ...step,
      step: mergedExecutionPlan.length + index + 1
    }))
  ]
  const fallbackSummary =
    mergedActionList.length > draftProposal.actions.length
      ? `已准备 ${mergedActionList.length} 个需审批的 MagicPot 站内动作，其中包含 ${contentActionAdditions.actions.length} 个可编辑文件内容更新。`
      : draftProposal.summary
  const fallbackRationale =
    mergedActionList.length > draftProposal.actions.length
      ? `${draftProposal.rationale} 只有在上下文中已标记为可编辑的文档才会接纳文件内容建议，并且执行前仍需用户明确批准。`
      : draftProposal.rationale
  const fallbackExpectedResult =
    mergedActionList.length > draftProposal.actions.length
      ? '批准后，当前选区会同时反映结构优先修正和已批准的可编辑文件内容更新。'
      : draftProposal.expectedResult

  return {
    ...draftProposal,
    summary: typeof parsed.summary === 'string' ? parsed.summary : fallbackSummary,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : fallbackRationale,
    expectedResult:
      typeof parsed.expectedResult === 'string' ? parsed.expectedResult : fallbackExpectedResult,
    issues: mergedIssueList,
    actions: mergedActionList,
    executionPlan: mergedExecutionPlanList
  }
}

function buildAgentFallbackProposal(
  draftProposal: DesignInspectionProposal,
  reason: string
): DesignInspectionProposal {
  return {
    ...draftProposal,
    rationale: `${draftProposal.rationale} 智能体文案回退原因：${reason}。`
  }
}

export async function requestDesignInspectionProposalFromAgent({
  contextPack,
  draftProposal,
  llmProxy,
  attachments,
  userNotes
}: RequestDesignInspectionProposalOptions): Promise<DesignInspectionProposal> {
  if (!llmProxy) {
    return buildAgentFallbackProposal(draftProposal, 'LLM 代理不可用')
  }

  try {
    const profilesResponse = await llmProxy.listProfiles({})
    const selectedProfile =
      profilesResponse.profiles.find((profile) => profile.is_vision_model) ||
      profilesResponse.profiles[0]

    if (!selectedProfile) {
      return buildAgentFallbackProposal(draftProposal, '没有可用的 LLM 配置')
    }

    const response = await llmProxy.chat({
      profileId: selectedProfile.id,
      messages: [
        {
          role: 'user',
          content: buildDesignInspectionAgentPrompt(contextPack, draftProposal, userNotes),
          attachments: attachments && attachments.length > 0 ? attachments : undefined
        }
      ]
    })

    if (!response?.content?.trim()) {
      return buildAgentFallbackProposal(draftProposal, '智能体返回了空响应')
    }

    return mergeDesignInspectionAgentResponse(
      contextPack,
      draftProposal,
      response.content,
      userNotes
    )
  } catch (error) {
    return buildAgentFallbackProposal(
      draftProposal,
      error instanceof Error ? error.message : '未知的智能体提案错误'
    )
  }
}

function updateCanvasItem<T extends CanvasItem>(
  item: T,
  changes: Partial<T>,
  field: string,
  description: string,
  appliedChanges: DesignInspectionExecutionResult['appliedChanges']
): T {
  const nextItem = { ...item, ...changes } as T
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(changes)) {
    before[key] = (item as unknown as Record<string, unknown>)[key]
    after[key] = value
  }

  appliedChanges.push({
    itemId: item.id,
    field,
    before,
    after,
    description
  })

  return nextItem
}

function createEditableFileContentUrl(content: string, mimeType: string): string {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(new Blob([content], { type: mimeType }))
  }

  return `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`
}

export function applyDesignInspectionProposal(
  items: CanvasItem[],
  proposal: DesignInspectionProposal,
  approval: DesignInspectionApproval
): ApplyDesignInspectionProposalResult {
  const approvedActionIds = new Set(approval.approvedActions)
  const appliedChanges: DesignInspectionExecutionResult['appliedChanges'] = []
  const trace: DesignInspectionTraceEntry[] = [
    createTraceEntry(
      'approval_recorded',
      `已记录审批状态“${formatApprovalStatusForTrace(approval.status)}”，共涉及 ${approvedActionIds.size} 个动作。`
    )
  ]

  let nextItems = [...items]

  for (const action of proposal.actions) {
    if (!approvedActionIds.has(action.id)) continue

    if (action.type === 'align-top') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        if (roundMetric(item.y) === roundMetric(action.payload.y)) return item
        return updateCanvasItem(
          item,
          { y: action.payload.y },
          'y',
          `已将 ${item.id} 对齐到 y=${action.payload.y}。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'align-bottom') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        const visualHeight = roundMetric(item.height * Math.abs(item.scaleY || 1))
        const nextY = roundMetric(action.payload.y - visualHeight)
        if (roundMetric(item.y) === nextY) return item
        return updateCanvasItem(
          item,
          { y: nextY },
          'y',
          `已将 ${item.id} 的下边缘对齐到 y=${action.payload.y}。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'align-left') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        if (roundMetric(item.x) === roundMetric(action.payload.x)) return item
        return updateCanvasItem(
          item,
          { x: action.payload.x },
          'x',
          `已将 ${item.id} 对齐到 x=${action.payload.x}。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'shift-horizontal') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        const nextX = roundMetric(item.x + action.payload.deltaX)
        if (roundMetric(item.x) === nextX) return item
        return updateCanvasItem(
          item,
          { x: nextX },
          'x',
          `Shifted ${item.id} horizontally by ${action.payload.deltaX}px.`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'align-center') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item

        const scaleX = Math.abs(item.scaleX || 1) || 1
        const visualWidth = roundMetric(item.width * scaleX)
        const nextX = roundMetric(action.payload.centerX - visualWidth / 2)
        if (roundMetric(item.x) === nextX) return item

        return updateCanvasItem(
          item,
          { x: nextX },
          'x',
          `已将 ${item.id} 的中心线对齐到 x=${action.payload.centerX}。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'align-middle') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item

        const scaleY = Math.abs(item.scaleY || 1) || 1
        const visualHeight = roundMetric(item.height * scaleY)
        const nextY = roundMetric(action.payload.centerY - visualHeight / 2)
        if (roundMetric(item.y) === nextY) return item

        return updateCanvasItem(
          item,
          { y: nextY },
          'y',
          `已将 ${item.id} 的中线对齐到 y=${action.payload.centerY}。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'align-right') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        const visualWidth = roundMetric(item.width * Math.abs(item.scaleX || 1))
        const nextX = roundMetric(action.payload.x - visualWidth)
        if (roundMetric(item.x) === nextX) return item
        return updateCanvasItem(
          item,
          { x: nextX },
          'x',
          `已将 ${item.id} 的右边缘对齐到 x=${action.payload.x}。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'distribute-horizontal-spacing') {
      const targetItems = nextItems
        .filter((item) => action.targetItemIds.includes(item.id))
        .sort((left, right) => left.x - right.x)

      if (targetItems.length >= 2) {
        const nextXById = new Map<string, number>()
        let cursorX = targetItems[0].x + targetItems[0].width + action.payload.gap

        for (let index = 1; index < targetItems.length; index += 1) {
          const targetItem = targetItems[index]
          nextXById.set(targetItem.id, cursorX)
          cursorX += targetItem.width + action.payload.gap
        }

        nextItems = nextItems.map((item) => {
          const nextX = nextXById.get(item.id)
          if (typeof nextX !== 'number') return item
          if (roundMetric(item.x) === roundMetric(nextX)) return item
          return updateCanvasItem(
            item,
            { x: nextX },
            'x',
            `已调整 ${item.id}，使水平间距保持为 ${action.payload.gap}px。`,
            appliedChanges
          )
        })
      }

      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'distribute-vertical-spacing') {
      const targetItems = nextItems
        .filter((item) => action.targetItemIds.includes(item.id))
        .sort((left, right) => left.y - right.y)

      if (targetItems.length >= 2) {
        const nextYById = new Map<string, number>()
        let cursorY = targetItems[0].y + targetItems[0].height + action.payload.gap

        for (let index = 1; index < targetItems.length; index += 1) {
          const targetItem = targetItems[index]
          nextYById.set(targetItem.id, cursorY)
          cursorY += targetItem.height + action.payload.gap
        }

        nextItems = nextItems.map((item) => {
          const nextY = nextYById.get(item.id)
          if (typeof nextY !== 'number') return item
          if (roundMetric(item.y) === roundMetric(nextY)) return item
          return updateCanvasItem(
            item,
            { y: nextY },
            'y',
            `已调整 ${item.id}，使垂直间距保持为 ${action.payload.gap}px。`,
            appliedChanges
          )
        })
      }

      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'normalize-text-style') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item

        if (item.type === 'text') {
          const changes: Partial<typeof item> = {}
          if (
            typeof action.payload.fontSize === 'number' &&
            item.fontSize !== action.payload.fontSize
          ) {
            changes.fontSize = action.payload.fontSize
          }
          if (action.payload.fontFamily && item.fontFamily !== action.payload.fontFamily) {
            changes.fontFamily = action.payload.fontFamily
          }
          if (action.payload.fontWeight && item.fontWeight !== action.payload.fontWeight) {
            changes.fontWeight = action.payload.fontWeight
          }
          if (action.payload.fill && item.fill !== action.payload.fill) {
            changes.fill = action.payload.fill
          }
          if (Object.keys(changes).length === 0) return item
          return updateCanvasItem(
            item,
            changes,
            'text-style',
            `已统一 ${item.id} 的文本样式。`,
            appliedChanges
          )
        }

        if (item.type === 'annotation' && item.shape === 'text-anno') {
          const changes: Partial<typeof item> = {}
          if (
            typeof action.payload.fontSize === 'number' &&
            item.fontSize !== action.payload.fontSize
          ) {
            changes.fontSize = action.payload.fontSize
          }
          if (action.payload.fontWeight && item.fontWeight !== action.payload.fontWeight) {
            changes.fontWeight = action.payload.fontWeight
          }
          if (Object.keys(changes).length === 0) return item
          return updateCanvasItem(
            item,
            changes,
            'annotation-text-style',
            `已统一 ${item.id} 的附着注释文本样式。`,
            appliedChanges
          )
        }

        return item
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'normalize-annotation-corner-style') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        if (item.type !== 'annotation') return item
        if (item.shape !== 'rect' && item.shape !== 'rounded-rect') return item
        if (item.shape === action.payload.shape) return item

        return updateCanvasItem(
          item,
          { shape: action.payload.shape },
          'annotation-corner-style',
          `已将 ${item.id} 的圆角风格统一为 ${action.payload.shape}。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'normalize-item-width') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item

        const canNormalizeWidth =
          item.type === 'file' ||
          (item.type === 'annotation' &&
            (item.shape === 'rect' ||
              item.shape === 'rounded-rect' ||
              item.shape === 'document' ||
              item.shape === 'double-line-rect'))

        if (!canNormalizeWidth) return item

        const scaleX = Math.abs(item.scaleX || 1) || 1
        const nextWidth = roundMetric(action.payload.width / scaleX)
        if (roundMetric(item.width) === nextWidth) return item

        return updateCanvasItem(
          item,
          { width: nextWidth },
          'item-width',
          `已将 ${item.id} 的宽度统一为 ${action.payload.width}px 可见宽度。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'normalize-item-height') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item

        const canNormalizeHeight =
          item.type === 'file' ||
          (item.type === 'annotation' &&
            (item.shape === 'rect' ||
              item.shape === 'rounded-rect' ||
              item.shape === 'document' ||
              item.shape === 'double-line-rect'))

        if (!canNormalizeHeight) return item

        const scaleY = Math.abs(item.scaleY || 1) || 1
        const nextHeight = roundMetric(action.payload.height / scaleY)
        if (roundMetric(item.height) === nextHeight) return item

        return updateCanvasItem(
          item,
          { height: nextHeight },
          'item-height',
          `已将 ${item.id} 的高度统一为 ${action.payload.height}px 可见高度。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'normalize-item-size') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item

        const canNormalizeSize =
          item.type === 'file' ||
          (item.type === 'annotation' &&
            (item.shape === 'rect' ||
              item.shape === 'rounded-rect' ||
              item.shape === 'document' ||
              item.shape === 'double-line-rect'))

        if (!canNormalizeSize) return item

        const scaleX = Math.abs(item.scaleX || 1) || 1
        const scaleY = Math.abs(item.scaleY || 1) || 1
        const nextWidth = roundMetric(action.payload.width / scaleX)
        const nextHeight = roundMetric(action.payload.height / scaleY)

        if (roundMetric(item.width) === nextWidth && roundMetric(item.height) === nextHeight) {
          return item
        }

        return updateCanvasItem(
          item,
          { width: nextWidth, height: nextHeight },
          'item-size',
          `已将 ${item.id} 的尺寸统一为 ${action.payload.width}x${action.payload.height}px 可见尺寸。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'update-file-content') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        if (item.type !== 'file' || !item.editable) return item

        const nextContent = normalizeMultilineContent(action.payload.content)
        const currentContent = normalizeMultilineContent(item.content ?? item.previewText ?? '')
        if (!nextContent.trim() || nextContent === currentContent) return item

        const nextSrc = createEditableFileContentUrl(nextContent, item.mimeType || 'text/plain')
        const updates = buildCanvasFileContentUpdate(item, nextContent, nextSrc)

        if (
          item.src.startsWith('blob:') &&
          item.src !== nextSrc &&
          typeof URL !== 'undefined' &&
          typeof URL.revokeObjectURL === 'function'
        ) {
          URL.revokeObjectURL(item.src)
        }

        return updateCanvasItem(
          item,
          updates,
          'file-content',
          `已更新 ${item.id} 的可编辑文件内容。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
    }
  }

  const attemptedActions = proposal.actions.filter((action) => approvedActionIds.has(action.id))
  const resultStatus =
    attemptedActions.length === 0 || appliedChanges.length > 0
      ? 'success'
      : approvedActionIds.size > 0
        ? 'partial'
        : 'success'

  const result: DesignInspectionExecutionResult = {
    id: createDesignInspectionId('design-execution'),
    contextPackId: proposal.contextPackId,
    proposalId: proposal.id,
    approvalId: approval.id,
    status: resultStatus,
    executor: 'magicpot-internal',
    appliedChanges,
    artifacts: [
      {
        type: 'json',
        label: 'design-inspection-result',
        content: JSON.stringify(
          {
            approvedActionIds: [...approvedActionIds],
            appliedChangeCount: appliedChanges.length
          },
          null,
          2
        )
      }
    ],
    trace
  }

  return {
    items: nextItems,
    result
  }
}
