import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentThreadHtmlSaved from './AgentThreadHtmlSaved'
const h = vi.hoisted(() => ({ list: vi.fn(), restore: vi.fn(), remove: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { listSavedAgentHtmlApps: h.list, restoreAgentHtmlApp: h.restore, deleteSavedAgentHtmlApp: h.remove } }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const scope = JSON.stringify({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }, conversationId: 'chat' })
const item = { id: '11111111-1111-4111-8111-111111111111', title: '<script>UNTRUSTED_TITLE</script>', storageRevision: 2, documentRevision: 7, htmlBytes: 100, surface: 'canvas', sha256: 'hash', createdAt: 1, updatedAt: 2 }
beforeEach(() => { Object.values(h).forEach(mock => mock.mockReset()); h.list.mockResolvedValue({ apps: [item] }); h.restore.mockResolvedValue({ app: { id: 'restored', status: 'ready' } }); h.remove.mockResolvedValue(undefined) })
afterEach(cleanup)
const mount = () => { const changed = vi.fn(), view = render(<AgentThreadHtmlSaved scope={scope} enabled onChanged={changed} />); return { view, changed } }
const refresh = async () => { await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.saved_refresh' }))) }
describe('explicit user saved HTML controls', () => {
  it('lists only on request and restores a ready card without injecting HTML or starting a model', async () => {
    const t = mount(); expect(h.list).not.toHaveBeenCalled(); await refresh()
    expect(h.list).toHaveBeenCalledExactlyOnceWith(JSON.parse(scope)); expect(document.querySelector('script,iframe')).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.restore' })))
    expect(h.restore).toHaveBeenCalledWith({ ...JSON.parse(scope), savedId: item.id, expectedStorageRevision: 2, operationId: expect.any(String) }); expect(t.changed).toHaveBeenCalledOnce()
  })
  it('reuses restoration operationID across uncertain retries and stale double clicks', async () => {
    mount(); await refresh(); h.restore.mockRejectedValueOnce(new Error('uncertain transport'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.restore' })))
    expect(screen.getByText('chat.agent_html.snapshot_failed')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.restore' })))
    expect(h.restore.mock.calls[1][0].operationId).toBe(h.restore.mock.calls[0][0].operationId)
  })
  it('keeps an uncertain restore identity after unmount/remount of the same scope', async () => {
    const t = mount(); await refresh(); h.restore.mockRejectedValueOnce(new Error('lost reply'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.restore' })))
    const original = h.restore.mock.calls[0][0].operationId; t.view.unmount(); mount(); await refresh()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.restore' })))
    expect(h.restore.mock.calls[1][0].operationId).toBe(original)
  })
  it('requires acknowledged success and a separate confirmation before generating a fresh restore operation', async () => {
    mount(); await refresh(); h.restore.mockRejectedValueOnce(new Error('uncertain'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.restore' })))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.restore' })))
    const prior = h.restore.mock.calls.at(-1)![0].operationId
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.restore_another' })); expect(h.restore).toHaveBeenCalledTimes(2)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.confirm_restore_another' })))
    expect(h.restore).toHaveBeenCalledTimes(3); expect(h.restore.mock.calls[2][0].operationId).not.toBe(prior)
  })
  it('requires a separate deletion confirmation and never restarts a failed/unknown process', async () => {
    mount(); await refresh(); fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.delete_saved' }))
    expect(h.remove).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.cancel_delete' })); expect(h.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.delete_saved' })); h.remove.mockRejectedValueOnce(new Error('termination unconfirmed'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.confirm_delete' })))
    expect(h.remove).toHaveBeenCalledWith({ ...JSON.parse(scope), savedId: item.id, expectedStorageRevision: 2 }); expect(screen.getByText('chat.agent_html.snapshot_failed')).toBeTruthy(); expect(h.restore).not.toHaveBeenCalled()
  })
  it('discards old list/restore responses when disabled or unmounted', async () => {
    const t = mount(); let finish!: (value: unknown) => void; h.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.saved_refresh' })); t.view.rerender(<AgentThreadHtmlSaved scope={scope} enabled={false} onChanged={t.changed} />)
    await act(async () => finish({ apps: [item] })); expect(screen.queryByText(/UNTRUSTED_TITLE/)).toBeNull()
    t.view.rerender(<AgentThreadHtmlSaved scope={scope} enabled onChanged={t.changed} />); await refresh()
    let finishRestore!: (value: unknown) => void; h.restore.mockImplementationOnce(() => new Promise(resolve => { finishRestore = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.restore' })); t.view.unmount()
    await act(async () => finishRestore({ app: { id: 'old' } })); expect(t.changed).not.toHaveBeenCalled()
  })
})
