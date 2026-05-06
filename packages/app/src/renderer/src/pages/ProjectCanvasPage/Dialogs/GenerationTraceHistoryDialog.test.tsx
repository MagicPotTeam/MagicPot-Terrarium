import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import GenerationTraceHistoryDialog from './GenerationTraceHistoryDialog'
import type { GenerationTraceRecord } from '../generationTraceStorage'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      language: 'zh-CN',
      resolvedLanguage: 'zh-CN'
    }
  })
}))

function createTestRecord(overrides: Partial<GenerationTraceRecord> = {}): GenerationTraceRecord {
  return {
    sessionId: 'gen-session-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectId: 'canvas-1',
    projectName: 'MagicPot Demo',
    selectedItemIds: ['file-1', 'img-1'],
    routeChoice: {
      type: 'project-style-model',
      modelId: 'model-abc',
      modelLabel: '赛博风格 LoRA'
    },
    taskPackSnapshot: {
      summary: {
        totalItems: 2,
        requirementDocs: 1,
        referenceDocs: 0,
        referenceImages: 1,
        styleReferenceImages: 0,
        taskNotes: 0,
        existingAssets: 0
      },
      requirementDocTitles: ['需求文档.md'],
      referenceDocTitles: [],
      referenceImageCount: 1,
      styleReferenceImageCount: 0,
      taskNoteTitles: [],
      existingAssetTitles: []
    },
    candidates: [
      {
        id: 'candidate-1',
        fileName: 'v1.png',
        generatedAt: new Date().toISOString()
      }
    ],
    userDecision: 'approved',
    notes: '首轮通过',
    timeline: [
      {
        at: new Date().toISOString(),
        stage: 'task_pack_built',
        message: 'built task pack'
      }
    ],
    ...overrides
  }
}

describe('GenerationTraceHistoryDialog', () => {
  it('renders empty state when no records exist', () => {
    render(
      <GenerationTraceHistoryDialog
        open={true}
        records={[]}
        onContinueRecord={vi.fn()}
        onApproveRecord={vi.fn()}
        onDiscardRecord={vi.fn()}
        onDeleteRecord={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('出图记录')).toBeTruthy()
    expect(screen.getByText('当前项目还没有出图记录。')).toBeTruthy()
  })

  it('renders records with project name, route, and decision status', () => {
    const record1 = createTestRecord({ sessionId: 'gen-1', userDecision: 'approved' })
    const record2 = createTestRecord({
      sessionId: 'gen-2',
      userDecision: 'pending',
      routeChoice: { type: 'default-agent' },
      candidates: [],
      notes: undefined
    })

    render(
      <GenerationTraceHistoryDialog
        open={true}
        records={[record1, record2]}
        onContinueRecord={vi.fn()}
        onApproveRecord={vi.fn()}
        onDiscardRecord={vi.fn()}
        onDeleteRecord={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getAllByText('MagicPot Demo').length).toBe(2)
    expect(screen.getByText('已采纳')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText('默认 Agent（当前项目没有可用模型）')).toBeTruthy()
  })

  it('calls onContinueRecord when a record row is clicked', () => {
    const onContinue = vi.fn()
    const record = createTestRecord()

    render(
      <GenerationTraceHistoryDialog
        open={true}
        records={[record]}
        onContinueRecord={onContinue}
        onApproveRecord={vi.fn()}
        onDiscardRecord={vi.fn()}
        onDeleteRecord={vi.fn()}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(screen.getByText('MagicPot Demo'))
    expect(onContinue).toHaveBeenCalledWith(record)
  })

  it('calls action handlers for approve, discard, and delete buttons', () => {
    const onApprove = vi.fn()
    const onDiscard = vi.fn()
    const onDelete = vi.fn()
    const record = createTestRecord()

    render(
      <GenerationTraceHistoryDialog
        open={true}
        records={[record]}
        onContinueRecord={vi.fn()}
        onApproveRecord={onApprove}
        onDiscardRecord={onDiscard}
        onDeleteRecord={onDelete}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '采纳本轮' }))
    fireEvent.click(screen.getByRole('button', { name: '标记放弃' }))
    fireEvent.click(screen.getByLabelText(`删除出图记录 ${record.sessionId}`))

    expect(onApprove).toHaveBeenCalledWith(record)
    expect(onDiscard).toHaveBeenCalledWith(record)
    expect(onDelete).toHaveBeenCalledWith(record.sessionId)
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()

    render(
      <GenerationTraceHistoryDialog
        open={true}
        records={[]}
        onContinueRecord={vi.fn()}
        onApproveRecord={vi.fn()}
        onDiscardRecord={vi.fn()}
        onDeleteRecord={vi.fn()}
        onClose={onClose}
      />
    )

    fireEvent.click(screen.getByText('关闭'))
    expect(onClose).toHaveBeenCalled()
  })
})
