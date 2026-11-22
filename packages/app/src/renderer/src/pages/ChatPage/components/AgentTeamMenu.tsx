import { useEffect, useId, useRef, useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  TextField,
  Typography
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import AgentColumnOverlay from '@renderer/components/AgentColumnOverlay'
import { getAgentColumnTokens } from '@renderer/components/agentColumnTokens'
import type { ChatSession } from '../chatStorage'
import { resolveTeamRequestSettings } from '../agentTeam'
import {
  canSetTeamTaskStatus,
  setTeamTaskDependencies,
  setTeamTaskStatus,
  teamTaskBlockers,
  teamTaskOutcome,
  validateTeamTasks,
  type TeamTaskOutcome
} from '../agentTeamTasks'

const taskStatusLabel = {
  pending: 'chat.team_menu.task_pending',
  running: 'chat.team_menu.task_running',
  done: 'chat.team_menu.task_done'
} as const
const broadcastUnknownNotice = 'chat.team_menu.broadcast_unknown'
const normalizeAccessibleName = (value: string) => value.replace(/\s+/g, ' ').trim()
const normalizePerceivedName = (value: string) =>
  normalizeAccessibleName(value.replace(/[\u200b\u2060]/gu, ''))

export default function AgentTeamMenu({
  lead,
  members,
  models,
  onSave,
  onEnd,
  onDispatch,
  isOwnerBusy,
  subscriptions,
  onSubscriptionChange,
  onBroadcast,
  openRequest,
  onReturnFocus,
  overlayHost
}: {
  /** Opens the dialog each time it changes (the composer "+" menu entry "团队…"). */
  openRequest?: number
  /** The dialog closed while it held the focus: the focus goes back to the conversation. */
  onReturnFocus?(): void
  /** The Agent column's overlay layer; the dialog is drawn in place without one. */
  overlayHost?: HTMLElement | null
  models: { id: string; name: string }[]
  onBroadcast?(
    input: Readonly<{ id: string; text: string }>
  ): { queued: number } | Promise<{ queued: number }>
  onEnd(): void
  onDispatch?(taskId: string): void
  /**
   * Whether a task owner (a member id, or the lead's id for lead tasks) has a live run or a send in
   * preparation. A running task whose owner is not busy is left over from an ended run: it can be
   * reset to pending. Without this callback no reset is offered.
   */
  isOwnerBusy?(ownerId: string): boolean
  subscriptions?: readonly string[]
  onSubscriptionChange?(memberId: string, subscribed: boolean): void
  lead: ChatSession
  members: ChatSession[]
  onSave(value: ChatSession): Promise<boolean>
}) {
  const dependencyDescriptionId = useId()
  const endDraftDescriptionId = useId()
  const channelLimitDescriptionId = useId()
  const subscriptionGroupLabelId = useId()
  const { t } = useTranslation()
  const tokens = getAgentColumnTokens(useTheme())
  const [open, setOpen] = useState(false)
  const initialOpenRequest = useRef(openRequest)
  useEffect(() => {
    if (openRequest !== undefined && initialOpenRequest.current !== openRequest) {
      initialOpenRequest.current = openRequest
      setOpen(true)
    }
  }, [openRequest])
  const [task, setTask] = useState('')
  const [owner, setOwner] = useState('')
  const [ownerNeedsReselection, setOwnerNeedsReselection] = useState(false)
  const ownerMissing = owner !== '' && !members.some((member) => member.id === owner)
  useEffect(() => {
    if (ownerMissing) setOwnerNeedsReselection(true)
  }, [ownerMissing])
  const invalidOwner = ownerMissing || ownerNeedsReselection
  const invalidOwnerOption = '\u0000former-owner'
  const [dependencies, setDependencies] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [broadcastPending, setBroadcastPending] = useState(false)
  const broadcastPendingRef = useRef(false)
  const [broadcastNotice, setBroadcastNotice] = useState('')
  const [broadcastUnknown, setBroadcastUnknown] = useState(false)
  const broadcastUnknownRef = useRef(false)
  const broadcastUnknownDescriptionId = useId()
  const [pendingDraft, setPendingDraft] = useState(false)
  const draftPendingRef = useRef(false)
  const [pendingOther, setPendingOther] = useState(false)
  const otherPendingRef = useRef(false)
  const draftGenerationRef = useRef(0)
  const unresolvedDraftRef = useRef(false)
  const [draftUnconfirmed, setDraftUnconfirmed] = useState(false)
  const [unconfirmedEntry, setUnconfirmedEntry] = useState<{
    kind: 'task' | 'channel'
    id: string
  } | null>(null)
  useEffect(
    () => () => {
      draftGenerationRef.current += 1
    },
    []
  )
  const submitDraft = async (
    value: ChatSession,
    entry: { kind: 'task' | 'channel'; id: string },
    clear: () => void
  ) => {
    if (draftPendingRef.current || otherPendingRef.current || unresolvedDraftRef.current) return
    draftPendingRef.current = true
    setUnconfirmedEntry(entry)
    setPendingDraft(true)
    const generation = draftGenerationRef.current
    try {
      const saved = await onSave(value)
      if (draftGenerationRef.current !== generation) return
      if (saved === true) {
        setUnconfirmedEntry(null)
        clear()
      } else {
        unresolvedDraftRef.current = true
        setUnconfirmedEntry(entry)
        setDraftUnconfirmed(true)
      }
    } catch {
      if (draftGenerationRef.current === generation) {
        unresolvedDraftRef.current = true
        setUnconfirmedEntry(entry)
        setDraftUnconfirmed(true)
      }
    } finally {
      draftPendingRef.current = false
      if (draftGenerationRef.current === generation) setPendingDraft(false)
    }
  }
  const saveOther = async (value: ChatSession) => {
    if (draftPendingRef.current || otherPendingRef.current || unresolvedDraftRef.current) return
    otherPendingRef.current = true
    setPendingOther(true)
    const generation = draftGenerationRef.current
    try {
      const saved = await onSave(value)
      if (draftGenerationRef.current === generation && saved !== true) {
        unresolvedDraftRef.current = true
        setDraftUnconfirmed(true)
      }
    } catch {
      if (draftGenerationRef.current === generation) {
        unresolvedDraftRef.current = true
        setDraftUnconfirmed(true)
      }
    } finally {
      otherPendingRef.current = false
      if (draftGenerationRef.current === generation) setPendingOther(false)
    }
  }
  const endTeam = () => {
    if (
      draftPendingRef.current ||
      otherPendingRef.current ||
      unresolvedDraftRef.current ||
      broadcastPendingRef.current
    )
      return
    draftGenerationRef.current += 1
    onEnd()
  }
  const draftLocked = pendingDraft || pendingOther || draftUnconfirmed || broadcastPending
  const runOutcomeLabel = (outcome: TeamTaskOutcome): string =>
    outcome === 'failed'
      ? t('chat.team_task_run_failed', { defaultValue: 'Last run failed' })
      : outcome === 'cancelled'
        ? t('chat.team_task_run_cancelled', { defaultValue: 'Last run cancelled' })
        : t('chat.team_task_run_interrupted', { defaultValue: 'Last run interrupted' })
  const tasks = lead.teamTasks ?? []
  let validTasks = true
  try {
    validateTeamTasks(tasks)
  } catch {
    validTasks = false
  }
  const titleCounts = new Map<string, number>()
  if (validTasks)
    for (const item of tasks) {
      const title = normalizeAccessibleName(item.title)
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
    }
  const dispatchNames = validTasks
    ? tasks.map((item, index) =>
        (titleCounts.get(normalizeAccessibleName(item.title)) ?? 0) > 1
          ? `执行 ${item.title}（当前列表第 ${index + 1} 项，位置随列表变化）`
          : `执行 ${item.title}`
      )
    : []
  const originalDispatchNames = validTasks ? tasks.map((item) => `执行 ${item.title}`) : []
  // Treat these invisible characters as a potential title collision, without changing displayed or saved titles.
  const seenPerceivedTitles = new Map<string, string>()
  let invisibleTitleCollision = false
  if (validTasks)
    for (const item of tasks) {
      const original = normalizeAccessibleName(item.title)
      const perceived = normalizePerceivedName(item.title)
      const previous = seenPerceivedTitles.get(perceived)
      if (previous !== undefined && previous !== original) {
        invisibleTitleCollision = true
        break
      }
      seenPerceivedTitles.set(perceived, original)
    }
  const conflictsWithOtherTitle = dispatchNames.some(
    (name, index) =>
      (titleCounts.get(normalizeAccessibleName(tasks[index].title)) ?? 0) > 1 &&
      originalDispatchNames.some(
        (original, otherIndex) =>
          otherIndex !== index && normalizePerceivedName(name) === normalizePerceivedName(original)
      )
  )
  const useDispatchPositionPrefix =
    !validTasks ||
    invisibleTitleCollision ||
    conflictsWithOtherTitle ||
    new Set(dispatchNames.map(normalizePerceivedName)).size !== dispatchNames.length ||
    tasks.some((item) => /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(item.title))
  const dependencyNames = new Set<string>()
  let useDependencyPositionPrefix = useDispatchPositionPrefix
  if (validTasks && open && !useDependencyPositionPrefix) {
    for (const item of tasks) {
      const name = normalizePerceivedName(item.title)
      if (dependencyNames.has(name)) {
        useDependencyPositionPrefix = true
        break
      }
      dependencyNames.add(name)
    }
    if (!useDependencyPositionPrefix)
      for (const item of tasks) {
        for (const candidate of tasks) {
          if (candidate.id === item.id) continue
          const name = normalizePerceivedName(`${item.title} 依赖 ${candidate.title}`)
          if (dependencyNames.has(name)) {
            useDependencyPositionPrefix = true
            break
          }
          dependencyNames.add(name)
        }
        if (useDependencyPositionPrefix) break
      }
  }
  const taskPositions = validTasks
    ? new Map(tasks.map((item, index) => [item.id, index + 1]))
    : new Map<string, number>()
  const unavailableSelection = Boolean(
    lead.teamSettings && Object.hasOwn(lead.teamSettings, 'memberModelSelection')
  )
  const currentModel = lead.teamSettings?.defaultModel ?? ''
  const missingModel = currentModel !== '' && !models.some((model) => model.id === currentModel)
  const currentIds = new Set(tasks.map((item) => item.id))
  const durablePendingReceipts = (lead.teamMessageReceipts ?? []).filter(
    (receipt) => receipt.state === 'queued' || receipt.state === 'unknown'
  ).length
  const selected = dependencies.filter((id) => currentIds.has(id))
  // Upstream's drawer look: section labels, 12px text and compact controls.
  const contentSx = {
    fontSize: tokens.fontSize.small,
    '& .MuiTypography-subtitle2': {
      m: '14px 0 4px',
      fontSize: tokens.fontSize.micro,
      fontWeight: 600,
      lineHeight: '16px',
      letterSpacing: '0.025em',
      textTransform: 'uppercase',
      color: tokens.muted
    },
    '& > .MuiTypography-subtitle2:first-of-type': { mt: 0 },
    '& .MuiTypography-caption, & .MuiFormControlLabel-label': {
      fontSize: tokens.fontSize.small,
      lineHeight: 1.5
    },
    '& .MuiButton-root': {
      minHeight: 24,
      py: '2px',
      fontSize: tokens.fontSize.small,
      textTransform: 'none'
    },
    // One field per line, as in a drawer form; the buttons that act on a field follow it.
    '& .MuiTextField-root': { display: 'flex', width: '100%', my: '6px' },
    '& .MuiInputBase-input, & .MuiInputLabel-root': { fontSize: tokens.fontSize.small },
    '& details': { fontSize: tokens.fontSize.small }
  } as const
  return (
    <AgentColumnOverlay
      open={open}
      container={overlayHost}
      label={t('chat.team_menu.manage_label')}
      title={t('agent_workspace.team_overlay.title')}
      onClose={() => setOpen(false)}
      cancelLabel={t('agent_workspace.overlay.close')}
      cancelAriaLabel={t('agent_workspace.team_overlay.close_aria')}
      initialFocus="cancel"
      onReturnFocus={onReturnFocus}
      data-testid="agent-team-overlay"
    >
      <Box sx={contentSx}>
        <Typography variant="subtitle2">{t('chat.team_menu.shared_tasks')}</Typography>
        {validTasks && tasks.length === 0 && (
          <Typography variant="caption" component="div">
            {t('chat.team_menu.no_shared_tasks')}
          </Typography>
        )}
        <Typography variant="caption" component="div">
          {onDispatch
            ? t('chat.team_menu.dispatch_after_dependencies')
            : t('chat.team_menu.dispatch_unavailable')}
        </Typography>
        <Typography variant="caption" component="div">
          {t('chat.team_menu.status_only_note')}
        </Typography>
        {validTasks && tasks.some((item) => item.status === 'running') && (
          <Typography variant="caption" component="div">
            {t('chat.team_menu.status_not_result')}
          </Typography>
        )}
        {onDispatch && validTasks && tasks.some((item) => !item.ownerId) && (
          <Typography variant="caption" component="div">
            {t('chat.team_menu.lead_task_no_dispatch')}
          </Typography>
        )}
        {!validTasks && (
          <Typography color="error">{t('chat.team_menu.dependency_invalid')}</Typography>
        )}
        {validTasks &&
          tasks.map((item, taskIndex) => {
            const blockers = teamTaskBlockers(tasks, item)
            const nextStatus = item.status === 'done' ? 'pending' : 'done'
            const reopenBlockedBySuccessor =
              item.status === 'done' &&
              tasks.some(
                (candidate) =>
                  candidate.dependsOn.includes(item.id) &&
                  (candidate.status === 'running' || candidate.status === 'done')
              )
            const reopenDescriptionId = `${dependencyDescriptionId}-reopen-${taskIndex}`
            const ownerMatches = members.filter(
              (member) => member.id === item.ownerId && item.ownerId !== ''
            )
            let validOwner = false
            if (ownerMatches.length === 1) {
              try {
                resolveTeamRequestSettings(ownerMatches[0], lead)
                validOwner = true
              } catch {
                /* Stale member. */
              }
            }
            const canDispatch =
              !draftLocked &&
              !!onDispatch &&
              !lead.teamEnded &&
              validOwner &&
              item.status === 'pending' &&
              canSetTeamTaskStatus(tasks, item.id, 'running')
            // Running without a live run of its owner: the run ended without reporting (an earlier app
            // session, a lost save). Reset only returns it to pending; it never starts a run.
            const orphanedRun =
              item.status === 'running' && !!isOwnerBusy && !isOwnerBusy(item.ownerId || lead.id)
            const lastOutcome = teamTaskOutcome(item)
            const outcomeNote = orphanedRun
              ? runOutcomeLabel('interrupted')
              : item.status === 'pending' && lastOutcome
                ? runOutcomeLabel(lastOutcome)
                : ''
            const resetLabel = t('chat.team_task_reset', { defaultValue: 'Reset' })
            return (
              <Box key={item.id}>
                <Typography variant="caption">
                  {item.title} ·{' '}
                  {unconfirmedEntry?.kind === 'task' && unconfirmedEntry.id === item.id
                    ? t('chat.team_menu.unconfirmed_prefix')
                    : ''}
                  {item.ownerId
                    ? (members.find((member) => member.id === item.ownerId)?.teamMemberName ??
                      t('chat.team_menu.former_member'))
                    : t('chat.team_lead_row')}{' '}
                  · {t(taskStatusLabel[item.status])}
                  {outcomeNote ? ` · ${outcomeNote}` : ''} · {t('chat.team_menu.depends_on')}{' '}
                  {item.dependsOn
                    .map((id) => tasks.find((taskItem) => taskItem.id === id)?.title ?? id)
                    .join(', ') || t('chat.skill_none')}
                  {blockers.length > 0
                    ? ` · 等待 ${blockers.map((blocker) => blocker.title).join(', ')}`
                    : ''}
                </Typography>
                <Button
                  size="small"
                  aria-label={
                    useDispatchPositionPrefix
                      ? `当前列表第 ${taskIndex + 1} 项（位置随列表变化），执行：${item.title}`
                      : dispatchNames[taskIndex]
                  }
                  disabled={!canDispatch}
                  onClick={() => {
                    if (canDispatch) onDispatch?.(item.id)
                  }}
                >
                  {t('chat.team_menu.dispatch')}
                </Button>
                <Button
                  size="small"
                  aria-label={`当前列表第 ${taskIndex + 1} 项（位置随列表变化），${item.status === 'done' ? t('chat.team_menu.reopen') : t('chat.team_menu.done')}：${item.title}`}
                  aria-describedby={reopenBlockedBySuccessor ? reopenDescriptionId : undefined}
                  disabled={draftLocked || !canSetTeamTaskStatus(tasks, item.id, nextStatus)}
                  onClick={() =>
                    saveOther({ ...lead, teamTasks: setTeamTaskStatus(tasks, item.id, nextStatus) })
                  }
                >
                  {item.status === 'done' ? t('chat.team_menu.reopen') : t('chat.team_menu.done')}
                </Button>
                {orphanedRun && (
                  <Button
                    size="small"
                    aria-label={
                      useDispatchPositionPrefix ||
                      (titleCounts.get(normalizeAccessibleName(item.title)) ?? 0) > 1
                        ? `${resetLabel} (${taskIndex + 1}): ${item.title}`
                        : `${resetLabel}: ${item.title}`
                    }
                    disabled={draftLocked}
                    onClick={() => {
                      if (!isOwnerBusy?.(item.ownerId || lead.id))
                        saveOther({
                          ...lead,
                          teamTasks: setTeamTaskStatus(tasks, item.id, 'pending', 'interrupted')
                        })
                    }}
                  >
                    {resetLabel}
                  </Button>
                )}
                {reopenBlockedBySuccessor && (
                  <Typography id={reopenDescriptionId} variant="caption" component="span">
                    {t('chat.team_menu.reopen_blocked')}
                  </Typography>
                )}
                <details>
                  <summary
                    aria-label={
                      useDispatchPositionPrefix ||
                      (titleCounts.get(normalizeAccessibleName(item.title)) ?? 0) > 1
                        ? `当前列表第 ${taskIndex + 1} 项（位置随列表变化），编辑依赖 · ${item.title}`
                        : undefined
                    }
                  >
                    {t('chat.team_menu.edit_dependencies')} · {item.title}
                  </summary>
                  {tasks
                    .filter((candidate) => candidate.id !== item.id)
                    .map((candidate, candidateIndex) => {
                      const selectedDependency = item.dependsOn.includes(candidate.id)
                      const nextDependencies = selectedDependency
                        ? item.dependsOn.filter((id) => id !== candidate.id)
                        : [...item.dependsOn, candidate.id]
                      let updated: typeof tasks | undefined
                      try {
                        updated = setTeamTaskDependencies(tasks, item.id, nextDependencies)
                      } catch {
                        /* Invalid transitions remain disabled. */
                      }
                      const descriptionId = `${dependencyDescriptionId}-${taskIndex}-${candidateIndex}`
                      const candidatePosition = taskPositions.get(candidate.id)
                      const distinguish = useDependencyPositionPrefix
                      return (
                        <Box key={candidate.id}>
                          <FormControlLabel
                            label={`${item.title} 依赖 ${candidate.title}`}
                            control={
                              <Checkbox
                                checked={selectedDependency}
                                disabled={draftLocked || !updated}
                                inputProps={{
                                  ...(distinguish
                                    ? {
                                        'aria-label': `第 ${taskIndex + 1} 项任务依赖第 ${candidatePosition} 项（位置随列表变化）：${item.title} 依赖 ${candidate.title}`
                                      }
                                    : {}),
                                  ...(!updated ? { 'aria-describedby': descriptionId } : {})
                                }}
                                onChange={() => {
                                  if (updated) saveOther({ ...lead, teamTasks: updated })
                                }}
                              />
                            }
                          />
                          {!updated && (
                            <Typography id={descriptionId} variant="caption" component="span">
                              {t('chat.team_menu.dependency_not_selectable')}
                            </Typography>
                          )}
                        </Box>
                      )
                    })}
                </details>
              </Box>
            )
          })}
        <TextField
          size="small"
          label={t('chat.team_menu.task_label')}
          value={task}
          onChange={(event) => {
            if (!draftLocked) setTask(event.target.value)
          }}
          inputProps={{ maxLength: 256, readOnly: draftLocked }}
        />
        <TextField
          disabled={draftLocked}
          select
          size="small"
          label={t('chat.team_menu.owner_label')}
          value={invalidOwner ? invalidOwnerOption : owner}
          onChange={(event) => {
            setOwner(event.target.value)
            setOwnerNeedsReselection(false)
          }}
        >
          {invalidOwner && (
            <MenuItem value={invalidOwnerOption} disabled>
              {t('chat.team_menu.former_member_choose')}
            </MenuItem>
          )}
          <MenuItem value="">{t('chat.team_lead_row')}</MenuItem>
          {members.map((member) => (
            <MenuItem key={member.id} value={member.id}>
              {member.teamMemberName}
            </MenuItem>
          ))}
        </TextField>
        {validTasks && tasks.length > 0 && (
          <Box>
            <Typography variant="caption">{t('chat.team_menu.dependencies')}</Typography>
            {tasks.map((item, index) => (
              <FormControlLabel
                key={item.id}
                label={item.title}
                control={
                  <Checkbox
                    disabled={draftLocked}
                    checked={selected.includes(item.id)}
                    inputProps={
                      useDependencyPositionPrefix
                        ? {
                            'aria-label': `新任务的前置：当前列表第 ${index + 1} 项（位置随列表变化），${item.title}`
                          }
                        : undefined
                    }
                    onChange={(event) =>
                      setDependencies((previous) =>
                        event.target.checked
                          ? [...previous, item.id]
                          : previous.filter((id) => id !== item.id)
                      )
                    }
                  />
                }
              />
            ))}
          </Box>
        )}
        {draftUnconfirmed && (
          <Typography color="error" variant="caption">
            {t('chat.team_menu.save_unconfirmed')}
          </Typography>
        )}
        <Button
          disabled={
            draftLocked || !validTasks || invalidOwner || !task.trim() || tasks.length >= 128
          }
          onClick={() => {
            if (invalidOwner) return
            const entry = {
              id: crypto.randomUUID(),
              title: task.trim(),
              ownerId: owner,
              status: 'pending' as const,
              dependsOn: selected
            }
            const updated = [...tasks, entry]
            try {
              validateTeamTasks(updated)
              void submitDraft(
                { ...lead, teamTasks: updated },
                { kind: 'task', id: entry.id },
                () => {
                  setTask('')
                  setDependencies([])
                }
              )
            } catch {
              /* Invalid graph is not saved. */
            }
          }}
        >
          {t('chat.team_menu.add_task')}
        </Button>
        <Typography variant="subtitle2">{t('chat.team_menu.channel_messages')}</Typography>
        {!lead.teamChannel?.length && (
          <Typography variant="caption" component="div">
            {t('chat.team_menu.no_channel_records')}
          </Typography>
        )}
        {onSubscriptionChange && (
          <Box role="group" aria-labelledby={subscriptionGroupLabelId}>
            <Typography id={subscriptionGroupLabelId} variant="caption" component="div">
              {t('chat.team_menu.subscriptions')}
            </Typography>
            {members.map((member) => (
              <FormControlLabel
                key={member.id}
                label={member.teamMemberName || member.title}
                control={
                  <Checkbox
                    size="small"
                    disabled={draftLocked || Boolean(lead.teamEnded)}
                    checked={subscriptions?.includes(member.id) ?? false}
                    onChange={(event) => onSubscriptionChange(member.id, event.target.checked)}
                  />
                }
              />
            ))}
          </Box>
        )}
        <Typography variant="caption" component="div">
          {t('chat.team_menu.record_vs_broadcast')}
        </Typography>
        {durablePendingReceipts > 0 && (
          <Typography variant="caption" component="div">
            {t('chat.team_menu.pending_receipts', { count: durablePendingReceipts })}
          </Typography>
        )}
        {(lead.teamChannel?.length ?? 0) > 50 && (
          <Typography variant="caption" component="div">
            {t('chat.team_menu.latest_50')}
          </Typography>
        )}
        {(lead.teamChannel ?? []).slice(-50).map((item) => (
          <Typography
            key={item.id}
            variant="caption"
            component="div"
            color="text.secondary"
            sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          >
            {unconfirmedEntry?.kind === 'channel' && unconfirmedEntry.id === item.id
              ? t('chat.team_menu.unconfirmed_prefix')
              : ''}
            {item.senderId === 'user'
              ? t('chat.team_menu.sender_user')
              : (members.find((member) => member.id === item.senderId)?.teamMemberName ??
                t('chat.team_menu.former_member'))}{' '}
            · {item.text}
          </Typography>
        ))}
        <TextField
          size="small"
          label={t('chat.team_menu.channel_message_label')}
          value={message}
          onChange={(event) => {
            if (!draftLocked) setMessage(event.target.value)
          }}
          inputProps={{ maxLength: 2000, readOnly: draftLocked }}
        />
        {onBroadcast && (
          <>
            <Button
              aria-describedby={broadcastUnknown ? broadcastUnknownDescriptionId : undefined}
              disabled={
                draftLocked || broadcastUnknown || Boolean(lead.teamEnded) || !message.trim()
              }
              onClick={() => {
                if (
                  broadcastUnknownRef.current ||
                  broadcastPendingRef.current ||
                  draftPendingRef.current ||
                  otherPendingRef.current ||
                  unresolvedDraftRef.current
                )
                  return
                const text = message.trim(),
                  generation = draftGenerationRef.current
                const input = Object.freeze({ id: crypto.randomUUID(), text })
                broadcastPendingRef.current = true
                setBroadcastPending(true)
                setBroadcastNotice('')
                void Promise.resolve()
                  .then(() => {
                    if (draftGenerationRef.current !== generation)
                      throw Error('Broadcast context changed.')
                    return onBroadcast(input)
                  })
                  .then((result) => {
                    if (draftGenerationRef.current !== generation) return
                    const queued = result?.queued
                    if (Number.isSafeInteger(queued) && queued > 0) {
                      setMessage((current) => (current.trim() === text ? '' : current))
                      setBroadcastNotice(t('chat.team_menu.broadcast_queued'))
                    } else if (queued === 0)
                      setBroadcastNotice(t('chat.team_menu.broadcast_not_sent'))
                    else {
                      broadcastUnknownRef.current = true
                      setBroadcastUnknown(true)
                      setBroadcastNotice(t(broadcastUnknownNotice))
                    }
                  })
                  .catch(() => {
                    if (draftGenerationRef.current === generation) {
                      broadcastUnknownRef.current = true
                      setBroadcastUnknown(true)
                      setBroadcastNotice(t(broadcastUnknownNotice))
                    }
                  })
                  .finally(() => {
                    broadcastPendingRef.current = false
                    if (draftGenerationRef.current === generation) setBroadcastPending(false)
                  })
              }}
            >
              {t('chat.team_menu.broadcast')}
            </Button>
            {broadcastNotice && (
              <Typography component="div" variant="caption">
                {broadcastNotice}
              </Typography>
            )}
            {broadcastUnknown && (
              <>
                <Typography id={broadcastUnknownDescriptionId} component="div" variant="caption">
                  {t('chat.team_menu.broadcast_unknown_detail')}
                </Typography>
                <Button
                  size="small"
                  aria-describedby={broadcastUnknownDescriptionId}
                  onClick={() => {
                    broadcastUnknownRef.current = false
                    setBroadcastUnknown(false)
                    setBroadcastNotice('')
                  }}
                >
                  {t('chat.team_menu.broadcast_allow_again')}
                </Button>
              </>
            )}
          </>
        )}
        {(lead.teamChannel?.length ?? 0) >= 200 && (
          <Typography id={channelLimitDescriptionId} variant="caption" component="div">
            {t('chat.team_menu.channel_limit')}
          </Typography>
        )}
        <Button
          aria-describedby={
            (lead.teamChannel?.length ?? 0) >= 200 ? channelLimitDescriptionId : undefined
          }
          disabled={draftLocked || !message.trim()}
          onClick={() => {
            const entry = {
              id: crypto.randomUUID(),
              senderId: 'user',
              text: message.trim(),
              createdAt: Date.now()
            }
            void submitDraft(
              { ...lead, teamChannel: [...(lead.teamChannel ?? []).slice(-199), entry] },
              { kind: 'channel', id: entry.id },
              () => setMessage('')
            )
          }}
        >
          {t('chat.team_menu.add_to_channel')}
        </Button>
        <Typography variant="subtitle2">{t('chat.team_menu.settings')}</Typography>
        <Typography variant="caption" component="div">
          {t('chat.team_menu.member_total')} {members.length} · {t('chat.team_menu.limit')}{' '}
          {lead.teamSettings?.maxMembers === undefined
            ? 6
            : Number.isInteger(lead.teamSettings.maxMembers) &&
                lead.teamSettings.maxMembers >= 1 &&
                lead.teamSettings.maxMembers <= 6
              ? lead.teamSettings.maxMembers
              : t('chat.team_menu.settings_invalid')}
          {pendingOther || draftUnconfirmed ? t('chat.team_menu.pending_suffix') : ''}
        </Typography>
        <TextField
          type="number"
          disabled={draftLocked}
          size="small"
          label={t('chat.team_menu.max_members')}
          value={lead.teamSettings?.maxMembers ?? 6}
          inputProps={{ min: 1, max: 6 }}
          onChange={(event) => {
            const count = Number(event.target.value)
            if (Number.isInteger(count) && count >= 1 && count <= 6)
              saveOther({
                ...lead,
                teamSettings: {
                  ...lead.teamSettings,
                  maxMembers: count,
                  defaultModel: lead.teamSettings?.defaultModel ?? null,
                  autoCleanup: lead.teamSettings?.autoCleanup ?? false
                }
              })
          }}
        />
        <Typography variant="caption" component="div">
          {unavailableSelection
            ? t('chat.team_menu.member_model_unavailable')
            : t('chat.team_menu.member_model_inherits')}
        </Typography>
        {unavailableSelection ? (
          <TextField
            disabled
            size="small"
            label={t('chat.team_menu.member_default_model')}
            value={t('chat.team_menu.settings_unavailable')}
          />
        ) : (
          <TextField
            select
            disabled={draftLocked}
            size="small"
            label={t('chat.team_menu.member_default_model')}
            value={currentModel}
            onChange={(event) => {
              const selected = event.target.value
              if (
                selected &&
                (selected !== lead.profileId || !models.some((model) => model.id === selected))
              )
                return
              saveOther({
                ...lead,
                teamSettings: {
                  ...lead.teamSettings,
                  maxMembers: lead.teamSettings?.maxMembers ?? 6,
                  defaultModel: selected || null,
                  autoCleanup: lead.teamSettings?.autoCleanup ?? false
                }
              })
            }}
          >
            {missingModel && (
              <MenuItem value={currentModel} disabled>
                {t('chat.team_menu.model_unavailable')}
              </MenuItem>
            )}
            <MenuItem value="">{t('chat.member_model_inherit')}</MenuItem>
            {models.map((model) => (
              <MenuItem key={model.id} value={model.id} disabled={model.id !== lead.profileId}>
                {model.name}
              </MenuItem>
            ))}
          </TextField>
        )}
        <FormControlLabel
          label={t('chat.team_menu.archive_members_on_end')}
          control={
            <Checkbox
              disabled={draftLocked}
              checked={lead.teamSettings?.autoCleanup ?? false}
              onChange={(event) =>
                saveOther({
                  ...lead,
                  teamSettings: {
                    ...lead.teamSettings,
                    maxMembers: lead.teamSettings?.maxMembers ?? 6,
                    defaultModel: lead.teamSettings?.defaultModel ?? null,
                    autoCleanup: event.target.checked
                  }
                })
              }
            />
          }
        />
        {message && !lead.teamEnded && (
          <Typography id={endDraftDescriptionId} variant="caption" component="div">
            {t('chat.team_menu.end_copy_draft')}
          </Typography>
        )}
        <Button
          aria-describedby={message && !lead.teamEnded ? endDraftDescriptionId : undefined}
          disabled={draftLocked || Boolean(lead.teamEnded)}
          onClick={endTeam}
        >
          {lead.teamEnded ? t('chat.team_ended') : t('chat.team_menu.end_team')}
        </Button>
        <Typography variant="caption">{t('chat.team_menu.nesting_depth')}</Typography>
      </Box>
    </AgentColumnOverlay>
  )
}
