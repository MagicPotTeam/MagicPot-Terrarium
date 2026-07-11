import { describe, expect, it, vi } from 'vitest'
import type { DesignInspectionApproval } from '@shared/designInspection'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasImageItem,
  CanvasItem,
  CanvasTextItem
} from './types'
import {
  applyDesignInspectionProposal,
  buildDesignInspectionContextPack,
  buildStructureFirstDesignInspectionProposal,
  requestDesignInspectionProposalFromAgent
} from './designInspectionWorkflow'

function createTextItem(id: string, overrides: Partial<CanvasTextItem> = {}): CanvasTextItem {
  return {
    id,
    type: 'text',
    text: `Text ${id}`,
    fontSize: 24,
    fontFamily: 'Inter',
    fill: '#111111',
    fontWeight: 'bold',
    x: 40,
    y: 40,
    width: 180,
    height: 48,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function createFileItem(id: string, overrides: Partial<CanvasFileItem> = {}): CanvasFileItem {
  return {
    id,
    type: 'file',
    src: `file:///C:/magicpot/${id}.md`,
    fileName: `${id}.md`,
    mimeType: 'text/markdown',
    fileKind: 'markdown',
    previewText: `Preview for ${id}`,
    content: `Preview for ${id}`,
    editable: true,
    x: 12,
    y: 280,
    width: 240,
    height: 120,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 3,
    locked: false,
    ...overrides
  }
}

function createImageItem(id: string, overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `file:///C:/magicpot/${id}.png`,
    fileName: `${id}.png`,
    x: 320,
    y: 64,
    width: 160,
    height: 160,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 4,
    locked: false,
    ...overrides
  }
}

function createAnnotationItem(
  id: string,
  overrides: Partial<CanvasAnnotationItem> = {}
): CanvasAnnotationItem {
  return {
    id,
    type: 'annotation',
    shape: 'rect',
    stroke: '#7c3aed',
    fillOpacity: 0.18,
    strokeWidth: 2,
    label: `Label ${id}`,
    x: 40,
    y: 40,
    width: 220,
    height: 96,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    ...overrides
  }
}

describe('designInspectionWorkflow', () => {
  it('builds a structure-first context pack with documents, references, rules, and fallback signals', () => {
    const items: CanvasItem[] = [
      createTextItem('title-1', {
        provenance: {
          kind: 'figma',
          sourceDocumentId: 'figma-file-1',
          sourceNodeId: 'headline-node',
          sourceNodeName: 'Headline'
        }
      }),
      createFileItem('brief-1', {
        provenance: {
          kind: 'imported-file',
          sourceFileName: 'marketing-brief.md',
          notes: 'Imported from the workspace brief folder.'
        }
      }),
      createImageItem('ref-1', {
        provenance: {
          kind: 'external',
          sourceDocumentId: 'agent-thread-7',
          bridgeTraceId: 'bridge-7'
        }
      })
    ]

    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      targetItems: items,
      groups: [
        {
          id: 'group-1',
          name: 'Cards',
          itemIds: ['title-1', 'brief-1'],
          createdAt: '2026-03-27T00:00:00.000Z'
        }
      ],
      snapshotDataUrl: 'data:image/png;base64,abc'
    })

    expect(contextPack.selection.itemIds).toEqual(['title-1', 'brief-1', 'ref-1'])
    expect(contextPack.selection.groupIds).toEqual(['group-1'])
    expect(contextPack.documents).toEqual([
      expect.objectContaining({
        itemId: 'brief-1',
        fileName: 'brief-1.md',
        previewText: 'Preview for brief-1'
      })
    ])
    expect(contextPack.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'ref-1', type: 'image' }),
        expect.objectContaining({ itemId: 'group-1', type: 'group' })
      ])
    )
    expect(contextPack.canvasSnapshot).toEqual(
      expect.objectContaining({
        type: 'image',
        url: 'data:image/png;base64,abc'
      })
    )
    expect(contextPack.rules).toHaveLength(3)
    expect(contextPack.selectionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'title-1',
          provenance: expect.objectContaining({
            kind: 'figma',
            sourceDocumentId: 'figma-file-1',
            sourceNodeId: 'headline-node'
          })
        }),
        expect.objectContaining({
          id: 'brief-1',
          provenance: expect.objectContaining({
            kind: 'imported-file',
            sourceFileName: 'marketing-brief.md'
          })
        }),
        expect.objectContaining({
          id: 'ref-1',
          provenance: expect.objectContaining({
            kind: 'external',
            bridgeTraceId: 'bridge-7'
          })
        })
      ])
    )
    expect(contextPack.fallbackSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'snapshot' }),
        expect.objectContaining({ type: 'geometry-measurement' })
      ])
    )
  })

  it('preserves the actual file editability flag in context-pack documents', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected docs.',
      targetItems: [
        createFileItem('readonly-brief', {
          editable: false,
          previewText: 'Preview only',
          content: undefined
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    expect(contextPack.documents).toEqual([
      expect.objectContaining({
        itemId: 'readonly-brief',
        editable: false,
        previewText: 'Preview only'
      })
    ])
  })

  it('drafts typography, alignment, and spacing fixes from structured canvas data', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createTextItem('title-1', { x: 40, y: 40 }),
        createTextItem('title-2', {
          x: 56,
          y: 112,
          fontSize: 18,
          fontFamily: 'Arial',
          fontWeight: 'normal'
        }),
        createTextItem('title-3', { x: 44, y: 196, fontSize: 24 })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)

    expect(proposal.issues).toHaveLength(3)
    expect(proposal.actions.map((action) => action.type)).toEqual([
      'normalize-text-style',
      'align-left',
      'distribute-vertical-spacing'
    ])
    expect(proposal.executionPlan).toHaveLength(3)
  })

  it('drafts radius fixes from structured annotation corner styles', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', { shape: 'rounded-rect', x: 40, y: 40 }),
        createAnnotationItem('card-2', { shape: 'rect', x: 40, y: 168 }),
        createAnnotationItem('card-3', { shape: 'rounded-rect', x: 40, y: 296 })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const radiusAction = proposal.actions.find(
      (action) => action.type === 'normalize-annotation-corner-style'
    )
    const radiusIssue = proposal.issues.find((issue) => issue.category === 'radius')

    expect(radiusAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-2'],
        payload: { shape: 'rounded-rect' }
      })
    )
    expect(radiusIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-2'],
        title: 'Rectangular annotation cards use mixed corner styles'
      })
    )
  })

  it('adds source-aware provenance narrative to the structure-first proposal when selection origins are known', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createTextItem('title-1', {
          x: 40,
          y: 40,
          provenance: {
            kind: 'figma',
            sourceDocumentId: 'figma-file-1',
            sourceNodeName: 'Headline'
          }
        }),
        createTextItem('title-2', {
          x: 56,
          y: 112,
          fontSize: 18,
          fontFamily: 'Arial',
          fontWeight: 'normal',
          provenance: {
            kind: 'imported-file',
            sourceFileName: 'headline-options.md'
          }
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)

    expect(proposal.summary).toContain('Source: Figma 1, Imported file 1.')
    expect(proposal.rationale).toContain(
      'Current source context: Figma 1, Imported file 1; MagicPot canvas elements and geometry remain the runtime inspection truth.'
    )
    expect(proposal.rationale).toContain('Text title-1')
    expect(proposal.rationale).toContain('Figma')
    expect(proposal.rationale).toContain('Headline')
    expect(proposal.rationale).toContain('Text title-2')
    expect(proposal.rationale).toContain('headline-options.md')
  })

  it('drafts card-title inset fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 200,
          width: 220,
          height: 120
        }),
        createTextItem('title-2', { x: 84, y: 228, width: 120, height: 32 }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 360,
          width: 220,
          height: 120
        }),
        createTextItem('title-3', { x: 64, y: 380, width: 120, height: 32 })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const leftInsetAction = proposal.actions.find((action) => action.type === 'align-left')
    const topInsetAction = proposal.actions.find((action) => action.type === 'align-top')
    const leftInsetIssue = proposal.issues.find(
      (issue) => issue.title === 'Card title left insets are inconsistent'
    )
    const topInsetIssue = proposal.issues.find(
      (issue) => issue.title === 'Card title top insets are inconsistent'
    )

    expect(proposal.actions).toHaveLength(2)
    expect(leftInsetAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['title-2'],
        payload: { x: 64 }
      })
    )
    expect(topInsetAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['title-2'],
        payload: { y: 220 }
      })
    )
    expect(leftInsetIssue).toEqual(
      expect.objectContaining({
        itemIds: ['title-2'],
        category: 'spacing'
      })
    )
    expect(topInsetIssue).toEqual(
      expect.objectContaining({
        itemIds: ['title-2'],
        category: 'spacing'
      })
    )
  })

  it('drafts card-title centerline fixes when center alignment is more stable than left or right insets', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createTextItem('title-1', { x: 110, y: 60, width: 80, height: 32 }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 200,
          width: 220,
          height: 120
        }),
        createTextItem('title-2', { x: 80, y: 220, width: 120, height: 32 }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 360,
          width: 220,
          height: 120
        }),
        createTextItem('title-3', { x: 70, y: 380, width: 160, height: 32 })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const centerAction = proposal.actions.find(
      (action) => action.type === 'align-center' && action.targetItemIds.includes('title-2')
    )
    const leftInsetAction = proposal.actions.find(
      (action) => action.type === 'align-left' && action.targetItemIds.includes('title-2')
    )
    const centerIssue = proposal.issues.find(
      (issue) => issue.title === 'Card titles are not aligned to a shared centerline'
    )

    expect(centerAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['title-2'],
        payload: { centerX: 150 }
      })
    )
    expect(leftInsetAction).toBeUndefined()
    expect(centerIssue).toEqual(
      expect.objectContaining({
        itemIds: ['title-2'],
        category: 'alignment'
      })
    )
  })

  it('drafts card-header meta right inset fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 160
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('meta-1', {
          x: 204,
          y: 60,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 240,
          width: 220,
          height: 160
        }),
        createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
        createTextItem('meta-2', {
          x: 184,
          y: 260,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('body-2', { x: 64, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 440,
          width: 220,
          height: 160
        }),
        createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
        createTextItem('meta-3', {
          x: 204,
          y: 460,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const metaAction = proposal.actions.find(
      (action) => action.type === 'align-right' && action.targetItemIds.includes('meta-2')
    )
    const metaIssue = proposal.issues.find(
      (issue) => issue.title === 'Card header trailing text right inset is inconsistent'
    )
    const footerIssue = proposal.issues.find(
      (issue) => issue.title === 'Card footer bottom inset is inconsistent'
    )

    expect(metaAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['meta-2'],
        payload: { x: 240 }
      })
    )
    expect(metaIssue).toEqual(
      expect.objectContaining({
        itemIds: ['meta-2'],
        category: 'spacing'
      })
    )
    expect(footerIssue).toBeUndefined()
  })

  it('still drafts body inset fixes when cards include a separate header meta text', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 160
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('meta-1', {
          x: 204,
          y: 60,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 240,
          width: 220,
          height: 160
        }),
        createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
        createTextItem('meta-2', {
          x: 204,
          y: 260,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('body-2', { x: 84, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 440,
          width: 220,
          height: 160
        }),
        createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
        createTextItem('meta-3', {
          x: 204,
          y: 460,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const bodyAction = proposal.actions.find(
      (action) => action.type === 'align-left' && action.targetItemIds.includes('body-2')
    )
    const bodyIssue = proposal.issues.find(
      (issue) => issue.title === 'Card body left inset is inconsistent'
    )
    const footerIssue = proposal.issues.find(
      (issue) => issue.title === 'Card footer bottom inset is inconsistent'
    )

    expect(bodyAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['body-2'],
        payload: { x: 64 }
      })
    )
    expect(bodyIssue).toEqual(
      expect.objectContaining({
        itemIds: ['body-2'],
        category: 'spacing'
      })
    )
    expect(footerIssue).toBeUndefined()
  })

  it('drafts card meta-block value-column fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 180
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('label-a-1', {
          x: 64,
          y: 104,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-1', {
          x: 184,
          y: 104,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('label-b-1', {
          x: 64,
          y: 136,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-b-1', {
          x: 192,
          y: 136,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-1', {
          x: 64,
          y: 188,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 240,
          width: 220,
          height: 180
        }),
        createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
        createTextItem('label-a-2', {
          x: 64,
          y: 304,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-2', {
          x: 164,
          y: 304,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('label-b-2', {
          x: 64,
          y: 336,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-b-2', {
          x: 172,
          y: 336,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-2', {
          x: 64,
          y: 388,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 440,
          width: 220,
          height: 180
        }),
        createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
        createTextItem('label-a-3', {
          x: 64,
          y: 504,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-3', {
          x: 184,
          y: 504,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('label-b-3', {
          x: 64,
          y: 536,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-b-3', {
          x: 192,
          y: 536,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-3', {
          x: 64,
          y: 588,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const metaBlockAction = proposal.actions.find(
      (action) =>
        action.type === 'align-right' &&
        action.targetItemIds.includes('value-a-2') &&
        action.targetItemIds.includes('value-b-2')
    )
    const metaBlockIssue = proposal.issues.find(
      (issue) => issue.title === 'Card info value column right inset is inconsistent'
    )
    const footerRowIssue = proposal.issues.find(
      (issue) => issue.title === 'Card footer action-row spacing is inconsistent'
    )

    expect(metaBlockAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['value-a-2', 'value-b-2'],
        payload: { x: 240 }
      })
    )
    expect(metaBlockIssue).toEqual(
      expect.objectContaining({
        itemIds: ['value-a-2', 'value-b-2'],
        category: 'spacing'
      })
    )
    expect(footerRowIssue).toBeUndefined()
  })

  it('drafts card badge-stack spacing fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 220
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-1', {
          x: 64,
          y: 144,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-1', {
          x: 64,
          y: 176,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-1', {
          x: 64,
          y: 228,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 240,
          width: 220,
          height: 220
        }),
        createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-2', {
          x: 64,
          y: 344,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-2', {
          x: 64,
          y: 388,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-2', {
          x: 64,
          y: 428,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 440,
          width: 220,
          height: 220
        }),
        createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-3', {
          x: 64,
          y: 544,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-3', {
          x: 64,
          y: 576,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-3', {
          x: 64,
          y: 628,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const badgeStackAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-vertical-spacing' &&
        action.targetItemIds.includes('badge-a-2') &&
        action.targetItemIds.includes('badge-b-2')
    )
    const badgeStackIssue = proposal.issues.find(
      (issue) => issue.title === 'Card label stack vertical spacing is inconsistent'
    )
    const tailBadgeIssue = proposal.issues.find(
      (issue) => issue.title === 'Trailing card label stack vertical spacing is inconsistent'
    )

    expect(badgeStackAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['badge-a-2', 'badge-b-2'],
        payload: {
          gap: 12,
          anchorItemId: 'badge-a-2'
        }
      })
    )
    expect(badgeStackIssue).toEqual(
      expect.objectContaining({
        itemIds: ['badge-a-2', 'badge-b-2'],
        category: 'spacing'
      })
    )
    expect(tailBadgeIssue).toBeUndefined()
  })

  it('drafts card badge-stack spacing fixes above footer action rows', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 240
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-1', {
          x: 64,
          y: 144,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-1', {
          x: 64,
          y: 176,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-a-1', {
          x: 64,
          y: 228,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-1', {
          x: 112,
          y: 228,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 300,
          width: 220,
          height: 240
        }),
        createTextItem('title-2', { x: 64, y: 320, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 364, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-2', {
          x: 64,
          y: 404,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-2', {
          x: 64,
          y: 448,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-a-2', {
          x: 64,
          y: 488,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-2', {
          x: 128,
          y: 488,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 560,
          width: 220,
          height: 240
        }),
        createTextItem('title-3', { x: 64, y: 580, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 624, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-3', {
          x: 64,
          y: 664,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-3', {
          x: 64,
          y: 696,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-a-3', {
          x: 64,
          y: 748,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-3', {
          x: 112,
          y: 748,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const badgeStackAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-vertical-spacing' &&
        action.targetItemIds.includes('badge-a-2') &&
        action.targetItemIds.includes('badge-b-2')
    )
    const badgeStackIssue = proposal.issues.find(
      (issue) => issue.title === 'Label stack vertical spacing above card buttons is inconsistent'
    )

    expect(badgeStackAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['badge-a-2', 'badge-b-2'],
        payload: {
          gap: 12,
          anchorItemId: 'badge-a-2'
        }
      })
    )
    expect(badgeStackIssue).toEqual(
      expect.objectContaining({
        itemIds: ['badge-a-2', 'badge-b-2'],
        category: 'spacing'
      })
    )
  })

  it('drafts tail badge-stack spacing fixes when cards end with stacked badges', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 220
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-1', {
          x: 64,
          y: 144,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-1', {
          x: 64,
          y: 176,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 260,
          width: 220,
          height: 220
        }),
        createTextItem('title-2', { x: 64, y: 280, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 324, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-2', {
          x: 64,
          y: 364,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-2', {
          x: 64,
          y: 404,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 480,
          width: 220,
          height: 220
        }),
        createTextItem('title-3', { x: 64, y: 500, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 544, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-3', {
          x: 64,
          y: 584,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-3', {
          x: 64,
          y: 616,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const badgeStackAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-vertical-spacing' &&
        action.targetItemIds.includes('badge-a-2') &&
        action.targetItemIds.includes('badge-b-2')
    )
    const tailBadgeIssue = proposal.issues.find(
      (issue) => issue.title === 'Trailing card label stack vertical spacing is inconsistent'
    )
    const footerAnchoredBadgeIssue = proposal.issues.find(
      (issue) => issue.title === 'Card label stack vertical spacing is inconsistent'
    )
    const footerInsetIssue = proposal.issues.find(
      (issue) => issue.title === 'Card footer bottom inset is inconsistent'
    )

    expect(badgeStackAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['badge-a-2', 'badge-b-2'],
        payload: {
          gap: 12,
          anchorItemId: 'badge-a-2'
        }
      })
    )
    expect(tailBadgeIssue).toEqual(
      expect.objectContaining({
        itemIds: ['badge-a-2', 'badge-b-2'],
        category: 'spacing'
      })
    )
    expect(footerAnchoredBadgeIssue).toBeUndefined()
    expect(footerInsetIssue).toBeUndefined()
  })

  it('drafts multi-column chip-group spacing fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 300,
          height: 240
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-1', {
          x: 64,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-1', {
          x: 124,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-1', {
          x: 184,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-1', {
          x: 64,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-e-1', {
          x: 124,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-f-1', {
          x: 184,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-1', {
          x: 64,
          y: 228,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 300,
          width: 300,
          height: 240
        }),
        createTextItem('title-2', { x: 64, y: 320, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 364, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-2', {
          x: 64,
          y: 404,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-2', {
          x: 132,
          y: 404,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-2', {
          x: 200,
          y: 404,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-2', {
          x: 64,
          y: 436,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-e-2', {
          x: 132,
          y: 436,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-f-2', {
          x: 200,
          y: 436,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-2', {
          x: 64,
          y: 488,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 560,
          width: 300,
          height: 240
        }),
        createTextItem('title-3', { x: 64, y: 580, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 624, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-3', {
          x: 64,
          y: 664,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-3', {
          x: 124,
          y: 664,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-3', {
          x: 184,
          y: 664,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-3', {
          x: 64,
          y: 696,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-e-3', {
          x: 124,
          y: 696,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-f-3', {
          x: 184,
          y: 696,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-3', {
          x: 64,
          y: 748,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const topChipAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('chip-a-2') &&
        action.targetItemIds.includes('chip-b-2') &&
        action.targetItemIds.includes('chip-c-2')
    )
    const bottomChipAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('chip-d-2') &&
        action.targetItemIds.includes('chip-e-2') &&
        action.targetItemIds.includes('chip-f-2')
    )
    const chipIssue = proposal.issues.find(
      (issue) => issue.title === 'Card multi-column label spacing is inconsistent'
    )

    expect(topChipAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['chip-a-2', 'chip-b-2', 'chip-c-2'],
        payload: {
          gap: 12,
          anchorItemId: 'chip-a-2'
        }
      })
    )
    expect(bottomChipAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['chip-d-2', 'chip-e-2', 'chip-f-2'],
        payload: {
          gap: 12,
          anchorItemId: 'chip-d-2'
        }
      })
    )
    expect(chipIssue).toEqual(
      expect.objectContaining({
        itemIds: ['chip-a-2', 'chip-b-2', 'chip-c-2', 'chip-d-2', 'chip-e-2', 'chip-f-2'],
        category: 'spacing'
      })
    )
  })

  it('does not draft footer-action-ending chip-group fixes when footer action-row counts differ', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 300,
          height: 264
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-1', {
          x: 64,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-1', {
          x: 124,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-1', {
          x: 184,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-1', {
          x: 64,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-e-1', {
          x: 124,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-f-1', {
          x: 184,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-primary-1', {
          x: 64,
          y: 228,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-1', {
          x: 140,
          y: 228,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 300,
          height: 264
        }),
        createTextItem('title-2', { x: 64, y: 340, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 384, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-2', {
          x: 64,
          y: 424,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-2', {
          x: 136,
          y: 424,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-2', {
          x: 208,
          y: 424,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-2', {
          x: 64,
          y: 456,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-e-2', {
          x: 136,
          y: 456,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-f-2', {
          x: 208,
          y: 456,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-primary-2', {
          x: 64,
          y: 508,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-2', {
          x: 140,
          y: 508,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-tertiary-2', {
          x: 228,
          y: 508,
          width: 52,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 600,
          width: 300,
          height: 264
        }),
        createTextItem('title-3', { x: 64, y: 620, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 664, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-3', {
          x: 64,
          y: 704,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-3', {
          x: 124,
          y: 704,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-3', {
          x: 184,
          y: 704,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-3', {
          x: 64,
          y: 736,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-e-3', {
          x: 124,
          y: 736,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-f-3', {
          x: 184,
          y: 736,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-primary-3', {
          x: 64,
          y: 788,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-3', {
          x: 140,
          y: 788,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const chipAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('chip-a-2') &&
        action.targetItemIds.includes('chip-b-2') &&
        action.targetItemIds.includes('chip-c-2')
    )
    const chipIssue = proposal.issues.find(
      (issue) => issue.title === 'Multi-column label spacing above card buttons is inconsistent'
    )

    expect(chipAction).toBeUndefined()
    expect(chipIssue).toBeUndefined()
  })

  it('drafts footer-action-ending chip-group spacing fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 300,
          height: 264
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-1', {
          x: 64,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-1', {
          x: 124,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-1', {
          x: 184,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-1', {
          x: 64,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-e-1', {
          x: 124,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-f-1', {
          x: 184,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-primary-1', {
          x: 64,
          y: 228,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-1', {
          x: 140,
          y: 228,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 300,
          height: 264
        }),
        createTextItem('title-2', { x: 64, y: 340, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 384, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-2', {
          x: 64,
          y: 424,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-2', {
          x: 136,
          y: 424,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-2', {
          x: 208,
          y: 424,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-2', {
          x: 64,
          y: 456,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-e-2', {
          x: 136,
          y: 456,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-f-2', {
          x: 208,
          y: 456,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-primary-2', {
          x: 64,
          y: 508,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-2', {
          x: 140,
          y: 508,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 600,
          width: 300,
          height: 264
        }),
        createTextItem('title-3', { x: 64, y: 620, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 664, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-3', {
          x: 64,
          y: 704,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-3', {
          x: 124,
          y: 704,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-3', {
          x: 184,
          y: 704,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-3', {
          x: 64,
          y: 736,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-e-3', {
          x: 124,
          y: 736,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-f-3', {
          x: 184,
          y: 736,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-primary-3', {
          x: 64,
          y: 788,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-3', {
          x: 140,
          y: 788,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const topChipAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('chip-a-2') &&
        action.targetItemIds.includes('chip-b-2') &&
        action.targetItemIds.includes('chip-c-2')
    )
    const bottomChipAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('chip-d-2') &&
        action.targetItemIds.includes('chip-e-2') &&
        action.targetItemIds.includes('chip-f-2')
    )
    const chipFooterActionIssue = proposal.issues.find(
      (issue) => issue.title === 'Multi-column label spacing above card buttons is inconsistent'
    )
    const chipIssue = proposal.issues.find(
      (issue) => issue.title === 'Card multi-column label spacing is inconsistent'
    )
    const footerRowAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('button-primary-2')
    )

    expect(topChipAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['chip-a-2', 'chip-b-2', 'chip-c-2'],
        payload: {
          gap: 12,
          anchorItemId: 'chip-a-2'
        }
      })
    )
    expect(bottomChipAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['chip-d-2', 'chip-e-2', 'chip-f-2'],
        payload: {
          gap: 12,
          anchorItemId: 'chip-d-2'
        }
      })
    )
    expect(chipFooterActionIssue).toEqual(
      expect.objectContaining({
        itemIds: ['chip-a-2', 'chip-b-2', 'chip-c-2', 'chip-d-2', 'chip-e-2', 'chip-f-2'],
        category: 'spacing'
      })
    )
    expect(chipIssue).toBeUndefined()
    expect(footerRowAction).toBeUndefined()
  })

  it('drafts body-plus-meta value-column fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 220
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('label-a-1', {
          x: 64,
          y: 144,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-1', {
          x: 184,
          y: 144,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('label-b-1', {
          x: 64,
          y: 176,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-b-1', {
          x: 192,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-1', {
          x: 64,
          y: 228,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 280,
          width: 220,
          height: 220
        }),
        createTextItem('title-2', { x: 64, y: 300, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 344, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('label-a-2', {
          x: 64,
          y: 384,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-2', {
          x: 164,
          y: 384,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('label-b-2', {
          x: 64,
          y: 416,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-b-2', {
          x: 172,
          y: 416,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-2', {
          x: 64,
          y: 468,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 520,
          width: 220,
          height: 220
        }),
        createTextItem('title-3', { x: 64, y: 540, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 584, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('label-a-3', {
          x: 64,
          y: 624,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-3', {
          x: 184,
          y: 624,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('label-b-3', {
          x: 64,
          y: 656,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-b-3', {
          x: 192,
          y: 656,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-3', {
          x: 64,
          y: 708,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const bodyMetaAction = proposal.actions.find(
      (action) =>
        action.type === 'align-right' &&
        action.targetItemIds.includes('value-a-2') &&
        action.targetItemIds.includes('value-b-2')
    )
    const bodyMetaIssue = proposal.issues.find(
      (issue) => issue.title === 'Post-body info value column right inset is inconsistent'
    )

    expect(bodyMetaAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['value-a-2', 'value-b-2'],
        payload: { x: 240 }
      })
    )
    expect(bodyMetaIssue).toEqual(
      expect.objectContaining({
        itemIds: ['value-a-2', 'value-b-2'],
        category: 'spacing'
      })
    )
  })

  it('does not draft body-plus-meta-with-footer-action value-column fixes for a nearby single-footer shape', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 220
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('label-a-1', {
          x: 64,
          y: 144,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-1', {
          x: 184,
          y: 144,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-1', {
          x: 64,
          y: 188,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 280,
          width: 220,
          height: 220
        }),
        createTextItem('title-2', { x: 64, y: 300, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 344, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('label-a-2', {
          x: 64,
          y: 384,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-2', {
          x: 164,
          y: 384,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-2', {
          x: 64,
          y: 428,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 520,
          width: 220,
          height: 220
        }),
        createTextItem('title-3', { x: 64, y: 540, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 584, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('label-a-3', {
          x: 64,
          y: 624,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-3', {
          x: 184,
          y: 624,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-3', {
          x: 64,
          y: 668,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const valueColumnAction = proposal.actions.find(
      (action) =>
        action.type === 'align-right' &&
        action.title === 'Align pre-action info value column to a consistent right inset'
    )
    const valueColumnIssue = proposal.issues.find(
      (issue) => issue.title === 'Pre-action info value column right inset is inconsistent'
    )

    expect(valueColumnAction).toBeUndefined()
    expect(valueColumnIssue).toBeUndefined()
  })

  it('drafts body-plus-meta-with-footer-action value-column fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 224
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('label-a-1', {
          x: 64,
          y: 144,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-1', {
          x: 184,
          y: 144,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('label-b-1', {
          x: 64,
          y: 176,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-b-1', {
          x: 192,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-primary-1', {
          x: 64,
          y: 232,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-1', {
          x: 140,
          y: 232,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 300,
          width: 220,
          height: 224
        }),
        createTextItem('title-2', { x: 64, y: 320, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 364, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('label-a-2', {
          x: 64,
          y: 404,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-2', {
          x: 164,
          y: 404,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('label-b-2', {
          x: 64,
          y: 436,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-b-2', {
          x: 176,
          y: 436,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-primary-2', {
          x: 64,
          y: 492,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-2', {
          x: 152,
          y: 492,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 560,
          width: 220,
          height: 224
        }),
        createTextItem('title-3', { x: 64, y: 580, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 624, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('label-a-3', {
          x: 64,
          y: 664,
          width: 60,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-a-3', {
          x: 184,
          y: 664,
          width: 56,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('label-b-3', {
          x: 64,
          y: 696,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('value-b-3', {
          x: 192,
          y: 696,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-primary-3', {
          x: 64,
          y: 752,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-3', {
          x: 140,
          y: 752,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const valueColumnAction = proposal.actions.find(
      (action) =>
        action.type === 'align-right' &&
        action.title === 'Align pre-action info value column to a consistent right inset'
    )
    const valueColumnIssue = proposal.issues.find(
      (issue) => issue.title === 'Pre-action info value column right inset is inconsistent'
    )
    const footerRowAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('button-primary-2')
    )
    const footerInsetIssue = proposal.issues.find(
      (issue) => issue.title === 'Card footer bottom inset is inconsistent'
    )

    expect(valueColumnAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['value-a-2', 'value-b-2'],
        payload: { x: 240 }
      })
    )
    expect(valueColumnIssue).toEqual(
      expect.objectContaining({
        itemIds: ['value-a-2', 'value-b-2'],
        category: 'spacing'
      })
    )
    expect(footerRowAction).toBeUndefined()
    expect(footerInsetIssue).toBeUndefined()
  })

  it('does not draft badge-stack spacing fixes when cards include only one middle tag row', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 188
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-1', {
          x: 64,
          y: 144,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-1', {
          x: 64,
          y: 196,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 240,
          width: 220,
          height: 188
        }),
        createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-2', {
          x: 64,
          y: 344,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-2', {
          x: 64,
          y: 396,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 440,
          width: 220,
          height: 188
        }),
        createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-3', {
          x: 64,
          y: 544,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-3', {
          x: 64,
          y: 596,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const badgeStackAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-vertical-spacing' && action.targetItemIds.includes('badge-a-2')
    )
    const badgeStackIssue = proposal.issues.find(
      (issue) => issue.title === 'Card label stack vertical spacing is inconsistent'
    )

    expect(badgeStackAction).toBeUndefined()
    expect(badgeStackIssue).toBeUndefined()
  })

  it('does not draft badge-stack-above-action-row fixes when cards include only one badge row', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 200
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-1', {
          x: 64,
          y: 144,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-a-1', {
          x: 64,
          y: 184,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-1', {
          x: 112,
          y: 184,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 260,
          width: 220,
          height: 200
        }),
        createTextItem('title-2', { x: 64, y: 280, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 324, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-2', {
          x: 64,
          y: 364,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-a-2', {
          x: 64,
          y: 404,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-2', {
          x: 128,
          y: 404,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 480,
          width: 220,
          height: 200
        }),
        createTextItem('title-3', { x: 64, y: 500, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 544, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-3', {
          x: 64,
          y: 584,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-a-3', {
          x: 64,
          y: 624,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-3', {
          x: 112,
          y: 624,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const badgeStackAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-vertical-spacing' && action.targetItemIds.includes('badge-a-2')
    )
    const badgeStackIssue = proposal.issues.find(
      (issue) => issue.title === 'Label stack vertical spacing above card buttons is inconsistent'
    )

    expect(badgeStackAction).toBeUndefined()
    expect(badgeStackIssue).toBeUndefined()
  })

  it('does not draft badge-stack-above-action-row fixes when footer action-row counts differ', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 240
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-1', {
          x: 64,
          y: 144,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-1', {
          x: 64,
          y: 176,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-a-1', {
          x: 64,
          y: 228,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-1', {
          x: 112,
          y: 228,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 300,
          width: 220,
          height: 240
        }),
        createTextItem('title-2', { x: 64, y: 320, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 364, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-2', {
          x: 64,
          y: 404,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-2', {
          x: 64,
          y: 448,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-a-2', {
          x: 64,
          y: 488,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-2', {
          x: 112,
          y: 488,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-c-2', {
          x: 160,
          y: 488,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 560,
          width: 220,
          height: 240
        }),
        createTextItem('title-3', { x: 64, y: 580, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 624, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('badge-a-3', {
          x: 64,
          y: 664,
          width: 72,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('badge-b-3', {
          x: 64,
          y: 696,
          width: 84,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-a-3', {
          x: 64,
          y: 748,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-3', {
          x: 112,
          y: 748,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const badgeStackAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-vertical-spacing' &&
        action.targetItemIds.includes('badge-a-2') &&
        action.targetItemIds.includes('badge-b-2')
    )
    const badgeStackIssue = proposal.issues.find(
      (issue) => issue.title === 'Label stack vertical spacing above card buttons is inconsistent'
    )

    expect(badgeStackAction).toBeUndefined()
    expect(badgeStackIssue).toBeUndefined()
  })

  it('does not draft multi-column chip-group fixes for two-column rows', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 300,
          height: 220
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-1', {
          x: 64,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-1', {
          x: 124,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-1', {
          x: 64,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-1', {
          x: 124,
          y: 176,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-1', {
          x: 64,
          y: 228,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 300,
          width: 300,
          height: 220
        }),
        createTextItem('title-2', { x: 64, y: 320, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 364, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-2', {
          x: 64,
          y: 404,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-2', {
          x: 132,
          y: 404,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-2', {
          x: 64,
          y: 436,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-2', {
          x: 132,
          y: 436,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-2', {
          x: 64,
          y: 488,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 560,
          width: 300,
          height: 220
        }),
        createTextItem('title-3', { x: 64, y: 580, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 624, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-3', {
          x: 64,
          y: 664,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-3', {
          x: 124,
          y: 664,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-3', {
          x: 64,
          y: 696,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-d-3', {
          x: 124,
          y: 696,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-3', {
          x: 64,
          y: 748,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const chipAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('chip-a-2') &&
        action.targetItemIds.includes('chip-b-2') &&
        action.targetItemIds.includes('chip-c-2')
    )
    const chipIssue = proposal.issues.find(
      (issue) => issue.title === 'Card multi-column label spacing is inconsistent'
    )

    expect(chipAction).toBeUndefined()
    expect(chipIssue).toBeUndefined()
  })

  it('does not draft multi-column chip-group fixes when cards include only one chip row', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 300,
          height: 188
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-1', {
          x: 64,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-1', {
          x: 124,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-1', {
          x: 184,
          y: 144,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-1', {
          x: 64,
          y: 196,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 240,
          width: 300,
          height: 188
        }),
        createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 304, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-2', {
          x: 64,
          y: 344,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-2', {
          x: 132,
          y: 344,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-2', {
          x: 200,
          y: 344,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-2', {
          x: 64,
          y: 396,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 440,
          width: 300,
          height: 188
        }),
        createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 504, width: 160, height: 28, fontWeight: 'normal' }),
        createTextItem('chip-a-3', {
          x: 64,
          y: 544,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-b-3', {
          x: 124,
          y: 544,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('chip-c-3', {
          x: 184,
          y: 544,
          width: 48,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('footer-3', {
          x: 64,
          y: 596,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const chipAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('chip-a-2') &&
        action.targetItemIds.includes('chip-b-2') &&
        action.targetItemIds.includes('chip-c-2')
    )
    const chipIssue = proposal.issues.find(
      (issue) => issue.title === 'Card multi-column label spacing is inconsistent'
    )

    expect(chipAction).toBeUndefined()
    expect(chipIssue).toBeUndefined()
  })

  it('drafts card-body inset fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 160
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 240,
          width: 220,
          height: 160
        }),
        createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
        createTextItem('body-2', { x: 84, y: 316, width: 140, height: 28, fontWeight: 'normal' }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 440,
          width: 220,
          height: 160
        }),
        createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const leftInsetAction = proposal.actions.find(
      (action) => action.type === 'align-left' && action.targetItemIds.includes('body-2')
    )
    const topInsetAction = proposal.actions.find(
      (action) => action.type === 'align-top' && action.targetItemIds.includes('body-2')
    )
    const leftInsetIssue = proposal.issues.find(
      (issue) => issue.title === 'Card body left inset is inconsistent'
    )
    const bodyGapIssue = proposal.issues.find(
      (issue) => issue.title === 'Vertical gap between card title and body is inconsistent'
    )

    expect(leftInsetAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['body-2'],
        payload: { x: 64 }
      })
    )
    expect(topInsetAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['body-2'],
        payload: { y: 304 }
      })
    )
    expect(leftInsetIssue).toEqual(
      expect.objectContaining({
        itemIds: ['body-2'],
        category: 'spacing'
      })
    )
    expect(bodyGapIssue).toEqual(
      expect.objectContaining({
        itemIds: ['body-2'],
        category: 'spacing'
      })
    )
  })

  it('does not draft body-gap fixes when title heights vary but title-to-body spacing stays consistent', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 180
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28 }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 260,
          width: 220,
          height: 180
        }),
        createTextItem('title-2', { x: 64, y: 280, width: 120, height: 56 }),
        createTextItem('body-2', { x: 64, y: 348, width: 140, height: 28 }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 480,
          width: 220,
          height: 180
        }),
        createTextItem('title-3', { x: 64, y: 500, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 544, width: 140, height: 28 })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const bodyGapIssue = proposal.issues.find(
      (issue) => issue.title === 'Vertical gap between card title and body is inconsistent'
    )
    const bodyGapAction = proposal.actions.find(
      (action) => action.type === 'align-top' && action.targetItemIds.includes('body-2')
    )

    expect(bodyGapIssue).toBeUndefined()
    expect(bodyGapAction).toBeUndefined()
  })

  it('drafts card-footer bottom inset fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 160
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('footer-1', {
          x: 64,
          y: 168,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 240,
          width: 220,
          height: 160
        }),
        createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('footer-2', {
          x: 64,
          y: 356,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 440,
          width: 220,
          height: 160
        }),
        createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('footer-3', {
          x: 64,
          y: 568,
          width: 80,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const footerAction = proposal.actions.find(
      (action) => action.type === 'align-bottom' && action.targetItemIds.includes('footer-2')
    )
    const footerIssue = proposal.issues.find(
      (issue) => issue.title === 'Card footer bottom inset is inconsistent'
    )

    expect(footerAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['footer-2'],
        payload: { y: 388 }
      })
    )
    expect(footerIssue).toEqual(
      expect.objectContaining({
        itemIds: ['footer-2'],
        category: 'spacing'
      })
    )
  })

  it('drafts card-footer action-row spacing fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 160
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('button-primary-1', {
          x: 64,
          y: 168,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-1', {
          x: 140,
          y: 168,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 240,
          width: 220,
          height: 160
        }),
        createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('button-primary-2', {
          x: 64,
          y: 368,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-2', {
          x: 160,
          y: 368,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 440,
          width: 220,
          height: 160
        }),
        createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('button-primary-3', {
          x: 64,
          y: 568,
          width: 64,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-secondary-3', {
          x: 140,
          y: 568,
          width: 76,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rowSpacingAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('button-primary-2')
    )
    const rowSpacingIssue = proposal.issues.find(
      (issue) => issue.title === 'Card footer action-row spacing is inconsistent'
    )

    expect(rowSpacingAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['button-primary-2', 'button-secondary-2'],
        payload: {
          gap: 12,
          anchorItemId: 'button-primary-2'
        }
      })
    )
    expect(rowSpacingIssue).toEqual(
      expect.objectContaining({
        itemIds: ['button-primary-2', 'button-secondary-2'],
        category: 'spacing'
      })
    )
  })

  it('drafts card-footer three-item action-row spacing fixes from structured container relationships', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 160
        }),
        createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
        createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('button-a-1', {
          x: 64,
          y: 168,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-1', {
          x: 112,
          y: 168,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-c-1', {
          x: 160,
          y: 168,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 240,
          width: 220,
          height: 160
        }),
        createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
        createTextItem('body-2', { x: 64, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('button-a-2', {
          x: 64,
          y: 368,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-2', {
          x: 128,
          y: 368,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-c-2', {
          x: 192,
          y: 368,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 440,
          width: 220,
          height: 160
        }),
        createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
        createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' }),
        createTextItem('button-a-3', {
          x: 64,
          y: 568,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-b-3', {
          x: 112,
          y: 568,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        }),
        createTextItem('button-c-3', {
          x: 160,
          y: 568,
          width: 36,
          height: 20,
          fontSize: 16,
          fontWeight: 'normal'
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rowSpacingAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('button-a-2')
    )
    const rowSpacingIssue = proposal.issues.find(
      (issue) => issue.title === 'Card footer action-row spacing is inconsistent'
    )

    expect(rowSpacingAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['button-a-2', 'button-b-2', 'button-c-2'],
        payload: {
          gap: 12,
          anchorItemId: 'button-a-2'
        }
      })
    )
    expect(rowSpacingIssue).toEqual(
      expect.objectContaining({
        itemIds: ['button-a-2', 'button-b-2', 'button-c-2'],
        category: 'spacing'
      })
    )
  })

  it('drafts centerline fixes for a text stack when center alignment is more stable than left or right edges', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createTextItem('title-1', { x: 80, y: 40, width: 120, height: 48 }),
        createTextItem('title-2', { x: 40, y: 128, width: 200, height: 48 }),
        createTextItem('title-3', { x: 86, y: 216, width: 120, height: 48 })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const centerAction = proposal.actions.find((action) => action.type === 'align-center')
    const centerIssue = proposal.issues.find(
      (issue) => issue.title === 'Selected vertical stack is not center-aligned'
    )

    expect(proposal.actions).toHaveLength(1)
    expect(centerAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['title-3'],
        payload: { centerX: 140 }
      })
    )
    expect(centerIssue).toEqual(
      expect.objectContaining({
        itemIds: ['title-3'],
        category: 'alignment'
      })
    )
  })

  it('drafts geometry fixes for inconsistent block widths inside a stack', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', { shape: 'rounded-rect', x: 40, y: 40, width: 220 }),
        createAnnotationItem('card-2', { shape: 'rounded-rect', x: 40, y: 168, width: 320 }),
        createAnnotationItem('card-3', { shape: 'rounded-rect', x: 40, y: 296, width: 220 })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const widthAction = proposal.actions.find((action) => action.type === 'normalize-item-width')
    const widthIssue = proposal.issues.find((issue) => issue.category === 'geometry')

    expect(widthAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-2'],
        payload: { width: 220 }
      })
    )
    expect(widthIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-2'],
        title: 'Block widths in the selected vertical stack are inconsistent'
      })
    )
  })

  it('drafts geometry fixes for inconsistent block heights inside a stack', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 220,
          height: 200
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 400,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const heightAction = proposal.actions.find((action) => action.type === 'normalize-item-height')
    const heightIssue = proposal.issues.find(
      (issue) => issue.title === 'Block heights in the selected vertical stack are inconsistent'
    )

    expect(heightAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-2'],
        payload: { height: 120 }
      })
    )
    expect(heightIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-2'],
        category: 'geometry'
      })
    )
  })

  it('drafts right-edge alignment fixes for a stack when right bounds are more consistent than left bounds', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 80,
          y: 180,
          width: 180,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const alignAction = proposal.actions.find((action) => action.type === 'align-right')
    const alignIssue = proposal.issues.find(
      (issue) => issue.title === 'Selected vertical stack right edges are inconsistent'
    )

    expect(alignAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-2'],
        payload: { x: 260 }
      })
    )
    expect(alignIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-2'],
        category: 'alignment'
      })
    )
  })

  it('drafts horizontal row fixes for top alignment and spacing from structured geometry', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', { shape: 'rounded-rect', x: 40, y: 40, width: 220 }),
        createAnnotationItem('card-2', { shape: 'rounded-rect', x: 280, y: 56, width: 220 }),
        createAnnotationItem('card-3', { shape: 'rounded-rect', x: 548, y: 44, width: 220 })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)

    expect(proposal.actions.map((action) => action.type)).toEqual([
      'align-top',
      'distribute-horizontal-spacing'
    ])
    expect(proposal.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'alignment',
          title: 'Selected horizontal row top edges are inconsistent'
        }),
        expect.objectContaining({
          category: 'spacing',
          title: 'Horizontal spacing is inconsistent'
        })
      ])
    )
  })

  it('drafts geometry fixes for inconsistent block heights inside a row', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 200
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const heightAction = proposal.actions.find((action) => action.type === 'normalize-item-height')
    const heightIssue = proposal.issues.find(
      (issue) => issue.title === 'Block heights in the selected horizontal row are inconsistent'
    )

    expect(heightAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-2'],
        payload: { height: 120 }
      })
    )
    expect(heightIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-2'],
        category: 'geometry'
      })
    )
  })

  it('drafts bottom-edge alignment fixes for a row when bottom bounds are more consistent than top bounds', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 20,
          width: 220,
          height: 140
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const alignAction = proposal.actions.find((action) => action.type === 'align-bottom')
    const alignIssue = proposal.issues.find(
      (issue) => issue.title === 'Selected horizontal row bottom edges are inconsistent'
    )

    expect(alignAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-2'],
        payload: { y: 160 }
      })
    )
    expect(alignIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-2'],
        category: 'alignment'
      })
    )
  })

  it('drafts middle-line fixes for a text row when middle alignment is more stable than top or bottom edges', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createTextItem('title-1', { x: 40, y: 80, width: 80, height: 40 }),
        createTextItem('title-2', { x: 160, y: 40, width: 80, height: 120 }),
        createTextItem('title-3', { x: 280, y: 92, width: 80, height: 40 })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const middleAction = proposal.actions.find((action) => action.type === 'align-middle')
    const middleIssue = proposal.issues.find(
      (issue) => issue.title === 'Selected horizontal row is not middle-aligned'
    )

    expect(proposal.actions).toHaveLength(1)
    expect(middleAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['title-3'],
        payload: { centerY: 100 }
      })
    )
    expect(middleIssue).toEqual(
      expect.objectContaining({
        itemIds: ['title-3'],
        category: 'alignment'
      })
    )
  })

  it('drafts geometry fixes for inconsistent block widths inside a row', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 300,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 600,
          y: 40,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const widthAction = proposal.actions.find((action) => action.type === 'normalize-item-width')
    const widthIssue = proposal.issues.find(
      (issue) => issue.title === 'Block widths in the selected horizontal row are inconsistent'
    )

    expect(widthAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-2'],
        payload: { width: 220 }
      })
    )
    expect(widthIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-2'],
        category: 'geometry'
      })
    )
  })

  it('drafts grid size fixes for inconsistent 2x2 card dimensions', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 260,
          height: 160
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 280,
          y: 180,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const sizeAction = proposal.actions.find((action) => action.type === 'normalize-item-size')
    const sizeIssue = proposal.issues.find(
      (issue) => issue.title === 'Grid item sizes are inconsistent'
    )

    expect(sizeAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-3'],
        payload: { width: 220, height: 120 }
      })
    )
    expect(sizeIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-3'],
        category: 'geometry'
      })
    )
  })

  it('drafts grid alignment fixes for drifting column centers and row middles', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 214,
          height: 114
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 44,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 44,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 280,
          y: 180,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const centerAction = proposal.actions.find((action) => action.type === 'align-center')
    const middleAction = proposal.actions.find((action) => action.type === 'align-middle')
    const columnIssue = proposal.issues.find(
      (issue) => issue.title === 'Grid columns are not center-aligned'
    )
    const rowIssue = proposal.issues.find(
      (issue) => issue.title === 'Grid rows are not middle-aligned'
    )

    expect(centerAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-1'],
        payload: { centerX: 152 }
      })
    )
    expect(middleAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-1'],
        payload: { centerY: 102 }
      })
    )
    expect(columnIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-1'],
        category: 'alignment'
      })
    )
    expect(rowIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-1'],
        category: 'alignment'
      })
    )
  })

  it('drafts 2x3 grid gutter fixes when one row compresses or stretches internal column gaps', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 284,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 518,
          y: 180,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const gutterAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('card-4') &&
        action.targetItemIds.includes('card-5') &&
        action.targetItemIds.includes('card-6')
    )
    const gutterIssue = proposal.issues.find(
      (issue) => issue.title === '2x3 grid row column spacing is inconsistent'
    )

    expect(gutterAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-4', 'card-5', 'card-6'],
        payload: {
          gap: 20,
          anchorItemId: 'card-4'
        }
      })
    )
    expect(gutterIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-4', 'card-5', 'card-6'],
        category: 'spacing'
      })
    )
  })

  it('does not draft 2x3 grid gutter fixes for 2x2 selections', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 280,
          y: 180,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const gutterAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('card-1') &&
        action.targetItemIds.includes('card-2') &&
        action.targetItemIds.includes('card-3')
    )
    const gutterIssue = proposal.issues.find(
      (issue) => issue.title === '2x3 grid row column spacing is inconsistent'
    )

    expect(gutterAction).toBeUndefined()
    expect(gutterIssue).toBeUndefined()
  })

  it('does not draft 2x3 grid gutter fixes when column anchors already drift beyond tolerance', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 288,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 518,
          y: 180,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const gutterAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('card-4') &&
        action.targetItemIds.includes('card-5') &&
        action.targetItemIds.includes('card-6')
    )
    const gutterIssue = proposal.issues.find(
      (issue) => issue.title === '2x3 grid row column spacing is inconsistent'
    )

    expect(gutterAction).toBeUndefined()
    expect(gutterIssue).toBeUndefined()
  })

  it('drafts 3-column multi-row matrix gutter fixes when one row drifts inside otherwise stable tracks', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 288,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 526,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 280,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 520,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const gutterAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('card-4') &&
        action.targetItemIds.includes('card-5') &&
        action.targetItemIds.includes('card-6')
    )
    const gutterIssue = proposal.issues.find(
      (issue) => issue.title === 'Three-column multi-row matrix row column spacing is inconsistent'
    )
    const centerAction = proposal.actions.find(
      (action) =>
        action.type === 'align-center' &&
        (action.targetItemIds.includes('card-4') ||
          action.targetItemIds.includes('card-5') ||
          action.targetItemIds.includes('card-6'))
    )

    expect(gutterAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-4', 'card-5', 'card-6'],
        payload: {
          gap: 20,
          anchorItemId: 'card-4'
        }
      })
    )
    expect(gutterIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-4', 'card-5', 'card-6'],
        category: 'spacing'
      })
    )
    expect(centerAction).toBeUndefined()
  })

  it('does not draft 3-column multi-row matrix gutter fixes when the row is a whole-track centerline drift', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 52,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 292,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 532,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 280,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 520,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const gutterAction = proposal.actions.find(
      (action) =>
        action.type === 'distribute-horizontal-spacing' &&
        action.targetItemIds.includes('card-4') &&
        action.targetItemIds.includes('card-5') &&
        action.targetItemIds.includes('card-6')
    )
    const gutterIssue = proposal.issues.find(
      (issue) => issue.title === 'Three-column multi-row matrix row column spacing is inconsistent'
    )

    expect(gutterAction).toBeUndefined()
    expect(gutterIssue).toBeUndefined()
  })

  it('drafts 3-column multi-row matrix row-rhythm fixes when one later row drifts off the dominant vertical step', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 280,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 520,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 280,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 520,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-10', {
          shape: 'rounded-rect',
          x: 40,
          y: 472,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-11', {
          shape: 'rounded-rect',
          x: 280,
          y: 472,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-12', {
          shape: 'rounded-rect',
          x: 520,
          y: 472,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rowRhythmAction = proposal.actions.find(
      (action) =>
        action.type === 'align-top' &&
        action.targetItemIds.includes('card-10') &&
        action.targetItemIds.includes('card-11') &&
        action.targetItemIds.includes('card-12')
    )
    const rowRhythmIssue = proposal.issues.find(
      (issue) => issue.title === 'Three-column multi-row matrix vertical rhythm is inconsistent'
    )

    expect(rowRhythmAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-10', 'card-11', 'card-12'],
        payload: { y: 460 }
      })
    )
    expect(rowRhythmIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-10', 'card-11', 'card-12'],
        category: 'spacing'
      })
    )
  })

  it('does not draft 3-column multi-row matrix row-rhythm fixes for ambiguous split-step matrices', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 192,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 280,
          y: 192,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 520,
          y: 192,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 332,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 280,
          y: 332,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 520,
          y: 332,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-10', {
          shape: 'rounded-rect',
          x: 40,
          y: 484,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-11', {
          shape: 'rounded-rect',
          x: 280,
          y: 484,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-12', {
          shape: 'rounded-rect',
          x: 520,
          y: 484,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rowRhythmAction = proposal.actions.find(
      (action) =>
        action.type === 'align-top' &&
        (action.targetItemIds.includes('card-10') ||
          action.targetItemIds.includes('card-11') ||
          action.targetItemIds.includes('card-12'))
    )
    const rowRhythmIssue = proposal.issues.find(
      (issue) => issue.title === 'Three-column multi-row matrix vertical rhythm is inconsistent'
    )

    expect(rowRhythmAction).toBeUndefined()
    expect(rowRhythmIssue).toBeUndefined()
  })

  it('drafts broader variable-width matrix left-track fixes when the exact helper is skipped', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 180,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 260,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 560,
          y: 40,
          width: 180,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 200,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 274,
          y: 180,
          width: 240,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 560,
          y: 180,
          width: 200,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 160,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 260,
          y: 320,
          width: 260,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 560,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const leftTrackAction = proposal.actions.find(
      (action) => action.type === 'align-left' && action.targetItemIds.includes('card-5')
    )
    const leftTrackIssue = proposal.issues.find(
      (issue) =>
        issue.title === 'Variable-width three-column matrix left column track is inconsistent'
    )
    const centerIssue = proposal.issues.find(
      (issue) => issue.title === 'Three-column matrix column centerlines are inconsistent'
    )

    expect(leftTrackAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-5'],
        payload: { x: 260 }
      })
    )
    expect(leftTrackIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-5'],
        category: 'alignment'
      })
    )
    expect(centerIssue).toBeUndefined()
  })

  it('does not draft broader variable-width matrix left-track fixes for exact uniform-width matrices', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 292,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 532,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 280,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 520,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const leftTrackAction = proposal.actions.find(
      (action) => action.type === 'align-left' && action.targetItemIds.includes('card-5')
    )
    const leftTrackIssue = proposal.issues.find(
      (issue) =>
        issue.title === 'Variable-width three-column matrix left column track is inconsistent'
    )

    expect(leftTrackAction).toBeUndefined()
    expect(leftTrackIssue).toBeUndefined()
  })

  it('drafts broader variable-width matrix right-track fixes when right anchors are more stable than left or center', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 180,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 560,
          y: 40,
          width: 180,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 200,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 274,
          y: 180,
          width: 240,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 560,
          y: 180,
          width: 200,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 160,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 220,
          y: 320,
          width: 280,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 560,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rightTrackAction = proposal.actions.find(
      (action) => action.type === 'align-right' && action.targetItemIds.includes('card-5')
    )
    const rightTrackIssue = proposal.issues.find(
      (issue) =>
        issue.title === 'Variable-width three-column matrix right column track is inconsistent'
    )
    const leftTrackIssue = proposal.issues.find(
      (issue) =>
        issue.title === 'Variable-width three-column matrix left column track is inconsistent'
    )

    expect(rightTrackAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-5'],
        payload: { x: 500 }
      })
    )
    expect(rightTrackIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-5'],
        category: 'alignment'
      })
    )
    expect(leftTrackIssue).toBeUndefined()
  })

  it('does not draft broader variable-width matrix right-track fixes for exact uniform-width matrices', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 294,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 520,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 280,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 520,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rightTrackAction = proposal.actions.find(
      (action) => action.type === 'align-right' && action.targetItemIds.includes('card-5')
    )
    const rightTrackIssue = proposal.issues.find(
      (issue) =>
        issue.title === 'Variable-width three-column matrix right column track is inconsistent'
    )

    expect(rightTrackAction).toBeUndefined()
    expect(rightTrackIssue).toBeUndefined()
  })

  it('drafts broader variable-width matrix center-track fixes when shared centers are more stable than left or right anchors', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 180,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 560,
          y: 40,
          width: 180,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 200,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 282,
          y: 180,
          width: 240,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 560,
          y: 180,
          width: 200,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 160,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 260,
          y: 320,
          width: 260,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 560,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const centerTrackAction = proposal.actions.find(
      (action) => action.type === 'align-center' && action.targetItemIds.includes('card-5')
    )
    const centerTrackIssue = proposal.issues.find(
      (issue) =>
        issue.title === 'Variable-width three-column matrix column centerline is inconsistent'
    )
    const leftTrackIssue = proposal.issues.find(
      (issue) =>
        issue.title === 'Variable-width three-column matrix left column track is inconsistent'
    )
    const rightTrackIssue = proposal.issues.find(
      (issue) =>
        issue.title === 'Variable-width three-column matrix right column track is inconsistent'
    )

    expect(centerTrackAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-5'],
        payload: { centerX: 390 }
      })
    )
    expect(centerTrackIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-5'],
        category: 'alignment'
      })
    )
    expect(leftTrackIssue).toBeUndefined()
    expect(rightTrackIssue).toBeUndefined()
  })

  it('does not draft broader variable-width matrix center-track fixes for exact uniform-width matrices', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 294,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 520,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 280,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 520,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const centerTrackAction = proposal.actions.find(
      (action) => action.type === 'align-center' && action.targetItemIds.includes('card-5')
    )
    const centerTrackIssue = proposal.issues.find(
      (issue) =>
        issue.title === 'Variable-width three-column matrix column centerline is inconsistent'
    )

    expect(centerTrackAction).toBeUndefined()
    expect(centerTrackIssue).toBeUndefined()
  })

  it('drafts mixed-anchor row-drift fixes when one variable-width matrix row slides horizontally as a whole', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 180,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 600,
          y: 40,
          width: 180,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 52,
          y: 180,
          width: 200,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 282,
          y: 180,
          width: 240,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 592,
          y: 180,
          width: 200,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 160,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 260,
          y: 320,
          width: 260,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 560,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rowDriftAction = proposal.actions.find(
      (action) =>
        action.type === 'shift-horizontal' &&
        action.targetItemIds.includes('card-4') &&
        action.targetItemIds.includes('card-5') &&
        action.targetItemIds.includes('card-6')
    )
    const rowDriftIssue = proposal.issues.find(
      (issue) =>
        issue.title === 'Variable-width three-column matrix row drifts across mixed anchors'
    )
    const leftTrackAction = proposal.actions.find(
      (action) => action.type === 'align-left' && action.targetItemIds.includes('card-4')
    )
    const centerTrackAction = proposal.actions.find(
      (action) => action.type === 'align-center' && action.targetItemIds.includes('card-5')
    )
    const rightTrackAction = proposal.actions.find(
      (action) => action.type === 'align-right' && action.targetItemIds.includes('card-6')
    )

    expect(rowDriftAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-4', 'card-5', 'card-6'],
        payload: { deltaX: -12 }
      })
    )
    expect(rowDriftIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-4', 'card-5', 'card-6'],
        category: 'alignment'
      })
    )
    expect(leftTrackAction).toBeUndefined()
    expect(centerTrackAction).toBeUndefined()
    expect(rightTrackAction).toBeUndefined()
  })

  it('does not draft mixed-anchor row-drift fixes when the row does not move as one coherent horizontal offset', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 180,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 600,
          y: 40,
          width: 180,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 52,
          y: 180,
          width: 200,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 270,
          y: 180,
          width: 240,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 592,
          y: 180,
          width: 200,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 160,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 260,
          y: 320,
          width: 260,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 560,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rowDriftAction = proposal.actions.find((action) => action.type === 'shift-horizontal')
    const rowDriftIssue = proposal.issues.find(
      (issue) =>
        issue.title === 'Variable-width three-column matrix row drifts across mixed anchors'
    )
    const leftTrackAction = proposal.actions.find(
      (action) => action.type === 'align-left' && action.targetItemIds.includes('card-4')
    )
    const rightTrackAction = proposal.actions.find(
      (action) => action.type === 'align-right' && action.targetItemIds.includes('card-6')
    )

    expect(rowDriftAction).toBeUndefined()
    expect(rowDriftIssue).toBeUndefined()
    expect(leftTrackAction).toEqual(
      expect.objectContaining({
        targetItemIds: ['card-4']
      })
    )
    expect(rightTrackAction).toEqual(
      expect.objectContaining({
        targetItemIds: ['card-6']
      })
    )
  })

  it('drafts 3-column multi-row matrix centerline fixes for drifting block centers', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 52,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 292,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 532,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-7', {
          shape: 'rounded-rect',
          x: 40,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-8', {
          shape: 'rounded-rect',
          x: 280,
          y: 320,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-9', {
          shape: 'rounded-rect',
          x: 520,
          y: 320,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const centerAction = proposal.actions.find(
      (action) => action.type === 'align-center' && action.targetItemIds.includes('card-5')
    )
    const centerIssue = proposal.issues.find(
      (issue) => issue.title === 'Three-column matrix column centerlines are inconsistent'
    )

    expect(centerAction).toEqual(
      expect.objectContaining({
        executor: 'magicpot-internal',
        targetItemIds: ['card-5'],
        payload: { centerX: 390 }
      })
    )
    expect(centerIssue).toEqual(
      expect.objectContaining({
        itemIds: ['card-4', 'card-5', 'card-6'],
        category: 'alignment'
      })
    )
  })

  it('does not draft 3-column multi-row matrix centerline fixes for exact 2x3 grids', () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createAnnotationItem('card-1', {
          shape: 'rounded-rect',
          x: 40,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-2', {
          shape: 'rounded-rect',
          x: 280,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-3', {
          shape: 'rounded-rect',
          x: 520,
          y: 40,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-4', {
          shape: 'rounded-rect',
          x: 40,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-5', {
          shape: 'rounded-rect',
          x: 296,
          y: 180,
          width: 220,
          height: 120
        }),
        createAnnotationItem('card-6', {
          shape: 'rounded-rect',
          x: 520,
          y: 180,
          width: 220,
          height: 120
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })

    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const centerAction = proposal.actions.find(
      (action) => action.type === 'align-center' && action.targetItemIds.includes('card-5')
    )
    const centerIssue = proposal.issues.find(
      (issue) => issue.title === 'Three-column matrix column centerlines are inconsistent'
    )

    expect(centerAction).toBeUndefined()
    expect(centerIssue).toBeUndefined()
  })

  it('keeps structural actions intact when the agent rewrites only the narrative fields', async () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [
        createTextItem('title-1', {
          x: 40,
          y: 40,
          provenance: {
            kind: 'figma',
            sourceDocumentId: 'figma-file-1',
            sourceNodeId: 'title-node-1'
          }
        }),
        createTextItem('title-2', {
          x: 56,
          y: 112,
          fontSize: 18,
          fontFamily: 'Arial',
          fontWeight: 'normal',
          provenance: {
            kind: 'imported-file',
            sourceFileName: 'headline-options.md',
            notes: 'Imported copy variant for review.'
          }
        })
      ],
      groups: [],
      snapshotDataUrl: null
    })
    const draftProposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const agentVersion = {
      ...draftProposal,
      summary: 'Agent-polished summary',
      rationale: 'Agent-polished rationale',
      issues: draftProposal.issues.map((issue) => ({
        ...issue,
        title: `${issue.title} (Agent)`
      })),
      actions: draftProposal.actions.map((action) => ({
        ...action,
        description: `${action.description} Agent wording.`
      }))
    }

    const llmProxy = {
      listProfiles: vi.fn().mockResolvedValue({
        profiles: [{ id: 'vision-1', model_name: 'vision', is_vision_model: true }]
      }),
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify(agentVersion)
      })
    }

    const proposal = await requestDesignInspectionProposalFromAgent({
      contextPack,
      draftProposal,
      llmProxy
    })

    expect(proposal.summary).toBe('Agent-polished summary')
    expect(proposal.rationale).toBe('Agent-polished rationale')
    expect(proposal.actions.map((action) => action.type)).toEqual(
      draftProposal.actions.map((action) => action.type)
    )
    expect(proposal.actions[0].payload).toEqual(draftProposal.actions[0].payload)
    expect(llmProxy.chat).toHaveBeenCalledTimes(1)
    const prompt = llmProxy.chat.mock.calls[0]?.[0]?.messages?.[0]?.content
    expect(typeof prompt).toBe('string')
    expect(prompt).toContain(
      'When provenance is present, treat it only as upstream origin context.'
    )
    const promptPayload = JSON.parse((prompt as string).slice((prompt as string).indexOf('{')))

    expect(promptPayload.contextPack.selectionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'title-1',
          provenance: expect.objectContaining({
            kind: 'figma',
            sourceDocumentId: 'figma-file-1',
            sourceNodeId: 'title-node-1'
          })
        }),
        expect.objectContaining({
          id: 'title-2',
          provenance: expect.objectContaining({
            kind: 'imported-file',
            sourceFileName: 'headline-options.md',
            notes: 'Imported copy variant for review.'
          })
        })
      ])
    )
    expect(promptPayload.provenanceOverview).toEqual(
      expect.objectContaining({
        kindLabels: ['Figma 1', 'Imported file 1'],
        detailLines: expect.arrayContaining([
          expect.stringContaining('Text title-1'),
          expect.stringContaining('figma-file-1'),
          expect.stringContaining('Text title-2'),
          expect.stringContaining('headline-options.md')
        ])
      })
    )
  })

  it('accepts editable file content suggestions only when reviewer notes explicitly request copy updates', async () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [createFileItem('brief-1')],
      groups: [],
      snapshotDataUrl: null
    })
    const draftProposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const llmProxy = {
      listProfiles: vi.fn().mockResolvedValue({
        profiles: [{ id: 'vision-1', model_name: 'vision', is_vision_model: true }]
      }),
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          contentActionSuggestions: [
            {
              itemId: 'brief-1',
              title: 'Refresh the markdown brief copy',
              summary: 'The selected markdown brief should use the approved wording.',
              description: 'Replace the current markdown content with the approved copy update.',
              expectedImpact: 'The brief node matches the latest approved wording.',
              evidence: ['brief-1.md is editable inside MagicPot.'],
              content: '# Updated brief\n\nUse the latest approved wording.'
            }
          ]
        })
      })
    }

    const proposal = await requestDesignInspectionProposalFromAgent({
      contextPack,
      draftProposal,
      llmProxy,
      userNotes: 'Please update the markdown file copy to the approved wording.'
    })

    expect(proposal.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'update-file-content',
          targetItemIds: ['brief-1'],
          payload: {
            content: '# Updated brief\n\nUse the latest approved wording.'
          }
        })
      ])
    )
    expect(proposal.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'content',
          itemIds: ['brief-1']
        })
      ])
    )
    expect(proposal.executionPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executor: 'magicpot-internal'
        })
      ])
    )
  })

  it('accepts editable file content suggestions when reviewer notes request copy updates in Chinese', async () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [createFileItem('brief-1')],
      groups: [],
      snapshotDataUrl: null
    })
    const draftProposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const llmProxy = {
      listProfiles: vi.fn().mockResolvedValue({
        profiles: [{ id: 'vision-1', model_name: 'vision', is_vision_model: true }]
      }),
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          contentActionSuggestions: [
            {
              itemId: 'brief-1',
              content: '# Updated brief\n\nUse the latest approved wording.'
            }
          ]
        })
      })
    }

    const proposal = await requestDesignInspectionProposalFromAgent({
      contextPack,
      draftProposal,
      llmProxy,
      userNotes: '请更新这个 markdown 文件的文案内容。'
    })

    expect(proposal.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'update-file-content',
          title: 'Update editable content for brief-1.md',
          targetItemIds: ['brief-1'],
          payload: {
            content: '# Updated brief\n\nUse the latest approved wording.'
          }
        })
      ])
    )
    expect(proposal.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'content',
          title: 'Update editable content for brief-1.md',
          itemIds: ['brief-1']
        })
      ])
    )
  })

  it('ignores file content suggestions when reviewer notes do not explicitly request copy updates', async () => {
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: [createFileItem('brief-1')],
      groups: [],
      snapshotDataUrl: null
    })
    const draftProposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const llmProxy = {
      listProfiles: vi.fn().mockResolvedValue({
        profiles: [{ id: 'vision-1', model_name: 'vision', is_vision_model: true }]
      }),
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          contentActionSuggestions: [
            {
              itemId: 'brief-1',
              content: '# Updated brief\n\nThis change should be ignored.'
            }
          ]
        })
      })
    }

    const proposal = await requestDesignInspectionProposalFromAgent({
      contextPack,
      draftProposal,
      llmProxy,
      userNotes: 'Only review spacing and alignment in this pass.'
    })

    expect(proposal.actions.find((action) => action.type === 'update-file-content')).toBeUndefined()
    expect(proposal.issues.find((issue) => issue.category === 'content')).toBeUndefined()
  })

  it('applies only approved MagicPot-internal actions and returns an execution result', () => {
    const items: CanvasItem[] = [
      createTextItem('title-1', { x: 40, y: 40 }),
      createTextItem('title-2', {
        x: 56,
        y: 112,
        fontSize: 18,
        fontFamily: 'Arial',
        fontWeight: 'normal'
      }),
      createTextItem('title-3', { x: 44, y: 196 })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const approval: DesignInspectionApproval = {
      id: 'approval-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: proposal.actions.map((action) => action.id),
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem

    expect(title2.x).toBe(44)
    expect(title2.fontSize).toBe(24)
    expect(title2.fontFamily).toBe('Inter')
    expect(title2.fontWeight).toBe('bold')
    expect(execution.result.status).toBe('success')
    expect(execution.result.executor).toBe('magicpot-internal')
    expect(execution.result.appliedChanges.length).toBeGreaterThan(0)
  })

  it('applies approved editable file content actions and revokes replaced blob URLs', () => {
    const fileItem = createFileItem('brief-1', {
      src: 'blob:brief-1',
      content: '# Old brief\n\nOutdated copy.',
      previewText: '# Old brief\n\nOutdated copy.'
    })
    const proposal = {
      id: 'proposal-file-1',
      contextPackId: 'context-file-1',
      generatedAt: '2026-03-27T00:00:00.000Z',
      summary: 'Update editable file content.',
      issues: [
        {
          id: 'issue-file-1',
          category: 'content' as const,
          severity: 'warning' as const,
          title: 'Editable file copy is outdated',
          summary: 'The markdown brief should be refreshed.',
          itemIds: ['brief-1'],
          evidence: ['brief-1.md is editable inside MagicPot.'],
          actionIds: ['action-file-1']
        }
      ],
      actions: [
        {
          id: 'action-file-1',
          type: 'update-file-content' as const,
          title: 'Refresh the markdown brief copy',
          description: 'Replace the markdown node with the approved content revision.',
          executor: 'magicpot-internal' as const,
          targetItemIds: ['brief-1'],
          payload: {
            content: '# Updated brief\n\nUse the latest approved wording.'
          },
          expectedImpact: 'The file node shows the latest approved copy.'
        }
      ],
      rationale: 'Editable files can be updated inside MagicPot after approval.',
      expectedResult: 'The markdown brief should reflect the approved wording.',
      executionPlan: [
        {
          step: 1,
          executor: 'magicpot-internal' as const,
          actionIds: ['action-file-1'],
          description: 'Refresh the markdown brief copy.'
        }
      ]
    }
    const approval: DesignInspectionApproval = {
      id: 'approval-file-1',
      contextPackId: 'context-file-1',
      proposalId: 'proposal-file-1',
      status: 'approved',
      approvedActions: ['action-file-1'],
      userNotes: 'Update the markdown file content.',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURLMock = vi.fn().mockReturnValue('blob:brief-1-updated')
    const revokeObjectURLMock = vi.fn()

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURLMock
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeObjectURLMock
    })

    try {
      const execution = applyDesignInspectionProposal([fileItem], proposal, approval)
      const updatedFile = execution.items[0] as CanvasFileItem

      expect(updatedFile.src).toBe('blob:brief-1-updated')
      expect(updatedFile.content).toBe('# Updated brief\n\nUse the latest approved wording.')
      expect(updatedFile.previewText).toBe('# Updated brief\n\nUse the latest approved wording.')
      expect(updatedFile.sizeBytes).toBeGreaterThan(0)
      expect(execution.result.appliedChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            itemId: 'brief-1',
            field: 'file-content'
          })
        ])
      )
      expect(createObjectURLMock).toHaveBeenCalledTimes(1)
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:brief-1')
    } finally {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: originalCreateObjectURL
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: originalRevokeObjectURL
      })
    }
  })

  it('applies only the selected subset of approved actions for controlled execution', () => {
    const items: CanvasItem[] = [
      createTextItem('title-1', { x: 40, y: 40 }),
      createTextItem('title-2', {
        x: 56,
        y: 112,
        fontSize: 18,
        fontFamily: 'Arial',
        fontWeight: 'normal'
      }),
      createTextItem('title-3', { x: 44, y: 196 })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const textStyleActionId = proposal.actions.find(
      (action) => action.type === 'normalize-text-style'
    )?.id
    expect(textStyleActionId).toBeTruthy()

    const approval: DesignInspectionApproval = {
      id: 'approval-subset-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: textStyleActionId ? [textStyleActionId] : [],
      userNotes: 'Only normalize typography in this pass.',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem
    const positionChanges = execution.result.appliedChanges.filter(
      (change) => change.field === 'x' || change.field === 'y'
    )

    expect(title2.fontSize).toBe(24)
    expect(title2.fontFamily).toBe('Inter')
    expect(title2.fontWeight).toBe('bold')
    expect(title2.x).toBe(56)
    expect(title2.y).toBe(112)
    expect(positionChanges).toHaveLength(0)
  })

  it('applies approved horizontal row actions by aligning tops and redistributing x positions', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', { shape: 'rounded-rect', x: 40, y: 40, width: 220 }),
      createAnnotationItem('card-2', { shape: 'rounded-rect', x: 280, y: 56, width: 220 }),
      createAnnotationItem('card-3', { shape: 'rounded-rect', x: 548, y: 44, width: 220 })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rowActionIds = proposal.actions
      .filter(
        (action) => action.type === 'align-top' || action.type === 'distribute-horizontal-spacing'
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-row-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: rowActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem

    expect(card2.y).toBe(44)
    expect(card2.x).toBe(294)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-2',
          field: 'y'
        }),
        expect.objectContaining({
          itemId: 'card-2',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved card-title inset actions by restoring consistent title padding', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 120
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 200,
        width: 220,
        height: 120
      }),
      createTextItem('title-2', { x: 84, y: 228, width: 120, height: 32 }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 360,
        width: 220,
        height: 120
      }),
      createTextItem('title-3', { x: 64, y: 380, width: 120, height: 32 })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter((action) => action.type === 'align-left' || action.type === 'align-top')
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-card-title-inset-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem

    expect(card2.x).toBe(40)
    expect(card2.y).toBe(200)
    expect(card2.width).toBe(220)
    expect(card2.height).toBe(120)
    expect(title2.x).toBe(64)
    expect(title2.y).toBe(220)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'title-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'title-2',
          field: 'y'
        })
      ])
    )
  })

  it('applies approved card-title centerline actions by restoring centered title alignment', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 120
      }),
      createTextItem('title-1', { x: 110, y: 60, width: 80, height: 32 }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 200,
        width: 220,
        height: 120
      }),
      createTextItem('title-2', { x: 80, y: 220, width: 120, height: 32 }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 360,
        width: 220,
        height: 120
      }),
      createTextItem('title-3', { x: 70, y: 380, width: 160, height: 32 })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) => action.type === 'align-center' && action.targetItemIds.includes('title-2')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-card-title-centerline-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem

    expect(card2.x).toBe(40)
    expect(card2.y).toBe(200)
    expect(card2.width).toBe(220)
    expect(card2.height).toBe(120)
    expect(title2.x).toBe(90)
    expect(title2.y).toBe(220)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'title-2',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved card-title centerline actions by restoring consistent title centering', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 120
      }),
      createTextItem('title-1', { x: 110, y: 60, width: 80, height: 32 }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 200,
        width: 220,
        height: 120
      }),
      createTextItem('title-2', { x: 80, y: 220, width: 120, height: 32 }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 360,
        width: 220,
        height: 120
      }),
      createTextItem('title-3', { x: 70, y: 380, width: 160, height: 32 })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) => action.type === 'align-center' && action.targetItemIds.includes('title-2')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-card-title-center-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem

    expect(card2.x).toBe(40)
    expect(card2.y).toBe(200)
    expect(card2.width).toBe(220)
    expect(card2.height).toBe(120)
    expect(title2.x).toBe(90)
    expect(title2.y).toBe(220)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'title-2',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved card-body inset actions by restoring consistent body padding', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 160
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 240,
        width: 220,
        height: 160
      }),
      createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
      createTextItem('body-2', { x: 84, y: 316, width: 140, height: 28, fontWeight: 'normal' }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 440,
        width: 220,
        height: 160
      }),
      createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
      createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) =>
          (action.type === 'align-left' || action.type === 'align-top') &&
          action.targetItemIds.includes('body-2')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-card-body-inset-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const body2 = execution.items.find((item) => item.id === 'body-2') as CanvasTextItem

    expect(card2.x).toBe(40)
    expect(card2.y).toBe(240)
    expect(card2.width).toBe(220)
    expect(card2.height).toBe(160)
    expect(body2.x).toBe(64)
    expect(body2.y).toBe(304)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'body-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'body-2',
          field: 'y'
        })
      ])
    )
  })

  it('applies approved card-footer inset actions by restoring consistent footer padding', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 160
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('footer-1', {
        x: 64,
        y: 168,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 240,
        width: 220,
        height: 160
      }),
      createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
      createTextItem('body-2', { x: 64, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('footer-2', {
        x: 64,
        y: 360,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 440,
        width: 220,
        height: 160
      }),
      createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
      createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('footer-3', {
        x: 64,
        y: 568,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) => action.type === 'align-bottom' && action.targetItemIds.includes('footer-2')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-card-footer-inset-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem
    const body2 = execution.items.find((item) => item.id === 'body-2') as CanvasTextItem
    const footer2 = execution.items.find((item) => item.id === 'footer-2') as CanvasTextItem

    expect(card2.x).toBe(40)
    expect(card2.y).toBe(240)
    expect(card2.width).toBe(220)
    expect(card2.height).toBe(160)
    expect(title2.x).toBe(64)
    expect(title2.y).toBe(260)
    expect(body2.x).toBe(64)
    expect(body2.y).toBe(304)
    expect(footer2.x).toBe(64)
    expect(footer2.y).toBe(368)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'footer-2',
          field: 'y'
        })
      ])
    )
  })

  it('applies approved card-footer action-row spacing actions by restoring consistent button gaps', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 160
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('button-primary-1', {
        x: 64,
        y: 168,
        width: 64,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-secondary-1', {
        x: 140,
        y: 168,
        width: 76,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 240,
        width: 220,
        height: 160
      }),
      createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
      createTextItem('body-2', { x: 64, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('button-primary-2', {
        x: 64,
        y: 368,
        width: 64,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-secondary-2', {
        x: 160,
        y: 368,
        width: 76,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 440,
        width: 220,
        height: 160
      }),
      createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
      createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('button-primary-3', {
        x: 64,
        y: 568,
        width: 64,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-secondary-3', {
        x: 140,
        y: 568,
        width: 76,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'distribute-horizontal-spacing' &&
          action.targetItemIds.includes('button-primary-2')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-card-footer-row-spacing-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const primary2 = execution.items.find(
      (item) => item.id === 'button-primary-2'
    ) as CanvasTextItem
    const secondary2 = execution.items.find(
      (item) => item.id === 'button-secondary-2'
    ) as CanvasTextItem

    expect(primary2.x).toBe(64)
    expect(primary2.y).toBe(368)
    expect(secondary2.x).toBe(140)
    expect(secondary2.y).toBe(368)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'button-secondary-2',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved card-footer three-item action-row spacing actions by restoring consistent button gaps', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 160
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('button-a-1', {
        x: 64,
        y: 168,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-b-1', {
        x: 112,
        y: 168,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-c-1', {
        x: 160,
        y: 168,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 240,
        width: 220,
        height: 160
      }),
      createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
      createTextItem('body-2', { x: 64, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('button-a-2', {
        x: 64,
        y: 368,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-b-2', {
        x: 128,
        y: 368,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-c-2', {
        x: 192,
        y: 368,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 440,
        width: 220,
        height: 160
      }),
      createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
      createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('button-a-3', {
        x: 64,
        y: 568,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-b-3', {
        x: 112,
        y: 568,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-c-3', {
        x: 160,
        y: 568,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'distribute-horizontal-spacing' &&
          action.targetItemIds.includes('button-a-2')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-card-footer-row-spacing-3-items-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const buttonA2 = execution.items.find((item) => item.id === 'button-a-2') as CanvasTextItem
    const buttonB2 = execution.items.find((item) => item.id === 'button-b-2') as CanvasTextItem
    const buttonC2 = execution.items.find((item) => item.id === 'button-c-2') as CanvasTextItem

    expect(buttonA2.x).toBe(64)
    expect(buttonA2.y).toBe(368)
    expect(buttonB2.x).toBe(112)
    expect(buttonB2.y).toBe(368)
    expect(buttonC2.x).toBe(160)
    expect(buttonC2.y).toBe(368)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'button-b-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'button-c-2',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved card-header meta inset actions by restoring consistent right padding', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 160
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('meta-1', {
        x: 204,
        y: 60,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 240,
        width: 220,
        height: 160
      }),
      createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
      createTextItem('meta-2', {
        x: 184,
        y: 260,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('body-2', { x: 64, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 440,
        width: 220,
        height: 160
      }),
      createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
      createTextItem('meta-3', {
        x: 204,
        y: 460,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter((action) => action.type === 'align-right' && action.targetItemIds.includes('meta-2'))
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-card-header-meta-inset-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem
    const meta2 = execution.items.find((item) => item.id === 'meta-2') as CanvasTextItem
    const body2 = execution.items.find((item) => item.id === 'body-2') as CanvasTextItem

    expect(card2.x).toBe(40)
    expect(card2.y).toBe(240)
    expect(card2.width).toBe(220)
    expect(card2.height).toBe(160)
    expect(title2.x).toBe(64)
    expect(title2.y).toBe(260)
    expect(meta2.x).toBe(204)
    expect(meta2.y).toBe(260)
    expect(body2.x).toBe(64)
    expect(body2.y).toBe(304)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'meta-2',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved card meta-block value-column actions by restoring consistent right padding', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 180
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('label-a-1', {
        x: 64,
        y: 104,
        width: 60,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-a-1', {
        x: 184,
        y: 104,
        width: 56,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('label-b-1', {
        x: 64,
        y: 136,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-b-1', {
        x: 192,
        y: 136,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-1', {
        x: 64,
        y: 188,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 240,
        width: 220,
        height: 180
      }),
      createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
      createTextItem('label-a-2', {
        x: 64,
        y: 304,
        width: 60,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-a-2', {
        x: 164,
        y: 304,
        width: 56,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('label-b-2', {
        x: 64,
        y: 336,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-b-2', {
        x: 172,
        y: 336,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-2', {
        x: 64,
        y: 388,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 440,
        width: 220,
        height: 180
      }),
      createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
      createTextItem('label-a-3', {
        x: 64,
        y: 504,
        width: 60,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-a-3', {
        x: 184,
        y: 504,
        width: 56,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('label-b-3', {
        x: 64,
        y: 536,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-b-3', {
        x: 192,
        y: 536,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-3', {
        x: 64,
        y: 588,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'align-right' &&
          action.targetItemIds.includes('value-a-2') &&
          action.targetItemIds.includes('value-b-2')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-card-meta-block-value-column-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem
    const labelA2 = execution.items.find((item) => item.id === 'label-a-2') as CanvasTextItem
    const valueA2 = execution.items.find((item) => item.id === 'value-a-2') as CanvasTextItem
    const labelB2 = execution.items.find((item) => item.id === 'label-b-2') as CanvasTextItem
    const valueB2 = execution.items.find((item) => item.id === 'value-b-2') as CanvasTextItem
    const footer2 = execution.items.find((item) => item.id === 'footer-2') as CanvasTextItem

    expect(title2.x).toBe(64)
    expect(title2.y).toBe(260)
    expect(labelA2.x).toBe(64)
    expect(labelA2.y).toBe(304)
    expect(valueA2.x).toBe(184)
    expect(valueA2.y).toBe(304)
    expect(labelB2.x).toBe(64)
    expect(labelB2.y).toBe(336)
    expect(valueB2.x).toBe(192)
    expect(valueB2.y).toBe(336)
    expect(footer2.x).toBe(64)
    expect(footer2.y).toBe(388)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'value-a-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'value-b-2',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved footer-action-ending value-column actions by moving only drifting value items', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 224
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('label-a-1', {
        x: 64,
        y: 144,
        width: 60,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-a-1', {
        x: 184,
        y: 144,
        width: 56,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('label-b-1', {
        x: 64,
        y: 176,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-b-1', {
        x: 192,
        y: 176,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-primary-1', {
        x: 64,
        y: 232,
        width: 64,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-secondary-1', {
        x: 140,
        y: 232,
        width: 76,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 300,
        width: 220,
        height: 224
      }),
      createTextItem('title-2', { x: 64, y: 320, width: 120, height: 32 }),
      createTextItem('body-2', { x: 64, y: 364, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('label-a-2', {
        x: 64,
        y: 404,
        width: 60,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-a-2', {
        x: 164,
        y: 404,
        width: 56,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('label-b-2', {
        x: 64,
        y: 436,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-b-2', {
        x: 176,
        y: 436,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-primary-2', {
        x: 64,
        y: 492,
        width: 64,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-secondary-2', {
        x: 152,
        y: 492,
        width: 76,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 560,
        width: 220,
        height: 224
      }),
      createTextItem('title-3', { x: 64, y: 580, width: 120, height: 32 }),
      createTextItem('body-3', { x: 64, y: 624, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('label-a-3', {
        x: 64,
        y: 664,
        width: 60,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-a-3', {
        x: 184,
        y: 664,
        width: 56,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('label-b-3', {
        x: 64,
        y: 696,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-b-3', {
        x: 192,
        y: 696,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-primary-3', {
        x: 64,
        y: 752,
        width: 64,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-secondary-3', {
        x: 140,
        y: 752,
        width: 76,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'align-right' &&
          action.title === 'Align pre-action info value column to a consistent right inset'
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-footer-action-ending-value-column-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const labelA2 = execution.items.find((item) => item.id === 'label-a-2') as CanvasTextItem
    const valueA2 = execution.items.find((item) => item.id === 'value-a-2') as CanvasTextItem
    const labelB2 = execution.items.find((item) => item.id === 'label-b-2') as CanvasTextItem
    const valueB2 = execution.items.find((item) => item.id === 'value-b-2') as CanvasTextItem
    const buttonPrimary2 = execution.items.find(
      (item) => item.id === 'button-primary-2'
    ) as CanvasTextItem
    const buttonSecondary2 = execution.items.find(
      (item) => item.id === 'button-secondary-2'
    ) as CanvasTextItem

    expect(labelA2.x).toBe(64)
    expect(valueA2.x).toBe(184)
    expect(labelB2.x).toBe(64)
    expect(valueB2.x).toBe(192)
    expect(buttonPrimary2.x).toBe(64)
    expect(buttonSecondary2.x).toBe(152)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'value-a-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'value-b-2',
          field: 'x'
        })
      ])
    )
    expect(execution.result.appliedChanges).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ itemId: 'label-a-2' }),
        expect.objectContaining({ itemId: 'label-b-2' }),
        expect.objectContaining({ itemId: 'button-primary-2' }),
        expect.objectContaining({ itemId: 'button-secondary-2' })
      ])
    )
  })

  it('applies approved card badge-stack spacing actions by restoring consistent vertical rhythm', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 220
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('badge-a-1', {
        x: 64,
        y: 144,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('badge-b-1', {
        x: 64,
        y: 176,
        width: 84,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-1', {
        x: 64,
        y: 228,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 240,
        width: 220,
        height: 220
      }),
      createTextItem('title-2', { x: 64, y: 260, width: 120, height: 32 }),
      createTextItem('body-2', { x: 64, y: 304, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('badge-a-2', {
        x: 64,
        y: 344,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('badge-b-2', {
        x: 64,
        y: 388,
        width: 84,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-2', {
        x: 64,
        y: 428,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 440,
        width: 220,
        height: 220
      }),
      createTextItem('title-3', { x: 64, y: 460, width: 120, height: 32 }),
      createTextItem('body-3', { x: 64, y: 504, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('badge-a-3', {
        x: 64,
        y: 544,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('badge-b-3', {
        x: 64,
        y: 576,
        width: 84,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-3', {
        x: 64,
        y: 628,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'distribute-vertical-spacing' &&
          action.targetItemIds.includes('badge-a-2') &&
          action.targetItemIds.includes('badge-b-2')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-card-badge-stack-spacing-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem
    const body2 = execution.items.find((item) => item.id === 'body-2') as CanvasTextItem
    const badgeA2 = execution.items.find((item) => item.id === 'badge-a-2') as CanvasTextItem
    const badgeB2 = execution.items.find((item) => item.id === 'badge-b-2') as CanvasTextItem
    const footer2 = execution.items.find((item) => item.id === 'footer-2') as CanvasTextItem

    expect(title2.x).toBe(64)
    expect(title2.y).toBe(260)
    expect(body2.x).toBe(64)
    expect(body2.y).toBe(304)
    expect(badgeA2.x).toBe(64)
    expect(badgeA2.y).toBe(344)
    expect(badgeB2.x).toBe(64)
    expect(badgeB2.y).toBe(376)
    expect(footer2.x).toBe(64)
    expect(footer2.y).toBe(428)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'badge-b-2',
          field: 'y'
        })
      ])
    )
  })

  it('applies approved tail badge-stack actions without moving title or body', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 220
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('badge-a-1', {
        x: 64,
        y: 144,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('badge-b-1', {
        x: 64,
        y: 176,
        width: 84,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 260,
        width: 220,
        height: 220
      }),
      createTextItem('title-2', { x: 64, y: 280, width: 120, height: 32 }),
      createTextItem('body-2', { x: 64, y: 324, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('badge-a-2', {
        x: 64,
        y: 364,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('badge-b-2', {
        x: 64,
        y: 404,
        width: 84,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 480,
        width: 220,
        height: 220
      }),
      createTextItem('title-3', { x: 64, y: 500, width: 120, height: 32 }),
      createTextItem('body-3', { x: 64, y: 544, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('badge-a-3', {
        x: 64,
        y: 584,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('badge-b-3', {
        x: 64,
        y: 616,
        width: 84,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'distribute-vertical-spacing' &&
          action.targetItemIds.includes('badge-a-2') &&
          action.targetItemIds.includes('badge-b-2')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-tail-badge-stack-spacing-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem
    const body2 = execution.items.find((item) => item.id === 'body-2') as CanvasTextItem
    const badgeA2 = execution.items.find((item) => item.id === 'badge-a-2') as CanvasTextItem
    const badgeB2 = execution.items.find((item) => item.id === 'badge-b-2') as CanvasTextItem

    expect(title2.x).toBe(64)
    expect(title2.y).toBe(280)
    expect(body2.x).toBe(64)
    expect(body2.y).toBe(324)
    expect(badgeA2.x).toBe(64)
    expect(badgeA2.y).toBe(364)
    expect(badgeB2.x).toBe(64)
    expect(badgeB2.y).toBe(396)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'badge-b-2',
          field: 'y'
        })
      ])
    )
  })

  it('applies approved badge-stack-above-action-row actions without moving the footer buttons', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 240
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('badge-a-1', {
        x: 64,
        y: 144,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('badge-b-1', {
        x: 64,
        y: 176,
        width: 84,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-a-1', {
        x: 64,
        y: 228,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-b-1', {
        x: 112,
        y: 228,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 300,
        width: 220,
        height: 240
      }),
      createTextItem('title-2', { x: 64, y: 320, width: 120, height: 32 }),
      createTextItem('body-2', { x: 64, y: 364, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('badge-a-2', {
        x: 64,
        y: 404,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('badge-b-2', {
        x: 64,
        y: 448,
        width: 84,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-a-2', {
        x: 64,
        y: 488,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-b-2', {
        x: 128,
        y: 488,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 560,
        width: 220,
        height: 240
      }),
      createTextItem('title-3', { x: 64, y: 580, width: 120, height: 32 }),
      createTextItem('body-3', { x: 64, y: 624, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('badge-a-3', {
        x: 64,
        y: 664,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('badge-b-3', {
        x: 64,
        y: 696,
        width: 84,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-a-3', {
        x: 64,
        y: 748,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-b-3', {
        x: 112,
        y: 748,
        width: 36,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'distribute-vertical-spacing' &&
          action.targetItemIds.includes('badge-a-2') &&
          action.targetItemIds.includes('badge-b-2')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-badge-stack-footer-action-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem
    const body2 = execution.items.find((item) => item.id === 'body-2') as CanvasTextItem
    const badgeA2 = execution.items.find((item) => item.id === 'badge-a-2') as CanvasTextItem
    const badgeB2 = execution.items.find((item) => item.id === 'badge-b-2') as CanvasTextItem
    const buttonA2 = execution.items.find((item) => item.id === 'button-a-2') as CanvasTextItem
    const buttonB2 = execution.items.find((item) => item.id === 'button-b-2') as CanvasTextItem

    expect(title2.x).toBe(64)
    expect(title2.y).toBe(320)
    expect(body2.x).toBe(64)
    expect(body2.y).toBe(364)
    expect(badgeA2.x).toBe(64)
    expect(badgeA2.y).toBe(404)
    expect(badgeB2.x).toBe(64)
    expect(badgeB2.y).toBe(436)
    expect(buttonA2.x).toBe(64)
    expect(buttonA2.y).toBe(488)
    expect(buttonB2.x).toBe(128)
    expect(buttonB2.y).toBe(488)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'badge-b-2',
          field: 'y'
        })
      ])
    )
  })

  it('applies approved multi-column chip-group actions without moving title, body, or footer', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 300,
        height: 240
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('body-1', { x: 64, y: 104, width: 160, height: 28, fontWeight: 'normal' }),
      createTextItem('chip-a-1', {
        x: 64,
        y: 144,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-b-1', {
        x: 124,
        y: 144,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-c-1', {
        x: 184,
        y: 144,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-d-1', {
        x: 64,
        y: 176,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-e-1', {
        x: 124,
        y: 176,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-f-1', {
        x: 184,
        y: 176,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-1', {
        x: 64,
        y: 228,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 300,
        width: 300,
        height: 240
      }),
      createTextItem('title-2', { x: 64, y: 320, width: 120, height: 32 }),
      createTextItem('body-2', { x: 64, y: 364, width: 160, height: 28, fontWeight: 'normal' }),
      createTextItem('chip-a-2', {
        x: 64,
        y: 404,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-b-2', {
        x: 132,
        y: 404,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-c-2', {
        x: 200,
        y: 404,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-d-2', {
        x: 64,
        y: 436,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-e-2', {
        x: 132,
        y: 436,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-f-2', {
        x: 200,
        y: 436,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-2', {
        x: 64,
        y: 488,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 560,
        width: 300,
        height: 240
      }),
      createTextItem('title-3', { x: 64, y: 580, width: 120, height: 32 }),
      createTextItem('body-3', { x: 64, y: 624, width: 160, height: 28, fontWeight: 'normal' }),
      createTextItem('chip-a-3', {
        x: 64,
        y: 664,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-b-3', {
        x: 124,
        y: 664,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-c-3', {
        x: 184,
        y: 664,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-d-3', {
        x: 64,
        y: 696,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-e-3', {
        x: 124,
        y: 696,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-f-3', {
        x: 184,
        y: 696,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-3', {
        x: 64,
        y: 748,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'distribute-horizontal-spacing' &&
          (action.targetItemIds.includes('chip-a-2') || action.targetItemIds.includes('chip-d-2'))
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-chip-group-spacing-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem
    const body2 = execution.items.find((item) => item.id === 'body-2') as CanvasTextItem
    const chipA2 = execution.items.find((item) => item.id === 'chip-a-2') as CanvasTextItem
    const chipB2 = execution.items.find((item) => item.id === 'chip-b-2') as CanvasTextItem
    const chipC2 = execution.items.find((item) => item.id === 'chip-c-2') as CanvasTextItem
    const chipD2 = execution.items.find((item) => item.id === 'chip-d-2') as CanvasTextItem
    const chipE2 = execution.items.find((item) => item.id === 'chip-e-2') as CanvasTextItem
    const chipF2 = execution.items.find((item) => item.id === 'chip-f-2') as CanvasTextItem
    const footer2 = execution.items.find((item) => item.id === 'footer-2') as CanvasTextItem

    expect(title2.x).toBe(64)
    expect(title2.y).toBe(320)
    expect(body2.x).toBe(64)
    expect(body2.y).toBe(364)
    expect(chipA2.x).toBe(64)
    expect(chipB2.x).toBe(124)
    expect(chipC2.x).toBe(184)
    expect(chipD2.x).toBe(64)
    expect(chipE2.x).toBe(124)
    expect(chipF2.x).toBe(184)
    expect(footer2.x).toBe(64)
    expect(footer2.y).toBe(488)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'chip-b-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'chip-c-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'chip-e-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'chip-f-2',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved footer-action-ending chip-group actions without moving body or footer buttons', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 300,
        height: 264
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('body-1', { x: 64, y: 104, width: 160, height: 28, fontWeight: 'normal' }),
      createTextItem('chip-a-1', {
        x: 64,
        y: 144,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-b-1', {
        x: 124,
        y: 144,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-c-1', {
        x: 184,
        y: 144,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-d-1', {
        x: 64,
        y: 176,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-e-1', {
        x: 124,
        y: 176,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-f-1', {
        x: 184,
        y: 176,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-primary-1', {
        x: 64,
        y: 228,
        width: 64,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-secondary-1', {
        x: 140,
        y: 228,
        width: 76,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 320,
        width: 300,
        height: 264
      }),
      createTextItem('title-2', { x: 64, y: 340, width: 120, height: 32 }),
      createTextItem('body-2', { x: 64, y: 384, width: 160, height: 28, fontWeight: 'normal' }),
      createTextItem('chip-a-2', {
        x: 64,
        y: 424,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-b-2', {
        x: 136,
        y: 424,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-c-2', {
        x: 208,
        y: 424,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-d-2', {
        x: 64,
        y: 456,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-e-2', {
        x: 136,
        y: 456,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-f-2', {
        x: 208,
        y: 456,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-primary-2', {
        x: 64,
        y: 508,
        width: 64,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-secondary-2', {
        x: 140,
        y: 508,
        width: 76,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 600,
        width: 300,
        height: 264
      }),
      createTextItem('title-3', { x: 64, y: 620, width: 120, height: 32 }),
      createTextItem('body-3', { x: 64, y: 664, width: 160, height: 28, fontWeight: 'normal' }),
      createTextItem('chip-a-3', {
        x: 64,
        y: 704,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-b-3', {
        x: 124,
        y: 704,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-c-3', {
        x: 184,
        y: 704,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-d-3', {
        x: 64,
        y: 736,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-e-3', {
        x: 124,
        y: 736,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('chip-f-3', {
        x: 184,
        y: 736,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-primary-3', {
        x: 64,
        y: 788,
        width: 64,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('button-secondary-3', {
        x: 140,
        y: 788,
        width: 76,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'distribute-horizontal-spacing' &&
          (action.targetItemIds.includes('chip-a-2') || action.targetItemIds.includes('chip-d-2'))
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-chip-group-footer-action-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const body2 = execution.items.find((item) => item.id === 'body-2') as CanvasTextItem
    const chipA2 = execution.items.find((item) => item.id === 'chip-a-2') as CanvasTextItem
    const chipB2 = execution.items.find((item) => item.id === 'chip-b-2') as CanvasTextItem
    const chipC2 = execution.items.find((item) => item.id === 'chip-c-2') as CanvasTextItem
    const chipD2 = execution.items.find((item) => item.id === 'chip-d-2') as CanvasTextItem
    const chipE2 = execution.items.find((item) => item.id === 'chip-e-2') as CanvasTextItem
    const chipF2 = execution.items.find((item) => item.id === 'chip-f-2') as CanvasTextItem
    const buttonPrimary2 = execution.items.find(
      (item) => item.id === 'button-primary-2'
    ) as CanvasTextItem
    const buttonSecondary2 = execution.items.find(
      (item) => item.id === 'button-secondary-2'
    ) as CanvasTextItem

    expect(body2.x).toBe(64)
    expect(chipA2.x).toBe(64)
    expect(chipB2.x).toBe(124)
    expect(chipC2.x).toBe(184)
    expect(chipD2.x).toBe(64)
    expect(chipE2.x).toBe(124)
    expect(chipF2.x).toBe(184)
    expect(buttonPrimary2.x).toBe(64)
    expect(buttonSecondary2.x).toBe(140)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'chip-b-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'chip-c-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'chip-e-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'chip-f-2',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved body-plus-meta value-column actions by restoring a shared right column', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 220
      }),
      createTextItem('title-1', { x: 64, y: 60, width: 120, height: 32 }),
      createTextItem('body-1', { x: 64, y: 104, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('label-a-1', {
        x: 64,
        y: 144,
        width: 60,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-a-1', {
        x: 184,
        y: 144,
        width: 56,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('label-b-1', {
        x: 64,
        y: 176,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-b-1', {
        x: 192,
        y: 176,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-1', {
        x: 64,
        y: 228,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 40,
        y: 280,
        width: 220,
        height: 220
      }),
      createTextItem('title-2', { x: 64, y: 300, width: 120, height: 32 }),
      createTextItem('body-2', { x: 64, y: 344, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('label-a-2', {
        x: 64,
        y: 384,
        width: 60,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-a-2', {
        x: 164,
        y: 384,
        width: 56,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('label-b-2', {
        x: 64,
        y: 416,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-b-2', {
        x: 172,
        y: 416,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-2', {
        x: 64,
        y: 468,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 520,
        width: 220,
        height: 220
      }),
      createTextItem('title-3', { x: 64, y: 540, width: 120, height: 32 }),
      createTextItem('body-3', { x: 64, y: 584, width: 140, height: 28, fontWeight: 'normal' }),
      createTextItem('label-a-3', {
        x: 64,
        y: 624,
        width: 60,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-a-3', {
        x: 184,
        y: 624,
        width: 56,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('label-b-3', {
        x: 64,
        y: 656,
        width: 72,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('value-b-3', {
        x: 192,
        y: 656,
        width: 48,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      }),
      createTextItem('footer-3', {
        x: 64,
        y: 708,
        width: 80,
        height: 20,
        fontSize: 16,
        fontWeight: 'normal'
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'align-right' &&
          action.targetItemIds.includes('value-a-2') &&
          action.targetItemIds.includes('value-b-2')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-body-plus-meta-value-column-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const title2 = execution.items.find((item) => item.id === 'title-2') as CanvasTextItem
    const body2 = execution.items.find((item) => item.id === 'body-2') as CanvasTextItem
    const labelA2 = execution.items.find((item) => item.id === 'label-a-2') as CanvasTextItem
    const valueA2 = execution.items.find((item) => item.id === 'value-a-2') as CanvasTextItem
    const labelB2 = execution.items.find((item) => item.id === 'label-b-2') as CanvasTextItem
    const valueB2 = execution.items.find((item) => item.id === 'value-b-2') as CanvasTextItem
    const footer2 = execution.items.find((item) => item.id === 'footer-2') as CanvasTextItem

    expect(title2.x).toBe(64)
    expect(title2.y).toBe(300)
    expect(body2.x).toBe(64)
    expect(body2.y).toBe(344)
    expect(labelA2.x).toBe(64)
    expect(labelA2.y).toBe(384)
    expect(valueA2.x).toBe(184)
    expect(valueA2.y).toBe(384)
    expect(labelB2.x).toBe(64)
    expect(labelB2.y).toBe(416)
    expect(valueB2.x).toBe(192)
    expect(valueB2.y).toBe(416)
    expect(footer2.x).toBe(64)
    expect(footer2.y).toBe(468)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'value-a-2',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'value-b-2',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved centerline actions by re-centering drifting text inside a vertical stack', () => {
    const items: CanvasItem[] = [
      createTextItem('title-1', { x: 80, y: 40, width: 120, height: 48 }),
      createTextItem('title-2', { x: 40, y: 128, width: 200, height: 48 }),
      createTextItem('title-3', { x: 86, y: 216, width: 120, height: 48 })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter((action) => action.type === 'align-center')
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-stack-center-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const title3 = execution.items.find((item) => item.id === 'title-3') as CanvasTextItem

    expect(title3.x).toBe(80)
    expect(title3.y).toBe(216)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'title-3',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved middle-line actions by re-centering drifting text inside a horizontal row', () => {
    const items: CanvasItem[] = [
      createTextItem('title-1', { x: 40, y: 80, width: 80, height: 40 }),
      createTextItem('title-2', { x: 160, y: 40, width: 80, height: 120 }),
      createTextItem('title-3', { x: 280, y: 92, width: 80, height: 40 })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter((action) => action.type === 'align-middle')
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-row-middle-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const title3 = execution.items.find((item) => item.id === 'title-3') as CanvasTextItem

    expect(title3.x).toBe(280)
    expect(title3.y).toBe(80)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'title-3',
          field: 'y'
        })
      ])
    )
  })

  it('applies approved geometry actions by normalizing row heights', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 280,
        y: 40,
        width: 220,
        height: 200
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 520,
        y: 40,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const heightActionIds = proposal.actions
      .filter((action) => action.type === 'normalize-item-height')
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-height-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: heightActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem

    expect(card2.height).toBe(120)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-2',
          field: 'item-height'
        })
      ])
    )
  })

  it('applies approved geometry actions by normalizing row widths', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 280,
        y: 40,
        width: 300,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 600,
        y: 40,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const widthActionIds = proposal.actions
      .filter((action) => action.type === 'normalize-item-width')
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-row-width-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: widthActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem

    expect(card2.width).toBe(220)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-2',
          field: 'item-width'
        })
      ])
    )
  })

  it('applies approved alignment actions by normalizing stack right edges', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 80,
        y: 180,
        width: 180,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 320,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const actionIds = proposal.actions
      .filter((action) => action.type === 'normalize-item-width' || action.type === 'align-right')
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-stack-right-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: actionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem

    expect(card2.width).toBe(220)
    expect(card2.x).toBe(40)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-2',
          field: 'item-width'
        }),
        expect.objectContaining({
          itemId: 'card-2',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved grid size actions by normalizing 2x2 card dimensions', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 280,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 40,
        y: 180,
        width: 260,
        height: 160
      }),
      createAnnotationItem('card-4', {
        shape: 'rounded-rect',
        x: 280,
        y: 180,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const sizeActionIds = proposal.actions
      .filter((action) => action.type === 'normalize-item-size')
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-grid-size-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: sizeActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card3 = execution.items.find((item) => item.id === 'card-3') as CanvasAnnotationItem

    expect(card3.width).toBe(220)
    expect(card3.height).toBe(120)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-3',
          field: 'item-size'
        })
      ])
    )
  })

  it('applies approved grid alignment actions by recentering drifting cards', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 214,
        height: 114
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 280,
        y: 44,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 44,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-4', {
        shape: 'rounded-rect',
        x: 280,
        y: 180,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const alignmentActionIds = proposal.actions
      .filter((action) => action.type === 'align-center' || action.type === 'align-middle')
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-grid-alignment-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: alignmentActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card1 = execution.items.find((item) => item.id === 'card-1') as CanvasAnnotationItem

    expect(card1.x).toBe(45)
    expect(card1.y).toBe(45)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-1',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'card-1',
          field: 'y'
        })
      ])
    )
  })

  it('applies approved 2x3 grid gutter actions by restoring the drifting row spacing only', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 280,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 520,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-4', {
        shape: 'rounded-rect',
        x: 40,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-5', {
        shape: 'rounded-rect',
        x: 284,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-6', {
        shape: 'rounded-rect',
        x: 518,
        y: 180,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const gutterActionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'distribute-horizontal-spacing' &&
          action.targetItemIds.includes('card-4') &&
          action.targetItemIds.includes('card-5') &&
          action.targetItemIds.includes('card-6')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-grid-gutter-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: gutterActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card1 = execution.items.find((item) => item.id === 'card-1') as CanvasAnnotationItem
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const card3 = execution.items.find((item) => item.id === 'card-3') as CanvasAnnotationItem
    const card4 = execution.items.find((item) => item.id === 'card-4') as CanvasAnnotationItem
    const card5 = execution.items.find((item) => item.id === 'card-5') as CanvasAnnotationItem
    const card6 = execution.items.find((item) => item.id === 'card-6') as CanvasAnnotationItem

    expect(card1.x).toBe(40)
    expect(card2.x).toBe(280)
    expect(card3.x).toBe(520)
    expect(card4.x).toBe(40)
    expect(card5.x).toBe(280)
    expect(card6.x).toBe(520)
    expect(card5.width).toBe(220)
    expect(card6.width).toBe(220)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-5',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'card-6',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved 3-column multi-row matrix actions by re-centering drifting blocks only', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 280,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 520,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-4', {
        shape: 'rounded-rect',
        x: 52,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-5', {
        shape: 'rounded-rect',
        x: 292,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-6', {
        shape: 'rounded-rect',
        x: 532,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-7', {
        shape: 'rounded-rect',
        x: 40,
        y: 320,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-8', {
        shape: 'rounded-rect',
        x: 280,
        y: 320,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-9', {
        shape: 'rounded-rect',
        x: 520,
        y: 320,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const centerActionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'align-center' &&
          (action.targetItemIds.includes('card-4') ||
            action.targetItemIds.includes('card-5') ||
            action.targetItemIds.includes('card-6'))
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-three-column-matrix-centerline-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: centerActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const card4 = execution.items.find((item) => item.id === 'card-4') as CanvasAnnotationItem
    const card5 = execution.items.find((item) => item.id === 'card-5') as CanvasAnnotationItem
    const card6 = execution.items.find((item) => item.id === 'card-6') as CanvasAnnotationItem
    const card8 = execution.items.find((item) => item.id === 'card-8') as CanvasAnnotationItem

    expect(card2.x).toBe(280)
    expect(card4.x).toBe(40)
    expect(card5.x).toBe(280)
    expect(card6.x).toBe(520)
    expect(card8.x).toBe(280)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-4',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'card-5',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'card-6',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved 3-column multi-row matrix gutter actions by restoring the drifting row spacing only', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 280,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 520,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-4', {
        shape: 'rounded-rect',
        x: 40,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-5', {
        shape: 'rounded-rect',
        x: 288,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-6', {
        shape: 'rounded-rect',
        x: 526,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-7', {
        shape: 'rounded-rect',
        x: 40,
        y: 320,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-8', {
        shape: 'rounded-rect',
        x: 280,
        y: 320,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-9', {
        shape: 'rounded-rect',
        x: 520,
        y: 320,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const gutterActionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'distribute-horizontal-spacing' &&
          action.targetItemIds.includes('card-4') &&
          action.targetItemIds.includes('card-5') &&
          action.targetItemIds.includes('card-6')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-three-column-matrix-gutter-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: gutterActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const card4 = execution.items.find((item) => item.id === 'card-4') as CanvasAnnotationItem
    const card5 = execution.items.find((item) => item.id === 'card-5') as CanvasAnnotationItem
    const card6 = execution.items.find((item) => item.id === 'card-6') as CanvasAnnotationItem
    const card8 = execution.items.find((item) => item.id === 'card-8') as CanvasAnnotationItem

    expect(card2.x).toBe(280)
    expect(card4.x).toBe(40)
    expect(card5.x).toBe(280)
    expect(card6.x).toBe(520)
    expect(card8.x).toBe(280)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-5',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'card-6',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved 3-column multi-row matrix row-rhythm actions by restoring the drifting row top only', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 280,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 520,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-4', {
        shape: 'rounded-rect',
        x: 40,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-5', {
        shape: 'rounded-rect',
        x: 280,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-6', {
        shape: 'rounded-rect',
        x: 520,
        y: 180,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-7', {
        shape: 'rounded-rect',
        x: 40,
        y: 320,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-8', {
        shape: 'rounded-rect',
        x: 280,
        y: 320,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-9', {
        shape: 'rounded-rect',
        x: 520,
        y: 320,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-10', {
        shape: 'rounded-rect',
        x: 40,
        y: 472,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-11', {
        shape: 'rounded-rect',
        x: 280,
        y: 472,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-12', {
        shape: 'rounded-rect',
        x: 520,
        y: 472,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rowRhythmActionIds = proposal.actions
      .filter(
        (action) =>
          action.type === 'align-top' &&
          action.targetItemIds.includes('card-10') &&
          action.targetItemIds.includes('card-11') &&
          action.targetItemIds.includes('card-12')
      )
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-three-column-matrix-row-rhythm-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: rowRhythmActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card8 = execution.items.find((item) => item.id === 'card-8') as CanvasAnnotationItem
    const card10 = execution.items.find((item) => item.id === 'card-10') as CanvasAnnotationItem
    const card11 = execution.items.find((item) => item.id === 'card-11') as CanvasAnnotationItem
    const card12 = execution.items.find((item) => item.id === 'card-12') as CanvasAnnotationItem

    expect(card8.y).toBe(320)
    expect(card10.y).toBe(460)
    expect(card11.y).toBe(460)
    expect(card12.y).toBe(460)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-10',
          field: 'y'
        }),
        expect.objectContaining({
          itemId: 'card-11',
          field: 'y'
        }),
        expect.objectContaining({
          itemId: 'card-12',
          field: 'y'
        })
      ])
    )
  })

  it('applies broader variable-width matrix left-track actions by restoring the drifting column anchor only', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 180,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 260,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 560,
        y: 40,
        width: 180,
        height: 120
      }),
      createAnnotationItem('card-4', {
        shape: 'rounded-rect',
        x: 40,
        y: 180,
        width: 200,
        height: 120
      }),
      createAnnotationItem('card-5', {
        shape: 'rounded-rect',
        x: 274,
        y: 180,
        width: 240,
        height: 120
      }),
      createAnnotationItem('card-6', {
        shape: 'rounded-rect',
        x: 560,
        y: 180,
        width: 200,
        height: 120
      }),
      createAnnotationItem('card-7', {
        shape: 'rounded-rect',
        x: 40,
        y: 320,
        width: 160,
        height: 120
      }),
      createAnnotationItem('card-8', {
        shape: 'rounded-rect',
        x: 260,
        y: 320,
        width: 260,
        height: 120
      }),
      createAnnotationItem('card-9', {
        shape: 'rounded-rect',
        x: 560,
        y: 320,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const leftTrackActionIds = proposal.actions
      .filter((action) => action.type === 'align-left' && action.targetItemIds.includes('card-5'))
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-three-column-matrix-graph-left-track-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: leftTrackActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const card5 = execution.items.find((item) => item.id === 'card-5') as CanvasAnnotationItem
    const card8 = execution.items.find((item) => item.id === 'card-8') as CanvasAnnotationItem

    expect(card2.x).toBe(260)
    expect(card5.x).toBe(260)
    expect(card8.x).toBe(260)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-5',
          field: 'x'
        })
      ])
    )
  })

  it('applies broader variable-width matrix right-track actions by restoring the drifting right anchor only', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 180,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 280,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 560,
        y: 40,
        width: 180,
        height: 120
      }),
      createAnnotationItem('card-4', {
        shape: 'rounded-rect',
        x: 40,
        y: 180,
        width: 200,
        height: 120
      }),
      createAnnotationItem('card-5', {
        shape: 'rounded-rect',
        x: 274,
        y: 180,
        width: 240,
        height: 120
      }),
      createAnnotationItem('card-6', {
        shape: 'rounded-rect',
        x: 560,
        y: 180,
        width: 200,
        height: 120
      }),
      createAnnotationItem('card-7', {
        shape: 'rounded-rect',
        x: 40,
        y: 320,
        width: 160,
        height: 120
      }),
      createAnnotationItem('card-8', {
        shape: 'rounded-rect',
        x: 220,
        y: 320,
        width: 280,
        height: 120
      }),
      createAnnotationItem('card-9', {
        shape: 'rounded-rect',
        x: 560,
        y: 320,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rightTrackActionIds = proposal.actions
      .filter((action) => action.type === 'align-right' && action.targetItemIds.includes('card-5'))
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-three-column-matrix-graph-right-track-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: rightTrackActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const card5 = execution.items.find((item) => item.id === 'card-5') as CanvasAnnotationItem
    const card8 = execution.items.find((item) => item.id === 'card-8') as CanvasAnnotationItem

    expect(card2.x).toBe(280)
    expect(card5.x).toBe(260)
    expect(card8.x).toBe(220)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-5',
          field: 'x'
        })
      ])
    )
  })

  it('applies broader variable-width matrix center-track actions by restoring the drifting column center only', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 180,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 280,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 560,
        y: 40,
        width: 180,
        height: 120
      }),
      createAnnotationItem('card-4', {
        shape: 'rounded-rect',
        x: 40,
        y: 180,
        width: 200,
        height: 120
      }),
      createAnnotationItem('card-5', {
        shape: 'rounded-rect',
        x: 282,
        y: 180,
        width: 240,
        height: 120
      }),
      createAnnotationItem('card-6', {
        shape: 'rounded-rect',
        x: 560,
        y: 180,
        width: 200,
        height: 120
      }),
      createAnnotationItem('card-7', {
        shape: 'rounded-rect',
        x: 40,
        y: 320,
        width: 160,
        height: 120
      }),
      createAnnotationItem('card-8', {
        shape: 'rounded-rect',
        x: 260,
        y: 320,
        width: 260,
        height: 120
      }),
      createAnnotationItem('card-9', {
        shape: 'rounded-rect',
        x: 560,
        y: 320,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const centerTrackActionIds = proposal.actions
      .filter((action) => action.type === 'align-center' && action.targetItemIds.includes('card-5'))
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-three-column-matrix-graph-center-track-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: centerTrackActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const card5 = execution.items.find((item) => item.id === 'card-5') as CanvasAnnotationItem
    const card8 = execution.items.find((item) => item.id === 'card-8') as CanvasAnnotationItem

    expect(card2.x).toBe(280)
    expect(card5.x).toBe(270)
    expect(card8.x).toBe(260)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-5',
          field: 'x'
        })
      ])
    )
  })

  it('applies mixed-anchor row-drift actions by shifting the whole row without disturbing other rows', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', {
        shape: 'rounded-rect',
        x: 40,
        y: 40,
        width: 180,
        height: 120
      }),
      createAnnotationItem('card-2', {
        shape: 'rounded-rect',
        x: 280,
        y: 40,
        width: 220,
        height: 120
      }),
      createAnnotationItem('card-3', {
        shape: 'rounded-rect',
        x: 600,
        y: 40,
        width: 180,
        height: 120
      }),
      createAnnotationItem('card-4', {
        shape: 'rounded-rect',
        x: 52,
        y: 180,
        width: 200,
        height: 120
      }),
      createAnnotationItem('card-5', {
        shape: 'rounded-rect',
        x: 282,
        y: 180,
        width: 240,
        height: 120
      }),
      createAnnotationItem('card-6', {
        shape: 'rounded-rect',
        x: 592,
        y: 180,
        width: 200,
        height: 120
      }),
      createAnnotationItem('card-7', {
        shape: 'rounded-rect',
        x: 40,
        y: 320,
        width: 160,
        height: 120
      }),
      createAnnotationItem('card-8', {
        shape: 'rounded-rect',
        x: 260,
        y: 320,
        width: 260,
        height: 120
      }),
      createAnnotationItem('card-9', {
        shape: 'rounded-rect',
        x: 560,
        y: 320,
        width: 220,
        height: 120
      })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const rowDriftActionIds = proposal.actions
      .filter((action) => action.type === 'shift-horizontal')
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-three-column-matrix-graph-row-drift-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: rowDriftActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card1 = execution.items.find((item) => item.id === 'card-1') as CanvasAnnotationItem
    const card4 = execution.items.find((item) => item.id === 'card-4') as CanvasAnnotationItem
    const card5 = execution.items.find((item) => item.id === 'card-5') as CanvasAnnotationItem
    const card6 = execution.items.find((item) => item.id === 'card-6') as CanvasAnnotationItem
    const card8 = execution.items.find((item) => item.id === 'card-8') as CanvasAnnotationItem

    expect(card1.x).toBe(40)
    expect(card4.x).toBe(40)
    expect(card5.x).toBe(270)
    expect(card6.x).toBe(580)
    expect(card8.x).toBe(260)
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-4',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'card-5',
          field: 'x'
        }),
        expect.objectContaining({
          itemId: 'card-6',
          field: 'x'
        })
      ])
    )
  })

  it('applies approved radius actions by normalizing annotation shapes', () => {
    const items: CanvasItem[] = [
      createAnnotationItem('card-1', { shape: 'rounded-rect', x: 40, y: 40 }),
      createAnnotationItem('card-2', { shape: 'rect', x: 40, y: 168 }),
      createAnnotationItem('card-3', { shape: 'rounded-rect', x: 40, y: 296 })
    ]
    const contextPack = buildDesignInspectionContextPack({
      task: 'Inspect the selected cards.',
      targetItems: items,
      groups: [],
      snapshotDataUrl: null
    })
    const proposal = buildStructureFirstDesignInspectionProposal(contextPack)
    const radiusActionIds = proposal.actions
      .filter((action) => action.type === 'normalize-annotation-corner-style')
      .map((action) => action.id)
    const approval: DesignInspectionApproval = {
      id: 'approval-card-radius-1',
      contextPackId: contextPack.id,
      proposalId: proposal.id,
      status: 'approved',
      approvedActions: radiusActionIds,
      userNotes: '',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:01.000Z'
    }

    const execution = applyDesignInspectionProposal(items, proposal, approval)
    const card1 = execution.items.find((item) => item.id === 'card-1') as CanvasAnnotationItem
    const card2 = execution.items.find((item) => item.id === 'card-2') as CanvasAnnotationItem
    const card3 = execution.items.find((item) => item.id === 'card-3') as CanvasAnnotationItem

    expect(card1.shape).toBe('rounded-rect')
    expect(card2.shape).toBe('rounded-rect')
    expect(card3.shape).toBe('rounded-rect')
    expect(execution.result.appliedChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'card-2',
          field: 'annotation-corner-style'
        })
      ])
    )
  })
})
