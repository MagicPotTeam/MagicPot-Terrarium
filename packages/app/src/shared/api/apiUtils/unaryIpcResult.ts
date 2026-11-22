import { ServiceError, type ServiceErrorTransport } from './serviceValidation'
import { readAgentToolFailurePayload } from '../agentThreadToolFailure'

/** Explicit MAIN-created transport error; ordinary ServiceError/duck payloads never opt in. */
export class IpcServiceError extends ServiceError {}
export type UnaryIpcResult<T> = { ok: true; value: T } | { ok: false; error: ServiceErrorTransport }

const ownData = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value))
  if (Object.getOwnPropertySymbols(value).length || entries.some(([, d]) => !d.enumerable || !('value' in d))) return undefined
  return Object.fromEntries(entries.map(([key, d]) => [key, d.value]))
}

/** Decode AFTER the invoke rejection normalizer. Plain governed rejection records
 * survive contextBridge; constructing an Error here would lose custom fields again.
 */
export function unwrapUnaryIpcResult<T>(value: unknown): T {
  const result = ownData(value)
  if (result?.ok === true && Object.hasOwn(result, 'value') && Object.keys(result).length === 2) return result.value as T
  if (result?.ok === false && Object.hasOwn(result, 'error') && Object.keys(result).length === 2) {
    const error = ownData(result.error)
    if (error && typeof error.message === 'string' && (!Object.hasOwn(error, 'code') || typeof error.code === 'string') && Object.keys(error).every(key => ['message', 'code', 'payload'].includes(key))) {
      if (Object.hasOwn(error, 'payload')) {
        const payload = readAgentToolFailurePayload(error.payload)
        if (!payload) throw new Error('Invalid unary IPC failure receipt.')
        // Deliberate plain asynchronous rejection, not a returned successful DTO.
        throw { message: error.message, ...(error.code !== undefined ? { code: error.code } : {}), payload }
      }
      // An allowed code also needs a plain record to survive contextBridge.
      if (error.code !== undefined) throw { message: error.message || 'Unknown error', code: error.code }
      throw new Error(error.message || 'Unknown error')
    }
  }
  throw new Error('Invalid unary IPC result.')
}
