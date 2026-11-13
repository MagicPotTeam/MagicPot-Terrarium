import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExistingSessionSummaryResult } from '../pages/ChatPage/chatStorage'
import { existingConversationOpenStore as store, useExistingConversationOpenSnapshot, validateExistingConversationTarget } from './existingConversationOpenStore'
import { PROJECTS_STORAGE_KEY } from '../pages/MainPage/projectStore'

const f = vi.hoisted(() => ({ read: vi.fn<(scopes: readonly string[], signal?: AbortSignal) => Promise<ExistingSessionSummaryResult>>() }))
vi.mock('../pages/ChatPage/chatStorage', () => ({ readExistingSessionSummaries: (...args: Parameters<typeof f.read>) => f.read(...args) }))
const target = { projectId: 'tab-project-p', paneId: 'agent-1', storageScope: 'tab-project-p.agent-1', sessionId: 'target' }
const paneKey = `agent.workspace.${target.projectId}`
const tombstone = `magicpot-chat-delete-tombstone:${encodeURIComponent(target.storageScope)}:target`
const row = { storageScope: target.storageScope, sessionId: 'target', title: 'Never authority', titleTruncated: false }
function fixture() {
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([{ id: target.projectId, name: 'Project', chatStorageScopePrefix: target.projectId }]))
  localStorage.setItem(paneKey, '[{"id":"agent-1","enabled":true},{"id":"hidden-disabled","enabled":false}]')
}
beforeEach(() => { localStorage.clear(); fixture(); f.read.mockReset().mockResolvedValue({ status: 'ready', sessions: [row] }) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); const state = store.getSnapshot(); if (state.request) store.cancel(state.request.handle); for (const visit of store.getSnapshot().visits) store.depart(visit); localStorage.clear() })

describe('strict existing-conversation persisted validation; no ordinary loader or normalization', () => {
  it('requires fresh exact enabled owner and strict completed persisted row for every invocation', async () => {
    const signal = new AbortController().signal
    expect(await validateExistingConversationTarget(target, signal)).toBe(true)
    expect(f.read).toHaveBeenCalledWith([target.storageScope], signal)
    f.read.mockResolvedValue({ status: 'ready', sessions: [] })
    expect(await validateExistingConversationTarget(target, signal)).toBe(false)
    expect(f.read).toHaveBeenCalledTimes(2)
  })
  it.each(['unavailable', 'wrong-scope', 'wrong-id', 'duplicate', 'empty'] as const)('rejects %s persisted results without fallback', async failure => {
    if (failure === 'unavailable') f.read.mockResolvedValue({ status: 'unavailable', reason: 'migration-required' })
    else f.read.mockResolvedValue({ status: 'ready', sessions: failure === 'empty' ? [] : failure === 'duplicate' ? [row, row] : [{ ...row, ...(failure === 'wrong-scope' ? { storageScope: 'other.scope' } : { sessionId: 'other' }) }] })
    expect(await validateExistingConversationTarget(target, new AbortController().signal)).toBe(false)
  })
  it.each(['missing-project', 'missing-panes', 'disabled', 'invalid', 'collision'] as const)('rejects %s canonical metadata before any database read', async failure => {
    if (failure === 'missing-project') localStorage.setItem(PROJECTS_STORAGE_KEY, '[]')
    if (failure === 'missing-panes') localStorage.removeItem(paneKey)
    if (failure === 'disabled') localStorage.setItem(paneKey, '[{"id":"agent-1","enabled":false}]')
    if (failure === 'invalid') localStorage.setItem(paneKey, '{')
    if (failure === 'collision') {
      localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([{ id: 'a.b', name: 'AB', chatStorageScopePrefix: 'a.b' }, { id: 'a', name: 'A', chatStorageScopePrefix: 'a' }]))
      localStorage.setItem('agent.workspace.a.b', '[{"id":"c","enabled":true}]'); localStorage.setItem('agent.workspace.a', '[{"id":"b.c","enabled":true}]')
    }
    expect(await validateExistingConversationTarget(target, new AbortController().signal)).toBe(false)
    expect(f.read).not.toHaveBeenCalled()
  })
  it('rejects an inconsistent tuple before reading metadata or database', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem')
    expect(await validateExistingConversationTarget({ ...target, storageScope: 'other.scope' }, new AbortController().signal)).toBe(false)
    expect(get).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })
  it.each(['metadata-changed', 'deleted', 'storage-denied', 'cancelled'] as const)('rechecks %s after awaited persisted membership, even if reader returned ready', async failure => {
    f.read.mockImplementation(async () => {
      if (failure === 'metadata-changed') localStorage.setItem(paneKey, '[{"id":"agent-1","enabled":false}]')
      if (failure === 'deleted') localStorage.setItem(tombstone, '')
      if (failure === 'storage-denied') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Denied') })
      if (failure === 'cancelled') controller.abort()
      return { status: 'ready', sessions: [row] }
    })
    const controller = new AbortController()
    expect(await validateExistingConversationTarget(target, controller.signal)).toBe(false)
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  it('does not normalize, write preferences, restore panes, or read on already-cancelled input', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem')
    const controller = new AbortController(); controller.abort()
    expect(await validateExistingConversationTarget(target, controller.signal)).toBe(false)
    expect(f.read).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
  })
})

it('external store subscription is passive, survives source unmount and retains protection through terminal settlement', async () => {
  function Subscriber() { const state = useExistingConversationOpenSnapshot(); return <div data-testid="state">{state.request?.phase ?? state.result?.status ?? 'idle'}</div> }
  const mounted = render(<Subscriber />)
  expect(screen.getByTestId('state')).toHaveTextContent('idle'); expect(f.read).not.toHaveBeenCalled()
  let handle!: NonNullable<ReturnType<typeof store.start>>
  act(() => { handle = store.start(target)!; expect(store.isGuarded(target.projectId)).toBe(true) })
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('navigating'))
  mounted.unmount(); expect(store.getSnapshot().request?.handle).toBe(handle)
  store.cancel(handle); expect(store.isGuarded(target.projectId)).toBe(true)
  render(<Subscriber />); expect(screen.getByTestId('state')).toHaveTextContent('rejected')
  expect(f.read).toHaveBeenCalledTimes(1)
})
