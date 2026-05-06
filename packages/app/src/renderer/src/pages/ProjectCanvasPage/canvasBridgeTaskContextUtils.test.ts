import { describe, expect, it } from 'vitest'
import type {
  DesignInspectionApproval,
  DesignInspectionContextPack,
  DesignInspectionExecutionResult,
  DesignInspectionProposal
} from '@shared/designInspection'
import { buildDesignInspectionBridgeTaskContext } from './canvasBridgeTaskContextUtils'

function createContextPack(): DesignInspectionContextPack {
  return {
    id: 'design-context-1',
    createdAt: '2026-03-28T10:00:00.000Z',
    task: 'Inspect selected items',
    projectId: 'canvas-1',
    projectName: 'Canvas One',
    structureFirst: true,
    selection: {
      itemIds: ['item-1', 'item-2'],
      groupIds: [],
      bounds: null
    },
    selectionItems: [],
    canvasSnapshot: null,
    documents: [],
    references: [],
    rules: [],
    fallbackSignals: []
  }
}

function createProposal(): DesignInspectionProposal {
  return {
    id: 'design-proposal-1',
    contextPackId: 'design-context-1',
    generatedAt: '2026-03-28T10:01:00.000Z',
    summary: 'Summary',
    issues: [],
    actions: [],
    rationale: 'Rationale',
    expectedResult: 'Expected result',
    executionPlan: []
  }
}

function createApproval(
  status: DesignInspectionApproval['status'] = 'approved'
): DesignInspectionApproval {
  return {
    id: 'design-approval-1',
    contextPackId: 'design-context-1',
    proposalId: 'design-proposal-1',
    status,
    approvedActions: [],
    userNotes: '',
    createdAt: '2026-03-28T10:02:00.000Z',
    updatedAt: '2026-03-28T10:03:00.000Z'
  }
}

function createExecutionResult(): DesignInspectionExecutionResult {
  return {
    id: 'design-execution-1',
    contextPackId: 'design-context-1',
    proposalId: 'design-proposal-1',
    approvalId: 'design-approval-1',
    status: 'success',
    executor: 'magicpot-internal',
    appliedChanges: [],
    artifacts: [],
    trace: []
  }
}

describe('buildDesignInspectionBridgeTaskContext', () => {
  it('returns task context when export items stay within the active inspection scope', () => {
    expect(
      buildDesignInspectionBridgeTaskContext({
        sessionId: 'design-session-1',
        inspectionTargetItemIds: ['item-1', 'item-2', 'item-3'],
        exportItemIds: ['item-1', 'item-2'],
        contextPack: createContextPack(),
        proposal: createProposal(),
        approval: createApproval(),
        executionResult: createExecutionResult()
      })
    ).toEqual({
      sessionId: 'design-session-1',
      contextPackId: 'design-context-1',
      proposalId: 'design-proposal-1',
      approvalId: 'design-approval-1',
      approvalStatus: 'approved',
      executionResultId: 'design-execution-1'
    })
  })

  it('falls back to context-pack selection item ids when explicit inspection target ids are unavailable', () => {
    expect(
      buildDesignInspectionBridgeTaskContext({
        sessionId: 'design-session-2',
        inspectionTargetItemIds: [],
        exportItemIds: ['item-1'],
        contextPack: createContextPack(),
        proposal: createProposal(),
        approval: createApproval('pending'),
        executionResult: null
      })
    ).toEqual({
      sessionId: 'design-session-2',
      contextPackId: 'design-context-1',
      proposalId: 'design-proposal-1',
      approvalId: 'design-approval-1',
      approvalStatus: 'pending',
      executionResultId: undefined
    })
  })

  it('returns undefined when the export selection falls outside the active inspection scope', () => {
    expect(
      buildDesignInspectionBridgeTaskContext({
        sessionId: 'design-session-3',
        inspectionTargetItemIds: ['item-1', 'item-2'],
        exportItemIds: ['item-3'],
        contextPack: createContextPack(),
        proposal: createProposal(),
        approval: createApproval(),
        executionResult: createExecutionResult()
      })
    ).toBeUndefined()
  })
})
