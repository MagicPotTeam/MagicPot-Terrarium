import { beforeEach, describe, expect, it } from 'vitest'

import type { GenerationRouteChoice, GenerationTaskPack } from './canvasGenerationTaskPack'
import {
  appendGenerationTraceCandidate,
  beginGenerationTraceSession,
  createGenerationTraceSessionId
} from './generationTraceRuntime'
import { listGenerationTraceRecords } from './generationTraceStorage'

function createTestTaskPack(): GenerationTaskPack {
  return {
    projectId: 'canvas-1',
    projectName: 'MagicPot Demo',
    selectedItemIds: ['file-1', 'img-1'],
    summary: {
      totalItems: 2,
      requirementDocs: 1,
      referenceDocs: 0,
      referenceImages: 1,
      styleReferenceImages: 0,
      taskNotes: 0,
      existingAssets: 0
    },
    requirementDocs: [
      {
        id: 'file-1',
        title: 'brief.docx',
        excerpt: 'Character brief',
        contentText: 'Create a wandering male character concept.'
      }
    ],
    referenceDocs: [],
    referenceImages: [{ id: 'img-1', title: 'reference-1.png' }],
    styleReferenceImages: [],
    taskNotes: [],
    existingAssets: []
  }
}

function createProjectRoute(): GenerationRouteChoice {
  return {
    type: 'project-style-model',
    modelId: 'model-1',
    modelLabel: 'Hero QuickApp'
  }
}

describe('generationTraceRuntime', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts and persists a generation trace session', () => {
    const sessionId = createGenerationTraceSessionId()

    const record = beginGenerationTraceSession({
      canvasId: 'canvas-1',
      sessionId,
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1', 'img-1'],
      routeChoice: createProjectRoute(),
      taskPack: createTestTaskPack(),
      notes: 'Dispatched from canvas'
    })

    expect(record.sessionId).toBe(sessionId)
    expect(record.userDecision).toBe('pending')
    expect(record.timeline.some((entry) => entry.stage === 'generation_started')).toBe(true)

    const records = listGenerationTraceRecords('canvas-1')
    expect(records).toHaveLength(1)
    expect(records[0].sessionId).toBe(sessionId)
  })

  it('appends returned candidates to an existing session', () => {
    const sessionId = createGenerationTraceSessionId()
    beginGenerationTraceSession({
      canvasId: 'canvas-1',
      sessionId,
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1', 'img-1'],
      routeChoice: createProjectRoute(),
      taskPack: createTestTaskPack()
    })

    const updatedRecord = appendGenerationTraceCandidate({
      canvasId: 'canvas-1',
      sessionId,
      candidate: {
        canvasItemId: 'img-candidate-1',
        fileName: 'candidate-1.png',
        src: 'blob:candidate-1',
        thumbnailSrc: 'blob:candidate-1'
      }
    })

    expect(updatedRecord).not.toBeNull()
    expect(updatedRecord?.candidates).toHaveLength(1)
    expect(updatedRecord?.candidates[0]).toMatchObject({
      canvasItemId: 'img-candidate-1',
      fileName: 'candidate-1.png',
      src: 'blob:candidate-1'
    })

    const records = listGenerationTraceRecords('canvas-1')
    expect(records[0].timeline.some((entry) => entry.stage === 'candidate_returned')).toBe(true)
  })

  it('ignores candidate appends for unknown sessions', () => {
    const result = appendGenerationTraceCandidate({
      canvasId: 'canvas-1',
      sessionId: 'missing-session',
      candidate: {
        fileName: 'missing.png'
      }
    })

    expect(result).toBeNull()
    expect(listGenerationTraceRecords('canvas-1')).toEqual([])
  })
})
