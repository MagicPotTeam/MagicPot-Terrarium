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

  it('accepts positive persisted reference counts and fills legacy IDs with one', () => {
    expect(
      validateServiceValue(
        {
          version: 1,
          complete: true,
          ids: [id, 'b'.repeat(64)],
          referenceCounts: { [id]: 3 }
        },
        managedMediaSvcDef.updateReferenceSnapshot.request
      )
    ).toEqual({
      version: 1,
      complete: true,
      ids: [id, 'b'.repeat(64)],
      referenceCounts: { [id]: 3, ['b'.repeat(64)]: 1 }
    })
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

  it.each([
    { version: 1, complete: true, ids: [id], referenceCounts: { [id]: 0 } },
    { version: 1, complete: true, ids: [id], referenceCounts: { [id]: -1 } },
    { version: 1, complete: true, ids: [id], referenceCounts: { ['b'.repeat(64)]: 1 } }
  ])('rejects invalid persisted reference counts %#', (payload) => {
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
