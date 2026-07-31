import { describe, expect, it } from 'vitest'
import { ServiceValidationError } from './apiUtils/serviceValidation'
import {
  managedMediaSvcDef,
  validateEnsureManagedMediaDerivativeReq,
  validateEnsureManagedMediaDerivativeResp
} from './svcManagedMedia'

const reference = {
  version: 1 as const,
  kind: 'managed' as const,
  relativePath: 'ab/file.png',
  sha256: 'a'.repeat(64),
  sizeBytes: 12,
  mimeType: 'image/png',
  originalFileName: 'file.png'
}
const ready = {
  status: 'ready' as const,
  descriptor: {
    maxEdge: 512 as const,
    relativePath: '.derivatives/x/file.webp',
    mimeType: 'image/webp' as const,
    sizeBytes: 10,
    width: 20,
    height: 10,
    sha256: 'b'.repeat(64),
    localMediaUrl: 'local-media:///canonical/root/.derivatives/x/file.webp'
  }
}

const rejectsResponse = (value: unknown): void => {
  expect(() => validateEnsureManagedMediaDerivativeResp(value)).toThrow(ServiceValidationError)
}

describe('svcManagedMedia contract', () => {
  it('normalizes a managed reference and fixed bucket', () => {
    expect(validateEnsureManagedMediaDerivativeReq({ reference, maxEdge: 512 })).toEqual({
      reference,
      maxEdge: 512
    })
  })

  it('rejects invalid references, buckets, and arbitrary caller-controlled fields', () => {
    rejectsResponse({})
    expect(() => validateEnsureManagedMediaDerivativeReq({ reference: {}, maxEdge: 512 })).toThrow(
      ServiceValidationError
    )
    expect(() => validateEnsureManagedMediaDerivativeReq({ reference, maxEdge: 500 })).toThrow(
      ServiceValidationError
    )
    for (const field of ['path', 'root', 'format', 'scope', 'destination']) {
      expect(() =>
        validateEnsureManagedMediaDerivativeReq({ reference, maxEdge: 512, [field]: 'attacker' })
      ).toThrow(ServiceValidationError)
    }
  })

  it('strictly validates ready responses', () => {
    expect(validateEnsureManagedMediaDerivativeResp(ready)).toEqual(ready)
    rejectsResponse({ ...ready, extra: true })
    rejectsResponse({ ...ready, descriptor: { ...ready.descriptor, extra: true } })
    rejectsResponse({
      ...ready,
      descriptor: { ...ready.descriptor, relativePath: '../escape.webp' }
    })
    rejectsResponse({
      ...ready,
      descriptor: { ...ready.descriptor, sha256: 'B'.repeat(64) }
    })
    for (const localMediaUrl of [
      'file:///canonical/root/.derivatives/x/file.webp',
      'local-media://evil/canonical/root/.derivatives/x/file.webp',
      'local-media:///canonical/root/.derivatives/x/other.webp',
      'local-media:///canonical/root/.derivatives/x/file.webp?x=1',
      'local-media:///canonical/root/.derivatives/x/%2e%2e/file.webp'
    ]) {
      rejectsResponse({ ...ready, descriptor: { ...ready.descriptor, localMediaUrl } })
    }
  })

  it('accepts only the exact fallback shape and reason', () => {
    const fallback = {
      status: 'fallbackOriginal' as const,
      reason: 'animated-gif' as const,
      localMediaUrl: 'local-media:///canonical/root/ab/original.gif'
    }
    expect(validateEnsureManagedMediaDerivativeResp(fallback)).toEqual(fallback)
    rejectsResponse({ ...fallback, reason: 'gif' })
    rejectsResponse({ ...fallback, descriptor: ready.descriptor })
    rejectsResponse({ ...fallback, maxEdge: 512 })
  })

  it('registers strict request and response validators', () => {
    expect(managedMediaSvcDef.ensureDerivative).toMatchObject({
      type: 'unary',
      request: validateEnsureManagedMediaDerivativeReq,
      response: validateEnsureManagedMediaDerivativeResp
    })
  })
})
