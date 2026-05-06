import { describe, expect, it } from 'vitest'
import { formatQAppErrorMessage } from './useQAppRunner'
import { QAPP_COMFY_LOGIN_REQUIRED_MESSAGE } from '../utils/qAppErrorMessage'

describe('formatQAppErrorMessage', () => {
  it('normalizes nested ComfyUI login failures from serialized IPC errors', () => {
    const error = {
      payload: {
        error: {
          message: 'Unauthorized: Please login first to use this node.'
        }
      }
    }

    expect(formatQAppErrorMessage(error)).toBe(QAPP_COMFY_LOGIN_REQUIRED_MESSAGE)
  })

  it('maps numeric auth status codes to the QuickApp API guidance when no message is available', () => {
    expect(formatQAppErrorMessage({ status: 401 })).toBe(QAPP_COMFY_LOGIN_REQUIRED_MESSAGE)
    expect(formatQAppErrorMessage({ status: 403 })).toBe(QAPP_COMFY_LOGIN_REQUIRED_MESSAGE)
  })
})
