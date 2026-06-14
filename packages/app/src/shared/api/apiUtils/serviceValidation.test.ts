import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ServerStreaming } from './streaming'
import {
  SERVICE_INTERNAL_ERROR_CODE,
  SERVICE_VALIDATION_ERROR_CODE,
  ServiceError,
  ServiceValidationError,
  isServiceErrorTransport,
  serializeServiceError,
  validateServiceValue,
  withServerStreamingValidation,
  withServiceValidation
} from './serviceValidation'

describe('serviceValidation', () => {
  it('validates values with zod safeParse and returns parsed output', () => {
    const schema = z.object({ count: z.coerce.number().int() })

    expect(validateServiceValue({ count: '2' }, schema, { label: 'demo request' })).toEqual({
      count: 2
    })
  })

  it('throws governed validation errors with issue payloads', () => {
    const schema = z.object({ count: z.number().int() })

    expect(() => validateServiceValue({ count: 'bad' }, schema, { label: 'demo request' })).toThrow(
      ServiceValidationError
    )

    try {
      validateServiceValue({ count: 'bad' }, schema, { label: 'demo request' })
      throw new Error('Expected validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceValidationError)
      const validationError = error as ServiceValidationError
      expect(validationError.code).toBe(SERVICE_VALIDATION_ERROR_CODE)
      expect(validationError.message).toContain('Invalid demo request')
      expect(validationError.payload).toEqual({
        label: 'demo request',
        issues: [
          {
            path: ['count'],
            message: 'Expected number, received string',
            code: 'invalid_type'
          }
        ]
      })
    }
  })

  it('supports predicate validators without requiring zod', () => {
    const isNamed = (value: unknown): value is { name: string } =>
      typeof value === 'object' &&
      value !== null &&
      'name' in value &&
      typeof (value as { name: unknown }).name === 'string'

    expect(validateServiceValue({ name: 'demo' }, isNamed)).toEqual({ name: 'demo' })
    expect(() => validateServiceValue({ name: 1 }, isNamed, { label: 'name request' })).toThrow(
      'Invalid name request'
    )
  })

  it('wraps unary handlers and skips service execution for invalid requests', async () => {
    const handler = vi.fn(async (req: { value: string }) => ({ ok: true, value: req.value }))
    const wrapped = withServiceValidation(handler, {
      methodName: 'svcDemo.ping',
      request: z.object({ value: z.string().min(1) }),
      response: z.object({ ok: z.boolean(), value: z.string() })
    })

    await expect(wrapped({ value: 'demo' })).resolves.toEqual({ ok: true, value: 'demo' })
    await expect(wrapped({ value: '' })).rejects.toMatchObject({
      code: SERVICE_VALIDATION_ERROR_CODE
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('wraps streaming handlers and validates emitted data before forwarding it', async () => {
    const onData = vi.fn()
    const handler = vi.fn(
      async (_req: { value: string }, resp: ServerStreaming<{ chunk: string }>) => {
        resp.onData({ chunk: 'first' })
      }
    )
    const wrapped = withServerStreamingValidation(handler, {
      methodName: 'svcDemo.watch',
      request: z.object({ value: z.string() }),
      data: z.object({ chunk: z.string() })
    })

    await expect(wrapped({ value: 'demo' }, { onData })).resolves.toBeUndefined()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(onData).toHaveBeenCalledWith({ chunk: 'first' })
  })

  it('fails streaming calls before forwarding invalid data', async () => {
    const onData = vi.fn()
    const wrapped = withServerStreamingValidation(
      async (_req: { value: string }, resp: ServerStreaming<{ chunk: string }>) => {
        resp.onData({ chunk: 1 } as unknown as { chunk: string })
      },
      {
        methodName: 'svcDemo.watch',
        data: z.object({ chunk: z.string() })
      }
    )

    await expect(wrapped({ value: 'demo' }, { onData })).rejects.toMatchObject({
      code: SERVICE_VALIDATION_ERROR_CODE
    })
    expect(onData).not.toHaveBeenCalled()
  })

  it('serializes service errors for IPC-safe transport', () => {
    const error = new ServiceError('denied', {
      code: 'E_DENIED',
      payload: { reason: 'policy' }
    })

    expect(serializeServiceError(error)).toEqual({
      message: 'denied',
      code: 'E_DENIED',
      payload: { reason: 'policy' }
    })
  })

  it('normalizes unknown errors with safe messages and JSON payloads', () => {
    expect(serializeServiceError({ message: 'bad input', code: 'E_BAD', detail: 1 })).toEqual({
      message: 'bad input',
      code: 'E_BAD',
      payload: { message: 'bad input', code: 'E_BAD', detail: 1 }
    })
    expect(serializeServiceError('', { includeJsonPayload: false })).toEqual({
      message: 'Unknown error',
      code: SERVICE_INTERNAL_ERROR_CODE
    })
  })

  it('guards service error transport payload shape', () => {
    expect(isServiceErrorTransport({ message: 'failed', code: 'E_FAILED' })).toBe(true)
    expect(isServiceErrorTransport({ message: 'failed', payload: { retry: false } })).toBe(true)
    expect(isServiceErrorTransport({ message: 'failed', payload: new Uint8Array() })).toBe(false)
    expect(isServiceErrorTransport({ message: 1 })).toBe(false)
  })
})
