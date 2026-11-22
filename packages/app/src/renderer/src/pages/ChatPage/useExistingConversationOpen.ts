import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ConsumerLease,
  ExistingConversationOpenCoordinator,
  LoadLease,
  OpenLoadGeneration,
  OpenRequestHandle,
  PaneLease,
  SelectionLease
} from '@renderer/utils/existingConversationOpen'

export type ExistingConversationOpenInput = Readonly<{
  coordinator: ExistingConversationOpenCoordinator
  handle: OpenRequestHandle
  pane: PaneLease
}>
export type ExistingConversationReadReceipt = Readonly<{
  storageScope: string
  token: object
  generation: OpenLoadGeneration
  storedSessionIds: readonly string[]
}>
export type ExistingConversationChatAdapter = {
  input?: ExistingConversationOpenInput
  storageScope: string
  active: boolean
  acceptExternalInput: boolean
  sessionsLoaded: boolean
  sessionLoadError: string | null
  selectedSessionId: string | null
  committedRead: ExistingConversationReadReceipt | null
  startRead: () => Promise<ExistingConversationReadReceipt | null>
  getReadGeneration: () => OpenLoadGeneration
  isReadCurrent: (receipt: ExistingConversationReadReceipt) => boolean
  hasLiveSession: (id: string) => boolean
  hasCommittedSession: (id: string) => boolean
  isPendingDeletion: (id: string) => boolean
  select: (id: string) => void
}
type Binding = { input: ExistingConversationOpenInput; consumer: ConsumerLease }
type Ready = { binding: Binding; load: LoadLease; receipt: ExistingConversationReadReceipt }
type Selected = Ready & { selection: SelectionLease }

/** Current-state correlation, not an atomic storage snapshot or a visibility authority. */
export function useExistingConversationOpen(adapter: ExistingConversationChatAdapter): void {
  const committed = useRef(adapter)
  useLayoutEffect(() => { committed.current = adapter })
  const bindingRef = useRef<Binding | null>(null)
  const layoutLiveRef = useRef(false)
  useLayoutEffect(() => {
    layoutLiveRef.current = true
    return () => {
      // Removal commits before passive cleanup; async membership/ack must fail now.
      layoutLiveRef.current = false
      bindingRef.current = null
    }
  }, [])
  const [ready, setReady] = useState<Ready | null>(null)
  const [selected, setSelected] = useState<Selected | null>(null)
  const { input, storageScope, active, acceptExternalInput } = adapter

  useEffect(() => {
    if (!input || !layoutLiveRef.current) return
    const { coordinator, handle, pane } = input
    if (handle.target.storageScope !== storageScope || !active || !acceptExternalInput) {
      coordinator.cancel(handle, 'destination-lost')
      return
    }
    const consumer = coordinator.attachConsumer(pane)
    if (!consumer) return
    const binding = { input, consumer }
    bindingRef.current = binding
    setReady(null)
    setSelected(null)
    // This starts a new read synchronously. Its sequence is captured before awaiting.
    const pending = committed.current.startRead()
    const load = coordinator.beginLoad(consumer, committed.current.getReadGeneration())
    void (async () => {
      let receipt: ExistingConversationReadReceipt | null = null
      try { receipt = await pending } catch { /* The normal loader also reports failures. */ }
      if (!layoutLiveRef.current || bindingRef.current !== binding) return
      if (!load || !receipt || !committed.current.isReadCurrent(receipt)) {
        coordinator.cancel(handle, 'load-failed')
        return
      }
      setReady({ binding, load, receipt })
    })()
    return () => {
      // StrictMode replay can attach a replacement; stale cleanup cannot detach it.
      if (bindingRef.current === binding) bindingRef.current = null
      coordinator.detachConsumer(consumer)
    }
  }, [input?.coordinator, input?.handle, input?.pane, storageScope, active, acceptExternalInput])

  const localCurrent = (state: Ready) => {
    const current = committed.current
    const { binding, receipt } = state
    const target = binding.input.handle.target
    return layoutLiveRef.current && bindingRef.current === binding &&
      current.input?.handle === binding.input.handle && current.input?.pane === binding.input.pane &&
      current.storageScope === target.storageScope && current.active && current.acceptExternalInput &&
      current.sessionsLoaded && !current.sessionLoadError && current.committedRead === receipt &&
      current.isReadCurrent(receipt) && receipt.storedSessionIds.includes(target.sessionId) &&
      current.hasLiveSession(target.sessionId) && current.hasCommittedSession(target.sessionId) &&
      !current.isPendingDeletion(target.sessionId)
  }
  const localCurrentRef = useRef(localCurrent)
  useLayoutEffect(() => { localCurrentRef.current = localCurrent })

  useEffect(() => {
    if (!ready || bindingRef.current !== ready.binding) return
    const { binding, load, receipt } = ready
    const { coordinator, handle } = binding.input
    if (adapter.committedRead !== receipt) {
      if (!adapter.isReadCurrent(receipt)) coordinator.cancel(handle, 'load-failed')
      return
    }
    if (!coordinator.commitLoad(binding.consumer, load, {
      storageScope,
      hasTarget: receipt.storedSessionIds.includes(handle.target.sessionId) && adapter.hasCommittedSession(handle.target.sessionId),
      loadError: !!adapter.sessionLoadError,
      pendingDeletion: adapter.isPendingDeletion(handle.target.sessionId)
    })) return
    let disposed = false
    void (async () => {
      const selection = await coordinator.validateSelection(binding.consumer, load, () => localCurrentRef.current(ready))
      if (disposed || bindingRef.current !== binding || !selection || !localCurrentRef.current(ready) || !coordinator.isSelectionCurrent(binding.consumer, selection)) return
      // Ordinary select may flush drafts/normalize profile and persist selection. It is not success.
      committed.current.select(handle.target.sessionId)
      setSelected({ ...ready, selection })
    })()
    return () => { disposed = true }
  }, [ready, adapter.committedRead])

  useEffect(() => {
    if (!selected || bindingRef.current !== selected.binding) return
    const { binding, selection } = selected
    const { coordinator, handle } = binding.input
    if (!localCurrentRef.current(selected)) {
      coordinator.cancel(handle, 'load-failed')
      return
    }
    if (adapter.selectedSessionId !== handle.target.sessionId) return
    // Runs only after the exact selected ID and receipt/membership are committed.
    void coordinator.confirmCommittedSelection(binding.consumer, selection, () =>
      localCurrentRef.current(selected) && committed.current.selectedSessionId === handle.target.sessionId
    )
  }, [selected, adapter.selectedSessionId, adapter.committedRead, adapter.active, adapter.acceptExternalInput, adapter.sessionLoadError])
}
