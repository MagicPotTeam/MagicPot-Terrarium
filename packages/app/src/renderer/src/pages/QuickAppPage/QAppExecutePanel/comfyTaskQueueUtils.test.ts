import { describe, expect, it } from 'vitest'
import type { GetQueueResp } from '@shared/api/svcComfy'
import type { QueueItem } from '@shared/comfy/types'
import { getComfySingleTaskEntries } from './comfyTaskQueueUtils'

const queueItem = (id: string): QueueItem =>
  [0, id, {}, { client_id: 'magicpot-main', created_at: 1_735_000_000_000 }, []] as QueueItem

describe('getComfySingleTaskEntries', () => {
  it('merges running, pending, and error single tasks with their progress', () => {
    const queue: GetQueueResp = {
      queue_running: [queueItem('running')],
      queue_pending: [queueItem('pending')],
      queue_error: [queueItem('error')]
    }

    expect(
      getComfySingleTaskEntries(queue, {
        running: { value: 3, max: 10 }
      })
    ).toEqual([
      { id: 'running', state: 'running', item: queueItem('running'), progress: 0.3 },
      { id: 'pending', state: 'queued', item: queueItem('pending'), progress: null },
      { id: 'error', state: 'error', item: queueItem('error'), progress: null }
    ])
  })

  it('does not duplicate a task when a queue snapshot contains it in multiple sections', () => {
    const item = queueItem('duplicate')
    const queue: GetQueueResp = {
      queue_running: [item],
      queue_pending: [item],
      queue_error: [item]
    }

    expect(getComfySingleTaskEntries(queue, {})).toHaveLength(1)
  })
})
