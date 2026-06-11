import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComfyEvent } from '@shared/comfy/events'
import {
  COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT,
  getComfyExecutionActivitySnapshot,
  handleComfyExecutionActivityEvent,
  resetComfyExecutionActivity
} from './comfyExecutionActivity'

const STALE_TIMEOUT_MS = 30 * 60 * 1000

function createExecutionStartEvent(promptId: string): ComfyEvent {
  return {
    type: 'execution_start',
    data: {
      prompt_id: promptId,
      timestamp: Date.now()
    }
  }
}

function createProgressEvent(promptId: string): ComfyEvent {
  return {
    type: 'progress',
    data: {
      prompt_id: promptId,
      value: 1,
      max: 2
    }
  }
}

function createExecutingEvent(promptId: string, node: string | null): ComfyEvent {
  return {
    type: 'executing',
    data: {
      prompt_id: promptId,
      node
    }
  }
}

function createStatusEvent(queueRemaining: number): ComfyEvent {
  return {
    type: 'status',
    data: {
      sid: 'test-session',
      status: {
        exec_info: {
          queue_remaining: queueRemaining
        }
      }
    }
  }
}

describe('comfyExecutionActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetComfyExecutionActivity()
  })

  afterEach(() => {
    resetComfyExecutionActivity()
    vi.useRealTimers()
  })

  it('marks execution active on start/progress and clears it when execution finishes', () => {
    const changes: Array<ReturnType<typeof getComfyExecutionActivitySnapshot>> = []
    const handleChange = (event: Event) => {
      changes.push(
        (event as CustomEvent<ReturnType<typeof getComfyExecutionActivitySnapshot>>).detail
      )
    }
    window.addEventListener(COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT, handleChange)

    try {
      handleComfyExecutionActivityEvent(createExecutionStartEvent('prompt-a'))

      expect(getComfyExecutionActivitySnapshot()).toMatchObject({
        active: true,
        activePromptIds: ['prompt-a'],
        reason: 'execution_start'
      })

      handleComfyExecutionActivityEvent(createProgressEvent('prompt-b'))

      expect(getComfyExecutionActivitySnapshot()).toMatchObject({
        active: true,
        activePromptIds: ['prompt-a', 'prompt-b'],
        reason: 'execution_progress'
      })

      handleComfyExecutionActivityEvent(createExecutingEvent('prompt-a', null))

      expect(getComfyExecutionActivitySnapshot()).toMatchObject({
        active: true,
        activePromptIds: ['prompt-b'],
        reason: 'execution_finished'
      })

      handleComfyExecutionActivityEvent({
        type: 'execution_success',
        data: {
          prompt_id: 'prompt-b',
          timestamp: Date.now()
        }
      })

      expect(getComfyExecutionActivitySnapshot()).toMatchObject({
        active: false,
        activePromptIds: [],
        reason: 'execution_finished'
      })
      expect(changes.some((change) => change.active)).toBe(true)
    } finally {
      window.removeEventListener(COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT, handleChange)
    }
  })

  it('uses Comfy queue status as a busy signal when no prompt id is available', () => {
    handleComfyExecutionActivityEvent(createStatusEvent(3))

    expect(getComfyExecutionActivitySnapshot()).toMatchObject({
      active: true,
      reason: 'execution_progress'
    })
    expect(getComfyExecutionActivitySnapshot().activePromptIds).toHaveLength(1)

    handleComfyExecutionActivityEvent(createStatusEvent(0))

    expect(getComfyExecutionActivitySnapshot()).toMatchObject({
      active: false,
      activePromptIds: [],
      reason: 'execution_finished'
    })
  })

  it('keeps refreshing the stale reset timer while execution events continue', () => {
    handleComfyExecutionActivityEvent(createExecutionStartEvent('prompt-a'))

    vi.advanceTimersByTime(STALE_TIMEOUT_MS - 1)
    handleComfyExecutionActivityEvent(createProgressEvent('prompt-a'))
    vi.advanceTimersByTime(1)

    expect(getComfyExecutionActivitySnapshot()).toMatchObject({
      active: true,
      activePromptIds: ['prompt-a']
    })

    vi.advanceTimersByTime(STALE_TIMEOUT_MS - 2)

    expect(getComfyExecutionActivitySnapshot()).toMatchObject({
      active: true,
      activePromptIds: ['prompt-a']
    })

    vi.advanceTimersByTime(1)

    expect(getComfyExecutionActivitySnapshot()).toMatchObject({
      active: false,
      activePromptIds: [],
      reason: 'reset'
    })
  })
})
