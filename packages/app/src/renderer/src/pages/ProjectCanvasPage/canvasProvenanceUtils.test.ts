import { describe, expect, it, vi } from 'vitest'

import {
  createExternalCanvasProvenance,
  createImportedFileProvenance,
  createMagicPotNativeProvenance,
  deriveCanvasGroupProvenance,
  summarizeCanvasItemProvenanceForBridge
} from './canvasProvenanceUtils'
import type { CanvasItem } from './types'

function createCanvasItemWithProvenance(
  provenance: CanvasItem['provenance']
): Pick<CanvasItem, 'provenance'> {
  return { provenance }
}

describe('canvasProvenanceUtils', () => {
  it('creates native provenance for in-canvas items', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-28T07:05:00.000Z'))

    expect(
      createMagicPotNativeProvenance({
        notes: 'Created from text tool'
      })
    ).toEqual({
      kind: 'magicpot-native',
      importedAt: '2026-03-28T07:05:00.000Z',
      notes: 'Created from text tool'
    })

    vi.useRealTimers()
  })

  it('creates imported-file provenance for local file intake', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-28T07:06:00.000Z'))

    expect(
      createImportedFileProvenance('hero-card.png', {
        notes: 'Dropped into canvas'
      })
    ).toEqual({
      kind: 'imported-file',
      sourceFileName: 'hero-card.png',
      importedAt: '2026-03-28T07:06:00.000Z',
      notes: 'Dropped into canvas'
    })

    vi.useRealTimers()
  })

  it('creates external provenance for bridge-driven payloads', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-28T07:07:00.000Z'))

    expect(
      createExternalCanvasProvenance({
        sourceFileName: 'bridge-selection.png',
        bridgeTraceId: 'bridge-77',
        notes: 'Received canvas:add-image event'
      })
    ).toEqual({
      kind: 'external',
      sourceFileName: 'bridge-selection.png',
      bridgeTraceId: 'bridge-77',
      importedAt: '2026-03-28T07:07:00.000Z',
      notes: 'Received canvas:add-image event'
    })

    vi.useRealTimers()
  })

  it('inherits a shared upstream source when a new group is built from matching imported items', () => {
    const groupProvenance = deriveCanvasGroupProvenance(
      [
        createCanvasItemWithProvenance({
          kind: 'figma',
          sourceFileName: 'Landing.fig',
          sourceDocumentId: 'file-1',
          bridgeTraceId: 'bridge-figma-9',
          notes: 'Imported from Figma selection'
        }),
        createCanvasItemWithProvenance({
          kind: 'figma',
          sourceFileName: 'Landing.fig',
          sourceDocumentId: 'file-1',
          bridgeTraceId: 'bridge-figma-9',
          notes: 'Imported from Figma selection'
        })
      ],
      {
        importedAt: '2026-03-28T07:08:00.000Z',
        groupName: 'Hero stack'
      }
    )

    expect(groupProvenance).toEqual({
      kind: 'figma',
      sourceFileName: 'Landing.fig',
      sourceDocumentId: 'file-1',
      bridgeTraceId: 'bridge-figma-9',
      importedAt: '2026-03-28T07:08:00.000Z',
      notes: 'Imported from Figma selection | Grouped in MagicPot as Hero stack'
    })
  })

  it('falls back to native provenance when grouped items do not share one upstream source', () => {
    const groupProvenance = deriveCanvasGroupProvenance(
      [
        createCanvasItemWithProvenance({
          kind: 'figma',
          sourceFileName: 'Landing.fig'
        }),
        createCanvasItemWithProvenance({
          kind: 'psd',
          sourceFileName: 'Cards.psd'
        })
      ],
      {
        importedAt: '2026-03-28T07:09:00.000Z',
        groupName: 'Mixed imports'
      }
    )

    expect(groupProvenance).toEqual({
      kind: 'magicpot-native',
      importedAt: '2026-03-28T07:09:00.000Z',
      notes: 'Grouped in MagicPot as Mixed imports'
    })
  })

  it('builds a compact source-context summary for Adobe handoff packages', () => {
    const sourceContextSummary = summarizeCanvasItemProvenanceForBridge(
      [
        {
          id: 'text-1',
          type: 'text',
          text: 'Hero headline',
          provenance: {
            kind: 'figma',
            sourceFileName: 'Landing.fig',
            sourceNodeName: 'Headline'
          }
        },
        {
          id: 'image-1',
          type: 'image',
          fileName: 'hero-card.png',
          provenance: {
            kind: 'imported-file',
            sourceFileName: 'hero-card.png'
          }
        },
        {
          id: 'shape-1',
          type: 'annotation',
          label: 'CTA callout',
          provenance: {
            kind: 'external',
            bridgeTraceId: 'bridge-42'
          }
        }
      ],
      2
    )

    expect(sourceContextSummary).toEqual({
      kindLabels: ['Figma 1', 'Imported file 1', 'External entry 1'],
      detailLines: [
        'Hero headline -> Figma / Headline',
        'hero-card.png -> Imported file / hero-card.png'
      ],
      totalItemCount: 3,
      hiddenDetailCount: 1
    })
  })
})
