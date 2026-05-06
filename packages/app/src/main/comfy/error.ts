import { JsonDict } from '@shared/utils/utilTypes'

export type ComfyErrorName = 'ComfyPostError'

const COMFY_ERROR_NAMES: ComfyErrorName[] = ['ComfyPostError']

export type ComfyError = {
  name: ComfyErrorName
}

export function isComfyError(error: unknown): error is ComfyError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof (error as { name: unknown }).name === 'string' &&
    COMFY_ERROR_NAMES.includes((error as { name: string }).name as ComfyErrorName)
  )
}

export type ComfyPostError = {
  name: 'ComfyPostError'
  status: number
  payload: JsonDict
}

export function NewComfyPostError(status: number, payload: JsonDict): ComfyPostError {
  return {
    name: 'ComfyPostError',
    status,
    payload
  }
}

export function isComfyPostError(error: unknown): error is ComfyPostError {
  return isComfyError(error) && error.name === 'ComfyPostError'
}
