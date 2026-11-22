import React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import AgentThreadSubRow from '../../../components/AgentThreadSubRow'

export interface AgentTeamThreadRowsTeam {
  leadId: string
  members: ReadonlyArray<{ id: string; name: string }>
}

interface AgentTeamThreadRowsProps {
  /** Host under this thread's row of the Agent column's thread list (only while the list is open). */
  host: HTMLElement | null | undefined
  /** The thread's team, or null when the thread has no members. */
  team: AgentTeamThreadRowsTeam | null
  /** The conversation the pane shows. */
  currentId: string | null
  onSelect: (sessionId: string) => void
  /** Receives the element the side conversations render their rows into, after the team rows. */
  sideRowsHostRef: (element: HTMLDivElement | null) => void
}

/**
 * The conversations of a thread as indented rows of the thread list: the lead ("组长") and one
 * row per member, then the side conversations (rendered by the sides panel into the host this
 * component places after the team rows, so the order does not depend on which mounts first).
 */
const AgentTeamThreadRows: React.FC<AgentTeamThreadRowsProps> = ({
  host,
  team,
  currentId,
  onSelect,
  sideRowsHostRef
}) => {
  const { t } = useTranslation()
  if (!host) return null
  return createPortal(
    <>
      {team ? (
        <>
          <AgentThreadSubRow
            label={t('chat.team_lead_row', { defaultValue: 'Lead' })}
            selected={currentId === team.leadId}
            onSelect={() => onSelect(team.leadId)}
          />
          {team.members.map((member) => (
            <AgentThreadSubRow
              key={member.id}
              label={member.name}
              selected={currentId === member.id}
              onSelect={() => onSelect(member.id)}
            />
          ))}
        </>
      ) : null}
      <div ref={sideRowsHostRef} data-agent-thread-side-rows="" style={{ display: 'contents' }} />
    </>,
    host
  )
}

export default AgentTeamThreadRows
