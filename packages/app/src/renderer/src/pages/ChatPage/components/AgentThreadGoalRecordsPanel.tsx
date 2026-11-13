import React, { useId, useState } from 'react'
import { Alert, Box, Button, TextField, Typography } from '@mui/material'
import {
  AGENT_GOAL_LIMITS,
  type AgentGoalProposal,
  type AgentGoalSpec,
  type AgentGoalView
} from '@shared/api/agentThreadGoal'

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
export type AgentThreadGoalRecordsPanelProps = {
  view: AgentGoalView | null
  pending: boolean
  error: string | null
  onCreate: (intent: AgentThreadGoalCreateIntent) => void
  onControl: (intent: AgentThreadGoalControlIntent) => void
  onReport?: (intent: AgentThreadGoalReportIntent) => void
  onDecision?: (intent: AgentThreadGoalDecisionIntent) => void
  createResetVersion?: number
  reportAck?: AgentThreadGoalReportAck
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
  createResetVersion = 0,
  reportAck
}: AgentThreadGoalRecordsPanelProps) {
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
      aria-labelledby={headingId}
      sx={{ mx: 2, mb: 1, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}
    >
      <Typography id={headingId} variant="subtitle2">
        Thread goals
      </Typography>
      <Typography variant="caption">
        Manual records only. Activating a goal does not run a model or grant permissions.
      </Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {!view && !error ? <Typography>Goals unavailable.</Typography> : null}
      {view && view.goals.length === 0 ? <Typography>No goals yet.</Typography> : null}
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
        return (
          <Box
            key={goal.id}
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
            <Typography variant="caption">Status: {goal.status}</Typography>
            {goal.progress ? (
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                Progress: {goal.progress.summary}
              </Typography>
            ) : null}
            {proposal ? (
              <Box sx={{ mt: 1 }}>
                <Typography variant="body2">Proposed outcome: {proposal.outcome}</Typography>
                <Typography variant="caption">
                  {['completed', 'failed'].includes(goal.status)
                    ? 'This is the proposal retained after confirmation. Proposal and evidence are unverified.'
                    : decisionAvailable
                      ? 'Proposal and evidence are unverified. Confirm changes the goal status; reject removes only this proposal. Neither action runs a model.'
                      : 'Proposal and evidence are unverified.'}
                </Typography>
                {['active', 'waiting', 'blocked'].includes(goal.status) ? (
                  <Typography variant="caption" display="block">
                    Pausing this goal removes its current proposal.
                  </Typography>
                ) : goal.status === 'paused' ? (
                  <Typography variant="caption" display="block">
                    Activating this goal removes its current proposal.
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
                      Confirm {proposal.outcome} for {label}
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
                      Reject proposal for {label}
                    </Button>
                  </Box>
                ) : null}
              </Box>
            ) : null}
            <Box>
              {goal.status === 'draft' || goal.status === 'paused' ? (
                <Button
                  size="small"
                  disabled={pending}
                  onClick={() => onControl({ goalId: goal.id, status: 'active' })}
                >
                  Activate {label}
                </Button>
              ) : null}
              {['active', 'waiting', 'blocked'].includes(goal.status) ? (
                <Button
                  size="small"
                  disabled={pending}
                  onClick={() => onControl({ goalId: goal.id, status: 'paused' })}
                >
                  Pause {label}
                </Button>
              ) : null}
            </Box>
            {onReport && ['active', 'waiting', 'blocked'].includes(goal.status) ? (
              <Box
                component="form"
                onSubmit={(event) => {
                  event.preventDefault()
                  const summary = drafts[goal.id] ?? ''
                  if (!pending && validReportSummary(summary))
                    onReport({ goalId: goal.id, summary })
                }}
              >
                <Typography variant="caption">
                  Saving replaces the current progress summary.
                </Typography>
                <TextField
                  label={`Progress for ${label}`}
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
                  Save progress for {label}
                </Button>
              </Box>
            ) : null}
          </Box>
        )
      })}
      <CreateGoalForm key={createResetVersion} view={view} pending={pending} onCreate={onCreate} />
    </Box>
  )
}

// UTF-16 length is intentionally conservative relative to AJV's Unicode code-point limit.
const validReportSummary = (summary: string): boolean =>
  Boolean(summary.trim()) && summary.length <= AGENT_GOAL_LIMITS.summary && !summary.includes('\0')

function CreateGoalForm({
  view,
  pending,
  onCreate
}: Pick<AgentThreadGoalRecordsPanelProps, 'view' | 'pending' | 'onCreate'>) {
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const canCreate = Boolean(
    view &&
    !pending &&
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
            autonomy: 'manual',
            completionPolicy: 'user_confirm',
            budgets: { maxTurns: 10, maxToolCalls: 50, maxWalltimeSeconds: 3600 }
          }
        })
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 1 }}
    >
      <TextField
        label="Goal title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        disabled={pending || !view}
        inputProps={{ maxLength: AGENT_GOAL_LIMITS.title }}
        size="small"
      />
      <TextField
        label="Objective"
        value={objective}
        onChange={(event) => setObjective(event.target.value)}
        disabled={pending || !view}
        inputProps={{ maxLength: AGENT_GOAL_LIMITS.objective }}
        multiline
        size="small"
      />
      {view && view.goals.length >= AGENT_GOAL_LIMITS.goals ? (
        <Typography variant="caption">
          Goal limit reached ({AGENT_GOAL_LIMITS.goals}). This interface cannot delete goals yet.
        </Typography>
      ) : null}
      <Button type="submit" disabled={!canCreate}>
        Create draft
      </Button>
    </Box>
  )
}
