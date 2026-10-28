import { describe, expect, it } from 'vitest'
import { ServiceValidationError, validateServiceValue } from './apiUtils/serviceValidation'
import { fsSvcDef, MAX_FULL_FILE_BYTES } from './svcFs'

describe('svcFs readImageFromPath request', () => {
  const fullPath = 'C:\\synthetic\\image.png'
  const validate = (value: unknown) =>
    validateServiceValue(value, fsSvcDef.readImageFromPath.request)

  it('preserves legacy requests without an explicit byte budget', () => {
    expect(validate({ fullPath })).toEqual({ fullPath })
    expect(validate({ fullPath, maxBytes: undefined })).toEqual({ fullPath })
  })

  it.each([1, 5 * 1024 * 1024, MAX_FULL_FILE_BYTES])(
    'retains the valid caller byte budget %i',
    (maxBytes) => {
      expect(validate({ fullPath, maxBytes })).toEqual({ fullPath, maxBytes })
    }
  )

  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    MAX_FULL_FILE_BYTES + 1,
    Number.MAX_SAFE_INTEGER + 1,
    '5242880',
    null,
    true,
    {},
    []
  ])('rejects an invalid caller byte budget %j', (maxBytes) => {
    expect(() => validate({ fullPath, maxBytes })).toThrow(ServiceValidationError)
    expect(() => validate({ fullPath, maxBytes })).toThrow(/maxBytes/)
  })

  it.each([null, [], {}, { fullPath: '' }, { fullPath: '   ' }, { fullPath: 7 }])(
    'retains request and path validation for %j',
    (value) => {
      expect(() => validate(value)).toThrow(ServiceValidationError)
    }
  )

  it('does not add byte budgets to the other full-path read contracts', () => {
    for (const method of ['readTextFile', 'readFileFromPath'] as const) {
      expect(validateServiceValue({ fullPath, maxBytes: 1 }, fsSvcDef[method].request)).toEqual({
        fullPath
      })
    }
  })
})
