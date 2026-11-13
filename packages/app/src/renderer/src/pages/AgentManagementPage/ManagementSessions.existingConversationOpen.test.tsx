import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ManagementSessions from './ManagementSessions'
import ExistingConversationOpenStatus from '@renderer/components/ExistingConversationOpenStatus'
import { existingConversationOpenStore as coordinator } from '@renderer/utils/existingConversationOpenStore'
import type { ExistingConversationTarget, OpenRequestHandle } from '@renderer/utils/existingConversationOpen'

const f = vi.hoisted(() => ({ read: vi.fn(), metadata: vi.fn(), validate: vi.fn<(target: ExistingConversationTarget, signal: AbortSignal) => Promise<boolean>>(), language: 'en' }))
vi.mock('./managementPaneMetadata', () => ({ readManagementPaneSnapshot: f.metadata }))
vi.mock('../ChatPage/chatStorage', () => ({ readExistingSessionSummaries: f.read }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: f.language } }) }))
vi.mock('@renderer/utils/existingConversationOpenStore', async () => {
  const { useSyncExternalStore } = await import('react')
  const { createExistingConversationOpenCoordinator } = await import('@renderer/utils/existingConversationOpen')
  const store = createExistingConversationOpenCoordinator({ validate: (target, signal) => f.validate(target, signal) })
  return { existingConversationOpenStore: store, useExistingConversationOpenSnapshot: () => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) }
})
const projectId = 'tab-project-existing'
const target = { projectId, paneId: 'agent-1', storageScope: `${projectId}.agent-1`, sessionId: 'target' }
const owner = { projectId, projectName: 'Existing', paneId: target.paneId, storageScope: target.storageScope }
const row = { storageScope: target.storageScope, sessionId: target.sessionId, title: '<script>inert target</script>', titleTruncated: false }
const other = { ...row, sessionId: 'other', title: 'Other' }
const region = () => screen.getByRole('region', { name: 'Existing conversation Open' })
const rowOpen = (title = row.title) => within(screen.getByText(title).closest('li')!).getByRole('button', { name: 'Open existing conversation' })
async function showRows() {
  fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
  await screen.findByText(row.title)
}
async function mountedSelection() {
  const handle = coordinator.getSnapshot().request!.handle
  await waitFor(() => expect(coordinator.getSnapshot().request?.phase).toBe('navigating'))
  const presentation = coordinator.attachPresentation(handle, () => true)!
  const pane = coordinator.attachPane(presentation, () => true)!
  const consumer = coordinator.attachConsumer(pane)!
  const load = coordinator.beginLoad(consumer, { scopeEpoch: 1, readSequence: 1, activationGeneration: 1 })!
  coordinator.commitLoad(consumer, load, { storageScope: target.storageScope, hasTarget: true, loadError: false, pendingDeletion: false })
  const selection = (await coordinator.validateSelection(consumer, load, () => true))!
  return { consumer, selection }
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); f.language = 'en'
  f.read.mockReset().mockResolvedValue({ status: 'ready', sessions: [row, other] })
  f.metadata.mockReset().mockReturnValue({ status: 'ready', owners: [owner], isCurrent: () => true })
  f.validate.mockReset().mockImplementation(() => new Promise(() => {}))
})
afterEach(() => {
  cleanup()
  const snapshot = coordinator.getSnapshot()
  if (snapshot.request) coordinator.cancel(snapshot.request.handle)
  for (const visit of coordinator.getSnapshot().visits) coordinator.depart(visit)
  vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear()
})

describe('explicit ManagementSessions Open caller and persistent coordinator-only feedback', () => {
  it('has no mount storage read/start, including StrictMode, and separates passive summaries from explicit Open side effects', () => {
    const start = vi.spyOn(coordinator, 'start'), get = vi.spyOn(Storage.prototype, 'getItem')
    render(<React.StrictMode><ManagementSessions /><ExistingConversationOpenStatus /></React.StrictMode>)
    expect(f.read).not.toHaveBeenCalled(); expect(f.metadata).not.toHaveBeenCalled(); expect(f.validate).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled()
    expect(screen.getByRole('heading',{name:'Sessions'})).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open existing conversation' })).toBeNull()
  })
  it('synchronously installs an exact detached tuple and guard on explicit click, not display authority, persistence, events or navigation', async () => {
    render(<ManagementSessions />); await showRows()
    const start = vi.spyOn(coordinator, 'start'), write = vi.spyOn(Storage.prototype, 'setItem')
    const event = vi.spyOn(window, 'dispatchEvent'), hash = window.location.hash
    const button = rowOpen()
    fireEvent.click(button)
    const handle = coordinator.getSnapshot().request?.handle
    expect(handle?.target).toEqual(target); expect(Object.keys(handle!.target).sort()).toEqual(['paneId', 'projectId', 'sessionId', 'storageScope'])
    expect(coordinator.isGuarded(projectId)).toBe(true)
    expect(start).toHaveBeenCalledTimes(1); expect(f.validate).toHaveBeenCalledTimes(1)
    expect(f.validate).toHaveBeenCalledWith(target, expect.any(AbortSignal))
    expect(button).toBeDisabled(); fireEvent.click(button); expect(start).toHaveBeenCalledTimes(1)
    expect(rowOpen('Other')).toBeEnabled()
    expect(write).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled(); expect(window.location.hash).toBe(hash)
    expect(document.querySelector('script')).toBeNull()
  })
  it('permits a different row to supersede and ignores the old validator without cancelling on source unmount', async () => {
    let finishOld!: (ok: boolean) => void
    f.validate.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    const view = render(<ManagementSessions />); await showRows(); fireEvent.click(rowOpen())
    const first = coordinator.getSnapshot().request!.handle
    const oldSignal = f.validate.mock.calls[0][1]
    fireEvent.click(rowOpen('Other'))
    const second = coordinator.getSnapshot().request!.handle
    expect(second).not.toBe(first); expect(second.target.sessionId).toBe('other'); expect(oldSignal.aborted).toBe(true)
    view.unmount(); expect(coordinator.getSnapshot().request?.handle).toBe(second)
    await act(async () => finishOld(true))
    expect(coordinator.getSnapshot().request?.handle).toBe(second); expect(coordinator.getSnapshot().result).toBeNull(); expect(coordinator.isGuarded(projectId)).toBe(true)
  })
  it('fails closed on a fresh denied/throwing validator despite a displayed valid row, with bounded nonsensitive feedback and retry', async () => {
    f.validate.mockRejectedValueOnce(new Error('secret-credential-not-for-dom'))
    render(<><ManagementSessions /><ExistingConversationOpenStatus /></>); await showRows(); fireEvent.click(rowOpen())
    await waitFor(() => expect(coordinator.getSnapshot().result?.status).toBe('rejected'))
    expect(region()).toHaveTextContent('Existing conversation could not be opened')
    expect(region()).toHaveTextContent('Current ownership or persisted conversation unavailable')
    expect(document.body.innerHTML).not.toContain('secret-credential-not-for-dom')
    expect(rowOpen()).toBeEnabled(); expect(coordinator.isGuarded(projectId)).toBe(true)
  })
  it('renders pending and cancel from Layout-owned status after the source unmounts; dismissing a result never releases visit protection', async () => {
    const source = render(<ManagementSessions />); render(<ExistingConversationOpenStatus />)
    await showRows(); fireEvent.click(rowOpen()); const handle = coordinator.getSnapshot().request!.handle
    source.unmount()
    expect(region()).toHaveTextContent('Opening existing conversation')
    expect(region()).not.toHaveTextContent('Existing conversation opened')
    fireEvent.click(within(region()).getByRole('button', { name: 'Cancel Open' }))
    expect(coordinator.getSnapshot().request).toBeNull(); expect(coordinator.getSnapshot().result?.handle).toBe(handle)
    expect(region()).toHaveTextContent('Open cancelled'); expect(coordinator.isGuarded(projectId)).toBe(true)
    fireEvent.click(within(region()).getByRole('button', { name: 'Dismiss Open result' }))
    expect(screen.queryByRole('region', { name: 'Existing conversation Open' })).toBeNull()
    expect(coordinator.getSnapshot().result?.handle).toBe(handle); expect(coordinator.isGuarded(projectId)).toBe(true)
  })
  it('does not call an older cancel handle against a synchronously replaced request', async () => {
    render(<><ManagementSessions /><ExistingConversationOpenStatus /></>); await showRows(); fireEvent.click(rowOpen())
    const old = coordinator.getSnapshot().request!.handle
    const cancel = within(region()).getByRole('button', { name: 'Cancel Open' })
    let next!: OpenRequestHandle
    await act(async () => { next = coordinator.start({ ...target, sessionId: 'other' })!; fireEvent.click(cancel) })
    expect(coordinator.getSnapshot().request?.handle).toBe(next)
    expect(coordinator.getSnapshot().result?.handle).not.toBe(old)
  })
  it('shows success only after the terminal coordinator result, not merely navigation, load or a selection request', async () => {
    f.validate.mockResolvedValue(true)
    render(<><ManagementSessions /><ExistingConversationOpenStatus /></>); await showRows(); fireEvent.click(rowOpen())
    let selection!: Awaited<ReturnType<typeof mountedSelection>>
    await act(async () => { selection = await mountedSelection() })
    expect(coordinator.getSnapshot().request?.phase).toBe('verifying-commit')
    expect(region()).not.toHaveTextContent('Existing conversation opened')
    await act(async () => { await coordinator.confirmCommittedSelection(selection.consumer, selection.selection, () => true) })
    expect(region()).toHaveTextContent('Existing conversation opened')
    expect(within(region()).queryByRole('button', { name: 'Cancel Open' })).toBeNull()
    expect(coordinator.isGuarded(projectId)).toBe(true)
  })
  it('shows timeout rejection and clears a dismissed-result filter when a later request is started', async () => {
    render(<><ManagementSessions /><ExistingConversationOpenStatus /></>); await showRows()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(rowOpen())
    await act(async () => vi.advanceTimersByTimeAsync(15000))
    expect(region()).toHaveTextContent('Open timed out'); expect(coordinator.isGuarded(projectId)).toBe(true)
    fireEvent.click(within(region()).getByRole('button', { name: 'Dismiss Open result' }))
    expect(screen.queryByRole('region', { name: 'Existing conversation Open' })).toBeNull()
    fireEvent.click(rowOpen())
    expect(region()).toHaveTextContent('Opening existing conversation')
    vi.useRealTimers()
  })
  it('surfaces malformed request rejection without serializing a receipt or using the summary as membership', async () => {
    f.read.mockResolvedValue({ status: 'ready', sessions: [{ ...row, sessionId: '' }] })
    render(<ManagementSessions />); await showRows(); fireEvent.click(rowOpen())
    expect(coordinator.getSnapshot().request).toBeNull(); expect(f.validate).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Open request unavailable')
  })
  it('provides Chinese action/status copy without treating ids/titles as markup', async () => {
    f.language = 'zh'; render(<><ManagementSessions /><ExistingConversationOpenStatus /></>)
    fireEvent.click(screen.getByRole('button', { name: '读取已有会话摘要' })); await screen.findByText(row.title)
    fireEvent.click(within(screen.getByText(row.title).closest('li')!).getByRole('button', { name: '打开已有会话' }))
    expect(screen.getByRole('region', { name: '打开已有会话状态' })).toHaveTextContent('正在打开已有会话')
    expect(document.querySelector('script')).toBeNull()
  })
})
