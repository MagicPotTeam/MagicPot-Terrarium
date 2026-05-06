import { describe, expect, it } from 'vitest'
import {
  summarizeCanvasTargetActionForJournal,
  summarizeCanvasTargetAttachmentsForJournal,
  summarizeCanvasTargetJournal,
  type CanvasTargetExecutionJournalEntry
} from './canvasTargetExecutionJournal'
import type { CanvasTargetCanvasAction } from './canvasTargetCapabilities'

describe('canvasTargetExecutionJournal', () => {
  it('summarizes actions without leaking raw media URLs or large text', () => {
    const action: CanvasTargetCanvasAction = {
      type: 'canvas',
      id: 'copy-upscaled',
      action: 'add_image',
      phase: 'after_stage',
      stageId: 'upscale-stage',
      outputTarget: 'canvas',
      sourceUrl: 'data:image/png;base64,' + 'A'.repeat(200),
      text: 'x'.repeat(220)
    }

    const summary = summarizeCanvasTargetActionForJournal(action)

    expect(summary).toEqual(
      expect.objectContaining({
        type: 'canvas',
        id: 'copy-upscaled',
        action: 'add_image',
        phase: 'after_stage',
        stageId: 'upscale-stage',
        hasSourceUrl: true
      })
    )
    expect(JSON.stringify(summary)).not.toContain('data:image/png;base64')
    expect(summary?.textPreview?.length).toBeLessThanOrEqual(183)
  })

  it('keeps the digest delta-only and bounded to recent entries', () => {
    const journal: CanvasTargetExecutionJournalEntry[] = Array.from({ length: 12 }, (_, index) => ({
      stageId: `stage-${index + 1}`,
      kind: index % 2 === 0 ? 'canvas_action' : 'model',
      label: `Stage ${index + 1}`,
      status: 'success',
      inputCanvasVersion: index + 1,
      outputCanvasVersion: index + 2,
      inputItemIds: [`input-${index}`],
      outputItemIds: [`output-${index}`],
      affectedItemIds: [`affected-${index}`],
      createdItemIds: [`created-${index}`],
      canvasMutation: index % 2 === 0,
      summary: 'Result ' + 'x'.repeat(220),
      attachmentSummaries: summarizeCanvasTargetAttachmentsForJournal([
        {
          type: 'image',
          url: 'data:image/png;base64,' + 'B'.repeat(200),
          fileName: `image-${index}.png`
        }
      ])
    }))

    const digest = summarizeCanvasTargetJournal(journal, 13, 4)

    expect(digest.canvasVersion).toBe(13)
    expect(digest.entryCount).toBe(12)
    expect(digest.omittedEntryCount).toBe(8)
    expect(digest.recentEntries).toHaveLength(4)
    expect(digest.counters.byKind.canvas_action).toBe(6)
    expect(digest.counters.canvasMutationCount).toBe(6)
    expect(JSON.stringify(digest)).not.toContain('data:image/png;base64')
    expect(digest.recentEntries[0].summary.length).toBeLessThanOrEqual(183)
  })
})
