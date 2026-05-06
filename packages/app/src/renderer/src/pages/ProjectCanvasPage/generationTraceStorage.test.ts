import { beforeEach, describe, expect, it } from 'vitest'
import type { GenerationTaskPack } from './canvasGenerationTaskPack'
import type { GenerationRouteChoice } from './canvasGenerationTaskPack'
import {
  createGenerationTraceRecord,
  addCandidateToTraceRecord,
  updateTraceUserDecision,
  listGenerationTraceRecords,
  upsertGenerationTraceRecord,
  removeGenerationTraceRecord,
  snapshotTaskPack,
  type GenerationTraceRecord
} from './generationTraceStorage'

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
        title: '需求文档.md',
        excerpt: '主角色立绘需求',
        contentText: '请根据角色设定生成立绘候选图'
      }
    ],
    referenceDocs: [],
    referenceImages: [{ id: 'img-1', title: '参考图-01.png' }],
    styleReferenceImages: [],
    taskNotes: [],
    existingAssets: []
  }
}

function createProjectModelRoute(): GenerationRouteChoice {
  return {
    type: 'project-style-model',
    modelId: 'model-abc',
    modelLabel: '赛博风格 LoRA'
  }
}

function createDefaultAgentRoute(): GenerationRouteChoice {
  return { type: 'default-agent' }
}

describe('generationTraceStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('snapshots a task pack into a compact trace-friendly shape', () => {
    const taskPack = createTestTaskPack()
    const snapshot = snapshotTaskPack(taskPack)

    expect(snapshot.summary.totalItems).toBe(2)
    expect(snapshot.requirementDocTitles).toEqual(['需求文档.md'])
    expect(snapshot.referenceImageCount).toBe(1)
    expect(snapshot.styleReferenceImageCount).toBe(0)
  })

  it('creates a trace record with task pack, route choice, and timeline', () => {
    const taskPack = createTestTaskPack()
    const route = createProjectModelRoute()

    const record = createGenerationTraceRecord({
      sessionId: 'gen-session-1',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      agentScope: 'canvas-1.agent-2',
      agentSessionKey: 'canvas:thread:canvas-1:thread:agent-2',
      selectedItemIds: ['file-1', 'img-1'],
      routeChoice: route,
      taskPack,
      notes: '首轮生成'
    })

    expect(record.sessionId).toBe('gen-session-1')
    expect(record.projectId).toBe('canvas-1')
    expect(record.agentScope).toBe('canvas-1.agent-2')
    expect(record.agentSessionKey).toBe('canvas:thread:canvas-1:thread:agent-2')
    expect(record.routeChoice).toEqual(route)
    expect(record.taskPackSnapshot.summary.totalItems).toBe(2)
    expect(record.candidates).toEqual([])
    expect(record.userDecision).toBe('pending')
    expect(record.notes).toBe('首轮生成')
    expect(record.timeline.map((e) => e.stage)).toEqual(['task_pack_built', 'route_selected'])
    expect(record.timeline[1].message).toContain('赛博风格 LoRA')
  })

  it('creates a trace record for default-agent route', () => {
    const taskPack = createTestTaskPack()
    const route = createDefaultAgentRoute()

    const record = createGenerationTraceRecord({
      sessionId: 'gen-session-default-agent',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1'],
      routeChoice: route,
      taskPack
    })

    expect(record.routeChoice.type).toBe('default-agent')
    expect(record.timeline[1].message).toContain('默认 Agent')
  })

  it('adds candidate images to a trace record', () => {
    const taskPack = createTestTaskPack()
    const record = createGenerationTraceRecord({
      sessionId: 'gen-session-2',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1'],
      routeChoice: createProjectModelRoute(),
      taskPack
    })

    const withCandidate = addCandidateToTraceRecord(record, {
      id: 'candidate-1',
      canvasItemId: 'canvas-img-101',
      fileName: 'candidate-01.png',
      generatedAt: new Date().toISOString()
    })

    expect(withCandidate.candidates).toHaveLength(1)
    expect(withCandidate.candidates[0].fileName).toBe('candidate-01.png')
    expect(withCandidate.timeline.find((e) => e.stage === 'candidate_returned')).toBeDefined()
  })

  it('tracks user decisions through the trace lifecycle', () => {
    const taskPack = createTestTaskPack()
    let record = createGenerationTraceRecord({
      sessionId: 'gen-session-3',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1'],
      routeChoice: createProjectModelRoute(),
      taskPack
    })

    record = addCandidateToTraceRecord(record, {
      id: 'candidate-1',
      fileName: 'v1.png',
      generatedAt: new Date().toISOString()
    })

    record = updateTraceUserDecision(record, 'approved', undefined, '采纳第一轮')

    expect(record.userDecision).toBe('approved')
    expect(record.notes).toBe('采纳第一轮')
    expect(record.timeline.find((e) => e.stage === 'user_approved')).toBeDefined()
  })

  it('tracks retry decisions with follow-up session', () => {
    const taskPack = createTestTaskPack()
    let record = createGenerationTraceRecord({
      sessionId: 'gen-session-4',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1'],
      routeChoice: createDefaultAgentRoute(),
      taskPack
    })

    record = updateTraceUserDecision(record, 'retried', 'gen-session-5')

    expect(record.userDecision).toBe('retried')
    expect(record.followUpSessionId).toBe('gen-session-5')
    expect(record.timeline.find((e) => e.stage === 'user_retried')).toBeDefined()
  })

  it('persists and replaces trace records by session id', () => {
    const taskPack = createTestTaskPack()
    const first = createGenerationTraceRecord({
      sessionId: 'gen-persist-1',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1'],
      routeChoice: createProjectModelRoute(),
      taskPack
    })

    const second = createGenerationTraceRecord({
      sessionId: 'gen-persist-2',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1', 'img-1'],
      routeChoice: createDefaultAgentRoute(),
      taskPack
    })

    upsertGenerationTraceRecord('canvas-1', first)
    upsertGenerationTraceRecord('canvas-1', second)

    const records = listGenerationTraceRecords('canvas-1')
    expect(records).toHaveLength(2)
    expect(records[0].sessionId).toBe('gen-persist-2')
    expect(records[1].sessionId).toBe('gen-persist-1')

    // Update first record
    const updated = updateTraceUserDecision(first, 'approved')
    upsertGenerationTraceRecord('canvas-1', updated)

    const afterUpdate = listGenerationTraceRecords('canvas-1')
    expect(afterUpdate).toHaveLength(2)
    expect(afterUpdate[0].sessionId).toBe('gen-persist-1')
    expect(afterUpdate[0].userDecision).toBe('approved')
    // merging preserves original createdAt
    expect(afterUpdate[0].createdAt).toBe(first.createdAt)
    // merging dedupes timeline entries
    expect(afterUpdate[0].timeline.length).toBeGreaterThanOrEqual(2)
  })

  it('removes a persisted trace record by session id', () => {
    const taskPack = createTestTaskPack()
    const first = createGenerationTraceRecord({
      sessionId: 'gen-delete-1',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1'],
      routeChoice: createProjectModelRoute(),
      taskPack
    })
    const second = createGenerationTraceRecord({
      sessionId: 'gen-delete-2',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1'],
      routeChoice: createDefaultAgentRoute(),
      taskPack
    })

    upsertGenerationTraceRecord('canvas-del', first)
    upsertGenerationTraceRecord('canvas-del', second)

    const remaining = removeGenerationTraceRecord('canvas-del', 'gen-delete-1')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].sessionId).toBe('gen-delete-2')

    const emptied = removeGenerationTraceRecord('canvas-del', 'gen-delete-2')
    expect(emptied).toEqual([])
    expect(localStorage.getItem('canvas.generationTrace.canvas-del')).toBeNull()
  })

  it('limits stored records to the configured maximum', () => {
    const taskPack = createTestTaskPack()

    for (let i = 0; i < 35; i++) {
      const record = createGenerationTraceRecord({
        sessionId: `gen-limit-${i}`,
        projectId: 'canvas-1',
        projectName: 'MagicPot Demo',
        selectedItemIds: ['file-1'],
        routeChoice: createProjectModelRoute(),
        taskPack
      })
      upsertGenerationTraceRecord('canvas-limit', record)
    }

    const records = listGenerationTraceRecords('canvas-limit')
    expect(records.length).toBeLessThanOrEqual(30)
    // Most recent is first
    expect(records[0].sessionId).toBe('gen-limit-34')
  })

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('canvas.generationTrace.canvas-corrupt', 'not-json')
    expect(listGenerationTraceRecords('canvas-corrupt')).toEqual([])

    localStorage.setItem('canvas.generationTrace.canvas-corrupt2', JSON.stringify({ not: 'array' }))
    expect(listGenerationTraceRecords('canvas-corrupt2')).toEqual([])
  })
})
