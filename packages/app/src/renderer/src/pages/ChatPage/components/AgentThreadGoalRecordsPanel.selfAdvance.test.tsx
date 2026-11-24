import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentGoal, AgentGoalView } from '@shared/api/agentThreadGoal'
import AgentThreadGoalRecordsPanel from './AgentThreadGoalRecordsPanel'

/** S5: the user's own autonomy, completion policy and budgets, and the budget use of each goal. */
const getApi = vi.hoisted(() =>
  vi.fn(() => {
    throw Error('Panel must not access IPC')
  })
)
vi.mock('../../../utils/windowUtils', () => ({ api: getApi }))
const goal = (patch: Partial<AgentGoal> = {}): AgentGoal => ({
  id: 'g1',
  title: 'Tidy',
  status: 'active',
  generation: 3,
  spec: {
    objective: 'Tidy the notes',
    successCriteria: [],
    constraints: [],
    autonomy: 'continue_when_ready',
    completionPolicy: 'user_confirm',
    budgets: { maxTurns: 10, maxToolCalls: 50, maxWalltimeSeconds: 3600 }
  },
  createdAt: 1,
  updatedAt: 1,
  reason: '',
  ...patch
})
const view = (goals: AgentGoal[], drive?: AgentGoalView['drive']): AgentGoalView => ({
  revision: 4,
  goals,
  untrustedData: true,
  grantsPermission: false,
  ...(drive ? { drive } : {})
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('self-advancing goal settings in the panel', () => {
  it("creates a continue_when_ready goal with the user's budgets; max turns pre-filled 10 and required", () => {
    const onCreate = vi.fn()
    render(
      <AgentThreadGoalRecordsPanel
        view={view([])}
        pending={false}
        error={null}
        onCreate={onCreate}
        onControl={vi.fn()}
      />
    )
    const form = screen.getByRole('button', { name: 'Create draft' }).closest('form')!
    fireEvent.change(within(form).getAllByRole('textbox')[0], { target: { value: 'Tidy' } })
    fireEvent.change(within(form).getAllByRole('textbox')[1], {
      target: { value: 'Tidy the notes' }
    })
    fireEvent.change(within(form).getByRole('combobox', { name: 'Autonomy' }), {
      target: { value: 'continue_when_ready' }
    })
    fireEvent.change(within(form).getByRole('combobox', { name: 'Completion' }), {
      target: { value: 'verifier' }
    })
    const maxTurns = within(form).getByRole('textbox', { name: 'Max turns' })
    expect(maxTurns).toHaveValue('10')
    // No max turns: nothing is created.
    fireEvent.change(maxTurns, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled()
    fireEvent.change(maxTurns, { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
    expect(onCreate).toHaveBeenCalledWith({
      title: 'Tidy',
      spec: expect.objectContaining({
        autonomy: 'continue_when_ready',
        completionPolicy: 'verifier',
        budgets: { maxTurns: 4, maxToolCalls: 50, maxWalltimeSeconds: 3600 }
      })
    })
  })

  it('shows the settings, the budget use and which budget ran out', () => {
    render(
      <AgentThreadGoalRecordsPanel
        view={view([goal()], {
          g1: {
            turnsUsed: 10,
            toolCallsUsed: 12,
            walltimeUsedSeconds: 125,
            exhausted: 'turns',
            stepPending: false,
            failures: 0
          }
        })}
        pending={false}
        error={null}
        onCreate={vi.fn()}
        onControl={vi.fn()}
      />
    )
    expect(screen.getByTestId('agent-goal-settings-line')).toHaveTextContent(
      'Continue when ready · completion: I confirm'
    )
    expect(screen.getByTestId('agent-goal-usage-line')).toHaveTextContent(
      'Turns 10/10 · tool calls 12/50 · time 2/60 min'
    )
    expect(
      screen.getByText('The turn budget is used up: no more steps run until you raise it.')
    ).toBeInTheDocument()
  })

  it('says steps wait while a proposal waits for the user', () => {
    render(
      <AgentThreadGoalRecordsPanel
        view={view([
          goal({
            proposal: { outcome: 'completed', summary: 'Done', evidence: ['x'], proposedAt: 1 }
          })
        ])}
        pending={false}
        error={null}
        onCreate={vi.fn()}
        onControl={vi.fn()}
      />
    )
    expect(
      screen.getByText('Steps wait until you confirm or reject the proposal.')
    ).toBeInTheDocument()
  })

  it('the user raises a budget for exactly the generation the editor opened at', () => {
    const onSettings = vi.fn()
    render(
      <AgentThreadGoalRecordsPanel
        view={view([goal()])}
        pending={false}
        error={null}
        onCreate={vi.fn()}
        onControl={vi.fn()}
        onSettings={onSettings}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Settings for Tidy' }))
    const editor = screen.getByRole('form', { name: 'Settings for Tidy' })
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Max turns' }), {
      target: { value: '20' }
    })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save settings for Tidy' }))
    expect(onSettings).toHaveBeenCalledWith({
      goalId: 'g1',
      generation: 3,
      title: 'Tidy',
      spec: expect.objectContaining({
        objective: 'Tidy the notes',
        budgets: { maxTurns: 20, maxToolCalls: 50, maxWalltimeSeconds: 3600 }
      })
    })
    expect(screen.queryByRole('form', { name: 'Settings for Tidy' })).toBeNull()
  })

  it('offers no settings for a finished goal', () => {
    render(
      <AgentThreadGoalRecordsPanel
        view={view([goal({ status: 'completed' })])}
        pending={false}
        error={null}
        onCreate={vi.fn()}
        onControl={vi.fn()}
        onSettings={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Settings for Tidy' })).toBeNull()
  })
})
