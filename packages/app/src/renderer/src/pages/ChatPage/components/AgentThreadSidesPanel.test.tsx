import React, { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sideSnapshot } from '../sideSnapshot'
import AgentThreadSidesPanel from './AgentThreadSidesPanel'
import type { AgentSideSummary } from '@shared/api/agentThreadSide'
import type { AgentSideCommandHandle } from '../agentSideCommand'
const mocks = vi.hoisted(() => ({ listAgentSides: vi.fn(), openAgentSide: vi.fn(), startAgentSide: vi.fn(), continueAgentSide: vi.fn(), stopAgentSide: vi.fn(), deleteAgentSide: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: mocks }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' } as const
const branch: AgentSideSummary = { id: '11111111-1111-4111-8111-111111111111', revision: 3, generation: 1, status: 'completed', title: 'Private branch', createdAt: 1, updatedAt: 2, turns: 1, modelSteps: 1, toolCalls: 0, snapshotTruncated: true, profileId: 'profile', modelLabel: 'Model', canContinue: true, busy: false }
const detail = { branch, messages: [{ role: 'user', kind: 'question', content: 'SIDE_QUESTION' }, { role: 'assistant', kind: 'answer', content: '<script>ADVISORY</script>' }], snapshotCharacters: 12, untrustedData: true }
const messages = [{ role: 'user' as const, content: 'PARENT_VISIBLE', hiddenContext: 'HIDDEN_SECRET', attachments: [{ type: 'file' as const, url: 'SECRET_FILE' }] }]
const commandRef = createRef<AgentSideCommandHandle>()
const renderPanel = () => render(<AgentThreadSidesPanel ref={commandRef} route={route} conversationId="chat" active profileId="profile" getMessages={() => messages} />)
/** Stands in for AgentWorkspace's open thread list: the host the sub-rows render into. */
function WithThreadList({ onOpenSubRowChange }: { onOpenSubRowChange?(title: string | null): void }) {
  const [host, setHost] = React.useState<HTMLElement | null>(null)
  return <><div data-testid="thread-sub-rows" ref={setHost} /><AgentThreadSidesPanel ref={commandRef} route={route} conversationId="chat" active profileId="profile" getMessages={() => messages} subRowsHost={host} onOpenSubRowChange={onOpenSubRowChange} /></>
}
beforeEach(() => { vi.useFakeTimers(); Object.values(mocks).forEach((m) => m.mockReset()); mocks.listAgentSides.mockResolvedValue({ branches: [] }); mocks.openAgentSide.mockResolvedValue(detail); mocks.startAgentSide.mockResolvedValue({ branch }); mocks.continueAgentSide.mockResolvedValue({ branch }); mocks.stopAgentSide.mockResolvedValue({ branch }); mocks.deleteAgentSide.mockResolvedValue(undefined) })
afterEach(() => { cleanup(); vi.useRealTimers() })
/** A bare "/btw" opens the new-side form; there is no "+" button. */
async function openPanel() { await act(async () => { commandRef.current!.execute({ action: 'help' }) }) }
describe('user-only private side panel', () => {
  it('renders nothing of its own while the main conversation shows, and no rows without a thread list host', async () => {
    mocks.listAgentSides.mockResolvedValue({ branches: [branch] })
    const view = renderPanel()
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(view.container.querySelectorAll('button')).toHaveLength(0)
    expect(view.container).toHaveTextContent('')
    expect(mocks.listAgentSides).not.toHaveBeenCalled()
  })
  it('lists the main conversation and each side as thread sub-rows, switches on click and reports the open side', async () => {
    mocks.listAgentSides.mockResolvedValue({ branches: [branch, { ...branch, id: '22222222-2222-4222-8222-222222222222', title: 'Second side' }] })
    const onOpenSubRowChange = vi.fn()
    render(<WithThreadList onOpenSubRowChange={onOpenSubRowChange} />)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const rows = within(screen.getByTestId('thread-sub-rows'))
    expect(rows.getAllByRole('button').map(row => row.textContent)).toEqual(['chat.agent_side.main', 'Private branch', 'Second side'])
    const [main, first] = rows.getAllByRole('button')
    expect(main).toHaveAttribute('aria-current', 'true')
    expect(first).not.toHaveAttribute('aria-current')
    expect(getComputedStyle(first).paddingLeft).toBe('29px')
    // No "+" row and no per-row buttons: "/btw" creates sides.
    expect(screen.queryByRole('button', { name: 'chat.agent_side.new' })).not.toBeInTheDocument()
    expect(onOpenSubRowChange).toHaveBeenLastCalledWith(null)

    await act(async () => fireEvent.click(first))
    expect(mocks.openAgentSide).toHaveBeenCalledWith({ route, conversationId: 'chat', branchId: branch.id })
    expect(first).toHaveAttribute('aria-current', 'true')
    expect(main).not.toHaveAttribute('aria-current')
    expect(onOpenSubRowChange).toHaveBeenLastCalledWith('Private branch')
    expect(screen.getByRole('region', { name: 'chat.agent_side.title' })).toBeVisible()

    fireEvent.click(main)
    expect(main).toHaveAttribute('aria-current', 'true')
    expect(onOpenSubRowChange).toHaveBeenLastCalledWith(null)
    expect(screen.queryByRole('region', { name: 'chat.agent_side.title' })).not.toBeInTheDocument()
    expect(mocks.startAgentSide).not.toHaveBeenCalled()
  })
  it('shows no sub-rows for a conversation without side conversations', async () => {
    render(<WithThreadList />)
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(mocks.listAgentSides).toHaveBeenCalled()
    expect(screen.getByTestId('thread-sub-rows')).toBeEmptyDOMElement()
    await openPanel()
    expect(screen.getByLabelText('chat.agent_side.question')).toBeVisible()
    expect(screen.getByTestId('thread-sub-rows')).toBeEmptyDOMElement()
  })
  it('does not load or call providers before user opens; starts with passive bounded visible snapshot only', async () => {
    renderPanel(); expect(mocks.listAgentSides).not.toHaveBeenCalled(); await openPanel()
    fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'SIDE_QUESTION' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' })))
    expect(mocks.startAgentSide).toHaveBeenCalledOnce()
    const req = mocks.startAgentSide.mock.calls[0][0]
    expect(req).toMatchObject({ route, conversationId: 'chat', profileId: 'profile', snapshot: [{ role: 'user', content: 'PARENT_VISIBLE' }], question: 'SIDE_QUESTION' })
    expect(JSON.stringify(req)).not.toMatch(/HIDDEN_SECRET|SECRET_FILE/)
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(screen.getByText('<script>ADVISORY</script>')).toBeTruthy(); expect(document.querySelector('script')).toBeNull()
    fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'FOLLOW_UP' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.continue' })))
    expect(mocks.continueAgentSide).toHaveBeenCalledWith(expect.objectContaining({ branchId: branch.id, expectedRevision: 3, question: 'FOLLOW_UP' }))
    expect(mocks.continueAgentSide.mock.calls[0][0]).not.toHaveProperty('snapshot')
  })
  it('does not display model-step or tool-send counters in the side conversation', async () => {
    mocks.openAgentSide.mockResolvedValue({ ...detail, branch: { ...branch, modelSteps: 13, toolCalls: 17 } })
    renderPanel(); await openPanel()
    fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'question' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' })))
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(screen.getByText(/Model · chat.agent_side.status_completed/)).toBeVisible()
    expect(screen.queryByText(/13\/64|17\/96/)).not.toBeInTheDocument()
  })
  it('retains operation identity on unchanged retry and does not stop when closing panel', async () => {
    mocks.startAgentSide.mockRejectedValueOnce(new Error('IPC uncertain'))
    renderPanel(); await openPanel(); fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'question' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' })))
    const first = mocks.startAgentSide.mock.calls[0][0]
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' })))
    expect(mocks.startAgentSide.mock.calls[1][0]).toEqual(first)
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.close' })); expect(mocks.stopAgentSide).not.toHaveBeenCalled()
  })
  it('does not display an old reply after the owner conversation switches', async () => {
    let finish!: (v: unknown) => void
    mocks.startAgentSide.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const view = renderPanel(); await openPanel(); fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'question' } })
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' }))
    view.rerender(<AgentThreadSidesPanel route={route} conversationId="other" active profileId="profile" getMessages={() => []} />)
    await act(async () => finish({ branch }))
    expect(screen.queryByText('SIDE_QUESTION')).toBeNull(); expect(mocks.openAgentSide).not.toHaveBeenCalled()
  })
  it('offers an explicit fresh-revision retry only after a definite rejected continuation', async () => {
    renderPanel(); await openPanel(); fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'question' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' })))
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    mocks.continueAgentSide.mockRejectedValueOnce(new Error('Side revision conflict; reopen before continuing.'))
    fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'follow' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.continue' })))
    const first = mocks.continueAgentSide.mock.calls[0][0]
    mocks.openAgentSide.mockResolvedValue({ ...detail, branch: { ...branch, revision: 5 } })
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(screen.getByRole('button', { name: 'chat.agent_side.continue' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.retry_conflict' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.continue' })))
    expect(mocks.continueAgentSide.mock.calls[1][0]).toMatchObject({ expectedRevision: 5, question: 'follow' })
    expect(mocks.continueAgentSide.mock.calls[1][0].operationId).not.toBe(first.operationId)
  })
  it('does not let an older same-branch poll replace newer stopped status after mutation', async () => {
    mocks.openAgentSide.mockResolvedValue({ ...detail, branch: { ...branch, busy: true, canContinue: false, status: 'running' } })
    renderPanel(); await openPanel(); fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'question' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' })))
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    let old!: (v: unknown) => void
    mocks.openAgentSide.mockImplementationOnce(() => new Promise((resolve) => { old = resolve }))
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    mocks.openAgentSide.mockResolvedValue({ ...detail, branch: { ...branch, revision: 6, status: 'stopped' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.stop' })))
    await act(async () => old({ ...detail, branch: { ...branch, busy: true, status: 'running' } }))
    expect(screen.queryByRole('button', { name: 'chat.agent_side.stop' })).toBeNull()
    expect(screen.getByRole('button', { name: 'chat.agent_side.delete' })).toBeTruthy()
  })
  it('routes explicit commands through current side APIs and preserves revision and original snapshot boundaries', async () => {
    const ref = createRef<AgentSideCommandHandle>()
    render(<AgentThreadSidesPanel ref={ref} route={route} conversationId="chat" active profileId="profile" getMessages={() => messages} />)
    expect(mocks.listAgentSides).not.toHaveBeenCalled()
    act(() => { expect(ref.current!.execute({ action: 'start', question: 'STALE_SCOPE' }, JSON.stringify({ route, conversationId: 'different' }))).toBe(false) })
    expect(mocks.startAgentSide).not.toHaveBeenCalled()
    await act(async () => { expect(ref.current!.execute({ action: 'start', question: 'COMMAND_PRIVATE_QUESTION' })).toBe(true) })
    const start = mocks.startAgentSide.mock.calls[0][0]
    expect(start).toMatchObject({ route, conversationId: 'chat', profileId: 'profile', question: 'COMMAND_PRIVATE_QUESTION', snapshot: [{ role: 'user', content: 'PARENT_VISIBLE' }] })
    expect(JSON.stringify(start)).not.toMatch(/HIDDEN_SECRET|SECRET_FILE/)
    await act(async () => { expect(ref.current!.execute({ action: 'continue', branchId: branch.id, question: 'COMMAND_FOLLOWUP' })).toBe(true) })
    expect(mocks.continueAgentSide).toHaveBeenCalledWith({ route, conversationId: 'chat', branchId: branch.id, expectedRevision: 3, question: 'COMMAND_FOLLOWUP', operationId: expect.any(String) })
    expect(mocks.continueAgentSide.mock.calls[0][0]).not.toHaveProperty('snapshot')
    await act(async () => { expect(ref.current!.execute({ action: 'open', branchId: branch.id })).toBe(true) })
    expect(screen.getByText('SIDE_QUESTION')).toBeInTheDocument()
    await act(async () => { expect(ref.current!.execute({ action: 'stop', branchId: branch.id })).toBe(true) })
    expect(mocks.stopAgentSide).toHaveBeenCalledWith({ route, conversationId: 'chat', branchId: branch.id, expectedRevision: 3 })
    expect(mocks.startAgentSide).toHaveBeenCalledOnce(); expect(mocks.continueAgentSide).toHaveBeenCalledOnce()
  })
  it.each(['switch', 'close'] as const)('does not dispatch continuation after a delayed open and %s invalidates its generation', async mode => {
    let finish!: (v: unknown) => void
    mocks.openAgentSide.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const ref = createRef<AgentSideCommandHandle>()
    const view = render(<AgentThreadSidesPanel ref={ref} route={route} conversationId="chat" active profileId="profile" getMessages={() => messages} />)
    act(() => { expect(ref.current!.execute({ action: 'continue', branchId: branch.id, question: 'OLD_QUESTION' })).toBe(true); expect(ref.current!.execute({ action: 'start', question: 'duplicate' })).toBe(false) })
    if (mode === 'switch') view.rerender(<AgentThreadSidesPanel ref={ref} route={route} conversationId="other" active profileId="profile" getMessages={() => []} />)
    else fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.close' }))
    await act(async () => { finish(detail) })
    expect(mocks.continueAgentSide).not.toHaveBeenCalled(); expect(mocks.startAgentSide).not.toHaveBeenCalled()
    expect(screen.queryByText('SIDE_QUESTION')).not.toBeInTheDocument()
  })
  it('never creates a new command identity to retry an uncertain start; existing panel retry keeps it', async () => {
    mocks.startAgentSide.mockRejectedValueOnce(new Error('uncertain IPC'))
    const ref = createRef<AgentSideCommandHandle>()
    render(<AgentThreadSidesPanel ref={ref} route={route} conversationId="chat" active profileId="profile" getMessages={() => messages} />)
    await act(async () => { ref.current!.execute({ action: 'start', question: 'UNCHANGED' }) })
    const original = mocks.startAgentSide.mock.calls[0][0]
    act(() => { expect(ref.current!.execute({ action: 'start', question: 'UNCHANGED' })).toBe(false) })
    expect(mocks.startAgentSide).toHaveBeenCalledOnce()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' })) })
    expect(mocks.startAgentSide.mock.calls[1][0]).toEqual(original)
  })
  it('revokes delayed commands when eligibility changes, even if enabled again before completion', async () => {
    let finish!: (value: unknown) => void
    mocks.openAgentSide.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const ref = createRef<AgentSideCommandHandle>()
    const renderPanel = (enabled: boolean) => <AgentThreadSidesPanel ref={ref} route={route} conversationId="chat" active commandEnabled={enabled} profileId="profile" getMessages={() => messages} />
    const view = render(renderPanel(true))
    act(() => { expect(ref.current!.execute({ action: 'continue', branchId: branch.id, question: 'old pending' })).toBe(true) })
    view.rerender(renderPanel(false)); view.rerender(renderPanel(true))
    await act(async () => { finish(detail) })
    expect(mocks.continueAgentSide).not.toHaveBeenCalled()
    expect(screen.queryByText('SIDE_QUESTION')).not.toBeInTheDocument()
  })
  it('allows identical pending continuation receipt recovery when polling reports busy/non-continuable', async () => {
    mocks.continueAgentSide.mockRejectedValueOnce(new Error('IPC response lost'))
    const ref = createRef<AgentSideCommandHandle>()
    render(<AgentThreadSidesPanel ref={ref} route={route} conversationId="chat" active profileId="profile" getMessages={() => messages} />)
    await act(async () => { ref.current!.execute({ action: 'continue', branchId: branch.id, question: 'UNCHANGED_FOLLOWUP' }) })
    const original = mocks.continueAgentSide.mock.calls[0][0]
    mocks.openAgentSide.mockResolvedValue({ ...detail, branch: { ...branch, busy: true, canContinue: false, revision: 6, status: 'running' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(screen.getByRole('button', { name: 'chat.agent_side.continue' })).not.toBeDisabled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.continue' })) })
    expect(mocks.continueAgentSide.mock.calls[1][0]).toEqual(original)
  })
  it('locks edits and branch selection for an uncertain operation until an explicit separate-attempt warning is confirmed', async () => {
    mocks.startAgentSide.mockRejectedValueOnce(new Error('response lost'))
    const ref = createRef<AgentSideCommandHandle>()
    render(<AgentThreadSidesPanel ref={ref} route={route} conversationId="chat" active profileId="profile" getMessages={() => messages} />)
    await act(async () => { ref.current!.execute({ action: 'start', question: 'ORIGINAL_PENDING' }) })
    const original = mocks.startAgentSide.mock.calls[0][0]
    expect(screen.getByLabelText('chat.agent_side.question')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'CHANGED_BY_EVENT' } })
    expect(screen.getByLabelText('chat.agent_side.question')).toHaveValue('ORIGINAL_PENDING')
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.new_attempt' }))
    expect(screen.getByText('chat.agent_side.new_attempt_notice')).toBeInTheDocument()
    expect(mocks.startAgentSide).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.keep_pending' }))
    expect(screen.getByLabelText('chat.agent_side.question')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.new_attempt' }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.confirm_new_attempt' }))
    expect(mocks.startAgentSide).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('chat.agent_side.question')).not.toBeDisabled()
    fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'EXPLICIT_SEPARATE' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' })) })
    const separate = mocks.startAgentSide.mock.calls[1][0]
    expect(separate.question).toBe('EXPLICIT_SEPARATE'); expect(separate.operationId).not.toBe(original.operationId); expect(separate.branchId).not.toBe(original.branchId)
  })
  it('does not dispatch from a retained handle after layout teardown and StrictMode remounts safely', async () => {
    let finish!: (value: unknown) => void
    mocks.openAgentSide.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const ref = createRef<AgentSideCommandHandle>()
    const view = render(<React.StrictMode><AgentThreadSidesPanel ref={ref} route={route} conversationId="chat" active profileId="profile" getMessages={() => messages} /></React.StrictMode>)
    const old = ref.current!
    act(() => { expect(old.execute({ action: 'continue', branchId: branch.id, question: 'OLD' })).toBe(true) })
    view.unmount()
    expect(old.execute({ action: 'start', question: 'LATE' })).toBe(false)
    await act(async () => { finish(detail) })
    expect(mocks.continueAgentSide).not.toHaveBeenCalled(); expect(mocks.startAgentSide).not.toHaveBeenCalled()
  })
  it.each(['start', 'continue'] as const)('preserves an uncertain %s identity across conversation and active-pane round trips', async action => {
    const ref = createRef<AgentSideCommandHandle>()
    const props = (conversationId: string, active = true) => <AgentThreadSidesPanel ref={ref} route={route} conversationId={conversationId} active={active} profileId="profile" getMessages={() => messages} />
    const view = render(props('chat'))
    const method = action === 'start' ? mocks.startAgentSide : mocks.continueAgentSide
    method.mockRejectedValueOnce(new Error('Reply lost'))
    await act(async () => { ref.current!.execute(action === 'start' ? { action, question: 'ORIGINAL_SCOPE_QUESTION' } : { action, branchId: branch.id, question: 'ORIGINAL_SCOPE_QUESTION' }) })
    const original = method.mock.calls[0][0]
    view.rerender(props('other'))
    expect(screen.queryByText('chat.agent_side.pending_notice')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('chat.agent_side.question')).not.toBeInTheDocument()
    view.rerender(props('chat'))
    expect(screen.getByText('chat.agent_side.pending_notice')).toBeVisible()
    expect(screen.getByLabelText('chat.agent_side.question')).toHaveValue('ORIGINAL_SCOPE_QUESTION')
    expect(screen.getByLabelText('chat.agent_side.question')).toBeDisabled()
    act(() => { expect(ref.current!.execute({ action: 'start', question: 'must not create a duplicate' })).toBe(false) })
    view.rerender(props('chat', false)); view.rerender(props('chat'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: `chat.agent_side.${action}` })))
    expect(method.mock.calls[1][0]).toEqual(original)
    expect(mocks.stopAgentSide).not.toHaveBeenCalled()
  })
  it('keeps the submitted identity when an old response arrives after switching away and back', async () => {
    let finish!: (value: unknown) => void
    mocks.startAgentSide.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const props = (conversationId: string) => <AgentThreadSidesPanel ref={commandRef} route={route} conversationId={conversationId} active profileId="profile" getMessages={() => messages} />
    const view = render(props('chat')); await openPanel()
    fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'LATE_SCOPE_QUESTION' } })
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' }))
    const original = mocks.startAgentSide.mock.calls[0][0]
    view.rerender(props('other')); view.rerender(props('chat'))
    await act(async () => finish({ branch }))
    expect(screen.queryByText('SIDE_QUESTION')).not.toBeInTheDocument()
    expect(screen.getByText('chat.agent_side.pending_notice')).toBeVisible()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' })))
    expect(mocks.startAgentSide.mock.calls[1][0]).toEqual(original)
  })
  it('bounds snapshots and excludes non-prose fields and system entries', () => {
    const snapshot = sideSnapshot(Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `${i}:` + 'x'.repeat(9000), hiddenContext: 'SECRET' })))
    expect(snapshot.length).toBeLessThanOrEqual(24); expect(snapshot.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(24000)
    expect(JSON.stringify(snapshot)).not.toContain('SECRET')
    expect(sideSnapshot([{ role: 'system', content: 'SYSTEM' }])).toEqual([])
  })
})
