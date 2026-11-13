export type ExistingConversationTarget = Readonly<{
  projectId: string
  paneId: string
  storageScope: string
  sessionId: string
}>
export type ExistingConversationProtection = Readonly<{
  storageScope: string
  /** Synchronous protection policy only, never membership or Open success authority. */
  isProtected: () => boolean
}>
export type OpenRequestHandle = Readonly<{
  requestId: string
  generation: number
  target: ExistingConversationTarget
}>
export type OpenVisit = Readonly<{ projectId: string; token: object }>
export type OpenLease<Kind extends string> = Readonly<{ kind: Kind; sequence: number }>
export type PresentationLease = OpenLease<'presentation'>
export type PaneLease = OpenLease<'pane'>
export type ConsumerLease = OpenLease<'consumer'>
export type LoadLease = OpenLease<'load'>
export type SelectionLease = OpenLease<'selection'>
export type OpenPhase =
  | 'preflight'
  | 'navigating'
  | 'waiting-for-load'
  | 'selecting'
  | 'verifying-commit'
export type OpenFailure =
  | 'superseded'
  | 'cancelled'
  | 'expired'
  | 'membership-unavailable'
  | 'load-failed'
  | 'destination-lost'
export type OpenSnapshot = Readonly<{
  request: Readonly<{
    handle: OpenRequestHandle
    phase: OpenPhase
    visit: OpenVisit
    deadlineAt: number
  }> | null
  visits: readonly OpenVisit[]
  result: Readonly<{
    handle: OpenRequestHandle
    status: 'succeeded' | 'rejected'
    reason?: OpenFailure
  }> | null
}>
export type LoadCompletion = Readonly<{
  storageScope: string
  hasTarget: boolean
  loadError: boolean
  pendingDeletion: boolean
}>
export type OpenLoadGeneration = Readonly<{
  scopeEpoch: number
  readSequence: number
  activationGeneration: number
}>
export type OpenCoordinatorDependencies = {
  /** Strict current owner AND persisted exact session/tombstone validation at each stage. */
  validate: (target: ExistingConversationTarget, signal: AbortSignal) => Promise<boolean>
  now?: () => number
  timeoutMs?: number
}
export interface ExistingConversationOpenCoordinator {
  getSnapshot(): OpenSnapshot
  subscribe(listener: () => void): () => void
  start(target: ExistingConversationTarget): OpenRequestHandle | null
  cancel(handle: OpenRequestHandle, reason?: OpenFailure): boolean
  isGuarded(projectId: string): boolean
  /** Actual departure only, never an effect cleanup/setup replay or request terminal state. */
  depart(visit: OpenVisit): boolean
  attachPresentation(
    handle: OpenRequestHandle,
    checkCommittedVisible: () => boolean
  ): PresentationLease | null
  detachPresentation(lease: PresentationLease): void
  attachPane(presentation: PresentationLease, checkCommittedPane: () => boolean): PaneLease | null
  detachPane(lease: PaneLease): void
  attachConsumer(pane: PaneLease): ConsumerLease | null
  detachConsumer(lease: ConsumerLease): void
  beginLoad(consumer: ConsumerLease, generation: OpenLoadGeneration): LoadLease | null
  commitLoad(consumer: ConsumerLease, load: LoadLease, completion: LoadCompletion): boolean
  validateSelection(
    consumer: ConsumerLease,
    load: LoadLease,
    checkCurrentLocalMembership: () => boolean
  ): Promise<SelectionLease | null>
  isSelectionCurrent(consumer: ConsumerLease, selection: SelectionLease): boolean
  confirmCommittedSelection(
    consumer: ConsumerLease,
    selection: SelectionLease,
    checkCommittedExactSelection: () => boolean
  ): Promise<boolean>
}

type ActiveRequest = {
  handle: OpenRequestHandle
  visit: OpenVisit
  deadlineAt: number
  phase: OpenPhase
  abort: AbortController
  timer?: ReturnType<typeof setTimeout>
  presentation?: { lease: PresentationLease; check: () => boolean }
  pane?: { lease: PaneLease; check: () => boolean }
  consumer?: ConsumerLease
  load?: { lease: LoadLease; generation: OpenLoadGeneration; committed: boolean }
  selection?: { lease: SelectionLease; localMember: () => boolean }
  validationSequence: number
  confirmationSequence: number
}
let coordinatorSequence = 0
const safe = (check: () => boolean): boolean => {
  try {
    return check() === true
  } catch {
    return false
  }
}
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value &&
  value.length <= 512 &&
  value.trim() === value &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

/**
 * Transient renderer coordinator, separate from the source page and navigation effects.
 * Lease identity, not serializable IDs/events, correlates current consumers. Committed
 * predicates must come from real parent/Chat adapters; this module cannot prove them.
 */
export function createExistingConversationOpenCoordinator(
  deps: OpenCoordinatorDependencies
): ExistingConversationOpenCoordinator {
  const instance = ++coordinatorSequence
  const now = deps.now ?? Date.now
  const timeout =
    Number.isFinite(deps.timeoutMs) && (deps.timeoutMs ?? 0) > 0
      ? Math.min(deps.timeoutMs!, 60000)
      : 15000
  let requestSequence = 0
  let leaseSequence = 0
  let active: ActiveRequest | null = null
  let result: OpenSnapshot['result'] = null
  const visits = new Map<string, OpenVisit>()
  const listeners = new Set<() => void>()
  let snapshot: OpenSnapshot = Object.freeze({ request: null, visits: Object.freeze([]), result })
  const publish = () => {
    snapshot = Object.freeze({
      request: active
        ? Object.freeze({
            handle: active.handle,
            phase: active.phase,
            visit: active.visit,
            deadlineAt: active.deadlineAt
          })
        : null,
      visits: Object.freeze([...visits.values()]),
      result
    })
    // A subscriber must not prevent cleanup/expiry or turn a notification into a load failure.
    for (const listener of [...listeners]) {
      try { listener() } catch { /* Subscriber errors do not alter coordinator authority. */ }
    }
  }
  const lease = <Kind extends string>(kind: Kind): OpenLease<Kind> =>
    Object.freeze({ kind, sequence: ++leaseSequence })
  const finish = (current: ActiveRequest, status: 'succeeded' | 'rejected', reason?: OpenFailure) => {
    if (active !== current) return
    active = null
    clearTimeout(current.timer)
    result = Object.freeze({ handle: current.handle, status, ...(reason ? { reason } : {}) })
    // Abort listeners can start/settle a newer request synchronously. Commit old
    // terminal state before callbacks, and never write it again after they return.
    current.abort.abort()
    // Do not release visit protection: empty hidden siblings must not auto-create after terminal state.
    publish()
  }
  const live = (current: ActiveRequest | null): current is ActiveRequest => {
    if (!current || active !== current || current.abort.signal.aborted) return false
    if (now() >= current.deadlineAt) {
      finish(current, 'rejected', 'expired')
      return false
    }
    return true
  }
  const phase = (current: ActiveRequest, next: OpenPhase) => {
    if (current.phase !== next) { current.phase = next; publish() }
  }
  const resetLoad = (current: ActiveRequest) => {
    current.load = undefined
    current.selection = undefined
    current.validationSequence++
    current.confirmationSequence++
  }
  const visible = (current: ActiveRequest): boolean => {
    const presentation = current.presentation
    const pane = current.pane
    return (
      live(current) &&
      !!presentation &&
      !!pane &&
      safe(presentation.check) &&
      safe(pane.check) &&
      current.presentation === presentation &&
      current.pane === pane &&
      live(current)
    )
  }
  const loadCurrent = (current: ActiveRequest | null, consumer: ConsumerLease, load: LoadLease) =>
    live(current) && current.consumer === consumer && current.load?.lease === load
  const selectionCurrent = (
    current: ActiveRequest | null,
    consumer: ConsumerLease,
    selection: SelectionLease
  ): current is ActiveRequest =>
    live(current) &&
    current.consumer === consumer &&
    current.load?.committed === true &&
    current.selection?.lease === selection
  const validated = async (current: ActiveRequest): Promise<boolean> => {
    try { return (await deps.validate(current.handle.target, current.abort.signal)) === true }
    catch { return false }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: (input) => {
      let target: ExistingConversationTarget
      try {
        if (
          !input ||
          !validId(input.projectId) ||
          !validId(input.paneId) ||
          !validId(input.sessionId) ||
          input.storageScope !== `${input.projectId}.${input.paneId}` ||
          (!visits.has(input.projectId) && visits.size >= 256)
        ) return null
        target = Object.freeze({
          projectId: input.projectId,
          paneId: input.paneId,
          storageScope: input.storageScope,
          sessionId: input.sessionId
        })
      } catch { return null }
      const old = active
      const generation = ++requestSequence
      const handle = Object.freeze({ requestId: `open-${instance}-${generation}`, generation, target })
      const visit: OpenVisit = Object.freeze({ projectId: target.projectId, token: Object.freeze({}) })
      const current: ActiveRequest = {
        handle, visit, phase: 'preflight', deadlineAt: now() + timeout,
        abort: new AbortController(), validationSequence: 0, confirmationSequence: 0
      }
      // Install before abort callbacks, subscribers, first await or any future navigation adapter.
      active = current
      visits.set(target.projectId, visit)
      result = null
      current.timer = setTimeout(() => finish(current, 'rejected', 'expired'), timeout)
      if (old) { clearTimeout(old.timer); old.abort.abort('superseded') }
      publish()
      void (async () => {
        if (!live(current)) return
        const accepted = await validated(current)
        if (!live(current)) return
        if (!accepted) { finish(current, 'rejected', 'membership-unavailable'); return }
        phase(current, 'navigating')
      })()
      return handle
    },
    cancel: (handle, reason = 'cancelled') => {
      const current = active
      if (!live(current) || current.handle !== handle) return false
      finish(current, 'rejected', reason)
      return true
    },
    isGuarded: (projectId) => visits.has(projectId),
    depart: (visit) => {
      if (visits.get(visit.projectId) !== visit) return false
      // Remove this exact visit before terminal callbacks can install its replacement.
      visits.delete(visit.projectId)
      if (active?.visit === visit) finish(active, 'rejected', 'destination-lost')
      else publish()
      return true
    },
    attachPresentation: (handle, check) => {
      const current = active
      if (!live(current) || current.handle !== handle || current.phase === 'preflight' || !safe(check) || !live(current) || current.handle !== handle) return null
      const next = lease('presentation')
      current.presentation = { lease: next, check }
      current.pane = undefined
      current.consumer = undefined
      resetLoad(current)
      phase(current, 'waiting-for-load')
      return live(current) && current.presentation?.lease === next ? next : null
    },
    detachPresentation: (value) => {
      const current = active
      if (!live(current) || current.presentation?.lease !== value) return
      current.presentation = undefined
      current.pane = undefined
      current.consumer = undefined
      resetLoad(current)
      phase(current, 'navigating')
    },
    attachPane: (presentation, check) => {
      const current = active
      const parent = current?.presentation
      if (!live(current) || !parent || parent.lease !== presentation || !safe(parent.check) || !safe(check) || !live(current) || current.presentation !== parent) return null
      const next = lease('pane')
      current.pane = { lease: next, check }
      current.consumer = undefined
      resetLoad(current)
      phase(current, 'waiting-for-load')
      return live(current) && current.pane?.lease === next ? next : null
    },
    detachPane: (value) => {
      const current = active
      if (!live(current) || current.pane?.lease !== value) return
      current.pane = undefined
      current.consumer = undefined
      resetLoad(current)
      phase(current, 'waiting-for-load')
    },
    attachConsumer: (pane) => {
      const current = active
      if (!live(current) || current.pane?.lease !== pane || !visible(current) || current.pane?.lease !== pane) return null
      const next = lease('consumer')
      current.consumer = next
      resetLoad(current)
      phase(current, 'waiting-for-load')
      return live(current) && current.consumer === next ? next : null
    },
    detachConsumer: (value) => {
      const current = active
      if (!live(current) || current.consumer !== value) return
      current.consumer = undefined
      resetLoad(current)
      phase(current, 'waiting-for-load')
    },
    beginLoad: (consumer, generation) => {
      const current = active
      if (!live(current) || current.consumer !== consumer || !visible(current) || current.consumer !== consumer) return null
      if (!generation || typeof generation !== 'object') return null
      const nextGeneration = {
        scopeEpoch: generation.scopeEpoch,
        readSequence: generation.readSequence,
        activationGeneration: generation.activationGeneration
      }
      if (!Object.values(nextGeneration).every((value) => Number.isSafeInteger(value) && value >= 0)) return null
      const previous = current.load?.generation
      if (previous && (nextGeneration.scopeEpoch < previous.scopeEpoch || nextGeneration.readSequence <= previous.readSequence || nextGeneration.activationGeneration < previous.activationGeneration)) return null
      const next = lease('load')
      current.load = { lease: next, generation: Object.freeze(nextGeneration), committed: false }
      current.selection = undefined
      current.validationSequence++
      current.confirmationSequence++
      phase(current, 'waiting-for-load')
      return loadCurrent(current, consumer, next) ? next : null
    },
    commitLoad: (consumer, value, completion) => {
      const current = active
      if (!loadCurrent(current, consumer, value) || !current || !visible(current) || !loadCurrent(current, consumer, value) || current.load!.committed) return false
      if (completion.storageScope !== current.handle.target.storageScope || completion.hasTarget !== true || completion.loadError !== false || completion.pendingDeletion !== false) {
        finish(current, 'rejected', 'load-failed')
        return false
      }
      current.load!.committed = true
      phase(current, 'selecting')
      return loadCurrent(current, consumer, value) && current.load!.committed
    },
    validateSelection: async (consumer, value, localMember) => {
      const current = active
      if (!loadCurrent(current, consumer, value) || !current?.load?.committed) return null
      // Claim the attempt before invoking any parent or membership callback. Even
      // same-load reentry must make the older callback/async continuation inert.
      const attempt = ++current.validationSequence
      if (!visible(current) || !loadCurrent(current, consumer, value) || current.validationSequence !== attempt) return null
      const initiallyAccepted = safe(localMember)
      if (!loadCurrent(current, consumer, value) || current.validationSequence !== attempt) return null
      if (!initiallyAccepted) { finish(current, 'rejected', 'membership-unavailable'); return null }
      const accepted = await validated(current)
      if (!loadCurrent(current, consumer, value) || current.validationSequence !== attempt) return null
      if (!accepted) { finish(current, 'rejected', 'membership-unavailable'); return null }
      if (!visible(current) || !loadCurrent(current, consumer, value) || current.validationSequence !== attempt) return null
      const localAccepted = safe(localMember)
      // Predicate callbacks can replace a load or validation attempt synchronously.
      // A stale predicate failure must not reject the replacement of the same request.
      if (!loadCurrent(current, consumer, value) || current.validationSequence !== attempt) return null
      if (!localAccepted) { finish(current, 'rejected', 'membership-unavailable'); return null }
      const next = lease('selection')
      current.selection = { lease: next, localMember }
      phase(current, 'verifying-commit')
      return selectionCurrent(current, consumer, next) && current.validationSequence === attempt ? next : null
    },
    isSelectionCurrent: (consumer, selection) => {
      const current = active
      const selected = current?.selection
      return !!selected && selectionCurrent(current, consumer, selection) && visible(current) && safe(selected.localMember) && selectionCurrent(current, consumer, selection)
    },
    confirmCommittedSelection: async (consumer, selection, committed) => {
      const current = active
      const selected = current?.selection
      if (!selected || !selectionCurrent(current, consumer, selection)) return false
      const attempt = ++current.confirmationSequence
      if (!visible(current) || !safe(committed) || !safe(selected.localMember) || !selectionCurrent(current, consumer, selection) || current.confirmationSequence !== attempt) return false
      const accepted = await validated(current)
      if (!selectionCurrent(current, consumer, selection) || current.confirmationSequence !== attempt) return false
      if (!accepted) { finish(current, 'rejected', 'membership-unavailable'); return false }
      if (!visible(current) || !safe(committed) || !safe(selected.localMember) || !selectionCurrent(current, consumer, selection) || current.confirmationSequence !== attempt) return false
      finish(current, 'succeeded')
      return true
    }
  }
}
