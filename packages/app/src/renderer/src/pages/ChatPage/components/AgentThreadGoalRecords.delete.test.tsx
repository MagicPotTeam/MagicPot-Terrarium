import React from 'react'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGoal, AgentGoalStatus, AgentGoalView } from '@shared/api/agentThreadGoal'

const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), list: vi.fn(), mutate: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { agentGoalScopeRevision: h.revision, setAgentGoalScope: h.bind, listAgentGoals: h.list, mutateAgentGoal: h.mutate } }) }))
import Host from './AgentThreadGoalRecordsHost'
import Panel from './AgentThreadGoalRecordsPanel'
import GoalEntry from './AgentThreadGoalEntry'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'synthetic-delete-project', threadId: 'synthetic-pane' } as const
const props = { route, active: true, remote: false }
const spec = { objective: 'Synthetic objective', successCriteria: [], constraints: [], autonomy: 'manual' as const, completionPolicy: 'user_confirm' as const, budgets: { maxTurns: 1, maxToolCalls: 1, maxWalltimeSeconds: 60 } }
const goal = (title: string, status: AgentGoalStatus = 'draft', id = `${title}-id`, generation = 1): AgentGoal => ({ id, title, status, generation, spec, createdAt: 1, updatedAt: 1, reason: '' })
const view = (revision: number, goals: AgentGoal[]): AgentGoalView => ({ revision, goals, untrustedData: true, grantsPermission: false })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const row = (label: string) => screen.getByRole('group', { name: label })
const button = (label: string, name: string) => within(row(label)).getByRole('button', { name })
const panel = (goalView: AgentGoalView, extra: Partial<React.ComponentProps<typeof Panel>> = {}) =>
  <Panel view={goalView} pending={false} error={null} onCreate={vi.fn()} onControl={vi.fn()} {...extra} />
let current: AgentGoalView
beforeEach(() => {
  current = view(9, [goal('Alpha', 'active', 'alpha-id', 2), goal('Beta'), goal('Gamma', 'paused', 'gamma-id', 3)])
  h.revision.mockReset().mockResolvedValue({ revision: 0 })
  h.bind.mockReset().mockResolvedValue({ documentToken: 'synthetic-token' })
  h.list.mockReset().mockImplementation(async () => structuredClone(current))
  h.mutate.mockReset()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error('Unexpected network')))
})
afterEach(async () => { cleanup(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); vi.unstubAllGlobals() })

describe('goal delete entry in the goal view (Panel)', () => {
  it('offers Delete only for draft, paused and ended goals, and nothing without onDelete', () => {
    const statuses = ['draft', 'active', 'waiting', 'blocked', 'paused', 'cancelled', 'completed', 'failed'] as const
    const page = render(panel(view(3, statuses.map(status => goal(status, status))), { onDelete: vi.fn() }))
    for (const status of statuses) {
      const shown = within(row(status)).queryByRole('button', { name: `Delete ${status}` })
      if (['draft', 'paused', 'cancelled', 'completed', 'failed'].includes(status)) expect(shown).toBeEnabled()
      else expect(shown).toBeNull()
    }
    page.rerender(panel(view(3, statuses.map(status => goal(status, status)))))
    expect(screen.queryAllByRole('button', { name: /^Delete / })).toHaveLength(0)
  })

  it('opens a confirmation in the row on the first click and sends nothing; Cancel and Escape restore the row', () => {
    const onDelete = vi.fn(), onControl = vi.fn()
    render(panel(view(4, [goal('Alpha'), goal('Beta', 'paused')]), { onDelete, onControl }))
    fireEvent.click(button('Beta', 'Delete Beta'))
    expect(within(row('Beta')).queryByRole('button', { name: 'Activate Beta' })).toBeNull()
    expect(button('Beta', 'Confirm delete Beta')).toBeEnabled()
    expect(button('Beta', 'Cancel')).toHaveFocus()
    expect(screen.getAllByRole('group')).toHaveLength(2)
    expect(button('Alpha', 'Delete Alpha')).toBeEnabled()

    fireEvent.click(button('Beta', 'Cancel'))
    expect(within(row('Beta')).queryByRole('button', { name: 'Confirm delete Beta' })).toBeNull()
    expect(button('Beta', 'Activate Beta')).toBeEnabled()
    expect(button('Beta', 'Delete Beta')).toHaveFocus()

    fireEvent.click(button('Beta', 'Delete Beta'))
    const escape = createEvent.keyDown(button('Beta', 'Confirm delete Beta'), { key: 'Escape' })
    fireEvent(button('Beta', 'Confirm delete Beta'), escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(within(row('Beta')).queryByRole('button', { name: 'Confirm delete Beta' })).toBeNull()
    expect(button('Beta', 'Delete Beta')).toHaveFocus()
    expect(onDelete).not.toHaveBeenCalled(); expect(onControl).not.toHaveBeenCalled()
  })

  it('sends the goal id, revision and generation the confirmation was opened at, once', () => {
    const onDelete = vi.fn()
    render(panel(view(4, [goal('Alpha'), goal('Beta', 'paused', 'beta-id', 5)]), { onDelete }))
    fireEvent.click(button('Beta', 'Delete Beta'))
    const confirm = button('Beta', 'Confirm delete Beta')
    fireEvent.click(confirm); fireEvent.click(confirm)
    expect(onDelete).toHaveBeenCalledExactlyOnceWith({ goalId: 'beta-id', revision: 4, generation: 5 })
  })

  it('works from the keyboard: Tab reaches Delete, Confirm and Cancel; Enter and Space press them', async () => {
    const onDelete = vi.fn(), user = userEvent.setup()
    render(panel(view(4, [goal('Beta', 'cancelled')]), { onDelete }))
    await user.tab()
    expect(button('Beta', 'Delete Beta')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(button('Beta', 'Cancel')).toHaveFocus()
    await user.keyboard(' ')
    expect(button('Beta', 'Delete Beta')).toHaveFocus()
    await user.keyboard(' ')
    await user.tab({ shift: true })
    expect(button('Beta', 'Confirm delete Beta')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onDelete).toHaveBeenCalledExactlyOnceWith({ goalId: 'Beta-id', revision: 4, generation: 1 })
    expect(document.activeElement).not.toBe(document.body)
  })

  it('keeps one confirmation and follows the goal id when an equal title leaves', () => {
    const onDelete = vi.fn(), first = goal('Same', 'draft', 'same-0001'), second = goal('Same', 'paused', 'same-0002', 3)
    const page = render(panel(view(7, [first, second]), { onDelete }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Same · same-0001' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Same · same-0002' }))
    expect(screen.queryByRole('button', { name: 'Confirm delete Same · same-0001' })).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Confirm delete / })).toHaveLength(1)
    // The first row leaves at the same revision: the confirmation stays with the second id, under its new label.
    page.rerender(panel(view(7, [second]), { onDelete }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Same' }))
    expect(onDelete).toHaveBeenCalledExactlyOnceWith({ goalId: 'same-0002', revision: 7, generation: 3 })
    // Opened on the second again, then a new revision removes the first: the confirmation closes.
    page.rerender(panel(view(7, [first, second]), { onDelete }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Same · same-0002' }))
    page.rerender(panel(view(8, [second]), { onDelete }))
    expect(screen.queryByRole('button', { name: /^Confirm delete / })).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete Same' })).toBeEnabled()
    // Opened on the first, which then leaves: the second goal takes its place and label but never its confirmation.
    page.rerender(panel(view(8, [first, second]), { onDelete }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Same · same-0001' }))
    page.rerender(panel(view(8, [second]), { onDelete }))
    expect(screen.queryByRole('button', { name: /^Confirm delete / })).toBeNull()
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('closes the confirmation when a request is pending or the goal or revision changes, and disables every button while pending', () => {
    const onDelete = vi.fn(), alpha = goal('Alpha'), beta = goal('Beta', 'paused', 'beta-id', 2)
    const page = render(panel(view(4, [alpha, beta]), { onDelete }))
    const open = () => fireEvent.click(button('Beta', 'Delete Beta'))
    const closed = () => expect(screen.queryByRole('button', { name: 'Confirm delete Beta' })).toBeNull()
    open(); page.rerender(panel(view(4, [alpha, beta]), { onDelete, pending: true })); closed()
    for (const name of ['Activate Alpha', 'Delete Alpha', 'Activate Beta', 'Delete Beta']) expect(screen.getByRole('button', { name })).toBeDisabled()
    page.rerender(panel(view(4, [alpha, beta]), { onDelete })); closed()
    for (const changed of [view(4, [alpha, { ...beta, generation: 3 }]), view(4, [alpha, { ...beta, status: 'cancelled' as const }]), view(5, [alpha, beta])]) {
      page.rerender(panel(view(4, [alpha, beta]), { onDelete })); open()
      expect(button('Beta', 'Confirm delete Beta')).toBeEnabled()
      page.rerender(panel(changed, { onDelete })); closed()
    }
    expect(onDelete).not.toHaveBeenCalled()
  })
})

describe('a double click on Delete never confirms', () => {
  afterEach(() => { vi.useRealTimers() })
  // Click 1 redraws the row before click 2, and Confirm is drawn where Delete was: the second click of a
  // double click lands on Confirm (always for an ended goal, on the left part of Delete for a draft).
  it.each(['completed', 'cancelled', 'failed', 'draft', 'paused'] as const)('opens the confirmation of a %s goal and deletes nothing', status => {
    const onDelete = vi.fn()
    render(panel(view(4, [goal('Beta', status, 'beta-id', 3)]), { onDelete }))
    const del = button('Beta', 'Delete Beta'), box = del.parentElement!
    fireEvent.click(del, { detail: 1 })
    const confirm = button('Beta', 'Confirm delete Beta')
    expect(box.firstElementChild).toBe(confirm)
    fireEvent.click(confirm, { detail: 2 }); fireEvent.dblClick(confirm, { detail: 2 }); fireEvent.click(confirm, { detail: 3 })
    expect(onDelete).not.toHaveBeenCalled()
    expect(button('Beta', 'Confirm delete Beta')).toBeEnabled()
    expect(button('Beta', 'Cancel')).toBeEnabled()
  })

  it('ignores a pointer click on Confirm within 400 ms of the opening click, then accepts a single click', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000)
    const onDelete = vi.fn()
    render(panel(view(4, [goal('Beta', 'completed', 'beta-id', 3)]), { onDelete }))
    fireEvent.click(button('Beta', 'Delete Beta'), { detail: 1 })
    // A fast second press that left the double-click area arrives as a new single click.
    vi.setSystemTime(1_000_150); fireEvent.click(button('Beta', 'Confirm delete Beta'), { detail: 1 })
    vi.setSystemTime(1_000_399); fireEvent.click(button('Beta', 'Confirm delete Beta'), { detail: 1 })
    expect(onDelete).not.toHaveBeenCalled()
    vi.setSystemTime(1_000_400); fireEvent.click(button('Beta', 'Confirm delete Beta'), { detail: 1 })
    expect(onDelete).toHaveBeenCalledExactlyOnceWith({ goalId: 'beta-id', revision: 4, generation: 3 })
  })

  it('ignores a slow double click whose second click comes after 400 ms (detail 2 within the system double-click time)', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000)
    const onDelete = vi.fn()
    render(panel(view(4, [goal('Beta', 'draft', 'beta-id', 1)]), { onDelete }))
    fireEvent.click(button('Beta', 'Delete Beta'), { detail: 1 })
    vi.setSystemTime(1_000_450); fireEvent.click(button('Beta', 'Confirm delete Beta'), { detail: 2 })
    expect(onDelete).not.toHaveBeenCalled()
    expect(button('Beta', 'Confirm delete Beta')).toBeEnabled()
  })

  it.each([['Enter', '{Enter}'], ['Space', ' ']])('still confirms with %s right after opening', async (_, key) => {
    const onDelete = vi.fn(), user = userEvent.setup()
    render(panel(view(4, [goal('Beta', 'failed', 'beta-id', 3)]), { onDelete }))
    await user.tab(); await user.keyboard('{Enter}')
    await user.tab({ shift: true })
    expect(button('Beta', 'Confirm delete Beta')).toHaveFocus()
    await user.keyboard(key)
    expect(onDelete).toHaveBeenCalledExactlyOnceWith({ goalId: 'beta-id', revision: 4, generation: 3 })
  })
})

describe('goal delete through the real Host and Panel, synthetic service', () => {
  const ready = () => screen.findByRole('button', { name: 'Delete Beta' })

  it('sends exactly one delete for the confirmed goal, removes only its row and keeps the focus in the view', async () => {
    const gate = deferred<unknown>(); h.mutate.mockReturnValue(gate.promise)
    render(<Host {...props} conversationId="delete-applied" />)
    try {
      fireEvent.click(await ready())
      expect(h.mutate).not.toHaveBeenCalled()
      const confirm = button('Beta', 'Confirm delete Beta')
      fireEvent.click(confirm); fireEvent.click(confirm)
      expect(h.mutate).toHaveBeenCalledTimes(1)
      const req = h.mutate.mock.calls[0][0]
      expect(req).toEqual({ route, conversationId: 'delete-applied', documentToken: 'synthetic-token', action: 'delete', goalId: 'Beta-id', expectedGeneration: 1, expectedRevision: 9, operationId: expect.any(String) })
      for (const name of ['Pause Alpha', 'Delete Beta', 'Activate Beta', 'Activate Gamma', 'Delete Gamma', 'Create draft']) expect(screen.getByRole('button', { name })).toBeDisabled()
      expect(document.activeElement).not.toBe(document.body)
      expect(screen.getByRole('region', { name: 'Thread goals' })).toContainElement(document.activeElement as HTMLElement)
      await act(async () => { gate.resolve({ ...view(10, [current.goals[0], current.goals[2]]), status: 'applied', operationId: req.operationId }); await gate.promise })
      await waitFor(() => expect(screen.queryByRole('group', { name: 'Beta' })).toBeNull())
      expect(row('Alpha')).toBeInTheDocument(); expect(row('Gamma')).toBeInTheDocument()
      expect(button('Gamma', 'Activate Gamma')).toHaveFocus()
      expect(h.mutate).toHaveBeenCalledTimes(1); expect(h.list).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled()
    } finally { gate.resolve({ status: 'synthetic-cleanup' }) }
  })

  it('sends nothing for a double click on Delete and one delete for a later single click on Confirm', async () => {
    h.mutate.mockImplementation(async req => ({ ...view(10, [current.goals[0], current.goals[2]]), status: 'applied', operationId: req.operationId }))
    render(<Host {...props} conversationId="delete-double-click" />)
    const del = await ready()
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(2_000_000)
    try {
      fireEvent.click(del, { detail: 1 }); fireEvent.click(button('Beta', 'Confirm delete Beta'), { detail: 2 })
      expect(h.mutate).not.toHaveBeenCalled()
      vi.setSystemTime(2_000_600); fireEvent.click(button('Beta', 'Confirm delete Beta'), { detail: 1 })
    } finally { vi.useRealTimers() }
    expect(h.mutate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'delete', goalId: 'Beta-id', expectedRevision: 9, expectedGeneration: 1 }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Beta' })).toBeNull())
  })

  it('gives a full view its Create button back after one delete and keeps every typed text', async () => {
    current = view(20, [goal('Active', 'active', 'active-id', 2), ...['Beta', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'].map(title => goal(title))])
    h.mutate.mockImplementation(async req => ({ ...view(21, current.goals.filter(item => item.id !== req.goalId)), status: 'applied', operationId: req.operationId }))
    render(<Host {...props} conversationId="delete-full" />)
    await ready()
    expect(screen.getByText('Goal limit reached (8).')).toBeVisible()
    expect(screen.queryByText(/cannot delete/)).toBeNull()
    fireEvent.change(screen.getByLabelText('Goal title'), { target: { value: 'Ninth title' } })
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Ninth objective' } })
    fireEvent.change(screen.getByLabelText('Progress for Active'), { target: { value: 'Unsaved progress' } })
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled()
    fireEvent.click(button('C3', 'Delete C3')); fireEvent.click(button('C3', 'Confirm delete C3'))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'C3' })).toBeNull())
    expect(screen.getAllByRole('group')).toHaveLength(7)
    expect(screen.queryByText('Goal limit reached (8).')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeEnabled()
    expect(screen.getByLabelText('Goal title')).toHaveValue('Ninth title')
    expect(screen.getByLabelText('Objective')).toHaveValue('Ninth objective')
    expect(screen.getByLabelText('Progress for Active')).toHaveValue('Unsaved progress')
    expect(h.mutate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'delete', goalId: 'C3-id', expectedRevision: 20, expectedGeneration: 1 }))
  })

  it.each(['revision', 'activated elsewhere'] as const)('sends nothing when the host snapshot changed (%s) after the confirmation opened', async mode => {
    const shared = view(9, [goal('Alpha'), goal('Beta')])
    h.list.mockImplementation(async () => shared)
    render(<Host {...props} conversationId={`delete-stale-${mode}`} />)
    fireEvent.click(await ready())
    if (mode === 'revision') shared.revision = 10
    else Object.assign(shared.goals[1], { status: 'active', generation: 2 })
    fireEvent.click(button('Beta', 'Confirm delete Beta'))
    expect(h.mutate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['retry-not-applied', 'rejection', 'wrong-operation'] as const)('refreshes once on %s, shows the refreshed list and requires review without sending again', async mode => {
    h.mutate.mockImplementation(async req => {
      // Another window changed the conversation first.
      current = view(10, [...current.goals, goal('Delta')])
      if (mode === 'rejection') throw Error('Synthetic failure')
      if (mode === 'wrong-operation') return { ...current, status: 'applied', operationId: `${req.operationId}-wrong` }
      return { status: 'retry-not-applied', priorOutcome: 'unknown', operationId: req.operationId, reason: 'revision-conflict', currentRevision: 10 }
    })
    render(<Host {...props} conversationId={`delete-${mode}`} />)
    fireEvent.click(await ready()); fireEvent.click(button('Beta', 'Confirm delete Beta'))
    const review = await screen.findByRole('button', { name: 'I reviewed the goals' })
    expect(screen.getByText(/Result unknown/)).toBeVisible()
    expect(row('Delta')).toBeInTheDocument(); expect(row('Beta')).toBeInTheDocument()
    expect(h.list).toHaveBeenCalledTimes(2); expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(button('Beta', 'Delete Beta')).toBeDisabled()
    fireEvent.click(review)
    expect(button('Beta', 'Delete Beta')).toBeEnabled()
    expect(h.mutate).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled()
  })

  it('does not send the delete again when its reply never arrives and the view is mounted again', async () => {
    const gate = deferred<unknown>(); h.mutate.mockReturnValue(gate.promise)
    const page = render(<Host {...props} conversationId="delete-remount" />)
    try {
      fireEvent.click(await ready()); fireEvent.click(button('Beta', 'Confirm delete Beta'))
      page.rerender(<Host {...props} active={false} conversationId="delete-remount" />)
      page.rerender(<Host {...props} conversationId="delete-remount" />)
      await waitFor(() => expect(h.bind.mock.calls.filter(([req]) => req.active)).toHaveLength(2))
      expect(h.list).toHaveBeenCalledTimes(1)
      current = view(10, [current.goals[0], current.goals[2]])
      await act(async () => { gate.resolve({ status: 'retry-not-applied', priorOutcome: 'unknown' }); await gate.promise })
      await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2))
      expect(await screen.findByText(/Result unknown/)).toBeVisible()
      await waitFor(() => expect(screen.queryByRole('group', { name: 'Beta' })).toBeNull())
      expect(screen.getByRole('button', { name: 'I reviewed the goals' })).toBeInTheDocument()
      expect(h.mutate).toHaveBeenCalledTimes(1)
    } finally { gate.resolve({ status: 'synthetic-cleanup' }) }
  })

  it('in the full-page view, Escape closes the confirmation and not the view', async () => {
    const onClose = vi.fn()
    render(<GoalEntry {...props} conversationId="delete-escape" open onClose={onClose} />)
    fireEvent.click(await ready())
    fireEvent.keyDown(button('Beta', 'Confirm delete Beta'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-goal-view')).toBeInTheDocument()
    expect(within(row('Beta')).queryByRole('button', { name: 'Confirm delete Beta' })).toBeNull()
    expect(button('Beta', 'Delete Beta')).toHaveFocus()
    fireEvent.keyDown(button('Beta', 'Delete Beta'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})
