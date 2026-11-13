import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ManagementSessions from './ManagementSessions'
import { existingConversationOpenStore } from '../../utils/existingConversationOpenStore'
import type { ExistingSessionSummaryResult } from '../ChatPage/chatStorage'

const deps = vi.hoisted(() => ({ metadata: vi.fn(), read: vi.fn(), current: vi.fn(() => true), api: vi.fn(() => { throw new Error('No MAIN/service allowed') }) }))
vi.mock('./managementPaneMetadata', () => ({ readManagementPaneSnapshot: deps.metadata }))
vi.mock('../ChatPage/chatStorage', () => ({ readExistingSessionSummaries: deps.read }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: deps.api }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }))
const owner = { projectId: 'p', projectName: 'Project', paneId: 'agent-1', storageScope: 'p.agent-1' }
const summary = { storageScope: 'p.agent-1', sessionId: 'existing', title: '<script>inert existing title</script>', titleTruncated: false, createdAt: 7 }
function deferred() { let resolve!: (value: ExistingSessionSummaryResult) => void; const promise = new Promise<ExistingSessionSummaryResult>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => { vi.clearAllMocks(); deps.current.mockReturnValue(true); deps.metadata.mockReturnValue({ status: 'ready', owners: [owner], isCurrent: deps.current }); deps.read.mockResolvedValue({ status: 'ready', sessions: [summary] }) })
afterEach(() => vi.restoreAllMocks())

describe('explicit management existing-conversation metadata view', () => {
  it('mounts and StrictMode rerenders without reading storage, services or creating/activating a chat', () => {
    const { rerender } = render(<React.StrictMode><ManagementSessions /></React.StrictMode>)
    rerender(<React.StrictMode><ManagementSessions /></React.StrictMode>)
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument()
    expect(screen.getByText('Not loaded — use Read existing conversation summaries')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read existing conversation summaries' })).toBeEnabled()
    expect(deps.metadata).not.toHaveBeenCalled(); expect(deps.read).not.toHaveBeenCalled(); expect(deps.api).not.toHaveBeenCalled()
  })
  it('one explicit click reads detached summaries only; separate Open is not invoked by reading or rendering rows', async () => {
    const start = vi.spyOn(existingConversationOpenStore, 'start')
    const { container } = render(<ManagementSessions />)
    fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
    expect(await screen.findByText(summary.title)).toBeInTheDocument()
    expect(deps.metadata).toHaveBeenCalledTimes(1)
    expect(deps.read).toHaveBeenCalledWith(['p.agent-1'], expect.any(AbortSignal))
    expect(screen.getByText('Project')).toBeInTheDocument(); expect(screen.getByText(/Scope: p\.agent-1 · ID: existing/)).toBeInTheDocument()
    expect(screen.getByRole('heading',{name:'Sessions'})).toBeVisible()
    expect(screen.queryByText(/Summary reads are snapshots only/)).toBeNull()
    expect(container.querySelector('script,img,input,textarea,select,a')).toBeNull()
    expect(start).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Open existing conversation' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Send|Save|Create/ })).toBeNull(); expect(deps.api).not.toHaveBeenCalled()
  })
  it('distinguishes pending, complete empty and unavailable; hides any prior rows on refresh', async () => {
    const first = deferred(); deps.read.mockReturnValueOnce(first.promise)
    render(<ManagementSessions />); fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
    expect(screen.getByRole('status')).toHaveTextContent('Reading existing conversation summaries')
    expect(screen.getByRole('button', { name: 'Read existing conversation summaries' })).toBeDisabled()
    await act(async () => first.resolve({ status: 'ready', sessions: [] }))
    expect(screen.getByText('No existing conversations in the validated enabled panes')).toBeInTheDocument()
    deps.read.mockResolvedValueOnce({ status: 'unavailable', reason: 'database-unavailable' })
    fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Existing conversation summaries unavailable')
    expect(screen.queryByText('No existing conversations in the validated enabled panes')).toBeNull()
  })
  it('does not query a database when project/pane metadata is missing or denied', async () => {
    deps.metadata.mockReturnValue({ status: 'unavailable', reason: 'metadata-unavailable' })
    render(<ManagementSessions />); fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Existing conversation summaries unavailable'); expect(deps.read).not.toHaveBeenCalled()
  })
  it('discards whole summary if canonical project/pane metadata changes during reading', async () => {
    const pending = deferred(); deps.read.mockReturnValue(pending.promise)
    render(<ManagementSessions />); fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
    deps.current.mockReturnValue(false); await act(async () => pending.resolve({ status: 'ready', sessions: [summary] }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Existing conversation summaries unavailable'); expect(screen.queryByText(summary.title)).toBeNull()
  })
  it('aborts on unmount and ignores an in-flight late result rather than reopening/navigating', async () => {
    const pending = deferred(); deps.read.mockReturnValue(pending.promise)
    const view = render(<ManagementSessions />); fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
    const signal = deps.read.mock.calls[0][1] as AbortSignal; view.unmount(); expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve({ status: 'ready', sessions: [summary] }))
    expect(screen.queryByText(summary.title)).toBeNull(); expect(deps.api).not.toHaveBeenCalled()
  })
  it('clears existing rows on explicit refresh and never publishes an unowned returned scope', async () => {
    render(<ManagementSessions />)
    fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
    expect(await screen.findByText(summary.title)).toBeInTheDocument()
    const next = deferred(); deps.read.mockReturnValueOnce(next.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
    expect(screen.queryByText(summary.title)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
    expect(deps.read).toHaveBeenCalledTimes(2)
    await act(async () => next.resolve({ status: 'ready', sessions: [{ ...summary, storageScope: 'foreign' }] }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Existing conversation summaries unavailable')
    expect(screen.queryByText(summary.title)).toBeNull()
  })
  it('treats rejected reads as unavailable, not empty or an unhandled rejection', async () => {
    deps.read.mockRejectedValue(new Error('Storage failure, not a user-facing secret dump'))
    render(<ManagementSessions />); fireEvent.click(screen.getByRole('button', { name: 'Read existing conversation summaries' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Existing conversation summaries unavailable')
    expect(screen.queryByText(/Storage failure/)).toBeNull()
  })
})
