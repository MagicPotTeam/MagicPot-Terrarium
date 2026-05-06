import React from 'react'
import {
  Box,
  Button,
  ButtonBase,
  Collapse,
  Divider,
  InputBase,
  IconButton,
  Menu,
  MenuItem,
  Popover,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import {
  AppsOutlined as AppsOutlinedIcon,
  ChevronRight as ChevronRightIcon,
  CreateNewFolderOutlined as CreateNewFolderOutlinedIcon,
  DeleteOutline as DeleteOutlineIcon,
  DriveFileRenameOutline as DriveFileRenameOutlineIcon,
  ExpandMore as ExpandMoreIcon,
  FolderOutlined as FolderOutlinedIcon,
  LayersOutlined as LayersOutlinedIcon,
  MoreHoriz as MoreHorizIcon,
  PauseCircleFilled as PauseIcon,
  PlayArrow as PlayArrowIcon
} from '@mui/icons-material'
import { alpha } from '@mui/material/styles'

import type { CanvasGroupSummary } from './groupMenuUtils'
import { buildCanvasGroupBranchSections, UNGROUPED_BRANCH_KEY } from './groupTreeUtils'
import type { CanvasGroup, CanvasGroupBranch } from './types'

type RenameState = {
  type: 'group' | 'branch'
  id: string
  draft: string
} | null

type GroupActionMenuState = {
  anchorEl: HTMLElement
  group: CanvasGroupSummary
} | null

type ProjectCanvasGroupTreePopoverProps = {
  anchorEl: HTMLElement | null
  open: boolean
  onClose: () => void
  t: (key: string, options?: Record<string, unknown>) => string
  groupSummaries: CanvasGroupSummary[]
  groupBranches: CanvasGroupBranch[]
  exactSelectedGroup: CanvasGroup | null
  groupPlayback: {
    groupId: string
    paused: boolean
  } | null
  canPlayGroupSummary: (group: CanvasGroupSummary) => boolean
  startGroupPlayback: (group: CanvasGroupSummary) => void
  pauseGroupPlayback: () => void
  resumeGroupPlayback: () => void
  handleAutoArrangeGroup: (group: CanvasGroup) => void
  handleDeleteGroup: (groupId: string) => void
  handleFocusGroup: (group: CanvasGroup) => void
  handleCreateGroupBranch: (nameDraft?: string) => CanvasGroupBranch
  handleDeleteGroupBranch: (branchId: string | null) => void
  handleFocusGroupBranch: (branchId: string | null) => void
  handleMoveGroupToBranch: (groupId: string, branchId: string | null) => void
  handleRenameGroup: (groupId: string, nextNameDraft: string) => void
  handleRenameGroupBranch: (branchId: string, nextNameDraft: string) => void
}

export default function ProjectCanvasGroupTreePopover({
  anchorEl,
  open,
  onClose,
  t,
  groupSummaries,
  groupBranches,
  exactSelectedGroup,
  groupPlayback,
  canPlayGroupSummary,
  startGroupPlayback,
  pauseGroupPlayback,
  resumeGroupPlayback,
  handleAutoArrangeGroup,
  handleDeleteGroup,
  handleFocusGroup,
  handleCreateGroupBranch,
  handleDeleteGroupBranch,
  handleFocusGroupBranch,
  handleMoveGroupToBranch,
  handleRenameGroup,
  handleRenameGroupBranch
}: ProjectCanvasGroupTreePopoverProps) {
  const sections = React.useMemo(
    () =>
      buildCanvasGroupBranchSections(
        groupBranches,
        groupSummaries,
        t('canvas.group_branch_ungrouped', { defaultValue: 'Ungrouped' })
      ),
    [groupBranches, groupSummaries, t]
  )
  const [collapsedBranchIds, setCollapsedBranchIds] = React.useState<Set<string>>(new Set())
  const [creatingBranch, setCreatingBranch] = React.useState(false)
  const [branchDraft, setBranchDraft] = React.useState('')
  const [renameState, setRenameState] = React.useState<RenameState>(null)
  const [groupActionMenuState, setGroupActionMenuState] = React.useState<GroupActionMenuState>(null)
  const createInputRef = React.useRef<HTMLInputElement | null>(null)
  const renameInputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    if (!creatingBranch) return
    const rafId = window.requestAnimationFrame(() => {
      createInputRef.current?.focus()
      createInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [creatingBranch])

  const renameSessionKey = renameState ? `${renameState.type}:${renameState.id}` : null

  React.useLayoutEffect(() => {
    if (!renameSessionKey) return
    const input = renameInputRef.current
    if (!input) return

    input.focus()
    const cursorPosition = input.value.length
    input.setSelectionRange(cursorPosition, cursorPosition)
  }, [renameSessionKey])

  React.useEffect(() => {
    if (!open) {
      setCreatingBranch(false)
      setBranchDraft('')
      setRenameState(null)
      setGroupActionMenuState(null)
    }
  }, [open])

  const toggleBranchCollapsed = React.useCallback((branchKey: string) => {
    setCollapsedBranchIds((prev) => {
      const next = new Set(prev)
      if (next.has(branchKey)) {
        next.delete(branchKey)
      } else {
        next.add(branchKey)
      }
      return next
    })
  }, [])

  const commitBranchCreate = React.useCallback(() => {
    handleCreateGroupBranch(branchDraft)
    setBranchDraft('')
    setCreatingBranch(false)
  }, [branchDraft, handleCreateGroupBranch])

  const commitRename = React.useCallback(() => {
    if (!renameState) return

    if (renameState.type === 'group') {
      handleRenameGroup(renameState.id, renameState.draft)
    } else {
      handleRenameGroupBranch(renameState.id, renameState.draft)
    }

    setRenameState(null)
  }, [handleRenameGroup, handleRenameGroupBranch, renameState])

  const cancelRename = React.useCallback(() => {
    setRenameState(null)
  }, [])

  const startBranchRename = React.useCallback((branchId: string, name: string) => {
    setRenameState({
      type: 'branch',
      id: branchId,
      draft: name
    })
  }, [])

  const startGroupRename = React.useCallback((group: Pick<CanvasGroupSummary, 'id' | 'name'>) => {
    setRenameState({
      type: 'group',
      id: group.id,
      draft: group.name
    })
  }, [])

  const moveTargets = React.useMemo(
    () => [
      ...groupBranches.map((branch) => ({
        id: branch.id,
        name: branch.name,
        branchId: branch.id as string | null
      })),
      {
        id: UNGROUPED_BRANCH_KEY,
        name: t('canvas.group_branch_ungrouped', { defaultValue: 'Ungrouped' }),
        branchId: null
      }
    ],
    [groupBranches, t]
  )

  const isEmpty = groupSummaries.length === 0 && groupBranches.length === 0
  const renameLabel = t('canvas.group_rename', { defaultValue: 'Rename' })
  const playbackActionGroup =
    groupActionMenuState?.group && canPlayGroupSummary(groupActionMenuState.group)
      ? groupActionMenuState.group
      : null

  return (
    <>
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={onClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: (theme) => ({
              mt: 1,
              width: 340,
              maxWidth: 'calc(100vw - 32px)',
              borderRadius: 2.5,
              overflow: 'hidden',
              border: `1px solid ${alpha(theme.palette.divider, 0.9)}`,
              backgroundColor:
                theme.palette.mode === 'dark'
                  ? alpha(theme.palette.background.paper, 0.96)
                  : alpha(theme.palette.background.paper, 0.98),
              boxShadow: '0 18px 42px rgba(15, 23, 42, 0.28)',
              backdropFilter: 'blur(12px)'
            })
          }
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', maxHeight: 420 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 1.25 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {t('canvas.group_toolbar')}
            </Typography>
            {groupSummaries.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                {groupSummaries.length}
              </Typography>
            )}
            <Box sx={{ flex: 1 }} />
            {creatingBranch ? (
              <Stack direction="row" spacing={0.75} sx={{ width: 248, maxWidth: '100%' }}>
                <TextField
                  value={branchDraft}
                  size="small"
                  fullWidth
                  inputRef={createInputRef}
                  placeholder={t('canvas.group_branch_placeholder', {
                    defaultValue: 'Branch name'
                  })}
                  onChange={(event) => setBranchDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitBranchCreate()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setCreatingBranch(false)
                      setBranchDraft('')
                    }
                  }}
                />
                <Button
                  size="small"
                  variant="contained"
                  disableElevation
                  onClick={commitBranchCreate}
                  sx={{
                    minWidth: 56,
                    height: 40,
                    minHeight: 40,
                    px: 1.5,
                    borderRadius: 1.5,
                    flexShrink: 0,
                    whiteSpace: 'nowrap'
                  }}
                >
                  {t('canvas.group_create_confirm', { defaultValue: 'Create' })}
                </Button>
              </Stack>
            ) : (
              <Button
                size="small"
                startIcon={<CreateNewFolderOutlinedIcon fontSize="small" />}
                onClick={() => setCreatingBranch(true)}
              >
                {t('canvas.group_branch_create', { defaultValue: 'Branch' })}
              </Button>
            )}
          </Stack>
          <Divider />
          {isEmpty ? (
            <Box sx={{ px: 2, py: 2.25 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {t('canvas.group_empty')}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {t('canvas.group_empty_hint')}
              </Typography>
            </Box>
          ) : (
            <Box sx={{ px: 1, py: 1, overflowY: 'auto' }}>
              {sections.map((section) => {
                const isCollapsed = collapsedBranchIds.has(section.id)
                const isRenamingBranch =
                  renameState?.type === 'branch' && renameState.id === section.branchId
                const canDeleteBranch = Boolean(section.branchId) || section.isUngrouped

                return (
                  <Box key={section.id} sx={{ mb: 0.5 }}>
                    <Stack direction="row" alignItems="center" spacing={0.5}>
                      <Box sx={{ width: 28, display: 'flex', justifyContent: 'center' }}>
                        {section.groups.length > 0 ? (
                          <IconButton
                            size="small"
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleBranchCollapsed(section.id)
                            }}
                          >
                            {isCollapsed ? (
                              <ChevronRightIcon fontSize="small" />
                            ) : (
                              <ExpandMoreIcon fontSize="small" />
                            )}
                          </IconButton>
                        ) : null}
                      </Box>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        {isRenamingBranch && section.branchId ? (
                          <Box
                            sx={(theme) => ({
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              px: 1,
                              py: 0.875,
                              borderRadius: 1.75,
                              backgroundColor:
                                theme.palette.mode === 'dark'
                                  ? alpha(theme.palette.common.white, 0.03)
                                  : alpha(theme.palette.common.black, 0.02)
                            })}
                          >
                            <FolderOutlinedIcon fontSize="small" />
                            <InputBase
                              value={renameState?.draft ?? ''}
                              inputRef={renameInputRef}
                              onChange={(event) =>
                                setRenameState((prev) =>
                                  prev ? { ...prev, draft: event.target.value } : prev
                                )
                              }
                              onBlur={commitRename}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  commitRename()
                                }
                                if (event.key === 'Escape') {
                                  event.preventDefault()
                                  cancelRename()
                                }
                              }}
                              inputProps={{ spellCheck: false }}
                              sx={{
                                ml: 1,
                                flex: 1,
                                minWidth: 0,
                                fontSize: 14,
                                fontWeight: 700,
                                lineHeight: 1.2,
                                color: 'text.primary',
                                '& input': {
                                  width: '100%',
                                  padding: 0,
                                  color: 'inherit',
                                  caretColor: 'currentColor'
                                }
                              }}
                            />
                          </Box>
                        ) : (
                          <ButtonBase
                            component="div"
                            role="button"
                            onClick={() => {
                              if (section.groups.length > 0) {
                                handleFocusGroupBranch(section.branchId)
                              }
                            }}
                            onDoubleClick={() => {
                              if (!section.branchId) return
                              startBranchRename(section.branchId, section.name)
                            }}
                            sx={(theme) => ({
                              width: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'flex-start',
                              px: 1,
                              py: 0.875,
                              borderRadius: 1.75,
                              backgroundColor:
                                theme.palette.mode === 'dark'
                                  ? alpha(theme.palette.common.white, 0.03)
                                  : alpha(theme.palette.common.black, 0.02),
                              '&:hover': {
                                backgroundColor:
                                  theme.palette.mode === 'dark'
                                    ? alpha(theme.palette.common.white, 0.06)
                                    : alpha(theme.palette.common.black, 0.04)
                              }
                            })}
                          >
                            <Box
                              sx={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                minWidth: 0,
                                maxWidth: '100%'
                              }}
                            >
                              <FolderOutlinedIcon fontSize="small" />
                              <Typography
                                variant="body2"
                                sx={{ ml: 1, minWidth: 0, textAlign: 'left', fontWeight: 700 }}
                                noWrap
                              >
                                {section.name}
                              </Typography>
                              {section.branchId ? (
                                <Tooltip title={renameLabel}>
                                  <IconButton
                                    size="small"
                                    aria-label={`${renameLabel} ${section.name}`}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      startBranchRename(section.branchId ?? '', section.name)
                                    }}
                                  >
                                    <DriveFileRenameOutlineIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                              ) : null}
                            </Box>
                            <Box sx={{ flex: 1, minWidth: 0 }} />
                          </ButtonBase>
                        )}
                      </Box>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ minWidth: 16, textAlign: 'center', flexShrink: 0 }}
                      >
                        {section.groups.length}
                      </Typography>
                      {canDeleteBranch ? (
                        <Tooltip
                          title={t('canvas.group_branch_delete', { defaultValue: 'Delete branch' })}
                        >
                          <IconButton
                            size="small"
                            aria-label={t('canvas.group_branch_delete', {
                              defaultValue: 'Delete branch'
                            })}
                            sx={(theme) => ({
                              color: theme.palette.error.main,
                              '&:hover': {
                                backgroundColor: alpha(theme.palette.error.main, 0.12)
                              }
                            })}
                            onClick={(event) => {
                              event.stopPropagation()
                              handleDeleteGroupBranch(section.branchId)
                            }}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      ) : (
                        <Box sx={{ width: 32 }} />
                      )}
                    </Stack>
                    <Collapse in={!isCollapsed}>
                      <Box sx={{ pl: 3.5, pt: 0.25 }}>
                        {section.groups.map((group) => {
                          const isRenamingGroup =
                            renameState?.type === 'group' && renameState.id === group.id

                          return (
                            <Stack
                              key={group.id}
                              direction="row"
                              alignItems="center"
                              spacing={0.5}
                              sx={{ minHeight: 36 }}
                            >
                              <Box sx={{ flex: 1, minWidth: 0 }}>
                                {isRenamingGroup ? (
                                  <Box
                                    sx={(theme) => ({
                                      width: '100%',
                                      display: 'flex',
                                      alignItems: 'flex-start',
                                      px: 1,
                                      py: 0.75,
                                      borderRadius: 1.5,
                                      backgroundColor:
                                        exactSelectedGroup?.id === group.id
                                          ? alpha(theme.palette.primary.main, 0.14)
                                          : 'transparent'
                                    })}
                                  >
                                    <LayersOutlinedIcon fontSize="small" />
                                    <Box sx={{ ml: 1, minWidth: 0, flex: 1, textAlign: 'left' }}>
                                      <InputBase
                                        value={renameState?.draft ?? ''}
                                        inputRef={renameInputRef}
                                        onChange={(event) =>
                                          setRenameState((prev) =>
                                            prev ? { ...prev, draft: event.target.value } : prev
                                          )
                                        }
                                        onBlur={commitRename}
                                        onKeyDown={(event) => {
                                          if (event.key === 'Enter') {
                                            event.preventDefault()
                                            commitRename()
                                          }
                                          if (event.key === 'Escape') {
                                            event.preventDefault()
                                            cancelRename()
                                          }
                                        }}
                                        inputProps={{ spellCheck: false }}
                                        sx={{
                                          width: '100%',
                                          fontSize: 14,
                                          fontWeight: 600,
                                          lineHeight: 1.2,
                                          color: 'text.primary',
                                          '& input': {
                                            width: '100%',
                                            padding: 0,
                                            color: 'inherit',
                                            caretColor: 'currentColor'
                                          }
                                        }}
                                      />
                                      <Typography variant="caption" color="text.secondary" noWrap>
                                        {t('canvas.group_item_count', {
                                          valid: group.validCount,
                                          total: group.totalCount
                                        })}
                                      </Typography>
                                    </Box>
                                  </Box>
                                ) : (
                                  <ButtonBase
                                    component="div"
                                    role="button"
                                    aria-label={group.name}
                                    onClick={() => handleFocusGroup(group)}
                                    onDoubleClick={() => startGroupRename(group)}
                                    sx={(theme) => ({
                                      width: '100%',
                                      display: 'flex',
                                      alignItems: 'flex-start',
                                      justifyContent: 'flex-start',
                                      px: 1,
                                      py: 0.75,
                                      borderRadius: 1.5,
                                      backgroundColor:
                                        exactSelectedGroup?.id === group.id
                                          ? alpha(theme.palette.primary.main, 0.14)
                                          : 'transparent',
                                      '&:hover': {
                                        backgroundColor:
                                          exactSelectedGroup?.id === group.id
                                            ? alpha(theme.palette.primary.main, 0.18)
                                            : theme.palette.mode === 'dark'
                                              ? alpha(theme.palette.common.white, 0.05)
                                              : alpha(theme.palette.common.black, 0.04)
                                      }
                                    })}
                                  >
                                    <LayersOutlinedIcon fontSize="small" />
                                    <Box sx={{ ml: 1, minWidth: 0, flex: 1, textAlign: 'left' }}>
                                      <Box
                                        sx={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          minWidth: 0,
                                          maxWidth: '100%'
                                        }}
                                      >
                                        <Typography
                                          variant="body2"
                                          noWrap
                                          sx={{ minWidth: 0, fontWeight: 600 }}
                                        >
                                          {group.name}
                                        </Typography>
                                        <Tooltip title={renameLabel}>
                                          <IconButton
                                            size="small"
                                            aria-label={`${renameLabel} ${group.name}`}
                                            sx={{ ml: 0.25, mt: -0.25 }}
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              startGroupRename(group)
                                            }}
                                          >
                                            <DriveFileRenameOutlineIcon fontSize="small" />
                                          </IconButton>
                                        </Tooltip>
                                      </Box>
                                      <Typography variant="caption" color="text.secondary" noWrap>
                                        {t('canvas.group_item_count', {
                                          valid: group.validCount,
                                          total: group.totalCount
                                        })}
                                      </Typography>
                                    </Box>
                                  </ButtonBase>
                                )}
                              </Box>
                              <Tooltip title={t('canvas.group_auto_arrange')}>
                                <IconButton
                                  size="small"
                                  aria-label={t('canvas.group_auto_arrange')}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    handleAutoArrangeGroup(group)
                                  }}
                                >
                                  <AppsOutlinedIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                              <Tooltip
                                title={t('canvas.group_action_more', {
                                  defaultValue: 'More actions'
                                })}
                              >
                                <IconButton
                                  size="small"
                                  aria-label={t('canvas.group_action_more', {
                                    defaultValue: 'More actions'
                                  })}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    setGroupActionMenuState({
                                      anchorEl: event.currentTarget,
                                      group
                                    })
                                  }}
                                >
                                  <MoreHorizIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            </Stack>
                          )
                        })}
                      </Box>
                    </Collapse>
                  </Box>
                )
              })}
            </Box>
          )}
          {!isEmpty && (
            <>
              <Divider />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ px: 1.5, py: 1, display: 'block' }}
              >
                {t('canvas.group_branch_empty_hint', {
                  defaultValue: 'Click a branch or group to quickly focus it on the canvas.'
                })}
              </Typography>
            </>
          )}
        </Box>
      </Popover>

      <Menu
        anchorEl={groupActionMenuState?.anchorEl ?? null}
        open={Boolean(groupActionMenuState)}
        onClose={() => setGroupActionMenuState(null)}
      >
        {playbackActionGroup ? (
          <MenuItem
            onClick={() => {
              const group = playbackActionGroup
              if (groupPlayback?.groupId === group.id) {
                if (groupPlayback.paused) {
                  resumeGroupPlayback()
                } else {
                  pauseGroupPlayback()
                }
              } else {
                startGroupPlayback(group)
              }
              setGroupActionMenuState(null)
            }}
          >
            {groupPlayback?.groupId === playbackActionGroup.id ? (
              groupPlayback.paused ? (
                <PlayArrowIcon fontSize="small" style={{ marginRight: 8 }} />
              ) : (
                <PauseIcon fontSize="small" style={{ marginRight: 8 }} />
              )
            ) : null}
            {groupPlayback?.groupId === playbackActionGroup.id
              ? groupPlayback.paused
                ? t('canvas.group_playback_resume', {
                    defaultValue: 'Resume playback'
                  })
                : t('canvas.group_playback_pause', {
                    defaultValue: 'Pause playback'
                  })
              : t('canvas.group_playback_start', {
                  defaultValue: 'Start playback'
                })}
          </MenuItem>
        ) : null}
        {playbackActionGroup ? <Divider /> : null}
        {moveTargets
          .filter((target) => target.branchId !== groupActionMenuState?.group.branchId)
          .map((target) => (
            <MenuItem
              key={target.id}
              onClick={() => {
                const group = groupActionMenuState?.group
                if (!group) return
                handleMoveGroupToBranch(group.id, target.branchId)
                setGroupActionMenuState(null)
              }}
            >
              {t('canvas.group_move_to_branch', {
                name: target.name,
                defaultValue: `Move to ${target.name}`
              })}
            </MenuItem>
          ))}
        <Divider />
        <MenuItem
          onClick={() => {
            const group = groupActionMenuState?.group
            if (!group) return
            handleDeleteGroup(group.id)
            setGroupActionMenuState(null)
          }}
          sx={{ color: 'error.main' }}
        >
          {t('canvas.group_delete')}
        </MenuItem>
      </Menu>
    </>
  )
}
