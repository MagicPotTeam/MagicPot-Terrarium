import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ProjectCanvasPageDialogs from './ProjectCanvasPageDialogs'

const { mockLanguage } = vi.hoisted(() => ({
  mockLanguage: { current: 'zh-CN' }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      language: mockLanguage.current,
      resolvedLanguage: mockLanguage.current
    }
  })
}))

vi.mock('./components/Model3DViewerDialog', () => ({ default: () => null }))
vi.mock('./Dialogs/LabelEditorDialog', () => ({ LabelEditorDialog: () => null }))
vi.mock('./Dialogs/ClearConfirmDialog', () => ({ ClearConfirmDialog: () => null }))
vi.mock('./Dialogs/TextureImportDialog', () => ({ TextureImportDialog: () => null }))
vi.mock('./Dialogs/GenerationTaskPackDialog', () => ({ default: () => null }))
vi.mock('./Dialogs/GenerationTraceHistoryDialog', () => ({ default: () => null }))
vi.mock('./Dialogs/CanvasFilePreviewDialog', () => ({ default: () => null }))

function buildProps(anchor: HTMLElement) {
  return {
    dccExportMenuAnchor: anchor,
    dccExportMenuItemId: 'model-1',
    onCloseDccExportMenu: vi.fn(),
    onSelectDccExportTarget: vi.fn(),
    agentSendMenuAnchor: anchor,
    agentSendMenuItemIds: ['item-1'],
    onCloseAgentSendMenu: vi.fn(),
    onSelectAgentTargetApp: vi.fn(),
    generationTaskPackDialogProps: {} as never,
    generationTraceHistoryDialogProps: {} as never,
    filePreviewDialogProps: {} as never,
    clearConfirmDialogProps: {} as never,
    model3DViewerDialogProps: {} as never,
    textureImportDialogProps: {} as never,
    textureInputRef: { current: null } as React.RefObject<HTMLInputElement | null>,
    onTextureFilesSelected: vi.fn(),
    labelEditorDialogProps: {} as never,
    imageContextMenu: null,
    contextMenuTarget: null,
    onCloseImageContextMenu: vi.fn(),
    onBringToFront: vi.fn(),
    onSendToBack: vi.fn(),
    onBringForward: vi.fn(),
    onSendBackward: vi.fn(),
    onOpenTextureImportFromContextMenu: vi.fn()
  }
}

describe('ProjectCanvasPageDialogs', () => {
  it('shows Chinese toolbar menu copy when the UI language is Chinese', () => {
    mockLanguage.current = 'zh-CN'
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)

    render(<ProjectCanvasPageDialogs {...buildProps(anchor)} />)

    expect(
      screen.getByText('\u53d1\u9001\u5230\u5f53\u524d Photoshop \u6587\u6863')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '\u5c06\u5f53\u524d\u9009\u533a\u4f5c\u4e3a\u65b0\u56fe\u5c42\u63d2\u5165\u5df2\u6253\u5f00\u7684 Photoshop \u6587\u6863'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('\u53d1\u9001\u5230 Figma')).toBeInTheDocument()
    expect(
      screen.getByText(
        '\u5c06\u5f53\u524d\u9009\u533a\u590d\u5236\u4e3a SVG\uff0c\u53ef\u76f4\u63a5\u7c98\u8d34\u5230 Figma'
      )
    ).toBeInTheDocument()
  })

  it('keeps English toolbar menu copy when the UI language is English', () => {
    mockLanguage.current = 'en-US'
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)

    render(<ProjectCanvasPageDialogs {...buildProps(anchor)} />)

    expect(screen.getByText('Send to Unity')).toBeInTheDocument()
    expect(
      screen.getByText('Export the selected 3D model to the Unity bridge folder')
    ).toBeInTheDocument()
    expect(screen.getByText('Send to current Photoshop document')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Insert the current selection into the active Photoshop document as a new layer'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Send to Figma')).toBeInTheDocument()
    expect(
      screen.getByText('Copy the current selection as SVG so you can paste it directly into Figma')
    ).toBeInTheDocument()
  })
})
