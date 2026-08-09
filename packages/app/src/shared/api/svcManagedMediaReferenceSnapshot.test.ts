import { describe, expect, it } from 'vitest'
import { ServiceValidationError, validateServiceValue } from './apiUtils/serviceValidation'
import { managedMediaSvcDef } from './svcManagedMedia'

const id = 'a'.repeat(64)

describe('managed media reference snapshot contract', () => {
  it('accepts and deduplicates a bounded complete snapshot', () => {
    expect(
      validateServiceValue(
        { version: 1, complete: true, ids: [id, id] },
        managedMediaSvcDef.updateReferenceSnapshot.request
      )
    ).toEqual({ version: 1, complete: true, ids: [id] })
  })

  it.each([
    { version: 1, complete: true, ids: ['bad'] },
    { version: 1, complete: true, ids: [], extra: true },
    { version: 1, complete: 'yes', ids: [] },
    { version: 2, complete: true, ids: [] }
  ])('fails closed for malformed payload %#', (payload) => {
    expect(() =>
      validateServiceValue(payload, managedMediaSvcDef.updateReferenceSnapshot.request)
    ).toThrow(ServiceValidationError)
  })

  it('rejects an excessive payload', () => {
    expect(() =>
      validateServiceValue(
        { version: 1, complete: true, ids: Array.from({ length: 100_001 }, () => id) },
        managedMediaSvcDef.updateReferenceSnapshot.request
      )
    ).toThrow(ServiceValidationError)
  })
})
