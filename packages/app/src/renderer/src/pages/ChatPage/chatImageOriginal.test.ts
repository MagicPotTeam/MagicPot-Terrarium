import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBinaryChunkTransport } from '@shared/binaryChunkProtocol'
import type { MediaReference } from '@shared/mediaReference'
import { createImageResponse } from '@renderer/testUtils/imageResponse'
import { isTerminalChatImageSaveError, readChatImageForSave } from './chatImageOriginal'

// Synthetic one-pixel images, no file or network reads.
const encoded = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ6nABAAG+AO+BmP0iAAAAAElFTkSuQmCC',
  gif: 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  webp: 'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQlDJ0pv+BiOh/AAA=',
  jpg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJmAQG//2Q=='
}
const bytesOf = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
const legacy = {
  type: 'image',
  url: 'file:///C:/Synthetic/AutoSave/error.png',
  mimeType: 'image/png',
  fileName: 'wrong.png'
} as const
async function fixture() {
  const data = bytesOf(encoded.webp)
  const wire = await createBinaryChunkTransport(data, { mimeType: 'image/webp', chunkSize: 12 })
  const { sha256, sizeBytes, mimeType } = wire.reference
  const media: MediaReference = {
    version: 1,
    kind: 'managed',
    relativePath: `originals/${sha256.slice(0, 2)}/${sha256}.webp`,
    sha256,
    sizeBytes,
    mimeType,
    originalFileName: 'image.webp'
  }
  return { data, media, reply: { transport: 'chunked-binary-v1' as const, ...wire } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chat original image export', () => {
  it.each(['jpg', 'gif', 'webp', 'png'] as const)(
    'uses the %s bytes, not the filename or response type',
    async (extension) => {
      const data = bytesOf(encoded[extension])
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => createImageResponse(data, { type: 'application/octet-stream' }))
      )
      await expect(readChatImageForSave(legacy)).resolves.toMatchObject({ extension, data })
    }
  )
  it('prefers the verified original over an obsolete AutoSave URL; refuses corrupt bytes without downgrading', async () => {
    const { media, data, reply } = await fixture()
    const fetch = vi.fn().mockRejectedValue(new Error('unexpected attachment request'))
    vi.stubGlobal('fetch', fetch)
    const bad = reply.chunks.map((chunk, index) =>
      index === 1 ? { ...chunk, bytesBase64: btoa('X'.repeat(12)) } : chunk
    )
    const service = {
      materializeForRequest: vi
        .fn()
        .mockResolvedValueOnce({ ...reply, chunks: bad })
        .mockResolvedValueOnce({
          ...reply,
          reference: { ...reply.reference, sizeBytes: data.length + 1 }
        })
        .mockResolvedValue(reply)
    }
    const attachment = { ...legacy, media }
    await expect(readChatImageForSave(attachment, service)).rejects.toThrow(/integrity/)
    await expect(readChatImageForSave(attachment, service)).rejects.toThrow(/reference mismatch/)
    await expect(readChatImageForSave(attachment, service)).resolves.toEqual({
      extension: 'webp',
      data,
      sha256: media.sha256
    })
    expect(service.materializeForRequest).toHaveBeenLastCalledWith({
      reference: media,
      maxBytes: data.length,
      transport: 'chunked-binary-v1'
    })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['MANAGED_MEDIA_MISSING', 'MANAGED_MEDIA_CORRUPT'] as const)(
    'does not try the attachment URL after %s',
    async (code) => {
      const { media } = await fixture()
      const error = { code, message: 'terminal fixture' }
      const service = { materializeForRequest: vi.fn().mockRejectedValue(error) }
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      await expect(readChatImageForSave({ ...legacy, media }, service)).rejects.toBe(error)
      expect(isTerminalChatImageSaveError(error)).toBe(true)
      expect(fetch).not.toHaveBeenCalled()
    }
  )
  it('bounds a streamed response even when the server lies about its size', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytesOf(encoded.png))
      },
      cancel() {
        cancelled = true
      }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { headers: { 'content-length': '1' } }))
    )
    const error = await readChatImageForSave({ ...legacy, sizeBytes: 3 }).catch(
      (reason: unknown) => reason
    )
    expect(error).toHaveProperty('message', expect.stringMatching(/byte limit/))
    expect(isTerminalChatImageSaveError(error)).toBe(true)
    expect(cancelled).toBe(true)
  })
})

describe('auto-save failure classification', () => {
  it.each([
    [new Error('ServiceError: Managed media is missing'), true],
    [new Error('Managed media is corrupt'), true],
    [new Error('Managed media exceeds the request byte limit'), true],
    [{ code: 'MANAGED_MEDIA_REQUEST_SIZE_LIMIT' }, true],
    [{ code: 'MANAGED_MEDIA_REQUEST_MATERIALIZATION_FAILED' }, false],
    [new Error('network unavailable'), false]
  ])('classifies %o as terminal=%s', (error, terminal) => {
    expect(isTerminalChatImageSaveError(error)).toBe(terminal)
  })
})
