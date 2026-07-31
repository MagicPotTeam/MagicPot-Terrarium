import fs from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import { ManagedMediaResolutionError } from '../llmProxy/managedMediaStore'
import { ManagedMediaSvcImpl, type ManagedMediaSvcImplDependencies } from './svcManagedMediaImpl'

const reference = {
  version: 1 as const,
  kind: 'managed' as const,
  relativePath: 'ab/file.png',
  sha256: 'a'.repeat(64),
  sizeBytes: 12,
  mimeType: 'image/png',
  originalFileName: 'file.png'
}
const descriptor = {
  purpose: 'managed-media-derivative' as const,
  maxEdge: 512 as const,
  relativePath: '.derivatives/x/file.webp',
  mimeType: 'image/webp' as const,
  sizeBytes: 10,
  width: 20,
  height: 10,
  sha256: 'b'.repeat(64),
  localMediaUrl: 'local-media:///canonical/media/.derivatives/x/file.webp'
}

function originalGif() {
  return {
    reference,
    absolutePath: '/canonical/media/ab/original.gif',
    localMediaUrl: 'local-media:///canonical/media/ab/original.gif',
    metadataPath: '/canonical/media/ab/original.gif.json',
    metadata: { mimeType: 'image/gif' },
    integrityVerified: true,
    verifiedAt: new Date(0).toISOString()
  } as never
}

function create(
  ensureDerivative: ManagedMediaSvcImplDependencies['ensureDerivative'],
  overrides: Partial<ManagedMediaSvcImplDependencies> = {}
) {
  return new ManagedMediaSvcImpl({
    ensureDerivative,
    getMediaDir: () => '/configured/media',
    realpath: (async (value: string) =>
      value === '/configured/media' ? '/canonical/media' : '/wrong/root') as typeof fs.realpath,
    ...overrides
  })
}

const expectSanitizedFailure = async (promise: Promise<unknown>): Promise<void> => {
  await expect(promise).rejects.toMatchObject({
    code: 'MANAGED_MEDIA_DERIVATIVE_FAILED',
    message: 'Unable to prepare managed media derivative'
  })
}

describe('ManagedMediaSvcImpl', () => {
  it('uses the single getMediaDir root and lets the derivative layer select format', async () => {
    const derive = vi.fn(async () => descriptor)
    await expect(create(derive).ensureDerivative({ reference, maxEdge: 512 })).resolves.toEqual({
      status: 'ready',
      descriptor: {
        maxEdge: 512,
        relativePath: descriptor.relativePath,
        mimeType: 'image/webp',
        sizeBytes: 10,
        width: 20,
        height: 10,
        sha256: descriptor.sha256,
        localMediaUrl: descriptor.localMediaUrl
      }
    })
    expect(derive).toHaveBeenCalledWith({
      authorizedRoot: '/canonical/media',
      reference,
      maxEdge: 512
    })
  })

  it('does not derive format from caller MIME metadata', async () => {
    const derive = vi.fn<NonNullable<ManagedMediaSvcImplDependencies['ensureDerivative']>>(
      async () => descriptor
    )
    await create(derive).ensureDerivative({
      reference: { ...reference, mimeType: 'image/jpeg' },
      maxEdge: 512
    })
    expect(derive.mock.calls[0][0]).not.toHaveProperty('format')
  })

  it('maps only an exact typed animated GIF result to fallbackOriginal', async () => {
    const exact = {
      purpose: 'original-fallback' as const,
      status: 'unsupported' as const,
      reason: 'animated-gif' as const,
      maxEdge: 512 as const,
      original: originalGif()
    }
    await expect(
      create(vi.fn(async () => exact)).ensureDerivative({ reference, maxEdge: 512 })
    ).resolves.toEqual({
      status: 'fallbackOriginal',
      reason: 'animated-gif',
      localMediaUrl: 'local-media:///canonical/media/ab/original.gif'
    })

    for (const invalid of [
      { ...exact, status: 'ready' },
      { ...exact, reason: 'other' },
      { ...exact, maxEdge: 256 },
      {
        ...exact,
        original: { ...(originalGif() as object), metadata: { mimeType: 'image/png' } }
      }
    ]) {
      await expectSanitizedFailure(
        create(vi.fn(async () => invalid as never)).ensureDerivative({ reference, maxEdge: 512 })
      )
    }
  })

  it.each([
    { ...descriptor, maxEdge: 256 },
    { ...descriptor, mimeType: 'image/png' },
    { ...descriptor, relativePath: '../escape.webp' },
    { ...descriptor, sha256: 'B'.repeat(64) },
    { ...descriptor, localMediaUrl: 'file:///canonical/media/.derivatives/x/file.webp' },
    { ...descriptor, width: 1024 }
  ])('sanitizes inconsistent dependency result %#', async (invalid) => {
    await expectSanitizedFailure(
      create(vi.fn(async () => invalid as never)).ensureDerivative({ reference, maxEdge: 512 })
    )
  })

  it.each(['MANAGED_MEDIA_MISSING', 'MANAGED_MEDIA_CORRUPT'] as const)(
    'preserves typed %s errors without leaking paths',
    async (code) => {
      const derive = vi.fn(async () => {
        throw new ManagedMediaResolutionError(code, 'secret /private/path')
      })
      await expect(
        create(derive).ensureDerivative({ reference, maxEdge: 512 })
      ).rejects.toMatchObject({ code })
      await create(derive)
        .ensureDerivative({ reference, maxEdge: 512 })
        .catch((error: ServiceError) => expect(error.message).not.toContain('/private/path'))
    }
  )

  it('sanitizes generic errors', async () => {
    const derive = vi.fn(async () => {
      throw new Error('secret /private/path')
    })
    await expectSanitizedFailure(create(derive).ensureDerivative({ reference, maxEdge: 512 }))
  })
})
