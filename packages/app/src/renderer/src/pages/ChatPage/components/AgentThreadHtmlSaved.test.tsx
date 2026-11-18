import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentThreadHtmlSaved from './AgentThreadHtmlSaved'
const h = vi.hoisted(() => ({ list: vi.fn(), restore: vi.fn(), remove: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { listSavedAgentHtmlApps: h.list, restoreAgentHtmlApp: h.restore, deleteSavedAgentHtmlApp: h.remove } }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const scope = JSON.stringify({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }, conversationId: 'chat' })
const item = { id: '11111111-1111-4111-8111-111111111111', title: '<script>UNTRUSTED_TITLE</script>', storageRevision: 2, documentRevision: 7, htmlBytes: 100, surface: 'canvas', sha256: 'hash', createdAt: 1, updatedAt: 2 }
beforeEach(() => { Object.values(h).forEach(mock => mock.mockReset()); h.list.mockResolvedValue({ apps: [item] }); h.restore.mockResolvedValue({ app: { id: 'restored', status: 'ready' } }); h.remove.mockResolvedValue(undefined) })
afterEach(cleanup)
const mount = (cards = false) => { const changed = vi.fn(), view = render(<AgentThreadHtmlSaved scope={scope} enabled cards={cards} onChanged={changed} />); return { view, changed } }
// The list is read on its own once saving is available: wait for it.
const refresh = async () => { await act(async () => { await Promise.resolve() }) }
const press = (name: string, index = 0) => act(async () => fireEvent.click(screen.getAllByRole('button', { name })[index]))
describe('explicit user saved HTML controls', () => {
  it('lists once when enabled, as short lines, and restores a ready card without injecting HTML or starting a model', async () => {
    const t = mount(); await refresh()
    expect(h.list).toHaveBeenCalledExactlyOnceWith(JSON.parse(scope)); expect(document.querySelector('script,iframe')).toBeNull()
    expect(screen.getByTestId('agent-html-saved-title')).toHaveTextContent('<script>UNTRUSTED_TITLE</script>')
    // A line of the app card's body, not a card of its own: no launcher card, no version label.
    expect(screen.queryByTestId('agent-app-launcher-title')).toBeNull()
    expect(screen.getByTestId('agent-html-saved-item')).not.toHaveTextContent('v7')
    expect(screen.getByRole('button', { name: 'chat.agent_html.restore' })).toHaveAccessibleDescription('chat.agent_html.saved_notice')
    await press('chat.agent_html.restore')
    expect(h.restore).toHaveBeenCalledWith({ ...JSON.parse(scope), savedId: item.id, expectedStorageRevision: 2, operationId: expect.any(String) }); expect(t.changed).toHaveBeenCalledOnce()
  })
  it('reuses restoration operationID across uncertain retries', async () => {
    mount(); await refresh(); h.restore.mockRejectedValueOnce(new Error('uncertain transport'))
    await press('chat.agent_html.restore')
    expect(screen.getByText('chat.agent_html.snapshot_failed_short')).toBeTruthy()
    await press('chat.agent_html.restore')
    expect(h.restore.mock.calls[1][0].operationId).toBe(h.restore.mock.calls[0][0].operationId)
  })
  it('keeps an uncertain restore identity after unmount/remount of the same scope', async () => {
    const t = mount(); await refresh(); h.restore.mockRejectedValueOnce(new Error('lost reply'))
    await press('chat.agent_html.restore')
    const original = h.restore.mock.calls[0][0].operationId; t.view.unmount(); mount(); await refresh()
    await press('chat.agent_html.restore')
    expect(h.restore.mock.calls[1][0].operationId).toBe(original)
  })
  it('makes each restore after an acknowledged one a new operation: main refuses a replay once its card is gone', async () => {
    const again = { ...item, id: '33333333-3333-4333-8333-333333333333' }
    h.list.mockResolvedValue({ apps: [again] })
    // Main as it answers: a replayed operation gets the card it made then, or a refusal once that card left.
    const cards = new Map<string, string>(), live = new Set<string>()
    h.restore.mockImplementation(async ({ operationId }: { operationId: string }) => {
      const made = cards.get(operationId)
      if (made) { if (!live.has(made)) throw new Error('HTML app is unavailable in this document/thread/conversation.'); return { app: { id: made, status: 'ready' } } }
      const id = `card-${cards.size + 1}`; cards.set(operationId, id); live.add(id); return { app: { id, status: 'ready' } }
    })
    mount(true); await refresh()
    await press('chat.agent_html.restore')
    // The restored card leaves the thread (its 15 minutes are over); the snapshot is restored again.
    live.clear()
    await press('chat.agent_html.restore')
    expect(h.restore).toHaveBeenCalledTimes(2)
    expect(h.restore.mock.calls[1][0].operationId).not.toBe(h.restore.mock.calls[0][0].operationId)
    expect(screen.queryByText('chat.agent_html.snapshot_failed_short')).toBeNull()
    // A third press while the second card is still there is a new restore too.
    await press('chat.agent_html.restore')
    expect(new Set(h.restore.mock.calls.map(call => call[0].operationId)).size).toBe(3)
  })
  it('draws nothing while no snapshot is saved and lists again after a change', async () => {
    h.list.mockResolvedValue({ apps: [] })
    const changed = vi.fn(), view = render(<AgentThreadHtmlSaved scope={scope} enabled revision={0} onChanged={changed} />); await refresh()
    expect(view.container).toBeEmptyDOMElement()
    h.list.mockResolvedValue({ apps: [item] })
    view.rerender(<AgentThreadHtmlSaved scope={scope} enabled revision={1} onChanged={changed} />); await refresh()
    expect(h.list).toHaveBeenCalledTimes(2); expect(screen.getByTestId('agent-html-saved-item')).toBeTruthy()
  })
  it('offers restore and delete per snapshot and removes nothing before the confirmation', async () => {
    h.list.mockResolvedValue({ apps: [item, { ...item, id: '22222222-2222-4222-8222-222222222222', title: 'Second snapshot' }] })
    mount(); await refresh()
    expect(screen.getAllByTestId('agent-html-saved-item')).toHaveLength(2)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['chat.agent_html.restore', 'chat.agent_html.delete_saved', 'chat.agent_html.restore', 'chat.agent_html.delete_saved'])
    // Deleting asks once more in the line below; keeping the snapshot closes the question.
    await press('chat.agent_html.delete_saved', 1)
    expect(h.remove).not.toHaveBeenCalled()
    expect(screen.getByText('chat.agent_html.delete_notice_short').parentElement).toHaveAttribute('title', 'chat.agent_html.delete_notice')
    await press('chat.agent_html.cancel_delete')
    expect(screen.queryByRole('button', { name: 'chat.agent_html.confirm_delete' })).toBeNull()
    expect(h.remove).not.toHaveBeenCalled(); expect(h.restore).not.toHaveBeenCalled()
  })
  it('deletes a snapshot only after the confirmation, with its storage revision, and lists again', async () => {
    const second = { ...item, id: '22222222-2222-4222-8222-222222222222', title: 'Second snapshot', storageRevision: 5 }
    h.list.mockResolvedValue({ apps: [item, second] })
    const t = mount(); await refresh()
    await press('chat.agent_html.delete_saved', 1)
    h.list.mockResolvedValue({ apps: [item] })
    await press('chat.agent_html.confirm_delete')
    expect(h.remove).toHaveBeenCalledExactlyOnceWith({ ...JSON.parse(scope), savedId: second.id, expectedStorageRevision: 5 })
    expect(t.changed).toHaveBeenCalledOnce(); expect(h.list).toHaveBeenCalledTimes(2)
    expect(screen.getAllByTestId('agent-html-saved-item')).toHaveLength(1); expect(screen.queryByText('Second snapshot')).toBeNull()
    expect(screen.queryByRole('button', { name: 'chat.agent_html.confirm_delete' })).toBeNull()
  })
  it('keeps the snapshot and says so when main refuses the deletion', async () => {
    const t = mount(); await refresh(); h.remove.mockRejectedValueOnce(new Error('Saved HTML is busy or termination unconfirmed.'))
    await press('chat.agent_html.delete_saved')
    await press('chat.agent_html.confirm_delete')
    expect(screen.getByRole('alert')).toHaveTextContent('chat.agent_html.snapshot_failed_short')
    expect(screen.getByTestId('agent-html-saved-item')).toBeTruthy(); expect(t.changed).not.toHaveBeenCalled(); expect(h.list).toHaveBeenCalledOnce()
  })
  it('draws each snapshot as a launcher card of its own while the thread has no app card: title, 恢复, 删除…', async () => {
    h.list.mockResolvedValue({ apps: [item, { ...item, id: '22222222-2222-4222-8222-222222222222', title: 'Second snapshot', storageRevision: 5 }] })
    const t = mount(true); await refresh()
    const own = screen.getAllByTestId('agent-html-saved-item')
    expect(own).toHaveLength(2)
    expect(own.map(card => within(card).getByTestId('agent-app-launcher-title').textContent)).toEqual(['<script>UNTRUSTED_TITLE</script>', 'Second snapshot'])
    // No version label, no second copy: only the filled 恢复 and the 删除… text button.
    expect(within(own[1]).getAllByRole('button').map(button => button.textContent)).toEqual(['chat.agent_html.restore', 'chat.agent_html.delete_saved'])
    expect(own[1]).not.toHaveTextContent('v7'); expect(document.querySelector('script,iframe')).toBeNull()
    expect(within(own[1]).getByRole('button', { name: 'chat.agent_html.restore' })).toHaveAccessibleDescription('chat.agent_html.saved_notice')
    await act(async () => fireEvent.click(within(own[1]).getByRole('button', { name: 'chat.agent_html.restore' })))
    expect(h.restore).toHaveBeenCalledExactlyOnceWith({ ...JSON.parse(scope), savedId: '22222222-2222-4222-8222-222222222222', expectedStorageRevision: 5, operationId: expect.any(String) })
    expect(t.changed).toHaveBeenCalledOnce()
    fireEvent.click(within(own[0]).getByRole('button', { name: 'chat.agent_html.delete_saved' }))
    h.list.mockResolvedValue({ apps: [] })
    await act(async () => fireEvent.click(within(own[0]).getByRole('button', { name: 'chat.agent_html.confirm_delete' })))
    expect(h.remove).toHaveBeenCalledExactlyOnceWith({ ...JSON.parse(scope), savedId: item.id, expectedStorageRevision: 2 })
    expect(t.view.container).toBeEmptyDOMElement()
  })
  it('discards old list/restore responses when disabled or unmounted', async () => {
    let finish!: (value: unknown) => void; h.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const t = mount(); t.view.rerender(<AgentThreadHtmlSaved scope={scope} enabled={false} onChanged={t.changed} />)
    await act(async () => finish({ apps: [item] })); expect(screen.queryByText(/UNTRUSTED_TITLE/)).toBeNull()
    t.view.rerender(<AgentThreadHtmlSaved scope={scope} enabled onChanged={t.changed} />); await refresh()
    let finishRestore!: (value: unknown) => void; h.restore.mockImplementationOnce(() => new Promise(resolve => { finishRestore = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.restore' })); t.view.unmount()
    await act(async () => finishRestore({ app: { id: 'old' } })); expect(t.changed).not.toHaveBeenCalled()
  })
})
