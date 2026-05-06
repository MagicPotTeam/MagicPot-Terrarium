import React from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography
} from '@mui/material'

type ProjectCanvasPageShortcutDialogProps = {
  open: boolean
  currentShortcut: string
  recordedShortcut: string
  onRecordedShortcutChange: (shortcut: string) => void
  onClose: () => void
  onSave: () => void
}

export default function ProjectCanvasPageShortcutDialog({
  open,
  currentShortcut,
  recordedShortcut,
  onRecordedShortcutChange,
  onClose,
  onSave
}: ProjectCanvasPageShortcutDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, fontSize: 16 }}>设置截图快捷键</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
          当前截图快捷键：<strong>{currentShortcut}</strong>
        </Typography>
        <TextField
          fullWidth
          variant="outlined"
          size="small"
          placeholder="聚焦后直接按下你想设置的新快捷键"
          value={recordedShortcut}
          InputProps={{ readOnly: true }}
          onKeyDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const parts: string[] = []
            if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
            if (event.altKey) parts.push('Alt')
            if (event.shiftKey) parts.push('Shift')
            const key = event.key
            if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
              parts.push(key.length === 1 ? key.toUpperCase() : key)
            }
            if (parts.length > 0) {
              onRecordedShortcutChange(parts.join('+'))
            }
          }}
          sx={{ '& input': { textAlign: 'center', fontWeight: 700, fontSize: 16 } }}
        />
        <Typography variant="caption" sx={{ mt: 1, display: 'block', color: 'text.disabled' }}>
          输入框聚焦后直接按键即可录入组合键，例如 Ctrl+Shift+S。
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button variant="contained" disabled={!recordedShortcut} onClick={onSave}>
          保存快捷键
        </Button>
      </DialogActions>
    </Dialog>
  )
}
