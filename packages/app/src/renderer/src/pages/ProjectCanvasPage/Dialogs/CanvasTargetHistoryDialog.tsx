import { DeleteOutline as DeleteOutlineIcon } from '@mui/icons-material'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { useEffect, useMemo, useState } from 'react'
import type { TargetHistoryEntry } from '@shared/targetHistory'

type CanvasTargetHistoryDialogProps = {
  open: boolean
  isChineseUi: boolean
  targets: TargetHistoryEntry[]
  selectedTargetId?: string | null
  busy?: boolean
  onApplyTarget: (targetId: string) => void
  onDeleteTarget: (targetId: string) => void
  onRenameTarget: (targetId: string, name: string) => void
  onClose: () => void
}

function formatHistoryTimestamp(value: string | undefined, isChineseUi: boolean): string {
  const timestamp = value ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(timestamp)) {
    return isChineseUi ? '暂无执行记录' : 'No execution history yet'
  }

  return new Date(timestamp).toLocaleString(isChineseUi ? 'zh-CN' : undefined)
}

export default function CanvasTargetHistoryDialog({
  open,
  isChineseUi,
  targets,
  selectedTargetId,
  busy = false,
  onApplyTarget,
  onDeleteTarget,
  onRenameTarget,
  onClose
}: CanvasTargetHistoryDialogProps) {
  const [draftNames, setDraftNames] = useState<Record<string, string>>({})

  const copy = useMemo(
    () =>
      isChineseUi
        ? {
            title: '历史目标',
            emptyState: '还没有历史目标。执行过一次目标后，会自动出现在这里。',
            targetName: '目标名',
            saveName: '保存',
            applyTarget: '填充',
            appliedTarget: '已填充',
            deleteTarget: '删除历史目标',
            lastRunAt: '最后一次执行',
            close: '关闭'
          }
        : {
            title: 'Target history',
            emptyState:
              'No saved target history is available yet. Run a target once and it will appear here.',
            targetName: 'Target name',
            saveName: 'Save',
            applyTarget: 'Fill',
            appliedTarget: 'Filled',
            deleteTarget: 'Delete target history',
            lastRunAt: 'Last run',
            close: 'Close'
          },
    [isChineseUi]
  )

  useEffect(() => {
    if (!open) {
      return
    }

    setDraftNames(
      Object.fromEntries(targets.map((target) => [target.id, target.name])) as Record<
        string,
        string
      >
    )
  }, [open, targets])

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>{copy.title}</DialogTitle>
      <DialogContent dividers>
        {targets.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {copy.emptyState}
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {targets.map((target) => {
              const draftName = draftNames[target.id] ?? target.name
              const trimmedDraftName = draftName.trim()
              const hasPendingRename =
                trimmedDraftName.length > 0 && trimmedDraftName !== target.name
              const isSelected = target.id === selectedTargetId

              return (
                <Stack
                  key={target.id}
                  spacing={1}
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    border: '1px solid',
                    borderColor: isSelected ? 'primary.main' : 'divider',
                    bgcolor: isSelected ? 'action.hover' : 'background.paper'
                  }}
                >
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    alignItems={{ xs: 'stretch', sm: 'flex-start' }}
                  >
                    <TextField
                      label={copy.targetName}
                      value={draftName}
                      onChange={(event) =>
                        setDraftNames((current) => ({
                          ...current,
                          [target.id]: event.target.value
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && hasPendingRename) {
                          onRenameTarget(target.id, trimmedDraftName)
                        }
                      }}
                      disabled={busy}
                      size="small"
                      fullWidth
                      sx={{ flex: 1, minWidth: 0 }}
                    />

                    <Stack
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      sx={{
                        flexShrink: 0,
                        width: { xs: '100%', sm: 'auto' },
                        alignSelf: { xs: 'stretch', sm: 'flex-start' }
                      }}
                    >
                      <Button
                        variant="outlined"
                        onClick={() => onRenameTarget(target.id, trimmedDraftName)}
                        disabled={busy || !hasPendingRename}
                        size="small"
                        sx={{
                          minWidth: isChineseUi ? 64 : 72,
                          whiteSpace: 'nowrap',
                          height: 40
                        }}
                      >
                        {copy.saveName}
                      </Button>
                      <Button
                        variant={isSelected ? 'contained' : 'outlined'}
                        onClick={() => onApplyTarget(target.id)}
                        disabled={busy}
                        size="small"
                        sx={{
                          minWidth: isChineseUi ? 64 : 72,
                          whiteSpace: 'nowrap',
                          height: 40
                        }}
                      >
                        {isSelected ? copy.appliedTarget : copy.applyTarget}
                      </Button>
                      <Tooltip title={copy.deleteTarget}>
                        <span>
                          <IconButton
                            aria-label={`${copy.deleteTarget} ${target.name}`}
                            onClick={() => onDeleteTarget(target.id)}
                            disabled={busy}
                            size="small"
                            sx={{
                              width: 40,
                              height: 40,
                              color: 'error.main',
                              border: '1px solid',
                              borderColor: 'error.main',
                              flexShrink: 0,
                              '&:hover': {
                                bgcolor: 'rgba(211, 47, 47, 0.08)',
                                borderColor: 'error.dark'
                              }
                            }}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  </Stack>

                  <Typography variant="caption" color="text.secondary">
                    {`${copy.lastRunAt}: ${formatHistoryTimestamp(target.lastRunAt, isChineseUi)}`}
                  </Typography>
                </Stack>
              )
            })}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {copy.close}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
