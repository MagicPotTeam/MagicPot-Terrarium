import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentGoal, AgentGoalView } from '@shared/api/agentThreadGoal'
import AgentThreadGoalRecordsPanel from './AgentThreadGoalRecordsPanel'

const getApi = vi.hoisted(() =>
  vi.fn(() => {
    throw Error('Panel must not access IPC')
  })
)
vi.mock('../../../utils/windowUtils', () => ({ api: getApi }))
const spec = {
  objective: 'Objective',
  successCriteria: [],
  constraints: [],
  autonomy: 'manual',
  completionPolicy: 'user_confirm',
  budgets: { maxTurns: 10, maxToolCalls: 50, maxWalltimeSeconds: 3600 }
} as const
const goal = (id: string, status: AgentGoal['status']): AgentGoal => ({
  id,
  title: id,
  status,
  generation: 1,
  spec: { ...spec, successCriteria: [], constraints: [] },
  createdAt: 1,
  updatedAt: 1,
  reason: ''
})
const view = (goals: AgentGoal[] = []): AgentGoalView => ({
  revision: 0,
  goals,
  untrustedData: true,
  grantsPermission: false
})
const callbacks = () => ({ onCreate: vi.fn(), onControl: vi.fn() })
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
describe('thread goal records pure panel', () => {
  it('associates the panel with its visible title for assistive navigation', () => {
    const cb = callbacks()
    render(<AgentThreadGoalRecordsPanel view={view()} pending={false} error={null} {...cb} />)
    const heading = screen.getByText('Thread goals')
    const panel = heading.closest('section')
    expect(panel).not.toBeNull()
    expect(heading.id).toBeTruthy()
    expect(panel).toHaveAttribute('aria-labelledby', heading.id)
    expect(panel).not.toHaveAttribute('aria-label')
  })

  it('renders empty and unavailable/error states without calling IPC', () => {
    const cb = callbacks(),
      page = render(
        <AgentThreadGoalRecordsPanel view={view()} pending={false} error={null} {...cb} />
      )
    expect(screen.getByText('No goals yet.')).toBeInTheDocument()
    expect(screen.getByText(/does not run a model or grant permissions/)).toBeInTheDocument()
    page.rerender(
      <AgentThreadGoalRecordsPanel view={null} pending={false} error="Unavailable" {...cb} />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Unavailable')
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled()
    page.rerender(<AgentThreadGoalRecordsPanel view={null} pending={false} error={null} {...cb} />)
    expect(screen.getByText('Goals unavailable.')).toBeInTheDocument()
    expect(getApi).not.toHaveBeenCalled()
  })
  it('emits trimmed manual create intent only for nonempty input', () => {
    const cb = callbacks()
    render(<AgentThreadGoalRecordsPanel view={view()} pending={false} error={null} {...cb} />)
    const button = screen.getByRole('button', { name: 'Create draft' })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Goal title'), { target: { value: '  title  ' } })
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: '  objective  ' } })
    fireEvent.click(button)
    expect(cb.onCreate).toHaveBeenCalledOnce()
    expect(cb.onCreate).toHaveBeenCalledWith({
      title: 'title',
      spec: { ...spec, objective: 'objective' }
    })
    expect(cb.onControl).not.toHaveBeenCalled()
  })
  it('distinguishes duplicate goal titles while keeping actions and drafts attached to their own IDs', () => {
    const first: AgentGoal = {
      ...goal('aaaaaaaa-0000-4000-8000-000000000001', 'active'),
      title: 'Shared',
      spec: { ...spec, objective: 'First objective', successCriteria: [], constraints: [] }
    }
    const second: AgentGoal = {
      ...goal('bbbbbbbb-0000-4000-8000-000000000002', 'active'),
      title: 'Shared',
      spec: { ...spec, objective: 'Second objective', successCriteria: [], constraints: [] }
    }
    const solo = { ...goal('solo', 'active'), title: 'Solo' }
    const cb = { ...callbacks(), onReport: vi.fn() }
    const page = render(
      <AgentThreadGoalRecordsPanel
        view={view([first, second, solo])}
        pending={false}
        error={null}
        {...cb}
      />
    )
    const firstRow = screen.getByRole('group', { name: 'Shared · aaaaaaaa' })
    const secondRow = screen.getByRole('group', { name: 'Shared · bbbbbbbb' })
    expect(firstRow).toHaveTextContent('First objective')
    expect(secondRow).toHaveTextContent('Second objective')
    expect(within(firstRow).getByText('Shared · aaaaaaaa')).toBeVisible()
    expect(within(secondRow).getByText('Shared · bbbbbbbb')).toBeVisible()
    const firstInput = screen.getByLabelText('Progress for Shared · aaaaaaaa')
    const secondInput = screen.getByLabelText('Progress for Shared · bbbbbbbb')
    fireEvent.change(firstInput, { target: { value: 'draft one' } })
    fireEvent.change(secondInput, { target: { value: 'draft two' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pause Shared · bbbbbbbb' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save progress for Shared · aaaaaaaa' }))
    expect(cb.onControl).toHaveBeenCalledExactlyOnceWith({ goalId: second.id, status: 'paused' })
    expect(cb.onReport).toHaveBeenCalledExactlyOnceWith({ goalId: first.id, summary: 'draft one' })
    page.rerender(
      <AgentThreadGoalRecordsPanel
        view={view([second, first, solo])}
        pending={false}
        error={null}
        {...cb}
      />
    )
    expect(screen.getByLabelText('Progress for Shared · bbbbbbbb')).toHaveValue('draft two')
    expect(screen.getByLabelText('Progress for Shared · aaaaaaaa')).toHaveValue('draft one')
    expect(screen.getByRole('button', { name: 'Pause Solo' })).toBeVisible()
    expect(screen.getByLabelText('Progress for Solo')).toHaveValue('')
    expect(getApi).not.toHaveBeenCalled()
  })
  it('extends same-title ID prefixes when the first eight characters collide', () => {
    const first = { ...goal('aaaaaaaa-1111-4000-8000-000000000001', 'draft'), title: 'Shared' }
    const second = { ...goal('aaaaaaaa-1111-4000-8000-000000000002', 'draft'), title: 'Shared' }
    const cb = callbacks()
    render(
      <AgentThreadGoalRecordsPanel
        view={view([first, second])}
        pending={false}
        error={null}
        {...cb}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: `Activate Shared · ${first.id}` }))
    fireEvent.click(screen.getByRole('button', { name: `Activate Shared · ${second.id}` }))
    expect(cb.onControl.mock.calls).toEqual([
      [{ goalId: first.id, status: 'active' }],
      [{ goalId: second.id, status: 'active' }]
    ])
    expect(getApi).not.toHaveBeenCalled()
  })
  it('avoids a generated duplicate-title label colliding with another goal title', () => {
    const first = { ...goal('aaaaaaaa-0000-4000-8000-000000000001', 'draft'), title: 'Shared' }
    const second = { ...goal('bbbbbbbb-0000-4000-8000-000000000002', 'draft'), title: 'Shared' }
    const third = {
      ...goal('cccccccc-0000-4000-8000-000000000003', 'draft'),
      title: 'Shared · aaaaaaaa'
    }
    const cb = callbacks()
    render(
      <AgentThreadGoalRecordsPanel
        view={view([first, second, third])}
        pending={false}
        error={null}
        {...cb}
      />
    )
    for (const entry of [first, second, third]) {
      const label = `${entry.title} · ${entry.id}`
      expect(screen.getByRole('group', { name: label })).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: `Activate ${label}` }))
    }
    expect(cb.onControl.mock.calls).toEqual(
      [first, second, third].map((entry) => [{ goalId: entry.id, status: 'active' }])
    )
    expect(getApi).not.toHaveBeenCalled()
  })
  it('emits only valid control intents and disables all actions while pending', () => {
    const cb = callbacks(),
      data = view([
        goal('draft', 'draft'),
        goal('active', 'active'),
        goal('paused', 'paused'),
        goal('done', 'completed')
      ])
    const page = render(
      <AgentThreadGoalRecordsPanel view={data} pending={false} error={null} {...cb} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Activate draft' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause active' }))
    fireEvent.click(screen.getByRole('button', { name: 'Activate paused' }))
    expect(cb.onControl.mock.calls).toEqual([
      [{ goalId: 'draft', status: 'active' }],
      [{ goalId: 'active', status: 'paused' }],
      [{ goalId: 'paused', status: 'active' }]
    ])
    expect(screen.queryByRole('button', { name: /done/ })).toBeNull()
    page.rerender(<AgentThreadGoalRecordsPanel view={data} pending error={null} {...cb} />)
    expect(screen.getByRole('button', { name: 'Activate draft' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pause active' })).toBeDisabled()
    expect(screen.getByLabelText('Goal title')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled()
  })
})
