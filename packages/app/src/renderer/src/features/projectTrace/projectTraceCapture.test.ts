import { describe, expect, it } from 'vitest'
import {
  DRAFT_TRACE_TAG,
  REFERENCE_READY_TRACE_TAG,
  REFERENCE_REVIEW_TRACE_TAG,
  applyTraceReferenceReadinessTags,
  evaluateTraceReferenceReadiness,
  getDraftTraceTags,
  getSavedTraceTags,
  isReferenceReadyTraceTagSet
} from './projectTraceCapture'
import type { ProjectTraceEventSummary } from '@shared/projectTrace'

const canvasMoveEvent: ProjectTraceEventSummary = {
  id: 'event-1',
  at: '2026-05-03T09:00:00.000Z',
  scope: 'canvas',
  action: 'canvas_items_changed',
  status: 'success',
  safeSummary: '移动 2 个画布元素。'
}

describe('projectTraceCapture', () => {
  it('requires user intent and operation evidence before a trace can be referenced', () => {
    expect(evaluateTraceReferenceReadiness('', [canvasMoveEvent])).toMatchObject({
      referenceReady: false
    })
    expect(
      evaluateTraceReferenceReadiness('验证角色立绘对齐流程，移动素材用于确认排版规则。', [
        canvasMoveEvent
      ])
    ).toMatchObject({
      referenceReady: true,
      reasons: []
    })
  })

  it('keeps stopped captures as drafts until the user saves them', () => {
    const draftTags = getDraftTraceTags(['manual', 'active-capture'], true)
    expect(draftTags).toContain(DRAFT_TRACE_TAG)
    expect(draftTags).toContain(REFERENCE_READY_TRACE_TAG)
    expect(draftTags).not.toContain('active-capture')

    const savedTags = getSavedTraceTags(draftTags)
    expect(savedTags).not.toContain(DRAFT_TRACE_TAG)
    expect(isReferenceReadyTraceTagSet(savedTags)).toBe(true)

    expect(applyTraceReferenceReadinessTags(savedTags, false)).toContain(REFERENCE_REVIEW_TRACE_TAG)
  })
})
