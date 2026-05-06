import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createGenerationTraceRecord,
  listGenerationTraceRecords,
  upsertGenerationTraceRecord
} from './generationTraceStorage'
import { upsertProjectStyleModel } from './projectStyleModelRegistry'
import type { CanvasFileItem, CanvasImageItem, CanvasItem, CanvasTextItem } from './types'
import { useCanvasGenerationWorkflow } from './useCanvasGenerationWorkflow'

type WorkflowProbeProps = {
  items: CanvasItem[]
  notifySuccess: (message: string) => unknown
  notifyWarning: (message: string) => unknown
  sendCanvasItemsToAgent: (
    targetItems: CanvasItem[],
    options?: Record<string, unknown>
  ) => Promise<void>
}

function WorkflowProbe({
  items,
  notifySuccess,
  notifyWarning,
  sendCanvasItemsToAgent
}: WorkflowProbeProps) {
  const workflow = useCanvasGenerationWorkflow({
    canvasId: 'canvas-1',
    projectName: 'MagicPot Demo',
    items,
    notifySuccess,
    notifyWarning,
    sendCanvasItemsToAgent
  })

  return (
    <div>
      <button
        type="button"
        onClick={() => void workflow.handleGenerateCanvasItems(items, 'selection-1')}
      >
        Start Generation
      </button>
      <button
        type="button"
        onClick={() => void workflow.handleGenerateCanvasItems(items, 'canvas-1.agent-2')}
      >
        Start Canvas Scope
      </button>
      <button
        type="button"
        onClick={() =>
          void workflow.handleGenerateCanvasItems(items, 'selection-1', {
            sourceSessionId: 'gen-prev',
            decision: 'refined'
          })
        }
      >
        Continue Generation
      </button>
      <button type="button" onClick={() => void workflow.handleConfirmGenerationTaskPack()}>
        Confirm Generation
      </button>
      <div data-testid="dialog-state">{workflow.generationTaskDialogOpen ? 'open' : 'closed'}</div>
      <div data-testid="task-total">{workflow.generationTaskPack?.summary.totalItems ?? 0}</div>
    </div>
  )
}

function createFileItem(): CanvasFileItem {
  return {
    id: 'file-1',
    type: 'file',
    src: 'file:///brief.docx',
    fileName: 'brief.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileKind: 'word',
    sizeBytes: 1024,
    previewText: 'Requirement brief',
    content: 'Need a cinematic character portrait for the current project.',
    editable: false,
    x: 0,
    y: 0,
    width: 320,
    height: 200,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createImageItem(): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'file:///reference.png',
    fileName: 'reference.png',
    x: 360,
    y: 0,
    width: 320,
    height: 320,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false
  }
}

function createTextItem(text = 'A neon fox courier in rainy cyberpunk Shanghai'): CanvasTextItem {
  return {
    id: 'text-1',
    type: 'text',
    text,
    fontSize: 28,
    fontFamily: 'system-ui',
    fill: '#ffffff',
    x: 40,
    y: 40,
    width: 420,
    height: 120,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 3,
    locked: false
  }
}

describe('useCanvasGenerationWorkflow', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('always sends the task pack to the default agent even if a project model exists', async () => {
    const notifySuccess = vi.fn()
    const notifyWarning = vi.fn()
    const sendCanvasItemsToAgent = vi.fn().mockResolvedValue(undefined)
    const items = [createFileItem(), createImageItem()]

    upsertProjectStyleModel('canvas-1', {
      label: 'Hero Model',
      qAppKey: 'qapp-hero',
      qAppName: 'Hero QuickApp'
    })

    render(
      <WorkflowProbe
        items={items}
        notifySuccess={notifySuccess}
        notifyWarning={notifyWarning}
        sendCanvasItemsToAgent={sendCanvasItemsToAgent}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start Generation' }))
    })

    await waitFor(() => {
      expect(screen.getByTestId('dialog-state')).toHaveTextContent('open')
      expect(screen.getByTestId('task-total')).toHaveTextContent('2')
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Generation' }))
    })

    await waitFor(() => {
      expect(sendCanvasItemsToAgent).toHaveBeenCalledTimes(1)
    })

    expect(notifyWarning).not.toHaveBeenCalled()
    expect(notifySuccess).toHaveBeenCalledWith('已发送给默认 Agent 生成候选图')
    expect(sendCanvasItemsToAgent).toHaveBeenCalledWith(
      items,
      expect.objectContaining({
        targetScope: 'selection-1',
        includeCanvasPromptText: false,
        includeGroupCompletionPrompt: false,
        promptPrefix: expect.stringContaining('brief.docx')
      })
    )

    const records = listGenerationTraceRecords('canvas-1')
    expect(records).toHaveLength(1)
    expect(records[0]?.routeChoice).toEqual({ type: 'default-agent' })
  })

  it('links a follow-up generation back to the previous trace session', async () => {
    const notifySuccess = vi.fn()
    const notifyWarning = vi.fn()
    const sendCanvasItemsToAgent = vi.fn().mockResolvedValue(undefined)
    const items = [createFileItem(), createImageItem()]

    const previousRecord = createGenerationTraceRecord({
      sessionId: 'gen-prev',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1', 'image-1'],
      routeChoice: { type: 'default-agent' },
      taskPack: {
        projectId: 'canvas-1',
        projectName: 'MagicPot Demo',
        selectedItemIds: ['file-1', 'image-1'],
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
            contentText: 'Need a cinematic character portrait for the current project.'
          }
        ],
        referenceDocs: [],
        referenceImages: [{ id: 'image-1', title: 'reference.png' }],
        styleReferenceImages: [],
        taskNotes: [],
        existingAssets: []
      }
    })
    upsertGenerationTraceRecord('canvas-1', previousRecord)

    render(
      <WorkflowProbe
        items={items}
        notifySuccess={notifySuccess}
        notifyWarning={notifyWarning}
        sendCanvasItemsToAgent={sendCanvasItemsToAgent}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue Generation' }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Generation' }))
    })

    await waitFor(() => {
      const records = listGenerationTraceRecords('canvas-1')
      expect(records).toHaveLength(2)
    })

    const records = listGenerationTraceRecords('canvas-1')
    const latestRecord = records[0]
    const previousUpdatedRecord = records.find((record) => record.sessionId === 'gen-prev')

    expect(latestRecord?.sessionId).not.toBe('gen-prev')
    expect(previousUpdatedRecord?.userDecision).toBe('refined')
    expect(previousUpdatedRecord?.followUpSessionId).toBe(latestRecord?.sessionId)
  })

  it('treats all selected canvas elements as hidden reference material when starting generation', async () => {
    const notifySuccess = vi.fn()
    const notifyWarning = vi.fn()
    const sendCanvasItemsToAgent = vi.fn().mockResolvedValue(undefined)
    const items = [createTextItem(), createImageItem()]

    render(
      <WorkflowProbe
        items={items}
        notifySuccess={notifySuccess}
        notifyWarning={notifyWarning}
        sendCanvasItemsToAgent={sendCanvasItemsToAgent}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start Generation' }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Generation' }))
    })

    await waitFor(() => {
      expect(sendCanvasItemsToAgent).toHaveBeenCalledTimes(1)
    })

    expect(sendCanvasItemsToAgent).toHaveBeenCalledWith(
      items,
      expect.objectContaining({
        targetScope: 'selection-1',
        includeCanvasPromptText: false,
        includeGroupCompletionPrompt: false,
        promptPrefix: expect.stringContaining('Canvas resource reference note:')
      })
    )
    expect(sendCanvasItemsToAgent.mock.calls[0]?.[1]?.promptPrefix).toContain(
      'A neon fox courier in rainy cyberpunk Shanghai'
    )
    expect(sendCanvasItemsToAgent.mock.calls[0]?.[1]?.promptPrefix).toContain(
      'Do not automatically turn any selected element into the primary chat prompt'
    )
    expect(sendCanvasItemsToAgent.mock.calls[0]?.[1]?.promptPrefix).toContain(
      'Selected resource mix: 1 image, 1 text.'
    )
  })

  it('records the canonical canvas agent session key when the target scope matches a pane', async () => {
    const notifySuccess = vi.fn()
    const notifyWarning = vi.fn()
    const sendCanvasItemsToAgent = vi.fn().mockResolvedValue(undefined)
    const items = [createFileItem(), createImageItem()]

    render(
      <WorkflowProbe
        items={items}
        notifySuccess={notifySuccess}
        notifyWarning={notifyWarning}
        sendCanvasItemsToAgent={sendCanvasItemsToAgent}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start Canvas Scope' }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Generation' }))
    })

    await waitFor(() => {
      expect(sendCanvasItemsToAgent).toHaveBeenCalledTimes(1)
    })

    const records = listGenerationTraceRecords('canvas-1')
    expect(records[0]?.agentScope).toBe('canvas-1.agent-2')
    expect(records[0]?.agentSessionKey).toBe('canvas:thread:canvas-1:thread:agent-2')
  })
})
