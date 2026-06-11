import type { ComfyEvent } from '@shared/comfy/events'

export const COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT = 'comfy:execution-activity-change'

const COMFY_EXECUTION_ACTIVITY_STALE_TIMEOUT_MS = 30 * 60 * 1000
const COMFY_EXECUTION_QUEUE_ACTIVITY_ID = '__comfy_queue_activity__'

export type ComfyExecutionActivityReason =
  | 'execution_start'
  | 'execution_progress'
  | 'execution_finished'
  | 'reset'

export type ComfyExecutionActivitySnapshot = {
  active: boolean
  activePromptIds: string[]
  updatedAt: number
  reason: ComfyExecutionActivityReason
}

type ComfyExecutionActivityChangeDetail = ComfyExecutionActivitySnapshot

const activePromptIds = new Set<string>()
let lastSnapshot: ComfyExecutionActivitySnapshot = {
  active: false,
  activePromptIds: [],
  updatedAt: Date.now(),
  reason: 'reset'
}
let staleResetTimer: ReturnType<typeof setTimeout> | null = null

function getPromptId(event: ComfyEvent): string | null {
  const promptId = (event.data as { prompt_id?: unknown }).prompt_id
  return typeof promptId === 'string' && promptId.trim() ? promptId : null
}

function getQueueRemaining(event: ComfyEvent): number | null {
  if (event.type !== 'status') {
    return null
  }

  const queueRemaining = event.data.status?.exec_info?.queue_remaining
  return typeof queueRemaining === 'number' && Number.isFinite(queueRemaining)
    ? queueRemaining
    : null
}

function emitComfyExecutionActivityChange(reason: ComfyExecutionActivityReason) {
  lastSnapshot = {
    active: activePromptIds.size > 0,
    activePromptIds: Array.from(activePromptIds),
    updatedAt: Date.now(),
    reason
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<ComfyExecutionActivityChangeDetail>(COMFY_EXECUTION_ACTIVITY_CHANGE_EVENT, {
        detail: lastSnapshot
      })
    )
  }
}

function scheduleStaleReset() {
  if (typeof window === 'undefined') {
    return
  }

  if (staleResetTimer !== null) {
    clearTimeout(staleResetTimer)
  }

  if (activePromptIds.size === 0) {
    staleResetTimer = null
    return
  }

  staleResetTimer = setTimeout(() => {
    staleResetTimer = null
    activePromptIds.clear()
    emitComfyExecutionActivityChange('reset')
  }, COMFY_EXECUTION_ACTIVITY_STALE_TIMEOUT_MS)
}

export function getComfyExecutionActivitySnapshot(): ComfyExecutionActivitySnapshot {
  return lastSnapshot
}

export function resetComfyExecutionActivity() {
  activePromptIds.clear()
  if (staleResetTimer !== null) {
    clearTimeout(staleResetTimer)
    staleResetTimer = null
  }
  emitComfyExecutionActivityChange('reset')
}

export function handleComfyExecutionActivityEvent(event: ComfyEvent) {
  const queueRemaining = getQueueRemaining(event)
  if (queueRemaining !== null) {
    if (queueRemaining > 0) {
      if (!activePromptIds.has(COMFY_EXECUTION_QUEUE_ACTIVITY_ID)) {
        activePromptIds.add(COMFY_EXECUTION_QUEUE_ACTIVITY_ID)
        emitComfyExecutionActivityChange('execution_progress')
      }
      scheduleStaleReset()
      return
    }

    if (activePromptIds.delete(COMFY_EXECUTION_QUEUE_ACTIVITY_ID)) {
      emitComfyExecutionActivityChange('execution_finished')
      scheduleStaleReset()
    }
    return
  }

  const promptId = getPromptId(event)

  if (event.type === 'execution_start') {
    if (promptId) {
      activePromptIds.add(promptId)
      emitComfyExecutionActivityChange('execution_start')
      scheduleStaleReset()
    }
    return
  }

  if (event.type === 'progress' || event.type === 'executed' || event.type === 'execution_cached') {
    if (promptId) {
      if (!activePromptIds.has(promptId)) {
        activePromptIds.add(promptId)
        emitComfyExecutionActivityChange('execution_progress')
      }
      scheduleStaleReset()
    }
    return
  }

  if (event.type === 'executing') {
    if (!promptId) {
      return
    }

    if ((event.data as { node?: unknown }).node === null) {
      activePromptIds.delete(promptId)
      emitComfyExecutionActivityChange('execution_finished')
      scheduleStaleReset()
      return
    }

    if (!activePromptIds.has(promptId)) {
      activePromptIds.add(promptId)
      emitComfyExecutionActivityChange('execution_progress')
    }
    scheduleStaleReset()
    return
  }

  if (
    event.type === 'execution_success' ||
    event.type === 'execution_error' ||
    event.type === 'execution_interrupted'
  ) {
    if (promptId) {
      activePromptIds.delete(promptId)
    } else {
      activePromptIds.clear()
    }
    emitComfyExecutionActivityChange('execution_finished')
    scheduleStaleReset()
  }
}
