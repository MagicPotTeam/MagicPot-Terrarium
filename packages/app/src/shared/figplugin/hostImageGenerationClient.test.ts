import { describe, expect, it } from 'vitest'
import {
  validateNativeImageGenerationReceipt,
  validateNativeImageGenerationStatus
} from './hostImageGenerationClient'
import * as publicClient from './hostPlanningClient'

const createdAt = 1_800_000_000_000
const receipt = {
  protocol: 1,
  requestId: 'a'.repeat(32),
  proposalId: 'b'.repeat(32),
  status: 'awaiting-approval',
  createdAt,
  expiresAt: createdAt + 120_000
}
const status = {
  protocol: 1,
  requestId: receipt.requestId,
  proposalId: receipt.proposalId,
  phase: 'generating',
  createdAt,
  updatedAt: createdAt + 1000,
  expiresAt: receipt.expiresAt
}
const receiptIdentity = {
  requestId: receipt.requestId,
  now: createdAt + 1000,
  sessionExpiresAt: createdAt + 600_000
}
const statusIdentity = {
  requestId: receipt.requestId,
  proposalId: receipt.proposalId,
  createdAt,
  expiresAt: receipt.expiresAt,
  now: createdAt + 1000
}

describe('native host image generation metadata validators', () => {
  it('exports the shared validators without transport or generation authority', () => {
    expect(publicClient.validateNativeImageGenerationReceipt).toBe(
      validateNativeImageGenerationReceipt
    )
    expect(publicClient.validateNativeImageGenerationStatus).toBe(
      validateNativeImageGenerationStatus
    )
  })

  it('returns isolated frozen metadata, preserving the original immutable deadline', () => {
    const first = validateNativeImageGenerationReceipt(receipt, receiptIdentity)
    const current = validateNativeImageGenerationStatus(status, statusIdentity)
    expect(first).toEqual(receipt)
    expect(current).toEqual(status)
    expect(first).not.toBe(receipt)
    expect(current).not.toBe(status)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(current)).toBe(true)
    expect(Object.keys(first).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'proposalId',
      'protocol',
      'requestId',
      'status'
    ])
  })

  it.each([
    { requestId: 'c'.repeat(32) },
    { now: createdAt - 1 },
    { now: receipt.expiresAt },
    { now: receipt.expiresAt + 1 },
    { now: Number.NaN },
    { now: createdAt + 0.5 },
    { sessionExpiresAt: receipt.expiresAt - 1 },
    { sessionExpiresAt: Number.POSITIVE_INFINITY }
  ])('rejects stale, cross-request or session-extending receipts %j', (change) => {
    expect(() =>
      validateNativeImageGenerationReceipt(receipt, { ...receiptIdentity, ...change })
    ).toThrow('IMAGE_GENERATION_RECEIPT_STALE_OR_UNBOUND')
  })

  it.each([
    { requestId: 'c'.repeat(32) },
    { proposalId: 'c'.repeat(32) },
    { createdAt: createdAt - 1 },
    { expiresAt: receipt.expiresAt + 1 },
    { expiresAt: receipt.expiresAt - 1 },
    { now: status.updatedAt - 1 },
    { now: receipt.expiresAt },
    { now: Number.NaN },
    { now: createdAt + 1000.5 }
  ])('rejects altered status identity and rolling/expired deadlines %j', (change) => {
    expect(() =>
      validateNativeImageGenerationStatus(status, { ...statusIdentity, ...change })
    ).toThrow('IMAGE_GENERATION_STATUS_STALE_OR_UNBOUND')
  })

  it.each(['output', 'prompt', 'reference', 'localMediaUrl', 'jobId', 'generationRequestId'])(
    'rejects a native response carrying %s rather than stripping it',
    (field) => {
      expect(() =>
        validateNativeImageGenerationReceipt({ ...receipt, [field]: 'PRIVATE' }, receiptIdentity)
      ).toThrow()
      expect(() =>
        validateNativeImageGenerationStatus({ ...status, [field]: 'PRIVATE' }, statusIdentity)
      ).toThrow()
    }
  )

  it('accepts terminal metadata only while the same proposal is still live', () => {
    for (const phase of ['accepted', 'declined', 'cancelled', 'failed']) {
      const current = {
        ...status,
        phase,
        error: phase === 'failed' ? 'UPSTREAM_FAILED' : undefined
      }
      expect(validateNativeImageGenerationStatus(current, statusIdentity).phase).toBe(phase)
      expect(() =>
        validateNativeImageGenerationStatus(current, { ...statusIdentity, now: receipt.expiresAt })
      ).toThrow('IMAGE_GENERATION_STATUS_STALE_OR_UNBOUND')
    }
  })
})
