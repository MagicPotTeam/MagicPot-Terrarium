/**
 * Pure lifecycle state for a ChatPage run.
 *
 * ChatPage currently starts a run locally and receives stream events named
 * `text-delta`, `attachment`, `session`, `done`, and `error`.  The
 * `waiting-tool` and `interrupted` signals are deliberately explicit here:
 * the current IPC stream does not emit them yet, so a caller must add a typed
 * event before using those transitions.  This helper never infers lifecycle
 * state from message contents, message presence, or an error string.
 */

export type ChatPageRunId = string | number

export type ChatPageRunStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting-tool'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type ChatPageRunLifecycleState = {
  runId: ChatPageRunId | null
  status: ChatPageRunStatus
  unread: boolean
}

export type ScopedChatPageRunLifecycleState = ChatPageRunLifecycleState & {
  scope: string
  sessionId: string
  updatedAt: number
}

/**
 * These names mirror the existing renderer stream event names.  Tool waiting,
 * tool resumption, cancellation, and interruption are separate lifecycle
 * signals and must be emitted explicitly by the future caller integration.
 */
export type ChatPageRunEvent =
  | { type: 'text-delta'; runId: ChatPageRunId }
  | { type: 'attachment'; runId: ChatPageRunId }
  | { type: 'session'; runId: ChatPageRunId }
  | { type: 'waiting-tool'; runId: ChatPageRunId }
  | { type: 'tool-resumed'; runId: ChatPageRunId }
  | { type: 'done'; runId: ChatPageRunId }
  | { type: 'error'; runId: ChatPageRunId }
  | { type: 'cancelled'; runId: ChatPageRunId }
  | { type: 'interrupted'; runId: ChatPageRunId }

/** DOM event used by ChatPage producers and AgentWorkspace consumers. */
export const CHAT_PAGE_RUN_LIFECYCLE_EVENT = 'chat:run-lifecycle'

export type ChatPageRunLifecycleEvent = {
  scope: string
  sessionId: string
  runId: ChatPageRunId
  status: Exclude<ChatPageRunStatus, 'idle'>
  /** Explicit unread override; normal completion defaults to unread. */
  unread?: boolean
  timestamp?: number
}

export type ScopedChatPageRunIdentity = {
  scope: string
  sessionId: string
}

const ACTIVE_STATUSES: ReadonlySet<ChatPageRunStatus> = new Set([
  'queued',
  'running',
  'waiting-tool'
])

const TERMINAL_STATUSES: ReadonlySet<ChatPageRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted'
])

export const createIdleChatPageRunLifecycleState = (): ChatPageRunLifecycleState => ({
  runId: null,
  status: 'idle',
  unread: false
})

export const isChatPageRunActive = (status: ChatPageRunStatus): boolean =>
  ACTIVE_STATUSES.has(status)

export const isChatPageRunTerminal = (status: ChatPageRunStatus): boolean =>
  TERMINAL_STATUSES.has(status)

const isSameRun = (state: ChatPageRunLifecycleState, runId: ChatPageRunId): boolean =>
  state.runId !== null && state.runId === runId

/**
 * Start a new run.  Starting is a trusted local operation performed when
 * ChatPage allocates its runId; stream events cannot start or replace a run.
 * This distinction prevents a late event from an older run from replacing a
 * newer runId.
 */
export const startChatPageRun = (
  state: ChatPageRunLifecycleState,
  runId: ChatPageRunId
): ChatPageRunLifecycleState => {
  if (isSameRun(state, runId)) {
    return state.status === 'idle' ? { runId, status: 'running', unread: false } : state
  }

  return {
    runId,
    status: 'running',
    unread: false
  }
}

const transitionToTerminal = (
  state: ChatPageRunLifecycleState,
  status: Exclude<ChatPageRunStatus, 'idle' | 'queued' | 'running' | 'waiting-tool'>
): ChatPageRunLifecycleState => {
  if (!isChatPageRunActive(state.status)) return state

  return {
    ...state,
    status,
    // Only an explicit successful `done` event creates unread output.  Error,
    // cancellation, and interruption are terminal but are not success.
    unread: status === 'completed'
  }
}

/**
 * Apply one explicit event to the current run.
 *
 * Events for any other runId are ignored, including terminal events that
 * arrive after a newer run has started.  A terminal run also cannot be
 * reopened by duplicate or late stream events.
 */
export const reduceChatPageRunEvent = (
  state: ChatPageRunLifecycleState,
  event: ChatPageRunEvent
): ChatPageRunLifecycleState => {
  if (!isSameRun(state, event.runId)) return state

  switch (event.type) {
    case 'text-delta':
    case 'attachment':
    case 'session':
      // A waiting-tool state is not cleared by incidental stream data.  The
      // caller must emit `tool-resumed` explicitly when the tool wait ends.
      return isChatPageRunActive(state.status) ? state : state
    case 'waiting-tool':
      return state.status === 'running' || state.status === 'waiting-tool'
        ? { ...state, status: 'waiting-tool' }
        : state
    case 'tool-resumed':
      return state.status === 'waiting-tool' ? { ...state, status: 'running' } : state
    case 'done':
      return transitionToTerminal(state, 'completed')
    case 'error':
      return transitionToTerminal(state, 'failed')
    case 'cancelled':
      return transitionToTerminal(state, 'cancelled')
    case 'interrupted':
      return transitionToTerminal(state, 'interrupted')
  }
}

/**
 * Mark the current run read.  A runId may be supplied by a caller handling a
 * pane-specific read action; a stale read cannot clear unread state for a
 * newer run.
 */
export const markChatPageRunRead = (
  state: ChatPageRunLifecycleState,
  runId?: ChatPageRunId
): ChatPageRunLifecycleState => {
  if (runId !== undefined && !isSameRun(state, runId)) return state
  if (!state.unread) return state
  return { ...state, unread: false }
}

export type ChatPageRunLifecycleController = {
  getState: () => ChatPageRunLifecycleState
  start: (runId: ChatPageRunId) => ChatPageRunLifecycleState
  dispatch: (event: ChatPageRunEvent) => ChatPageRunLifecycleState
  markRead: (runId?: ChatPageRunId) => ChatPageRunLifecycleState
}

/**
 * Small mutable adapter for a future ChatPage/AgentWorkspace caller.  The
 * transition functions above stay pure so they can also be used with React
 * state or a reducer without introducing a store or persistence contract.
 */
export const createChatPageRunLifecycle = (
  initialState: ChatPageRunLifecycleState = createIdleChatPageRunLifecycleState()
): ChatPageRunLifecycleController => {
  let state = initialState

  return {
    getState: () => state,
    start: (runId) => {
      state = startChatPageRun(state, runId)
      return state
    },
    dispatch: (event) => {
      state = reduceChatPageRunEvent(state, event)
      return state
    },
    markRead: (runId) => {
      state = markChatPageRunRead(state, runId)
      return state
    }
  }
}

const scopedChatPageRunLifecycles = new Map<string, ScopedChatPageRunLifecycleState>()

export const chatPageRunLifecycleKey = (scope: string, sessionId: string): string =>
  `${scope}\u0000${sessionId}`

const createScopedIdleState = (
  identity: ScopedChatPageRunIdentity
): ScopedChatPageRunLifecycleState => ({
  ...identity,
  runId: null,
  status: 'idle',
  unread: false,
  updatedAt: 0
})

/** Read one scope/session state without deriving completion from chat history. */
export const readScopedChatPageRunLifecycle = (
  scope: string,
  sessionId: string
): ScopedChatPageRunLifecycleState => ({
  ...(scopedChatPageRunLifecycles.get(chatPageRunLifecycleKey(scope, sessionId)) ||
    createScopedIdleState({ scope, sessionId }))
})

/** Read all independently tracked session states for one scope. */
export const readScopedChatPageRunLifecycles = (scope: string): ScopedChatPageRunLifecycleState[] =>
  [...scopedChatPageRunLifecycles.entries()]
    .filter(([key]) => key.startsWith(`${scope}\u0000`))
    .map(([, state]) => ({ ...state }))

/** Test/reset hook; does not infer or manufacture a terminal result. */
export const clearScopedChatPageRunLifecycles = (scope?: string): void => {
  if (scope === undefined) {
    scopedChatPageRunLifecycles.clear()
    return
  }

  const prefix = `${scope}\u0000`
  for (const key of scopedChatPageRunLifecycles.keys()) {
    if (key.startsWith(prefix)) scopedChatPageRunLifecycles.delete(key)
  }
}

/** Trusted local start. A producer should use a fresh UUID-like runId per run. */
export const startScopedChatPageRun = (options: {
  scope: string
  sessionId: string
  runId: ChatPageRunId
  status?: 'queued' | 'running'
}): ScopedChatPageRunLifecycleState => {
  const state: ScopedChatPageRunLifecycleState = {
    scope: options.scope,
    sessionId: options.sessionId,
    runId: options.runId,
    status: options.status || 'running',
    unread: false,
    updatedAt: Date.now()
  }
  scopedChatPageRunLifecycles.set(chatPageRunLifecycleKey(options.scope, options.sessionId), state)
  return { ...state }
}

const applyScopedLifecycleStatus = (
  state: ScopedChatPageRunLifecycleState,
  event: ChatPageRunLifecycleEvent
): ScopedChatPageRunLifecycleState => {
  if (state.runId !== event.runId) return state
  if (isChatPageRunTerminal(state.status)) return state

  const nextStatus = event.status
  if (nextStatus === 'queued' && state.status !== 'queued') return state
  if (
    nextStatus === 'running' &&
    state.status !== 'queued' &&
    state.status !== 'running' &&
    state.status !== 'waiting-tool'
  ) {
    return state
  }
  if (nextStatus === 'waiting-tool' && !isChatPageRunActive(state.status)) return state

  const unread =
    event.unread !== undefined
      ? event.unread
      : nextStatus === 'completed'
        ? true
        : nextStatus === 'failed' || nextStatus === 'cancelled' || nextStatus === 'interrupted'
          ? false
          : state.unread

  return { ...state, status: nextStatus, unread, updatedAt: event.timestamp ?? Date.now() }
}

/** Apply only events for the currently started run; stale/cross-scope events return null. */
export const applyScopedChatPageRunEvent = (
  event: ChatPageRunLifecycleEvent
): ScopedChatPageRunLifecycleState | null => {
  const key = chatPageRunLifecycleKey(event.scope, event.sessionId)
  const current = scopedChatPageRunLifecycles.get(key)
  if (!current || current.runId !== event.runId) return null

  const next = applyScopedLifecycleStatus(current, event)
  scopedChatPageRunLifecycles.set(key, next)
  return { ...next }
}

/** Mark unread independently of lifecycle status; stale run reads cannot clear a newer run. */
export const markScopedChatPageRunRead = (
  scope: string,
  sessionId: string,
  runId?: ChatPageRunId
): ScopedChatPageRunLifecycleState => {
  const key = chatPageRunLifecycleKey(scope, sessionId)
  const current =
    scopedChatPageRunLifecycles.get(key) || createScopedIdleState({ scope, sessionId })
  if (runId !== undefined && current.runId !== runId) return { ...current }
  const next = { ...current, unread: false, updatedAt: Date.now() }
  scopedChatPageRunLifecycles.set(key, next)
  return { ...next }
}

/** Producer helper: update the keyed cache and publish the exact DOM event contract. */
export const emitChatPageRunLifecycleEvent = (
  event: ChatPageRunLifecycleEvent
): ScopedChatPageRunLifecycleState | null => {
  const current = scopedChatPageRunLifecycles.get(
    chatPageRunLifecycleKey(event.scope, event.sessionId)
  )
  const next = applyScopedChatPageRunEvent(event)
  const changed =
    next !== null &&
    (!current ||
      current.runId !== next.runId ||
      current.status !== next.status ||
      current.unread !== next.unread)
  if (changed && typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(CHAT_PAGE_RUN_LIFECYCLE_EVENT, {
        detail: {
          scope: next.scope,
          sessionId: next.sessionId,
          runId: next.runId,
          status: next.status,
          unread: next.unread,
          timestamp: next.updatedAt
        }
      })
    )
  }
  return next
}
