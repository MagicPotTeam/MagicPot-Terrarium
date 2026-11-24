import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Box, Button, TextField, Typography } from '@mui/material'
import {
  AGENT_GOAL_LIMITS,
  type AgentGoal,
  type AgentGoalProposal,
  type AgentGoalSpec,
  type AgentGoalStatus,
  type AgentGoalView
} from '@shared/api/agentThreadGoal'
import { AgentThreadGoalSettingsFields } from './AgentThreadGoalSettingsFields'
import {
  defaultGoalSettings,
  goalSettingsBudgets,
  goalSettingsOf,
  type AgentThreadGoalSettings
} from './agentThreadGoalSettings'

export type AgentThreadGoalCreateIntent = { title: string; spec: AgentGoalSpec }
export type AgentThreadGoalReportIntent = { goalId: string; summary: string }
export type AgentThreadGoalReportAck = { sequence: number; goalId: string; summary: string }
export type AgentThreadGoalControlIntent = { goalId: string; status: 'active' | 'paused' }
/** A decision applies to exactly the proposal shown when the button was rendered. */
export type AgentThreadGoalDecisionIntent = {
  action: 'confirm' | 'reject-proposal'
  goalId: string
  revision: number
  generation: number
  proposal: AgentGoalProposal
}
/** A delete applies to exactly the goal, revision and generation its confirmation was opened at. */
export type AgentThreadGoalDeleteIntent = { goalId: string; revision: number; generation: number }
/** The user's own settings change (autonomy, completion policy, budgets) of exactly this generation. */
export type AgentThreadGoalSettingsIntent = {
  goalId: string
  generation: number
  title: string
  spec: AgentGoalSpec
}
/** The statuses MAIN deletes; an active, waiting or blocked goal is paused first. */
const deletable: readonly AgentGoalStatus[] = [
  'draft',
  'paused',
  'cancelled',
  'completed',
  'failed'
]
const enabledControl = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)'
/**
 * Confirm is drawn where Delete was, so a fast second click on Delete lands on it. A pointer click on
 * Confirm counts only after this delay from the click that opened the confirmation; it covers a double
 * click whose second press moved out of the platform's double-click area (detail 1, not 2).
 */
const confirmArmMs = 400
export type AgentThreadGoalRecordsPanelProps = {
  view: AgentGoalView | null
  pending: boolean
  error: string | null
  onCreate: (intent: AgentThreadGoalCreateIntent) => void
  onControl: (intent: AgentThreadGoalControlIntent) => void
  onReport?: (intent: AgentThreadGoalReportIntent) => void
  onDecision?: (intent: AgentThreadGoalDecisionIntent) => void
  /** Without it the view offers no delete. */
  onDelete?: (intent: AgentThreadGoalDeleteIntent) => void
  /** Without it the view offers no settings change. */
  onSettings?: (intent: AgentThreadGoalSettingsIntent) => void
  createResetVersion?: number
  reportAck?: AgentThreadGoalReportAck
  /**
   * Inside a command card of the Agent column: the card is the frame and names the view, so the
   * panel draws neither, and its fields and buttons sit in wrapping rows.
   */
  embedded?: boolean
}

/** Pure user-intent surface. Parent owns binding, authorization, mutation and errors. */
export default function AgentThreadGoalRecordsPanel({
  view,
  pending,
  error,
  onCreate,
  onControl,
  onReport,
  onDecision,
  onDelete,
  onSettings,
  createResetVersion = 0,
  reportAck,
  embedded = false
}: AgentThreadGoalRecordsPanelProps) {
  const { t } = useTranslation()
  const translate = (key: string, fallback: string, values: Record<string, string | number> = {}) => {
    const value = t(key, { ...values, defaultValue: fallback })
    const resolved = value === key ? fallback : value
    return resolved.replace(/{{(\w+)}}/g, (_, name: string) => String(values[name] ?? `{{${name}}}`))
  }
  const statusLabel = (status: string) => translate(`chat.agent_goal.status_${status}`, status)
  const [editing, setEditing] = useState<{
    goalId: string
    generation: number
    settings: AgentThreadGoalSettings
  } | null>(null)
  const settingsLine = (goal: AgentGoal) => {
    const autonomy = goal.spec.autonomy === 'continue_when_ready'
      ? translate('chat.agent_goal.autonomy_continue', 'Continue when ready')
      : translate('chat.agent_goal.autonomy_manual', 'Manual')
    const completion = translate(`chat.agent_goal.completion_${goal.spec.completionPolicy}`, {
      user_confirm: 'I confirm',
      self_propose: 'Agent completes it',
      verifier: 'Agent completes it with evidence'
    }[goal.spec.completionPolicy])
    return translate('chat.agent_goal.settings_line', `${autonomy} · completion: ${completion}`, { autonomy, completion })
  }
  const usageLine = (goal: AgentGoal) => {
    const usage = view?.drive?.[goal.id]
    if (!usage) return null
    const { maxTurns, maxToolCalls, maxWalltimeSeconds } = goal.spec.budgets
    const values = {
      turns: usage.turnsUsed, maxTurns, calls: usage.toolCallsUsed, maxCalls: maxToolCalls,
      minutes: Math.floor(usage.walltimeUsedSeconds / 60), maxMinutes: Math.round(maxWalltimeSeconds / 60)
    }
    return translate('chat.agent_goal.usage_line', `Turns ${values.turns}/${maxTurns} · tool calls ${values.calls}/${maxToolCalls} · time ${values.minutes}/${values.maxMinutes} min`, values)
  }
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const headingId = useId()
  const consumed = React.useRef(0)
  React.useEffect(() => {
    if (!reportAck || reportAck.sequence <= consumed.current) return
    consumed.current = reportAck.sequence
    setDrafts((current) =>
      current[reportAck.goalId] === reportAck.summary
        ? { ...current, [reportAck.goalId]: '' }
        : current
    )
  }, [reportAck])
  // At most one goal waits for its delete confirmation. It is keyed by the goal id and the revision,
  // generation and status it was opened at, never by label or position, and it ends when any of
  // them changes or a request is pending.
  const [confirming, setConfirming] = useState<{
    goalId: string
    revision: number
    generation: number
    status: AgentGoalStatus
    /** Time stamp of the event that opened it. */
    openedAt: number
  } | null>(null)
  const confirmed =
    confirming &&
    onDelete &&
    view &&
    !pending &&
    view.revision === confirming.revision &&
    view.goals.some(
      (goal) =>
        goal.id === confirming.goalId &&
        goal.generation === confirming.generation &&
        goal.status === confirming.status
    )
      ? confirming
      : null
  useEffect(() => {
    if (confirming && !confirmed) setConfirming(null)
  }, [confirming, confirmed])
  const sectionRef = useRef<HTMLElement>(null)
  const rows = useRef(new Map<string, HTMLElement>())
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>())
  const cancelButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<string | null>(null)
  useEffect(() => {
    if (confirmed) cancelButton.current?.focus()
  }, [confirmed])
  useEffect(() => {
    const goalId = returnFocus.current
    if (!goalId || confirming) return
    returnFocus.current = null
    deleteButtons.current.get(goalId)?.focus()
  }, [confirming])
  const cancelDelete = (goalId: string) => {
    returnFocus.current = goalId
    setConfirming(null)
  }
  // A confirmed delete disables the buttons and may remove the row: the focus stays in this view
  // while it is pending, then moves to a control next to where the goal was.
  const [deleting, setDeleting] = useState<{ goalId: string; index: number } | null>(null)
  useLayoutEffect(() => {
    const section = sectionRef.current
    if (!deleting || !section) return
    const active = document.activeElement
    const lost =
      !active ||
      active === document.body ||
      active === section ||
      !active.isConnected ||
      (section.contains(active) && active.matches(':disabled'))
    if (pending) {
      if (lost && active !== section) section.focus()
      return
    }
    setDeleting(null)
    if (!lost) return
    const goals = view?.goals ?? []
    const kept = goals.findIndex((goal) => goal.id === deleting.goalId)
    const own = kept >= 0 ? deleteButtons.current.get(deleting.goalId) : undefined
    const near = kept >= 0 ? goals[kept] : goals[Math.min(deleting.index, goals.length - 1)]
    const target =
      (own && !own.disabled ? own : null) ??
      (near ? rows.current.get(near.id)?.querySelector<HTMLElement>(enabledControl) : null) ??
      section.querySelector<HTMLElement>(enabledControl)
    target?.focus()
  }, [deleting, pending, view])
  const goalLabels = new Map<string, string>()
  const goals = view?.goals ?? []
  for (const goal of goals) {
    const sameTitle = goals.filter((candidate) => candidate.title === goal.title)
    let prefixLength = Math.min(8, goal.id.length)
    while (
      prefixLength < goal.id.length &&
      sameTitle.some(
        (candidate) =>
          candidate.id !== goal.id && candidate.id.startsWith(goal.id.slice(0, prefixLength))
      )
    )
      prefixLength++
    goalLabels.set(
      goal.id,
      sameTitle.length > 1 ? `${goal.title} · ${goal.id.slice(0, prefixLength)}` : goal.title
    )
  }
  // User-provided titles can equal a generated short label. If they do, use
  // full IDs for all rows; fixed-length unique UUIDs make those names unique.
  const labels = [...goalLabels.values()]
  const disambiguateAll = new Set(labels).size !== labels.length
  return (
    <Box
      component="section"
      ref={sectionRef}
      tabIndex={deleting ? -1 : undefined}
      aria-labelledby={embedded ? undefined : headingId}
      aria-label={embedded ? translate('chat.agent_goal.panel_title', 'Thread goals') : undefined}
      sx={
        embedded
          ? { minWidth: 0 }
          : { mx: 2, mb: 1, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2 }
      }
    >
      {embedded ? null : (
        <Typography id={headingId} variant="subtitle2">
          {translate('chat.agent_goal.panel_title', 'Thread goals')}
        </Typography>
      )}
      <Typography variant="caption" display={embedded ? 'block' : undefined}>
        {translate('chat.agent_goal.panel_notice', 'A manual goal is a record: activating it runs nothing. An active goal set to continue when ready runs one step at a time while this project is open, within its budgets; steps grant no permissions.')}
      </Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {!view && !error ? <Typography>{translate('chat.agent_goal.unavailable', 'Goals unavailable.')}</Typography> : null}
      {view && view.goals.length === 0 ? <Typography>{translate('chat.agent_goal.no_goals', 'No goals yet.')}</Typography> : null}
      {view?.goals.map((goal) => {
        const label = disambiguateAll
          ? `${goal.title} · ${goal.id}`
          : (goalLabels.get(goal.id) ?? goal.title)
        const goalId = goal.id,
          generation = goal.generation,
          revision = view.revision
        const proposal = goal.proposal && structuredClone(goal.proposal)
        const decisionAvailable = Boolean(
          onDecision && proposal && ['active', 'waiting', 'blocked', 'paused'].includes(goal.status)
        )
        const confirmingThis = confirmed?.goalId === goal.id ? confirmed : null
        return (
          <Box
            key={goal.id}
            ref={(node: HTMLElement | null) => {
              if (node) rows.current.set(goalId, node)
              else rows.current.delete(goalId)
            }}
            role="group"
            aria-label={label}
            sx={{ borderTop: '1px solid', borderColor: 'divider', mt: 1, pt: 1 }}
          >
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {label}
            </Typography>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {goal.spec.objective}
            </Typography>
            <Typography variant="caption">{translate('chat.agent_goal.status', `Status: ${goal.status}`, { status: statusLabel(goal.status) })}</Typography>
            <Typography variant="caption" display="block" data-testid="agent-goal-settings-line">
              {settingsLine(goal)}
            </Typography>
            {usageLine(goal) ? (
              <Typography variant="caption" display="block" data-testid="agent-goal-usage-line">
                {usageLine(goal)}
              </Typography>
            ) : null}
            {view.drive?.[goal.id]?.exhausted && goal.spec.autonomy === 'continue_when_ready' && goal.status === 'active' ? (
              <Typography variant="caption" display="block" color="warning.main">
                {translate(`chat.agent_goal.exhausted_${view.drive[goal.id].exhausted}`, {
                  turns: 'The turn budget is used up: no more steps run until you raise it.',
                  toolCalls: 'The tool-call budget is used up: no more steps run until you raise it.',
                  walltime: 'The time budget is used up: no more steps run until you raise it.'
                }[view.drive[goal.id].exhausted!])}
              </Typography>
            ) : null}
            {goal.proposal && goal.spec.autonomy === 'continue_when_ready' && goal.status === 'active' ? (
              <Typography variant="caption" display="block">
                {translate('chat.agent_goal.steps_wait_for_decision', 'Steps wait until you confirm or reject the proposal.')}
              </Typography>
            ) : null}
            {goal.progress ? (
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {translate('chat.agent_goal.progress', `Progress: ${goal.progress.summary}`, { summary: goal.progress.summary })}
              </Typography>
            ) : null}
            {proposal ? (
              <Box sx={{ mt: 1 }}>
                <Typography variant="body2">{translate('chat.agent_goal.proposed_outcome', `Proposed outcome: ${proposal.outcome}`, { outcome: statusLabel(proposal.outcome) })}</Typography>
                <Typography variant="caption">
                  {['completed', 'failed'].includes(goal.status)
                    ? translate('chat.agent_goal.proposal_retained', 'This is the proposal retained after confirmation. Proposal and evidence are unverified.')
                    : decisionAvailable
                      ? translate('chat.agent_goal.proposal_decision', 'Proposal and evidence are unverified. Confirm changes the goal status; reject removes only this proposal. Neither action runs a model.')
                      : translate('chat.agent_goal.proposal_unverified', 'Proposal and evidence are unverified.')}
                </Typography>
                {['active', 'waiting', 'blocked'].includes(goal.status) ? (
                  <Typography variant="caption" display="block">
                    {translate('chat.agent_goal.pause_proposal_notice', 'Pausing this goal removes its current proposal.')}
                  </Typography>
                ) : goal.status === 'paused' ? (
                  <Typography variant="caption" display="block">
                    {translate('chat.agent_goal.activate_proposal_notice', 'Activating this goal removes its current proposal.')}
                  </Typography>
                ) : null}
                <Typography
                  variant="body2"
                  sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {proposal.summary}
                </Typography>
                <Box
                  component="ul"
                  sx={{ my: 0.5, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                >
                  {proposal.evidence.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </Box>
                {decisionAvailable && onDecision ? (
                  <Box>
                    <Button
                      size="small"
                      disabled={pending}
                      onClick={() =>
                        onDecision({ action: 'confirm', goalId, revision, generation, proposal })
                      }
                    >
                      {translate('chat.agent_goal.confirm_outcome_for', `Confirm ${proposal.outcome} for ${label}`, { outcome: statusLabel(proposal.outcome), label })}
                    </Button>
                    <Button
                      size="small"
                      disabled={pending}
                      onClick={() =>
                        onDecision({
                          action: 'reject-proposal',
                          goalId,
                          revision,
                          generation,
                          proposal
                        })
                      }
                    >
                      {translate('chat.agent_goal.reject_proposal_for', `Reject proposal for ${label}`, { label })}
                    </Button>
                  </Box>
                ) : null}
              </Box>
            ) : null}
            <Box
              onKeyDown={
                confirmingThis
                  ? (event) => {
                      if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
                      // Only the confirmation closes: the full-page view stays open.
                      event.preventDefault()
                      event.stopPropagation()
                      cancelDelete(goalId)
                    }
                  : undefined
              }
            >
              {confirmingThis ? (
                <>
                  <Button
                    size="small"
                    disabled={pending}
                    onClick={(event) => {
                      // The second click of a double click (detail 2) or a pointer click right after
                      // the opening one does not confirm. Enter and Space give detail 0.
                      if (
                        event.detail > 1 ||
                        (event.detail > 0 &&
                          event.timeStamp - confirmingThis.openedAt < confirmArmMs)
                      )
                        return
                      const intent = {
                        goalId: confirmingThis.goalId,
                        revision: confirmingThis.revision,
                        generation: confirmingThis.generation
                      }
                      setConfirming(null)
                      setDeleting({
                        goalId: intent.goalId,
                        index: view.goals.findIndex((item) => item.id === intent.goalId)
                      })
                      onDelete?.(intent)
                    }}
                  >
                    {translate('chat.agent_goal.confirm_delete_for', `Confirm delete ${label}`, {
                      label
                    })}
                  </Button>
                  <Button
                    ref={cancelButton}
                    size="small"
                    disabled={pending}
                    onClick={() => cancelDelete(goalId)}
                  >
                    {translate('chat.cancel', 'Cancel')}
                  </Button>
                </>
              ) : (
                <>
                  {goal.status === 'draft' || goal.status === 'paused' ? (
                    <Button
                      size="small"
                      disabled={pending}
                      onClick={() => onControl({ goalId: goal.id, status: 'active' })}
                    >
                      {translate('chat.agent_goal.activate_for', `Activate ${label}`, { label })}
                    </Button>
                  ) : null}
                  {['active', 'waiting', 'blocked'].includes(goal.status) ? (
                    <Button
                      size="small"
                      disabled={pending}
                      onClick={() => onControl({ goalId: goal.id, status: 'paused' })}
                    >
                      {translate('chat.agent_goal.pause_for', `Pause ${label}`, { label })}
                    </Button>
                  ) : null}
                  {onSettings && !['cancelled', 'completed', 'failed'].includes(goal.status) && editing?.goalId !== goal.id ? (
                    <Button
                      size="small"
                      disabled={pending}
                      onClick={() => setEditing({ goalId, generation, settings: goalSettingsOf(goal.spec) })}
                    >
                      {translate('chat.agent_goal.settings_for', `Settings for ${label}`, { label })}
                    </Button>
                  ) : null}
                  {onDelete && deletable.includes(goal.status) ? (
                    <Button
                      ref={(node: HTMLButtonElement | null) => {
                        if (node) deleteButtons.current.set(goalId, node)
                        else deleteButtons.current.delete(goalId)
                      }}
                      size="small"
                      disabled={pending}
                      onClick={(event) =>
                        setConfirming({
                          goalId,
                          revision,
                          generation,
                          status: goal.status,
                          openedAt: event.timeStamp
                        })
                      }
                    >
                      {translate('chat.agent_goal.delete_for', `Delete ${label}`, { label })}
                    </Button>
                  ) : null}
                </>
              )}
            </Box>
            {onSettings && editing?.goalId === goal.id && editing.generation === goal.generation ? (
              <Box
                component="form"
                aria-label={translate('chat.agent_goal.settings_for', `Settings for ${label}`, { label })}
                onSubmit={(event) => {
                  event.preventDefault()
                  const budgets = goalSettingsBudgets(editing.settings)
                  if (pending || !budgets) return
                  onSettings({
                    goalId,
                    generation,
                    title: goal.title,
                    spec: { ...goal.spec, autonomy: editing.settings.autonomy, completionPolicy: editing.settings.completionPolicy, budgets }
                  })
                  setEditing(null)
                }}
                sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 1 }}
              >
                <AgentThreadGoalSettingsFields
                  idPrefix={`goal-settings-${goalId}`}
                  settings={editing.settings}
                  onChange={(settings) => setEditing({ ...editing, settings })}
                  disabled={pending}
                />
                <Box>
                  <Button type="submit" size="small" disabled={pending || !goalSettingsBudgets(editing.settings)}>
                    {translate('chat.agent_goal.save_settings_for', `Save settings for ${label}`, { label })}
                  </Button>
                  <Button size="small" disabled={pending} onClick={() => setEditing(null)}>
                    {translate('chat.cancel', 'Cancel')}
                  </Button>
                </Box>
              </Box>
            ) : null}
            {onReport && ['active', 'waiting', 'blocked'].includes(goal.status) ? (
              <Box
                component="form"
                onSubmit={(event) => {
                  event.preventDefault()
                  const summary = drafts[goal.id] ?? ''
                  if (!pending && validReportSummary(summary))
                    onReport({ goalId: goal.id, summary })
                }}
                sx={
                  embedded
                    ? {
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: '6px 8px',
                        mt: '6px',
                        // The note takes a line of its own; the field and its button share the next.
                        '& > .MuiTypography-caption': { flexBasis: '100%' },
                        '& .MuiTextField-root': { flex: '1 1 140px', minWidth: 0 }
                      }
                    : undefined
                }
              >
                <Typography variant="caption">
                  {translate('chat.agent_goal.report_notice', 'Saving replaces the current progress summary.')}
                </Typography>
                <TextField
                  label={translate('chat.agent_goal.progress_for', `Progress for ${label}`, { label })}
                  value={drafts[goal.id] ?? ''}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [goal.id]: event.target.value }))
                  }
                  disabled={pending}
                  multiline
                  size="small"
                  inputProps={{ maxLength: AGENT_GOAL_LIMITS.summary }}
                />
                <Button
                  type="submit"
                  disabled={pending || !validReportSummary(drafts[goal.id] ?? '')}
                >
                  {translate('chat.agent_goal.save_progress_for', `Save progress for ${label}`, { label })}
                </Button>
              </Box>
            ) : null}
          </Box>
        )
      })}
      <CreateGoalForm
        key={createResetVersion}
        view={view}
        pending={pending}
        onCreate={onCreate}
        embedded={embedded}
      />
    </Box>
  )
}

// UTF-16 length is intentionally conservative relative to AJV's Unicode code-point limit.
const validReportSummary = (summary: string): boolean =>
  Boolean(summary.trim()) && summary.length <= AGENT_GOAL_LIMITS.summary && !summary.includes('\0')

function CreateGoalForm({
  view,
  pending,
  onCreate,
  embedded = false
}: Pick<AgentThreadGoalRecordsPanelProps, 'view' | 'pending' | 'onCreate' | 'embedded'>) {
  const { t } = useTranslation()
  const translate = (key: string, fallback: string, values: Record<string, string | number> = {}) => {
    const value = t(key, { ...values, defaultValue: fallback })
    const resolved = value === key ? fallback : value
    return resolved.replace(/{{(\w+)}}/g, (_, name: string) => String(values[name] ?? `{{${name}}}`))
  }
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [settings, setSettings] = useState(defaultGoalSettings)
  const budgets = goalSettingsBudgets(settings)
  const canCreate = Boolean(
    view &&
    !pending &&
    budgets &&
    title.trim() &&
    objective.trim() &&
    title.length <= AGENT_GOAL_LIMITS.title &&
    objective.length <= AGENT_GOAL_LIMITS.objective &&
    view.goals.length < AGENT_GOAL_LIMITS.goals
  )
  return (
    <Box
      component="form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!canCreate) return
        onCreate({
          title: title.trim(),
          spec: {
            objective: objective.trim(),
            successCriteria: [],
            constraints: [],
            autonomy: settings.autonomy,
            completionPolicy: settings.completionPolicy,
            budgets: budgets!
          }
        })
      }}
      sx={
        embedded
          ? {
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'flex-start',
              gap: '8px',
              mt: '12px',
              '& .MuiTextField-root': { flex: '1 1 140px', minWidth: 0 }
            }
          : { display: 'flex', flexDirection: 'column', gap: 1, mt: 1 }
      }
    >
      <TextField
        label={translate('chat.agent_goal.goal_title_label', 'Goal title')}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        disabled={pending || !view}
        inputProps={{ maxLength: AGENT_GOAL_LIMITS.title }}
        size="small"
      />
      <TextField
        label={translate('chat.agent_goal.objective_label', 'Objective')}
        value={objective}
        onChange={(event) => setObjective(event.target.value)}
        disabled={pending || !view}
        inputProps={{ maxLength: AGENT_GOAL_LIMITS.objective }}
        multiline
        size="small"
      />
      <AgentThreadGoalSettingsFields
        idPrefix="goal-create"
        settings={settings}
        onChange={setSettings}
        disabled={pending || !view}
      />
      {view && view.goals.length >= AGENT_GOAL_LIMITS.goals ? (
        <Typography variant="caption">
          {translate('chat.agent_goal.goal_limit_reached', `Goal limit reached (${AGENT_GOAL_LIMITS.goals}).`, { count: AGENT_GOAL_LIMITS.goals })}
        </Typography>
      ) : null}
      <Button type="submit" disabled={!canCreate}>
        {translate('chat.agent_goal.create_draft', 'Create draft')}
      </Button>
    </Box>
  )
}
