import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_GOAL_LIMITS, type AgentGoalView } from '@shared/api/agentThreadGoal'
import AgentThreadGoalRecordsPanel from './AgentThreadGoalRecordsPanel'

const getApi = vi.hoisted(() => vi.fn(() => { throw Error('Panel must not access IPC') }))
vi.mock('../../../utils/windowUtils', () => ({ api: getApi }))
const spec = { objective: 'Synthetic objective', successCriteria: [], constraints: [], autonomy: 'manual' as const, completionPolicy: 'user_confirm' as const, budgets: { maxTurns: 1, maxToolCalls: 1, maxWalltimeSeconds: 60 } }
const goal = (index: number) => ({ id: `synthetic-${index}`, title: `Synthetic ${index}`, status: 'draft' as const, generation: 1, spec, createdAt: 1, updatedAt: 1, reason: '' })
const view = (count: number): AgentGoalView => ({ revision: count, goals: Array.from({ length: count }, (_, i) => goal(i)), untrustedData: true, grantsPermission: false })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('goal capacity explanation', () => {
  it('explains why a full, successfully loaded view cannot create a draft and leaves text intact if capacity changes', () => {
    const onCreate = vi.fn(), onControl = vi.fn()
    const page = render(<AgentThreadGoalRecordsPanel view={view(AGENT_GOAL_LIMITS.goals - 1)} pending={false} error={null} onCreate={onCreate} onControl={onControl} />)
    fireEvent.change(screen.getByLabelText('Goal title'), { target: { value: 'Unsubmitted title' } })
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Unsubmitted objective' } })
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeEnabled()
    expect(screen.queryByText(/Goal limit reached/)).not.toBeInTheDocument()

    page.rerender(<AgentThreadGoalRecordsPanel view={view(AGENT_GOAL_LIMITS.goals)} pending={false} error={null} onCreate={onCreate} onControl={onControl} />)
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled()
    expect(screen.getByText(`Goal limit reached (${AGENT_GOAL_LIMITS.goals}). This interface cannot delete goals yet.`)).toBeVisible()
    expect(screen.getByLabelText('Goal title')).toHaveValue('Unsubmitted title')
    expect(screen.getByLabelText('Objective')).toHaveValue('Unsubmitted objective')
    fireEvent.submit(screen.getByLabelText('Goal title').closest('form')!)
    expect(onCreate).not.toHaveBeenCalled()

    page.rerender(<AgentThreadGoalRecordsPanel view={view(AGENT_GOAL_LIMITS.goals - 1)} pending={false} error={null} onCreate={onCreate} onControl={onControl} />)
    expect(screen.queryByText(/Goal limit reached/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeEnabled()
    expect(screen.getByLabelText('Goal title')).toHaveValue('Unsubmitted title')
    expect(onControl).not.toHaveBeenCalled()
    expect(getApi).not.toHaveBeenCalled()
  })
  it('does not attribute an unavailable view or pending request to capacity', () => {
    const onCreate = vi.fn(), onControl = vi.fn()
    const page = render(<AgentThreadGoalRecordsPanel view={null} pending={false} error="Unavailable" onCreate={onCreate} onControl={onControl} />)
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled()
    expect(screen.queryByText(/Goal limit reached/)).not.toBeInTheDocument()
    page.rerender(<AgentThreadGoalRecordsPanel view={view(0)} pending error={null} onCreate={onCreate} onControl={onControl} />)
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled()
    expect(screen.queryByText(/Goal limit reached/)).not.toBeInTheDocument()
    expect(onCreate).not.toHaveBeenCalled()
    expect(getApi).not.toHaveBeenCalled()
  })
})
