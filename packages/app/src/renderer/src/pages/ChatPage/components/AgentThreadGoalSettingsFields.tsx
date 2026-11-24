import React from 'react'
import { useTranslation } from 'react-i18next'
import { Box, TextField } from '@mui/material'
import {
  AGENT_GOAL_LIMITS,
  type AgentGoalAutonomy,
  type AgentGoalCompletionPolicy
} from '@shared/api/agentThreadGoal'
import { goalSettingNumber, type AgentThreadGoalSettings } from './agentThreadGoalSettings'

export function AgentThreadGoalSettingsFields({
  settings,
  onChange,
  disabled,
  idPrefix
}: {
  settings: AgentThreadGoalSettings
  onChange: (settings: AgentThreadGoalSettings) => void
  disabled: boolean
  idPrefix: string
}) {
  const { t } = useTranslation()
  const translate = (key: string, fallback: string) => {
    const value = t(key, { defaultValue: fallback })
    return value === key ? fallback : value
  }
  const set = (patch: Partial<AgentThreadGoalSettings>) => onChange({ ...settings, ...patch })
  const number = (
    field: 'maxTurns' | 'maxToolCalls' | 'maxWalltimeMinutes',
    label: string,
    max: number
  ) => (
    <TextField
      id={`${idPrefix}-${field}`}
      label={label}
      value={settings[field]}
      onChange={(event) => set({ [field]: event.target.value })}
      disabled={disabled}
      size="small"
      error={goalSettingNumber(settings[field], max) === undefined}
      inputProps={{ inputMode: 'numeric', maxLength: 7 }}
    />
  )
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 1,
        '& .MuiTextField-root': { flex: '1 1 140px', minWidth: 0 }
      }}
    >
      <TextField
        id={`${idPrefix}-autonomy`}
        select
        label={translate('chat.agent_goal.autonomy_label', 'Autonomy')}
        value={settings.autonomy}
        onChange={(event) => set({ autonomy: event.target.value as AgentGoalAutonomy })}
        disabled={disabled}
        size="small"
        SelectProps={{ native: true }}
      >
        <option value="manual">{translate('chat.agent_goal.autonomy_manual', 'Manual')}</option>
        <option value="continue_when_ready">
          {translate('chat.agent_goal.autonomy_continue', 'Continue when ready')}
        </option>
      </TextField>
      <TextField
        id={`${idPrefix}-completion`}
        select
        label={translate('chat.agent_goal.completion_label', 'Completion')}
        value={settings.completionPolicy}
        onChange={(event) =>
          set({ completionPolicy: event.target.value as AgentGoalCompletionPolicy })
        }
        disabled={disabled}
        size="small"
        SelectProps={{ native: true }}
      >
        <option value="user_confirm">
          {translate('chat.agent_goal.completion_user_confirm', 'I confirm')}
        </option>
        <option value="self_propose">
          {translate('chat.agent_goal.completion_self_propose', 'Agent completes it')}
        </option>
        <option value="verifier">
          {translate('chat.agent_goal.completion_verifier', 'Agent completes it with evidence')}
        </option>
      </TextField>
      {number(
        'maxTurns',
        translate('chat.agent_goal.max_turns_label', 'Max turns'),
        AGENT_GOAL_LIMITS.maxTurns
      )}
      {number(
        'maxToolCalls',
        translate('chat.agent_goal.max_tool_calls_label', 'Max tool calls'),
        AGENT_GOAL_LIMITS.maxToolCalls
      )}
      {number(
        'maxWalltimeMinutes',
        translate('chat.agent_goal.max_walltime_label', 'Max time (minutes)'),
        Math.floor(AGENT_GOAL_LIMITS.maxWalltimeSeconds / 60)
      )}
    </Box>
  )
}
