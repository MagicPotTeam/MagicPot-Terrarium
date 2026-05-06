/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useRef } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Popover,
  Tooltip,
  IconButton,
  Typography,
  Menu,
  MenuItem,
  ListItemText
} from '@mui/material'
import { Colorize as ColorizeIcon } from '@mui/icons-material'
import type { CanvasItem } from '../types'
import { getAgentSendMenuCopy } from '../adobeBridgeUx'
import Model3DViewerDialog from './Model3DViewerDialog'
import { LabelEditorDialog } from '../Dialogs/LabelEditorDialog'
import { ClearConfirmDialog } from '../Dialogs/ClearConfirmDialog'
import { TextureImportDialog } from '../Dialogs/TextureImportDialog'
import { ColorWheelSquarePicker } from './ColorWheelSquarePicker'
import { MODEL_IMPORT_EXTENSIONS } from '../types'

type CanvasTransientUiProps = any

const ANNOTATION_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#ffffff'
]

const BG_COLORS = [
  { label: 'Default Dark', value: '#1a1a1a' },
  { label: 'Dark Gray', value: '#252525' },
  { label: 'Graphite', value: '#3a3a3a' },
  { label: 'Pure Black', value: '#0d0d0d' },
  { label: 'Cream', value: '#f5f0e8' },
  { label: 'Light Gray', value: '#e8e8e8' },
  { label: 'Pure White', value: '#ffffff' },
  { label: 'Dark Blue', value: '#0f1923' },
  { label: 'Dark Green', value: '#0f1a0f' },
  { label: 'Transparent', value: 'transparent' }
]

const CanvasTransientUi: React.FC<CanvasTransientUiProps> = (props) => {
  const {
    t,
    notifyError,
    items,
    selectedIds,
    annotationColor,
    bgColor,
    transparentPattern,
    annotationStrokeWidth,
    groupNameDraft,
    groupCreateError,
    currentShortcut,
    recordedShortcut,
    setCurrentShortcut,
    shortcutDialogOpen,
    groupCreateAnchor,
    dccExportMenuAnchor,
    dccExportMenuItemId,
    agentSendMenuAnchor,
    colorPickerAnchor,
    brushWidthAnchor,
    bgColorPickerAnchor,
    clearConfirmOpen,
    textureImportDialogOpen,
    pendingTextureModelId,
    labelDialogOpen,
    labelDialogText,
    imageContextMenu,
    activeModel3DItem,
    contextMenuTarget,
    handleCloseGroupCreatePopover,
    handleCreateGroup,
    handleCloseDccExportMenu,
    handleSelectDccExportTarget,
    handleCloseAgentSendMenu,
    handleSelectAgentTargetApp,
    handleSendCanvasItemsToAgent,
    handleCloseImageContextMenu,
    handleBringToFront,
    handleSendToBack,
    handleBringForward,
    handleSendBackward,
    handleCloseModel3DViewer,
    handleDownloadBlobItem,
    handleRequestModel3DTextureImport,
    handleTextureFilesSelected,
    handleBgColorChange,
    handleClear,
    activateModel3DRender,
    getNextDefaultGroupMeta,
    setShortcutDialogOpen,
    setRecordedShortcut,
    setGroupNameDraft,
    setGroupCreateError,
    setAnnotationColor,
    setBgCustomColor,
    setInlineTextEdit,
    setItems,
    setBrushWidthAnchor,
    setAnnotationStrokeWidth,
    setClearConfirmOpen,
    setTextureImportDialogOpen,
    setPendingTextureModelId,
    setLabelDialogOpen,
    setLabelDialogText,
    labelDialogItemId,
    setBgColorPickerAnchor,
    setColorPickerAnchor: setColorPickerAnchorState,
    handleFileSelect,
    handleModelSelect,
    handleVideoSelect,
    ANNOTATION_COLORS: annotationColorsFromProps,
    BG_COLORS: bgColorsFromProps
  } = props as any

  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const textureInputRef = useRef<HTMLInputElement>(null)
  const setColorPickerAnchor = setColorPickerAnchorState
  const annotationPalette = annotationColorsFromProps || ANNOTATION_COLORS
  const bgPalette = bgColorsFromProps || BG_COLORS

  return (
    <Box>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        data-testid="project-canvas-transient-image-import-input"
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />
      {/* 模型导入（支持 3D 模型文件） */}
      <input
        ref={modelInputRef}
        type="file"
        accept={MODEL_IMPORT_EXTENSIONS.join(',')}
        multiple
        data-testid="project-canvas-transient-model-import-input"
        style={{ display: 'none' }}
        onChange={handleModelSelect}
      />
      {/* 视频导入 */}
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        multiple
        data-testid="project-canvas-transient-video-import-input"
        style={{ display: 'none' }}
        onChange={handleVideoSelect}
      />
      {/* 截图快捷键设置对话框 */}
      <Dialog
        open={shortcutDialogOpen}
        onClose={() => setShortcutDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 700, fontSize: 16 }}>
          {'\u8bbe\u7f6e\u622a\u56fe\u5feb\u6377\u952e'}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
            当前截图快捷键：<strong>{currentShortcut}</strong>
          </Typography>
          <TextField
            fullWidth
            variant="outlined"
            size="small"
            placeholder="请按下新的快捷键组合..."
            value={recordedShortcut}
            InputProps={{ readOnly: true }}
            onKeyDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const parts: string[] = []
              if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
              if (e.altKey) parts.push('Alt')
              if (e.shiftKey) parts.push('Shift')
              const key = e.key
              if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
                parts.push(key.length === 1 ? key.toUpperCase() : key)
              }
              if (parts.length > 0) {
                setRecordedShortcut(parts.join('+'))
              }
            }}
            sx={{ '& input': { textAlign: 'center', fontWeight: 700, fontSize: 16 } }}
          />
          <Typography variant="caption" sx={{ mt: 1, display: 'block', color: 'text.disabled' }}>
            支持 Ctrl / Alt / Shift 与其他按键组合，按下后会自动记录。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShortcutDialogOpen(false)}>取消</Button>
          <Button
            variant="contained"
            disabled={!recordedShortcut}
            onClick={() => {
              if (recordedShortcut) {
                // 转成 Electron accelerator 格式
                const accelerator = recordedShortcut.replace('Ctrl', 'CommandOrControl')
                try {
                  window.electron?.ipcRenderer?.invoke?.('screenshot:setShortcut', accelerator)
                  setCurrentShortcut(recordedShortcut)
                } catch (err) {
                  console.error('[Canvas] 保存截图快捷键失败', err)
                }
                setRecordedShortcut('')
                setShortcutDialogOpen(false)
              }
            }}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
      <Popover
        anchorEl={groupCreateAnchor}
        open={Boolean(groupCreateAnchor)}
        onClose={handleCloseGroupCreatePopover}
        anchorOrigin={{ vertical: 'center', horizontal: 'right' }}
        transformOrigin={{ vertical: 'center', horizontal: 'left' }}
        PaperProps={{
          sx: {
            width: 280,
            p: 1.5,
            borderRadius: 2
          }
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {t('canvas.group_create_title')}
          </Typography>
          <TextField
            size="small"
            autoFocus
            value={groupNameDraft}
            placeholder={t('canvas.group_name_hint', {
              defaultName: getNextDefaultGroupMeta().name
            })}
            error={Boolean(groupCreateError)}
            helperText={groupCreateError || undefined}
            onChange={(event) => {
              setGroupNameDraft(event.target.value)
              if (groupCreateError) setGroupCreateError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleCreateGroup(groupNameDraft)
              }
            }}
          />
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 1,
              pt: groupCreateError ? 0.5 : 0
            }}
          >
            <Button size="small" onClick={handleCloseGroupCreatePopover}>
              {t('canvas.group_create_cancel')}
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => handleCreateGroup(groupNameDraft)}
            >
              {t('canvas.group_create_confirm')}
            </Button>
          </Box>
        </Box>
      </Popover>
      <Menu
        anchorEl={dccExportMenuAnchor}
        open={Boolean(dccExportMenuAnchor) && Boolean(dccExportMenuItemId)}
        onClose={handleCloseDccExportMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <MenuItem onClick={() => handleSelectDccExportTarget('unity')}>
          <ListItemText primary="发送到 Unity" secondary="导出 3D 模型到已配置的 Unity 桥接目录" />
        </MenuItem>
        <MenuItem onClick={() => handleSelectDccExportTarget('unreal')}>
          <ListItemText
            primary="发送到 Unreal"
            secondary="导出 3D 模型到已配置的 Unreal 桥接目录"
          />
        </MenuItem>
      </Menu>
      <Menu
        anchorEl={agentSendMenuAnchor}
        open={Boolean(agentSendMenuAnchor)}
        onClose={handleCloseAgentSendMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <MenuItem onClick={() => handleSelectAgentTargetApp('photoshop')}>
          <ListItemText {...getAgentSendMenuCopy('photoshop')} />
        </MenuItem>
        <MenuItem onClick={() => handleSelectAgentTargetApp('after-effects')}>
          <ListItemText {...getAgentSendMenuCopy('after-effects')} />
        </MenuItem>
        <MenuItem onClick={() => handleSelectAgentTargetApp('premiere')}>
          <ListItemText {...getAgentSendMenuCopy('premiere')} />
        </MenuItem>
      </Menu>
      {/* 注释颜色快捷选择 */}
      <Popover
        open={Boolean(colorPickerAnchor) && selectedIds.size < 0}
        anchorEl={colorPickerAnchor}
        onClose={() => setColorPickerAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              p: 1.5,
              borderRadius: 2,
              display: 'flex',
              gap: 0.75,
              flexWrap: 'wrap',
              maxWidth: 180
            }
          }
        }}
      >
        {annotationPalette.map((color) => (
          <Box
            key={color}
            onClick={() => {
              setAnnotationColor(color)
              setColorPickerAnchor(null)
              // 同步正在编辑的文字颜色预览
              setInlineTextEdit((prev) => (prev ? { ...prev, fill: color } : null))
              // 同步已选注释和文字元素的颜色
              if (selectedIds.size > 0) {
                setItems(
                  (prev) =>
                    prev.map((item) => {
                      if (!selectedIds.has(item.id)) return item
                      if (item.type === 'annotation') return { ...item, stroke: color }
                      if (item.type === 'text') return { ...item, fill: color }
                      return item
                    }) as CanvasItem[]
                )
              }
            }}
            sx={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              bgcolor: color,
              cursor: 'pointer',
              border: annotationColor === color ? '3px solid' : '2px solid',
              borderColor: annotationColor === color ? 'primary.main' : 'divider',
              transition: 'transform 0.15s, border-color 0.15s',
              '&:hover': {
                transform: 'scale(1.15)',
                borderColor: 'primary.light'
              }
            }}
          />
        ))}
        {/* 屏幕取色器 API */}
        <Tooltip title="屏幕取色器 (EyeDropper)">
          <IconButton
            size="small"
            sx={{ width: 28, height: 28, border: '1px solid', borderColor: 'divider', mr: 1 }}
            onClick={async () => {
              if (!(window as any).EyeDropper) {
                notifyError('当前浏览器环境不支持屏幕取色 API')
                return
              }
              try {
                const eyeDropper = new (window as any).EyeDropper()
                const result = await eyeDropper.open()
                const c = result.sRGBHex
                setAnnotationColor(c)
                setBgCustomColor(c)
                setInlineTextEdit((prev) => (prev ? { ...prev, fill: c } : null))
                if (selectedIds.size > 0) {
                  setItems(
                    (prev) =>
                      prev.map((item) => {
                        if (!selectedIds.has(item.id)) return item
                        if (item.type === 'annotation') return { ...item, stroke: c }
                        if (item.type === 'text') return { ...item, fill: c }
                        return item
                      }) as CanvasItem[]
                  )
                }
              } catch (e) {
                /* user cancelled */
              }
            }}
          >
            <ColorizeIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {/* 自定义颜色 */}
        <Box
          component="label"
          title={'\u81ea\u5b9a\u4e49\u989c\u8272'}
          sx={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: '2px dashed',
            borderColor: 'divider',
            cursor: 'pointer',
            display: 'grid',
            placeItems: 'center',
            fontSize: 16,
            color: 'text.secondary',
            transition: 'transform 0.15s, border-color 0.15s',
            '&:hover': { transform: 'scale(1.15)', borderColor: 'primary.light' }
          }}
        >
          +
          <input
            type="color"
            style={{ display: 'none' }}
            value={annotationColor.startsWith('#') ? annotationColor : '#ef4444'}
            onChange={(e) => {
              const c = e.target.value
              setAnnotationColor(c)
              setInlineTextEdit((prev) => (prev ? { ...prev, fill: c } : null))
              if (selectedIds.size > 0) {
                setItems(
                  (prev) =>
                    prev.map((item) => {
                      if (!selectedIds.has(item.id)) return item
                      if (item.type === 'annotation') return { ...item, stroke: c }
                      if (item.type === 'text') return { ...item, fill: c }
                      return item
                    }) as CanvasItem[]
                )
              }
            }}
          />
        </Box>
      </Popover>
      {/* 画笔粗细快捷选择 */}
      <Popover
        open={Boolean(brushWidthAnchor)}
        anchorEl={brushWidthAnchor}
        onClose={() => setBrushWidthAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              p: 1,
              mt: 1,
              borderRadius: 2,
              bgcolor: '#2b2d31',
              display: 'flex',
              gap: 0.75
            }
          }
        }}
      >
        {[
          { size: 2, dot: 6 },
          { size: 5, dot: 12 },
          { size: 10, dot: 20 }
        ].map(({ size, dot }) => (
          <Box
            key={size}
            onClick={() => {
              setAnnotationStrokeWidth(size)
              setBrushWidthAnchor(null)
            }}
            sx={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer',
              border: '2px solid',
              borderColor: annotationStrokeWidth === size ? annotationColor : 'transparent',
              bgcolor: annotationStrokeWidth === size ? `${annotationColor}22` : 'transparent',
              transition: 'all 0.15s ease',
              '&:hover': {
                bgcolor: `${annotationColor}33`
              }
            }}
          >
            <Box
              sx={{
                width: dot,
                height: dot,
                borderRadius: '50%',
                bgcolor: annotationColor
              }}
            />
          </Box>
        ))}
      </Popover>
      {/* 背景颜色快捷选择 */}
      <Popover
        open={Boolean(bgColorPickerAnchor) && items.length < 0}
        anchorEl={bgColorPickerAnchor}
        onClose={() => setBgColorPickerAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              p: 1.5,
              borderRadius: 2,
              display: 'flex',
              gap: 0.75,
              flexWrap: 'wrap',
              maxWidth: 180
            }
          }
        }}
      >
        {bgPalette.map(({ label, value }) => (
          <Box
            key={value}
            title={label}
            onClick={() => {
              handleBgColorChange(value)
              setBgColorPickerAnchor(null)
            }}
            sx={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              cursor: 'pointer',
              border: bgColor === value ? '3px solid' : '2px solid',
              borderColor: bgColor === value ? 'primary.main' : 'divider',
              transition: 'transform 0.15s, border-color 0.15s',
              '&:hover': { transform: 'scale(1.15)', borderColor: 'primary.light' },
              ...(value === 'transparent'
                ? {
                    background: 'repeating-conic-gradient(#888 0% 25%, #555 0% 50%) 0 0 / 8px 8px'
                  }
                : { bgcolor: value })
            }}
          />
        ))}
        {/* 自定义颜色 */}
        <Box
          component="label"
          title={'\u81ea\u5b9a\u4e49\u989c\u8272'}
          sx={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: '2px dashed',
            borderColor: 'divider',
            cursor: 'pointer',
            display: 'grid',
            placeItems: 'center',
            fontSize: 16,
            color: 'text.secondary',
            transition: 'transform 0.15s, border-color 0.15s',
            '&:hover': { transform: 'scale(1.15)', borderColor: 'primary.light' }
          }}
        >
          +
          <input
            type="color"
            style={{ display: 'none' }}
            value={bgColor.startsWith('#') ? bgColor : '#1a1a1a'}
            onChange={(e) => {
              setBgCustomColor(e.target.value)
            }}
            onInput={(e) => {
              handleBgColorChange((e.target as HTMLInputElement).value)
            }}
          />
        </Box>
      </Popover>
      {/* 高级取色面板 */}
      <Popover
        open={Boolean(colorPickerAnchor)}
        anchorEl={colorPickerAnchor}
        onClose={() => setColorPickerAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              p: 1.5,
              borderRadius: 2,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1.25
            }
          }
        }}
      >
        <ColorWheelSquarePicker
          color={annotationColor}
          onChange={(color) => {
            setAnnotationColor(color)
            setInlineTextEdit((prev) => (prev ? { ...prev, fill: color } : null))
            if (selectedIds.size > 0) {
              setItems(
                (prev) =>
                  prev.map((item) => {
                    if (!selectedIds.has(item.id)) return item
                    if (item.type === 'annotation') return { ...item, stroke: color }
                    if (item.type === 'text') return { ...item, fill: color }
                    return item
                  }) as CanvasItem[]
              )
            }
          }}
        />
      </Popover>
      <Popover
        open={Boolean(bgColorPickerAnchor)}
        anchorEl={bgColorPickerAnchor}
        onClose={() => setBgColorPickerAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              p: 1.5,
              borderRadius: 2,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1.25
            }
          }
        }}
      >
        <ColorWheelSquarePicker
          color={bgColor === 'transparent' ? '#1a1a1a' : bgColor}
          onChange={(color) => {
            setBgCustomColor(color)
            handleBgColorChange(color)
          }}
        />
      </Popover>
      <ClearConfirmDialog
        open={clearConfirmOpen}
        onClose={() => setClearConfirmOpen(false)}
        onConfirm={() => {
          handleClear()
          setClearConfirmOpen(false)
        }}
      />
      <Model3DViewerDialog
        open={Boolean(activeModel3DItem)}
        item={activeModel3DItem}
        bgColor={bgColor}
        transparentPattern={transparentPattern}
        onClose={handleCloseModel3DViewer}
        onDownload={(item) => handleDownloadBlobItem(item)}
        onImportTextures={handleRequestModel3DTextureImport}
      />

      {/* 纹理导入对话框（用于 3D 模型贴图导入） */}
      <TextureImportDialog
        open={textureImportDialogOpen}
        onClose={() => {
          if (pendingTextureModelId) {
            activateModel3DRender(pendingTextureModelId)
          }
          setTextureImportDialogOpen(false)
          setPendingTextureModelId(null)
        }}
        onSkip={() => {
          if (pendingTextureModelId) {
            activateModel3DRender(pendingTextureModelId)
          }
          setTextureImportDialogOpen(false)
          setPendingTextureModelId(null)
        }}
        onImport={() => {
          // 选择整组纹理文件夹
          textureInputRef.current?.click()
        }}
      />
      <input
        ref={textureInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is a valid HTML attribute
        webkitdirectory=""
        // eslint-disable-next-line react/no-unknown-property
        directory=""
        multiple
        style={{ display: 'none' }}
        onChange={handleTextureFilesSelected}
      />
      {/* 标注文本编辑对话框 */}
      <LabelEditorDialog
        open={labelDialogOpen}
        text={labelDialogText}
        onTextChange={(text) => setLabelDialogText(text)}
        onClose={() => setLabelDialogOpen(false)}
        onConfirm={() => {
          if (labelDialogItemId) {
            setItems(
              (prev) =>
                prev.map((item) =>
                  item.id === labelDialogItemId && item.type === 'annotation'
                    ? { ...item, label: labelDialogText }
                    : item
                ) as CanvasItem[]
            )
          }
          setLabelDialogOpen(false)
        }}
      />
      <Menu
        open={Boolean(imageContextMenu)}
        onClose={handleCloseImageContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          imageContextMenu
            ? { top: imageContextMenu.mouseY, left: imageContextMenu.mouseX }
            : undefined
        }
        slotProps={{ paper: { sx: { borderRadius: 2, minWidth: 140 } } }}
      >
        <MenuItem onClick={handleBringToFront}>
          <ListItemText>{'\u79fb\u5230\u6700\u4e0a'}</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleSendToBack}>
          <ListItemText>{'\u79fb\u5230\u6700\u4e0b'}</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleBringForward}>
          <ListItemText>{'\u4e0a\u79fb\u4e00\u5c42'}</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleSendBackward}>
          <ListItemText>{'\u4e0b\u79fb\u4e00\u5c42'}</ListItemText>
        </MenuItem>
        {/* 3D 模型支持导入贴图 */}
        {contextMenuTarget?.type === 'model3d' && (
          <MenuItem
            onClick={() => {
              handleCloseImageContextMenu()
              setPendingTextureModelId(contextMenuTarget.id)
              setTextureImportDialogOpen(true)
            }}
          >
            <ListItemText>加载纹理文件</ListItemText>
          </MenuItem>
        )}
      </Menu>
    </Box>
  )
}

export default CanvasTransientUi
