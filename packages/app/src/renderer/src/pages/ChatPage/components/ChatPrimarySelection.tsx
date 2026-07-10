import React, { useEffect, useState } from 'react'
import { Box, Chip, Typography, Button, Menu, MenuItem } from '@mui/material'
import type { Theme } from '@mui/material/styles'
import BoltIcon from '@mui/icons-material/Bolt'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import CheckIcon from '@mui/icons-material/Check'
import { useTranslation } from 'react-i18next'
import { getReasoningEffortLabel, type LLMReasoningEffort } from '@shared/llm'

export type ChatPrimarySelectionProfile = {
  id: string
  model_name: string
}

type ChatPrimarySelectionProps = {
  compact: boolean
  isAgentSkillSelected: boolean
  selectedProfileId: string | null
  availableProfiles: ChatPrimarySelectionProfile[]
  selectedReasoningEffort?: LLMReasoningEffort | null
  availableReasoningEfforts?: LLMReasoningEffort[]
  selectedSkillLabel: string
  active?: boolean
  onSelectProfile: (profileId: string | null) => void
  onSelectReasoningEffort?: (effort: LLMReasoningEffort) => void
}

const ChatPrimarySelection: React.FC<ChatPrimarySelectionProps> = ({
  compact,
  isAgentSkillSelected,
  selectedProfileId,
  availableProfiles,
  selectedReasoningEffort,
  availableReasoningEfforts = [],
  selectedSkillLabel,
  active = true,
  onSelectProfile,
  onSelectReasoningEffort
}) => {
  const { t } = useTranslation()
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const [reasoningAnchorEl, setReasoningAnchorEl] = useState<null | HTMLElement>(null)

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget)
  }
  const handleClose = () => {
    setAnchorEl(null)
  }
  const handleOpenReasoning = (event: React.MouseEvent<HTMLElement>) => {
    setReasoningAnchorEl(event.currentTarget)
  }
  const handleCloseReasoning = () => {
    setReasoningAnchorEl(null)
  }

  useEffect(() => {
    if (active) return
    setAnchorEl(null)
    setReasoningAnchorEl(null)
  }, [active])

  const selectedProfile = availableProfiles.find((profile) => profile.id === selectedProfileId)
  const displayLabel = selectedProfile ? selectedProfile.model_name : 'No model'
  const displayReasoningLabel = selectedReasoningEffort
    ? getReasoningEffortLabel(selectedReasoningEffort)
    : 'Default'
  const buildSelectorButtonSx = (theme: Theme) =>
    compact
      ? {
          minWidth: 0,
          bgcolor: 'transparent',
          borderRadius: 1,
          color: 'text.secondary',
          px: 0.25,
          py: 0.25,
          textTransform: 'none',
          justifyContent: 'flex-start',
          boxShadow: 'none',
          '&:hover': {
            bgcolor: 'transparent',
            color: 'text.primary'
          }
        }
      : {
          minWidth: 200,
          bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
          borderRadius: 999,
          color: 'text.secondary',
          px: 1.5,
          py: 0.5,
          textTransform: 'none',
          justifyContent: 'space-between',
          '&:hover': {
            bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'
          }
        }
  const buildReasoningButtonSx = (theme: Theme) =>
    compact
      ? {
          minWidth: 0,
          bgcolor: 'transparent',
          borderRadius: 1,
          color: 'text.secondary',
          px: 0.25,
          py: 0.25,
          textTransform: 'none',
          justifyContent: 'flex-start',
          boxShadow: 'none',
          '&:hover': {
            bgcolor: 'transparent',
            color: 'text.primary'
          }
        }
      : {
          minWidth: 120,
          bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
          borderRadius: 999,
          color: 'text.secondary',
          px: 1.5,
          py: 0.5,
          textTransform: 'none',
          justifyContent: 'space-between',
          '&:hover': {
            bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'
          }
        }

  return !isAgentSkillSelected ? (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: compact ? 0.75 : 1,
          flexWrap: 'wrap'
        }}
      >
        {!compact && (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: compact ? 12 : 14 }}>
            {t('chat.model')}:
          </Typography>
        )}
        <Button
          size="small"
          onClick={handleOpen}
          disabled={availableProfiles.length === 0}
          sx={(theme) => buildSelectorButtonSx(theme)}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <BoltIcon sx={{ fontSize: compact ? 14 : 16, opacity: compact ? 0.85 : 1 }} />
            <Typography
              sx={{
                fontSize: compact ? 12 : 14,
                fontWeight: 700,
                letterSpacing: compact ? 0.2 : 0
              }}
            >
              {displayLabel}
            </Typography>
          </Box>
          <ExpandMoreIcon
            sx={{ fontSize: compact ? 15 : 16, opacity: 0.7, ml: compact ? 0.25 : 1 }}
          />
        </Button>
        {availableReasoningEfforts.length > 0 && onSelectReasoningEffort ? (
          <Button
            size="small"
            onClick={handleOpenReasoning}
            sx={(theme) => buildReasoningButtonSx(theme)}
          >
            <Typography
              sx={{
                fontSize: compact ? 12 : 14,
                fontWeight: 700,
                letterSpacing: compact ? 0.2 : 0
              }}
            >
              {displayReasoningLabel}
            </Typography>
            <ExpandMoreIcon
              sx={{ fontSize: compact ? 15 : 16, opacity: 0.7, ml: compact ? 0.25 : 1 }}
            />
          </Button>
        ) : null}
      </Box>
      <Menu
        anchorEl={anchorEl}
        open={active && Boolean(anchorEl)}
        onClose={handleClose}
        slotProps={{
          paper: {
            sx: (theme) => ({
              bgcolor: theme.palette.mode === 'dark' ? '#252628' : '#ffffff',
              borderRadius: 3,
              ...(compact ? { mb: 0.75 } : { mt: 1 }),
              minWidth: 160,
              boxShadow:
                theme.palette.mode === 'dark'
                  ? '0 8px 32px rgba(0,0,0,0.4)'
                  : '0 8px 32px rgba(0,0,0,0.08)',
              border: '1px solid',
              borderColor:
                theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
            })
          }
        }}
        transformOrigin={{ horizontal: 'left', vertical: 'bottom' }}
        anchorOrigin={{ horizontal: 'left', vertical: 'top' }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
            {'\u9009\u62e9\u6a21\u578b'}
          </Typography>
        </Box>
        {availableProfiles.length === 0 && <MenuItem disabled>No model</MenuItem>}
        {availableProfiles.map((profile) => {
          const isSelected = profile.id === selectedProfileId
          return (
            <MenuItem
              key={profile.id}
              onClick={() => {
                onSelectProfile(profile.id)
                handleClose()
              }}
              sx={{
                mx: 1,
                mb: 0.5,
                borderRadius: 2,
                fontSize: 13,
                fontWeight: isSelected ? 700 : 500,
                color: isSelected ? 'text.primary' : 'text.secondary',
                bgcolor: isSelected ? 'action.selected' : 'transparent',
                display: 'flex',
                justifyContent: 'space-between',
                py: 0.75,
                '&:hover': {
                  bgcolor: 'action.hover'
                }
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {isSelected ? <BoltIcon sx={{ fontSize: 16 }} /> : <Box sx={{ width: 16 }} />}
                {profile.model_name}
              </Box>
              {isSelected && <CheckIcon sx={{ fontSize: 16 }} />}
            </MenuItem>
          )
        })}
      </Menu>
      <Menu
        anchorEl={reasoningAnchorEl}
        open={active && Boolean(reasoningAnchorEl)}
        onClose={handleCloseReasoning}
        slotProps={{
          paper: {
            sx: (theme) => ({
              bgcolor: theme.palette.mode === 'dark' ? '#252628' : '#ffffff',
              borderRadius: 3,
              ...(compact ? { mb: 0.75 } : { mt: 1 }),
              minWidth: 140,
              boxShadow:
                theme.palette.mode === 'dark'
                  ? '0 8px 32px rgba(0,0,0,0.4)'
                  : '0 8px 32px rgba(0,0,0,0.08)',
              border: '1px solid',
              borderColor:
                theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
            })
          }
        }}
        transformOrigin={{ horizontal: 'left', vertical: 'bottom' }}
        anchorOrigin={{ horizontal: 'left', vertical: 'top' }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
            Reasoning Effort
          </Typography>
        </Box>
        {availableReasoningEfforts.map((effort) => {
          const isSelected = effort === selectedReasoningEffort
          return (
            <MenuItem
              key={effort}
              onClick={() => {
                onSelectReasoningEffort?.(effort)
                handleCloseReasoning()
              }}
              sx={{
                mx: 1,
                mb: 0.5,
                borderRadius: 2,
                fontSize: 13,
                fontWeight: isSelected ? 700 : 500,
                color: isSelected ? 'text.primary' : 'text.secondary',
                bgcolor: isSelected ? 'action.selected' : 'transparent',
                display: 'flex',
                justifyContent: 'space-between',
                py: 0.75,
                '&:hover': {
                  bgcolor: 'action.hover'
                }
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {isSelected ? <BoltIcon sx={{ fontSize: 16 }} /> : <Box sx={{ width: 16 }} />}
                {getReasoningEffortLabel(effort)}
              </Box>
              {isSelected && <CheckIcon sx={{ fontSize: 16 }} />}
            </MenuItem>
          )
        })}
      </Menu>
    </>
  ) : (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        py: 1,
        minHeight: 40,
        minWidth: compact ? 220 : 300,
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper'
      }}
    >
      {!compact && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontSize: compact ? 12 : 14, whiteSpace: 'nowrap' }}
        >
          {t('chat.agent_skill_active')}:
        </Typography>
      )}
      <Chip
        size="small"
        variant="outlined"
        color="primary"
        label={selectedSkillLabel || t('chat.skill_none')}
      />
      {!compact && (
        <Typography variant="caption" color="text.secondary">
          {t('chat.agent_skill_active_desc')}
        </Typography>
      )}
    </Box>
  )
}

const MemoizedChatPrimarySelection = React.memo(ChatPrimarySelection)

MemoizedChatPrimarySelection.displayName = 'ChatPrimarySelection'

export default MemoizedChatPrimarySelection
