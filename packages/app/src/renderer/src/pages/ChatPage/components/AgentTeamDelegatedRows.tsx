import React from 'react'
import { Box } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { ChatSession } from '../chatStorage'
import { CHAT_SESSION_RUN_STATE_EVENT, type ChatSessionRunStateEvent } from '../chatPageShared'
import {
  delegatedMemberStatus,
  delegatedTaskText,
  latestDelegatedReply,
  type IdSet
} from '../agentTeamDelegatedWork'
import {
  DelegatedAgentRow,
  DelegatedNote,
  DelegatedResult,
  type DelegatedRowStatus
} from './ChatToolCalls'

/** The failure text without the "(Run: <id>)" reference that names the stored failure record. */
const withoutRunReference = (text: string): string => text.replace(/\s*\(Run: [^()\s]+\)\s*$/, '')

const MemberRow: React.FC<{ member: ChatSession; status: DelegatedRowStatus; held: boolean }> = ({
  member,
  status,
  held
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const reply = latestDelegatedReply(member)
  const name = member.teamMemberName || member.title
  const placeholder =
    reply || status === 'unknown' || status === 'completed' || status === 'failed'
      ? null
      : status === 'cancelled'
        ? 'interrupted'
        : 'running'
  // A member the user stopped while team messages waited for it: they wait until the user resumes it.
  const statusLabel = held
    ? t('chat.delegated.held')
    : status === 'waiting'
      ? t('chat.delegated.status_waiting')
      : t(`chat.tool_call.status_${status}`)
  return (
    <DelegatedAgentRow
      testId="team-delegated-row"
      label={t('chat.delegated.member_label', { name })}
      summary={delegatedTaskText(member)}
      status={status}
      statusLabel={statusLabel}
      expandable={Boolean(reply) || placeholder !== null || held}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      {held ? <DelegatedNote text={t('chat.delegated.held')} tone="interrupted" /> : null}
      {reply && status === 'failed' ? (
        <DelegatedResult text={withoutRunReference(reply)} error />
      ) : reply ? (
        <DelegatedResult text={reply} />
      ) : placeholder && !held ? (
        <DelegatedNote
          text={t(
            placeholder === 'running' ? 'chat.delegated.running' : 'chat.delegated.interrupted'
          )}
          tone={placeholder}
        />
      ) : null}
    </DelegatedAgentRow>
  )
}

/**
 * The lead's view of its members' work: one delegated-agent line per member that has been
 * given work ("[成员] 文案" and its task), at the end of the lead's transcript. Read only:
 * nothing is written to the lead's conversation.
 */
export default function AgentTeamDelegatedRows({
  members,
  scope,
  running,
  waiting,
  held
}: {
  /** The members that have been given work, in the order they were created. */
  members: readonly ChatSession[]
  /** The page's storage scope: the run states of the members are kept under it. */
  scope: string
  running: IdSet
  waiting: IdSet
  /** Members with team messages held for them after the user stopped them. */
  held?: IdSet
}): React.ReactElement | null {
  // A finished, failed or stopped run is announced as a run-state event; draw again then.
  const [, setRevision] = React.useState(0)
  const ids = React.useMemo(() => new Set(members.map((member) => member.id)), [members])
  React.useEffect(() => {
    const onRunState = (event: Event): void => {
      const detail = (event as CustomEvent<ChatSessionRunStateEvent>).detail
      if (detail?.scope === scope && ids.has(detail.sessionId)) setRevision((value) => value + 1)
    }
    window.addEventListener(CHAT_SESSION_RUN_STATE_EVENT, onRunState)
    return () => window.removeEventListener(CHAT_SESSION_RUN_STATE_EVENT, onRunState)
  }, [scope, ids])
  if (!members.length) return null
  return (
    <Box
      data-testid="team-delegated-rows"
      sx={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}
    >
      {members.map((member) => (
        <MemberRow
          key={member.id}
          member={member}
          status={delegatedMemberStatus(member, scope, running, waiting)}
          held={held?.has(member.id) ?? false}
        />
      ))}
    </Box>
  )
}
