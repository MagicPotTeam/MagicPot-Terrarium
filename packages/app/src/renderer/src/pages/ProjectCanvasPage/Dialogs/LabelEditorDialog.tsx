import React from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography
} from '@mui/material'

export const LabelEditorDialog: React.FC<{
  open: boolean
  text: string
  onTextChange: (text: string) => void
  onClose: () => void
  onConfirm: () => void
}> = ({ open, text, onTextChange, onClose, onConfirm }) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, fontSize: 16 }}>编辑标注</DialogTitle>
      <DialogContent>
        <TextField
          fullWidth
          variant="outlined"
          size="small"
          autoFocus
          placeholder="输入标注文字 (可留空)"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onConfirm()
            }
          }}
          sx={{ mt: 1, '& input': { fontWeight: 600 } }}
        />
        <Typography variant="caption" sx={{ mt: 1, display: 'block', color: 'text.disabled' }}>
          标签会显示在标注框上方 · 按 Enter 确认
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button variant="contained" onClick={onConfirm}>
          确定
        </Button>
      </DialogActions>
    </Dialog>
  )
}
