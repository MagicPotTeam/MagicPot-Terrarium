import React from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography
} from '@mui/material'

export const TextureImportDialog: React.FC<{
  open: boolean
  onClose: () => void
  onSkip: () => void
  onImport: () => void
}> = ({ open, onClose, onSkip, onImport }) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, fontSize: 16 }}>纹理文件也要导入吗？</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
          导入与此模型链接的纹理，或者加载无纹理的模型。
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onImport}>
          导入
        </Button>
        <Button onClick={onSkip}>跳过</Button>
      </DialogActions>
    </Dialog>
  )
}
