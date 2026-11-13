import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHtmlApp } from '@shared/api/agentThreadHtml'
import AgentThreadHtmlPanel from './AgentThreadHtmlPanel'
const mocks = vi.hoisted(() => ({ list: vi.fn(), open: vi.fn(), close: vi.fn(), storage: vi.fn(), initialize: vi.fn(), bind: vi.fn(), save: vi.fn(), saved: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { saveAgentHtmlApp: mocks.save, listSavedAgentHtmlApps: mocks.saved, setAgentHtmlScope: mocks.bind, listAgentHtmlApps: mocks.list, openAgentHtmlApp: mocks.open, closeAgentHtmlApp: mocks.close, agentHtmlStorageStatus: mocks.storage, initializeAgentHtmlStorage: mocks.initialize } }) }))
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
    expect(screen.getByText(/status_ready/)).toBeTruthy()
  })
  it('locks repeated open while pending and does not call a model or invent success on errors', async () => {
    await mount(); let reject!: (e: Error) => void
    mocks.open.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.open' })); fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.open' }))
    expect(mocks.open).toHaveBeenCalledOnce()
    await act(async () => reject(new Error('no verified helper')))
    expect(screen.getByText('chat.agent_html.error')).toBeTruthy(); expect(screen.getByText(/status_ready/)).toBeTruthy()
  })
  it('stops explicitly and shows unknown quarantine without offering restart', async () => {
    await mount(app('open'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.close' })))
    expect(mocks.close).toHaveBeenCalledWith({ route, conversationId: 'chat', appId: 'owned', expectedRevision: 1 })
    mocks.list.mockResolvedValue({ apps: [app('unknown')] }); await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(screen.getByText('chat.agent_html.unknown')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'chat.agent_html.open' })).toBeNull()
  })
  it('discards stale polls and mutation errors after conversation change', async () => {
    const view = await mount(); let resolve!: (value: unknown) => void, reject!: (e: Error) => void
    mocks.list.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    mocks.open.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.open' }))
    mocks.list.mockResolvedValue({ apps: [] }); mocks.storage.mockResolvedValue({ enabled: false }); view.rerender(<AgentThreadHtmlPanel route={route} conversationId="other" active />)
    await act(async () => { resolve({ apps: [{ ...app(), title: 'OLD DOCUMENT' }] }); reject(new Error('old')); await Promise.resolve() })
    expect(screen.queryByRole('region')).toBeNull(); expect(screen.queryByText('OLD DOCUMENT')).toBeNull()
  })
  it('allows stop while an open IPC is unresolved and ignores its later obsolete failure', async () => {
    await mount(); let reject!: (error: Error) => void
    mocks.open.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.open' }))
    expect(screen.getByRole('button', { name: 'chat.agent_html.close' })).not.toBeDisabled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.close' })))
    expect(mocks.close).toHaveBeenCalledOnce()
    await act(async () => reject(new Error('cancelled by user')))
    expect(screen.queryByText('chat.agent_html.error')).toBeNull()
  })
  it('keeps unknown shutdown visible after document expiry', async () => {
    await mount({ ...app('unknown'), expiresAt: Date.now() - 1 })
    expect(screen.getByText('chat.agent_html.unknown')).toBeTruthy()
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
    expect(screen.queryByText('chat.agent_html.error')).toBeNull(); expect(screen.queryByRole('button', { name: 'chat.agent_html.save_snapshot' })).toBeNull()
    mocks.storage.mockResolvedValue({ initialized: true, enabled: true, available: true, saveEnabled: true, unconfirmedRuns: 0, canInitialize: false }); mocks.list.mockResolvedValue({ apps: [{ ...app('closed'), snapshotReady: false }] })
    await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(screen.queryByRole('button', { name: 'chat.agent_html.save_snapshot' })).toBeNull()
  })
  it('does not initialize on polling or open without explicit user initialization', async () => {
    mocks.storage.mockResolvedValue({ enabled: true, initialized: false, available: true, unconfirmedRuns: 0, canInitialize: true, saveEnabled: false })
    await mount(); expect(mocks.initialize).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'chat.agent_html.open' })).toBeDisabled()
    expect(screen.getByText('chat.agent_html.initialize_notice')).toBeTruthy()
    mocks.storage.mockResolvedValue({ enabled: true, initialized: true, available: true, unconfirmedRuns: 0, canInitialize: false, saveEnabled: false })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.initialize' })))
    expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith({ route, conversationId: 'chat', documentToken: 'document-token' })
    expect(screen.getByRole('button', { name: 'chat.agent_html.open' })).not.toBeDisabled()
  })
  it('does not offer a reset when existing storage or count is unknown', async () => {
    mocks.storage.mockResolvedValue({ enabled: true, initialized: true, available: false, unconfirmedRuns: null, canInitialize: false, saveEnabled: false })
    await mount(); expect(screen.queryByRole('button', { name: 'chat.agent_html.initialize' })).toBeNull()
    expect(screen.getByRole('button', { name: 'chat.agent_html.open' })).toBeDisabled()
    expect(screen.getByText('chat.agent_html.storage_unavailable')).toBeTruthy()
  })
  it('keeps unknown run warnings when status IPC fails instead of hiding the retained instance', async () => {
    await mount(app('unknown')); mocks.storage.mockRejectedValue(new Error('storage unavailable'))
    await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(screen.getByText('chat.agent_html.unknown')).toBeTruthy()
  })
  it('does not poll inactive surfaces and removes expired metadata', async () => {
    mocks.storage.mockResolvedValue({ enabled: false, initialized: false, available: false, unconfirmedRuns: null, canInitialize: false, saveEnabled: false })
    const view = await mount(); await act(async () => vi.advanceTimersByTimeAsync(61000)); expect(screen.queryByRole('region')).toBeNull()
    view.rerender(<AgentThreadHtmlPanel route={route} conversationId="chat" active={false} />)
    const count = mocks.list.mock.calls.length; await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(mocks.list).toHaveBeenCalledTimes(count)
  })
})
