import { describe, expect, it } from 'vitest'
import {
  createChatPageRunLifecycle,
  createIdleChatPageRunLifecycleState,
  isChatPageRunActive,
  isChatPageRunTerminal,
  reduceChatPageRunEvent,
  startChatPageRun,
  clearScopedChatPageRunLifecycles,
  startScopedChatPageRun,
  readScopedChatPageRunLifecycle,
  applyScopedChatPageRunEvent,
  emitChatPageRunLifecycleEvent,
  type ChatPageRunLifecycleState
} from './chatPageRunLifecycle'

const runningState = (runId: string | number): ChatPageRunLifecycleState =>
  startChatPageRun(createIdleChatPageRunLifecycleState(), runId)

describe('chat page run lifecycle', () => {
  it('starts explicitly and exposes the complete status vocabulary', () => {
    expect(createIdleChatPageRunLifecycleState()).toEqual({
      runId: null,
      status: 'idle'
    })
    expect(startChatPageRun(createIdleChatPageRunLifecycleState(), 'run-1')).toEqual({
      runId: 'run-1',
      status: 'running'
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
      status: 'failed'
    })
  })

  it('requires explicit waiting-tool and tool-resumed events', () => {
    const running = runningState('run-1')
    const waiting = reduceChatPageRunEvent(running, {
      type: 'waiting-tool',
      runId: 'run-1'
    })

    expect(waiting).toEqual({ runId: 'run-1', status: 'waiting-tool' })
    expect(reduceChatPageRunEvent(waiting, { type: 'text-delta', runId: 'run-1' })).toEqual(waiting)
    expect(reduceChatPageRunEvent(waiting, { type: 'tool-resumed', runId: 'run-1' })).toEqual({
      runId: 'run-1',
      status: 'running'
    })
  })

  it('accepts only an explicit done event as successful completion', () => {
    const completed = reduceChatPageRunEvent(runningState('run-1'), {
      type: 'done',
      runId: 'run-1'
    })

    expect(completed).toEqual({ runId: 'run-1', status: 'completed' })
    expect(reduceChatPageRunEvent(completed, { type: 'text-delta', runId: 'run-1' })).toEqual(
      completed
    )
    expect(reduceChatPageRunEvent(completed, { type: 'done', runId: 'run-1' })).toEqual(completed)
  })

  it('keeps failed, cancelled, and interrupted outcomes distinct from success', () => {
    for (const type of ['error', 'cancelled', 'interrupted'] as const) {
      expect(reduceChatPageRunEvent(runningState('run-1'), { type, runId: 'run-1' })).toEqual({
        runId: 'run-1',
        status: type === 'error' ? 'failed' : type
      })
    }
  })

  it('ignores stale events from an older run after a newer run starts', () => {
    const run2 = startChatPageRun(runningState('run-1'), 'run-2')

    expect(reduceChatPageRunEvent(run2, { type: 'done', runId: 'run-1' })).toEqual(run2)
    expect(reduceChatPageRunEvent(run2, { type: 'error', runId: 'run-1' })).toEqual(run2)
    expect(reduceChatPageRunEvent(run2, { type: 'waiting-tool', runId: 'run-1' })).toEqual(run2)
    expect(run2).toEqual({ runId: 'run-2', status: 'running' })
  })

  it('tracks independent scoped runs, rejects stale events, and publishes only accepted state', () => {
    clearScopedChatPageRunLifecycles()
    const scope = 'project-1.agent-1'
    const sessionId = 'session-1'

    expect(startScopedChatPageRun({ scope, sessionId, runId: 'run-1' })).toMatchObject({
      scope,
      sessionId,
      runId: 'run-1',
      status: 'running'
    })
    expect(
      emitChatPageRunLifecycleEvent({
        scope,
        sessionId,
        runId: 'run-1',
        status: 'completed',
        timestamp: 10
      })
    ).toMatchObject({ status: 'completed', updatedAt: 10 })
    expect(
      emitChatPageRunLifecycleEvent({
        scope,
        sessionId,
        runId: 'run-1',
        status: 'running',
        timestamp: 11
      })
    ).toMatchObject({ status: 'completed' })

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

  it('isolates scope/session keys and lets a new run replace the old one', () => {
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
    expect(readScopedChatPageRunLifecycle('scope-a', 'session-1').runId).toBe('run-new')
  })

  it('keeps the mutable lifecycle controller explicit and terminal', () => {
    const lifecycle = createChatPageRunLifecycle()

    expect(lifecycle.getState()).toEqual(createIdleChatPageRunLifecycleState())
    expect(lifecycle.start(7)).toEqual({ runId: 7, status: 'running' })
    expect(lifecycle.dispatch({ type: 'waiting-tool', runId: 7 })).toEqual({
      runId: 7,
      status: 'waiting-tool'
    })
    expect(lifecycle.dispatch({ type: 'tool-resumed', runId: 7 })).toEqual({
      runId: 7,
      status: 'running'
    })
    expect(lifecycle.dispatch({ type: 'done', runId: 7 })).toEqual({
      runId: 7,
      status: 'completed'
    })
  })
})
