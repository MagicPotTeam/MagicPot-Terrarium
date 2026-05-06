import { QueueItem } from '@shared/comfy/types'

const padDateTimePart = (value: number): string => String(value).padStart(2, '0')

export type QueueAnimationStates = Record<
  string,
  {
    value?: number
    max?: number
  }
>

export const formatQueueTimestamp = (timestamp?: number): string | null => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return null
  }

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return [
    `${date.getFullYear()}-${padDateTimePart(date.getMonth() + 1)}-${padDateTimePart(date.getDate())}`,
    `${padDateTimePart(date.getHours())}:${padDateTimePart(date.getMinutes())}:${padDateTimePart(date.getSeconds())}`
  ].join(' ')
}

export const getQueueItemDisplayLabel = (item: QueueItem): string => {
  return formatQueueTimestamp(item[3]?.created_at) ?? `${item[1].substring(0, 8)}...`
}

const MAX_RUNNING_PROGRESS = 0.99
const clampRunningProgress = (value: number): number =>
  Math.min(MAX_RUNNING_PROGRESS, Math.max(0, value))

export const getQueueItemProgress = (
  animationStates: QueueAnimationStates,
  promptId: string
): number | null => {
  const state = animationStates[promptId]
  if (!state) return null

  const value = typeof state.value === 'number' && Number.isFinite(state.value) ? state.value : null
  if (value === null) return null

  const max = typeof state.max === 'number' && Number.isFinite(state.max) ? state.max : null
  if (max === null || max <= 0) {
    return null
  }

  return clampRunningProgress(value / max)
}

export const getQueueOverallProgress = (
  runningQueueItems: QueueItem[],
  animationStates: QueueAnimationStates
): number | null => {
  if (runningQueueItems.length === 0) {
    return null
  }

  const values = runningQueueItems.map((item) => getQueueItemProgress(animationStates, item[1]))
  const knownValues = values.filter((value): value is number => value !== null)

  if (knownValues.length !== runningQueueItems.length) {
    return null
  }

  return clampRunningProgress(
    knownValues.reduce((sum, value) => sum + value, 0) / knownValues.length
  )
}

export const pruneQueueAnimationStates = (
  animationStates: QueueAnimationStates,
  runningQueueItems: QueueItem[]
): QueueAnimationStates => {
  const runningPromptIds = new Set(runningQueueItems.map((item) => item[1]))
  const nextEntries = Object.entries(animationStates).filter(([promptId]) =>
    runningPromptIds.has(promptId)
  )

  if (nextEntries.length === Object.keys(animationStates).length) {
    return animationStates
  }

  return Object.fromEntries(nextEntries)
}
