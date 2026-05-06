import React from 'react'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Typography
} from '@mui/material'
import type { GenerationTaskPack } from '../canvasGenerationTaskPack'

type GenerationTaskPackDialogProps = {
  open: boolean
  taskPack: GenerationTaskPack | null
  onClose: () => void
  onConfirm: () => void
}

function renderEntryList(
  title: string,
  entries: Array<{ id: string; title: string; excerpt?: string; contentText?: string }>
) {
  if (entries.length === 0) return null

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      <Box
        component="ul"
        sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}
      >
        {entries.map((entry) => (
          <Box component="li" key={entry.id}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {entry.title}
            </Typography>
            {entry.contentText || entry.excerpt ? (
              <Typography variant="body2" color="text.secondary">
                {entry.contentText || entry.excerpt}
              </Typography>
            ) : null}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function renderAssetList(
  title: string,
  entries: Array<{ id: string; title: string; assetType: 'image' | 'video' | 'model3d' }>
) {
  if (entries.length === 0) return null

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      <Box
        component="ul"
        sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}
      >
        {entries.map((entry) => (
          <Box component="li" key={entry.id}>
            <Typography variant="body2">
              {entry.title}
              <Typography component="span" variant="body2" color="text.secondary">
                {` [${entry.assetType}]`}
              </Typography>
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

export default function GenerationTaskPackDialog({
  open,
  taskPack,
  onClose,
  onConfirm
}: GenerationTaskPackDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>出图任务包</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {taskPack ? (
          <>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              <Chip label={`项目：${taskPack.projectName}`} size="small" />
              <Chip label={`已选 ${taskPack.summary.totalItems} 项`} size="small" />
              <Chip label={`需求 ${taskPack.summary.requirementDocs}`} size="small" />
              <Chip label={`参考文档 ${taskPack.summary.referenceDocs}`} size="small" />
              <Chip label={`参考图 ${taskPack.summary.referenceImages}`} size="small" />
              <Chip label={`风格图 ${taskPack.summary.styleReferenceImages}`} size="small" />
              <Chip label={`备注 ${taskPack.summary.taskNotes}`} size="small" />
              <Chip label={`素材 ${taskPack.summary.existingAssets}`} size="small" />
            </Box>

            <Box
              sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}
            >
              {renderEntryList('需求文档', taskPack.requirementDocs)}
              {renderEntryList('参考文档', taskPack.referenceDocs)}
              {renderEntryList('参考图', taskPack.referenceImages)}
              {renderEntryList('风格参考图', taskPack.styleReferenceImages)}
              {renderEntryList('任务备注', taskPack.taskNotes)}
              {renderAssetList('现有素材', taskPack.existingAssets)}
            </Box>

            <Divider />

            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                borderRadius: 2,
                border: '1px solid',
                borderColor: 'divider',
                px: 1.5,
                py: 1.25,
                bgcolor: 'background.paper'
              }}
            >
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                本轮发送方式
              </Typography>
              <Typography variant="body2" color="text.secondary">
                当前这条“按需求生成”入口默认直接发送给默认 Agent
                生成候选图，不再把项目模型选择当成必须步骤。
              </Typography>
              <Typography variant="body2" color="text.secondary">
                左侧快应用是另一条独立工作流。如果那边已经能完成，就不需要再通过这里绕一圈 Agent。
              </Typography>
            </Box>
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            当前没有可发送的任务包内容。
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button onClick={onConfirm} variant="contained">
          发送给 默认 Agent 生成候选图
        </Button>
      </DialogActions>
    </Dialog>
  )
}
