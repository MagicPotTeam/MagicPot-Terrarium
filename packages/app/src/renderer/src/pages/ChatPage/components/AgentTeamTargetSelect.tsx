import React, { useId, useMemo, useState } from 'react'
import { Box, ButtonBase, Menu, MenuItem } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { useTranslation } from 'react-i18next'

import {
  getAgentColumnRaisedSurface,
  getAgentColumnTokens
} from '../../../components/agentColumnTokens'
import type { AgentTeamThreadRowsTeam } from './AgentTeamThreadRows'

interface AgentTeamTargetSelectProps {
  team: AgentTeamThreadRowsTeam
  /** The conversation the pane shows. */
  currentId: string | null
  onSelect: (sessionId: string) => void
}

/**
 * The small select of the Agent column's header for a thread with a team: it lists the lead
 * ("组长") and the members, shows the open conversation and opens the chosen one.
 */
const AgentTeamTargetSelect: React.FC<AgentTeamTargetSelectProps> = ({
  team,
  currentId,
  onSelect
}) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const tokens = useMemo(() => getAgentColumnTokens(theme), [theme])
  const menuId = useId()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const options = [
    { id: team.leadId, label: t('chat.team_lead_row', { defaultValue: 'Lead' }) },
    ...team.members.map((member) => ({ id: member.id, label: member.name }))
  ]
  const current = options.find((option) => option.id === currentId) ?? options[0]
  const open = Boolean(anchorEl)
  const listLabel = t('chat.team_target_list', { defaultValue: 'Team members' })

  return (
    <>
      <ButtonBase
        type="button"
        disableRipple
        data-testid="agent-team-target-select"
        aria-label={t('chat.team_target_label', {
          defaultValue: 'Team member: {{name}}',
          name: current.label
        })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={current.label}
        onClick={(event) => setAnchorEl(event.currentTarget)}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: `${tokens.space.xs}px`,
          width: '7rem',
          height: 24,
          padding: '0 6px 0 8px',
          border: `1px solid ${alpha(tokens.muted, 0.25)}`,
          borderRadius: `${tokens.radius.control}px`,
          backgroundColor: 'transparent',
          color: tokens.text,
          fontFamily: 'inherit',
          fontSize: tokens.fontSize.small,
          transition: 'border-color 100ms ease, background-color 100ms ease',
          '&:hover': {
            borderColor: alpha(tokens.muted, 0.5),
            backgroundColor: alpha(tokens.muted, 0.06)
          },
          '&.Mui-focusVisible': tokens.focusRing,
          '@container (min-width: 768px)': { width: '8.5rem' }
        }}
      >
        <Box
          component="span"
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: '16px'
          }}
        >
          {current.label}
        </Box>
        <ExpandMoreIcon aria-hidden sx={{ flex: 'none', fontSize: 13, color: tokens.muted }} />
      </ButtonBase>
      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={open}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ horizontal: 'left', vertical: 'bottom' }}
        transformOrigin={{ horizontal: 'left', vertical: 'top' }}
        marginThreshold={8}
        slotProps={{
          list: { 'aria-label': listLabel, dense: true },
          paper: {
            sx: {
              mt: '4px',
              minWidth: anchorEl?.offsetWidth || 112,
              maxWidth: 280,
              maxHeight: 'min(60vh, 360px)',
              border: `1px solid ${tokens.border}`,
              borderRadius: `${tokens.radius.control}px`,
              bgcolor: getAgentColumnRaisedSurface(theme),
              boxShadow: '0 10px 15px rgba(0,0,0,0.1)'
            }
          }
        }}
      >
        {options.map((option) => {
          const checked = option.id === current.id
          return (
            <MenuItem
              key={option.id}
              role="menuitemradio"
              aria-checked={checked}
              selected={checked}
              onClick={() => {
                setAnchorEl(null)
                if (option.id !== currentId) onSelect(option.id)
              }}
              sx={{
                minHeight: 0,
                padding: '4px 8px',
                fontSize: tokens.fontSize.small,
                color: tokens.text,
                '&.Mui-selected': { backgroundColor: tokens.selected },
                '&:hover, &.Mui-focusVisible': { backgroundColor: tokens.hover },
                '&.Mui-selected:hover, &.Mui-selected.Mui-focusVisible': {
                  backgroundColor: tokens.selected
                }
              }}
            >
              <Box
                component="span"
                sx={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {option.label}
              </Box>
            </MenuItem>
          )
        })}
      </Menu>
    </>
  )
}

export default AgentTeamTargetSelect
