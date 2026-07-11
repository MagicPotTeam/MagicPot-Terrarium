import type { DesignInspectionItemSummary } from '@shared/designInspection'

export type InspectableTextSummary = DesignInspectionItemSummary & {
  fontSize: number
  textContent: string
}

export type PrimaryTextStyle = {
  fontSize?: number
  fontFamily?: string
  fontWeight?: 'normal' | 'bold'
  fill?: string
}

export type RectangularCornerShape = 'rect' | 'rounded-rect'

export type InspectableRectangularAnnotationSummary = DesignInspectionItemSummary & {
  type: 'annotation'
  shape: RectangularCornerShape
}

export type WidthNormalizableItemSummary =
  | (DesignInspectionItemSummary & {
      type: 'annotation'
      shape: RectangularCornerShape | 'document' | 'double-line-rect'
    })
  | (DesignInspectionItemSummary & {
      type: 'file'
    })

export type TitleTextItemSummary = InspectableTextSummary & {
  type: 'text'
}

export type ContainerTitleInsetPair = {
  container: WidthNormalizableItemSummary
  title: TitleTextItemSummary
  leftInset: number
  rightInset: number
  topInset: number
  centerOffset: number
}

export type ContainerHeaderMetaInsetPair = {
  container: WidthNormalizableItemSummary
  meta: TitleTextItemSummary
  rightInset: number
}

export type ContainerMetaBlockValueColumnPair = {
  container: WidthNormalizableItemSummary
  valueItems: TitleTextItemSummary[]
  rightInset: number
  rowCount: number
}

export type ContainerBodyMetaValueColumnPair = {
  container: WidthNormalizableItemSummary
  valueItems: TitleTextItemSummary[]
  rightInset: number
  rowCount: number
}

export type ContainerBodyMetaFooterActionValueColumnPair = {
  container: WidthNormalizableItemSummary
  valueItems: TitleTextItemSummary[]
  rightInset: number
  rowCount: number
}

export type ContainerBadgeStackSpacingPair = {
  container: WidthNormalizableItemSummary
  items: TitleTextItemSummary[]
  gap: number
  footerGap: number
  rowCount: number
}

export type ContainerTailBadgeStackSpacingPair = {
  container: WidthNormalizableItemSummary
  items: TitleTextItemSummary[]
  gap: number
  rowCount: number
}

export type ContainerBadgeStackFooterActionSpacingPair = {
  container: WidthNormalizableItemSummary
  items: TitleTextItemSummary[]
  gap: number
  rowCount: number
  footerRowCount: number
}

export type ContainerChipGroupRowSpacingPair = {
  container: WidthNormalizableItemSummary
  rows: TitleTextItemSummary[][]
  gap: number
  rowCount: number
  columnCount: number
}

export type ContainerChipGroupFooterActionRowSpacingPair = {
  container: WidthNormalizableItemSummary
  rows: TitleTextItemSummary[][]
  gap: number
  rowCount: number
  columnCount: number
  footerRowCount: number
}

export type ContainerTrailingBadgeStackSpacingPair = {
  container: WidthNormalizableItemSummary
  items: TitleTextItemSummary[]
  gap: number
}

export type ContainerBodyInsetPair = {
  container: WidthNormalizableItemSummary
  title: TitleTextItemSummary
  body: TitleTextItemSummary
  leftInset: number
  verticalGap: number
}

export type ContainerFooterInsetPair = {
  container: WidthNormalizableItemSummary
  footer: TitleTextItemSummary
  bottomInset: number
}

export type ContainerFooterRowSpacingPair = {
  container: WidthNormalizableItemSummary
  items: TitleTextItemSummary[]
  gap: number
}

export type GridTwoByThreeRowSpacingPair = {
  label: string
  items: WidthNormalizableItemSummary[]
  gap: number
  gapSpread: number
  gaps: number[]
  index: number
}

export type ThreeColumnMultiRowMatrixCandidate = {
  rows: WidthNormalizableItemSummary[][]
  columns: WidthNormalizableItemSummary[][]
}

export type ThreeColumnMultiRowMatrixGraphCandidate = {
  rows: WidthNormalizableItemSummary[][]
  columns: WidthNormalizableItemSummary[][]
}

export type ThreeColumnMatrixGraphTrackKind = 'left' | 'center' | 'right'

export type ThreeColumnMatrixGraphResolvedTrack = {
  kind: ThreeColumnMatrixGraphTrackKind
  target: number
}

export type ThreeColumnMatrixRowSpacingPair = {
  label: string
  items: WidthNormalizableItemSummary[]
  top: number
  gap: number
  gapSpread: number
  gaps: number[]
  index: number
  anchorAligned: boolean
}

export type ThreeColumnMatrixRowRhythmTransition = {
  label: string
  items: WidthNormalizableItemSummary[]
  top: number
  topGap: number
  gap: number
  gapSpread: number
  gaps: number[]
  index: number
}

export type StructuredContainerTextRoles = {
  container: WidthNormalizableItemSummary
  title: TitleTextItemSummary
  rows: TitleTextItemSummary[][]
  headerMeta?: TitleTextItemSummary
  body?: TitleTextItemSummary
  footer?: TitleTextItemSummary
  footerRow?: TitleTextItemSummary[]
}
