import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHtmlApp } from '@shared/api/agentThreadHtml'
import AgentThreadHtmlPanel from './AgentThreadHtmlPanel'
const mocks = vi.hoisted(() => ({ list: vi.fn(), open: vi.fn(), close: vi.fn(), storage: vi.fn(), initialize: vi.fn(), bind: vi.fn(), save: vi.fn(), saved: vi.fn(), restore: vi.fn(), remove: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { restoreAgentHtmlApp: mocks.restore, deleteSavedAgentHtmlApp: mocks.remove, saveAgentHtmlApp: mocks.save, listSavedAgentHtmlApps: mocks.saved, setAgentHtmlScope: mocks.bind, listAgentHtmlApps: mocks.list, openAgentHtmlApp: mocks.open, closeAgentHtmlApp: mocks.close, agentHtmlStorageStatus: mocks.storage, initializeAgentHtmlStorage: mocks.initialize } }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' } as const
const app = (status: AgentHtmlApp['status'] = 'ready'): AgentHtmlApp => ({ id: 'owned', title: '<img src=x onerror=alert(1)>', status, revision: 1, sha256: 'hash', createdAt: Date.now(), expiresAt: Date.now() + 60000, surface: 'canvas' })
const mount = async (item = app()) => { mocks.list.mockResolvedValue({ apps: [item] }); const view = render(<AgentThreadHtmlPanel route={route} conversationId="chat" active />); await act(async () => { await Promise.resolve() }); return view }
beforeEach(() => { vi.useFakeTimers(); Object.values(mocks).forEach(m => m.mockReset()); mocks.bind.mockResolvedValue({ documentToken: 'document-token' }); mocks.saved.mockResolvedValue({ apps: [] }); mocks.save.mockResolvedValue({}); mocks.storage.mockResolvedValue({ initialized: true, enabled: true, available: true, unconfirmedRuns: 0, canInitialize: false, saveEnabled: false }); mocks.initialize.mockResolvedValue(undefined); mocks.open.mockResolvedValue({ app: app('open') }); mocks.close.mockResolvedValue({ app: app('closed') }) })
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('HTML user-control metadata panel', () => {
  it('renders only metadata as text and requires explicit open; no iframe or script in chat', async () => {
    await mount(); expect(mocks.open).not.toHaveBeenCalled(); expect(document.querySelector('iframe,script,img')).toBeNull()
    expect(mocks.list).toHaveBeenCalledWith({ route, conversationId: 'chat' })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.open' })))
    expect(mocks.open).toHaveBeenCalledWith({ route, conversationId: 'chat', appId: 'owned', expectedRevision: 1 })
    expect(screen.queryByTestId('agent-app-launcher-state')).toBeNull()
  })
  it('locks repeated open while pending and does not call a model or invent success on errors', async () => {
    await mount(); let reject!: (e: Error) => void
    mocks.open.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.open' })); fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.open' }))
    expect(mocks.open).toHaveBeenCalledOnce()
    await act(async () => reject(new Error('no verified helper')))
    expect(screen.getByText('chat.agent_html.error_short')).toBeTruthy(); expect(screen.getByRole('alert')).toHaveAttribute('title', 'chat.agent_html.error')
  })
  it('stops explicitly and shows unknown quarantine without offering restart', async () => {
    await mount(app('open'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.close' })))
    expect(mocks.close).toHaveBeenCalledWith({ route, conversationId: 'chat', appId: 'owned', expectedRevision: 1 })
    mocks.list.mockResolvedValue({ apps: [app('unknown')] }); await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(screen.getByText('chat.agent_html.unknown_short')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'chat.agent_html.open' })).toBeNull()
  })
  it('discards stale polls and mutation errors after conversation change', async () => {
    const view = await mount(); let resolve!: (value: unknown) => void, reject!: (e: Error) => void
    mocks.list.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    mocks.open.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.open' }))
    mocks.list.mockResolvedValue({ apps: [] }); mocks.storage.mockResolvedValue({ enabled: false }); view.rerender(<AgentThreadHtmlPanel route={route} conversationId="other" active />)
    await act(async () => { resolve({ apps: [{ ...app(), title: 'OLD DOCUMENT' }] }); reject(new Error('old')); await Promise.resolve() })
    expect(screen.queryByTestId('agent-html-apps')).toBeNull(); expect(screen.queryByText('OLD DOCUMENT')).toBeNull()
  })
  it('allows stop while an open IPC is unresolved and ignores its later obsolete failure', async () => {
    await mount(); let reject!: (error: Error) => void
    mocks.open.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.open' }))
    expect(screen.getByRole('button', { name: 'chat.agent_html.close' })).not.toBeDisabled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.close' })))
    expect(mocks.close).toHaveBeenCalledOnce()
    await act(async () => reject(new Error('cancelled by user')))
    expect(screen.queryByText('chat.agent_html.error_short')).toBeNull()
  })
  it('keeps unknown shutdown visible after document expiry', async () => {
    await mount({ ...app('unknown'), expiresAt: Date.now() - 1 })
    expect(screen.getByText('chat.agent_html.unknown_short')).toBeTruthy()
  })
  it('waits for activation before storage access and ignores activation success after deactivation', async () => {
    let finish!: (value: { documentToken: string }) => void
    mocks.bind.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = await mount(); expect(mocks.storage).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled()
    view.rerender(<AgentThreadHtmlPanel route={route} conversationId="chat" active={false} />)
    await act(async () => finish({ documentToken: 'old' })); expect(mocks.storage).not.toHaveBeenCalled()
    expect(mocks.bind.mock.calls[1][0]).toMatchObject({ active: false, conversationId: 'chat', lifecycleRevision: mocks.bind.mock.calls[0][0].lifecycleRevision })
  })
  it('saves only by explicit user action with both revisions and retains uncertain IDs across a remount', async () => {
    mocks.storage.mockResolvedValue({ initialized: true, enabled: true, available: true, saveEnabled: true, unconfirmedRuns: 0, canInitialize: false })
    const view = await mount(); expect(mocks.save).not.toHaveBeenCalled()
    mocks.save.mockRejectedValueOnce(new Error('reply lost'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.save_snapshot' })))
    expect(mocks.save).toHaveBeenCalledWith({ route, conversationId: 'chat', documentToken: 'document-token', appId: 'owned', expectedRevision: 1, expectedStorageRevision: 0, operationId: expect.any(String) })
    const operationId = mocks.save.mock.calls[0][0].operationId
    view.unmount(); await mount()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.save_snapshot' })))
    expect(mocks.save.mock.calls[1][0].operationId).toBe(operationId)
  })
  it('drops a pending save failure after saving is disabled and hides incomplete closed snapshots', async () => {
    mocks.storage.mockResolvedValue({ initialized: true, enabled: true, available: true, saveEnabled: true, unconfirmedRuns: 0, canInitialize: false })
    await mount(); let reject!: (reason: Error) => void
    mocks.save.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.save_snapshot' }))
    mocks.storage.mockResolvedValue({ initialized: true, enabled: true, available: true, saveEnabled: false, unconfirmedRuns: 0, canInitialize: false })
    await act(async () => vi.advanceTimersByTimeAsync(1000)); await act(async () => reject(new Error('old save')))
    expect(screen.queryByText('chat.agent_html.error_short')).toBeNull(); expect(screen.queryByRole('button', { name: 'chat.agent_html.save_snapshot' })).toBeNull()
    mocks.storage.mockResolvedValue({ initialized: true, enabled: true, available: true, saveEnabled: true, unconfirmedRuns: 0, canInitialize: false }); mocks.list.mockResolvedValue({ apps: [{ ...app('closed'), snapshotReady: false }] })
    await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(screen.queryByRole('button', { name: 'chat.agent_html.save_snapshot' })).toBeNull()
  })
  it('does not initialize on polling or open without explicit user initialization', async () => {
    mocks.storage.mockResolvedValue({ enabled: true, initialized: false, available: true, unconfirmedRuns: 0, canInitialize: true, saveEnabled: false })
    await mount(); expect(mocks.initialize).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'chat.agent_html.open' })).toBeDisabled()
    expect(screen.getByText('chat.agent_html.initialize_notice_short')).toBeTruthy()
    mocks.storage.mockResolvedValue({ enabled: true, initialized: true, available: true, unconfirmedRuns: 0, canInitialize: false, saveEnabled: false })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.initialize' })))
    expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'chat', documentToken: 'document-token' })
    expect(screen.getByRole('button', { name: 'chat.agent_html.open' })).not.toBeDisabled()
  })
  it('does not offer a reset when existing storage or count is unknown', async () => {
    mocks.storage.mockResolvedValue({ enabled: true, initialized: true, available: false, unconfirmedRuns: null, canInitialize: false, saveEnabled: false })
    await mount(); expect(screen.queryByRole('button', { name: 'chat.agent_html.initialize' })).toBeNull()
    expect(screen.getByRole('button', { name: 'chat.agent_html.open' })).toBeDisabled()
    expect(screen.getByText('chat.agent_html.storage_unavailable_short')).toBeTruthy()
  })
  it('keeps unknown run warnings when status IPC fails instead of hiding the retained instance', async () => {
    await mount(app('unknown')); mocks.storage.mockRejectedValue(new Error('storage unavailable'))
    await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(screen.getByText('chat.agent_html.unknown_short')).toBeTruthy()
  })
  it('does not poll inactive surfaces and removes expired metadata', async () => {
    mocks.storage.mockResolvedValue({ enabled: false, initialized: false, available: false, unconfirmedRuns: null, canInitialize: false, saveEnabled: false })
    const view = await mount(); await act(async () => vi.advanceTimersByTimeAsync(61000)); expect(screen.queryByTestId('agent-html-apps')).toBeNull()
    view.rerender(<AgentThreadHtmlPanel route={route} conversationId="chat" active={false} />)
    const count = mocks.list.mock.calls.length; await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(mocks.list).toHaveBeenCalledTimes(count)
  })
  it('draws each app as a launcher card (title, 打开) into the given host, with no notice paragraph', async () => {
    const host = document.createElement('div'); document.body.appendChild(host)
    mocks.list.mockResolvedValue({ apps: [app(), { ...app('open'), id: 'second', title: 'Second app' }] })
    const view = render(<AgentThreadHtmlPanel route={route} conversationId="chat" active host={host} />)
    await act(async () => { await Promise.resolve() })
    expect(view.container).toBeEmptyDOMElement()
    const cards = within(host).getAllByTestId('agent-html-app')
    expect(cards).toHaveLength(2)
    // The cards are the host's own children: an empty host stays empty.
    expect(cards[0].parentElement).toBe(host)
    expect(within(cards[0]).getByTestId('agent-app-launcher-title')).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(within(cards[0]).queryByTestId('agent-app-launcher-state')).toBeNull()
    // The security notice is the Open button's tooltip and its accessible description, not a paragraph.
    const open = within(cards[0]).getByRole('button', { name: 'chat.agent_html.open' })
    expect(open).toHaveAttribute('title', 'chat.agent_html.notice')
    expect(open).toHaveAccessibleDescription('chat.agent_html.notice')
    expect(within(cards[1]).queryByRole('button', { name: 'chat.agent_html.open' })).toBeNull()
    expect(within(cards[1]).getByText('chat.agent_html.status_open')).toBeTruthy()
    view.unmount(); host.remove()
  })
  it('draws nothing without an app or a saved snapshot, and keeps storage lines in the last app card only', async () => {
    const host = document.createElement('div'); document.body.appendChild(host)
    mocks.storage.mockResolvedValue({ enabled: true, initialized: true, available: true, unconfirmedRuns: 2, canInitialize: false, saveEnabled: true })
    mocks.list.mockResolvedValue({ apps: [] })
    render(<AgentThreadHtmlPanel route={route} conversationId="chat" active host={host} />)
    await act(async () => { await Promise.resolve() })
    expect(host).toBeEmptyDOMElement()
    // The snapshots are listed once to learn whether there is anything to draw; polling adds no read.
    expect(mocks.saved).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(host).toBeEmptyDOMElement(); expect(mocks.saved).toHaveBeenCalledOnce()
    mocks.list.mockResolvedValue({ apps: [app(), { ...app(), id: 'last', title: 'Last app' }] })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    const cards = within(host).getAllByTestId('agent-html-app')
    expect(within(cards[0]).queryByText('chat.agent_html.run_slots_short')).toBeNull()
    const line = within(cards[1]).getByText('chat.agent_html.run_slots_short')
    expect(line.parentElement).toHaveAttribute('title', 'chat.agent_html.run_slots')
    expect(screen.queryByRole('button', { name: /saved_refresh/ })).toBeNull()
    // The lines moved into the app card (one more read); polling does not list the snapshots again.
    expect(mocks.saved).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(mocks.saved).toHaveBeenCalledTimes(2)
    host.remove()
  })
  it('lists saved snapshots in the body of the last app card, and as launcher cards of their own while the thread has no app', async () => {
    const host = document.createElement('div'); document.body.appendChild(host)
    mocks.storage.mockResolvedValue({ enabled: true, initialized: true, available: true, unconfirmedRuns: 0, canInitialize: false, saveEnabled: true })
    mocks.saved.mockResolvedValue({ apps: [{ id: 's1', title: 'Saved chart', storageRevision: 1, documentRevision: 3, htmlBytes: 10, surface: 'canvas', sha256: 'h', createdAt: 1, updatedAt: 1 }, { id: 's2', title: 'Saved table', storageRevision: 4, documentRevision: 1, htmlBytes: 10, surface: 'canvas', sha256: 'h', createdAt: 1, updatedAt: 1 }] })
    mocks.list.mockResolvedValue({ apps: [] })
    render(<AgentThreadHtmlPanel route={route} conversationId="chat" active host={host} />)
    await act(async () => { await Promise.resolve() })
    // No app (it left after 15 minutes, or the program restarted): each snapshot is still there as a
    // launcher card, the host's own child (title, 恢复, 删除…), so it can be restored and deleted.
    const own = within(host).getAllByTestId('agent-html-saved-item')
    expect(own.map(card => card.parentElement)).toEqual([host, host])
    expect(own.map(card => within(card).getByTestId('agent-app-launcher-title').textContent)).toEqual(['Saved chart', 'Saved table'])
    expect(within(own[0]).getAllByRole('button').map(button => button.textContent)).toEqual(['chat.agent_html.restore', 'chat.agent_html.delete_saved'])
    expect(own[0]).not.toHaveTextContent('v3')
    expect(within(host).queryByTestId('agent-html-app')).toBeNull()
    mocks.list.mockResolvedValue({ apps: [app(), { ...app(), id: 'last', title: 'Last app' }] })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    await act(async () => { await Promise.resolve() })
    // With app cards the same snapshots are lines in the last one's body; their own cards are gone.
    const cards = within(host).getAllByTestId('agent-html-app')
    expect(cards).toHaveLength(2)
    expect([...host.children]).toEqual(cards)
    expect(within(cards[0]).queryByTestId('agent-html-saved-item')).toBeNull()
    const lines = within(cards[1]).getAllByTestId('agent-html-saved-item')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toHaveTextContent('Saved chart')
    expect(lines[0]).not.toHaveTextContent('v3')
    expect(within(lines[0]).getAllByRole('button').map(button => button.textContent)).toEqual(['chat.agent_html.restore', 'chat.agent_html.delete_saved'])
    expect(within(host).queryAllByTestId('agent-app-launcher-title').map(title => title.textContent)).toEqual(['<img src=x onerror=alert(1)>', 'Last app'])
    host.remove()
  })
  it('restores a snapshot with no live app in the thread, restores it again after that card left, and deletes it', async () => {
    const host = document.createElement('div'); document.body.appendChild(host)
    mocks.storage.mockResolvedValue({ enabled: true, initialized: true, available: true, unconfirmedRuns: 0, canInitialize: false, saveEnabled: true })
    const saved = { id: 's-alone', title: 'Saved chart', storageRevision: 2, documentRevision: 3, htmlBytes: 10, surface: 'canvas', sha256: 'h', createdAt: 1, updatedAt: 1 }
    mocks.saved.mockResolvedValue({ apps: [saved] }); mocks.list.mockResolvedValue({ apps: [] }); mocks.remove.mockResolvedValue(undefined)
    // Main as it answers a restore: a replayed operation gets the card it made then, and is refused
    // once that card left the thread.
    const made = new Map<string, AgentHtmlApp>()
    let listed: AgentHtmlApp[] = []
    mocks.list.mockImplementation(async () => ({ apps: listed }))
    mocks.restore.mockImplementation(async ({ operationId }: { operationId: string }) => {
      const prior = made.get(operationId)
      if (prior) { if (!listed.includes(prior)) throw new Error('HTML app is unavailable in this document/thread/conversation.'); return { app: prior } }
      const card = { ...app(), id: `restored-${made.size + 1}`, title: 'Saved chart', savedId: saved.id, savedRevision: 2 }
      made.set(operationId, card); listed = [...listed, card]; return { app: card }
    })
    render(<AgentThreadHtmlPanel route={route} conversationId="chat" active host={host} />)
    await act(async () => { await Promise.resolve() })
    await act(async () => fireEvent.click(within(host).getByRole('button', { name: 'chat.agent_html.restore' })))
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'chat', documentToken: 'document-token', savedId: saved.id, expectedStorageRevision: 2, operationId: expect.any(String) })
    // The restored card appears and takes the snapshot into its body as a line.
    await act(async () => vi.advanceTimersByTimeAsync(1000)); await act(async () => { await Promise.resolve() })
    const restored = within(host).getByTestId('agent-html-app')
    expect(within(restored).getByTestId('agent-html-saved-item')).toHaveTextContent('Saved chart')
    // That card expires: the snapshot is a card of its own again, and 恢复 restores it once more
    // (a new operation: main would refuse the first one now).
    listed = []
    await act(async () => vi.advanceTimersByTimeAsync(1000)); await act(async () => { await Promise.resolve() })
    expect(within(host).queryByTestId('agent-html-app')).toBeNull()
    await act(async () => fireEvent.click(within(host).getByRole('button', { name: 'chat.agent_html.restore' })))
    expect(mocks.restore).toHaveBeenCalledTimes(2)
    expect(mocks.restore.mock.calls[1][0].operationId).not.toBe(mocks.restore.mock.calls[0][0].operationId)
    expect(within(host).queryByRole('alert')).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(1000)); await act(async () => { await Promise.resolve() })
    expect(within(within(host).getByTestId('agent-html-app')).getByTestId('agent-app-launcher-title')).toHaveTextContent('Saved chart')
    // That card leaves too; deleting from the snapshot's own card asks once more, then removes it.
    listed = []
    await act(async () => vi.advanceTimersByTimeAsync(1000)); await act(async () => { await Promise.resolve() })
    fireEvent.click(within(host).getByRole('button', { name: 'chat.agent_html.delete_saved' }))
    expect(mocks.remove).not.toHaveBeenCalled()
    mocks.saved.mockResolvedValue({ apps: [] })
    await act(async () => fireEvent.click(within(host).getByRole('button', { name: 'chat.agent_html.confirm_delete' })))
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'chat', documentToken: 'document-token', savedId: saved.id, expectedStorageRevision: 2 })
    await act(async () => { await Promise.resolve() })
    expect(host).toBeEmptyDOMElement()
    host.remove()
  })
  it('does not read or draw snapshots while saving is off', async () => {
    const host = document.createElement('div'); document.body.appendChild(host)
    mocks.saved.mockResolvedValue({ apps: [{ id: 's1', title: 'Saved chart', storageRevision: 1, documentRevision: 3, htmlBytes: 10, surface: 'canvas', sha256: 'h', createdAt: 1, updatedAt: 1 }] })
    mocks.list.mockResolvedValue({ apps: [] })
    render(<AgentThreadHtmlPanel route={route} conversationId="chat" active host={host} />)
    await act(async () => { await Promise.resolve() }); await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(host).toBeEmptyDOMElement(); expect(mocks.saved).not.toHaveBeenCalled()
    mocks.list.mockResolvedValue({ apps: [app()] })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(within(host).getByTestId('agent-html-app')).toBeTruthy(); expect(within(host).queryByTestId('agent-html-saved-item')).toBeNull(); expect(mocks.saved).not.toHaveBeenCalled()
    host.remove()
  })
})
