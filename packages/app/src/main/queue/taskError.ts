import { ComfyHistory } from '@shared/comfy/types'

/**
 * TaskResultError 就是 ComfyHistory
 * 但 status.status_str 一定是 error
 */
export type TaskResultError = Omit<ComfyHistory, 'status'> & {
  status: Omit<ComfyHistory['status'], 'status_str'> & { status_str: 'error' }
}

export function isTaskResultError(error: unknown): error is TaskResultError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'object' &&
    error.status !== null &&
    'status_str' in error.status &&
    error.status.status_str === 'error' &&
    'messages' in error.status &&
    Array.isArray(error.status.messages)
  )
}
