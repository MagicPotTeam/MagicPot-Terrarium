import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { MediaReference } from '@shared/mediaReference'

// FIX-PLAN item 4, part 3: a draft keeps a managed reference for a blob: image, not a base64 copy;
// a failed import keeps the old data: URL form, so a draft never loses an attachment.

const media = vi.hoisted(() => ({ importBytes: vi.fn(), importDataUrl: vi.fn() }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcManagedMedia: media }) }))

import {
  importQueuedImages,
  needsDurableQueuedImport,
  serializeDraftAttachment,
  serializeDraftAttachments
} from './chatDraftAttachments'

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
const reference = (id: string): MediaReference => ({
  version: 1,
  kind: 'managed',
  sha256: id,
  relativePath: `originals/${id.slice(0, 2)}/${id}.png`,
  sizeBytes: PNG_BYTES.byteLength,
  mimeType: 'image/png',
  originalFileName: 'pasted.png'
})
const imported = (id: string) => ({
  reference: reference(id),
  localMediaUrl: `local-media:///managed/originals/${id}.png`
})

const blobs = new Map<string, Blob>()
let seq = 0
const blobImage = (type = 'image/png'): ChatAttachment => {
  const url = `blob:file:///draft-${++seq}`
  blobs.set(url, new Blob([PNG_BYTES], { type }))
  return { type: 'image', url, fileName: 'pasted.png', mimeType: type }
}

beforeEach(() => {
  media.importBytes.mockReset()
  media.importDataUrl.mockReset()
  media.importBytes.mockImplementation(async () => imported('a'.repeat(64)))
  media.importDataUrl.mockImplementation(async () => imported('b'.repeat(64)))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const blob = blobs.get(url)
      if (!blob) throw new Error('revoked')
      return { ok: true, blob: async () => blob }
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('serializeDraftAttachment', () => {
  it('stores a blob: image as a managed reference, imported once per blob', async () => {
    const attachment = blobImage()
    const first = await serializeDraftAttachment(attachment)
    expect(first).toMatchObject({
      type: 'image',
      fileName: 'pasted.png',
      url: `local-media:///managed/originals/${'a'.repeat(64)}.png`,
      media: reference('a'.repeat(64))
    })
    expect(JSON.stringify(first)).not.toContain('data:')
    expect(media.importBytes).toHaveBeenCalledTimes(1)
    expect(media.importBytes.mock.calls[0][0]).toMatchObject({
      mimeType: 'image/png',
      storage: { namespace: 'user-output', scope: 'chat-attachments' }
    })
    // Every later pause in typing saves the same draft again: no second import.
    await expect(serializeDraftAttachment({ ...attachment })).resolves.toEqual(first)
    expect(media.importBytes).toHaveBeenCalledTimes(1)
  })

  it('keeps the former data: URL form when the import fails, never dropping the image', async () => {
    media.importBytes.mockRejectedValue(new Error('store unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const result = await serializeDraftAttachment(blobImage())
      expect(result?.url).toMatch(/^data:image\/png;base64,/)
      expect(result?.media).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps other blob: attachments as data: URLs and other urls as they are', async () => {
    const video: ChatAttachment = { ...blobImage('video/mp4'), type: 'video', fileName: 'clip.mp4' }
    await expect(serializeDraftAttachment(video)).resolves.toMatchObject({
      type: 'video',
      url: expect.stringMatching(/^data:video\/mp4;base64,/)
    })
    expect(media.importBytes).not.toHaveBeenCalled()
    const managed: ChatAttachment = {
      type: 'image',
      url: 'local-media:///managed/originals/x.png',
      media: reference('c'.repeat(64))
    }
    const copy = await serializeDraftAttachment(managed)
    expect(copy).toEqual(managed)
    expect(copy).not.toBe(managed)
  })

  it('leaves out only an attachment whose blob is gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const gone: ChatAttachment = { type: 'image', url: 'blob:file:///revoked', fileName: 'x.png' }
      const kept = blobImage()
      const result = await serializeDraftAttachments([gone, kept])
      expect(result).toHaveLength(1)
      expect(result[0]?.media).toEqual(reference('a'.repeat(64)))
    } finally {
      warn.mockRestore()
    }
  })
})

describe('importQueuedImages', () => {
  const inlinePng = (chars: number) => `data:image/png;base64,${'A'.repeat(chars)}`

  it('imports the blob: and oversized inline images of a queued item and keeps the rest', async () => {
    const blob = blobImage()
    const big: ChatAttachment = { type: 'image', url: inlinePng(70 * 1024), fileName: 'big.png' }
    const small: ChatAttachment = { type: 'image', url: inlinePng(1024), fileName: 'small.png' }
    const managed: ChatAttachment = {
      type: 'image',
      url: 'local-media:///managed/originals/m.png',
      media: reference('d'.repeat(64))
    }
    const importInlineImage = vi.fn(async (attachment: ChatAttachment) => ({
      ...attachment,
      url: 'local-media:///managed/originals/big.png',
      media: reference('e'.repeat(64))
    }))
    expect([blob, big, small, managed].map(needsDurableQueuedImport)).toEqual([
      true,
      true,
      false,
      false
    ])

    const result = await importQueuedImages([blob, big, small, managed], importInlineImage)

    expect(result.map((attachment) => attachment.media?.sha256)).toEqual([
      'a'.repeat(64),
      'e'.repeat(64),
      undefined,
      'd'.repeat(64)
    ])
    expect(result[2]).toBe(small)
    expect(result[3]).toBe(managed)
    expect(importInlineImage).toHaveBeenCalledTimes(1)
  })

  it('returns the same array when nothing needs importing, and keeps an image whose import fails', async () => {
    const managed: ChatAttachment[] = [
      {
        type: 'image',
        url: 'local-media:///managed/originals/m.png',
        media: reference('f'.repeat(64))
      }
    ]
    await expect(importQueuedImages(managed, vi.fn())).resolves.toBe(managed)

    media.importBytes.mockRejectedValue(new Error('store unavailable'))
    const blob = blobImage()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const attachments = [blob]
      await expect(importQueuedImages(attachments, vi.fn())).resolves.toBe(attachments)
    } finally {
      warn.mockRestore()
    }
  })
})
