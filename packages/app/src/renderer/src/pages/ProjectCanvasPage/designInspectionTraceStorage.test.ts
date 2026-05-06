import { beforeEach, describe, expect, it } from 'vitest'
import type {
  DesignInspectionApproval,
  DesignInspectionContextPack,
  DesignInspectionExecutionResult,
  DesignInspectionProposal
} from '@shared/designInspection'
import {
  createDesignInspectionTraceRecord,
  hydrateDesignInspectionTraceSession,
  listDesignInspectionTraceRecords,
  removeDesignInspectionTraceRecord,
  restoreDesignInspectionTraceRecord,
  type DesignInspectionTraceRecord,
  upsertDesignInspectionTraceRecord
} from './designInspectionTraceStorage'

const LONG_TEXT = 'x'.repeat(2105)

function createContextPack(): DesignInspectionContextPack {
  return {
    id: 'context-1',
    createdAt: '2026-03-27T00:00:00.000Z',
    task: `Inspect ${LONG_TEXT}`,
    projectId: 'canvas-1',
    projectName: 'MagicPot Demo',
    structureFirst: true,
    selection: {
      itemIds: ['file-1'],
      groupIds: ['group-1'],
      bounds: { x: 40, y: 80, width: 320, height: 180 }
    },
    selectionItems: [
      {
        id: 'file-1',
        type: 'file',
        x: 40,
        y: 80,
        width: 320,
        height: 180,
        zIndex: 1,
        locked: false,
        bounds: { x: 40, y: 80, width: 320, height: 180 },
        fileName: 'brief-1.md',
        mimeType: 'text/markdown',
        previewText: `Preview ${LONG_TEXT}`,
        textContent: `Copy ${LONG_TEXT}`,
        provenance: {
          kind: 'imported-file',
          sourceFileName: 'marketing-brief.md',
          sourceDocumentId: 'workspace-briefs',
          notes: `Imported note ${LONG_TEXT}`
        }
      }
    ],
    canvasSnapshot: {
      type: 'image',
      label: 'selection-snapshot',
      mimeType: 'image/png',
      url: `data:image/png;base64,${LONG_TEXT}`
    },
    documents: [
      {
        itemId: 'file-1',
        fileName: 'brief-1.md',
        mimeType: 'text/markdown',
        editable: true,
        previewText: `Document ${LONG_TEXT}`
      }
    ],
    references: [
      {
        itemId: 'ref-1',
        type: 'image',
        label: 'Reference',
        detail: `Reference detail ${LONG_TEXT}`
      }
    ],
    rules: [
      {
        source: 'rulebook',
        content: `Rule ${LONG_TEXT}`
      }
    ],
    fallbackSignals: [
      {
        type: 'document-summary',
        label: 'doc-summary',
        content: `Signal ${LONG_TEXT}`
      }
    ]
  }
}

function createProposal(contextPackId: string): DesignInspectionProposal {
  return {
    id: 'proposal-1',
    contextPackId,
    generatedAt: '2026-03-27T00:01:00.000Z',
    summary: `Summary ${LONG_TEXT}`,
    issues: [
      {
        id: 'issue-1',
        category: 'content',
        severity: 'warning',
        title: `Title ${LONG_TEXT}`,
        summary: `Issue ${LONG_TEXT}`,
        itemIds: ['file-1'],
        evidence: [`Evidence ${LONG_TEXT}`],
        actionIds: ['action-1']
      }
    ],
    actions: [
      {
        id: 'action-1',
        type: 'update-file-content',
        title: 'Refresh markdown copy',
        description: 'Replace the markdown node with approved copy.',
        executor: 'magicpot-internal',
        targetItemIds: ['file-1'],
        payload: {
          content: `# Updated\n\n${LONG_TEXT}`
        },
        expectedImpact: 'The file node matches the approved copy.'
      }
    ],
    rationale: `Rationale ${LONG_TEXT}`,
    expectedResult: `Expected ${LONG_TEXT}`,
    executionPlan: [
      {
        step: 1,
        executor: 'magicpot-internal',
        actionIds: ['action-1'],
        description: `Execute ${LONG_TEXT}`
      }
    ]
  }
}

function createApproval(contextPackId: string, proposalId: string): DesignInspectionApproval {
  return {
    id: 'approval-1',
    contextPackId,
    proposalId,
    status: 'approved',
    approvedActions: ['action-1'],
    userNotes: `Notes ${LONG_TEXT}`,
    createdAt: '2026-03-27T00:02:00.000Z',
    updatedAt: '2026-03-27T00:03:00.000Z'
  }
}

function createExecutionResult(
  contextPackId: string,
  proposalId: string,
  approvalId: string
): DesignInspectionExecutionResult {
  return {
    id: 'execution-1',
    contextPackId,
    proposalId,
    approvalId,
    status: 'success',
    executor: 'magicpot-internal',
    appliedChanges: [
      {
        itemId: 'file-1',
        field: 'file-content',
        before: { content: 'old' },
        after: { content: 'new' },
        description: `Applied ${LONG_TEXT}`
      }
    ],
    artifacts: [
      {
        type: 'file',
        label: 'updated-brief',
        mimeType: 'text/markdown',
        url: `blob:${LONG_TEXT}`,
        content: `# Updated\n\n${LONG_TEXT}`
      }
    ],
    trace: [
      {
        at: '2026-03-27T00:03:00.000Z',
        stage: 'execution_applied',
        message: `Trace ${LONG_TEXT}`
      }
    ]
  }
}

describe('designInspectionTraceStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('captures a reusable trace record with context, proposal, approval, and execution snapshots', () => {
    const contextPack = createContextPack()
    const proposal = createProposal(contextPack.id)
    const approval = createApproval(contextPack.id, proposal.id)
    const executionResult = createExecutionResult(contextPack.id, proposal.id, approval.id)

    const record = createDesignInspectionTraceRecord({
      sessionId: 'session-1',
      contextPack,
      proposal,
      approval,
      executionResult,
      selectedActionIds: ['action-1'],
      notes: `Reviewer ${LONG_TEXT}`
    })

    expect(record.contextSnapshot.selection.itemIds).toEqual(['file-1'])
    expect(record.selectedActionIds).toEqual(['action-1'])
    expect(record.proposalSnapshot.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'update-file-content',
          targetItemIds: ['file-1']
        })
      ])
    )
    expect(record.approvalSnapshot.status).toBe('approved')
    expect(record.executionResultSnapshot).toEqual(
      expect.objectContaining({
        id: 'execution-1',
        status: 'success'
      })
    )
    expect(record.timeline.map((entry) => entry.stage)).toEqual([
      'context_pack_built',
      'proposal_generated',
      'approval_recorded',
      'execution_applied'
    ])
    expect(record.timeline[2]).toEqual(
      expect.objectContaining({
        approvalStatus: 'approved'
      })
    )
    expect(record.timeline[3]).toEqual(
      expect.objectContaining({
        executionStatus: 'success'
      })
    )
    expect(record.contextSnapshot.canvasSnapshot).toEqual({
      type: 'image',
      label: 'selection-snapshot',
      mimeType: 'image/png'
    })
    expect(record.contextSnapshot.task.endsWith('...')).toBe(true)
    expect(record.contextSnapshot.selectionItems[0].previewText?.endsWith('...')).toBe(true)
    expect(record.contextSnapshot.selectionItems[0].provenance).toEqual(
      expect.objectContaining({
        kind: 'imported-file',
        sourceFileName: 'marketing-brief.md',
        notes: expect.stringMatching(/\.\.\.$/)
      })
    )
    const updateFileAction = record.proposalSnapshot.actions.find(
      (action) => action.type === 'update-file-content'
    )

    expect(updateFileAction).toBeDefined()
    expect(updateFileAction?.type).toBe('update-file-content')
    if (!updateFileAction || updateFileAction.type !== 'update-file-content') {
      throw new Error('Expected an update-file-content action in the proposal snapshot.')
    }
    expect(updateFileAction.payload.content.endsWith('...')).toBe(true)
    expect(record.executionResultSnapshot?.artifacts[0].url?.endsWith('...')).toBe(true)
    expect(record.executionResultSnapshot?.trace[0].message.endsWith('...')).toBe(true)
    expect(record.notes?.endsWith('...')).toBe(true)
  })

  it('persists and replaces trace records by session id', () => {
    const contextPack = createContextPack()
    const proposal = createProposal(contextPack.id)
    const approval = createApproval(contextPack.id, proposal.id)
    const executionResult = createExecutionResult(contextPack.id, proposal.id, approval.id)

    const first = createDesignInspectionTraceRecord({
      sessionId: 'session-1',
      contextPack,
      proposal,
      approval,
      executionResult
    })
    const replacement = createDesignInspectionTraceRecord({
      sessionId: 'session-1',
      contextPack,
      proposal,
      approval: {
        ...approval,
        status: 'rejected',
        approvedActions: [],
        updatedAt: '2026-03-27T00:04:00.000Z'
      },
      executionResult
    })
    replacement.summary = 'Rejected without applying changes.'
    const second = createDesignInspectionTraceRecord({
      sessionId: 'session-2',
      contextPack: { ...contextPack, id: 'context-2' },
      proposal: { ...proposal, id: 'proposal-2', contextPackId: 'context-2' },
      approval: {
        ...approval,
        id: 'approval-2',
        contextPackId: 'context-2',
        proposalId: 'proposal-2'
      },
      executionResult: null
    })

    upsertDesignInspectionTraceRecord('canvas-1', first)
    upsertDesignInspectionTraceRecord('canvas-1', second)
    upsertDesignInspectionTraceRecord('canvas-1', replacement)

    const records = listDesignInspectionTraceRecords('canvas-1')

    expect(records).toHaveLength(2)
    expect(records[0]).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        approvalStatus: 'rejected',
        approvedActionCount: 0,
        summary: 'Rejected without applying changes.'
      })
    )
    expect(records[0].timeline.map((entry) => entry.stage)).toEqual([
      'context_pack_built',
      'proposal_generated',
      'approval_recorded',
      'execution_applied',
      'approval_recorded'
    ])
    expect(records[0].timeline.at(-1)).toEqual(
      expect.objectContaining({
        approvalStatus: 'rejected'
      })
    )
    expect(records[1].sessionId).toBe('session-2')
  })

  it('hydrates a reusable review session from a persisted trace record', () => {
    const contextPack = createContextPack()
    const proposal = createProposal(contextPack.id)
    const approval = createApproval(contextPack.id, proposal.id)
    const executionResult = createExecutionResult(contextPack.id, proposal.id, approval.id)
    const record = createDesignInspectionTraceRecord({
      sessionId: 'session-3',
      contextPack,
      proposal,
      approval,
      executionResult,
      selectedActionIds: ['action-1'],
      notes: 'Stored reviewer note'
    })

    const hydrated = hydrateDesignInspectionTraceSession(record)

    expect(hydrated).toEqual(
      expect.objectContaining({
        sessionId: 'session-3',
        targetItemIds: ['file-1'],
        notes: 'Stored reviewer note',
        selectedActionIds: ['action-1']
      })
    )
    expect(hydrated.contextPack.canvasSnapshot).toEqual({
      type: 'image',
      label: 'selection-snapshot',
      mimeType: 'image/png'
    })
    expect(hydrated.proposal.actions[0]).toMatchObject({
      type: 'update-file-content',
      targetItemIds: ['file-1']
    })
    expect(hydrated.approval.status).toBe('approved')
    expect(hydrated.executionResult).toEqual(
      expect.objectContaining({
        id: 'execution-1',
        status: 'success'
      })
    )
  })

  it('preserves an explicitly empty selected-action set for zero-change approvals', () => {
    const contextPack = createContextPack()
    const proposal = createProposal(contextPack.id)
    const approval: DesignInspectionApproval = {
      ...createApproval(contextPack.id, proposal.id),
      approvedActions: [],
      userNotes: 'Confirmed no changes are needed.'
    }
    const record = createDesignInspectionTraceRecord({
      sessionId: 'session-zero-actions',
      contextPack,
      proposal,
      approval,
      executionResult: null,
      selectedActionIds: [],
      notes: 'Keep as-is.'
    })

    expect(record.selectedActionIds).toEqual([])

    const restored = restoreDesignInspectionTraceRecord(record)
    const hydrated = hydrateDesignInspectionTraceSession(record)

    expect(restored.selectedActionIds).toEqual([])
    expect(hydrated.selectedActionIds).toEqual([])
    expect(hydrated.approval.approvedActions).toEqual([])
  })

  it('reconstructs a lifecycle timeline for legacy records that predate the timeline field', () => {
    const contextPack = createContextPack()
    const proposal = createProposal(contextPack.id)
    const approval = createApproval(contextPack.id, proposal.id)
    const executionResult = createExecutionResult(contextPack.id, proposal.id, approval.id)
    const record = createDesignInspectionTraceRecord({
      sessionId: 'session-legacy',
      contextPack,
      proposal,
      approval,
      executionResult
    })

    const legacyRecord = { ...record } as Record<string, unknown>
    delete legacyRecord.timeline

    localStorage.setItem(
      'canvas.designInspectionTrace.canvas-legacy',
      JSON.stringify([legacyRecord])
    )

    const restored = listDesignInspectionTraceRecords('canvas-legacy')

    expect(restored).toHaveLength(1)
    expect(restored[0].timeline.map((entry) => entry.stage)).toEqual([
      'context_pack_built',
      'proposal_generated',
      'approval_recorded',
      'execution_applied'
    ])
  })

  it('removes a persisted trace record by session id', () => {
    const contextPack = createContextPack()
    const proposal = createProposal(contextPack.id)
    const approval = createApproval(contextPack.id, proposal.id)

    const first = createDesignInspectionTraceRecord({
      sessionId: 'session-delete-1',
      contextPack,
      proposal,
      approval,
      executionResult: null
    })
    const second = createDesignInspectionTraceRecord({
      sessionId: 'session-delete-2',
      contextPack: { ...contextPack, id: 'context-delete-2' },
      proposal: { ...proposal, id: 'proposal-delete-2', contextPackId: 'context-delete-2' },
      approval: {
        ...approval,
        id: 'approval-delete-2',
        contextPackId: 'context-delete-2',
        proposalId: 'proposal-delete-2'
      },
      executionResult: null
    })

    upsertDesignInspectionTraceRecord('canvas-delete', first)
    upsertDesignInspectionTraceRecord('canvas-delete', second)

    const remaining = removeDesignInspectionTraceRecord('canvas-delete', 'session-delete-1')

    expect(remaining).toHaveLength(1)
    expect(remaining[0].sessionId).toBe('session-delete-2')
    expect(listDesignInspectionTraceRecords('canvas-delete')).toHaveLength(1)

    const emptied = removeDesignInspectionTraceRecord('canvas-delete', 'session-delete-2')

    expect(emptied).toEqual([])
    expect(listDesignInspectionTraceRecords('canvas-delete')).toEqual([])
    expect(localStorage.getItem('canvas.designInspectionTrace.canvas-delete')).toBeNull()
  })
})
