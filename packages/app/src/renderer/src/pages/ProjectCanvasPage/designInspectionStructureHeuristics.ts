import type {
  DesignInspectionAction,
  DesignInspectionContextPack,
  DesignInspectionExecutionPlanStep,
  DesignInspectionIssue,
  DesignInspectionItemSummary,
  DesignInspectionProposal
} from '@shared/designInspection'
import { createDesignInspectionId } from './designInspectionCommon'
import { buildDesignInspectionSelectionProvenanceNarrative } from './designInspectionProvenanceNarrative'
import {
  ALIGNMENT_TOLERANCE_PX,
  HEIGHT_TOLERANCE_PX,
  SPACING_TOLERANCE_PX,
  WIDTH_TOLERANCE_PX,
  formatThreeColumnMatrixGraphTrackKind,
  getHeightNormalizableItems,
  getInspectableTextItems,
  getLayoutHeuristicItems,
  getRectangularAnnotationItems,
  getThreeColumnMatrixGraphTrackValue,
  getWidthNormalizableItems,
  itemNeedsTextStyleNormalization,
  median,
  resolveContainerBadgeStackFooterActionSpacingPairs,
  resolveContainerBadgeStackSpacingPairs,
  resolveContainerBodyInsetPairs,
  resolveContainerBodyMetaFooterActionValueColumnPairs,
  resolveContainerBodyMetaValueColumnPairs,
  resolveContainerChipGroupFooterActionRowSpacingPairs,
  resolveContainerChipGroupRowSpacingPairs,
  resolveContainerFooterInsetPairs,
  resolveContainerFooterRowSpacingPairs,
  resolveContainerHeaderMetaInsetPairs,
  resolveContainerMetaBlockValueColumnPairs,
  resolveContainerTailBadgeStackSpacingPairs,
  resolveContainerTitleInsetPairs,
  resolveContainerTrailingBadgeStackSpacingPairs,
  resolveDominantCornerShape,
  resolveGridCandidate,
  resolveHorizontalRowCandidate,
  resolvePrimaryTextStyle,
  resolveThreeColumnMultiRowMatrixCandidate,
  resolveThreeColumnMultiRowMatrixGraphCandidate,
  resolveTwoByThreeGridCandidate,
  resolveVerticalStackCandidate,
  roundMetric
} from './designInspectionStructureRules'
import type {
  ContainerBodyInsetPair,
  ContainerBodyMetaFooterActionValueColumnPair,
  ContainerBodyMetaValueColumnPair,
  ContainerFooterInsetPair,
  ContainerHeaderMetaInsetPair,
  ContainerMetaBlockValueColumnPair,
  ContainerTitleInsetPair,
  GridTwoByThreeRowSpacingPair,
  ThreeColumnMatrixGraphResolvedTrack,
  ThreeColumnMatrixRowRhythmTransition,
  ThreeColumnMatrixRowSpacingPair
} from './designInspectionStructureRules'

export function buildStructureFirstDesignInspectionProposal(
  contextPack: DesignInspectionContextPack
): DesignInspectionProposal {
  const issues: DesignInspectionIssue[] = []
  const actions: DesignInspectionAction[] = []
  const executionPlan: DesignInspectionExecutionPlanStep[] = []
  const selectionItems = contextPack.selectionItems
  const provenanceNarrative = buildDesignInspectionSelectionProvenanceNarrative(selectionItems)
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
        title: 'Normalize text style to the selection primary style',
        description:
          'Restore text nodes that deviate from the dominant font size and font styling in the current selection.',
        executor: 'magicpot-internal',
        targetItemIds: targetItems.map((item) => item.id),
        payload: {
          fontSize: primaryStyle.fontSize,
          fontFamily: primaryStyle.fontFamily,
          fontWeight: primaryStyle.fontWeight,
          fill: primaryStyle.fill
        },
        expectedImpact:
          'Text styling returns to one coherent system instead of scattered local overrides.'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'typography',
        severity: 'warning',
        title: 'Selected text nodes use inconsistent typography',
        summary:
          'The structure-first check found text nodes with inconsistent font size or font styling in the same selection.',
        itemIds: targetItems.map((item) => item.id),
        evidence: targetItems.map(
          (item) =>
            `${item.id}: font size ${item.fontSize}; font ${item.fontFamily || 'not provided'}; weight ${item.fontWeight || 'normal'}`
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
      const normalizedShapeLabel =
        dominantCornerShape === 'rounded-rect' ? 'rounded corners' : 'square corners'
      actions.push({
        id: actionId,
        type: 'normalize-annotation-corner-style',
        title: 'Normalize selected card corner style',
        description:
          'Restore annotation rectangles that deviate from the dominant corner treatment in the current selection.',
        executor: 'magicpot-internal',
        targetItemIds: targetItems.map((item) => item.id),
        payload: {
          shape: dominantCornerShape
        },
        expectedImpact:
          'These rectangular annotations will read as one intentional card system instead of mixing square and rounded corners.'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'radius',
        severity: 'warning',
        title: 'Rectangular annotation cards use mixed corner styles',
        summary:
          'The structure-first check found both square-corner and rounded-corner annotation rectangles in the same selection.',
        itemIds: targetItems.map((item) => item.id),
        evidence: targetItems.map(
          (item) => `${item.id}: current shape ${item.shape}; standard ${normalizedShapeLabel}`
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
          title: 'Align card titles to a shared centerline',
          description:
            'Move title text in sibling cards back to the more stable shared centerline found in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.title.id),
          payload: { centerX: targetCenterX },
          expectedImpact:
            'Card titles will organize around one centerline instead of drifting around the shared axis.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: 'Card titles are not aligned to a shared centerline',
        summary:
          'The structure-first relationship check found these sibling card titles are organized around a shared centerline rather than stable left or right insets.',
        itemIds: offPatternCenterPairs.map((pair) => pair.title.id),
        evidence: offPatternCenterPairs.map(
          (pair) =>
            `${pair.title.id} in ${pair.container.id}: title center offset ${pair.centerOffset}px; target ${targetCenterOffset}px`
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
          title: 'Align card titles to a consistent left inset',
          description:
            'Move top text in sibling cards back to the most common left inset in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.title.id),
          payload: { x: targetX },
          expectedImpact:
            'Card titles will return to the same internal text column instead of drifting horizontally within related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Card title left insets are inconsistent',
        summary:
          'The structure-first relationship check found inconsistent left insets for top text in sibling cards.',
        itemIds: offPatternLeftInsetPairs.map((pair) => pair.title.id),
        evidence: offPatternLeftInsetPairs.map(
          (pair) =>
            `${pair.title.id} in ${pair.container.id}: left inset ${pair.leftInset}px; target ${targetLeftInset}px`
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
          title: 'Align card titles to a consistent top inset',
          description:
            'Move top text in sibling cards back to the most common top inset in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.title.id),
          payload: { y: targetY },
          expectedImpact:
            'Card titles will return to the same internal top-inset rhythm instead of drifting vertically across related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Card title top insets are inconsistent',
        summary:
          'The structure-first relationship check found inconsistent top insets for top text in sibling cards.',
        itemIds: offPatternTopInsetPairs.map((pair) => pair.title.id),
        evidence: offPatternTopInsetPairs.map(
          (pair) =>
            `${pair.title.id} in ${pair.container.id}: top inset ${pair.topInset}px; target ${targetTopInset}px`
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
          title: 'Align card header trailing text to a consistent right inset',
          description:
            'Move trailing header text in sibling cards back to the most common right inset in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.meta.id),
          payload: { x: targetRightX },
          expectedImpact:
            'Trailing header status, date, or tag text will return to consistent right-side padding instead of shifting across related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Card header trailing text right inset is inconsistent',
        summary:
          'The structure-first relationship check found trailing header text in sibling cards does not keep a consistent right inset.',
        itemIds: offPatternRightInsetPairs.map((pair) => pair.meta.id),
        evidence: offPatternRightInsetPairs.map(
          (pair) =>
            `${pair.meta.id} in ${pair.container.id}: right inset ${pair.rightInset}px; target ${targetRightInset}px`
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
          title: 'Align card info value column to a consistent right inset',
          description:
            'Move right-side value text in sibling card info blocks back to the most common right inset in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pairs.flatMap((pair) => pair.valueItems.map((item) => item.id)),
          payload: { x: targetRightX },
          expectedImpact:
            'Value columns inside card info blocks will return to consistent right-side padding instead of shifting across related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Card info value column right inset is inconsistent',
        summary:
          'The structure-first relationship check found right-side value text in sibling card info blocks does not keep a consistent right inset.',
        itemIds: offPatternMetaBlocks.flatMap((pair) => pair.valueItems.map((item) => item.id)),
        evidence: offPatternMetaBlocks.map(
          (pair) =>
            `${pair.valueItems.map((item) => item.id).join(', ')} in ${pair.container.id}: value-column right inset ${pair.rightInset}px; target ${targetRightInset}px`
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
          title: 'Align post-body info value column to a consistent right inset',
          description:
            'Move post-body info value text in sibling cards back to the most common right inset in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pairs.flatMap((pair) => pair.valueItems.map((item) => item.id)),
          payload: { x: targetRightX },
          expectedImpact:
            'Post-body info value columns will return to consistent right-side padding instead of shifting across related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Post-body info value column right inset is inconsistent',
        summary:
          'The structure-first relationship check found post-body info value text in sibling cards does not keep a consistent right inset.',
        itemIds: offPatternBodyMetaBlocks.flatMap((pair) => pair.valueItems.map((item) => item.id)),
        evidence: offPatternBodyMetaBlocks.map(
          (pair) =>
            `${pair.valueItems.map((item) => item.id).join(', ')} in ${pair.container.id}: value-column right inset ${pair.rightInset}px; target ${targetRightInset}px`
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
          title: 'Align pre-action info value column to a consistent right inset',
          description:
            'Move the two-column info value text between body copy and bottom actions back to the most common right-side padding in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pairs.flatMap((pair) => pair.valueItems.map((item) => item.id)),
          payload: { x: targetRightX },
          expectedImpact:
            'The value column before bottom actions will return to consistent right-side padding instead of shifting across related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Pre-action info value column right inset is inconsistent',
        summary:
          'The structure-first relationship check found info value columns between body copy and bottom actions do not keep a consistent right inset.',
        itemIds: offPatternBodyMetaFooterActions.flatMap((pair) =>
          pair.valueItems.map((item) => item.id)
        ),
        evidence: offPatternBodyMetaFooterActions.map(
          (pair) =>
            `${pair.valueItems.map((item) => item.id).join(', ')} in ${pair.container.id}: value-column right inset ${pair.rightInset}px; target ${targetRightInset}px`
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
          title: 'Normalize card label stack vertical spacing',
          description:
            'Adjust label text between body and footer in sibling cards so vertical spacing returns to the most common rhythm in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pair.items.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: pair.items[0].id
          },
          expectedImpact:
            'Label stacks inside cards will return to a consistent vertical rhythm instead of varying across related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Card label stack vertical spacing is inconsistent',
        summary:
          'The structure-first relationship check found label stacks between body and footer in sibling cards do not keep consistent vertical spacing.',
        itemIds: offPatternBadgeStacks.flatMap((pair) => pair.items.map((item) => item.id)),
        evidence: offPatternBadgeStacks.map(
          (pair) =>
            `${pair.items.map((item) => item.id).join(', ')} in ${pair.container.id}: label spacing ${pair.gap}px; target ${targetGap}px`
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
          title: 'Normalize trailing card label stack vertical spacing',
          description:
            'Adjust trailing label text after body copy in sibling cards so vertical spacing returns to the most common rhythm in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pair.items.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: pair.items[0].id
          },
          expectedImpact:
            'Trailing card label stacks will return to a consistent vertical rhythm instead of varying across related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Trailing card label stack vertical spacing is inconsistent',
        summary:
          'The structure-first relationship check found trailing label stacks after body copy in sibling cards do not keep consistent vertical spacing.',
        itemIds: offPatternBadgeStacks.flatMap((pair) => pair.items.map((item) => item.id)),
        evidence: offPatternBadgeStacks.map(
          (pair) =>
            `${pair.items.map((item) => item.id).join(', ')} in ${pair.container.id}: label spacing ${pair.gap}px; target ${targetGap}px`
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
          title: 'Normalize label stack spacing above card buttons',
          description:
            'Adjust label text between body copy and bottom buttons in sibling cards so vertical spacing returns to the most common rhythm in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pair.items.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: pair.items[0].id
          },
          expectedImpact:
            'Label stacks above card button rows will return to a consistent vertical rhythm instead of varying across related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Label stack vertical spacing above card buttons is inconsistent',
        summary:
          'The structure-first relationship check found label stacks between body copy and bottom buttons in sibling cards do not keep consistent vertical spacing.',
        itemIds: offPatternBadgeStacks.flatMap((pair) => pair.items.map((item) => item.id)),
        evidence: offPatternBadgeStacks.map(
          (pair) =>
            `${pair.items.map((item) => item.id).join(', ')} in ${pair.container.id}: label spacing ${pair.gap}px; target ${targetGap}px`
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
            title: 'Normalize card multi-column label spacing',
            description:
              'Adjust multi-column label text after body copy in sibling cards so each row returns to the most common horizontal rhythm in the structured geometry.',
            executor: 'magicpot-internal',
            targetItemIds: row.map((item) => item.id),
            payload: {
              gap: targetGap,
              anchorItemId: row[0].id
            },
            expectedImpact:
              'Multi-column label groups inside cards will return to a consistent horizontal rhythm instead of varying across related cards.'
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
            )} in ${pair.container.id}: label spacing ${pair.gap}px; target ${targetGap}px`
        )
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Card multi-column label spacing is inconsistent',
        summary:
          'The structure-first relationship check found multi-column label groups after body copy in sibling cards do not keep consistent horizontal spacing.',
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
            title: 'Normalize multi-column label spacing above card buttons',
            description:
              'Adjust multi-column label text after body copy and above bottom buttons so each row returns to the most common horizontal rhythm in the structured geometry.',
            executor: 'magicpot-internal',
            targetItemIds: row.map((item) => item.id),
            payload: {
              gap: targetGap,
              anchorItemId: row[0].id
            },
            expectedImpact:
              'Multi-column label groups above button rows will return to a consistent horizontal rhythm instead of varying across related cards.'
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
            )} in ${pair.container.id}: label spacing ${pair.gap}px; target ${targetGap}px`
        )
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Multi-column label spacing above card buttons is inconsistent',
        summary:
          'The structure-first relationship check found multi-column label groups above bottom button rows in sibling cards do not keep consistent horizontal spacing.',
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
          title: 'Normalize no-footer card trailing label stack spacing',
          description:
            'Adjust trailing label text in cards without a stable footer anchor so vertical spacing returns to the most common rhythm in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pair.items.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: pair.items[0].id
          },
          expectedImpact:
            'Trailing label stacks in cards without footer anchors will return to a consistent vertical rhythm instead of varying across related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'No-footer trailing label stack vertical spacing is inconsistent',
        summary:
          'The structure-first relationship check found trailing label stacks in sibling cards without stable footer anchors do not keep consistent vertical spacing.',
        itemIds: offPatternTrailingBadgeStacks.flatMap((pair) => pair.items.map((item) => item.id)),
        evidence: offPatternTrailingBadgeStacks.map(
          (pair) =>
            `${pair.items.map((item) => item.id).join(', ')} in ${pair.container.id}: label spacing ${pair.gap}px; target ${targetGap}px`
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
          title: 'Align card body to a consistent left inset',
          description:
            'Move body text in sibling cards back to the most common left inset in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.body.id),
          payload: { x: targetX },
          expectedImpact:
            'Card body text will return to the same internal text column instead of drifting horizontally within related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Card body left inset is inconsistent',
        summary:
          'The structure-first relationship check found body text in sibling cards uses different left insets.',
        itemIds: offPatternLeftInsetPairs.map((pair) => pair.body.id),
        evidence: offPatternLeftInsetPairs.map(
          (pair) =>
            `${pair.body.id} in ${pair.container.id}: left inset ${pair.leftInset}px; target ${targetLeftInset}px`
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
          title: 'Normalize vertical gap between card title and body',
          description:
            'Move body text in sibling cards so the gap between title and body returns to the most common rhythm.',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.body.id),
          payload: { y: targetY },
          expectedImpact:
            'Titles and body text inside cards will return to a consistent vertical hierarchy instead of uneven spacing.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Vertical gap between card title and body is inconsistent',
        summary:
          'The structure-first relationship check found sibling cards do not keep consistent vertical spacing between title and body.',
        itemIds: offPatternVerticalGapPairs.map((pair) => pair.body.id),
        evidence: offPatternVerticalGapPairs.map(
          (pair) =>
            `${pair.body.id} in ${pair.container.id}: title-to-body gap ${pair.verticalGap}px; target ${targetVerticalGap}px`
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
          title: 'Align card footer to a consistent bottom inset',
          description:
            'Move trailing text in sibling cards back to the most common bottom inset in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pairs.map((pair) => pair.footer.id),
          payload: { y: targetBottomY },
          expectedImpact:
            'Card footers will return to consistent bottom padding instead of drifting vertically across related cards.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Card footer bottom inset is inconsistent',
        summary:
          'The structure-first relationship check found trailing text in sibling cards uses different bottom insets.',
        itemIds: offPatternBottomInsetPairs.map((pair) => pair.footer.id),
        evidence: offPatternBottomInsetPairs.map(
          (pair) =>
            `${pair.footer.id} in ${pair.container.id}: bottom inset ${pair.bottomInset}px; target ${targetBottomInset}px`
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
          title: 'Normalize card footer action-row horizontal spacing',
          description:
            'Adjust adjacent text nodes in sibling card footer action rows so horizontal spacing returns to the most common rhythm in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: pair.items.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: pair.items[0].id
          },
          expectedImpact:
            'Action text in card footers will return to a consistent horizontal rhythm, avoiding one card with buttons that are too loose or too tight.'
        })
        actionIds.push(actionId)
      }

      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'spacing',
        severity: 'warning',
        title: 'Card footer action-row spacing is inconsistent',
        summary:
          'The structure-first relationship check found adjacent text nodes in sibling card footer action rows do not keep consistent horizontal spacing.',
        itemIds: offPatternFooterRows.flatMap((pair) => pair.items.map((item) => item.id)),
        evidence: offPatternFooterRows.map(
          (pair) =>
            `${pair.container.id}：${pair.items.map((item) => item.id).join(' / ')} current spacing ${pair.gap}px; target ${targetGap}px`
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
        title: 'Align vertical stack to a shared centerline',
        description:
          'Snap the selected vertical stack to the shared centerline implied by the structured bounds.',
        executor: 'magicpot-internal',
        targetItemIds: centerAlignedItems.map((item) => item.id),
        payload: { centerX: anchorCenterX },
        expectedImpact:
          'This column will read as arranged around one axis instead of drifting around a shared centerline.'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: 'Selected vertical stack is not center-aligned',
        summary:
          'Structured geometry shows items that appear to belong to the same vertical group have drifted away from a shared centerline.',
        itemIds: centerAlignedItems.map((item) => item.id),
        evidence: centerAlignedItems.map((item) => {
          const effectiveWidth = offPatternWidthItems.some((candidate) => candidate.id === item.id)
            ? (targetWidth ?? item.bounds.width)
            : item.bounds.width
          return `${item.id}: centerline ${roundMetric(item.bounds.x + effectiveWidth / 2)}px; target ${anchorCenterX}px`
        }),
        actionIds: [actionId]
      })
    } else if (!preferRightAlignment && misalignedItems.length > 0) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'align-left',
        title: 'Align vertical stack to a shared left edge',
        description:
          'Snap the selected vertical stack to the shared left edge implied by the structured bounds.',
        executor: 'magicpot-internal',
        targetItemIds: misalignedItems.map((item) => item.id),
        payload: { x: anchorLeft },
        expectedImpact:
          'This column will read as a clear vertical arrangement instead of a group of blocks drifting horizontally.'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: 'Selected vertical stack left edges are inconsistent',
        summary:
          'Structured geometry shows items that appear to belong to the same vertical group have different left edges.',
        itemIds: misalignedItems.map((item) => item.id),
        evidence: misalignedItems.map(
          (item) => `${item.id}: left edge ${roundMetric(item.bounds.x)}px; target ${anchorLeft}px`
        ),
        actionIds: [actionId]
      })
    }

    if (typeof targetWidth === 'number' && offPatternWidthItems.length > 0) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'normalize-item-width',
        title: 'Normalize card widths in vertical stack',
        description:
          'Resize block-level elements that deviate from the primary style so this vertical stack returns to the most common width in the structured geometry.',
        executor: 'magicpot-internal',
        targetItemIds: offPatternWidthItems.map((item) => item.id),
        payload: {
          width: targetWidth
        },
        expectedImpact:
          'This column will read as a unified card column instead of mixing different block widths.'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'geometry',
        severity: 'warning',
        title: 'Block widths in the selected vertical stack are inconsistent',
        summary:
          'Structure-first geometry automation found block-level elements in the same vertical stack use clearly different widths.',
        itemIds: offPatternWidthItems.map((item) => item.id),
        evidence: offPatternWidthItems.map(
          (item) => `${item.id}: width ${roundMetric(item.bounds.width)}px; target ${targetWidth}px`
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
          title: 'Normalize card heights in vertical stack',
          description:
            'Resize block-level elements that deviate from the primary style so this vertical stack returns to the most common height in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: offPatternHeightItems.map((item) => item.id),
          payload: {
            height: targetHeight
          },
          expectedImpact:
            'This column will read as a unified card column instead of mixing different block heights.'
        })
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'geometry',
          severity: 'warning',
          title: 'Block heights in the selected vertical stack are inconsistent',
          summary:
            'Structure-first geometry automation found block-level elements in the same vertical stack use clearly different heights.',
          itemIds: offPatternHeightItems.map((item) => item.id),
          evidence: offPatternHeightItems.map(
            (item) =>
              `${item.id}: height ${roundMetric(item.bounds.height)}px; target ${targetHeight}px`
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
        title: 'Align vertical stack to a shared right edge',
        description:
          'Snap the selected vertical stack to the shared right edge implied by the structured bounds.',
        executor: 'magicpot-internal',
        targetItemIds: rightAlignedItems.map((item) => item.id),
        payload: { x: anchorRight },
        expectedImpact:
          'This column will read as a clear right-aligned arrangement instead of drifting around the right edge.'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: 'Selected vertical stack right edges are inconsistent',
        summary:
          'Structured geometry shows items that appear to belong to the same vertical group have different right edges.',
        itemIds: rightAlignedItems.map((item) => item.id),
        evidence: rightAlignedItems.map(
          (item) =>
            `${item.id}: right edge ${roundMetric(item.bounds.x + item.bounds.width)}px; target ${anchorRight}px`
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
          title: 'Normalize vertical stack spacing',
          description:
            'Redistribute the selected vertical stack so adjacent spacing returns to the most common rhythm in this column.',
          executor: 'magicpot-internal',
          targetItemIds: verticalStack.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: verticalStack[0].id
          },
          expectedImpact: 'Vertical spacing will be more rhythmic and easier to scan quickly.'
        })
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'spacing',
          severity: 'warning',
          title: 'Vertical spacing is inconsistent',
          summary:
            'Structured geometry shows adjacent items in the same vertical stack do not have even vertical spacing.',
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
        title: 'Normalize selected grid card sizes',
        description:
          'Resize grid items that deviate from the primary style so the whole selection returns to the most common card size in the structured geometry.',
        executor: 'magicpot-internal',
        targetItemIds: offPatternSizeItems.map((item) => item.id),
        payload: {
          width: targetWidth,
          height: targetHeight
        },
        expectedImpact:
          'The grid will read as an intentional equal-size card matrix instead of mixing multiple sizes.'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'geometry',
        severity: 'warning',
        title: 'Grid item sizes are inconsistent',
        summary:
          'Structure-first geometry automation found clearly different widths or heights in this 2x2 card grid.',
        itemIds: offPatternSizeItems.map((item) => item.id),
        evidence: offPatternSizeItems.map(
          (item) =>
            `${item.id}：${roundMetric(item.bounds.width)}x${roundMetric(item.bounds.height)}; target ${targetWidth}x${targetHeight}`
        ),
        actionIds: [actionId]
      })
    }

    if (sizeCandidates.length >= 4) {
      const [topLeft, topRight, bottomLeft, bottomRight] = grid
      const gridColumns = [
        { label: 'left grid column', items: [topLeft, bottomLeft] },
        { label: 'right grid column', items: [topRight, bottomRight] }
      ]
      const gridRows = [
        { label: 'top grid row', items: [topLeft, topRight] },
        { label: 'bottom grid row', items: [bottomLeft, bottomRight] }
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
          title: `Align ${column.label} to a shared centerline`,
          description:
            'Recenter off-style grid items so this column shares one centerline based on the implied grid x position and dominant card width.',
          executor: 'magicpot-internal',
          targetItemIds: misalignedItems.map((item) => item.id),
          payload: {
            centerX: targetCenterX
          },
          expectedImpact:
            'Grid columns will read as clear vertical tracks instead of drifting centerlines.'
        })
        centerAlignedActionIds.push(actionId)
        for (const item of misalignedItems) {
          centerAlignedItemIds.add(item.id)
          centerAlignedEvidence.push(
            `${item.id}: centerline ${roundMetric(item.bounds.x + resolveEffectiveGridWidth(item) / 2)}px; target ${targetCenterX}px`
          )
        }
      }

      if (centerAlignedActionIds.length > 0) {
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'alignment',
          severity: 'warning',
          title: 'Grid columns are not center-aligned',
          summary:
            'Structure-first geometry automation found column centerlines in this 2x2 grid have drifted away from the implied grid tracks.',
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
          title: `Align ${row.label} to a shared middle line`,
          description:
            'Recenter off-style grid items so this row shares one middle line based on the implied grid y position and dominant card height.',
          executor: 'magicpot-internal',
          targetItemIds: misalignedItems.map((item) => item.id),
          payload: {
            centerY: targetCenterY
          },
          expectedImpact:
            'Grid rows will read as clear horizontal tracks instead of drifting middle lines.'
        })
        middleAlignedActionIds.push(actionId)
        for (const item of misalignedItems) {
          middleAlignedItemIds.add(item.id)
          middleAlignedEvidence.push(
            `${item.id}: middle line ${roundMetric(item.bounds.y + resolveEffectiveGridHeight(item) / 2)}px; target ${targetCenterY}px`
          )
        }
      }

      if (middleAlignedActionIds.length > 0) {
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'alignment',
          severity: 'warning',
          title: 'Grid rows are not middle-aligned',
          summary:
            'Structure-first geometry automation found row middle lines in this 2x2 grid have drifted away from the implied grid tracks.',
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
          label: index === 0 ? 'top 2x3 grid row' : 'bottom 2x3 grid row',
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
              title: 'Normalize 2x3 grid horizontal spacing',
              description:
                'Adjust the 2x3 grid row that deviates from the primary rhythm so its internal column spacing returns to the most common horizontal rhythm in the structured geometry.',
              executor: 'magicpot-internal',
              targetItemIds: row.items.map((item) => item.id),
              payload: {
                gap: targetGap,
                anchorItemId: row.items[0].id
              },
              expectedImpact:
                'This 2x3 grid will return to a steadier column-spacing rhythm instead of one row being compressed or stretched.'
            })
            actionIds.push(actionId)

            for (const item of row.items) {
              itemIds.add(item.id)
            }

            evidence.push(
              `${row.label}: adjacent spacing ${row.gaps.join(' / ')}px; target ${targetGap}px`
            )
          }

          issues.push({
            id: createDesignInspectionId('design-issue'),
            category: 'spacing',
            severity: 'warning',
            title: '2x3 grid row column spacing is inconsistent',
            summary:
              'The structure-first geometry check found at least one row in this 2x3 grid has internal column spacing that deviates from the primary rhythm established by the other row.',
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
    const columnLabels = ['left matrix column', 'middle matrix column', 'right matrix column']
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
          label: `Row ${index + 1} of the three-column matrix`,
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
              title: 'Normalize three-column matrix vertical rhythm',
              description:
                'Move the three-column multi-row matrix row that deviates from the primary rhythm back to the most common vertical rhythm in the structured geometry.',
              executor: 'magicpot-internal',
              targetItemIds: row.items.map((item) => item.id),
              payload: { y: targetY },
              expectedImpact:
                'This three-column matrix will return to a steadier row rhythm instead of a few whole rows drifting vertically.'
            })
            actionIds.push(actionId)

            for (const item of row.items) {
              itemIds.add(item.id)
            }

            evidence.push(
              `${row.label}: top y=${row.top}px; target ${targetY}px\uff0c` +
                ` current row spacing ${transition?.gaps.join(' / ') || '\u2014'}px\uff0c` +
                ` target rhythm ${dominantMatrixRowRhythm.transition.gap}px`
            )
          }

          issues.push({
            id: createDesignInspectionId('design-issue'),
            category: 'spacing',
            severity: 'warning',
            title: 'Three-column multi-row matrix vertical rhythm is inconsistent',
            summary:
              'The structure-first geometry check found a few whole rows in this three-column multi-row block matrix deviate from the primary vertical rhythm established by the other rows.',
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
            title: 'Normalize three-column matrix horizontal spacing',
            description:
              'Adjust the three-column multi-row matrix row that deviates from the primary rhythm so its internal column spacing returns to the most common horizontal rhythm in the structured geometry.',
            executor: 'magicpot-internal',
            targetItemIds: row.items.map((item) => item.id),
            payload: {
              gap: targetGap,
              anchorItemId: row.items[0].id
            },
            expectedImpact:
              'This three-column matrix will return to a steadier column-spacing rhythm instead of one row being compressed or stretched.'
          })
          actionIds.push(actionId)

          for (const item of row.items) {
            itemIds.add(item.id)
            suppressedCenterlineItemIds.add(item.id)
          }

          evidence.push(
            `${row.label}: adjacent spacing ${row.gaps.join(' / ')}px; target ${targetGap}px`
          )
        }

        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'spacing',
          severity: 'warning',
          title: 'Three-column multi-row matrix row column spacing is inconsistent',
          summary:
            'The structure-first geometry check found at least one row in this three-column multi-row block matrix has internal column spacing that deviates from the primary rhythm established by the other rows.',
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
        title: `${columnLabels[columnIndex]} to a shared centerline`,
        description:
          'Recenter block elements that deviate from column tracks in the three-column multi-row matrix so each column returns to the most common x-axis centerline in the structured geometry.',
        executor: 'magicpot-internal',
        targetItemIds: misalignedItems.map((item) => item.id),
        payload: {
          centerX: targetCenterX
        },
        expectedImpact:
          'This three-column matrix will return to clearer column tracks instead of some cells drifting horizontally.'
      })
      centerlineActionIds.push(actionId)

      for (const item of misalignedItems) {
        centerlineItemIds.add(item.id)
        centerlineEvidence.push(
          `${item.id} in ${columnLabels[columnIndex]}: centerline ${roundMetric(
            item.bounds.x + item.bounds.width / 2
          )}px; target ${targetCenterX}px`
        )
      }
    }

    if (centerlineActionIds.length > 0) {
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: 'Three-column matrix column centerlines are inconsistent',
        summary:
          'The structure-first geometry check found some cells in this three-column multi-row block matrix have drifted away from their column centerlines.',
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
      'left variable-width matrix column',
      'middle variable-width matrix column',
      'right variable-width matrix column'
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

          const rowLabel = `Row ${rowIndex + 1} of the variable-width three-column matrix`
          const actionId = createDesignInspectionId('design-action')
          actions.push({
            id: actionId,
            type: 'shift-horizontal',
            title: `${rowLabel} returns to the established mixed column anchors`,
            description:
              'Shift this entire row horizontally back to the more stable structural position established by other rows across left-track, centerline, and right-track anchors without changing the row order.',
            executor: 'magicpot-internal',
            targetItemIds: row.map((item) => item.id),
            payload: {
              deltaX: roundMetric(-dominantDelta)
            },
            expectedImpact:
              'This row will return as a whole to the established mixed column anchors instead of sliding into a full-row offset between tracks.'
          })
          rowShiftActionIds.push(actionId)

          for (const item of row) {
            rowShiftItemIds.add(item.id)
            suppressedGraphItemIds.add(item.id)
          }

          rowShiftEvidence.push(
            `${rowLabel}: whole-row offset from mixed column anchors ${dominantDelta}px\uff08${deltas.join(
              ' / '
            )}px; tracks ${dominantTracks
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
          title: `${stat.label} to a shared left track`,
          description:
            'Adjust the variable-width but still clearly related three-column multi-row matrix so blocks that deviate from the left track return to the most stable left anchor in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: leftMisalignedItems.map((item) => item.id),
          payload: {
            x: stat.targetLeftX
          },
          expectedImpact:
            'This variable-width three-column matrix will return to clearer left column tracks instead of a few blocks sliding out of the column relationship.'
        })
        leftActionIds.push(actionId)

        for (const item of leftMisalignedItems) {
          leftItemIds.add(item.id)
          leftEvidence.push(
            `${item.id} in ${stat.label}: left x=${roundMetric(
              item.bounds.x
            )}px; target ${stat.targetLeftX}px`
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
          title: `${stat.label} to a shared centerline`,
          description:
            'Adjust the variable-width but still clearly related three-column multi-row matrix so blocks that deviate from the centerline track return to the most stable column centerline in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: centerMisalignedItems.map((item) => item.id),
          payload: {
            centerX: stat.targetCenterX
          },
          expectedImpact:
            'This variable-width three-column matrix will return to clearer column centerlines instead of a few blocks sliding out of the shared column tracks.'
        })
        centerActionIds.push(actionId)

        for (const item of centerMisalignedItems) {
          centerItemIds.add(item.id)
          centerEvidence.push(
            `${item.id} in ${stat.label}: centerline ${roundMetric(
              item.bounds.x + item.bounds.width / 2
            )}px; target ${stat.targetCenterX}px`
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
        title: `${stat.label} to a shared right track`,
        description:
          'Adjust the variable-width but still clearly related three-column multi-row matrix so blocks that deviate from the right track return to the most stable right anchor in the structured geometry.',
        executor: 'magicpot-internal',
        targetItemIds: rightMisalignedItems.map((item) => item.id),
        payload: {
          x: stat.targetRightX
        },
        expectedImpact:
          'This variable-width three-column matrix will return to clearer right column tracks instead of a few blocks sliding out of the column relationship.'
      })
      rightActionIds.push(actionId)

      for (const item of rightMisalignedItems) {
        rightItemIds.add(item.id)
        rightEvidence.push(
          `${item.id} in ${stat.label}: right x=${roundMetric(
            item.bounds.x + item.bounds.width
          )}px; target ${stat.targetRightX}px`
        )
      }
    }

    if (rowShiftActionIds.length > 0) {
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: 'Variable-width three-column matrix row drifts across mixed anchors',
        summary:
          'The looser structural relationship check found at least one whole row in this variable-width three-column multi-row block matrix has shifted horizontally relative to the established left-track, centerline, and right-track combination.',
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
        title: 'Variable-width three-column matrix left column track is inconsistent',
        summary:
          'The looser structural relationship check found at least one column in this variable-width three-column multi-row block matrix has a left anchor that does not return to the primary track established by other rows.',
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
        title: 'Variable-width three-column matrix column centerline is inconsistent',
        summary:
          'The looser structural relationship check found at least one column in this variable-width three-column multi-row block matrix has a centerline that does not return to the primary track established by other rows.',
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
        title: 'Variable-width three-column matrix right column track is inconsistent',
        summary:
          'The looser structural relationship check found at least one column in this variable-width three-column multi-row block matrix has a right anchor that does not return to the primary track established by other rows.',
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
        title: 'Align horizontal row to a shared middle line',
        description:
          'Snap the selected horizontal row to the shared middle line implied by the structured bounds.',
        executor: 'magicpot-internal',
        targetItemIds: middleAlignedItems.map((item) => item.id),
        payload: { centerY: anchorMiddleY },
        expectedImpact:
          'This row will read as a band arranged around one middle line instead of drifting vertically around the shared axis.'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: 'Selected horizontal row is not middle-aligned',
        summary:
          'Structured geometry shows items that appear to belong to the same horizontal group have drifted away from a shared middle line.',
        itemIds: middleAlignedItems.map((item) => item.id),
        evidence: middleAlignedItems.map((item) => {
          const effectiveHeight = offPatternHeightItems.some(
            (candidate) => candidate.id === item.id
          )
            ? (targetHeight ?? item.bounds.height)
            : item.bounds.height
          return `${item.id}: middle line ${roundMetric(item.bounds.y + effectiveHeight / 2)}px; target ${anchorMiddleY}px`
        }),
        actionIds: [actionId]
      })
    } else if (!preferBottomAlignment && misalignedItems.length > 0) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'align-top',
        title: 'Align horizontal row to a shared top edge',
        description:
          'Snap the selected horizontal row to the shared top edge implied by the structured bounds.',
        executor: 'magicpot-internal',
        targetItemIds: misalignedItems.map((item) => item.id),
        payload: { y: anchorTop },
        expectedImpact:
          'This row will read as a clear horizontal band instead of a group of cards drifting vertically.'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: 'Selected horizontal row top edges are inconsistent',
        summary:
          'Structured geometry shows items that appear to belong to the same horizontal group have different top edges.',
        itemIds: misalignedItems.map((item) => item.id),
        evidence: misalignedItems.map(
          (item) => `${item.id}: top edge ${roundMetric(item.bounds.y)}px; target ${anchorTop}px`
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
          title: 'Normalize horizontal row spacing',
          description:
            'Redistribute the selected horizontal row so adjacent spacing returns to the most common rhythm in this row.',
          executor: 'magicpot-internal',
          targetItemIds: horizontalRow.map((item) => item.id),
          payload: {
            gap: targetGap,
            anchorItemId: horizontalRow[0].id
          },
          expectedImpact: 'Horizontal spacing will be more rhythmic and easier to scan quickly.'
        })
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'spacing',
          severity: 'warning',
          title: 'Horizontal spacing is inconsistent',
          summary:
            'Structured geometry shows adjacent items in the same horizontal row do not have even horizontal spacing.',
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
          title: 'Normalize card widths in horizontal row',
          description:
            'Resize block-level elements that deviate from the primary style so this horizontal row returns to the most common width in the structured geometry.',
          executor: 'magicpot-internal',
          targetItemIds: offPatternWidthItems.map((item) => item.id),
          payload: {
            width: targetWidth
          },
          expectedImpact:
            'This row will read as a unified card band instead of mixing different block widths.'
        })
        issues.push({
          id: createDesignInspectionId('design-issue'),
          category: 'geometry',
          severity: 'warning',
          title: 'Block widths in the selected horizontal row are inconsistent',
          summary:
            'Structure-first geometry automation found block-level elements in the same horizontal row use clearly different widths.',
          itemIds: offPatternWidthItems.map((item) => item.id),
          evidence: offPatternWidthItems.map(
            (item) =>
              `${item.id}: width ${roundMetric(item.bounds.width)}px; target ${targetWidth}px`
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
        title: 'Normalize card heights in horizontal row',
        description:
          'Resize block-level elements that deviate from the primary style so this horizontal row returns to the most common height in the structured geometry.',
        executor: 'magicpot-internal',
        targetItemIds: offPatternHeightItems.map((item) => item.id),
        payload: {
          height: targetHeight
        },
        expectedImpact:
          'This row will read as a unified card band instead of mixing different block heights.'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'geometry',
        severity: 'warning',
        title: 'Block heights in the selected horizontal row are inconsistent',
        summary:
          'Structure-first geometry automation found block-level elements in the same horizontal row use clearly different heights.',
        itemIds: offPatternHeightItems.map((item) => item.id),
        evidence: offPatternHeightItems.map(
          (item) =>
            `${item.id}: height ${roundMetric(item.bounds.height)}px; target ${targetHeight}px`
        ),
        actionIds: [actionId]
      })
    }

    if (!preferMiddleAlignment && preferBottomAlignment) {
      const actionId = createDesignInspectionId('design-action')
      actions.push({
        id: actionId,
        type: 'align-bottom',
        title: 'Align horizontal row to a shared bottom edge',
        description:
          'Snap the selected horizontal row to the shared bottom edge implied by the structured bounds.',
        executor: 'magicpot-internal',
        targetItemIds: bottomAlignedItems.map((item) => item.id),
        payload: { y: anchorBottom },
        expectedImpact:
          'This row will read as a clear bottom-aligned arrangement instead of drifting around the bottom edge.'
      })
      issues.push({
        id: createDesignInspectionId('design-issue'),
        category: 'alignment',
        severity: 'warning',
        title: 'Selected horizontal row bottom edges are inconsistent',
        summary:
          'Structured geometry shows items that appear to belong to the same horizontal group have different bottom edges.',
        itemIds: bottomAlignedItems.map((item) => item.id),
        evidence: bottomAlignedItems.map(
          (item) =>
            `${item.id}: bottom edge ${roundMetric(item.bounds.y + item.bounds.height)}px; target ${anchorBottom}px`
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
        ? `Found ${issues.length} structure-first issue(s) and prepared ${actions.length} internal action(s) requiring approval.`
        : 'No typography, spacing, alignment, radius, or geometry issues were detected in the current selection.',
    issues,
    actions,
    rationale:
      issues.length > 0
        ? 'This proposal is generated from explicit canvas geometry and text attributes, and it only includes actions that run inside MagicPot after user approval.'
        : 'Structured canvas data did not show typography, spacing, alignment, radius, or geometry deviations worth applying automatically.',
    expectedResult:
      issues.length > 0
        ? 'After approval, the current selection should read as a more unified system with more consistent alignment, spacing, text styling, corner treatment, and block geometry.'
        : 'The current selection does not need structure-first fixes and can stay as it is.',
    executionPlan
  }

  if (provenanceNarrative) {
    proposal.summary = `${proposal.summary}${provenanceNarrative.summarySuffix}`
    proposal.rationale = `${proposal.rationale}${provenanceNarrative.rationaleSuffix}`
  }

  return proposal
}
