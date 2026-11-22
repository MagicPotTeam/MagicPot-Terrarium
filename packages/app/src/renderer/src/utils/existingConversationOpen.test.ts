import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createExistingConversationOpenCoordinator,
  type ExistingConversationTarget,
  type ExistingConversationOpenCoordinator,
  type OpenRequestHandle,
  type LoadLease
} from './existingConversationOpen'

const target: ExistingConversationTarget = { projectId: 'tab-project-p', paneId: 'agent-1', storageScope: 'tab-project-p.agent-1', sessionId: 'existing' }
const completion = { storageScope: target.storageScope, hasTarget: true, loadError: false, pendingDeletion: false }
const generation = { scopeEpoch: 2, readSequence: 3, activationGeneration: 4 }
const deferred = () => {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((done) => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function required<T>(value: T | null): T { expect(value).not.toBeNull(); if (value === null) throw new Error('Expected active request/lease'); return value }
function mounted(coordinator: ExistingConversationOpenCoordinator, handle: OpenRequestHandle) {
  const visible = vi.fn(() => true)
  const paneVisible = vi.fn(() => true)
  const localMember = vi.fn(() => true)
  const presentation = required(coordinator.attachPresentation(handle, visible))
  const pane = required(coordinator.attachPane(presentation, paneVisible))
  const consumer = required(coordinator.attachConsumer(pane))
  const load = required(coordinator.beginLoad(consumer, generation))
  return { visible, paneVisible, localMember, presentation, pane, consumer, load }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('transient exact-existing Open coordinator with injected validation/committed predicates', () => {
  it('installs request and guarded visit synchronously before first async validation, without implicit success', async () => {
    const pending = deferred(); const validate = vi.fn(() => pending.promise)
    const coordinator = createExistingConversationOpenCoordinator({ validate })
    const original = coordinator.getSnapshot(); const listener = vi.fn(); const unsubscribe = coordinator.subscribe(listener)
    expect(coordinator.getSnapshot()).toBe(original)
    const handle = required(coordinator.start(target))
    expect(coordinator.getSnapshot().request?.handle).toBe(handle)
    expect(coordinator.getSnapshot().request?.phase).toBe('preflight')
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
    expect(listener).toHaveBeenCalled(); expect(coordinator.getSnapshot().result).toBeNull()
    expect(validate).toHaveBeenCalledWith(target, expect.any(AbortSignal))
    pending.resolve(true); await flush()
    expect(coordinator.getSnapshot().request?.phase).toBe('navigating')
    expect(coordinator.getSnapshot().result).toBeNull()
    expect(coordinator.getSnapshot()).not.toBe(original)
    unsubscribe()
  })
  it('rejects invalid/mismatched/ambiguous tuples without normalization or any validation/navigation work', () => {
    const validate = vi.fn(async () => true); const coordinator = createExistingConversationOpenCoordinator({ validate })
    for (const invalid of [{ ...target, storageScope: 'other' }, { ...target, projectId: '' }, { ...target, paneId: 'bad\0pane' }, { ...target, sessionId: '' }, { ...target, sessionId: 'bad\x1fid' }, { ...target, paneId: ' a ' }]) expect(coordinator.start(invalid)).toBeNull()
    expect(validate).not.toHaveBeenCalled(); expect(coordinator.getSnapshot().visits).toEqual([])
  })
  it('copies and freezes the target/handle/snapshot so request identity cannot be mutated through caller data', () => {
    const coordinator = createExistingConversationOpenCoordinator({ validate: () => new Promise(() => {}) })
    const supplied = { ...target }; const handle = required(coordinator.start(supplied)); supplied.sessionId = 'changed'
    expect(handle.target.sessionId).toBe('existing'); expect(Object.isFrozen(handle.target)).toBe(true)
    expect(Object.isFrozen(handle)).toBe(true); expect(Object.isFrozen(coordinator.getSnapshot())).toBe(true)
    expect(Object.isFrozen(coordinator.getSnapshot().visits)).toBe(true)
    expect(coordinator.cancel({ ...handle })).toBe(false)
  })
  it('supersedes and aborts old validation, ignoring late old result and stale handle callbacks', async () => {
    const first = deferred(); const second = deferred(); const validate = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const coordinator = createExistingConversationOpenCoordinator({ validate })
    const old = required(coordinator.start(target)); const signal = validate.mock.calls[0][1] as AbortSignal
    const next = required(coordinator.start({ ...target, sessionId: 'next' }))
    expect(next.generation).toBeGreaterThan(old.generation); expect(signal.aborted).toBe(true)
    first.resolve(true); await flush()
    expect(coordinator.getSnapshot().request?.handle).toBe(next)
    expect(coordinator.attachPresentation(old, () => true)).toBeNull(); expect(coordinator.cancel(old)).toBe(false)
    second.resolve(true); await flush(); expect(coordinator.getSnapshot().request?.phase).toBe('navigating')
  })
  it.each(['false', 'reject'] as const)('fails closed on %s preflight without releasing visit guards or choosing fallback', async (failure) => {
    const coordinator = createExistingConversationOpenCoordinator({ validate: failure === 'false' ? async () => false : async () => { throw new Error('Read denied SECRET') } })
    const handle = required(coordinator.start(target)); await flush()
    expect(coordinator.getSnapshot().request).toBeNull()
    expect(coordinator.getSnapshot().result).toMatchObject({ handle, status: 'rejected', reason: 'membership-unavailable' })
    expect(JSON.stringify(coordinator.getSnapshot())).not.toContain('SECRET')
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
  })
  it('expires pending work and ignores a late result; only actual visit departure releases surviving guards', async () => {
    const wait = deferred(); const coordinator = createExistingConversationOpenCoordinator({ validate: () => wait.promise, timeoutMs: 100 })
    const handle = required(coordinator.start(target)); const visit = required(coordinator.getSnapshot().request).visit
    await vi.advanceTimersByTimeAsync(101); wait.resolve(true); await flush()
    expect(coordinator.getSnapshot().result).toMatchObject({ handle, status: 'rejected', reason: 'expired' })
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
    expect(coordinator.depart({ ...visit })).toBe(false)
    expect(coordinator.depart(visit)).toBe(true); expect(coordinator.isGuarded(target.projectId)).toBe(false)
  })
  it('expires through live clock checks on a late await without executing the scheduled deadline callback', async () => {
    const pending = deferred(); let now = 0
    const coordinator = createExistingConversationOpenCoordinator({ validate: () => pending.promise, now: () => now, timeoutMs: 100 })
    const handle = required(coordinator.start(target))
    const timers = vi.getTimerCount()
    expect(timers).toBeGreaterThan(0)
    now = 101; pending.resolve(true); await flush()
    expect(coordinator.getSnapshot().request).toBeNull()
    expect(coordinator.getSnapshot().result).toMatchObject({ handle, status: 'rejected', reason: 'expired' })
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
    expect(vi.getTimerCount()).toBe(timers - 1)
  })
  it('old visit cleanup cannot release a newer same-project visit or cancel its request', async () => {
    const coordinator = createExistingConversationOpenCoordinator({ validate: async () => true })
    required(coordinator.start(target)); const oldVisit = required(coordinator.getSnapshot().request).visit
    const next = required(coordinator.start({ ...target, sessionId: 'next' })); await flush()
    expect(coordinator.depart(oldVisit)).toBe(false)
    expect(coordinator.getSnapshot().request?.handle).toBe(next); expect(coordinator.isGuarded(target.projectId)).toBe(true)
  })
  it('requires committed exact presentation and pane predicates before attaching the target consumer', async () => {
    const coordinator = createExistingConversationOpenCoordinator({ validate: async () => true }); const handle = required(coordinator.start(target))
    expect(coordinator.attachPresentation(handle, () => true)).toBeNull(); await flush()
    expect(coordinator.attachPresentation(handle, () => false)).toBeNull()
    expect(coordinator.attachPresentation(handle, () => { throw new Error('Invalid route') })).toBeNull()
    const presentation = required(coordinator.attachPresentation(handle, () => true))
    expect(coordinator.attachPane(presentation, () => false)).toBeNull()
    const pane = required(coordinator.attachPane(presentation, () => true)); const consumer = required(coordinator.attachConsumer(pane))
    expect(coordinator.beginLoad({ ...consumer }, generation)).toBeNull()
    expect(coordinator.getSnapshot().result).toBeNull()
  })
  it('handles StrictMode detach/setup replacement without terminating request and ignores old cleanup', async () => {
    const coordinator = createExistingConversationOpenCoordinator({ validate: async () => true }); const handle = required(coordinator.start(target)); await flush()
    const first = mounted(coordinator, handle)
    coordinator.detachConsumer(first.consumer); coordinator.detachPane(first.pane); coordinator.detachPresentation(first.presentation)
    expect(coordinator.getSnapshot().request?.handle).toBe(handle)
    const next = mounted(coordinator, handle)
    coordinator.detachConsumer(first.consumer); coordinator.detachPane(first.pane); coordinator.detachPresentation(first.presentation)
    expect(coordinator.commitLoad(first.consumer, first.load, completion)).toBe(false)
    expect(coordinator.commitLoad(next.consumer, next.load, completion)).toBe(true)
  })
  it('does not accept old sessionsLoaded-style completion after a new activation/read generation starts', async () => {
    const coordinator = createExistingConversationOpenCoordinator({ validate: async () => true }); const handle = required(coordinator.start(target)); await flush(); const m = mounted(coordinator, handle)
    const fresh = required(coordinator.beginLoad(m.consumer, { ...generation, readSequence: 4, activationGeneration: 5 }))
    expect(coordinator.commitLoad(m.consumer, m.load, completion)).toBe(false)
    expect(coordinator.beginLoad(m.consumer, generation)).toBeNull()
    expect(coordinator.commitLoad(m.consumer, fresh, completion)).toBe(true)
    const selection = required(await coordinator.validateSelection(m.consumer, fresh, m.localMember))
    required(coordinator.beginLoad(m.consumer, { ...generation, readSequence: 5, activationGeneration: 6 }))
    expect(coordinator.isSelectionCurrent(m.consumer, selection)).toBe(false)
    expect(await coordinator.confirmCommittedSelection(m.consumer, selection, () => true)).toBe(false)
  })
  it.each([{ ...completion, hasTarget: false }, { ...completion, loadError: true }, { ...completion, pendingDeletion: true }, { ...completion, storageScope: 'other' }])('rejects current failed/missing/deleted/wrong-scope load %j rather than selecting latest', async (bad) => {
    const coordinator = createExistingConversationOpenCoordinator({ validate: async () => true }); const handle = required(coordinator.start(target)); await flush(); const m = mounted(coordinator, handle)
    expect(coordinator.commitLoad(m.consumer, m.load, bad)).toBe(false)
    expect(coordinator.getSnapshot().result?.status).toBe('rejected'); expect(coordinator.isGuarded(target.projectId)).toBe(true)
    expect(await coordinator.validateSelection(m.consumer, m.load, m.localMember)).toBeNull()
  })
  it('requires fresh persisted membership and local live/deletion checks after the await before returning a selection lease', async () => {
    const check = deferred(); const validate = vi.fn().mockResolvedValueOnce(true).mockReturnValueOnce(check.promise)
    const coordinator = createExistingConversationOpenCoordinator({ validate }); const handle = required(coordinator.start(target)); await flush(); const m = mounted(coordinator, handle)
    expect(await coordinator.validateSelection(m.consumer, m.load, m.localMember)).toBeNull()
    expect(coordinator.commitLoad(m.consumer, m.load, completion)).toBe(true)
    const pending = coordinator.validateSelection(m.consumer, m.load, m.localMember)
    m.localMember.mockReturnValue(false); check.resolve(true)
    expect(await pending).toBeNull(); expect(coordinator.getSnapshot().result?.status).toBe('rejected')
  })
  it.each(['false', 'throw'] as const)('a second membership callback that replaces the load and returns %s cannot reject that replacement', async (behavior) => {
    const coordinator = createExistingConversationOpenCoordinator({ validate: async () => true })
    const handle = required(coordinator.start(target)); await flush(); const m = mounted(coordinator, handle)
    coordinator.commitLoad(m.consumer, m.load, completion)
    let replacement: ReturnType<typeof coordinator.beginLoad> = null
    const membership = vi.fn().mockReturnValueOnce(true).mockImplementationOnce(() => {
      replacement = coordinator.beginLoad(m.consumer, { ...generation, readSequence: 4, activationGeneration: 5 })
      if (behavior === 'throw') throw new Error('Old callback failed after replacement')
      return false
    })
    expect(await coordinator.validateSelection(m.consumer, m.load, membership)).toBeNull()
    expect(membership).toHaveBeenCalledTimes(2)
    expect(coordinator.getSnapshot().request?.handle).toBe(handle)
    expect(coordinator.getSnapshot().result).toBeNull()
    expect(coordinator.commitLoad(m.consumer, required<LoadLease>(replacement), completion)).toBe(true)
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
  })
  it('invalidates a pending persisted membership result when its consumer is replaced', async () => {
    const check = deferred(); const validate = vi.fn().mockResolvedValueOnce(true).mockReturnValueOnce(check.promise)
    const coordinator = createExistingConversationOpenCoordinator({ validate }); const handle = required(coordinator.start(target)); await flush(); const old = mounted(coordinator, handle)
    coordinator.commitLoad(old.consumer, old.load, completion); const pending = coordinator.validateSelection(old.consumer, old.load, old.localMember)
    const replacement = mounted(coordinator, handle); check.resolve(true)
    expect(await pending).toBeNull(); expect(coordinator.commitLoad(replacement.consumer, replacement.load, completion)).toBe(true)
    expect(coordinator.getSnapshot().result).toBeNull()
  })
  it('does not report success for a ref/event/select call; requires subsequent committed selection and both visible parents', async () => {
    const validate = vi.fn(async () => true); const coordinator = createExistingConversationOpenCoordinator({ validate }); const handle = required(coordinator.start(target)); await flush(); const m = mounted(coordinator, handle)
    coordinator.commitLoad(m.consumer, m.load, completion)
    const selection = required(await coordinator.validateSelection(m.consumer, m.load, m.localMember))
    expect(coordinator.isSelectionCurrent(m.consumer, selection)).toBe(true)
    expect(coordinator.getSnapshot().result).toBeNull()
    expect(await coordinator.confirmCommittedSelection(m.consumer, selection, () => false)).toBe(false)
    expect(coordinator.getSnapshot().result).toBeNull()
    m.visible.mockReturnValue(false)
    expect(await coordinator.confirmCommittedSelection(m.consumer, selection, () => true)).toBe(false)
    expect(coordinator.getSnapshot().result).toBeNull()
    m.visible.mockReturnValue(true); m.paneVisible.mockReturnValue(false)
    expect(await coordinator.confirmCommittedSelection(m.consumer, selection, () => true)).toBe(false)
    m.paneVisible.mockReturnValue(true)
    expect(await coordinator.confirmCommittedSelection(m.consumer, selection, () => true)).toBe(true)
    expect(coordinator.getSnapshot().result).toMatchObject({ handle, status: 'succeeded' })
    expect(coordinator.getSnapshot().request).toBeNull(); expect(validate).toHaveBeenCalledTimes(3)
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
    expect(await coordinator.confirmCommittedSelection(m.consumer, selection, () => true)).toBe(false)
  })
  it('revalidates all tokens, visible parents and exact committed state after final persisted membership await', async () => {
    const final = deferred(); const validate = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockReturnValueOnce(final.promise)
    const coordinator = createExistingConversationOpenCoordinator({ validate }); const handle = required(coordinator.start(target)); await flush(); const m = mounted(coordinator, handle)
    coordinator.commitLoad(m.consumer, m.load, completion); const selection = required(await coordinator.validateSelection(m.consumer, m.load, m.localMember))
    const committed = vi.fn(() => true); const pending = coordinator.confirmCommittedSelection(m.consumer, selection, committed)
    committed.mockReturnValue(false); final.resolve(true)
    expect(await pending).toBe(false); expect(coordinator.getSnapshot().result).toBeNull()
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
  })
  it('a terminal abort callback cannot overwrite a newer request result or release its visit', async () => {
    let abortSignal: AbortSignal | undefined
    const validate = vi.fn((_target: ExistingConversationTarget, signal: AbortSignal) => {
      abortSignal = signal
      return new Promise<boolean>(() => {})
    })
    const coordinator = createExistingConversationOpenCoordinator({ validate })
    const first = required(coordinator.start(target))
    let replacement: OpenRequestHandle | null = null
    abortSignal!.addEventListener('abort', () => { replacement = coordinator.start({ ...target, sessionId: 'replacement' }) }, { once: true })
    expect(coordinator.cancel(first)).toBe(true)
    expect(coordinator.getSnapshot().request?.handle).toBe(replacement)
    expect(coordinator.getSnapshot().result).toBeNull()
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
    const current = required(replacement)
    const visit = required(coordinator.getSnapshot().request).visit
    abortSignal!.addEventListener('abort', () => { replacement = coordinator.start({ ...target, sessionId: 'third' }) }, { once: true })
    expect(coordinator.depart(visit)).toBe(true)
    expect(coordinator.getSnapshot().request?.handle).toBe(replacement)
    expect(coordinator.getSnapshot().request?.handle).not.toBe(current)
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
    expect(coordinator.getSnapshot().result).toBeNull()
    await flush()
  })
  it('departure retains a replacement same-project guard installed by a terminal subscriber', async () => {
    const coordinator = createExistingConversationOpenCoordinator({ validate: async () => true })
    const first = required(coordinator.start(target)); await flush()
    const visit = required(coordinator.getSnapshot().request).visit
    let replacement: OpenRequestHandle | null = null
    coordinator.subscribe(() => {
      if (coordinator.getSnapshot().result?.handle === first) {
        replacement = coordinator.start({ ...target, sessionId: 'replacement' })
      }
    })
    expect(coordinator.depart(visit)).toBe(true)
    expect(coordinator.getSnapshot().request?.handle).toBe(replacement)
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
    await flush()
    expect(coordinator.getSnapshot().request?.phase).toBe('navigating')
  })
  it('does not launch old preflight validation if a synchronous subscriber supersedes it', async () => {
    const validate = vi.fn(async (_requested: ExistingConversationTarget) => true)
    const coordinator = createExistingConversationOpenCoordinator({ validate })
    let replacement: OpenRequestHandle | null = null
    coordinator.subscribe(() => {
      if (coordinator.getSnapshot().request?.handle.target.sessionId === target.sessionId) {
        replacement = coordinator.start({ ...target, sessionId: 'replacement' })
      }
    })
    const old = required(coordinator.start(target)); await flush()
    expect(coordinator.getSnapshot().request?.handle).toBe(replacement)
    expect(coordinator.getSnapshot().request?.handle).not.toBe(old)
    expect(validate.mock.calls.map(([requested]) => requested.sessionId)).toEqual(['replacement'])
  })
  it.each([{ scopeEpoch: 1 }, { scopeEpoch: 1, readSequence: 1, activationGeneration: NaN }, { scopeEpoch: -1, readSequence: 1, activationGeneration: 1 }])('refuses malformed/missing generation fields %j instead of issuing a load lease', async (invalid) => {
    const coordinator = createExistingConversationOpenCoordinator({ validate: async () => true })
    const handle = required(coordinator.start(target)); await flush()
    const presentation = required(coordinator.attachPresentation(handle, () => true))
    const pane = required(coordinator.attachPane(presentation, () => true))
    const consumer = required(coordinator.attachConsumer(pane))
    expect(coordinator.beginLoad(consumer, invalid as typeof generation)).toBeNull()
  })
  it('fails closed when a committed parent predicate detaches/replaces a lease synchronously', async () => {
    const coordinator = createExistingConversationOpenCoordinator({ validate: async () => true })
    const handle = required(coordinator.start(target)); await flush()
    let mutate = false
    let presentation = required(coordinator.attachPresentation(handle, () => {
      if (mutate) coordinator.detachPresentation(presentation)
      return true
    }))
    const pane = required(coordinator.attachPane(presentation, () => true))
    const consumer = required(coordinator.attachConsumer(pane))
    mutate = true
    expect(() => coordinator.beginLoad(consumer, generation)).not.toThrow()
    expect(coordinator.beginLoad(consumer, generation)).toBeNull()
    mutate = false
    presentation = required(coordinator.attachPresentation(handle, () => true))
    const replacementPane = required(coordinator.attachPane(presentation, () => true))
    const replacement = required(coordinator.attachConsumer(replacementPane))
    expect(coordinator.beginLoad(consumer, generation)).toBeNull()
    expect(coordinator.beginLoad(replacement, generation)).not.toBeNull()
  })
  it.each(['false', 'throw', 'true'] as const)('does not let an initial %s membership callback override a newer validation attempt on the same committed load', async outcome => {
    const pending = deferred()
    const validate = vi.fn().mockResolvedValueOnce(true).mockReturnValueOnce(pending.promise)
    const coordinator = createExistingConversationOpenCoordinator({ validate })
    const handle = required(coordinator.start(target)); await flush(); const m = mounted(coordinator, handle)
    expect(coordinator.commitLoad(m.consumer, m.load, completion)).toBe(true)
    let newer!: ReturnType<typeof coordinator.validateSelection>
    const outer = coordinator.validateSelection(m.consumer, m.load, () => {
      newer = coordinator.validateSelection(m.consumer, m.load, m.localMember)
      if (outcome === 'throw') throw new Error('outer callback no longer authoritative')
      return outcome === 'true'
    })
    await flush()
    expect(coordinator.getSnapshot().request?.handle).toBe(handle)
    expect(coordinator.getSnapshot().result).toBeNull()
    expect(validate).toHaveBeenCalledTimes(2)
    pending.resolve(true)
    const selected = required(await newer)
    expect(await outer).toBeNull()
    expect(coordinator.isSelectionCurrent(m.consumer, selected)).toBe(true)
    expect(coordinator.getSnapshot().request?.phase).toBe('verifying-commit')
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
  })
  it.each(['committed', 'membership', 'presentation', 'pane'] as const)('does not settle success after the final %s callback starts another confirmation for the same selection', async boundary => {
    const newerValidation = deferred()
    const validate = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockReturnValueOnce(newerValidation.promise)
    const coordinator = createExistingConversationOpenCoordinator({ validate })
    const handle = required(coordinator.start(target)); await flush(); const m = mounted(coordinator, handle)
    expect(coordinator.commitLoad(m.consumer, m.load, completion)).toBe(true)
    const selection = required(await coordinator.validateSelection(m.consumer, m.load, m.localMember))
    let newer!: ReturnType<typeof coordinator.confirmCommittedSelection>
    let calls = 0
    const reenter = () => {
      if (++calls === 2) newer = coordinator.confirmCommittedSelection(m.consumer, selection, () => true)
      return true
    }
    const committed = boundary === 'committed' ? reenter : () => true
    if (boundary === 'membership') m.localMember.mockImplementation(reenter)
    if (boundary === 'presentation') m.visible.mockImplementation(reenter)
    if (boundary === 'pane') m.paneVisible.mockImplementation(reenter)
    expect(await coordinator.confirmCommittedSelection(m.consumer, selection, committed)).toBe(false)
    expect(coordinator.getSnapshot().request?.handle).toBe(handle)
    expect(coordinator.getSnapshot().result).toBeNull()
    expect(validate).toHaveBeenCalledTimes(4)
    newerValidation.resolve(false)
    expect(await newer).toBe(false)
    expect(coordinator.getSnapshot().request).toBeNull()
    expect(coordinator.getSnapshot().result).toMatchObject({ handle, status: 'rejected', reason: 'membership-unavailable' })
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
  })
  it.each(['committed', 'membership', 'presentation', 'pane'] as const)('does not reclaim confirmation authority after the initial %s callback starts a newer same-selection attempt', async boundary => {
    const pending = deferred(), validate = vi.fn().mockResolvedValue(true)
    const coordinator = createExistingConversationOpenCoordinator({ validate })
    const handle = required(coordinator.start(target)); await flush(); const m = mounted(coordinator, handle)
    expect(coordinator.commitLoad(m.consumer, m.load, completion)).toBe(true)
    const selection = required(await coordinator.validateSelection(m.consumer, m.load, m.localMember))
    validate.mockImplementation(() => pending.promise)
    let newer!: ReturnType<typeof coordinator.confirmCommittedSelection>
    let reentered = false
    const reenter = () => {
      if (!reentered) { reentered = true; newer = coordinator.confirmCommittedSelection(m.consumer, selection, () => true) }
      return true
    }
    const committed = boundary === 'committed' ? reenter : () => true
    if (boundary === 'membership') m.localMember.mockImplementation(reenter)
    if (boundary === 'presentation') m.visible.mockImplementation(reenter)
    if (boundary === 'pane') m.paneVisible.mockImplementation(reenter)
    const outer = coordinator.confirmCommittedSelection(m.consumer, selection, committed)
    await flush()
    expect(validate).toHaveBeenCalledTimes(3)
    expect(coordinator.getSnapshot().result).toBeNull()
    pending.resolve(true)
    expect(await outer).toBe(false); expect(await newer).toBe(true)
    expect(coordinator.getSnapshot().result).toMatchObject({ handle, status: 'succeeded' })
    expect(coordinator.isGuarded(target.projectId)).toBe(true)
  })
  it.each(['presentation', 'pane'] as const)('fences initial %s predicate reentry before launching obsolete same-load persisted validation', async boundary => {
    const pending = deferred(), validate = vi.fn().mockResolvedValueOnce(true).mockReturnValue(pending.promise)
    const coordinator = createExistingConversationOpenCoordinator({ validate })
    const handle = required(coordinator.start(target)); await flush(); const m = mounted(coordinator, handle)
    expect(coordinator.commitLoad(m.consumer, m.load, completion)).toBe(true)
    let newer!: ReturnType<typeof coordinator.validateSelection>, reentered = false
    const reenter = () => {
      if (!reentered) { reentered = true; newer = coordinator.validateSelection(m.consumer, m.load, m.localMember) }
      return true
    }
    if (boundary === 'presentation') m.visible.mockImplementation(reenter)
    else m.paneVisible.mockImplementation(reenter)
    const outer = coordinator.validateSelection(m.consumer, m.load, m.localMember)
    await flush()
    expect(validate).toHaveBeenCalledTimes(2)
    pending.resolve(true)
    expect(await outer).toBeNull()
    expect(coordinator.isSelectionCurrent(m.consumer, required(await newer))).toBe(true)
    expect(coordinator.getSnapshot().result).toBeNull()
  })
  it('rejects when final persisted membership fails, preserving protection for surviving hidden siblings', async () => {
    const validate = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const coordinator = createExistingConversationOpenCoordinator({ validate }); const handle = required(coordinator.start(target)); await flush(); const m = mounted(coordinator, handle)
    coordinator.commitLoad(m.consumer, m.load, completion); const selection = required(await coordinator.validateSelection(m.consumer, m.load, m.localMember))
    expect(await coordinator.confirmCommittedSelection(m.consumer, selection, () => true)).toBe(false)
    expect(coordinator.getSnapshot().result?.status).toBe('rejected'); expect(coordinator.isGuarded(target.projectId)).toBe(true)
    expect(coordinator.depart(required(coordinator.getSnapshot().visits.find(v => v.projectId === target.projectId) ?? null))).toBe(true)
  })
})
