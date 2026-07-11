import type {
  DesignInspectionAction,
  DesignInspectionApproval,
  DesignInspectionExecutionResult,
  DesignInspectionProposal,
  DesignInspectionTraceEntry
} from '@shared/designInspection'
import { buildCanvasFileContentUpdate } from './canvasAgentAttachmentUtils'
import {
  createDesignInspectionId,
  createDesignInspectionTraceEntry,
  roundDesignInspectionMetric
} from './designInspectionCommon'
import type { CanvasItem } from './types'

export type ApplyDesignInspectionProposalResult = {
  items: CanvasItem[]
  result: DesignInspectionExecutionResult
}

function normalizeMultilineContent(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function formatApprovalStatusForTrace(status: DesignInspectionApproval['status']): string {
  switch (status) {
    case 'approved':
      return 'approved'
    case 'rejected':
      return 'rejected'
    case 'retry_requested':
      return 'retry requested'
    case 'pending':
    default:
      return 'pending'
  }
}

function createExecutionAppliedTrace(action: DesignInspectionAction): DesignInspectionTraceEntry {
  return createDesignInspectionTraceEntry('execution_applied', `Applied action: ${action.title}。`)
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
    createDesignInspectionTraceEntry(
      'approval_recorded',
      `Recorded approval status "${formatApprovalStatusForTrace(approval.status)}" for ${approvedActionIds.size} action(s).`
    )
  ]

  let nextItems = [...items]

  for (const action of proposal.actions) {
    if (!approvedActionIds.has(action.id)) continue

    if (action.type === 'align-top') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        if (roundDesignInspectionMetric(item.y) === roundDesignInspectionMetric(action.payload.y)) {
          return item
        }
        return updateCanvasItem(
          item,
          { y: action.payload.y },
          'y',
          `Set ${item.id} to y=${action.payload.y}。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'align-bottom') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        const visualHeight = roundDesignInspectionMetric(item.height * Math.abs(item.scaleY || 1))
        const nextY = roundDesignInspectionMetric(action.payload.y - visualHeight)
        if (roundDesignInspectionMetric(item.y) === nextY) return item
        return updateCanvasItem(
          item,
          { y: nextY },
          'y',
          `Set ${item.id} bottom edge to y=${action.payload.y}。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'align-left') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        if (roundDesignInspectionMetric(item.x) === roundDesignInspectionMetric(action.payload.x)) {
          return item
        }
        return updateCanvasItem(
          item,
          { x: action.payload.x },
          'x',
          `Set ${item.id} to x=${action.payload.x}。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'shift-horizontal') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        const nextX = roundDesignInspectionMetric(item.x + action.payload.deltaX)
        if (roundDesignInspectionMetric(item.x) === nextX) return item
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
        const visualWidth = roundDesignInspectionMetric(item.width * scaleX)
        const nextX = roundDesignInspectionMetric(action.payload.centerX - visualWidth / 2)
        if (roundDesignInspectionMetric(item.x) === nextX) return item

        return updateCanvasItem(
          item,
          { x: nextX },
          'x',
          `Set ${item.id} centerline to x=${action.payload.centerX}。`,
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
        const visualHeight = roundDesignInspectionMetric(item.height * scaleY)
        const nextY = roundDesignInspectionMetric(action.payload.centerY - visualHeight / 2)
        if (roundDesignInspectionMetric(item.y) === nextY) return item

        return updateCanvasItem(
          item,
          { y: nextY },
          'y',
          `Set ${item.id} middle line to y=${action.payload.centerY}。`,
          appliedChanges
        )
      })
      trace.push(createExecutionAppliedTrace(action))
      continue
    }

    if (action.type === 'align-right') {
      nextItems = nextItems.map((item) => {
        if (!action.targetItemIds.includes(item.id)) return item
        const visualWidth = roundDesignInspectionMetric(item.width * Math.abs(item.scaleX || 1))
        const nextX = roundDesignInspectionMetric(action.payload.x - visualWidth)
        if (roundDesignInspectionMetric(item.x) === nextX) return item
        return updateCanvasItem(
          item,
          { x: nextX },
          'x',
          `Set ${item.id} right edge to x=${action.payload.x}。`,
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
          if (roundDesignInspectionMetric(item.x) === roundDesignInspectionMetric(nextX)) {
            return item
          }
          return updateCanvasItem(
            item,
            { x: nextX },
            'x',
            `Adjusted ${item.id} to keep horizontal spacing at ${action.payload.gap}px。`,
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
          if (roundDesignInspectionMetric(item.y) === roundDesignInspectionMetric(nextY)) {
            return item
          }
          return updateCanvasItem(
            item,
            { y: nextY },
            'y',
            `Adjusted ${item.id} to keep vertical spacing at ${action.payload.gap}px。`,
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
            `Normalized ${item.id} text style.`,
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
            `Normalized ${item.id} attached annotation text style.`,
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
          `Set ${item.id} corner style to ${action.payload.shape}。`,
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
        const nextWidth = roundDesignInspectionMetric(action.payload.width / scaleX)
        if (roundDesignInspectionMetric(item.width) === nextWidth) return item

        return updateCanvasItem(
          item,
          { width: nextWidth },
          'item-width',
          `Set ${item.id} width to ${action.payload.width}px visible width.`,
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
        const nextHeight = roundDesignInspectionMetric(action.payload.height / scaleY)
        if (roundDesignInspectionMetric(item.height) === nextHeight) return item

        return updateCanvasItem(
          item,
          { height: nextHeight },
          'item-height',
          `Set ${item.id} height to ${action.payload.height}px visible height.`,
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
        const nextWidth = roundDesignInspectionMetric(action.payload.width / scaleX)
        const nextHeight = roundDesignInspectionMetric(action.payload.height / scaleY)

        if (
          roundDesignInspectionMetric(item.width) === nextWidth &&
          roundDesignInspectionMetric(item.height) === nextHeight
        ) {
          return item
        }

        return updateCanvasItem(
          item,
          { width: nextWidth, height: nextHeight },
          'item-size',
          `Set ${item.id} size to ${action.payload.width}x${action.payload.height}px visible size.`,
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
          `Updated ${item.id} editable file content.`,
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
