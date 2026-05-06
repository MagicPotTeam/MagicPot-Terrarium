import { describe, expect, it } from 'vitest'
import type { QueueItem } from '@shared/comfy/types'
import {
  formatQueueTimestamp,
  getQueueItemDisplayLabel,
  getQueueItemProgress,
  getQueueOverallProgress,
  pruneQueueAnimationStates
} from './sidePanelQueueUtils'

const createQueueItem = (promptId: string, createdAt?: number): QueueItem =>
  [
    0,
    promptId,
    {},
    {
      client_id: 'client-1',
      created_at: createdAt
    },
    []
  ] as QueueItem

describe('sidePanelQueueUtils', () => {
  it('formats queue timestamps as local datetime strings with second precision', () => {
    const createdAt = new Date(2026, 3, 2, 22, 48, 29).getTime()

    expect(formatQueueTimestamp(createdAt)).toBe('2026-04-02 22:48:29')
  })

  it('falls back to a shortened prompt id when no timestamp is available', () => {
    expect(getQueueItemDisplayLabel(createQueueItem('prompt-abcdef12'))).toBe('prompt-a...')
  })

  it('normalizes per-item queue progress', () => {
    expect(getQueueItemProgress({ 'prompt-1': { value: 2, max: 4 } }, 'prompt-1')).toBe(0.5)
    expect(getQueueItemProgress({ 'prompt-1': { value: 4, max: 4 } }, 'prompt-1')).toBe(0.99)
    expect(getQueueItemProgress({ 'prompt-1': { value: 5, max: 4 } }, 'prompt-1')).toBe(0.99)
    expect(getQueueItemProgress({ 'prompt-1': { value: 1, max: 0 } }, 'prompt-1')).toBeNull()
    expect(getQueueItemProgress({}, 'missing')).toBeNull()
  })

  it('averages queue progress across running items when progress is known', () => {
    const running = [createQueueItem('prompt-1'), createQueueItem('prompt-2')]

    expect(
      getQueueOverallProgress(running, {
        'prompt-1': { value: 1, max: 4 },
        'prompt-2': { value: 3, max: 4 }
      })
    ).toBe(0.5)

    expect(getQueueOverallProgress(running, {})).toBeNull()
    expect(
      getQueueOverallProgress(running, {
        'prompt-1': { value: 1, max: 4 }
      })
    ).toBeNull()
  })

  it('drops stale animation state once a prompt leaves the running queue', () => {
    expect(
      pruneQueueAnimationStates(
        {
          'prompt-1': { value: 1, max: 4 },
          'prompt-2': { value: 2, max: 4 }
        },
        [createQueueItem('prompt-2')]
      )
    ).toEqual({
      'prompt-2': { value: 2, max: 4 }
    })
  })
})
