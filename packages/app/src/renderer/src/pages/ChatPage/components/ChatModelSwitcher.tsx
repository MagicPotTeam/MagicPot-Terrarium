import React, { useId, useMemo, useState } from 'react'
import { Box, InputBase } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import { getReasoningEffortLabel, type LLMReasoningEffort } from '@shared/llm'
import AgentColumnOverlay from '@renderer/components/AgentColumnOverlay'
import { getAgentColumnTokens } from '@renderer/components/agentColumnTokens'

export type ChatModelSwitcherProfile = {
  id: string
  model_name: string
  /** The reasoning efforts this model offers (empty: none) and the one that is in use. */
  efforts: LLMReasoningEffort[]
  effort: LLMReasoningEffort | null
}

export type ChatModelSwitcherProps = {
  open: boolean
  container?: HTMLElement | null
  /** The models that may be chosen, in menu order. */
  profiles: ChatModelSwitcherProfile[]
  /** The model in use (null: none of the listed ones). */
  currentProfileId: string | null
  onClose: () => void
  /** Called with the chosen model and effort when either differs from what is in use. */
  onSwitch: (profileId: string, effort: LLMReasoningEffort | undefined) => void
}

type Draft = { profileId: string | null; effort: LLMReasoningEffort | null }

/**
 * The model switcher of the Agent column, in the column's overlay drawer: a search field,
 * the models as two-line rows (the chosen one tinted), the reasoning efforts of the chosen
 * model as pill chips, and Cancel + Switch (disabled while nothing changed).
 */
const ChatModelSwitcher: React.FC<ChatModelSwitcherProps> = ({
  open,
  container,
  profiles,
  currentProfileId,
  onClose,
  onSwitch
}) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const tokens = getAgentColumnTokens(theme)
  const modelLabelId = useId()
  const effortLabelId = useId()
  const current = profiles.find((profile) => profile.id === currentProfileId) ?? null
  const initialDraft = (): Draft => ({
    profileId: current?.id ?? null,
    effort: current?.effort ?? null
  })
  const [draft, setDraft] = useState<Draft>(initialDraft)
  const [query, setQuery] = useState('')
  const [wasOpen, setWasOpen] = useState(open)
  // Every opening starts from the model and effort in use.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setDraft(initialDraft())
      setQuery('')
    }
  }

  const needle = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      needle
        ? profiles.filter(
            (profile) =>
              profile.model_name.toLowerCase().includes(needle) ||
              profile.id.toLowerCase().includes(needle)
          )
        : profiles,
    [needle, profiles]
  )
  const chosen = profiles.find((profile) => profile.id === draft.profileId) ?? null
  const changed =
    chosen !== null &&
    (chosen.id !== current?.id || (draft.effort ?? null) !== (chosen.effort ?? null))

  const sectionLabelSx = {
    margin: '0 0 4px',
    fontSize: tokens.fontSize.micro,
    fontWeight: 400,
    lineHeight: '16px',
    letterSpacing: '0.025em',
    textTransform: 'uppercase',
    color: tokens.muted
  } as const

  // An InputBase: the app's global style for plain inputs (14px, its own border) skips it.
  const search = (
    <InputBase
      value={query}
      placeholder={t('chat.model_switcher.search')}
      inputProps={{ type: 'search', 'aria-label': t('chat.model_switcher.search') }}
      onChange={(event) => setQuery(event.target.value)}
      sx={{
        display: 'flex',
        width: '100%',
        minWidth: 0,
        height: 28,
        padding: '0 8px',
        border: `1px solid ${tokens.border}`,
        borderRadius: `${tokens.radius.control}px`,
        color: tokens.text,
        fontSize: tokens.fontSize.small,
        '&.Mui-focused': { borderColor: tokens.accent },
        '& .MuiInputBase-input': { padding: 0, height: '100%' },
        '& .MuiInputBase-input::placeholder': { color: tokens.muted, opacity: 1 }
      }}
    />
  )

  const efforts = chosen?.efforts ?? []
  const effortsSection =
    efforts.length > 0 ? (
      <Box
        data-testid="chat-model-switcher-efforts"
        sx={{
          maxHeight: '24vh',
          overflowY: 'auto',
          padding: '10px 12px',
          borderTop: `1px solid ${tokens.border}`
        }}
      >
        <Box component="h3" id={effortLabelId} sx={sectionLabelSx}>
          {t('chat.reasoning_label')}
        </Box>
        <Box
          role="group"
          aria-labelledby={effortLabelId}
          sx={{ display: 'flex', flexWrap: 'wrap', gap: '4px', minWidth: 0 }}
        >
          {efforts.map((effort) => {
            const pressed = draft.effort === effort
            return (
              <Box
                component="button"
                type="button"
                key={effort}
                aria-pressed={pressed}
                // At most one effort; choosing the chosen one again goes back to the default.
                onClick={() =>
                  setDraft((previous) => ({ ...previous, effort: pressed ? null : effort }))
                }
                sx={{
                  boxSizing: 'border-box',
                  m: 0,
                  padding: '2px 9px',
                  border: `1px solid ${pressed ? tokens.accent : alpha(tokens.muted, 0.3)}`,
                  borderRadius: '999px',
                  backgroundColor: pressed ? alpha(tokens.accent, 0.18) : 'transparent',
                  color: pressed ? tokens.accent : tokens.text,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: tokens.fontSize.caption,
                  fontWeight: pressed ? 500 : 400,
                  lineHeight: '16px',
                  '&:hover': {
                    backgroundColor: pressed ? alpha(tokens.accent, 0.18) : tokens.hover
                  },
                  '&:focus-visible': { outline: `2px solid ${tokens.accent}`, outlineOffset: '1px' }
                }}
              >
                {getReasoningEffortLabel(effort)}
              </Box>
            )
          })}
        </Box>
      </Box>
    ) : null

  return (
    <AgentColumnOverlay
      open={open}
      container={container}
      label={t('chat.model_switcher.label')}
      top={search}
      bottom={effortsSection}
      onClose={onClose}
      primary={{
        label: t('chat.model_switcher.switch'),
        disabled: !changed,
        onClick: () => {
          if (!chosen || !changed) return
          onSwitch(chosen.id, draft.effort ?? undefined)
          onClose()
        }
      }}
      data-testid="chat-model-switcher"
    >
      <Box component="h3" id={modelLabelId} sx={sectionLabelSx}>
        {t('chat.model')}
      </Box>
      {visible.length === 0 ? (
        <Box
          component="p"
          sx={{
            m: 0,
            padding: '12px 0',
            textAlign: 'center',
            fontSize: tokens.fontSize.caption,
            fontStyle: 'italic',
            color: tokens.muted
          }}
        >
          {t('chat.model_switcher.empty')}
        </Box>
      ) : (
        <Box role="radiogroup" aria-labelledby={modelLabelId}>
          {visible.map((profile) => {
            const checked = profile.id === draft.profileId
            return (
              <Box
                component="button"
                type="button"
                role="radio"
                key={profile.id}
                aria-checked={checked}
                title={profile.model_name}
                onClick={() => setDraft({ profileId: profile.id, effort: profile.effort })}
                sx={{
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  width: '100%',
                  minWidth: 0,
                  m: '0 0 2px',
                  padding: '6px 8px',
                  border: `1px solid ${checked ? alpha(tokens.accent, 0.3) : 'transparent'}`,
                  borderRadius: `${tokens.radius.control}px`,
                  backgroundColor: checked ? alpha(tokens.accent, 0.12) : 'transparent',
                  color: tokens.text,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  '&:hover': {
                    backgroundColor: checked ? alpha(tokens.accent, 0.12) : tokens.hover
                  },
                  '&:focus-visible': tokens.focusRing
                }}
              >
                <Box
                  component="span"
                  sx={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: tokens.fontSize.small,
                    fontWeight: 500,
                    lineHeight: '16px'
                  }}
                >
                  {profile.model_name}
                </Box>
                <Box
                  component="span"
                  sx={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: tokens.monoFont,
                    fontSize: tokens.fontSize.micro,
                    lineHeight: '14px',
                    color: tokens.muted
                  }}
                >
                  {profile.id}
                </Box>
              </Box>
            )
          })}
        </Box>
      )}
    </AgentColumnOverlay>
  )
}

export default ChatModelSwitcher
