import { describe, expect, it } from 'vitest'
import {
  normalizeQAppErrorMessage,
  QAPP_COMFY_LOGIN_REQUIRED_MESSAGE,
  QAPP_INPUT_IMAGE_REQUIRED_MESSAGE
} from './qAppErrorMessage'

describe('normalizeQAppErrorMessage', () => {
  it('maps missing image input errors to a friendly message', () => {
    expect(
      normalizeQAppErrorMessage("[Errno 2] No such file or directory: 'input/example.png'")
    ).toBe(QAPP_INPUT_IMAGE_REQUIRED_MESSAGE)
  })

  it('maps ComfyUI login-required errors to a friendly message', () => {
    expect(normalizeQAppErrorMessage('Unauthorized: Please login first to use this node.')).toBe(
      QAPP_COMFY_LOGIN_REQUIRED_MESSAGE
    )
  })

  it('maps generic HTTP auth status errors to the same friendly message', () => {
    expect(normalizeQAppErrorMessage('HTTP 401')).toBe(QAPP_COMFY_LOGIN_REQUIRED_MESSAGE)
    expect(normalizeQAppErrorMessage('HTTP 403 Forbidden')).toBe(QAPP_COMFY_LOGIN_REQUIRED_MESSAGE)
  })

  it('preserves unrelated errors', () => {
    expect(normalizeQAppErrorMessage('network timeout')).toBe('network timeout')
  })
})
