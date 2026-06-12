import { QueueItem as ComfyQueueItem } from '@shared/comfy/types'
import { ComfyEvent } from '@shared/comfy/events'
import { getTaskByPromptId, Task, TaskQueueState, TaskStatus } from './taskQueue'

type ComfyEventWithPromptId = Extract<ComfyEvent, { data: { prompt_id: string } }>

function isOnePromptIdField(event: ComfyEvent): event is ComfyEventWithPromptId {
  return (
    event.type === 'progress' ||
    event.type === 'executing' ||
    event.type === 'executed' ||
    event.type === 'execution_start' ||
    event.type === 'execution_success' ||
    event.type === 'execution_error' ||
    event.type === 'execution_interrupted' ||
    event.type === 'execution_cached'
  )
}

export function extractPromptId(event: ComfyEvent): string {
  if (isOnePromptIdField(event)) {
    return event.data.prompt_id
  }

  return ''
}

// 将 Comfy Ws 返回的 Event 中的 prompt_id 转换为内部的 ID
export function comfyEventToTaskEvent(event: ComfyEvent): ComfyEvent {
  const promptId = extractPromptId(event)
  if (!promptId) {
    return event
  }

  const [, task] = getTaskByPromptId(promptId)
  const taskId = task?.id
  if (!taskId) {
    return event
  }
  if (isOnePromptIdField(event)) {
    return {
      type: event.type,
      data: {
        ...event.data,
        prompt_id: taskId // 用内部的 ID 代替 prompt_id
      }
    } as ComfyEvent // 断言一定成立，因为 isOnePromptIdField 的 event 一定有 prompt_id 字段
  }

  // fallback , 不管有没有，都返回原 event
  return event
}

export const taskToComfyQueueItem = (task: Task, index: number): ComfyQueueItem => {
  return [
    index,
    task.id,
    task.payload,
    { client_id: task.client_id, created_at: task.created_at },
    [] // 这里应该是输出节点的 Id ，但不知怎么取，且暂时不用，先空着
  ]
}
