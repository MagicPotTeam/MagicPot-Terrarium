import type { useTeamImagePlacement } from './useTeamImagePlacement'
import { reconcileTeamImageButtonKeys } from './teamImageButtonKeys'
import { useState } from 'react'
import { Box, Button, TextField, Typography } from '@mui/material'
import AgentColumnOverlay from '@renderer/components/AgentColumnOverlay'
import { useTranslation } from 'react-i18next'
import { createTeamMember, TEAM_MAX_MEMBERS } from '../agentTeam'
import type { ChatSession } from '../chatStorage'

export type TeamImagePlacement = ReturnType<typeof useTeamImagePlacement>
type CreateMember = (
  name: string,
  role: string,
  onCommittedEmpty: (memberId: string) => void
) => Promise<void>

/** Observer-free form: provide the placement owned by a stable parent, never mount a second observer. */
export function AgentTeamMemberForm({
  lead,
  members,
  creating,
  onClose,
  onCreate,
  placement,
  overlayHost,
  onReturnFocus
}: {
  lead: ChatSession
  members: ChatSession[]
  creating: boolean
  placement: TeamImagePlacement
  onClose(): void
  onCreate: CreateMember
  /** The Agent column's overlay layer; the form is drawn in place without one. */
  overlayHost?: HTMLElement | null
  /** The form closed while it held the focus: the focus goes back to the conversation. */
  onReturnFocus?(): void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(''),
    [role, setRole] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const limit = lead.teamSettings?.maxMembers ?? TEAM_MAX_MEMBERS
  const invalidLimit = !Number.isInteger(limit) || limit < 1 || limit > TEAM_MAX_MEMBERS
  const atLimit = !invalidLimit && members.length >= limit
  let valid = false
  try {
    createTeamMember(lead, name, role, 'validation-only', 0)
    valid = true
  } catch {
    /* Same validation as the actual create. */
  }
  return (
    <AgentColumnOverlay
      open={creating}
      container={overlayHost}
      label={t('agent_workspace.member_form.create_label')}
      title={t('agent_workspace.member_form.title')}
      // A creation in flight cannot be abandoned: its result must be read first.
      onClose={() => {
        if (!busy) onClose()
      }}
      cancelDisabled={busy}
      onReturnFocus={onReturnFocus}
      primary={{
        label: t('agent_workspace.member_form.create'),
        // The accessible name keeps the visible label in it (voice control) and says more.
        ariaLabel: t('agent_workspace.member_form.create_aria'),
        busy,
        disabled: !valid || atLimit || invalidLimit || Boolean(lead.teamEnded),
        onClick: () => {
          setBusy(true)
          setError('')
          void onCreate(name, role, placement.registerEmptyMember)
            .then(() => {
              setName('')
              setRole('')
              onClose()
            })
            .catch(() => setError(t('agent_workspace.member_form.create_unconfirmed')))
            .finally(() => setBusy(false))
        }
      }}
      data-testid="agent-team-member-form"
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          minWidth: 0,
          '& .MuiInputBase-input, & .MuiInputLabel-root': { fontSize: 12 }
        }}
      >
        {invalidLimit ? (
          <Typography variant="caption" component="div">
            {t('agent_workspace.member_form.limit_invalid')}
          </Typography>
        ) : (
          atLimit && (
            <Typography variant="caption" component="div">
              {t('agent_workspace.member_form.limit_reached', { limit })}
            </Typography>
          )
        )}
        <TextField
          size="small"
          fullWidth
          label={t('agent_workspace.member_form.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          inputProps={{ maxLength: 32 }}
        />
        <TextField
          size="small"
          fullWidth
          label={t('agent_workspace.member_form.role')}
          value={role}
          onChange={(e) => setRole(e.target.value)}
          inputProps={{ maxLength: 256 }}
        />
        {error && (
          <Typography role="alert" color="error" sx={{ fontSize: 12 }}>
            {error}
          </Typography>
        )}
      </Box>
    </AgentColumnOverlay>
  )
}

/** Bordered 22px text buttons, as the per-message action row of the Agent column. */
const memberImageButtonSx = {
  height: 22,
  minWidth: 0,
  px: '6px',
  py: 0,
  fontSize: 11,
  lineHeight: '20px',
  textTransform: 'none',
  borderRadius: '4px',
  border: '1px solid',
  borderColor: 'divider',
  color: 'text.secondary',
  '&:hover': { color: 'text.primary', borderColor: 'text.secondary', bgcolor: 'transparent' }
} as const

/** Render existing manual image actions with the exact slots used by auto placement. */
export function AgentTeamMemberImages({
  member,
  placeImage
}: {
  member: ChatSession
  placeImage: TeamImagePlacement['place']
}) {
  const { t } = useTranslation()
  const images = member.messages.flatMap((message, messageIndex) =>
    message.role === 'assistant'
      ? (message.attachments ?? [])
          .filter((attachment) => attachment.type === 'image')
          .map((attachment, attachmentIndex) => ({
            attachment,
            slot: JSON.stringify([member.id, messageIndex, attachmentIndex])
          }))
      : []
  )
  const urls = images.map(({ attachment }) => `${attachment.url}`)
  const [keys, setKeys] = useState(() =>
    reconcileTeamImageButtonKeys({ nextId: 0, entries: [] }, urls)
  )
  const nextKeys = reconcileTeamImageButtonKeys(keys, urls)
  if (nextKeys !== keys) setKeys(nextKeys)
  return (
    <>
      {images.map(({ attachment, slot }, index) => (
        <Button
          key={nextKeys.entries[index].key}
          size="small"
          onClick={() => {
            placeImage(
              member.id,
              { ...attachment, fileName: `${member.teamMemberName}·图${index + 1}` },
              undefined,
              undefined,
              slot
            )
          }}
          sx={memberImageButtonSx}
        >
          {t('chat.team_member_image_place', {
            name: member.teamMemberName,
            index: index + 1,
            defaultValue: 'Place {{name}} · image {{index}}'
          })}
        </Button>
      ))}
    </>
  )
}
