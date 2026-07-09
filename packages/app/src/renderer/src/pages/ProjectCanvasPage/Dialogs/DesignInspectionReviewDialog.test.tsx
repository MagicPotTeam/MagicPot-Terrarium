import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import { theme } from '@renderer/theme'
import type {
  DesignInspectionApproval,
  DesignInspectionContextPack,
  DesignInspectionExecutionResult,
  DesignInspectionProposal
} from '@shared/designInspection'
import type { DesignInspectionTraceRecord } from '../designInspectionTraceStorage'
import DesignInspectionReviewDialog from './DesignInspectionReviewDialog'

const contextPack: DesignInspectionContextPack = {
  id: 'context-1',
  createdAt: '2026-03-27T00:00:00.000Z',
  task: 'Inspect the selected cards.',
  projectId: 'canvas-1',
  projectName: 'MagicPot Demo',
  structureFirst: true,
  selection: {
    itemIds: ['card-1', 'card-2'],
    groupIds: [],
    bounds: { x: 40, y: 40, width: 220, height: 184 }
  },
  selectionItems: [
    {
      id: 'card-1',
      type: 'text',
      x: 40,
      y: 40,
      width: 180,
      height: 48,
      zIndex: 0,
      locked: false,
      bounds: { x: 40, y: 40, width: 180, height: 48 },
      textContent: 'Hero Title',
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
      id: 'card-2',
      type: 'file',
      x: 40,
      y: 112,
      width: 220,
      height: 112,
      zIndex: 1,
      locked: false,
      bounds: { x: 40, y: 112, width: 220, height: 112 },
      fileName: 'marketing-brief.md',
      mimeType: 'text/markdown',
      previewText: 'Approved brief copy',
      textContent: 'Approved brief copy',
      provenance: {
        kind: 'imported-file',
        sourceFileName: 'marketing-brief.md'
      }
    }
  ],
  canvasSnapshot: null,
  documents: [],
  references: [],
  rules: [],
  fallbackSignals: []
}

const proposal: DesignInspectionProposal = {
  id: 'proposal-1',
  contextPackId: 'context-1',
  generatedAt: '2026-03-27T00:00:01.000Z',
  summary: 'Found two actions to review.',
  issues: [],
  actions: [
    {
      id: 'action-1',
      type: 'normalize-text-style',
      title: 'Normalize title style',
      description: 'Bring the title back to the dominant style.',
      executor: 'magicpot-internal',
      targetItemIds: ['card-1'],
      payload: {
        fontSize: 24,
        fontFamily: 'Inter',
        fontWeight: 'bold',
        fill: '#111111'
      },
      expectedImpact: 'Typography becomes consistent.'
    },
    {
      id: 'action-2',
      type: 'align-left',
      title: 'Align the card stack',
      description: 'Move the second card onto the shared left edge.',
      executor: 'magicpot-internal',
      targetItemIds: ['card-2'],
      payload: { x: 40 },
      expectedImpact: 'The stack reads as one column.'
    }
  ],
  rationale: 'Use structure-first geometry and typography.',
  expectedResult: 'The selection should look cleaner after approval.',
  executionPlan: [
    {
      step: 1,
      executor: 'magicpot-internal',
      actionIds: ['action-1'],
      description: 'Normalize title style.'
    },
    {
      step: 2,
      executor: 'magicpot-internal',
      actionIds: ['action-2'],
      description: 'Align the card stack.'
    }
  ]
}

const approval: DesignInspectionApproval = {
  id: 'approval-1',
  contextPackId: 'context-1',
  proposalId: 'proposal-1',
  status: 'pending',
  approvedActions: [],
  userNotes: '',
  createdAt: '2026-03-27T00:00:02.000Z',
  updatedAt: '2026-03-27T00:00:02.000Z'
}

const executionResult: DesignInspectionExecutionResult = {
  id: 'execution-1',
  contextPackId: 'context-1',
  proposalId: 'proposal-1',
  approvalId: 'approval-1',
  status: 'success',
  executor: 'magicpot-internal',
  appliedChanges: [],
  artifacts: [],
  trace: []
}

const recentTrace: DesignInspectionTraceRecord = {
  sessionId: 'session-1',
  createdAt: '2026-03-27T00:00:02.000Z',
  updatedAt: '2026-03-27T00:03:00.000Z',
  task: 'Inspect the selected cards.',
  selectionItemIds: ['card-1', 'card-2'],
  selectedActionIds: ['action-2'],
  issueCount: 1,
  actionCount: 2,
  approvedActionCount: 1,
  approvalStatus: 'approved',
  executionStatus: 'success',
  executor: 'magicpot-internal',
  summary: 'Applied one approved correction.',
  proposalId: 'proposal-1',
  contextPackId: 'context-1',
  approvalId: 'approval-1',
  executionResultId: 'execution-1',
  notes: 'Keep only the alignment change.',
  contextSnapshot: {
    id: contextPack.id,
    createdAt: contextPack.createdAt,
    task: contextPack.task,
    projectId: contextPack.projectId,
    projectName: contextPack.projectName,
    structureFirst: contextPack.structureFirst,
    selection: contextPack.selection,
    selectionItems: contextPack.selectionItems,
    canvasSnapshot: null,
    documents: contextPack.documents,
    references: contextPack.references,
    rules: contextPack.rules,
    fallbackSignals: contextPack.fallbackSignals
  },
  proposalSnapshot: {
    id: proposal.id,
    contextPackId: proposal.contextPackId,
    generatedAt: proposal.generatedAt,
    summary: proposal.summary,
    issues: proposal.issues,
    actions: proposal.actions,
    rationale: proposal.rationale,
    expectedResult: proposal.expectedResult,
    executionPlan: proposal.executionPlan
  },
  approvalSnapshot: {
    ...approval,
    status: 'approved',
    approvedActions: ['action-2']
  },
  executionResultSnapshot: executionResult,
  timeline: [
    {
      at: '2026-03-27T00:00:00.000Z',
      stage: 'context_pack_built',
      message: 'Captured context for 2 selected item(s).',
      contextPackId: 'context-1'
    },
    {
      at: '2026-03-27T00:00:01.000Z',
      stage: 'proposal_generated',
      message: 'Generated proposal with 0 issue(s) and 2 action(s).',
      contextPackId: 'context-1',
      proposalId: 'proposal-1'
    },
    {
      at: '2026-03-27T00:00:02.000Z',
      stage: 'approval_recorded',
      message: 'Approval status updated to approved for 1 action(s).',
      contextPackId: 'context-1',
      proposalId: 'proposal-1',
      approvalId: 'approval-1',
      approvalStatus: 'approved'
    },
    {
      at: '2026-03-27T00:03:00.000Z',
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

describe('DesignInspectionReviewDialog', () => {
  it('lets the reviewer deselect individual actions before approval', () => {
    const onSelectedActionIdsChange = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <DesignInspectionReviewDialog
          open
          loading={false}
          applying={false}
          error={null}
          contextPack={contextPack}
          proposal={proposal}
          approval={approval}
          executionResult={null}
          notes=""
          selectedActionIds={['action-1', 'action-2']}
          recentTraces={[]}
          activeSessionId={null}
          onNotesChange={vi.fn()}
          onSelectedActionIdsChange={onSelectedActionIdsChange}
          onLoadTrace={vi.fn()}
          onClose={vi.fn()}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          onRetry={vi.fn()}
        />
      </ThemeProvider>
    )

    expect(screen.getByText('\u5f85\u5ba1\u6279\u52a8\u4f5c\uff1a2 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('\u9009\u62e9\u52a8\u4f5c Align the card stack'))

    expect(onSelectedActionIdsChange).toHaveBeenCalledWith(['action-1'])
  }, 15000)

  it('switches the approval button copy when no actions are selected', () => {
    render(
      <ThemeProvider theme={theme}>
        <DesignInspectionReviewDialog
          open
          loading={false}
          applying={false}
          error={null}
          contextPack={contextPack}
          proposal={proposal}
          approval={approval}
          executionResult={null}
          notes=""
          selectedActionIds={[]}
          recentTraces={[]}
          activeSessionId={null}
          onNotesChange={vi.fn()}
          onSelectedActionIdsChange={vi.fn()}
          onLoadTrace={vi.fn()}
          onClose={vi.fn()}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          onRetry={vi.fn()}
        />
      </ThemeProvider>
    )

    expect(
      screen.getByRole('button', { name: '\u786e\u8ba4\u65e0\u9700\u53d8\u66f4' })
    ).toBeInTheDocument()
  })

  it('shows recent traces and lets the reviewer load one', () => {
    const onLoadTrace = vi.fn()

    render(
      <ThemeProvider theme={theme}>
        <DesignInspectionReviewDialog
          open
          loading={false}
          applying={false}
          error={null}
          contextPack={contextPack}
          proposal={proposal}
          approval={approval}
          executionResult={null}
          notes=""
          selectedActionIds={['action-1', 'action-2']}
          recentTraces={[recentTrace]}
          activeSessionId={null}
          onNotesChange={vi.fn()}
          onSelectedActionIdsChange={vi.fn()}
          onLoadTrace={onLoadTrace}
          onClose={vi.fn()}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          onRetry={vi.fn()}
        />
      </ThemeProvider>
    )

    expect(screen.getByText('\u6700\u8fd1\u4f1a\u8bdd')).toBeInTheDocument()
    expect(screen.getByText('Applied one approved correction.')).toBeInTheDocument()
    expect(
      screen.getByText('轨迹：上下文 -> 方案 -> 审批:已批准 -> 执行:已完成')
    ).toBeInTheDocument()
    expect(screen.getByText('最新：Execution completed.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '\u52a0\u8f7d' }))

    expect(onLoadTrace).toHaveBeenCalledWith(recentTrace)
  })

  it('shows provenance context for the current selection', () => {
    render(
      <ThemeProvider theme={theme}>
        <DesignInspectionReviewDialog
          open
          loading={false}
          applying={false}
          error={null}
          contextPack={contextPack}
          proposal={proposal}
          approval={approval}
          executionResult={null}
          notes=""
          selectedActionIds={['action-1', 'action-2']}
          recentTraces={[]}
          activeSessionId={null}
          onNotesChange={vi.fn()}
          onSelectedActionIdsChange={vi.fn()}
          onLoadTrace={vi.fn()}
          onClose={vi.fn()}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          onRetry={vi.fn()}
        />
      </ThemeProvider>
    )

    expect(screen.getByText('来源上下文')).toBeInTheDocument()
    expect(screen.getByText('Figma 1')).toBeInTheDocument()
    expect(screen.getByText('Imported file 1')).toBeInTheDocument()
    expect(
      screen.getByText(
        (content) =>
          content.includes('Hero Title') &&
          content.includes('Figma') &&
          content.includes('Headline')
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        (content) =>
          content.includes('marketing-brief.md') && content.split('marketing-brief.md').length > 2
      )
    ).toBeInTheDocument()
  })

  it('locks approval controls after execution has already completed', () => {
    render(
      <ThemeProvider theme={theme}>
        <DesignInspectionReviewDialog
          open
          loading={false}
          applying={false}
          error={null}
          contextPack={contextPack}
          proposal={proposal}
          approval={{ ...approval, status: 'approved', approvedActions: ['action-1'] }}
          executionResult={executionResult}
          notes=""
          selectedActionIds={['action-1']}
          recentTraces={[recentTrace]}
          activeSessionId="session-1"
          onNotesChange={vi.fn()}
          onSelectedActionIdsChange={vi.fn()}
          onLoadTrace={vi.fn()}
          onClose={vi.fn()}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          onRetry={vi.fn()}
        />
      </ThemeProvider>
    )

    expect(screen.getByRole('button', { name: '\u5df2\u6267\u884c' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '\u62d2\u7edd' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '\u5df2\u52a0\u8f7d' })).toBeDisabled()
  })
})
