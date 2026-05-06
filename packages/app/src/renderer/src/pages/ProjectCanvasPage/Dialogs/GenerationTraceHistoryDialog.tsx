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
  IconButton,
  Typography
} from '@mui/material'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import { useTranslation } from 'react-i18next'

import { isChineseUiLanguage } from '../projectCanvasPageUiCopy'
import type { GenerationTraceRecord } from '../generationTraceStorage'

type GenerationTraceHistoryDialogProps = {
  open: boolean
  records: GenerationTraceRecord[]
  onContinueRecord: (record: GenerationTraceRecord) => void
  onApproveRecord: (record: GenerationTraceRecord) => void
  onDiscardRecord: (record: GenerationTraceRecord) => void
  onDeleteRecord: (sessionId: string) => void
  onClose: () => void
}

function formatRouteLabel(record: GenerationTraceRecord, isChineseUi: boolean): string {
  if (record.routeChoice.type === 'project-style-model') {
    return isChineseUi
      ? `项目模型：${record.routeChoice.modelLabel}`
      : `Project model: ${record.routeChoice.modelLabel}`
  }

  return isChineseUi ? '默认 Agent（当前项目没有可用模型）' : 'Default agent (no project model)'
}

function formatDecisionLabel(
  decision: GenerationTraceRecord['userDecision'],
  isChineseUi: boolean
): string {
  if (!isChineseUi) {
    const labels: Record<typeof decision, string> = {
      pending: 'In progress',
      approved: 'Approved',
      retried: 'Retried',
      refined: 'Refined',
      discarded: 'Discarded'
    }

    return labels[decision] || decision
  }

  const labels: Record<typeof decision, string> = {
    pending: '进行中',
    approved: '已采纳',
    retried: '已重试',
    refined: '已细化',
    discarded: '已放弃'
  }

  return labels[decision] || decision
}

function formatDecisionColor(
  decision: GenerationTraceRecord['userDecision']
): 'default' | 'success' | 'warning' | 'error' | 'info' {
  const colors: Record<typeof decision, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
    pending: 'info',
    approved: 'success',
    retried: 'warning',
    refined: 'info',
    discarded: 'error'
  }

  return colors[decision] || 'default'
}

function formatTimeAgo(isoDate: string, isChineseUi: boolean): string {
  try {
    const diff = Date.now() - new Date(isoDate).getTime()

    if (diff < 60_000) return isChineseUi ? '刚刚' : 'Just now'
    if (diff < 3_600_000) {
      const minutes = Math.floor(diff / 60_000)
      return isChineseUi ? `${minutes} 分钟前` : `${minutes} minute${minutes === 1 ? '' : 's'} ago`
    }
    if (diff < 86_400_000) {
      const hours = Math.floor(diff / 3_600_000)
      return isChineseUi ? `${hours} 小时前` : `${hours} hour${hours === 1 ? '' : 's'} ago`
    }

    const days = Math.floor(diff / 86_400_000)
    return isChineseUi ? `${days} 天前` : `${days} day${days === 1 ? '' : 's'} ago`
  } catch {
    return isoDate
  }
}

export default function GenerationTraceHistoryDialog({
  open,
  records,
  onContinueRecord,
  onApproveRecord,
  onDiscardRecord,
  onDeleteRecord,
  onClose
}: GenerationTraceHistoryDialogProps) {
  const { i18n } = useTranslation()
  const isChineseUi = isChineseUiLanguage(i18n.resolvedLanguage || i18n.language)

  const title = isChineseUi ? '出图记录' : 'Generation History'
  const emptyText = isChineseUi
    ? '当前项目还没有出图记录。'
    : 'There is no generation history for this project yet.'
  const closeLabel = isChineseUi ? '关闭' : 'Close'
  const continueLabel = isChineseUi ? '继续出图' : 'Continue'
  const approveLabel = isChineseUi ? '采纳本轮' : 'Approve'
  const discardLabel = isChineseUi ? '标记放弃' : 'Discard'
  const selectedItemsLabel = isChineseUi ? '选中元素' : 'Selected items'
  const candidatesLabel = isChineseUi ? '候选图' : 'Candidates'
  const notesLabel = isChineseUi ? '备注' : 'Notes'
  const followUpLabel = isChineseUi ? '后续会话' : 'Follow-up session'
  const untitledProjectLabel = isChineseUi ? '未命名项目' : 'Untitled project'
  const deleteRecordLabel = isChineseUi ? '删除出图记录' : 'Delete generation record'

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, py: 2 }}>
        {records.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {emptyText}
          </Typography>
        ) : (
          records.map((record, index) => (
            <React.Fragment key={record.sessionId}>
              {index > 0 && <Divider />}
              <Box
                sx={{
                  display: 'flex',
                  gap: 1.5,
                  alignItems: 'flex-start',
                  py: 0.75,
                  borderRadius: 1.5,
                  '&:hover': { bgcolor: 'action.hover' },
                  px: 1
                }}
              >
                <Box
                  sx={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                  onClick={() => onContinueRecord(record)}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      mb: 0.5,
                      flexWrap: 'wrap'
                    }}
                  >
                    <Typography variant="body1" sx={{ fontWeight: 600 }}>
                      {record.projectName || untitledProjectLabel}
                    </Typography>
                    <Chip
                      label={formatDecisionLabel(record.userDecision, isChineseUi)}
                      size="small"
                      color={formatDecisionColor(record.userDecision)}
                      variant="outlined"
                    />
                  </Box>

                  <Typography variant="body2" color="text.secondary">
                    {formatRouteLabel(record, isChineseUi)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    {selectedItemsLabel} {record.selectedItemIds.length} | {candidatesLabel}{' '}
                    {record.candidates.length}
                  </Typography>

                  {record.notes ? (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {notesLabel}：{record.notes}
                    </Typography>
                  ) : null}

                  {record.followUpSessionId ? (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {followUpLabel}：{record.followUpSessionId}
                    </Typography>
                  ) : null}

                  <Typography
                    variant="caption"
                    color="text.disabled"
                    sx={{ mt: 0.5, display: 'block' }}
                  >
                    {formatTimeAgo(record.updatedAt || record.createdAt, isChineseUi)}
                  </Typography>
                </Box>

                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0.75,
                    alignItems: 'flex-end'
                  }}
                >
                  <Button
                    size="small"
                    variant="contained"
                    onClick={(event) => {
                      event.stopPropagation()
                      onContinueRecord(record)
                    }}
                  >
                    {continueLabel}
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    color="success"
                    onClick={(event) => {
                      event.stopPropagation()
                      onApproveRecord(record)
                    }}
                  >
                    {approveLabel}
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    color="warning"
                    onClick={(event) => {
                      event.stopPropagation()
                      onDiscardRecord(record)
                    }}
                  >
                    {discardLabel}
                  </Button>
                  <IconButton
                    size="small"
                    aria-label={`${deleteRecordLabel} ${record.sessionId}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onDeleteRecord(record.sessionId)
                    }}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>
            </React.Fragment>
          ))
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{closeLabel}</Button>
      </DialogActions>
    </Dialog>
  )
}
