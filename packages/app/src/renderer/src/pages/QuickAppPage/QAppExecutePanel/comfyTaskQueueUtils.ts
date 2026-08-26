import type { GetQueueResp } from '@shared/api/svcComfy'
import type { QueueItem } from '@shared/comfy/types'
import {
  getQueueItemProgress,
  type QueueAnimationStates
} from '@renderer/components/sidePanelQueueUtils'

export type ComfySingleTaskEntry = {
  id: string
  state: 'queued' | 'running' | 'error'
  item: QueueItem
  progress: number | null
}

export const getComfySingleTaskEntries = (
  queue: GetQueueResp,
  animationStates: QueueAnimationStates
): ComfySingleTaskEntry[] => {
  const entries: ComfySingleTaskEntry[] = []
  const seen = new Set<string>()
  const append = (state: ComfySingleTaskEntry['state'], items: QueueItem[] | undefined) => {
    for (const item of items ?? []) {
      const id = String(item[1] || '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      entries.push({
        id,
        state,
        item,
        progress: state === 'running' ? getQueueItemProgress(animationStates, id) : null
      })
    }
  }

  append('running', queue.queue_running)
  append('queued', queue.queue_pending)
  append('error', queue.queue_error)
  return entries
}
