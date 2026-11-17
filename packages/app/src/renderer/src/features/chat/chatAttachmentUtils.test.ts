import { describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import {
  assertRequestImageBytesWithinBudget,
  describeRequestImageSize
} from '@renderer/pages/ChatPage/chatRequestImageBudget'
import {
  CHAT_MESSAGE_IMAGE_BATCH_MAX_BYTES,
  getChatAttachmentMaxSizeMB,
  getChatAttachmentTypeForFile,
  getKnownChatImageBytes,
  getLocalFilePath,
  resolveChatAttachmentSource,
  resolveChatImageBatchBudget,
  summarizeChatAttachmentsForLog
} from './chatAttachmentUtils'

describe('chatAttachmentUtils', () => {
  it('classifies files by mime type before falling back to model extensions', () => {
    expect(getChatAttachmentTypeForFile({ name: 'photo.bin', type: 'image/png' })).toBe('image')
    expect(getChatAttachmentTypeForFile({ name: 'clip.dat', type: 'video/mp4' })).toBe('video')
    expect(getChatAttachmentTypeForFile({ name: 'mesh.GLB', type: '' })).toBe('model3d')
    expect(getChatAttachmentTypeForFile({ name: 'notes.pdf', type: 'application/pdf' })).toBe(
      'file'
    )
  })

  it('uses requested image and generic file limits without changing video or model limits', () => {
    expect(getChatAttachmentMaxSizeMB('video')).toBe(500)
    expect(getChatAttachmentMaxSizeMB('model3d')).toBe(200)
    expect(getChatAttachmentMaxSizeMB('image')).toBe(5)
    expect(getChatAttachmentMaxSizeMB('file')).toBe(10)
  })

  it('recognizes supported native dropped images when an app omits their MIME type', () => {
    for (const name of ['photo.JPG', 'photo.jpeg', 'photo.png', 'photo.webp', 'photo.gif']) {
      expect(getChatAttachmentTypeForFile({ name, type: '' })).toBe('image')
      expect(getChatAttachmentTypeForFile({ name, type: 'application/octet-stream' })).toBe('image')
    }
    expect(
      getChatAttachmentTypeForFile({ name: 'not-an-image.jpg', type: 'application/pdf' })
    ).toBe('file')
    expect(getChatAttachmentTypeForFile({ name: 'active.svg', type: '' })).toBe('file')
    expect(getChatAttachmentTypeForFile({ name: 'notes.txt', type: '' })).toBe('file')
  })

  it('normalizes local file paths and avoids logging full data urls', () => {
    const file = { path: 'C:\\Users\\me\\image.png' } as unknown as File

    expect(getLocalFilePath(file)).toBe('C:/Users/me/image.png')
    expect(
      summarizeChatAttachmentsForLog([
        { type: 'image', url: `data:image/png;base64,${'a'.repeat(32)}`, fileName: 'image.png' }
      ])
    ).toEqual([
      expect.objectContaining({
        type: 'image',
        fileName: 'image.png',
        url: '[data-url length=54]'
      })
    ])
  })

  it('resolves direct and managed attachment sources', () => {
    expect(resolveChatAttachmentSource({ type: 'image', url: 'file:///preview.png' })).toEqual({
      status: 'resolved',
      url: 'file:///preview.png',
      source: 'url'
    })

    const media = {
      version: 1 as const,
      kind: 'managed' as const,
      mimeType: 'image/png',
      originalFileName: 'preview.png',
      relativePath: 'images/preview.png'
    }
    const mediaLookup = vi.fn().mockReturnValue('file:///managed/preview.png')

    expect(resolveChatAttachmentSource({ type: 'image', url: '', media }, { mediaLookup })).toEqual(
      {
        status: 'resolved',
        url: 'file:///managed/preview.png',
        source: 'media'
      }
    )
    expect(mediaLookup).toHaveBeenCalledWith(media)
  })

  it('reports a missing attachment source', () => {
    expect(resolveChatAttachmentSource({ type: 'file', url: '' })).toEqual({
      status: 'unavailable',
      reason: 'missing-source'
    })
  })

  describe('per-message image budget', () => {
    const MiB = 1024 * 1024
    const png49 = Math.round(4.9 * MiB)
    const managedImage = (index: number, sizeBytes = png49): ChatAttachment => ({
      type: 'image',
      url: `local-media://managed/${index}.png`,
      fileName: `${index}.png`,
      mimeType: 'image/png',
      sizeBytes,
      media: {
        version: 1,
        kind: 'managed',
        relativePath: `chat/${index}.png`,
        status: 'ready',
        mimeType: 'image/png',
        sizeBytes,
        sha256: 'a'.repeat(64),
        originalFileName: `${index}.png`
      }
    })

    it('is the 32 MiB batch MAIN prepares for one request', () => {
      expect(CHAT_MESSAGE_IMAGE_BATCH_MAX_BYTES).toBe(32 * MiB)
      // A single image at the per-image limit always fits an empty message.
      expect(getChatAttachmentMaxSizeMB('image') * MiB).toBeLessThan(
        CHAT_MESSAGE_IMAGE_BATCH_MAX_BYTES
      )
    })

    it('reads image sizes from descriptors only', () => {
      expect(getKnownChatImageBytes(managedImage(1, 1234))).toBe(1234)
      // A descriptor's own sizeBytes is not trusted, as at send.
      expect(getKnownChatImageBytes({ type: 'image', url: 'blob:x', sizeBytes: 77 })).toBe(0)
      expect(getKnownChatImageBytes({ ...managedImage(2, 1234), sizeBytes: 40 * MiB })).toBe(1234)
      expect(getKnownChatImageBytes({ type: 'image', url: 'data:image/png;base64,QUJDRA==' })).toBe(
        4
      )
      expect(getKnownChatImageBytes({ type: 'image', url: 'local-media://unknown.png' })).toBe(0)
      expect(getKnownChatImageBytes({ type: 'file', url: 'x', sizeBytes: 50 * MiB })).toBe(0)
      expect(getKnownChatImageBytes({ type: 'image', url: 'x', sizeBytes: -1 })).toBe(0)
    })

    it('counts every image as the send-time check counts it', () => {
      const samples: ChatAttachment[] = [
        managedImage(3, 4321),
        { type: 'image', url: 'data:image/png;base64,QUJDRA==' },
        { type: 'image', url: 'data:image/png;base64,QUJDRA=', sizeBytes: 9 },
        { type: 'image', url: 'data:image/png;base64,QU JDRA==' },
        { type: 'image', url: 'data:image/png,ABCD' },
        { type: 'image', url: `data:${'x'.repeat(5000)};base64,QUJDRA==` },
        { type: 'image', url: 'local-media://x.png', sizeBytes: 10 * MiB }
      ]
      for (const attachment of samples) {
        expect(getKnownChatImageBytes(attachment)).toBe(
          describeRequestImageSize(attachment)?.sourceBytes ?? 0
        )
      }
    })

    it('accepts six 4.9 MB PNG one by one and refuses the seventh and eighth', () => {
      const draft: ChatAttachment[] = []
      const outcomes: boolean[] = []
      for (let index = 0; index < 8; index++) {
        const budget = resolveChatImageBatchBudget(draft, [png49])
        outcomes.push(budget.fits)
        if (budget.fits) draft.push(managedImage(index))
      }
      expect(outcomes).toEqual([true, true, true, true, true, true, false, false])
      const refused = resolveChatImageBatchBudget(draft, [png49])
      expect(refused.usedBytes).toBe(6 * png49)
      expect(refused.remainingBytes).toBe(32 * MiB - 6 * png49)
      expect(refused.incomingBytes).toBe(png49)
      // Whatever the composer accepted, the send-time check accepts on the same route.
      expect(() => assertRequestImageBytesWithinBudget(draft, 'prepared-source')).not.toThrow()
      expect(() =>
        assertRequestImageBytesWithinBudget([...draft, managedImage(7)], 'prepared-source')
      ).toThrow()
    })

    it('takes a batch whole or not at all', () => {
      expect(resolveChatImageBatchBudget([], Array(8).fill(png49)).fits).toBe(false)
      expect(resolveChatImageBatchBudget([], Array(6).fill(png49)).fits).toBe(true)
      expect(resolveChatImageBatchBudget([], [32 * MiB]).fits).toBe(true)
      expect(resolveChatImageBatchBudget([], [32 * MiB + 1]).fits).toBe(false)
    })

    it('keeps accepting non-images and unknown sizes next to a full or over-full draft', () => {
      const overFull = Array.from({ length: 8 }, (_, index) => managedImage(index))
      const budget = resolveChatImageBatchBudget(overFull, [0, 0])
      expect(budget.fits).toBe(true)
      expect(budget.remainingBytes).toBe(0)
      expect(resolveChatImageBatchBudget(overFull, [1]).fits).toBe(false)
    })
  })
})
