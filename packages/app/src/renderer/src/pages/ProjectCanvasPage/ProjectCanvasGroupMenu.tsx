import React from 'react'
import {
  Box,
  Button,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import {
  AddRounded as AddRoundedIcon,
  AppsOutlined as AppsOutlinedIcon,
  CheckRounded as CheckRoundedIcon,
  CloseRounded as CloseRoundedIcon,
  DeleteOutline as DeleteOutlineIcon,
  DriveFileRenameOutline as DriveFileRenameOutlineIcon,
  LayersOutlined as LayersOutlinedIcon,
  PlayArrow as PlayArrowIcon
} from '@mui/icons-material'

import type { CanvasGroupSummary } from './groupMenuUtils'

type TranslateFn = (key: string, options?: Record<string, unknown>) => string

type ProjectCanvasGroupMenuProps = {
  anchorEl: HTMLElement | null
  canPlayGroupSummary: (group: Pick<CanvasGroupSummary, 'validItems'>) => boolean
  exactSelectedGroupId: string | null
  groupRenameDraft: string
  groupRenameId: string | null
  groupRenameInputRef: React.RefObject<HTMLInputElement | null>
  groupSummaries: CanvasGroupSummary[]
  isChineseUi: boolean
  selectedIdsSize: number
  handleAutoArrangeGroup: (group: CanvasGroupSummary) => void
  handleCancelGroupRename: () => void
  handleCloseGroupMenu: () => void
  handleCommitGroupRename: (groupId: string, fallbackName: string) => void
  handleCreateGroup: () => void
  handleDeleteGroup: (groupId: string) => void
  handleFocusGroup: (group: CanvasGroupSummary) => void
  handleStartGroupRename: (group: Pick<CanvasGroupSummary, 'id' | 'name'>) => void
  setGroupRenameDraft: React.Dispatch<React.SetStateAction<string>>
  startGroupPlayback: (group: CanvasGroupSummary) => void
  t: TranslateFn
}

function stopInnerAction(event: React.MouseEvent<HTMLElement>) {
  event.preventDefault()
  event.stopPropagation()
}

export default function ProjectCanvasGroupMenu({
  anchorEl,
  canPlayGroupSummary,
  exactSelectedGroupId,
  groupRenameDraft,
  groupRenameId,
  groupRenameInputRef,
  groupSummaries,
  isChineseUi,
  selectedIdsSize,
  handleAutoArrangeGroup,
  handleCancelGroupRename,
  handleCloseGroupMenu,
  handleCommitGroupRename,
  handleCreateGroup,
  handleDeleteGroup,
  handleFocusGroup,
  handleStartGroupRename,
  setGroupRenameDraft,
  startGroupPlayback,
  t
}: ProjectCanvasGroupMenuProps) {
  const renameLabel = isChineseUi ? '重命名' : 'Rename'
  const playLabel = isChineseUi ? '播放' : 'Play'
  const saveLabel = isChineseUi ? '保存' : 'Save'

  return (
    <Menu
      anchorEl={anchorEl}
      open={Boolean(anchorEl)}
      onClose={handleCloseGroupMenu}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{
        paper: {
          sx: {
            mt: 1,
            minWidth: 320,
            maxWidth: 'min(92vw, 440px)',
            borderRadius: 2
          }
        }
      }}
      MenuListProps={{ dense: true }}
    >
      <MenuItem onClick={handleCreateGroup} disabled={selectedIdsSize === 0}>
        <ListItemIcon>
          <AddRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText
          primary={t('canvas.group_create_button')}
          secondary={selectedIdsSize === 0 ? t('canvas.group_create_empty') : undefined}
        />
      </MenuItem>
      <Divider />

      {groupSummaries.length === 0 ? (
        <Box sx={{ px: 2, py: 1.5, maxWidth: 360 }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {t('canvas.group_empty')}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('canvas.group_empty_hint')}
          </Typography>
        </Box>
      ) : (
        groupSummaries.map((group) => {
          if (groupRenameId === group.id) {
            return (
              <Box key={group.id} sx={{ px: 1.5, py: 1, width: 'min(92vw, 420px)' }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', mb: 0.75 }}
                >
                  {group.name}
                </Typography>
                <TextField
                  autoFocus
                  fullWidth
                  inputRef={groupRenameInputRef}
                  placeholder={t('canvas.group_name_placeholder')}
                  size="small"
                  value={groupRenameDraft}
                  onChange={(event) => setGroupRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      handleCommitGroupRename(group.id, group.name)
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      handleCancelGroupRename()
                    }
                  }}
                />
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
                  <Button
                    size="small"
                    onClick={handleCancelGroupRename}
                    startIcon={<CloseRoundedIcon />}
                  >
                    {t('canvas.group_create_cancel')}
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    onClick={() => handleCommitGroupRename(group.id, group.name)}
                    startIcon={<CheckRoundedIcon />}
                  >
                    {saveLabel}
                  </Button>
                </Box>
              </Box>
            )
          }

          return (
            <MenuItem
              key={group.id}
              onClick={() => handleFocusGroup(group)}
              selected={exactSelectedGroupId === group.id}
              sx={{
                alignItems: 'flex-start',
                gap: 1,
                py: 1,
                pr: 1,
                '& .MuiListItemText-secondary': {
                  mt: 0.25
                }
              }}
            >
              <ListItemIcon sx={{ minWidth: 32, mt: 0.25 }}>
                <LayersOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary={group.name}
                secondary={t('canvas.group_item_count', {
                  valid: group.validCount,
                  total: group.totalCount
                })}
                primaryTypographyProps={{ noWrap: true, fontWeight: 700 }}
                secondaryTypographyProps={{ noWrap: true }}
              />
              <Box
                sx={{ display: 'flex', alignItems: 'center', gap: 0.25, ml: 1, flexShrink: 0 }}
                onClick={(event) => stopInnerAction(event)}
              >
                {canPlayGroupSummary(group) && (
                  <Tooltip title={playLabel}>
                    <IconButton
                      aria-label={`${playLabel} ${group.name}`}
                      size="small"
                      onClick={(event) => {
                        stopInnerAction(event)
                        startGroupPlayback(group)
                      }}
                    >
                      <PlayArrowIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title={t('canvas.group_auto_arrange')}>
                  <IconButton
                    aria-label={`${t('canvas.group_auto_arrange')} ${group.name}`}
                    size="small"
                    onClick={(event) => {
                      stopInnerAction(event)
                      handleAutoArrangeGroup(group)
                    }}
                  >
                    <AppsOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title={renameLabel}>
                  <IconButton
                    aria-label={`${renameLabel} ${group.name}`}
                    size="small"
                    onClick={(event) => {
                      stopInnerAction(event)
                      handleStartGroupRename(group)
                    }}
                  >
                    <DriveFileRenameOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title={t('canvas.group_delete')}>
                  <IconButton
                    aria-label={`${t('canvas.group_delete')} ${group.name}`}
                    size="small"
                    color="error"
                    onClick={(event) => {
                      stopInnerAction(event)
                      handleDeleteGroup(group.id)
                    }}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            </MenuItem>
          )
        })
      )}
    </Menu>
  )
}
