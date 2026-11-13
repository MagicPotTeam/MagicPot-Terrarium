import React, { Suspense, useEffect, useLayoutEffect } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useExistingConversationOpen, type ExistingConversationChatAdapter, type ExistingConversationOpenInput, type ExistingConversationReadReceipt } from './useExistingConversationOpen'
import { createExistingConversationOpenCoordinator } from '@renderer/utils/existingConversationOpen'

const target = { projectId: 'p', paneId: 'pane', storageScope: 'p.pane', sessionId: 'target' }
afterEach(cleanup)

it('layout removal invalidates pending final acknowledgment before passive cleanup, without an explicit cancel', async () => {
  let finish!: (ok: boolean) => void
  const validate = vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const coordinator = createExistingConversationOpenCoordinator({ validate })
  const handle = coordinator.start(target)!
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const presentation = coordinator.attachPresentation(handle, () => true)!
  const pane = coordinator.attachPane(presentation, () => true)!
  const input: ExistingConversationOpenInput = { coordinator, handle, pane }
  const receipt: ExistingConversationReadReceipt = { storageScope: target.storageScope, token: {}, storedSessionIds: ['target'], generation: { scopeEpoch: 1, readSequence: 1, activationGeneration: 1 } }
  const get = { current: undefined as (() => boolean) | undefined }
  const original = coordinator.confirmCommittedSelection
  vi.spyOn(coordinator, 'confirmCommittedSelection').mockImplementation((consumer, selection, check) => { get.current = check; return original(consumer, selection, check) })
  const passive = vi.fn(); let visibleAtLayoutRemoval: boolean | undefined
  function Consumer() {
    useExistingConversationOpen({ input, storageScope: target.storageScope, active: true, acceptExternalInput: true, sessionsLoaded: true, sessionLoadError: null, selectedSessionId: 'target', committedRead: receipt, startRead: async () => receipt, getReadGeneration: () => receipt.generation, isReadCurrent: () => true, hasLiveSession: () => true, hasCommittedSession: () => true, isPendingDeletion: () => false, select: vi.fn() })
    useEffect(() => () => { passive() }, [])
    return <div>Consumer</div>
  }
  function LayoutRemovalProbe({ removing }: { removing: boolean }) {
    useLayoutEffect(() => {
      if (removing) { expect(passive).not.toHaveBeenCalled(); visibleAtLayoutRemoval = get.current?.() }
    }, [removing])
    return null
  }
  const rendered = render(<><Consumer /><LayoutRemovalProbe removing={false} /></>)
  await waitFor(() => expect(validate).toHaveBeenCalledTimes(3))
  rendered.rerender(<><LayoutRemovalProbe removing /></>)
  expect(visibleAtLayoutRemoval).toBe(false)
  await act(async () => finish(true))
  expect(coordinator.getSnapshot().result?.status).not.toBe('succeeded')
  expect(coordinator.isGuarded(target.projectId)).toBe(true)
})

it('retains the committed selector while a new-scope render is suspended before committing', async () => {
  let finish!: (ok: boolean) => void
  const validate = vi.fn(async () => true).mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const coordinator = createExistingConversationOpenCoordinator({ validate })
  const handle = coordinator.start(target)!
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const presentation = coordinator.attachPresentation(handle, () => true)!
  const pane = coordinator.attachPane(presentation, () => true)!
  const input = { coordinator, handle, pane }
  const receipt: ExistingConversationReadReceipt = { storageScope: target.storageScope, token: {}, storedSessionIds: ['target'], generation: { scopeEpoch: 1, readSequence: 1, activationGeneration: 1 } }
  const oldSelect = vi.fn(); const newSelect = vi.fn(); const never = new Promise<void>(() => {})
  function Consumer({ pending }: { pending: boolean }) {
    const adapter: ExistingConversationChatAdapter = { input, storageScope: pending ? 'other.scope' : target.storageScope, active: true, acceptExternalInput: true, sessionsLoaded: true, sessionLoadError: null, selectedSessionId: null, committedRead: receipt, startRead: async () => receipt, getReadGeneration: () => receipt.generation, isReadCurrent: () => true, hasLiveSession: () => true, hasCommittedSession: () => true, isPendingDeletion: () => false, select: pending ? newSelect : oldSelect }
    useExistingConversationOpen(adapter)
    if (pending) throw never
    return <div>Committed consumer</div>
  }
  const rendered = render(<Suspense fallback={<div>Waiting</div>}><Consumer pending={false} /></Suspense>)
  await waitFor(() => expect(validate).toHaveBeenCalledTimes(2))
  await act(async () => { React.startTransition(() => rendered.rerender(<Suspense fallback={<div>Waiting</div>}><Consumer pending /></Suspense>)) })
  expect(screen.getByText('Committed consumer')).toBeInTheDocument()
  await act(async () => finish(true))
  expect(oldSelect).toHaveBeenCalledWith('target'); expect(newSelect).not.toHaveBeenCalled()
})
