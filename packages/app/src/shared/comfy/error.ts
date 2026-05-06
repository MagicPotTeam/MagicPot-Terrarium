import { JsonDict } from '@shared/utils/utilTypes'

/**
 * InvalidPromptError
 * ComfyUI 的 Prompt 接口错误时返回的 JSON
 */
export type PromptError = {
  error: {
    type: string
    details: string
    message: string
    extra_info: unknown
  }
  node_errors: unknown
}

export function isPromptError(payload: unknown): payload is PromptError {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    payload.error !== null &&
    typeof payload.error === 'object' &&
    'type' in payload.error &&
    typeof payload.error.type === 'string'
  )
}
