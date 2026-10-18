import { describe, expect, it } from 'vitest'
import {
  createChatPageRunLifecycle,
  createIdleChatPageRunLifecycleState,
  isChatPageRunActive,
  isChatPageRunTerminal,
  markChatPageRunRead,
  reduceChatPageRunEvent,
  startChatPageRun,
  clearScopedChatPageRunLifecycles,
  startScopedChatPageRun,
  readScopedChatPageRunLifecycle,
  applyScopedChatPageRunEvent,
  markScopedChatPageRunRead,
  emitChatPageRunLifecycleEvent,
  type ChatPageRunLifecycleState
} from './chatPageRunLifecycle'

const runningState = (runId: string | number): ChatPageRunLifecycleState =>
  startChatPageRun(createIdleChatPageRunLifecycleState(), runId)

describe('chat page run lifecycle', () => {
  it('starts explicitly and exposes the complete status vocabulary', () => {
    expect(createIdleChatPageRunLifecycleState()).toEqual({
      runId: null,
      status: 'idle',
      unread: false
    })
    expect(startChatPageRun(createIdleChatPageRunLifecycleState(), 'run-1')).toEqual({
      runId: 'run-1',
      status: 'running',
      unread: false
    })
    expect(isChatPageRunActive('running')).toBe(true)
    expect(isChatPageRunActive('waiting-tool')).toBe(true)
    expect(isChatPageRunActive('completed')).toBe(false)
    expect(isChatPageRunTerminal('completed')).toBe(true)
    expect(isChatPageRunTerminal('failed')).toBe(true)
    expect(isChatPageRunTerminal('cancelled')).toBe(true)
    expect(isChatPageRunTerminal('interrupted')).toBe(true)
  })

  it('does not infer success from text, attachments, or an error-looking message', () => {
    const state = runningState('run-1')

    expect(reduceChatPageRunEvent(state, { type: 'text-delta', runId: 'run-1' })).toEqual(state)
    expect(reduceChatPageRunEvent(state, { type: 'attachment', runId: 'run-1' })).toEqual(state)
    expect(reduceChatPageRunEvent(state, { type: 'session', runId: 'run-1' })).toEqual(state)
    expect(reduceChatPageRunEvent(state, { type: 'error', runId: 'run-1' })).toEqual({
      runId: 'run-1',
      status: 'failed',
      unread: false
    })
  })

  it('requires explicit waiting-tool and tool-resumed events', () => {
    const running = runningState('run-1')
    const waiting = reduceChatPageRunEvent(running, {
      type: 'waiting-tool',
      runId: 'run-1'
    })

    expect(waiting).toEqual({ runId: 'run-1', status: 'waiting-tool', unread: false })
    expect(reduceChatPageRunEvent(waiting, { type: 'text-delta', runId: 'run-1' })).toEqual(waiting)
    expect(reduceChatPageRunEvent(waiting, { type: 'tool-resumed', runId: 'run-1' })).toEqual({
      runId: 'run-1',
      status: 'running',
      unread: false
    })
  })

  it('accepts only an explicit done event as successful completion and unread output', () => {
    const completed = reduceChatPageRunEvent(runningState('run-1'), {
      type: 'done',
      runId: 'run-1'
    })

    expect(completed).toEqual({ runId: 'run-1', status: 'completed', unread: true })
    expect(reduceChatPageRunEvent(completed, { type: 'text-delta', runId: 'run-1' })).toEqual(
      completed
    )
    expect(reduceChatPageRunEvent(completed, { type: 'done', runId: 'run-1' })).toEqual(completed)
    expect(markChatPageRunRead(completed, 'run-1')).toEqual({
      runId: 'run-1',
      status: 'completed',
      unread: false
    })
  })

  it('keeps failed, cancelled, and interrupted outcomes distinct from success', () => {
    for (const type of ['error', 'cancelled', 'interrupted'] as const) {
      expect(reduceChatPageRunEvent(runningState('run-1'), { type, runId: 'run-1' })).toEqual({
        runId: 'run-1',
        status: type === 'error' ? 'failed' : type,
        unread: false
      })
    }
  })

  it('ignores stale events from an older run after a newer run starts', () => {
    const run2 = startChatPageRun(runningState('run-1'), 'run-2')

    expect(reduceChatPageRunEvent(run2, { type: 'done', runId: 'run-1' })).toEqual(run2)
    expect(reduceChatPageRunEvent(run2, { type: 'error', runId: 'run-1' })).toEqual(run2)
    expect(reduceChatPageRunEvent(run2, { type: 'waiting-tool', runId: 'run-1' })).toEqual(run2)
    expect(run2).toEqual({ runId: 'run-2', status: 'running', unread: false })
  })

  it('does not let a stale read clear a newer run unread flag', () => {
    const completedRun1 = reduceChatPageRunEvent(runningState('run-1'), {
      type: 'done',
      runId: 'run-1'
    })
    const completedRun2 = startChatPageRun(completedRun1, 'run-2')
    const completedRun2WithUnread = reduceChatPageRunEvent(completedRun2, {
      type: 'done',
      runId: 'run-2'
    })

    expect(markChatPageRunRead(completedRun2WithUnread, 'run-1')).toEqual(completedRun2WithUnread)
    expect(markChatPageRunRead(completedRun2WithUnread)).toEqual({
      runId: 'run-2',
      status: 'completed',
      unread: false
    })
  })

  it('tracks independent scoped runs, rejects stale events, and publishes only accepted state', () => {
    clearScopedChatPageRunLifecycles()
    const scope = 'project-1.agent-1'
    const sessionId = 'session-1'

    expect(startScopedChatPageRun({ scope, sessionId, runId: 'run-1' })).toMatchObject({
      scope,
      sessionId,
      runId: 'run-1',
      status: 'running',
      unread: false
    })
    expect(
      emitChatPageRunLifecycleEvent({
        scope,
        sessionId,
        runId: 'run-1',
        status: 'completed',
        timestamp: 10
      })
    ).toMatchObject({ status: 'completed', unread: true, updatedAt: 10 })
    expect(
      emitChatPageRunLifecycleEvent({
        scope,
        sessionId,
        runId: 'run-1',
        status: 'running',
        timestamp: 11
      })
    ).toMatchObject({ status: 'completed', unread: true })

    expect(
      emitChatPageRunLifecycleEvent({
        scope,
        sessionId,
        runId: 'old-run',
        status: 'failed'
      })
    ).toBeNull()
    expect(readScopedChatPageRunLifecycle(scope, sessionId).runId).toBe('run-1')
  })

  it('isolates scope/session keys and does not let stale reads clear a replacement run', () => {
    clearScopedChatPageRunLifecycles()
    startScopedChatPageRun({ scope: 'scope-a', sessionId: 'session-1', runId: 'run-a' })
    startScopedChatPageRun({ scope: 'scope-b', sessionId: 'session-1', runId: 'run-b' })
    expect(readScopedChatPageRunLifecycle('scope-a', 'session-1').runId).toBe('run-a')
    expect(readScopedChatPageRunLifecycle('scope-b', 'session-1').runId).toBe('run-b')

    expect(
      applyScopedChatPageRunEvent({
        scope: 'scope-a',
        sessionId: 'session-1',
        runId: 'run-b',
        status: 'failed'
      })
    ).toBeNull()

    startScopedChatPageRun({ scope: 'scope-a', sessionId: 'session-1', runId: 'run-new' })
    expect(markScopedChatPageRunRead('scope-a', 'session-1', 'run-a').runId).toBe('run-new')
  })

  it('keeps the mutable lifecycle controller explicit and terminal', () => {
    const lifecycle = createChatPageRunLifecycle()

    expect(lifecycle.getState()).toEqual(createIdleChatPageRunLifecycleState())
    expect(lifecycle.start(7)).toEqual({ runId: 7, status: 'running', unread: false })
    expect(lifecycle.dispatch({ type: 'waiting-tool', runId: 7 })).toEqual({
      runId: 7,
      status: 'waiting-tool',
      unread: false
    })
    expect(lifecycle.dispatch({ type: 'tool-resumed', runId: 7 })).toEqual({
      runId: 7,
      status: 'running',
      unread: false
    })
    expect(lifecycle.dispatch({ type: 'done', runId: 7 })).toEqual({
      runId: 7,
      status: 'completed',
      unread: true
    })
  })
})
