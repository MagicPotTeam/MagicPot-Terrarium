import React from 'react'
import { ListItemText, Menu, MenuItem } from '@mui/material'
import { useTranslation } from 'react-i18next'
import Model3DViewerDialog from './components/Model3DViewerDialog'
import { LabelEditorDialog } from './Dialogs/LabelEditorDialog'
import { ClearConfirmDialog } from './Dialogs/ClearConfirmDialog'
import { TextureImportDialog } from './Dialogs/TextureImportDialog'
import GenerationTaskPackDialog from './Dialogs/GenerationTaskPackDialog'
import GenerationTraceHistoryDialog from './Dialogs/GenerationTraceHistoryDialog'
import CanvasFilePreviewDialog from './Dialogs/CanvasFilePreviewDialog'
import type { AgentTargetApp } from './projectCanvasPageShared'
import type { CanvasItem } from './types'

type MouseMenuPosition = {
  mouseX: number
  mouseY: number
}

type ProjectCanvasPageDialogsProps = {
  dccExportMenuAnchor: HTMLElement | null
  dccExportMenuItemId: string | null
  onCloseDccExportMenu: () => void
  onSelectDccExportTarget: (target: 'unity' | 'unreal') => void
  agentSendMenuAnchor: HTMLElement | null
  agentSendMenuItemIds: string[]
  onCloseAgentSendMenu: () => void
  onSelectAgentTargetApp: (targetApp: AgentTargetApp) => void
  generationTaskPackDialogProps: React.ComponentProps<typeof GenerationTaskPackDialog>
  generationTraceHistoryDialogProps: React.ComponentProps<typeof GenerationTraceHistoryDialog>
  filePreviewDialogProps: React.ComponentProps<typeof CanvasFilePreviewDialog>
  clearConfirmDialogProps: React.ComponentProps<typeof ClearConfirmDialog>
  model3DViewerDialogProps: React.ComponentProps<typeof Model3DViewerDialog>
  textureImportDialogProps: React.ComponentProps<typeof TextureImportDialog>
  textureInputRef: React.RefObject<HTMLInputElement | null>
  onTextureFilesSelected: React.ChangeEventHandler<HTMLInputElement>
  labelEditorDialogProps: React.ComponentProps<typeof LabelEditorDialog>
  imageContextMenu: MouseMenuPosition | null
  contextMenuTarget: CanvasItem | null
  onCloseImageContextMenu: () => void
  onBringToFront: () => void
  onSendToBack: () => void
  onBringForward: () => void
  onSendBackward: () => void
  onOpenTextureImportFromContextMenu: (itemId: string) => void
}

export default function ProjectCanvasPageDialogs({
  dccExportMenuAnchor,
  dccExportMenuItemId,
  onCloseDccExportMenu,
  onSelectDccExportTarget,
  agentSendMenuAnchor,
  agentSendMenuItemIds,
  onCloseAgentSendMenu,
  onSelectAgentTargetApp,
  generationTaskPackDialogProps,
  generationTraceHistoryDialogProps,
  filePreviewDialogProps,
  clearConfirmDialogProps,
  model3DViewerDialogProps,
  textureImportDialogProps,
  textureInputRef,
  onTextureFilesSelected,
  labelEditorDialogProps,
  imageContextMenu,
  contextMenuTarget,
  onCloseImageContextMenu,
  onBringToFront,
  onSendToBack,
  onBringForward,
  onSendBackward,
  onOpenTextureImportFromContextMenu
}: ProjectCanvasPageDialogsProps) {
  const { i18n } = useTranslation()
  const locale = (i18n.resolvedLanguage || i18n.language || '').toLowerCase()
  const isChineseUi = locale.startsWith('zh')

  const dccMenuCopy = {
    unity: {
      primary: isChineseUi ? '\u53d1\u9001\u5230 Unity' : 'Send to Unity',
      secondary: isChineseUi
        ? '\u5bfc\u51fa\u9009\u4e2d\u7684 3D \u6a21\u578b\u5230\u5df2\u914d\u7f6e\u7684 Unity \u6865\u63a5\u76ee\u5f55'
        : 'Export the selected 3D model to the Unity bridge folder'
    },
    unreal: {
      primary: isChineseUi ? '\u53d1\u9001\u5230 Unreal' : 'Send to Unreal',
      secondary: isChineseUi
        ? '\u5bfc\u51fa\u9009\u4e2d\u7684 3D \u6a21\u578b\u5230\u5df2\u914d\u7f6e\u7684 Unreal \u6865\u63a5\u76ee\u5f55'
        : 'Export the selected 3D model to the Unreal bridge folder'
    }
  }

  const agentMenuCopy = {
    photoshop: {
      primary: isChineseUi
        ? '\u53d1\u9001\u5230\u5f53\u524d Photoshop \u6587\u6863'
        : 'Send to current Photoshop document',
      secondary: isChineseUi
        ? '\u5c06\u5f53\u524d\u9009\u533a\u4f5c\u4e3a\u65b0\u56fe\u5c42\u63d2\u5165\u5df2\u6253\u5f00\u7684 Photoshop \u6587\u6863'
        : 'Insert the current selection into the active Photoshop document as a new layer'
    },
    figma: {
      primary: isChineseUi ? '\u53d1\u9001\u5230 Figma' : 'Send to Figma',
      secondary: isChineseUi
        ? '\u5c06\u5f53\u524d\u9009\u533a\u590d\u5236\u4e3a SVG\uff0c\u53ef\u76f4\u63a5\u7c98\u8d34\u5230 Figma'
        : 'Copy the current selection as SVG so you can paste it directly into Figma'
    },
    'after-effects': {
      primary: isChineseUi ? '\u53d1\u9001\u5230 After Effects' : 'Send to After Effects',
      secondary: isChineseUi
        ? '\u5728\u9762\u5411 After Effects \u7684 Agent \u6d41\u7a0b\u91cc\u7ee7\u7eed\u5904\u7406\u5f53\u524d\u753b\u677f\u9009\u533a'
        : 'Continue this canvas selection in an After Effects-oriented Agent flow'
    },
    premiere: {
      primary: isChineseUi ? '\u53d1\u9001\u5230 Premiere Pro' : 'Send to Premiere Pro',
      secondary: isChineseUi
        ? '\u5728\u9762\u5411 Premiere Pro \u7684 Agent \u6d41\u7a0b\u91cc\u7ee7\u7eed\u5904\u7406\u5f53\u524d\u753b\u677f\u9009\u533a'
        : 'Continue this canvas selection in a Premiere Pro-oriented Agent flow'
    }
  } as const

  return (
    <>
      <Menu
        anchorEl={dccExportMenuAnchor}
        open={Boolean(dccExportMenuAnchor) && Boolean(dccExportMenuItemId)}
        onClose={onCloseDccExportMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <MenuItem onClick={() => onSelectDccExportTarget('unity')}>
          <ListItemText {...dccMenuCopy.unity} />
        </MenuItem>
        <MenuItem onClick={() => onSelectDccExportTarget('unreal')}>
          <ListItemText {...dccMenuCopy.unreal} />
        </MenuItem>
      </Menu>

      <Menu
        anchorEl={agentSendMenuAnchor}
        open={Boolean(agentSendMenuAnchor) && agentSendMenuItemIds.length > 0}
        onClose={onCloseAgentSendMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <MenuItem onClick={() => onSelectAgentTargetApp('photoshop')}>
          <ListItemText {...agentMenuCopy.photoshop} />
        </MenuItem>
        <MenuItem onClick={() => onSelectAgentTargetApp('figma')}>
          <ListItemText {...agentMenuCopy.figma} />
        </MenuItem>
        <MenuItem onClick={() => onSelectAgentTargetApp('after-effects')}>
          <ListItemText {...agentMenuCopy['after-effects']} />
        </MenuItem>
        <MenuItem onClick={() => onSelectAgentTargetApp('premiere')}>
          <ListItemText {...agentMenuCopy.premiere} />
        </MenuItem>
      </Menu>

      <GenerationTaskPackDialog {...generationTaskPackDialogProps} />
      <GenerationTraceHistoryDialog {...generationTraceHistoryDialogProps} />
      <CanvasFilePreviewDialog {...filePreviewDialogProps} />
      <ClearConfirmDialog {...clearConfirmDialogProps} />
      <Model3DViewerDialog {...model3DViewerDialogProps} />
      <TextureImportDialog {...textureImportDialogProps} />
      <input
        ref={textureInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is a valid HTML attribute
        webkitdirectory=""
        // eslint-disable-next-line react/no-unknown-property
        directory=""
        multiple
        style={{ display: 'none' }}
        onChange={onTextureFilesSelected}
      />
      <LabelEditorDialog {...labelEditorDialogProps} />

      <Menu
        open={Boolean(imageContextMenu)}
        onClose={onCloseImageContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          imageContextMenu
            ? { top: imageContextMenu.mouseY, left: imageContextMenu.mouseX }
            : undefined
        }
        slotProps={{ paper: { sx: { borderRadius: 2, minWidth: 140 } } }}
      >
        <MenuItem onClick={onBringToFront}>
          <ListItemText>{'\u79fb\u5230\u6700\u4e0a'}</ListItemText>
        </MenuItem>
        <MenuItem onClick={onSendToBack}>
          <ListItemText>{'\u79fb\u5230\u6700\u4e0b'}</ListItemText>
        </MenuItem>
        <MenuItem onClick={onBringForward}>
          <ListItemText>{'\u4e0a\u79fb\u4e00\u5c42'}</ListItemText>
        </MenuItem>
        <MenuItem onClick={onSendBackward}>
          <ListItemText>{'\u4e0b\u79fb\u4e00\u5c42'}</ListItemText>
        </MenuItem>
        {contextMenuTarget?.type === 'model3d' && (
          <MenuItem
            onClick={() => {
              onOpenTextureImportFromContextMenu(contextMenuTarget.id)
            }}
          >
            <ListItemText>{'\u52a0\u8f7d\u7eb9\u7406\u6587\u4ef6'}</ListItemText>
          </MenuItem>
        )}
      </Menu>
    </>
  )
}
