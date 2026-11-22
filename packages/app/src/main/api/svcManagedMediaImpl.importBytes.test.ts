import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MANAGED_MEDIA_IMPORT_BYTES_MAX_BYTES,
  validateImportManagedMediaBytesReq
} from '@shared/api/svcManagedMedia'
import { ServiceValidationError } from '@shared/api/apiUtils/serviceValidation'
import { importManagedMedia } from '../llmProxy/managedMediaStore'
import { ManagedMediaSvcImpl, isCanonicalBase64Payload } from './svcManagedMediaImpl'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/magicpot-test-user-data') }
}))

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

async function withMedia(run: (media: string) => Promise<void>): Promise<void> {
  // memfs (node vitest config): an absolute root of its own per test.
  const root = `/managed-media-bytes-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const media = path.join(root, 'media')
  await fs.mkdir(media, { recursive: true })
  try {
    await run(media)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isCanonicalBase64Payload', () => {
  // The previous check: decode, re-encode, compare (a second string as long as the payload).
  const reencodes = (payload: string): boolean => {
    const bytes = Buffer.from(payload, 'base64')
    return bytes.length > 0 && bytes.toString('base64') === payload
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

  it('accepts exactly what the re-encode comparison accepted', () => {
    let seed = 7
    const random = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % limit
    }
    const cases: string[] = ['AQID', 'AQI=', 'AQ==', 'AA==', 'AB==', 'AQJ=', 'AQ', 'AQI', 'A', '']
    for (let length = 1; length <= 40; length++) {
      const bytes = Buffer.alloc(length)
      for (let index = 0; index < length; index++) bytes[index] = random(256)
      const canonical = bytes.toString('base64')
      cases.push(canonical)
      // Change the last data character: unused low bits set, or a different value.
      const padding = canonical.endsWith('==') ? 2 : canonical.endsWith('=') ? 1 : 0
      const at = canonical.length - padding - 1
      for (let variant = 0; variant < 6; variant++) {
        cases.push(canonical.slice(0, at) + alphabet[random(64)] + canonical.slice(at + 1))
      }
      cases.push(canonical.replace(/=+$/u, ''))
    }
    for (const payload of cases) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(payload)) continue
      expect(isCanonicalBase64Payload(payload), payload).toBe(reencodes(payload))
    }
  })
})

describe('ManagedMediaSvcImpl.importDataUrl', () => {
  it('checks the payload without re-encoding the decoded bytes into a second string', async () => {
    const importBytes = vi.fn(async () => {
      throw new Error('stop after the check')
    })
    const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`
    const service = new ManagedMediaSvcImpl({
      importBytes: importBytes as never,
      getMediaDir: () => '/configured/media',
      realpath: (async () => '/configured/media') as unknown as typeof fs.realpath
    })
    const toString = vi.spyOn(Buffer.prototype, 'toString')
    await expect(
      service.importDataUrl({ dataUrl, originalFileName: 'paste.png' })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_FAILED' })
    expect(importBytes).toHaveBeenCalledOnce()
    expect(toString.mock.calls.filter(([encoding]) => encoding === 'base64')).toEqual([])
  })

  it('still refuses a non-canonical payload before the store sees it', async () => {
    const importBytes = vi.fn()
    const service = new ManagedMediaSvcImpl({ importBytes: importBytes as never })
    for (const dataUrl of ['data:image/png;base64,AQJ=', 'data:image/png;base64,AQ']) {
      await expect(
        service.importDataUrl({ dataUrl, originalFileName: 'a.png' })
      ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_FAILED' })
    }
    expect(importBytes).not.toHaveBeenCalled()
  })
})

describe('ManagedMediaSvcImpl.importBytes', () => {
  it('imports path-less bytes through the managed store, deduplicated with the data URL route', async () => {
    await withMedia(async (media) => {
      const service = new ManagedMediaSvcImpl({
        getMediaDir: () => media,
        ensureDerivative: vi.fn(async () => {
          throw new Error('not needed')
        })
      })
      const fromBytes = await service.importBytes({
        bytes: new Uint8Array(PNG),
        mimeType: 'image/png',
        originalFileName: 'paste.png'
      })
      const fromDataUrl = await service.importDataUrl({
        dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
        originalFileName: 'paste.png'
      })
      expect(fromBytes.reference).toMatchObject({
        kind: 'managed',
        mimeType: 'image/png',
        sizeBytes: PNG.length
      })
      expect(fromBytes).toEqual(fromDataUrl)
    })
  })

  it('hands the store the caller bytes with the cap, without copying them into a string', async () => {
    const importBytes = vi.fn(async () => {
      throw new Error('stop')
    })
    const service = new ManagedMediaSvcImpl({
      importBytes: importBytes as unknown as typeof importManagedMedia,
      getMediaDir: () => '/configured/media',
      realpath: (async () => '/configured/media') as unknown as typeof fs.realpath
    })
    const bytes = new Uint8Array(PNG)
    await expect(
      service.importBytes({ bytes, mimeType: 'image/png', originalFileName: 'a.png' })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_FAILED' })
    expect(importBytes).toHaveBeenCalledWith(
      '/configured/media',
      expect.objectContaining({ maxBytes: MANAGED_MEDIA_IMPORT_BYTES_MAX_BYTES }),
      { authorizedRoot: '/configured/media' }
    )
    const calls = importBytes.mock.calls as unknown as Array<[string, { bytes: Uint8Array }]>
    expect(calls[0][1].bytes).toBe(bytes)
  })

  it('refuses empty, oversized, non-binary and unsupported input before the store', async () => {
    const importBytes = vi.fn()
    const service = new ManagedMediaSvcImpl({ importBytes: importBytes as never })
    const oversized = new Uint8Array(1)
    Object.defineProperty(oversized, 'byteLength', {
      value: MANAGED_MEDIA_IMPORT_BYTES_MAX_BYTES + 1
    })
    for (const [bytes, code] of [
      [new Uint8Array(0), 'MANAGED_MEDIA_TOO_LARGE'],
      [oversized, 'MANAGED_MEDIA_TOO_LARGE'],
      ['iVBORw0KGgo=' as unknown as Uint8Array, 'MANAGED_MEDIA_TOO_LARGE']
    ] as const) {
      await expect(
        service.importBytes({ bytes, mimeType: 'image/png', originalFileName: 'a.png' })
      ).rejects.toMatchObject({ code })
    }
    await expect(
      service.importBytes({
        bytes: new Uint8Array(PNG),
        mimeType: 'video/mp4',
        originalFileName: 'a.mp4'
      })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_UNSUPPORTED' })
    expect(importBytes).not.toHaveBeenCalled()
  })

  it('validates the IPC request: bytes only, within the cap, a MIME type and a safe name', () => {
    const valid = validateImportManagedMediaBytesReq({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'IMAGE/PNG',
      originalFileName: 'paste.png',
      storage: { namespace: 'user-output', scope: 'chat-attachments' }
    })
    expect(valid).toMatchObject({ mimeType: 'image/png', originalFileName: 'paste.png' })
    expect(valid.bytes).toBeInstanceOf(Uint8Array)
    const oversized = new Uint8Array(1)
    Object.defineProperty(oversized, 'byteLength', {
      value: MANAGED_MEDIA_IMPORT_BYTES_MAX_BYTES + 1
    })
    for (const request of [
      { bytes: 'AQID', mimeType: 'image/png', originalFileName: 'a.png' },
      { bytes: [1, 2, 3], mimeType: 'image/png', originalFileName: 'a.png' },
      { bytes: new Uint8Array(0), mimeType: 'image/png', originalFileName: 'a.png' },
      { bytes: oversized, mimeType: 'image/png', originalFileName: 'a.png' },
      { bytes: new Uint8Array([1]), mimeType: 'png', originalFileName: 'a.png' },
      { bytes: new Uint8Array([1]), mimeType: 'image/png', originalFileName: '../a.png' },
      { bytes: new Uint8Array([1]), mimeType: 'image/png', originalFileName: 'a.png', extra: 1 },
      { bytes: new Uint8Array([1]), mimeType: 'image/png' }
    ]) {
      expect(() => validateImportManagedMediaBytesReq(request)).toThrow(ServiceValidationError)
    }
  })
})
