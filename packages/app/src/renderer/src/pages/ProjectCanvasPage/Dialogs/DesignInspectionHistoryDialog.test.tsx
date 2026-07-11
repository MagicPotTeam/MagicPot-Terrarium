import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DesignInspectionTraceRecord } from '../designInspectionTraceStorage'
import { DesignInspectionHistoryDialog } from './DesignInspectionHistoryDialog'

const traceRecord: DesignInspectionTraceRecord = {
  sessionId: 'session-1',
  createdAt: '2026-03-27T15:42:00.000Z',
  updatedAt: '2026-03-27T15:43:00.000Z',
  task: 'Inspect card spacing and alignment.',
  selectionItemIds: ['item-1', 'item-2'],
  selectedActionIds: ['action-1'],
  issueCount: 2,
  actionCount: 1,
  approvedActionCount: 1,
  approvalStatus: 'approved',
  executionStatus: 'success',
  executor: 'magicpot-internal',
  summary: 'Execution success with 1 applied change(s).',
  proposalId: 'proposal-1',
  contextPackId: 'context-1',
  approvalId: 'approval-1',
  executionResultId: 'execution-1',
  notes: 'Keep the approved alignment fix.',
  contextSnapshot: {
    id: 'context-1',
    createdAt: '2026-03-27T15:40:00.000Z',
    task: 'Inspect card spacing and alignment.',
    projectId: 'canvas-1',
    projectName: 'MagicPot Demo',
    structureFirst: true,
    selection: {
      itemIds: ['item-1', 'item-2'],
      groupIds: [],
      bounds: { x: 0, y: 0, width: 320, height: 180 }
    },
    selectionItems: [
      {
        id: 'item-1',
        type: 'text',
        x: 0,
        y: 0,
        width: 140,
        height: 48,
        zIndex: 0,
        locked: false,
        bounds: { x: 0, y: 0, width: 140, height: 48 },
        textContent: 'Headline',
        fontSize: 24,
        fontFamily: 'Inter',
        fontWeight: 'bold',
        fill: '#111111',
        provenance: {
          kind: 'figma',
          sourceDocumentId: 'figma-file-1',
          sourceNodeName: 'Headline'
        }
      },
      {
        id: 'item-2',
        type: 'file',
        x: 0,
        y: 64,
        width: 220,
        height: 116,
        zIndex: 1,
        locked: false,
        bounds: { x: 0, y: 64, width: 220, height: 116 },
        fileName: 'brief.md',
        mimeType: 'text/markdown',
        previewText: 'Approved brief',
        textContent: 'Approved brief',
        provenance: {
          kind: 'imported-file',
          sourceFileName: 'brief.md'
        }
      }
    ],
    canvasSnapshot: null,
    documents: [],
    references: [],
    rules: [],
    fallbackSignals: []
  },
  proposalSnapshot: {
    id: 'proposal-1',
    contextPackId: 'context-1',
    generatedAt: '2026-03-27T15:41:00.000Z',
    summary: 'Execution success with 1 applied change(s).',
    issues: [],
    actions: [],
    rationale: 'Use geometry-first validation.',
    expectedResult: 'Cards align cleanly.',
    executionPlan: []
  },
  approvalSnapshot: {
    id: 'approval-1',
    contextPackId: 'context-1',
    proposalId: 'proposal-1',
    status: 'approved',
    approvedActions: ['action-1'],
    userNotes: 'Keep the approved alignment fix.',
    createdAt: '2026-03-27T15:42:00.000Z',
    updatedAt: '2026-03-27T15:43:00.000Z'
  },
  executionResultSnapshot: {
    id: 'execution-1',
    contextPackId: 'context-1',
    proposalId: 'proposal-1',
    approvalId: 'approval-1',
    status: 'success',
    executor: 'magicpot-internal',
    appliedChanges: [],
    artifacts: [],
    trace: []
  },
  timeline: [
    {
      at: '2026-03-27T15:40:00.000Z',
      stage: 'context_pack_built',
      message: 'Captured context for 2 selected item(s).',
      contextPackId: 'context-1'
    },
    {
      at: '2026-03-27T15:41:00.000Z',
      stage: 'proposal_generated',
      message: 'Generated proposal with 0 issue(s) and 0 action(s).',
      contextPackId: 'context-1',
      proposalId: 'proposal-1'
    },
    {
      at: '2026-03-27T15:43:00.000Z',
      stage: 'approval_recorded',
      message: 'Approval status updated to approved for 1 action(s).',
      contextPackId: 'context-1',
      proposalId: 'proposal-1',
      approvalId: 'approval-1',
      approvalStatus: 'approved'
    },
    {
      at: '2026-03-27T15:43:30.000Z',
      stage: 'execution_applied',
      message: 'Execution completed.',
      contextPackId: 'context-1',
      proposalId: 'proposal-1',
      approvalId: 'approval-1',
      executionResultId: 'execution-1',
      executionStatus: 'success'
    }
  ]
}

describe('DesignInspectionHistoryDialog', () => {
  it('renders an empty state when there is no persisted history yet', () => {
    render(
      <DesignInspectionHistoryDialog
        open
        traces={[]}
        activeSessionId={null}
        onLoadTrace={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('\u68c0\u67e5\u8bb0\u5f55')).toBeInTheDocument()
    expect(
      screen.getByText(
        '\u6682\u65f6\u8fd8\u6ca1\u6709\u8bb0\u5f55\u4efb\u4f55\u68c0\u67e5\u4f1a\u8bdd\u3002'
      )
    ).toBeInTheDocument()
  })

  it('shows trace details and disables loading the active session', () => {
    render(
      <DesignInspectionHistoryDialog
        open
        traces={[traceRecord]}
        activeSessionId="session-1"
        onLoadTrace={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('Execution success with 1 applied change(s).')).toBeInTheDocument()
    expect(screen.getByText('Inspect card spacing and alignment.')).toBeInTheDocument()
    expect(
      screen.getByText('轨迹：上下文 -> 方案 -> 审批:已批准 -> 执行:已完成')
    ).toBeInTheDocument()
    expect(screen.getByText('最新：Execution completed.')).toBeInTheDocument()
    expect(screen.getByText('来源：Figma 1 | Imported file 1')).toBeInTheDocument()
    expect(
      screen.getByText(
        (content) =>
          content.includes('Headline') &&
          content.includes('Figma') &&
          content.includes('brief.md') &&
          content.includes('Imported file')
      )
    ).toBeInTheDocument()
    expect(screen.getByText('\u5ba1\u6279\uff1a\u5df2\u6279\u51c6')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '\u5f53\u524d\u4f1a\u8bdd' })).toBeDisabled()
    expect(screen.getByText('\u5f53\u524d\u4f1a\u8bdd')).toBeInTheDocument()
  })

  it('forwards trace deletion requests', () => {
    const onDeleteTrace = vi.fn()

    render(
      <DesignInspectionHistoryDialog
        open
        traces={[traceRecord]}
        activeSessionId={null}
        onLoadTrace={vi.fn()}
        onDeleteTrace={onDeleteTrace}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '\u5220\u9664' }))

    expect(onDeleteTrace).toHaveBeenCalledWith(traceRecord)
  })
})
