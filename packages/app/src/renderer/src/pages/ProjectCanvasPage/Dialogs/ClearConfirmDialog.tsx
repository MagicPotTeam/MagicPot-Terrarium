import React from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography
} from '@mui/material'

export const ClearConfirmDialog: React.FC<{
  open: boolean
  onClose: () => void
  onConfirm: () => void
}> = ({ open, onClose, onConfirm }) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, fontSize: 16 }}>清空画布</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
          确定要彻底清空当前画布吗？所有未保存的图片、标注等内容将被永久移除，无法撤销。
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button variant="contained" color="error" onClick={onConfirm}>
          确定删除
        </Button>
      </DialogActions>
    </Dialog>
  )
}
